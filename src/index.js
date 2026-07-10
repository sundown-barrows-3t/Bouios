// Thin client worker for customer deployment.
// Personal memory D1 (hot/context/memory/log) + auth + MCP.
// Rules are served by our gateway; never stored in the customer D1.
// Secrets required: BEARER_TOKEN
// Env vars: GATEWAY_URL (set in wrangler.toml)

const MEMORY_TYPES = ["pattern", "mistake", "decision", "pending"];
const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS hot (domain TEXT PRIMARY KEY, state TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS context (domain TEXT NOT NULL, key TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (domain, key))",
  "CREATE TABLE IF NOT EXISTS memory (id INTEGER PRIMARY KEY AUTOINCREMENT, domain TEXT NOT NULL, type TEXT NOT NULL CHECK (type IN ('pattern','mistake','decision','pending')), title TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, source TEXT)",
  "CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, domain TEXT NOT NULL, summary TEXT NOT NULL)",
];
let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  for (const sql of SCHEMA) await db.prepare(sql).run();
  schemaReady = true;
}

const PROJECT_RE = /^[A-Z][A-Z0-9_-]{1,19}$/;
function normaliseProject(raw) {
  const p = String(raw || "").toUpperCase();
  return PROJECT_RE.test(p) ? p : null;
}

function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(a), bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let out = 0;
  for (let i = 0; i < ab.length; i++) out |= ab[i] ^ bb[i];
  return out === 0;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// ---- Licence verification (verify-only) ----------------------------------
// Paid tiers are gated here against a signed licence. Signing happens ONLY on
// the owner's gateway, with a private key that is never shipped. This worker
// only VERIFIES, using the Ed25519 PUBLIC key below (safe to publish) — so a
// self-hoster cannot forge a licence without the private key. This is inert
// until REQUIRE_LICENCE="true" is set, so existing free deployments are
// unaffected. Set LICENCE_PUBLIC_KEY_B64 to your gateway's Ed25519 public key
// (base64 SPKI). Empty = licence checks disabled.
const LICENCE_PUBLIC_KEY_B64 = "";

// Per-tier ceilings. 'free' is the no-/lapsed-licence fallback (what a customer
// drops to when a subscription ends). Values mirror bouios.syndakat.com/join.
const TIER_LIMITS = {
  free:   { projects: 1,        skills: 2 },
  herder: { projects: 1,        skills: 2 },
  pro:    { projects: Infinity, skills: Infinity },
  max:    { projects: Infinity, skills: Infinity },
};

function b64urlToBytes(s) {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const LAPSED = { valid: false, tier: "free", sub: null };

// Verify an Ed25519-signed licence token (header.payload.signature, base64url).
// Returns { valid, tier, sub }; falls back to the lapsed/free tier on any failure.
async function verifyLicence(token) {
  if (!token || !LICENCE_PUBLIC_KEY_B64) return LAPSED;
  const parts = String(token).split(".");
  if (parts.length !== 3) return LAPSED;
  try {
    const key = await crypto.subtle.importKey(
      "spki",
      b64urlToBytes(LICENCE_PUBLIC_KEY_B64),
      { name: "Ed25519" },
      false,
      ["verify"]
    );
    const ok = await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      b64urlToBytes(parts[2]),
      new TextEncoder().encode(parts[0] + "." + parts[1])
    );
    if (!ok) return LAPSED;
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
    if (payload.exp && Math.floor(Date.now() / 1000) > Number(payload.exp)) return LAPSED;
    const tier = Object.prototype.hasOwnProperty.call(TIER_LIMITS, payload.tier) ? payload.tier : "free";
    return { valid: true, tier, sub: payload.sub || null };
  } catch {
    return LAPSED;
  }
}

function licenceFromRequest(request, url, env) {
  return request.headers.get("x-licence") || url.searchParams.get("licence") || (env && env.LICENCE) || null;
}

// Refuse a NEW project once the tier's project ceiling is reached. Only enforced
// when REQUIRE_LICENCE="true". Returns an error string, or null if allowed.
async function projectLimitError(db, domain, lic, env) {
  if (!env || env.REQUIRE_LICENCE !== "true") return null;
  const limit = (TIER_LIMITS[lic.tier] || TIER_LIMITS.free).projects;
  if (!Number.isFinite(limit)) return null;
  const existing = await db
    .prepare("SELECT 1 AS ok FROM (SELECT domain FROM hot UNION SELECT domain FROM memory UNION SELECT domain FROM context UNION SELECT domain FROM log) WHERE domain = ? LIMIT 1")
    .bind(domain)
    .first();
  if (existing) return null;
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM (SELECT domain FROM hot UNION SELECT domain FROM memory UNION SELECT domain FROM context UNION SELECT domain FROM log)")
    .first();
  const count = (row && row.n) || 0;
  if (count >= limit) {
    return `Project limit reached: the ${lic.tier} tier allows ${limit} project${limit === 1 ? "" : "s"}. Upgrade at bouios.syndakat.com/join, or write to an existing project.`;
  }
  return null;
}

