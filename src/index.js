// Memory Vault Gateway
// Fronts the memory-vault D1 so every surface loads and writes through one enforced door.
// Routes: GET /health, GET /rules, GET /hooks/:name, PUT /hooks/:name,
//         PUT /transcript/{session-id},
//         GET /session/start?domain=AI, POST /session/write,
//         POST /mcp/{token} (connector failover for chat/cowork surfaces)
// Auth: env.AUTH_MODE = "bearer" (default) or "access". MCP route authenticates via
// the token path segment (same BEARER_TOKEN). Transcript PUT is unauthenticated
// (UUID.jsonl keys have 128-bit entropy; safe write-only for personal use).
// Self-contained, no npm dependencies.

const MEMORY_TYPES = ["pattern", "mistake", "decision", "pending"];

// Schema applied lazily on first DB use, so a fresh customer deploy (the Deploy
// to Cloudflare button provisions an EMPTY D1) works with no post-deploy /setup
// call. CREATE TABLE IF NOT EXISTS is idempotent; the module flag keeps it to a
// single pass per isolate. /setup remains for explicit/manual re-runs.
const SETUP_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS rules (id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS hot (domain TEXT PRIMARY KEY, state TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS context (domain TEXT NOT NULL, key TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (domain, key))",
  "CREATE TABLE IF NOT EXISTS memory (id INTEGER PRIMARY KEY AUTOINCREMENT, domain TEXT NOT NULL, type TEXT NOT NULL CHECK (type IN ('pattern','mistake','decision','pending')), title TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, source TEXT)",
  "CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, domain TEXT NOT NULL, summary TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS hooks (name TEXT PRIMARY KEY, content TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS usage (sub TEXT NOT NULL, window TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY (sub, window))",
];
let SCHEMA_READY = false;
async function ensureSchema(env) {
  if (SCHEMA_READY) return;
  for (const sql of SETUP_SCHEMA) await env.DB.prepare(sql).run();
  SCHEMA_READY = true;
}

// Projects are dynamic: created on first write, listed live from the store.
// Valid name: starts with a letter, 2-20 chars, A-Z 0-9 _ - (stored uppercase).
const PROJECT_RE = /^[A-Z][A-Z0-9_-]{1,19}$/;
function normaliseProject(raw) {
  const p = String(raw || "").toUpperCase();
  return PROJECT_RE.test(p) ? p : null;
}
async function listProjects(db) {
  const r = await db
    .prepare("SELECT domain FROM (SELECT domain FROM hot UNION SELECT domain FROM context UNION SELECT domain FROM memory) WHERE domain != 'GLOBAL' ORDER BY domain")
    .all();
  return (r.results || []).map((x) => x.domain);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let out = 0;
  for (let i = 0; i < ab.length; i++) out |= ab[i] ^ bb[i];
  return out === 0;
}

function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? 4 - (s.length % 4) : 0;
  s += "=".repeat(pad);
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function b64urlToString(s) {
  return new TextDecoder().decode(b64urlToBytes(s));
}

let JWKS_CACHE = { url: null, keys: null, at: 0 };
async function getJwks(teamDomain) {
  const url = `${teamDomain}/cdn-cgi/access/certs`;
  const now = Date.now();
  if (JWKS_CACHE.url === url && JWKS_CACHE.keys && now - JWKS_CACHE.at < 3600000) return JWKS_CACHE.keys;
  const res = await fetch(url);
  if (!res.ok) throw new Error("jwks fetch failed");
  const data = await res.json();
  JWKS_CACHE = { url, keys: data.keys || [], at: now };
  return JWKS_CACHE.keys;
}

async function verifyAccessJwt(token, teamDomain, aud) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed jwt");
  const header = JSON.parse(b64urlToString(parts[0]));
  const payload = JSON.parse(b64urlToString(parts[1]));
  const sig = b64urlToBytes(parts[2]);
  const keys = await getJwks(teamDomain);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("no matching key");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const data = new TextEncoder().encode(parts[0] + "." + parts[1]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, data);
  if (!ok) throw new Error("bad signature");
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && now > payload.exp) throw new Error("expired");
  if (payload.iss !== teamDomain) throw new Error("bad issuer");
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (aud && !auds.includes(aud)) throw new Error("bad audience");
  return payload;
}

// ---- Licence (T2.1 scaffold): stateless, signed-token tier checks ----
// A licence key is an HS256 JWT verified in Worker compute against
// env.LICENCE_SIGNING_KEY -- no database read per request. Claims: sub
// (customer id), tier (free/pro/max), exp. Gating only runs when
// env.REQUIRE_LICENCE === "true"; otherwise behaviour is unchanged.

// 'free' is the lapsed / no-licence fallback, NOT a free product tier -- there
// is no free tier. A trial is a short-exp licence with tier "max", so it gets
// full Max limits until it expires, then falls back to 'free'. Pro caps
// projects; Max is unlimited.
// projects = max concurrent projects; rpm = calls per minute per licence (the
// rate-limit ceiling AND the metering unit). rpm is finite for every tier so even
// max is protected from runaway loops. These are product defaults, owner-tunable.
const TIER_LIMITS = { free: { projects: 1, rpm: 20 }, pro: { projects: 9, rpm: 60 }, max: { projects: Infinity, rpm: 240 } };

