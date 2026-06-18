// Memory Vault Gateway
// Fronts the memory-vault D1 so every surface loads and writes through one enforced door.
// Routes: GET /health, GET /rules, GET /hooks/:name, PUT /hooks/:name,
//         GET /session/start?domain=AI, POST /session/write,
//         POST /mcp/{token} (connector failover for chat/cowork surfaces)
// Auth: env.AUTH_MODE = "bearer" (default) or "access". MCP route authenticates via
// the token path segment (same BEARER_TOKEN). Self-contained, no npm dependencies.

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
// env.LICENCE_SIGNING_KEY — no database read per request. Claims: sub
// (customer id), tier (free/pro/max), exp. Gating only runs when
// env.REQUIRE_LICENCE === "true"; otherwise behaviour is unchanged.

// 'free' is the lapsed / no-licence fallback, NOT a free product tier — there
// is no free tier. A trial is a short-exp licence with tier "max", so it gets
// full Max limits until it expires, then falls back to 'free'. Pro caps
// projects; Max is unlimited.
const TIER_LIMITS = { free: { projects: 1 }, pro: { projects: 9 }, max: { projects: Infinity } };

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

// Encoders + HS256 mint: the inverse of the b64url decoders and
// verifyLicenceToken above. Issuance and verification share one HMAC path so a
// minted token always verifies. btoa needs a binary string, hence the per-byte
// build before url-safe substitution and padding strip.
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

// Resolve licence state for a request. When REQUIRE_LICENCE is off (the
// default), this returns immediately and no verification runs.
async function requestLicence(request, url, env) {
  if (env.REQUIRE_LICENCE !== "true") return { required: false, valid: false, tier: "free", sub: null };
  const token = request.headers.get("x-licence") || url.searchParams.get("licence");
  const v = await verifyLicence(token, env);
  return { required: true, ...v };
}