async function fetchRules(env) {
  if (!env.GATEWAY_URL) return [];
  try {
    const r = await fetch(env.GATEWAY_URL + "/rules");
    if (!r.ok) return [];
    const data = await r.json();
    return Array.isArray(data.rules) ? data.rules : [];
  } catch {
    return [];
  }
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

async function sessionLoad(domain, surface, env) {
  const db = env.DB;
  await ensureSchema(db);
  const [rules, hot, context, pending, recent, memTotal] = await Promise.all([
    fetchRules(env),
    db.prepare("SELECT state, updated_at FROM hot WHERE domain = ?").bind(domain).all(),
    db.prepare("SELECT key, content FROM context WHERE domain = ?").bind(domain).all(),
    db.prepare("SELECT id, type, title, body FROM memory WHERE (domain = ? OR domain = 'GLOBAL') AND type = 'pending' ORDER BY id").bind(domain).all(),
    db.prepare("SELECT id, type, title, body FROM memory WHERE (domain = ? OR domain = 'GLOBAL') AND type != 'pending' ORDER BY id DESC LIMIT 40").bind(domain).all(),
    db.prepare("SELECT COUNT(*) AS n FROM memory WHERE domain = ? OR domain = 'GLOBAL'").bind(domain).first(),
  ]);
  const hotRow = (hot.results && hot.results[0]) || null;
  const hotState = hotRow ? hotRow.state : null;
  const hotDate = hotRow ? hotRow.updated_at : "none";
  const openN = countOpenTasks(hotState);
  await db.prepare("INSERT INTO log (ts, domain, summary) VALUES (datetime('now'), ?, ?)").bind(domain, "Session loaded, surface=" + (surface || "mcp")).run();
  return {
    confirmation: "Memory loaded: " + domain + ", " + rules.length + " rules, hot from " + hotDate + ", " + openN + " open tasks.",
    domain,
    rules,
    hot: hotState,
    hot_updated: hotDate,
    open_tasks: openN,
    context: context.results || [],
    memory: [...(pending.results || []), ...(recent.results || [])],
    memory_total: memTotal ? memTotal.n : 0,
  };
}

async function sessionWrite(domain, body, db) {
  await ensureSchema(db);
  const applied = [];
  if (typeof body.hot === "string" && body.hot.length) {
    await db.prepare("INSERT INTO log (ts, domain, summary) SELECT datetime('now'), ?, 'HOT ARCHIVE: ' || state FROM hot WHERE domain = ?").bind(domain, domain).run();
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

async function sessionLoaded(db, sessionId) {
  if (!sessionId) return false;
  const row = await db.prepare("SELECT 1 AS ok FROM log WHERE summary LIKE ? AND ts > datetime('now', '-1 day') LIMIT 1").bind("%session=" + sessionId + "%").first();
  return !!row;
}

// ---- MCP (JSON-RPC 2.0, Streamable HTTP) ----

const MCP_PROTOCOL = "2025-03-26";
// Tool identifiers are Bouios-branded (2026-07-02): the platform's own
// permission dialogs render the raw technical tool name with zero branding -
// confirmed by owner screenshot on the owner's own connector, applies
// identically to every customer's connector. Mirrors memory-gateway/src.
const MCP_INSTRUCTIONS =
  "This is Bouios, your memory system. Call bouios_load for the active project first, before any other work. " +
  "'load memory', 'load rules' and 'load Bouios' each trigger bouios_load immediately. " +
  "Surface only the returned confirmation line to the user. " +
  "Every few substantive steps and before any long operation, call bouios_save with the full working state, then output a handoff block in a code box. Do not wait until 70% context - by then it may be too late. " +
  "Call bouios_handoff when the conversation nears its limit and show the user the returned block to paste into a new chat. " +
  "If your memory tools are unavailable or error, do not stall or block - continue in a degraded mode; they reconnect on their own.";

const MCP_TOOLS = [
  {
    name: "bouios_load",
    description:
      "Load memory for a project (rules, working state, context, patterns). " +
      "Must be called first in every conversation before any other work. " +
      "Triggers on user messages: 'load memory', 'load rules', 'load Bouios'.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name (uppercase, 2-20 chars)." },
        surface: { type: "string", description: "Where this session runs: chat, cowork, code, dispatch." },
      },
      required: ["project"],
    },
  },
  {
    name: "bouios_save",
    description: "Save updates: hot state, memory entries, context rows, log lines. Requires bouios_load first.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        hot: { type: "string", description: "Full current working state." },
        memory: {
          type: "array",
          items: {
            type: "object",
            properties: { type: { type: "string", enum: MEMORY_TYPES }, title: { type: "string" }, body: { type: "string" } },
            required: ["type", "title", "body"],
          },
        },
        context: {
          type: "array",
          items: { type: "object", properties: { key: { type: "string" }, content: { type: "string" } }, required: ["key", "content"] },
        },
        log: { type: "array", items: { type: "string" } },
      },
      required: ["project"],
    },
  },
  {
    name: "bouios_handoff",
    description: "Save hot state and return a continuation block to paste into a new chat.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        hot: { type: "string", description: "Full current working state to save." },
        next_step: { type: "string", description: "One line: the immediate next action for the new chat." },
      },
      required: ["project"],
    },
  },
];