// Pure verifier (token + key only) so the logic is testable outside the Worker.
async function verifyLicenceToken(token, signingKey) {
  const invalid = { valid: false, tier: "free", sub: null };
  if (!token || !signingKey) return invalid;
  const parts = String(token).split(".");
  if (parts.length !== 3) return invalid;
  let header, payload;
  try {
    header = JSON.parse(b64urlToString(parts[0]));
    payload = JSON.parse(b64urlToString(parts[1]));
  } catch {
    return invalid;
  }
  if (!header || header.alg !== "HS256") return invalid;
  let ok = false;
  try {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(signingKey), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    ok = await crypto.subtle.verify("HMAC", key, b64urlToBytes(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
  } catch {
    return invalid;
  }
  if (!ok) return invalid;
  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return invalid;
  const tier = Object.prototype.hasOwnProperty.call(TIER_LIMITS, payload.tier) ? payload.tier : "free";
  return { valid: true, tier, sub: payload.sub || null };
}

async function verifyLicence(token, env) {
  return verifyLicenceToken(token, env.LICENCE_SIGNING_KEY);
}

function bytesToB64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function stringToB64url(s) {
  return bytesToB64url(new TextEncoder().encode(s));
}
async function mintLicenceToken(payload, signingKey) {
  if (!signingKey) throw new Error("no signing key");
  const header = { alg: "HS256", typ: "JWT" };
  const signingInput = stringToB64url(JSON.stringify(header)) + "." + stringToB64url(JSON.stringify(payload));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(signingKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));
  return signingInput + "." + bytesToB64url(new Uint8Array(sig));
}

async function requestLicence(request, url, env) {
  if (env.REQUIRE_LICENCE !== "true") return { required: false, valid: false, tier: "free", sub: null };
  const token = request.headers.get("x-licence") || url.searchParams.get("licence");
  const v = await verifyLicence(token, env);
  return { required: true, ...v };
}

// ---- Stripe webhook signature verification (SubtleCrypto HMAC-SHA256) ----
// Stripe signs: t=<unix_timestamp> . "." . raw_body using HMAC-SHA256.
// Header: Stripe-Signature: t=<ts>,v1=<hex>
// Replay window: 300 seconds. Timing-safe compare via existing timingSafeEqual.
async function verifyStripeSignature(bodyBytes, sigHeader, secret) {
  if (!sigHeader || !secret) return { ok: false, reason: "missing header or secret" };
  const parts = sigHeader.split(",");
  let ts = null;
  const v1sigs = [];
  for (const p of parts) {
    if (p.startsWith("t=")) ts = p.slice(2);
    else if (p.startsWith("v1=")) v1sigs.push(p.slice(3));
  }
  if (!ts || !v1sigs.length) return { ok: false, reason: "malformed Stripe-Signature" };
  const tsNum = parseInt(ts, 10);
  if (!Number.isFinite(tsNum)) return { ok: false, reason: "invalid timestamp" };
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - tsNum) > 300) return { ok: false, reason: "timestamp outside tolerance" };
  const signedPayload = ts + "." + new TextDecoder().decode(bodyBytes);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sigBytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
  const computed = Array.from(new Uint8Array(sigBytes)).map((b) => b.toString(16).padStart(2, "0")).join("");
  for (const v1 of v1sigs) {
    if (timingSafeEqual(v1, computed)) return { ok: true, ts: tsNum };
  }
  return { ok: false, reason: "signature mismatch" };
}

async function handleStripeWebhook(request, env) {
  if (!env.STRIPE_WEBHOOK_SECRET) return json({ error: "webhook not configured" }, 500);
  const bodyBytes = await request.arrayBuffer();
  const sigHeader = request.headers.get("stripe-signature") || "";
  const sigResult = await verifyStripeSignature(bodyBytes, sigHeader, env.STRIPE_WEBHOOK_SECRET);
  if (!sigResult.ok) return json({ error: "invalid signature", reason: sigResult.reason }, 400);
  let event;
  try { event = JSON.parse(new TextDecoder().decode(bodyBytes)); } catch { return json({ error: "invalid JSON" }, 400); }
  const type = (event && event.type) || "unknown";
  const obj = event && event.data && event.data.object;
  try {
    if (type === "checkout.session.completed" && obj) {
      const meta = obj.metadata || {};
      const sub = String(meta.sub || obj.customer || obj.client_reference_id || "").trim();
      const tier = String(meta.tier || "pro").toLowerCase();
      const expDays = parseInt(meta.exp_days || "365", 10);
      if (sub && Object.prototype.hasOwnProperty.call(TIER_LIMITS, tier) && env.LICENCE_SIGNING_KEY) {
        const iat = Math.floor(Date.now() / 1000);
        const exp = iat + (Number.isFinite(expDays) && expDays > 0 ? expDays : 365) * 24 * 60 * 60;
        const token = await mintLicenceToken({ sub, tier, iat, exp, iss: "memory-gateway" }, env.LICENCE_SIGNING_KEY);
        await env.DB.prepare("INSERT OR REPLACE INTO context (domain, key, content, updated_at) VALUES ('BOUIOS', ?, ?, date('now'))").bind("licence:" + sub, token).run();
        await env.DB.prepare("INSERT INTO log (ts, domain, summary) VALUES (datetime('now'), 'BOUIOS', ?)").bind("stripe checkout.session.completed: licence issued sub=" + sub + " tier=" + tier).run();
      }
    } else if (type === "customer.subscription.deleted" && obj) {
      const meta = obj.metadata || {};
      const sub = String(meta.sub || obj.customer || "").trim();
      if (sub && env.LICENCE_SIGNING_KEY) {
        const iat = Math.floor(Date.now() / 1000);
        const token = await mintLicenceToken({ sub, tier: "free", iat, exp: iat, iss: "memory-gateway" }, env.LICENCE_SIGNING_KEY);
        await env.DB.prepare("INSERT OR REPLACE INTO context (domain, key, content, updated_at) VALUES ('BOUIOS', ?, ?, date('now'))").bind("licence:" + sub, token).run();
        await env.DB.prepare("INSERT INTO log (ts, domain, summary) VALUES (datetime('now'), 'BOUIOS', ?)").bind("stripe subscription.deleted: licence expired sub=" + sub).run();
      }
    }
  } catch (e) {
    try {
      await env.DB.prepare("INSERT INTO log (ts, domain, summary) VALUES (datetime('now'), 'BOUIOS', ?)").bind("stripe webhook handler error: " + String(e).slice(0, 200)).run();
    } catch (_) {}
  }
  return json({ ok: true, type });
}