// Single enforcement point for tier limits: refuse creating a NEW project
// beyond the tier's project cap. One indexed query, write paths only.
async function projectLimitError(db, domain, tier) {
  const limit = (TIER_LIMITS[tier] || TIER_LIMITS.free).projects;
  if (!Number.isFinite(limit)) return null; // unlimited (max tier): no project cap
  const row = await db
    .prepare("SELECT (SELECT COUNT(*) FROM hot WHERE domain = ?1) AS already, (SELECT COUNT(DISTINCT domain) FROM hot WHERE domain != 'GLOBAL') AS total")
    .bind(domain)
    .first();
  if (row && !row.already && row.total >= limit) {
    return `Project limit reached: the ${tier} tier allows ${limit} project${limit === 1 ? "" : "s"}, and ${domain} would be a new one. Write to an existing project or upgrade.`;
  }
  return null;
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

// ---- Skills selection + tiering ----
// Per-tier default skill sets (memory 168), capped and token-budgeted. Skill
// bodies live in the memory table as type='pattern', title='skill-<name>'.
// Selection is DETERMINISTIC: the tier's named defaults that exist, in priority
// order, trimmed to the tier cap and a token budget. Semantic ranking over the
// wider library (Vectorize, issue #3) and usage instrumentation are the next
// layer and intentionally not built here. Returned only when a tier is known
// (licence gating), so default deployments are byte-for-byte unchanged.
const TIER_SKILLS = {
  free: { cap: 2, defaults: ["five-advisor-chairman-model", "first-principles"] },
  pro: { cap: 10, defaults: ["five-advisor-chairman-model", "first-principles", "solopreneur-strategy", "linkedin-optimiser"] },
  max: { cap: 999, defaults: ["five-advisor-chairman-model", "first-principles", "solopreneur-strategy", "linkedin-optimiser", "skill-creator"] },
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
    if (body === undefined) continue; // a named default not yet registered
    const est = Math.ceil(body.length / SKILL_CHARS_PER_TOKEN);
    // Keep at least one; otherwise stop before exceeding the token budget.
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

async function sessionStart(domain, surface, env, licence) {
  await ensureSchema(env);
  const db = env.DB;
  const [rules, hot, context, pending, recent, memTotal] = await Promise.all([
    db.prepare("SELECT scope, content FROM rules ORDER BY id").all(),
    db.prepare("SELECT state, updated_at FROM hot WHERE domain = ?").bind(domain).all(),
    db.prepare("SELECT key, content FROM context WHERE domain = ?").bind(domain).all(),
    db.prepare("SELECT id, type, title, body FROM memory WHERE (domain = ? OR domain = 'GLOBAL') AND type = 'pending' ORDER BY id").bind(domain).all(),
    db.prepare("SELECT id, type, title, body FROM memory WHERE (domain = ? OR domain = 'GLOBAL') AND type != 'pending' ORDER BY id DESC LIMIT 40").bind(domain).all(),
    db.prepare("SELECT COUNT(*) AS n FROM memory WHERE domain = ? OR domain = 'GLOBAL'").bind(domain).first(),
  ]);
  const memoryRows = [...(pending.results || []), ...(recent.results || [])];
  const hotRow = (hot.results && hot.results[0]) || null;
  const hotState = hotRow ? hotRow.state : null;
  const hotDate = hotRow ? hotRow.updated_at : "none";
  const rulesN = rules.results ? rules.results.length : 0;
  const openN = countOpenTasks(hotState);
  const confirmation = `Memory loaded: ${domain}, ${rulesN} rules, hot from ${hotDate}, ${openN} open tasks.`;
  await db.prepare("INSERT INTO log (ts, domain, summary) VALUES (datetime('now'), ?, ?)").bind(domain, `Session loaded via gateway, surface=${surface || "unknown"}.`).run();
  const out = { confirmation, domain, rules: rules.results || [], hot: hotState, hot_updated: hotDate, open_tasks: openN, context: context.results || [], memory: memoryRows, memory_total: memTotal ? memTotal.n : memoryRows.length, memory_returned: memoryRows.length };
  // Tier-gated skills: only when a licence tier is known, so default
  // (REQUIRE_LICENCE off) deployments are unchanged. Separate from the memory load.
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

// ---- MCP endpoint: connector failover for chat/cowork surfaces ----
// Streamable HTTP transport, JSON-RPC 2.0, plain JSON responses (no SSE stream).
// Primary chat load path stays the registered database tools. This endpoint is
// the enforced failover: tool descriptions carry the load-first instruction and
// memory_write is refused until memory_load has run in the same MCP session.

const MCP_PROTOCOL = "2025-03-26";
const MCP_INSTRUCTIONS =
  "This connector is the user's own memory backend. Their standing infrastructure, expected in every conversation. " +
  "Call memory_load for the relevant project FIRST, before acting on any message. A clear, self-contained task does not exempt this. " +
  "The exact user message 'load memory' triggers memory_load immediately. " +
  "Show the user only the single returned confirmation line, then proceed. " +
  "Memory loads return all pending rows plus the most recent entries; older rows beyond that window still exist and can be requested via memory_load again or direct queries when needed. " +
  "Never display internal queries, identifiers, or backend details. " +
  "Writes are refused until memory_load has been called in this session. " +
  "Monitor your own context usage. At roughly 70 percent, or before any compaction or long operation, call memory_write with the full working state. " +
  "When the conversation nears its limit, call session_handoff and show the user the returned block in a code box to copy into a new chat.";

const MCP_TOOLS = [
  {
    name: "memory_load",
    description:
      "Load the user's memory for a project: rules, current working state, context, and learned patterns. " +
      "This is the user's own standing setup and must be called first in every conversation, before any other work, " +
      "including direct, self-contained task instructions. The user message 'load memory' invokes this immediately. " +
      "Returns a one-line confirmation to show the user, plus the memory payload.",
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
  // Notifications (no id) get no response; unknown request methods get an error.
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

function htmlResponse(html) {
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (path === "/" && request.method === "GET") {
      const html = `<!DOCTYPE html>
<html lang="en-GB">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Bouios - AI Memory Backend - Syndakat</title>
    <meta name="description" content="Bouios: persistent memory backend for AI assistants. Keep your assistant's context across sessions and devices with a stateful memory vault.">
    <meta name="keywords" content="AI memory, assistant memory, context persistence, AI backend, Cloudflare Workers">
    <meta property="og:title" content="Bouios - AI Memory Backend">
    <meta property="og:description" content="Persistent memory backend for AI assistants. Built by Syndakat.">
    <meta property="og:type" content="website">
    <meta property="og:url" content="https://bouios.syndakat.com/">
    <meta property="og:site_name" content="Syndakat">
    <meta name="theme-color" content="#C8102E">
    <link rel="canonical" href="https://bouios.syndakat.com/">
    <link rel="icon" type="image/svg+xml" href="https://syndakat.com/favicon.svg">
    <link rel="stylesheet" href="https://syndakat.com/syndakat.css">
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; }
        header { background: #fff; border-bottom: 1px solid #eee; padding: 1.5rem 2rem; display: flex; align-items: center; gap: 2rem; }
        .logo { font-size: 1.5rem; font-weight: 700; color: #000; text-decoration: none; }
        .logo span { color: #C8102E; }
        .by-syndakat { font-size: 0.9rem; color: #999; font-weight: 500; }
        .content { max-width: 960px; margin: 0 auto; padding: 3rem 2rem; }
        h1 { font-size: 2.2rem; margin: 0 0 1rem; color: #000; }
        p { line-height: 1.6; color: #666; font-size: 1.05rem; }
        .feature-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 2rem; margin: 2rem 0; }
        .feature-card { padding: 1.5rem; border: 1px solid #eee; border-radius: 8px; background: #fafafa; }
        .feature-card h3 { margin: 0 0 0.5rem; font-size: 1.1rem; color: #000; }
        .feature-card p { font-size: 0.95rem; margin: 0; color: #666; }
        .tech-specs { background: #f5f5f5; padding: 2rem; border-radius: 8px; margin: 2rem 0; }
        .tech-specs h2 { margin: 0 0 1rem; font-size: 1.3rem; }
        .tech-specs ul { margin: 0; padding-left: 1.5rem; }
        .tech-specs li { margin-bottom: 0.5rem; color: #666; }
        footer { text-align: center; padding: 2rem; color: #999; font-size: 0.9rem; border-top: 1px solid #eee; }
    </style>
</head>
<body>

<header>
    <a href="https://syndakat.com" class="logo">BOUIOS<span>.</span></a>
    <span class="by-syndakat">by Syndakat</span>
</header>

<div class="content">
    <h1>Persistent Memory for AI Assistants</h1>
    <p>Bouios is a stateful memory backend that keeps your AI assistant's context, decisions, and learned patterns across conversations, sessions, and devices. No more context window resets. No more forgotten conversations.</p>

    <div class="feature-grid">
        <div class="feature-card">
            <h3>Session Memory</h3>
            <p>Your assistant loads your full context at the start of each conversation. Rules, decisions, and working state are always available.</p>
        </div>
        <div class="feature-card">
            <h3>Cross-Device Sync</h3>
            <p>Continue on your phone where you left off on your desktop. Memory state syncs automatically across every surface.</p>
        </div>
        <div class="feature-card">
            <h3>Learned Patterns</h3>
            <p>Your assistant remembers decisions, approaches, and patterns from past conversations. Gets smarter the more you work together.</p>
        </div>
        <div class="feature-card">
            <h3>Rules & Context</h3>
            <p>Set standing rules once. Your assistant applies them consistently across all future conversations.</p>
        </div>
    </div>

    <div class="tech-specs">
        <h2>What Bouios Stores</h2>
        <ul>
            <li><strong>Hot state:</strong> Current working context, active tasks, and conversation state</li>
            <li><strong>Memory entries:</strong> Patterns, mistakes, decisions, and pending items your assistant has learned</li>
            <li><strong>Rules:</strong> Standing instructions and constraints that apply across conversations</li>
            <li><strong>Context:</strong> Project-specific information, metadata, and cross-session variables</li>
            <li><strong>Logs:</strong> Audit trail of what happened in each session</li>
        </ul>
    </div>

    <h2>How</h2>
    <p>Bouios exposes a simple JSON-RPC 2.0 MCP server that your AI assistant calls at the start and end of conversations. Your assistant loads your memory, works on your task, then writes back what was learned. On the next conversation, it has the full context from before.</p>

    <h2>Pricing</h2>
    <p>Start free, then choose the plan that fits your needs.</p>
    <div class="feature-grid">
      <div class="feature-card">
        <h3>Trial Herder</h3>
        <p style="font-weight: 700; font-size: 1.3rem; margin: 1rem 0 0.5rem;">Free</p>
        <p style="font-size: 0.85rem; color: #999;">24 hours (5 days with referral)</p>
        <ul style="list-style: none; padding-left: 0; font-size: 0.95rem; color: #666;">
          <li>• 1 project, 1 repo</li>
          <li>• 2 skills</li>
          <li>• D1 persistent memory</li>
          <li>• No card required</li>
        </ul>
      </div>
      <div class="feature-card">
        <h3>Herder</h3>
        <p style="font-weight: 700; font-size: 1.3rem; margin: 1rem 0 0.5rem;">$4.99<span style="font-size: 0.8rem; font-weight: normal;">/mo</span></p>
        <p style="font-size: 0.85rem; color: #999;">30-day extended trial</p>
        <ul style="list-style: none; padding-left: 0; font-size: 0.95rem; color: #666;">
          <li>• 1 project, 1 repo</li>
          <li>• 2 skills</li>
          <li>• 30-day history</li>
          <li>• Same scope as Trial</li>
        </ul>
      </div>
      <div class="feature-card">
        <h3>Pro Herder</h3>
        <p style="font-weight: 700; font-size: 1.3rem; margin: 1rem 0 0.5rem;">$19<span style="font-size: 0.8rem; font-weight: normal;">/mo</span></p>
        <p style="font-size: 0.85rem; color: #999;">Professional use</p>
        <ul style="list-style: none; padding-left: 0; font-size: 0.95rem; color: #666;">
          <li>• Unlimited projects</li>
          <li>• All surfaces</li>
          <li>• 10 skills</li>
          <li>• 7-day history</li>
        </ul>
      </div>
      <div class="feature-card">
        <h3>Max Herder</h3>
        <p style="font-weight: 700; font-size: 1.3rem; margin: 1rem 0 0.5rem;">$49<span style="font-size: 0.8rem; font-weight: normal;">/mo</span></p>
        <p style="font-size: 0.85rem; color: #999;">Enterprise features</p>
        <ul style="list-style: none; padding-left: 0; font-size: 0.95rem; color: #666;">
          <li>• Everything in Pro</li>
          <li>• Shared memory</li>
          <li>• 30-day history</li>
          <li>• Unlimited skills</li>
        </ul>
      </div>
    </div>

    <h2>Built for Channel Islands</h2>
    <p>Bouios is part of the Syndakat platform, built for life and work in the Channel Islands. If you need your AI assistant to remember things across conversations, context windows, and devices — integrate Bouios.</p>

</div>

<footer>
    <p>&copy; 2026 Syndakat &middot; Built by islanders, for the Channel Islands</p>
</footer>

<div class="floating-buttons">
  <button id="back-to-top" title="Back to top">↑</button>
  <button id="dark-sky-toggle" title="Toggle dark mode">◐</button>
  <button id="sark-bot-float" title="Chat with Sark Bot">🦞</button>
</div>

<div id="sark-bot-overlay"></div>
<div class="sark-bot-popup" id="sark-bot-popup" style="display:none;">
  <header>
    Sark Bot
    <button class="close-btn" onclick="closeSarkBotPopup()">×</button>
  </header>
  <div class="chat-body" id="popup-chat-body"></div>
  <div class="chat-input">
    <input id="popup-chat-input" type="text" placeholder="Ask about sailings, events, or news...">
    <button onclick="sendPopupMessage()">Ask</button>
  </div>
</div>

  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Product",
    "name": "Bouios",
    "description": "Persistent memory for AI assistants that spans conversations, sessions, and devices.",
    "offers": [
      {
        "@type": "Offer",
        "name": "Trial Herder",
        "description": "Free for 24 hours (5 days with a referral). 1 project, 1 repo, 2 skills, D1 persistent memory.",
        "price": "0",
        "priceCurrency": "USD"
      },
      {
        "@type": "Offer",
        "name": "Herder",
        "description": "30-day extended trial. 1 project, 1 repo, 2 skills, D1 persistent memory.",
        "price": "4.99",
        "priceCurrency": "USD"
      },
      {
        "@type": "Offer",
        "name": "Pro Herder",
        "description": "Unlimited projects, all surfaces, 10 skills, 7-day history.",
        "price": "19",
        "priceCurrency": "USD"
      },
      {
        "@type": "Offer",
        "name": "Max Herder",
        "description": "Everything in Pro plus shared memory, 30-day history, unlimited skills.",
        "price": "49",
        "priceCurrency": "USD"
      }
    ]
  }
  </script>

<script>
const backToTop = document.getElementById("back-to-top");
const botFloatBtn = document.getElementById("sark-bot-float");
const botOverlay = document.getElementById("sark-bot-overlay");
const botPopup = document.getElementById("sark-bot-popup");
const popupChatBody = document.getElementById("popup-chat-body");
const popupChatInput = document.getElementById("popup-chat-input");

window.addEventListener("scroll", () => {
  if (window.scrollY > 300) {
    backToTop.style.opacity = "1";
    backToTop.style.visibility = "visible";
  } else {
    backToTop.style.opacity = "0";
    backToTop.style.visibility = "hidden";
  }
});
backToTop.addEventListener("click", () => {
  window.scrollTo({ top: 0, behavior: "smooth" });
});

botFloatBtn.addEventListener("click", () => {
  botOverlay.style.display = "block";
  botPopup.style.display = "flex";
  popupChatInput.focus();
});

function closeSarkBotPopup() {
  botOverlay.style.display = "none";
  botPopup.style.display = "none";
}

botOverlay.addEventListener("click", closeSarkBotPopup);

function sendPopupMessage() {
  const q = popupChatInput.value.trim();
  if (!q) return;
  popupChatInput.value = '';
  const userMsg = document.createElement("div");
  userMsg.style.cssText = "text-align:right;padding:0.5rem;background:#f0f0f0;border-radius:6px;font-size:0.9rem";
  userMsg.textContent = q;
  popupChatBody.appendChild(userMsg);
  popupChatBody.scrollTop = popupChatBody.scrollHeight;

  fetch('/api/archive/query?q=' + encodeURIComponent(q), { headers: { 'Accept': 'application/json' } })
    .then(r => r.json())
    .then(d => {
      const botMsg = document.createElement("div");
      botMsg.style.cssText = "text-align:left;padding:0.5rem;background:#e8f5e9;border-radius:6px;font-size:0.9rem";
      botMsg.textContent = d.answer || "Could not fetch response.";
      popupChatBody.appendChild(botMsg);
      popupChatBody.scrollTop = popupChatBody.scrollHeight;
    })
    .catch(() => {
      const errMsg = document.createElement("div");
      errMsg.style.cssText = "text-align:left;padding:0.5rem;background:#ffebee;border-radius:6px;font-size:0.9rem;color:var(--red,#C8102E)";
      errMsg.textContent = "Error connecting to Sark Bot. Please try again.";
      popupChatBody.appendChild(errMsg);
    });
}

popupChatInput.addEventListener("keypress", (e) => {
  if (e.key === "Enter") sendPopupMessage();
});

function toggleDarkMode() {
  const html = document.documentElement;
  const current = html.getAttribute("data-theme");
  const next = current === "dark" ? "light" : "dark";
  html.setAttribute("data-theme", next);
  localStorage.setItem("theme", next);
}

document.addEventListener("DOMContentLoaded", () => {
  const darkSkyToggle = document.getElementById("dark-sky-toggle");
  if (darkSkyToggle) {
    darkSkyToggle.addEventListener("click", toggleDarkMode);
  }
  const savedTheme = localStorage.getItem("theme");
  if (savedTheme === "dark") {
    document.documentElement.setAttribute("data-theme", "dark");
  }
});
</script>`;
      return htmlResponse(html);
    }
    if (path === "/health") return json({ ok: true, service: "memory-gateway" });
    // No-op unless REQUIRE_LICENCE === "true" (default deployments unchanged).
    const licence = await requestLicence(request, url, env);
    if (path.startsWith("/mcp/")) {
      const token = path.slice("/mcp/".length);
      if (!env.BEARER_TOKEN || !token || !timingSafeEqual(token, env.BEARER_TOKEN)) return json({ error: "unauthorised" }, 401);
      if (licence.required && !licence.valid) return json({ error: "licence required or invalid" }, 403);
      return handleMcp(request, env, licence);
    }
    const auth = await authorise(request, env);
    if (!auth.ok) return json({ error: auth.msg }, auth.status);
    if (path === "/token/sync" && request.method === "POST") {
      // Self-heal: copy the live secret into the memory store so the stored
      // copy can never drift from the Worker. Returns no secret material.
      if (!env.BEARER_TOKEN) return json({ error: "no token configured" }, 500);
      try {
        await env.DB.prepare("INSERT OR REPLACE INTO context (domain, key, content, updated_at) VALUES ('AI', 'gateway-bearer-token', ?, date('now'))").bind(env.BEARER_TOKEN).run();
        return json({ ok: true, synced: true });
      } catch (e) {
        return json({ error: "sync failed", detail: String(e) }, 500);
      }
    }
    if (path === "/licence/issue" && request.method === "POST") {
      // Owner-only (sits behind the bearer/Access gate above): mint a signed
      // HS256 licence for a customer + tier. Stateless — later verified in
      // Worker compute against the same LICENCE_SIGNING_KEY, no per-request DB
      // read. exp is an absolute unix timestamp; default is one year out.
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
      // Idempotent first-run table creation. Authenticated like every other
      // mutating route; safe to re-run on an already-set-up database.
      try {
        const existing = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
        const existingNames = new Set((existing.results || []).map(r => r.name));
        const tableNames = SETUP_SCHEMA.map(s => s.match(/CREATE TABLE IF NOT EXISTS (\w+)/)?.[1]).filter(Boolean);
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
      try {
        const rules = await env.DB.prepare("SELECT id, scope, content FROM rules ORDER BY id").all();
        return json({ rules: rules.results || [] });
      } catch (e) {
        return json({ error: "rules fetch failed", detail: String(e) }, 500);
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
      if (!domain) return json({ error: "invalid or missing project name" }, 400);
      const surface = url.searchParams.get("surface") || request.headers.get("x-surface") || "unknown";
      try { return json(await sessionStart(domain, surface, env, licence)); } catch (e) { return json({ error: "load failed", detail: String(e) }, 500); }
    }
    if (path === "/session/write" && request.method === "POST") {
      if (licence.required && !licence.valid) return json({ error: "licence required or invalid" }, 403);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid JSON body" }, 400); }
      const domain = normaliseProject(body.domain || url.searchParams.get("domain"));
      if (!domain) return json({ error: "invalid or missing project name" }, 400);
      try {
        const out = await sessionWrite(domain, body, env, licence);
        return json(out, out.ok === false ? 403 : 200);
      } catch (e) { return json({ error: "write failed", detail: String(e) }, 500); }
    }
    return json({ error: "not found", routes: ["GET /health", "POST /setup", "POST /licence/issue", "GET /rules", "GET /hooks/:name", "PUT /hooks/:name", "GET /session/start?domain=AI", "POST /session/write", "POST /mcp/{token}"] }, 404);
  },
};