function rpcResult(id, result) { return { jsonrpc: "2.0", id, result }; }
function rpcError(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }
function toolText(id, text, isError) {
  const result = { content: [{ type: "text", text }] };
  if (isError) result.isError = true;
  return rpcResult(id, result);
}

async function handleMsg(msg, sessionId, env, lic) {
  const id = msg && msg.id !== undefined ? msg.id : null;
  lic = lic || LAPSED;
  const method = msg && msg.method;
  if (!method) return rpcError(id, -32600, "invalid request");
  if (method === "initialize") {
    return rpcResult(id, {
      protocolVersion: MCP_PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: "memory", version: "2.0.0" },
      instructions: MCP_INSTRUCTIONS,
    });
  }
  if (method === "ping") return rpcResult(id, {});
  if (method === "tools/list") return rpcResult(id, { tools: MCP_TOOLS });
  if (method === "tools/call") {
    const name = msg.params && msg.params.name;
    const args = (msg.params && msg.params.arguments) || {};
    const domain = normaliseProject(args.project || args.domain);
    if (!domain) return toolText(id, "Invalid project name. Use 2-20 chars, start with a letter.", true);
    try {
      if (name === "bouios_load") {
        const surface = (args.surface || "mcp") + " session=" + (sessionId || "none");
        return toolText(id, JSON.stringify(await sessionLoad(domain, surface, env)));
      }
      if (name === "bouios_save") {
        if (!(await sessionLoaded(env.DB, sessionId))) return toolText(id, "Write refused: call bouios_load first.", true);
        const limitErr = await projectLimitError(env.DB, domain, lic, env);
        if (limitErr) return toolText(id, limitErr, true);
        return toolText(id, JSON.stringify(await sessionWrite(domain, args, env.DB)));
      }
      if (name === "bouios_handoff") {
        if (!(await sessionLoaded(env.DB, sessionId))) return toolText(id, "Handoff refused: call bouios_load first.", true);
        const limitErr = await projectLimitError(env.DB, domain, lic, env);
        if (limitErr) return toolText(id, limitErr, true);
        const saved = [];
        if (typeof args.hot === "string" && args.hot.length) {
          const out = await sessionWrite(domain, { hot: args.hot, log: ["Session handoff."] }, env.DB);
          saved.push(...out.applied);
        }
        const next = typeof args.next_step === "string" && args.next_step.length ? args.next_step : "resume open tasks";
        const block = "load memory\nProject: " + domain + ". Continue previous session. First action: " + next;
        return toolText(id, JSON.stringify({ saved, handoff_block: block, instruction: "Show handoff_block to the user in a code box." }));
      }
    } catch (e) {
      return toolText(id, "tool failed: " + String(e), true);
    }
    return toolText(id, "unknown tool: " + String(name), true);
  }
  if (msg.id === undefined || msg.id === null) return null;
  return rpcError(id, -32601, "method not found");
}

async function handleMcp(request, env) {
  if (request.method === "DELETE") return new Response(null, { status: 204 });
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST, DELETE" } });
  let body;
  try { body = await request.json(); } catch { return json(rpcError(null, -32700, "parse error"), 400); }
  let sessionId = request.headers.get("mcp-session-id");
  const msgs = Array.isArray(body) ? body : [body];
  if (!sessionId && msgs.some((m) => m && m.method === "initialize")) sessionId = crypto.randomUUID();
  const lic = await verifyLicence(licenceFromRequest(request, new URL(request.url), env));
  const responses = [];
  for (const m of msgs) {
    const r = await handleMsg(m, sessionId, env, lic);
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
    if (path === "/health") return json({ ok: true, service: "memory-vault" });
    if (path.startsWith("/mcp/")) {
      const token = path.slice(5);
      if (!env.BEARER_TOKEN || !token || !timingSafeEqual(token, env.BEARER_TOKEN)) return json({ error: "unauthorised" }, 401);
      return handleMcp(request, env);
    }
    // Remaining routes require bearer auth
    const h = request.headers.get("authorization") || "";
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m || !env.BEARER_TOKEN || !timingSafeEqual(m[1], env.BEARER_TOKEN)) return json({ error: "unauthorised" }, 401);
    return json({ error: "not found", routes: ["GET /health", "POST /mcp/{token}"] }, 404);
  },
};