async function projectLimitError(db, domain, tier) {
  const limit = (TIER_LIMITS[tier] || TIER_LIMITS.free).projects;
  if (!Number.isFinite(limit)) return null;
  const row = await db
    .prepare("SELECT (SELECT COUNT(*) FROM hot WHERE domain = ?1) AS already, (SELECT COUNT(DISTINCT domain) FROM hot WHERE domain != 'GLOBAL') AS total")
    .bind(domain)
    .first();
  if (row && !row.already && row.total >= limit) {
    return `Project limit reached: the ${tier} tier allows ${limit} project${limit === 1 ? "" : "s"}, and ${domain} would be a new one. Write to an existing project or upgrade.`;
  }
  return null;
}

// Per-licence usage metering + rate limit (T2.1). One atomic upsert per billable
// call: increments the (sub, minute) counter and returns the new count. The usage
// table IS the metering record (read via GET /usage); the count vs tier rpm gives
// the rate limit. Only branded (licensed) calls are metered; owner/unbranded skip.
async function checkAndRecordUsage(db, sub, tier) {
  const limit = (TIER_LIMITS[tier] || TIER_LIMITS.free).rpm;
  const window = new Date().toISOString().slice(0, 16); // UTC minute bucket YYYY-MM-DDTHH:MM
  // Fail-open: metering must NEVER break a user's call. If the usage table is
  // absent (e.g. a DB provisioned before the meter shipped) or the write fails,
  // the INSERT throws; callers run this OUTSIDE their try blocks, so an uncaught
  // throw became a 500 in chat (regression from the meter, e27941a). Swallow it
  // here and allow the call unmetered rather than failing the request.
  try {
    const row = await db
      .prepare(
        "INSERT INTO usage (sub, window, count, updated_at) VALUES (?1, ?2, 1, datetime('now')) " +
          "ON CONFLICT(sub, window) DO UPDATE SET count = count + 1, updated_at = datetime('now') RETURNING count"
      )
      .bind(sub, window)
      .first();
    const count = row ? row.count : 1;
    return { count, limit, window, over: Number.isFinite(limit) && count > limit };
  } catch (e) {
    return { count: 0, limit, window, over: false, meter_error: String(e) };
  }
}

async function authorise(request, env) {
  const mode = (env.AUTH_MODE || "bearer").toLowerCase();
  if (mode === "access") {
    if (!env.TEAM_DOMAIN || !env.POLICY_AUD) return { ok: false, status: 500, msg: "Access not configured" };
    const token = request.headers.get("cf-access-jwt-assertion");
    if (!token) return { ok: false, status: 403, msg: "missing Access JWT" };
    try {
      await verifyAccessJwt(token, env.TEAM_DOMAIN, env.POLICY_AUD);
      return { ok: true };
    } catch (e) {
      return { ok: false, status: 403, msg: "invalid Access JWT" };
    }
  }
  if (!env.BEARER_TOKEN) return { ok: false, status: 500, msg: "bearer not configured" };
  const h = request.headers.get("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return { ok: false, status: 401, msg: "missing bearer token" };
  if (!timingSafeEqual(m[1], env.BEARER_TOKEN)) return { ok: false, status: 401, msg: "invalid bearer token" };
  return { ok: true };
}

function countOpenTasks(hotState) {
  if (!hotState) return 0;
  const idx = hotState.search(/##\s*STILL OPEN/i);
  if (idx === -1) return 0;
  const after = hotState.slice(idx);
  const next = after.slice(3).search(/\n##\s/);
  const block = next === -1 ? after : after.slice(0, next + 3);
  return block.split("\n").filter((l) => /^\s*-\s+/.test(l)).length;
}

const TIER_SKILLS = {
  free: { cap: 3, defaults: ["continuity", "five-advisor-chairman-model", "first-principles"] },
  pro: { cap: 10, defaults: ["continuity", "five-advisor-chairman-model", "first-principles", "solopreneur-strategy", "linkedin-optimiser"] },
  max: { cap: 999, defaults: ["continuity", "five-advisor-chairman-model", "first-principles", "solopreneur-strategy", "linkedin-optimiser", "skill-creator"] },
};
const SKILL_CHARS_PER_TOKEN = 4;
const SKILL_TOKEN_BUDGET = 8000;

async function selectSkills(db, tier) {
  const cfg = TIER_SKILLS[tier] || TIER_SKILLS.free;
  const names = cfg.defaults.map((n) => "skill-" + n);
  let rows = [];
  if (names.length) {
    const placeholders = names.map(() => "?").join(",");
    const r = await db.prepare(`SELECT title, body FROM memory WHERE type = 'pattern' AND title IN (${placeholders})`).bind(...names).all();
    rows = r.results || [];
  }
  const byTitle = new Map(rows.map((x) => [x.title, x.body]));
  const selected = [];
  let tokens = 0;
  for (const name of cfg.defaults) {
    if (selected.length >= cfg.cap) break;
    const body = byTitle.get("skill-" + name);
    if (body === undefined) continue;
    const est = Math.ceil(body.length / SKILL_CHARS_PER_TOKEN);
    if (tokens + est > SKILL_TOKEN_BUDGET && selected.length > 0) break;
    selected.push({ name, est_tokens: est, body });
    tokens += est;
  }
  return {
    tier,
    cap: cfg.cap === 999 ? "unlimited" : cfg.cap,
    token_budget: SKILL_TOKEN_BUDGET,
    est_tokens: tokens,
    count: selected.length,
    skills: selected,
  };
}

// Customer-safe rule set. A licensed (branded) session receives THIS de-jargoned
// mirror, never the owner rules table -- that table names the store, the tools,
// the query language and other internals, which must never reach a customer
// surface (R19). The owner loads through the direct store connector, not this
// gateway, so the owner still gets the full concrete rules and is unaffected.
// Kept verbatim-equal to .session/rules.customer.md; test/customer-rules.test.mjs
// and verify.sh fail the build if they drift or if an internal term leaks in.
const CUSTOMER_RULES = [
  { scope: "session-start", content: `At every session start, load your rules, hot, and context silently. Infer the active Project (stored as domain) from project, folder, repo, or topic; for names that do not obviously match, check memory for the project-name-to-domain-mapping pattern (memory 36). Infer one project only: if the project is obvious, load it immediately without asking. If genuinely ambiguous, ask which one. Never load all projects. Loading is mandatory on every surface including dispatch and automated runs - never skip it. If the store is unreachable, say so and retry once. Output one line only: "Memory loaded: {Project}, {n} rules, hot from {date}, {n} open tasks." and log the same to your store. Then surface every open task from hot with its status and blocking condition. Hot is the work queue, not background. Do not begin new work without acknowledging open tasks first.` },
  { scope: "session-during", content: `Log every substantive exchange immediately (one-line entry to your log). Every few substantive steps, and before any long operation: write full state to hot, and output a handoff block in a code box starting with "load memory", then the Project and the most critical next action, for pasting into a new chat. Do not wait until 70% context - by then the next step may blow the window. State what was checkpointed. Before the final reply: write any new pattern, decision, or mistake to memory, update hot, append a log line, and state what was written (table, id, one-line summary). No memory entry may record a decision as DONE or a bug as FIXED without a commit hash, test output, or live url in the body. If blocked: checkpoint and report the blocker. Never store important findings only in ephemeral container files; commit them to your store.` },
  { scope: "session-end", content: `Before overwriting any hot value that already exists: read the current value and archive it to your log with prefix "HOT ARCHIVE:" and a timestamp. Then overwrite hot with the new state. Never silently overwrite. Log, hot, and memory writes performed as part of this established protocol are standing-approved and do not require per-write approval under R4.` },
  { scope: "global", content: `No file write, edit, delete, memory-store write (outside the established session protocol), git commit, push, or external action without explicit written approval in the current session for that specific action. Audit = read only. Plan = present for approval. This rule overrides every other rule when they conflict.` },
  { scope: "global", content: `Edit forward only. Never run git revert, reset, rebase, merge, or checkout of a file, and never delete or overwrite a file or a stored row outside the session protocol, without explicit user approval for that specific action. The single exception is discarding an unpushed local stray to match the remote, and only after verifying nothing unique is lost. Reverting is never the default; fix forward.` },
  { scope: "global", content: `Never state a fact, capability, or done, fixed or working from memory or assumption. Check first: read the file, run the check, query your store. Label any unverified claim and say how it would be verified. Tag all claims chat, file, memory, search or tool. Give confidence levels, never present a guess as certainty, and never guess at incomplete lists when a tool can return the complete answer. Do not act on memory rows tagged mistake. For anything verifiable, verify, do not ask; for decisions that genuinely need the user, ask once, framed clearly, never to avoid the work. When reporting, use Action, Evidence, Source, Status, Next.` },
  { scope: "global", content: `When the user pushes back in any form ("are you sure?", "that is wrong", "you missed X"), stop immediately, investigate, then correct. Do not defend, re-explain, or argue the prior claim.` },
  { scope: "global", content: `Before any edit or build: confirm the fault is in the layer or surface you are about to change before changing it. State which files change and why, and verify paths exist. Diffs not rewrites. Capture the working baseline first. Additive by default, freeze interfaces (a change to one needs approval). State success criteria and the stopping point, max 3 components, reuse over create. Machine-checkable criteria: write the check first, loop to green. Human-verified: produce, state criteria, checkpoint. Re-run baseline checks after every change, all pass or the change is rejected, not patched. Cap retries and escalate, do not thrash or re-probe. No placeholders unless asked, no shortcuts, never imply done unless verified, no unrequested features. Every site, page, CV or profile meets semantic HTML, correct heading order, WCAG AA, SEO and AEO, schema.org JSON-LD, ATS-parseable, validated before deploy.` },
  { scope: "global", content: `Before building anything that spans multiple repos, files, or systems: audit the current state of each surface, map what exists, identify gaps, present findings, get approval. Then build.` },
  { scope: "global", content: `Complete the current task before starting the next. If a secondary issue is found, note it at the end and ask; do not pivot mid-task, do not reopen settled decisions, no epistemic shutdowns. Execute the owner's instruction: raise a concern once if you have one, but the instruction stands unless the owner cancels it - never downgrade an instruction to a recommendation, never substitute your own judgement for it, and never record "noted, no edit made" in place of doing it. Track every instruction the owner gives until it is done with evidence or the owner cancels it; it may not be silently dropped. Before closing a task, state whether it could have been done better and how, ask permission to redo if so, and never redo unilaterally.` },
  { scope: "global", content: `At task start, discover available skills and registered tools through tool discovery. Use the matching skill before building a workaround, build a skill when a capability recurs, and never reinvent a deployed tool. Route to the right surface: Code for repos, deploys and filesystem; Cowork for multi-file work; Design for visual artifacts; Chat for reasoning and drafting. State if the current surface cannot enforce or persist what the task needs.` },
  { scope: "global", content: `A blocker is real only after a registered tool returned the error. Never state 403, egress, allowlist, unreachable, or no-tool from assumption. Before claiming any limit, route through the tools that bypass the sandbox: your registered tools, browser engines, the failover proxies. The sandbox limit is not the system limit. Discover your tools before declaring any capability unavailable or any path blocked.` },
  { scope: "global", content: `Never hand-keep counts, totals, or rule numbers in context or documentation files; they drift. Read them live from your store. The store is the single source of truth.` },
  { scope: "global", content: `Projects are strict boundaries: read and use content only from the active Project, and cross-Project reads require approval. Operate only on the repos and the storage resources approved at install, default or custom, for the active identity and licence. Default deny outside that set. Respect the enforcement tier and never assume or forge owner status.` },
  { scope: "global", content: `For any consequential architecture, product, or stuck-problem decision: run the five-advisor-chairman model against your stored evidence (log, memory, hot). Output only the chairman decision unless the advisor breakdown is asked for. Full model definition in memory 53.` },
  { scope: "global", content: `British English. Short sentences. Active voice. No em dashes, semicolons, or Oxford commas. Be concise and token-efficient: no babble, no padding, no restating what was just said. State any question plainly on its own line. Never bury a question in prose and never skip a question about missing features, functionality, or scope. No AI writing traits: can, may, just, very, actually, certainly, game-changer, groundbreaking, dive deep, shed light, unlock, remarkable, craft, imagine, realm, utilize, harness, exciting, cutting-edge, tapestry, illuminate. No setup language: in conclusion, in summary, overall, as mentioned. No emoji unless explicitly requested. No hashtags, watermarks, hidden characters, or zero-width spaces.` },
  { scope: "global", content: `Act as a rigorous honest mentor. Identify weaknesses, blind spots, and flawed assumptions. Never default to agreement. When correcting, explain why and propose the better alternative. Never soften a correct assessment to avoid friction. No filler affirmations.` },
  { scope: "global", content: `No rule may be added, modified, or deleted without explicit user approval. The set is capped at 20 rules (S + D + G combined), with a target of 19 and one slot kept open. Before proposing a new rule: check for contradictions with existing rules and identify which current rule it would retire. The cap cannot be exceeded without a simultaneous retirement.` },
  { scope: "global", content: `Never expose secrets or internals. Do not put credentials, tokens, API keys, account or store identifiers, or internal config or paths into chat, instructions, commits, logs, or any artifact, and never quote them from memory; retrieve live or ask. On any customer-facing surface, never reveal how the system works (store, provider, tools, urls, ids); surface only the branded result.` },
];

async function sessionStart(domain, surface, env, licence) {
  await ensureSchema(env);
  const db = env.DB;
  const [rules, hot, context, pending, recent, log, memTotal] = await Promise.all([
    db.prepare("SELECT scope, content FROM rules ORDER BY id").all(),
    db.prepare("SELECT state, updated_at FROM hot WHERE domain = ?").bind(domain).all(),
    db.prepare("SELECT key, content FROM context WHERE domain = ? AND key != 'gateway-bearer-token'").bind(domain).all(),
    db.prepare("SELECT id, type, title, body FROM memory WHERE (domain = ? OR domain = 'GLOBAL') AND type = 'pending' ORDER BY id").bind(domain).all(),
    db.prepare("SELECT id, type, title, body FROM memory WHERE (domain = ? OR domain = 'GLOBAL') AND type != 'pending' ORDER BY id DESC LIMIT 40").bind(domain).all(),
    db.prepare("SELECT ts, summary FROM log WHERE domain = ? ORDER BY id DESC LIMIT 25").bind(domain).all(),
    db.prepare("SELECT COUNT(*) AS n FROM memory WHERE domain = ? OR domain = 'GLOBAL'").bind(domain).first(),
  ]);
  const memoryRows = [...(pending.results || []), ...(recent.results || [])];
  const hotRow = (hot.results && hot.results[0]) || null;
  const hotState = hotRow ? hotRow.state : null;
  const hotDate = hotRow ? hotRow.updated_at : "none";
  const branded = !!(licence && licence.required);
  // Branded = a licensed customer session. Serve the de-jargoned customer rules,
  // never the owner rules table. Unbranded (owner / CI) keeps the concrete rules.
  const servedRules = branded ? CUSTOMER_RULES : (rules.results || []);
  const rulesN = servedRules.length;
  const openN = countOpenTasks(hotState);
  const confirmation = branded
    ? `Bouios loaded - working set ${domain}, ${rulesN} rules loaded, ${openN} items flagged for follow-up.`
    : `Memory loaded: ${domain}, ${rulesN} rules, hot from ${hotDate}, ${openN} open tasks.`;
  await db.prepare("INSERT INTO log (ts, domain, summary) VALUES (datetime('now'), ?, ?)").bind(domain, `Session loaded via gateway, surface=${surface || "unknown"}.`).run();
  const out = { confirmation, domain, rules: servedRules, hot: hotState, hot_updated: hotDate, open_tasks: openN, context: context.results || [], memory: memoryRows, log: log.results || [], memory_total: memTotal ? memTotal.n : memoryRows.length, memory_returned: memoryRows.length };
  if (licence && licence.required) {
    out.tier = licence.tier;
    out.skills = await selectSkills(db, licence.tier);
  }
  return out;
}

async function sessionWrite(domain, body, env, licence) {
  await ensureSchema(env);
  const db = env.DB;
  if (licence && licence.required) {
    const limitErr = await projectLimitError(db, domain, licence.tier);
    if (limitErr) return { ok: false, domain, error: limitErr, tier: licence.tier };
  }
  const applied = [];
  if (typeof body.hot === "string" && body.hot.length) {
    await db.prepare("INSERT INTO log (ts, domain, summary) SELECT datetime('now'), ?, 'HOT ARCHIVE via gateway: ' || state FROM hot WHERE domain = ?").bind(domain, domain).run();
    await db.prepare("INSERT OR REPLACE INTO hot (domain, state, updated_at) VALUES (?, ?, date('now'))").bind(domain, body.hot).run();
    applied.push("hot");
  }
  if (Array.isArray(body.memory)) {
    for (const m of body.memory) {
      if (!m || !MEMORY_TYPES.includes(m.type) || !m.title || !m.body) continue;
      await db.prepare("INSERT INTO memory (domain, type, title, body, created_at) VALUES (?, ?, ?, ?, date('now'))").bind(domain, m.type, m.title, m.body).run();
      applied.push("memory:" + m.title);
    }
  }
  if (Array.isArray(body.context)) {
    for (const c of body.context) {
      if (!c || !c.key || typeof c.content !== "string") continue;
      await db.prepare("INSERT OR REPLACE INTO context (domain, key, content, updated_at) VALUES (?, ?, ?, date('now'))").bind(domain, c.key, c.content).run();
      applied.push("context:" + c.key);
    }
  }
  const logs = Array.isArray(body.log) ? body.log : typeof body.log === "string" ? [body.log] : [];
  for (const s of logs) {
    if (typeof s !== "string" || !s) continue;
    await db.prepare("INSERT INTO log (ts, domain, summary) VALUES (datetime('now'), ?, ?)").bind(domain, s).run();
    applied.push("log");
  }
  return { ok: true, domain, applied };
}

const MCP_PROTOCOL = "2025-03-26";
const MCP_INSTRUCTIONS =
  "This connector is Bouios, the user's own memory system - their standing infrastructure, expected in every conversation. " +
  "Call memory_load for the relevant project FIRST, before acting on any message. A clear, self-contained task does not exempt this. Infer one project from the conversation; if unclear, ask which one; never load all projects. " +
  "Any of these exact user messages triggers memory_load immediately: 'load memory', 'load rules', 'load Bouios'. " +
  "Surface order after loading: the single returned confirmation line first, then this project's open tasks, then any skills or linked projects. " +
  "Load only this project's tasks; do not pull tasks from other projects unless the user asks. " +
  "Show the user only the single returned confirmation line - never the store, provider, identifiers, urls, paths, or any other backend detail. " +
  "Memory loads return all pending rows plus the most recent entries; older rows beyond that window still exist and can be requested via memory_load again or direct queries when needed. " +
  "Writes are refused until memory_load has been called in this session. " +
  "Monitor your own context usage and save EARLY AND OFTEN - checkpoint every few substantive steps, and at the latest by roughly 70 percent of context: call memory_write with full working state, log the exchange, then output a handoff block in a code box. " +
  "BEFORE any compaction: call session_handoff (saves hot state and log). AFTER any compaction: call memory_load immediately to re-arm before any write. " +
  "When the conversation nears its limit, call session_handoff and show the user the returned block in a code box to copy into a new chat. " +
  "If your memory tools are unavailable or return errors, do not stall, repeat, or block the conversation - continue without them in a degraded mode and they reconnect on their own. Use the tools available in this session; if a tool reports it cannot reach a service, note it briefly and work around it rather than retrying.";

const MCP_TOOLS = [
  {
    name: "memory_load",
    description:
      "Load the user's memory for a project: rules, current working state, context, learned patterns, open follow-ups, AND the recent activity log (what was actually agreed and done last sessions). " +
      "This is the user's own standing setup and must be called first in every conversation, before any other work, " +
      "including direct, self-contained task instructions. The user messages 'load memory', 'load rules' and 'load Bouios' each invoke this immediately. " +
      "Returns a one-line confirmation to show the user, plus the payload. READ the returned log and open follow-ups before proposing a plan or re-deriving anything - never re-propose what the log or memory shows is already built or decided.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project matching this conversation's topic. Uppercase name; new projects are created on first write." },
        surface: { type: "string", description: "Where this session runs: chat, cowork, code, dispatch." },
      },
      required: ["project"],
    },
  },
  {
    name: "memory_write",
    description:
      "Save updates to the user's memory: hot working state (replaces, old state is archived), memory entries " +
      "(pattern, mistake, decision, pending), context rows, and log lines. " +
      "Refused until memory_load has been called in this session.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name, uppercase." },
        hot: { type: "string", description: "New hot working state for the project." },
        memory: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: MEMORY_TYPES },
              title: { type: "string" },
              body: { type: "string" },
            },
            required: ["type", "title", "body"],
          },
        },
        context: {
          type: "array",
          items: {
            type: "object",
            properties: { key: { type: "string" }, content: { type: "string" } },
            required: ["key", "content"],
          },
        },
        log: { type: "array", items: { type: "string" } },
      },
      required: ["project"],
    },
  },
  {
    name: "session_handoff",
    description:
      "End-of-session continuity. Saves the provided working state as the project's hot state (old state is archived first), " +
      "then returns a short continuation block. Show that block to the user in a code box so they can paste it into a new chat. " +
      "Call this when the conversation nears its context limit, before compaction, or when the user asks to hand off.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name, uppercase." },
        hot: { type: "string", description: "Full current working state to save before handing off." },
        next_step: { type: "string", description: "One line: the immediate next action for the new chat." },
      },
      required: ["project"],
    },
  },
];

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
function toolText(id, text, isError) {
  const result = { content: [{ type: "text", text }] };
  if (isError) result.isError = true;
  return rpcResult(id, result);
}

async function mcpSessionLoaded(db, sessionId) {
  if (!sessionId) return false;
  const row = await db
    .prepare("SELECT 1 AS ok FROM log WHERE summary LIKE ? AND ts > datetime('now', '-1 day') LIMIT 1")
    .bind("%mcp-session=" + sessionId + "%")
    .first();
  return !!row;
}

async function handleMcpMessage(msg, sessionId, env, licence) {
  const id = msg && msg.id !== undefined ? msg.id : null;
  const method = msg && msg.method;
  if (!method) return rpcError(id, -32600, "invalid request");
  if (method === "initialize") {
    return rpcResult(id, {
      protocolVersion: MCP_PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: "memory", version: "1.1.0" },
      instructions: MCP_INSTRUCTIONS,
    });
  }
  if (method === "ping") return rpcResult(id, {});
  if (method === "tools/list") {
    let tools = MCP_TOOLS;
    try {
      const projects = await listProjects(env.DB);
      if (projects.length) {
        tools = JSON.parse(JSON.stringify(MCP_TOOLS));
        tools[0].inputSchema.properties.project.description += " Existing projects: " + projects.join(", ") + ".";
      }
    } catch (e) {}
    return rpcResult(id, { tools });
  }
  if (method === "tools/call") {
    const name = msg.params && msg.params.name;
    const args = (msg.params && msg.params.arguments) || {};
    const domain = normaliseProject(args.project || args.domain);
    if (!domain) return toolText(id, "Invalid project name. Use 2-20 characters: letters, digits, _ or -, starting with a letter.", true);
    if (licence && licence.required && licence.valid && licence.sub) {
      const q = await checkAndRecordUsage(env.DB, licence.sub, licence.tier);
      if (q.over) return toolText(id, `Rate limit reached: the ${licence.tier} tier allows ${q.limit} calls per minute. Pause briefly and retry.`, true);
    }
    try {
      if (name === "memory_load") {
        const surface = (args.surface || "chat") + " mcp-session=" + (sessionId || "none");
        const out = await sessionStart(domain, surface, env, licence);
        return toolText(id, JSON.stringify(out));
      }
      if (name === "memory_write") {
        if (!(await mcpSessionLoaded(env.DB, sessionId))) {
          return toolText(id, "Write refused: memory has not been loaded in this session. Call memory_load for the project first, then retry.", true);
        }
        const out = await sessionWrite(domain, args, env, licence);
        return toolText(id, JSON.stringify(out), out.ok === false);
      }
      if (name === "session_handoff") {
        if (!(await mcpSessionLoaded(env.DB, sessionId))) {
          return toolText(id, "Handoff refused: memory has not been loaded in this session. Call memory_load for the project first, then retry.", true);
        }
        const saved = [];
        if (typeof args.hot === "string" && args.hot.length) {
          const out = await sessionWrite(domain, { hot: args.hot, log: ["Session handoff: state saved before continuation."] }, env, licence);
          if (out.ok === false) return toolText(id, out.error, true);
          saved.push(...out.applied);
        }
        const next = typeof args.next_step === "string" && args.next_step.length ? args.next_step : "resume the open tasks in the saved state";
        const block =
          "load memory\n" +
          "Project: " + domain + ". Continue the previous session. " +
          "The full state is in my memory backend (hot state plus open tasks). " +
          "First action: " + next;
        return toolText(id, JSON.stringify({ saved, handoff_block: block, instruction: "Show handoff_block to the user in a code box to paste into a new chat." }));
      }
    } catch (e) {
      return toolText(id, "tool failed: " + String(e), true);
    }
    return toolText(id, "unknown tool: " + String(name), true);
  }
  if (msg.id === undefined || msg.id === null) return null;
  return rpcError(id, -32601, "method not found");
}

async function handleMcp(request, env, licence) {
  if (request.method === "DELETE") return new Response(null, { status: 204 });
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST, DELETE" } });
  let body;
  try {
    body = await request.json();
  } catch {
    return json(rpcError(null, -32700, "parse error"), 400);
  }
  let sessionId = request.headers.get("mcp-session-id");
  const msgs = Array.isArray(body) ? body : [body];
  if (!sessionId && msgs.some((m) => m && m.method === "initialize")) sessionId = crypto.randomUUID();
  const responses = [];
  for (const m of msgs) {
    const r = await handleMcpMessage(m, sessionId, env, licence);
    if (r) responses.push(r);
  }
  const headers = { "content-type": "application/json; charset=utf-8" };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  if (!responses.length) return new Response(null, { status: 202, headers });
  return new Response(JSON.stringify(Array.isArray(body) ? responses : responses[0]), { status: 200, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (path === "/health") return json({ ok: true, service: "memory-gateway" });
    const licence = await requestLicence(request, url, env);
    if (path.startsWith("/mcp/")) {
      const token = path.slice("/mcp/".length);
      if (!env.BEARER_TOKEN || !token || !timingSafeEqual(token, env.BEARER_TOKEN)) return json({ error: "unauthorised" }, 401);
      if (licence.required && !licence.valid) return json({ error: "licence required or invalid" }, 403);
      return handleMcp(request, env, licence);
    }
    // Unauthenticated transcript upload. UUID.jsonl format validation provides
    // 128-bit entropy write isolation; no bearer token needed from hook scripts.
    if (path.startsWith("/transcript/") && request.method === "PUT") {
      const sessionId = path.slice("/transcript/".length);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/.test(sessionId)) {
        return json({ error: "session-id must be UUID.jsonl" }, 400);
      }
      if (!env.TRANSCRIPTS) return json({ error: "transcript storage not configured" }, 500);
      const body = await request.arrayBuffer();
      const key = "transcript:" + sessionId;
      await env.TRANSCRIPTS.put(key, body, {
        httpMetadata: { contentType: "application/x-ndjson" },
        customMetadata: { created: new Date().toISOString() },
      });
      if (env.DB) {
        try {
          await env.DB.prepare("INSERT INTO log (ts, domain, summary) VALUES (datetime('now'), 'AI', ?)").bind("transcript PUT " + sessionId + " " + body.byteLength + "b").run();
        } catch (_) {}
      }
      return json({ ok: true, key, bytes: body.byteLength });
    }
    // Bearer-gated transcript reads (Authorization: Bearer <t> OR ?token=<t> for
    // browser access). Owner diagnostic: list/read what actually landed in R2.
    if (path === "/transcript" && request.method === "GET") {
      const tok = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") || url.searchParams.get("token") || "";
      if (!env.BEARER_TOKEN || !tok || !timingSafeEqual(tok, env.BEARER_TOKEN)) return json({ error: "unauthorised" }, 401);
      if (!env.TRANSCRIPTS) return json({ error: "transcript storage not configured" }, 500);
      const listed = await env.TRANSCRIPTS.list({ prefix: "transcript:", limit: 1000 });
      const objects = (listed.objects || []).map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded }));
      return json({ count: objects.length, truncated: listed.truncated || false, objects });
    }
    if (path.startsWith("/transcript/") && request.method === "GET") {
      const tok = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") || url.searchParams.get("token") || "";
      if (!env.BEARER_TOKEN || !tok || !timingSafeEqual(tok, env.BEARER_TOKEN)) return json({ error: "unauthorised" }, 401);
      if (!env.TRANSCRIPTS) return json({ error: "transcript storage not configured" }, 500);
      const id = path.slice("/transcript/".length);
      const key = id.startsWith("transcript:") ? id : "transcript:" + id;
      const obj = await env.TRANSCRIPTS.get(key);
      if (!obj) return json({ error: "not found", key }, 404);
      return new Response(obj.body, { headers: { "content-type": "application/x-ndjson; charset=utf-8" } });
    }
    // Stripe webhook: no bearer auth, verified by Stripe-Signature HMAC instead.
    if (path === "/licence/webhook" && request.method === "POST") {
      return handleStripeWebhook(request, env);
    }
    const auth = await authorise(request, env);
    if (!auth.ok) return json({ error: auth.msg }, auth.status);

    if (path === "/licence/issue" && request.method === "POST") {
      if (!env.LICENCE_SIGNING_KEY) return json({ error: "licence signing not configured" }, 500);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid JSON body" }, 400); }
      const customer = String(body.customer || body.sub || "").trim();
      if (!customer) return json({ error: "missing customer" }, 400);
      const tier = String(body.tier || "").toLowerCase();
      if (!Object.prototype.hasOwnProperty.call(TIER_LIMITS, tier)) return json({ error: "unknown tier", allowed: Object.keys(TIER_LIMITS) }, 400);
      const iat = Math.floor(Date.now() / 1000);
      let exp;
      if (body.exp === undefined || body.exp === null) {
        exp = iat + 365 * 24 * 60 * 60;
      } else {
        exp = Math.floor(Number(body.exp));
        if (!Number.isFinite(exp) || exp <= iat) return json({ error: "exp must be a unix timestamp after now" }, 400);
      }
      const claims = { sub: customer, tier, iat, exp, iss: "memory-gateway" };
      try {
        const token = await mintLicenceToken(claims, env.LICENCE_SIGNING_KEY);
        return json({ ok: true, licence: token, sub: customer, tier, iat, exp });
      } catch (e) {
        return json({ error: "mint failed", detail: String(e) }, 500);
      }
    }
    if (path === "/setup" && request.method === "POST") {
      try {
        const existing = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
        const existingNames = new Set((existing.results || []).map(r => r.name));
        const created = [], existed = [];
        for (const sql of SETUP_SCHEMA) {
          await env.DB.prepare(sql).run();
          const name = sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/)?.[1];
          if (name) (existingNames.has(name) ? existed : created).push(name);
        }
        return json({ ok: true, created, existed });
      } catch (e) {
        return json({ error: "setup failed", detail: String(e) }, 500);
      }
    }
    if (path === "/rules" && request.method === "GET") {
      // CUSTOMER-FACING route: the deployed customer worker (worker/src/index.js
      // fetchRules) loads its rules from here with the shared GATEWAY_TOKEN. It
      // MUST serve the de-jargoned CUSTOMER_RULES, never the owner rules table
      // (which names the store, tools, db and query language - R19). The owner
      // loads rules via the direct store connector, not this route, so is
      // unaffected. Closes the leak this branch is named for: previously this
      // returned the raw owner rules table, so every customer's memory_load
      // surfaced owner internals. Unconditional (not licence-gated) so it holds
      // even when REQUIRE_LICENCE is off.
      return json({ rules: CUSTOMER_RULES });
    }
    // Usage metering read-out (bearer-gated, owner). Per-licence per-minute call
    // counts: ?sub=<licence> for one customer, otherwise the most recent across all.
    if (path === "/usage" && request.method === "GET") {
      try {
        const sub = url.searchParams.get("sub");
        const r = sub
          ? await env.DB.prepare("SELECT sub, window, count, updated_at FROM usage WHERE sub = ? ORDER BY window DESC LIMIT 60").bind(sub).all()
          : await env.DB.prepare("SELECT sub, window, count, updated_at FROM usage ORDER BY window DESC LIMIT 100").all();
        return json({ tiers: TIER_LIMITS, usage: r.results || [] });
      } catch (e) {
        return json({ error: "usage fetch failed", detail: String(e) }, 500);
      }
    }
    if (path.startsWith("/hooks/") && (request.method === "GET" || request.method === "PUT")) {
      const name = path.slice("/hooks/".length);
      if (!name || name.includes("/") || name.includes("..")) return json({ error: "invalid name" }, 400);
      if (request.method === "GET") {
        try {
          const row = await env.DB.prepare("SELECT content FROM hooks WHERE name = ?").bind(name).first();
          if (!row) return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
          return new Response(row.content, { headers: { "content-type": "text/plain; charset=utf-8" } });
        } catch (e) {
          return json({ error: "hooks fetch failed", detail: String(e) }, 500);
        }
      }
      const content = await request.text();
      if (!content) return json({ error: "empty content" }, 400);
      try {
        await env.DB.prepare("INSERT OR REPLACE INTO hooks (name, content, updated_at) VALUES (?, ?, datetime('now'))").bind(name, content).run();
        return json({ ok: true, name });
      } catch (e) {
        return json({ error: "hooks write failed", detail: String(e) }, 500);
      }
    }
    if (path === "/session/start" && request.method === "GET") {
      if (licence.required && !licence.valid) return json({ error: "licence required or invalid" }, 403);
      const domain = normaliseProject(url.searchParams.get("domain"));
      if (!domain) {
        try {
          const ps = await env.DB.prepare("SELECT DISTINCT domain FROM hot ORDER BY domain").all();
          return json({ error: "domain required", available: (ps.results || []).map((r) => r.domain) }, 400);
        } catch (_) {
          return json({ error: "domain required" }, 400);
        }
      }
      if (licence.required && licence.valid && licence.sub) {
        const q = await checkAndRecordUsage(env.DB, licence.sub, licence.tier);
        if (q.over) return json({ error: "rate limit", tier: licence.tier, limit: q.limit, window: q.window }, 429);
      }
      const surface = url.searchParams.get("surface") || request.headers.get("x-surface") || "unknown";
      try { return json(await sessionStart(domain, surface, env, licence)); } catch (e) { return json({ error: "load failed", detail: String(e) }, 500); }
    }
    if (path === "/session/write" && request.method === "POST") {
      if (licence.required && !licence.valid) return json({ error: "licence required or invalid" }, 403);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid JSON body" }, 400); }
      const domain = normaliseProject(body.domain || url.searchParams.get("domain"));
      if (!domain) return json({ error: "invalid or missing project name" }, 400);
      if (licence.required && licence.valid && licence.sub) {
        const q = await checkAndRecordUsage(env.DB, licence.sub, licence.tier);
        if (q.over) return json({ error: "rate limit", tier: licence.tier, limit: q.limit, window: q.window }, 429);
      }
      try {
        const out = await sessionWrite(domain, body, env, licence);
        return json(out, out.ok === false ? 403 : 200);
      } catch (e) { return json({ error: "write failed", detail: String(e) }, 500); }
    }
    return json({ error: "not found", routes: ["GET /health", "POST /setup", "POST /licence/issue", "POST /licence/webhook", "GET /rules", "GET /usage", "GET /hooks/:name", "PUT /hooks/:name", "PUT /transcript/{session-id}", "GET /session/start?domain=AI", "POST /session/write", "POST /mcp/{token}"] }, 404);
  },
};
