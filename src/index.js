// Thin client worker for customer deployment.
// Personal memory D1 (hot/context/memory/log) + auth + MCP.
// Rules are served by our gateway; never stored in the customer D1.
// Secrets required: BEARER_TOKEN
// Optional secret: LICENCE (the key from your licence email; without it memory
// still works). Optional bucket binding: TRANSCRIPTS (session transcripts and
// chat session records kept in your own storage).
// Env vars: GATEWAY_URL (set in wrangler.toml)

// Inlined from memory-gateway/src/text-generator.js (not imported: this file is
// deployed standalone via a single-module REST upload with no bundler, so a
// relative import outside this directory fails on Cloudflare with "Invalid
// module specifier" - confirmed live via a real install-rest.sh deploy, error
// 10021. Keep this block's logic identical to text-generator.js by hand;
// memory-gateway/test/worker-gateway-parity.test.mjs checks the MEMORY_NOTE
// text stays present here regardless of source.
// One format on every surface (A2, 2026-10-06) - see text-generator.js.
function confirmationText(domain, rulesN, hotDate, openN, branded = false) {
  return `Bouios loaded - working set ${domain}, ${rulesN} rules loaded, ${openN} items flagged for follow-up.`;
}
const MEMORY_NOTE = "titles only - call bouios_get({project, ids:[...]}) for full body of any row you need";

const MEMORY_TYPES = ["pattern", "mistake", "decision", "pending"];
const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS hot (domain TEXT PRIMARY KEY, state TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS context (domain TEXT NOT NULL, key TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (domain, key))",
  "CREATE TABLE IF NOT EXISTS memory (id INTEGER PRIMARY KEY AUTOINCREMENT, domain TEXT NOT NULL, type TEXT NOT NULL CHECK (type IN ('pattern','mistake','decision','pending')), title TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, source TEXT)",
  "CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, domain TEXT NOT NULL, summary TEXT NOT NULL)",
  // SAVE MUST NOT MAKE EVERY FUTURE LOAD MORE EXPENSIVE (2026-09-17). Parity
  // with the gateway, and a customer's store fills exactly the same way ours did.
  // log had no index of any kind, so every query against it was a full descending
  // scan of the whole table. Measured on the owner's store that day: 15,840 rows,
  // of which 1,318 are HOT ARCHIVE rows totalling 3,569,680 characters - 8.3% of
  // the rows and 52% of the bytes, because the archive INSERT above is the one
  // writer into this table with no length cap (a real log line is capped at
  // LOG_LINE_MAX 400; an archive averaged 2,708 and reached 10,256). So every
  // save made every later read of this table cost more, for ever.
  // (domain, id) is the shape the reads ask for: seek to the project, walk its
  // own rows newest first, stop at the LIMIT. Nothing is deleted and no result
  // changes - only what it costs to get it.
  "CREATE INDEX IF NOT EXISTS log_domain_id ON log (domain, id)",
  // Sign-in surface for hosted connectors (2026-08-04, ported from the gateway).
  // A hosted claude.ai connector sends no credential in any slot, so without this
  // a customer on chat gets a bare 401 with no way in - the same defect the
  // gateway had. The customer's own BEARER_TOKEN is the key the authorize step
  // checks; the access token IS that token, which /mcp then accepts.
  // Where each chat/Cowork session's record has got to (2026-10-06):
  // which part object is being filled and how many bytes it holds, so adding a
  // line does not have to list the bucket. See recordChatTurn.
  // Past-chat excerpt index (2026-10-27, BOUIOS 4053): what the user typed in each stored transcript, so the
  // per-message lookup and bouios_transcripts can find a past chat. Same table as the owner gateway's.
  "CREATE TABLE IF NOT EXISTS transcript_excerpts (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, turn_index INTEGER NOT NULL, ts TEXT, domain TEXT NOT NULL, excerpt TEXT NOT NULL, UNIQUE(session_id, turn_index))",
  "CREATE INDEX IF NOT EXISTS transcript_excerpts_domain_id ON transcript_excerpts (domain, id)",
  "CREATE TABLE IF NOT EXISTS chat_record_parts (session_id TEXT PRIMARY KEY, part INTEGER NOT NULL DEFAULT 0, size INTEGER NOT NULL DEFAULT 0, updated_at TEXT)",
  // The last rules and instructions our service sent this licensed install
  // (2026-10-07), so our service being unreachable cannot strip it. See rememberLicensed.
  "CREATE TABLE IF NOT EXISTS licensed_text_cache (kind TEXT PRIMARY KEY, body TEXT NOT NULL, at INTEGER NOT NULL)",
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

// LAST KNOWN GOOD (owner, 2026-10-07: "If you lock make sure we don't get locked
// out on error"). The paid rules and instructions come from our service, so an
// outage there would drop a paying install to nothing or to the short fallback.
// Each time our service answers this install as licensed, the text is kept in
// this install's own database (table licensed_text_cache); when a later fetch
// FAILS, that same text is served again for up to 30 days. The store holds only
// text this licensed install was already sent, never anything newly fetched for
// someone else. An answer that says "not licensed" is a real answer, not a
// failure: it is served as sent and the stored text is not used.
const LAST_GOOD_MAX_AGE_MS = 30 * 86400000;
const LAST_GOOD_REWRITE_MS = 24 * 3600000;
// What was last stored, read once per database per isolate so a load does not
// cost a read: Map(kind -> { body, at }).
const licensedSeen = new WeakMap();
async function rememberLicensed(env, kind, body) {
  if (!env.DB) return;
  try {
    await ensureSchema(env.DB);
    let seen = licensedSeen.get(env.DB);
    if (!seen) { seen = new Map(); licensedSeen.set(env.DB, seen); }
    let last = seen.get(kind);
    if (!last) {
      const row = await env.DB.prepare("SELECT body, at FROM licensed_text_cache WHERE kind = ?").bind(kind).first();
      last = row ? { body: row.body, at: Number(row.at) } : { body: null, at: 0 };
      seen.set(kind, last);
    }
    const now = Date.now();
    if (last.body === body && now - last.at < LAST_GOOD_REWRITE_MS) return;
    await env.DB.prepare("INSERT INTO licensed_text_cache (kind, body, at) VALUES (?, ?, ?) ON CONFLICT(kind) DO UPDATE SET body = excluded.body, at = excluded.at").bind(kind, body, now).run();
    seen.set(kind, { body, at: now });
  } catch {
    // keeping a copy must never break a load
  }
}
async function lastLicensed(env, kind) {
  if (!env.DB) return null;
  try {
    await ensureSchema(env.DB);
    const row = await env.DB.prepare("SELECT body, at FROM licensed_text_cache WHERE kind = ?").bind(kind).first();
    if (row && typeof row.body === "string" && Date.now() - Number(row.at) < LAST_GOOD_MAX_AGE_MS) return row.body;
  } catch {
    // no stored copy
  }
  return null;
}

// The licence goes in a header, never in the URL, so it stays out of logs. With
// no licence the service answers with its small free set (no switch), which
// still works. If the service cannot be reached or answers badly, an install
// with a licence is served the last text it was sent as licensed (see above);
// with no licence, or nothing stored, the answer is no rules as before.
async function fetchRules(env, token) {
  if (!env.GATEWAY_URL) return [];
  try {
    const r = await fetch(env.GATEWAY_URL + "/rules", { headers: token ? { "x-licence": token } : {} });
    if (r.ok) {
      const data = await r.json();
      if (data && Array.isArray(data.rules)) {
        if (data.licensed === true) await rememberLicensed(env, "rules", JSON.stringify(data.rules));
        return data.rules;
      }
    }
  } catch {
    // fall through to the last known good
  }
  if (token) {
    const stored = await lastLicensed(env, "rules");
    if (stored) {
      try { const rules = JSON.parse(stored); if (Array.isArray(rules)) return rules; } catch { /* unusable copy */ }
    }
  }
  return [];
}

// ---- Self-host access check (2026-08-30) -----------------------------------
// HISTORY: 448b134 (2026-07-10) added a local gate to this file once, using
// an embedded key and a local ceiling table. It was reverted the same day
// (0da9b09) - not for being broken, its own commit message records a
// verified crypto round trip, but because keeping ANY of that logic here at
// all is wrong: this file is the customer-deployable artifact
// (test-public-leak.sh enforces it, after a real 2026-07-01 incident where
// commercial internals leaked into the public template), and it must never
// hold pricing/tier logic or the words that name it.
//
// So this worker holds no table, no key, no config flag naming what it is -
// it forwards a token (if one is set) plus its own project count to the
// gateway and obeys a plain yes/no. All of that logic lives at
// memory-gateway/src/index.js's GET /licence/verify?existing=&total=.
//
// INERT BY DEFAULT: no existing free/alpha deployment has ever had a token
// configured, so this never runs for them - no separate on/off flag needed,
// presence of a token IS the switch.
const NO_ACCESS_CHECK = { ok: true, note: null };

// TRANSCRIPTS IN YOUR OWN STORAGE. Session transcripts are kept in a bucket in
// this account (binding TRANSCRIPTS) and nowhere else: nothing here sends one
// to any other service. Nothing is ever deleted. How far back they are listed
// and read is a number of days the gateway returns with the licence check; this
// file holds no plan logic, only obeys the number. With no licence set, or if
// the gateway cannot be reached, the window is open - the same fail-open rule
// as checkAccess above, so a network problem never hides a customer's own data.
const TRANSCRIPT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
async function historyWindowDays(request, url, env) {
  const token = accessTokenFromRequest(request, url, env);
  if (!token || !env.GATEWAY_URL) return null;
  try {
    const r = await fetch(env.GATEWAY_URL + "/licence/verify?licence=" + encodeURIComponent(token), { headers: { "x-licence": token } });
    if (!r.ok) return null;
    const v = await r.json();
    return v && Number.isFinite(v.history_days) && v.history_days >= 0 ? v.history_days : null;
  } catch {
    return null;
  }
}
// PAST-CHAT EXCERPT INDEX (2026-10-27, BOUIOS 4053; owner: "How the hell does customer have no transcripts").
// The owner gateway has indexed what the owner typed in every uploaded transcript since 25 Sep (ddaff8e), so
// its per-message lookup finds a past chat. This worker stored the customer's transcripts but never indexed
// them, so their lookup could not. These are the gateway's own functions (extractOwnerTurnExcerpts,
// ownerTurnExcerptOfLine, ownerTurnExcerptsFromStream), copied because this file deploys standalone.
// Only what the person typed is indexed: never the model's words, never a tool result riding the user role.
// Everything stays in this account: the index is a table in this worker's own database.
function extractOwnerTurnExcerpts(text) {
  const out = [];
  const lines = String(text || "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec || rec.type !== "user") continue;
    const msg = rec.message;
    if (!msg || typeof msg !== "object") continue;
    let raw = "";
    if (typeof msg.content === "string") {
      raw = msg.content;
    } else if (Array.isArray(msg.content)) {
      const textParts = msg.content.filter((p) => p && p.type === "text" && typeof p.text === "string");
      if (!textParts.length) continue;
      raw = textParts.map((p) => p.text).join(" ");
    } else {
      continue;
    }
    raw = raw.trim();
    if (!raw) continue;
    const ts = typeof rec.timestamp === "string" ? rec.timestamp : null;
    out.push({ turn_index: i, ts, excerpt: raw.slice(0, 300) });
  }
  return out;
}
function ownerTurnExcerptOfLine(line, i) {
  line = line.trim();
  if (!line || line.indexOf('"user"') === -1) return null;
  return extractOwnerTurnExcerpts(line).map((r) => ({ ...r, turn_index: i }))[0] || null;
}
const TRANSCRIPT_LINE_MAX_CHARS = 1024 * 1024;
async function ownerTurnExcerptsFromStream(byteStream) {
  const out = [];
  const reader = byteStream.pipeThrough(new TextDecoderStream()).getReader();
  let carry = "", dropping = false, i = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const parts = value.split("\n");
    for (let k = 0; k < parts.length; k++) {
      if (!dropping) { carry += parts[k]; if (carry.length > TRANSCRIPT_LINE_MAX_CHARS) { carry = ""; dropping = true; } }
      if (k < parts.length - 1) {
        if (!dropping) { const r = ownerTurnExcerptOfLine(carry, i); if (r) out.push(r); }
        i++; carry = ""; dropping = false;
      }
    }
  }
  if (!dropping) { const last = ownerTurnExcerptOfLine(carry, i); if (last) out.push(last); }
  return out;
}
const transcriptSessionId = (key) => String(key).replace(/^transcript:/, "").replace(/\.jsonl(\.gz)?$/, "");
// Re-index one stored transcript: delete its rows, insert the fresh set (an upload is the whole transcript,
// never a delta, so this can never duplicate). Reads the stored object, so a streamed upload is indexed too.
// FAIL OPEN: the upload has already been stored when this runs; an indexing error never fails it.
async function indexStoredTranscript(env, key, domain) {
  try {
    const obj = await env.TRANSCRIPTS.get(key);
    if (!obj || !obj.body) return 0;
    let src = obj.body;
    if (/\.gz$/.test(key)) {
      if (typeof DecompressionStream === "undefined") return 0;
      src = src.pipeThrough(new DecompressionStream("gzip"));
    }
    const rows = await ownerTurnExcerptsFromStream(src);
    await ensureSchema(env.DB);
    const sid = transcriptSessionId(key);
    await env.DB.prepare("DELETE FROM transcript_excerpts WHERE session_id = ?").bind(sid).run();
    const ins = (r) => env.DB.prepare("INSERT INTO transcript_excerpts (session_id, turn_index, ts, domain, excerpt) VALUES (?, ?, ?, ?, ?)").bind(sid, r.turn_index, r.ts, domain || "", r.excerpt);
    for (let k = 0; k < rows.length; k += 50) await env.DB.batch(rows.slice(k, k + 50).map(ins));
    return rows.length;
  } catch (_) {
    return 0;
  }
}
// The project an upload names (header x-bouios-project, sent by the upload hook from the session's own load),
// or "" for an untagged upload. Untagged past chats are searched for every project of this account, as the
// owner gateway treats untagged transcripts.
const uploadProject = (request) => normaliseProject(request.headers.get("x-bouios-project") || "") || "";
// Index after the response, off the upload's path: a large transcript must never slow or fail the upload.
function afterTranscriptPut(env, ctx, key, domain) {
  if (String(key).startsWith("chat/")) return;
  const job = indexStoredTranscript(env, key, domain);
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(job);
  else globalThis.__lastTranscriptIndex = job; // in-process tests with no ctx await this
}
// The plan's history window, asked once per isolate per ten minutes (only the licence is sent, never data).
let historyCache = { at: 0, days: undefined };
async function historyWindowDaysCached(request, url, env) {
  if (historyCache.days !== undefined && Date.now() - historyCache.at < 600000) return historyCache.days;
  const days = await historyWindowDays(request, url, env);
  historyCache = { at: Date.now(), days };
  return days;
}

async function transcriptRoute(request, env, url, path, ctx) {
  if (!env.TRANSCRIPTS) return json({ error: "transcript storage is not set up on this install" }, 501);
  let id = "";
  try { id = path === "/transcript" ? "" : decodeURIComponent(path.slice("/transcript/".length)); } catch { return json({ error: "invalid transcript id" }, 400); }
  if (id && !TRANSCRIPT_ID.test(id)) return json({ error: "invalid transcript id" }, 400);
  if (request.method === "PUT") {
    if (!id) return json({ error: "a transcript id is required" }, 400);
    // A session transcript only grows, so a re-upload replaces it with a longer
    // copy. A SHORTER upload under an existing id is refused: it would wipe part
    // of what is stored, and nothing here ever loses data.
    // STREAMED, NOT HELD (2026-10-06, rebuild A4): with a declared length the
    // body goes straight to the bucket through a FixedLengthStream (errors if
    // the bytes differ from the header), so a 90MB+ transcript never sits whole
    // in the 128MB isolate - the cause of the owner gateway's out-of-memory
    // 503s (memory 3169). The shorter-copy check uses the declared length.
    // Without one (chunked) it is buffered and checked as before.
    const opts = { httpMetadata: { contentType: request.headers.get("content-type") || "application/x-ndjson" }, ...(uploadProject(request) ? { customMetadata: { project: uploadProject(request) } } : {}) };
    const declared = Number(request.headers.get("content-length") || 0);
    const existing = await env.TRANSCRIPTS.head(id);
    const tooShort = (n) => existing && n < existing.size;
    if (Number.isFinite(declared) && declared > 0 && request.body && typeof FixedLengthStream !== "undefined") {
      if (tooShort(declared)) return json({ error: "a transcript with this id is already stored and is longer; upload under a new id" }, 409);
      const { readable, writable } = new FixedLengthStream(declared);
      const [put] = await Promise.all([env.TRANSCRIPTS.put(id, readable, opts), request.body.pipeTo(writable)]);
      afterTranscriptPut(env, ctx, id, uploadProject(request));
      return json({ ok: true, id, size: put ? put.size : declared });
    }
    const bytes = await request.arrayBuffer();
    if (tooShort(bytes.byteLength)) return json({ error: "a transcript with this id is already stored and is longer; upload under a new id" }, 409);
    const put = await env.TRANSCRIPTS.put(id, bytes, opts);
    afterTranscriptPut(env, ctx, id, uploadProject(request));
    return json({ ok: true, id, size: put ? put.size : bytes.byteLength });
  }
  if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
  const days = await historyWindowDays(request, url, env);
  const since = days === null ? 0 : Date.now() - days * 86400000;
  const inWindow = (o) => days === null || (o.uploaded && new Date(o.uploaded).getTime() >= since);
  if (!id) {
    const items = [];
    let cursor;
    do {
      const page = await env.TRANSCRIPTS.list({ cursor, limit: 1000 });
      // Chat/Cowork session records live under chat/ in the same bucket but are
      // not transcripts (a trail mixed into this listing could not
      // be told apart); they are listed at GET /chat only.
      for (const o of page.objects) if (!o.key.startsWith("chat/") && inWindow(o)) items.push({ id: o.key, size: o.size, uploaded: o.uploaded });
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    items.sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded));
    return json({ ok: true, history_days: days, transcripts: items });
  }
  const obj = await env.TRANSCRIPTS.get(id);
  if (!obj) return json({ error: "not found" }, 404);
  if (!inWindow(obj)) return json({ error: "this transcript is older than your plan's history period; it is still in your storage" }, 403);
  return new Response(obj.body, { headers: { "content-type": (obj.httpMetadata && obj.httpMetadata.contentType) || "application/x-ndjson" } });
}

// CHAT AND COWORK SESSION RECORD IN YOUR OWN BUCKET (2026-10-06).
// Chat and Cowork have no hooks, so the Code transcript uploader never runs
// there (owner, 30 Sep: customer data saves to their own Cloudflare on every
// surface). This worker already sees every Bouios tool call of a
// chat session and its session id, so it records what it saw.
// This is a SESSION RECORD, NOT THE CONVERSATION: the Bouios tool calls (load,
// save, get, ...) with their arguments and a clipped answer. The worker never
// sees the rest of the chat. It is kept apart from real transcripts (key prefix
// chat/, its own route) because an event trail mixed into the transcript listing
// could not be told apart from a transcript.
// COST, on the customer's own bill: each recorded request is one bucket read
// (Class B) plus one write (Class A) and two small database statements. The storage free
// tier is 1,000,000 Class A and 10,000,000 Class B operations a month, then
// $4.50 / $0.36 per million (developers.cloudflare.com/r2/pricing, read 2026-10-06).
const CHAT_SESSION_ID = /^[A-Za-z0-9-]{8,100}$/;
const CHAT_PART_CAP = 1048576; // bytes per part object; past it a new part starts, nothing is dropped
const CHAT_ANSWER_CLIP = 4000; // characters of each tool answer kept
const CHAT_ARG_CLIP = 20000; // characters kept per string argument
const clipStr = (v, n) => (typeof v === "string" && v.length > n ? v.slice(0, n) : v);
// One JSON line (ending "\n") for a message, or null for what is not recorded
// (tools/list, ping, notifications). The load_token is never written: it is a
// credential and the bucket is read back through /chat.
function chatLine(msg, response, sessionId) {
  if (!msg || typeof msg !== "object") return null;
  const ts = new Date().toISOString();
  if (msg.method === "initialize") {
    const ci = (msg.params && msg.params.clientInfo) || {};
    const client = { name: clipStr(typeof ci.name === "string" ? ci.name : null, 100), version: clipStr(typeof ci.version === "string" ? ci.version : null, 100) };
    return JSON.stringify({ ts, session: sessionId, event: "start", client }) + "\n";
  }
  if (msg.method === "tools/call") {
    const params = msg.params || {};
    const raw = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
    const args = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k === "load_token") continue;
      args[k] = clipStr(v, CHAT_ARG_CLIP);
    }
    const result = response && response.result;
    const rpcErr = response && response.error;
    let answer = "";
    if (rpcErr) answer = String(rpcErr.message || "");
    else if (result && Array.isArray(result.content)) answer = result.content.filter((c) => c && typeof c.text === "string").map((c) => c.text).join("\n");
    // A load's answer carries the load_token it minted (JSON escaped inside the text).
    answer = answer.replace(/(\\?"load_token\\?"\s*:\s*\\?")[^"\\]*/g, "$1[not kept]");
    return JSON.stringify({
      ts, session: sessionId, event: "tool", tool: params.name || null,
      project: args.project || args.domain || null, surface: args.surface || null,
      args, answer: clipStr(answer, CHAT_ANSWER_CLIP), error: !!((result && result.isError) || rpcErr),
    }) + "\n";
  }
  return null;
}
// The bucket has no append, so a line is read, added and written back. Two
// requests of the same session landing at the same instant can lose one of them
// (accepted: clients send a session's calls one at a time). A failure here
// is swallowed: recording never touches the tool answer.
async function recordChatTurn(env, sessionId, text) {
  if (!text || !env.TRANSCRIPTS || !env.DB || !sessionId || !CHAT_SESSION_ID.test(sessionId)) return;
  try {
    await ensureSchema(env.DB);
    const row = await env.DB.prepare("SELECT part, size FROM chat_record_parts WHERE session_id = ?").bind(sessionId).first();
    let part = (row && Number(row.part)) || 0;
    let size = (row && Number(row.size)) || 0;
    const add = new TextEncoder().encode(text).byteLength;
    if (size > 0 && size + add > CHAT_PART_CAP) { part += 1; size = 0; }
    const key = "chat/" + sessionId + "/" + String(part).padStart(4, "0") + ".jsonl";
    let prior = "";
    if (size > 0) {
      const obj = await env.TRANSCRIPTS.get(key);
      prior = obj ? await obj.text() : "";
    }
    await env.TRANSCRIPTS.put(key, prior + text, { httpMetadata: { contentType: "application/x-ndjson" } });
    const newSize = new TextEncoder().encode(prior).byteLength + add;
    await env.DB.prepare("INSERT INTO chat_record_parts (session_id, part, size, updated_at) VALUES (?, ?, ?, datetime('now')) ON CONFLICT(session_id) DO UPDATE SET part = excluded.part, size = excluded.size, updated_at = excluded.updated_at")
      .bind(sessionId, part, newSize).run();
  } catch (_) {}
}
// GET /chat lists the records, GET /chat/<session>/<nnnn>.jsonl reads one. Read
// only: nothing outside the worker writes or deletes a record.
const CHAT_RECORD_ID = /^[A-Za-z0-9-]{8,100}\/\d{4}\.jsonl$/;
async function chatRoute(request, env, url, path) {
  if (!env.TRANSCRIPTS) return json({ error: "transcript storage is not set up on this install" }, 501);
  if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
  const days = await historyWindowDays(request, url, env);
  const since = days === null ? 0 : Date.now() - days * 86400000;
  const inWindow = (o) => days === null || (o.uploaded && new Date(o.uploaded).getTime() >= since);
  if (path === "/chat") {
    const items = [];
    let cursor;
    do {
      const page = await env.TRANSCRIPTS.list({ prefix: "chat/", cursor, limit: 1000 });
      for (const o of page.objects) if (o.key.startsWith("chat/") && inWindow(o)) items.push({ id: o.key.slice(5), size: o.size, uploaded: o.uploaded });
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    items.sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded));
    return json({ ok: true, history_days: days, note: "Session records: the Bouios tool calls the worker saw in chat and Cowork sessions, not the conversation itself.", records: items });
  }
  let id = "";
  try { id = decodeURIComponent(path.slice("/chat/".length)); } catch { return json({ error: "invalid record id" }, 400); }
  if (!CHAT_RECORD_ID.test(id)) return json({ error: "invalid record id" }, 400);
  const obj = await env.TRANSCRIPTS.get("chat/" + id);
  if (!obj) return json({ error: "not found" }, 404);
  if (!inWindow(obj)) return json({ error: "this record is older than your plan's history period; it is still in your storage" }, 403);
  return new Response(obj.body, { headers: { "content-type": (obj.httpMetadata && obj.httpMetadata.contentType) || "application/x-ndjson" } });
}

function accessTokenFromRequest(request, url, env) {
  return request.headers.get("x-licence") || url.searchParams.get("licence") || env.LICENCE || null;
}

// Fail-open on any gateway/network problem, deliberately: this worker was
// fully open before this existed, so an unreachable gateway degrading to
// "allowed" is a false negative on a system that used to have no check at
// all - never a new way to lock a real customer out of their own data.
// Existence is checked against `hot` only, not log/memory/context: every
// domain that was ever loaded has a "Session loaded" log row before any
// save can even be attempted (the load-before-write gate requires it), so
// checking log made every domain look pre-existing and nothing ever
// triggered - caught by this file's own test going green on a bug, not by
// inspection, before this was routed through the gateway at all.
async function checkAccess(db, domain, request, url, env) {
  const token = accessTokenFromRequest(request, url, env);
  if (!token || !env.GATEWAY_URL) return NO_ACCESS_CHECK;
  const row = await db
    .prepare("SELECT (SELECT COUNT(*) FROM hot WHERE domain = ?1) AS already, (SELECT COUNT(DISTINCT domain) FROM hot) AS total")
    .bind(domain)
    .first();
  const existing = row && row.already ? "1" : "0";
  const total = (row && row.total) || 0;
  try {
    const r = await fetch(
      env.GATEWAY_URL + "/licence/verify?licence=" + encodeURIComponent(token) + "&existing=" + existing + "&total=" + total,
      { headers: { "x-licence": token } }
    );
    if (!r.ok) return NO_ACCESS_CHECK;
    const v = await r.json();
    if (!v || typeof v !== "object" || v.allowed === undefined) return NO_ACCESS_CHECK;
    return { ok: !!v.allowed, note: v.reason || null };
  } catch {
    return NO_ACCESS_CHECK;
  }
}

// OPEN ITEMS ARE COUNTED FROM WHAT THE RECORD ACTUALLY SAYS (2026-09-10).
//
// countOpenTasks below matches bullets under a literal "## STILL OPEN" heading.
// Measured against the live store: no hot state has used that heading in
// months, so it returned 0 on every load - while the store held ONE pending row
// and the current hot named seven unfinished items in prose. Every session on
// every surface was told "0 open tasks" and started believing nothing was
// outstanding. Over the same period the owner raised "you left items open" 48
// times. That is a mechanical cause, not a behaviour one, and it is in the
// gateway, so fixing it reaches Chat and Cowork where no hook exists.
//
// CONSERVATIVE ON PURPOSE. hot is free prose, and a loose matcher would turn
// every sentence describing FINISHED work into a false open item - worse than
// zero, because a list that is always wrong gets ignored, which is the
// over-firing failure this repo has shipped twice. Only four sources count:
// real pending rows, bullets under the existing heading (kept, not replaced), a
// NEXT block, and lines carrying an explicit unfinished marker. Bounded to 12
// items of 160 characters so it cannot grow into the payload.
const OPEN_MARKER = /\b(not yet (?:verified|confirmed|checked|done)|still (?:open|unverified|outstanding|not)|unverified|remains? open|outstanding|to do|todo)\b/i;
// A SENTENCE SAYING THERE IS NOTHING OUTSTANDING IS NOT AN OUTSTANDING ITEM.
// Caught by this reader's own over-counting case rather than by reading it:
// "Everything landed and both runs are green. Nothing outstanding." matched on
// the word outstanding and reported one open item, so a finished state produced
// a false count in the one line every session reads. Checked BEFORE the marker,
// because the marker word is present either way.
const OPEN_NEGATED = /\b(no|none|nothing|not)\b[^.]{0,40}\b(outstanding|open|unverified|remaining|left|to do|todo)\b/i;

function openItems(hotState, pendingRows) {
  const out = [];
  const push = (s) => {
    const t = String(s || "").replace(/\s+/g, " ").trim();
    if (t.length < 8) return;
    if (out.length >= 12) return;
    if (out.some((o) => o.slice(0, 60) === t.slice(0, 60))) return;
    out.push(t.slice(0, 160));
  };

  for (const r of pendingRows || []) push("pending " + r.id + ": " + r.title);

  const hot = String(hotState || "");
  if (hot) {
    // The existing heading, kept so a hot state written the old way still works.
    const h = hot.search(/##\s*STILL OPEN/i);
    if (h !== -1) {
      const after = hot.slice(h);
      const nxt = after.slice(3).search(/\n##\s/);
      for (const l of (nxt === -1 ? after : after.slice(0, nxt + 3)).split("\n")) {
        if (/^\s*-\s+/.test(l)) push(l.replace(/^\s*-\s+/, ""));
      }
    }
    for (const line of hot.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      // A HEADING IS NOT AN ITEM. "## STILL OPEN" carries the marker words in
      // its own title, so the line scan counted the heading itself alongside the
      // bullets beneath it - caught by P4 rather than by reading.
      if (/^#/.test(t)) continue;
      if (/^NEXT\b/i.test(t)) { push(t.replace(/^NEXT[:\s-]*/i, "")); continue; }
      if (OPEN_NEGATED.test(t)) continue;
      if (OPEN_MARKER.test(t)) push(t);
    }
  }
  return out;
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


// RELEVANCE RETRIEVAL - parity with the gateway (2026-09-08). The load returned
// 41 rows out of 707 and called itself loaded, so a session could report
// "memory loaded" four times and still work blind on an older row that answered
// its exact question. bouios_get closes nothing there: you cannot ask for an id
// you have never been shown. Titles-only is KEPT - `memory` above is untouched -
// and this is a second bounded array of at most 8 rows with a 400-character
// excerpt, chosen by relevance to a topic the caller names rather than by age.
// Term filtering is deliberately harsh (nothing under four characters, plus a
// stop list of words that appear in nearly every row) because a matcher that
// matches everything is the over-firing failure this codebase has shipped twice.
const RELEVANCE_STOPWORDS = new Set([
  "this", "that", "with", "from", "have", "what", "when", "were", "will",
  "they", "them", "then", "than", "into", "over", "your", "yours", "about",
  "because", "which", "would", "could", "should", "there", "their", "been",
  "does", "done", "make", "made", "just", "also", "only", "same", "such",
  "every", "still", "must", "need", "needs", "want", "wants", "like",
  "bouios", "memory", "session", "sessions", "claude", "owner", "project",
]);

function relevanceTerms(topic) {
  if (!topic || typeof topic !== "string") return [];
  const seen = new Set();
  const out = [];
  for (const raw of topic.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 4) continue;
    if (RELEVANCE_STOPWORDS.has(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
    if (out.length >= 6) break;
  }
  return out;
}

// Identifiers kept whole (a route, method + route, snake_case name, HTTP status)
// and scored above plain words, matched by instr() - parity with the gateway
// (2026-09-30, see memory-gateway/src/index.js relevanceScore for the measured
// reason). relevanceTerms() and its other callers are unchanged.
function exactTerms(topic) {
  if (!topic || typeof topic !== "string") return [];
  const t = topic.toLowerCase();
  const out = [];
  const add = (x) => { if (x && !out.includes(x) && out.length < 4) out.push(x); };
  for (const m of t.matchAll(/(?:^|[\s(,'"`])(?:(get|post|put|patch|delete|head)\s+)?(\/[a-z0-9_][a-z0-9_\-\/.]*)/g)) {
    const route = m[2].replace(/[.\/]+$/, "");
    if (route.length < 3) continue;
    if (m[1]) add(m[1] + " " + route);
    add(route);
  }
  for (const m of t.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)) add(m[0]);
  for (const m of t.matchAll(/\b[1-5][0-9]{2}\b/g)) add(m[0]);
  return out;
}

function relevanceScore(topic) {
  const terms = relevanceTerms(topic);
  const exact = exactTerms(topic);
  const all = exact.map((t) => [t, 20, 15, true]).concat(terms.map((t) => [t, 3, 1, false]));
  const score = all
    .map(([, tw, bw, ex]) => ex
      ? "(CASE WHEN instr(lower(title), ?) > 0 THEN " + tw + " ELSE 0 END) + (CASE WHEN instr(lower(COALESCE(body,'')), ?) > 0 THEN " + bw + " ELSE 0 END)"
      : "(CASE WHEN lower(title) LIKE ? THEN " + tw + " ELSE 0 END) + (CASE WHEN lower(COALESCE(body,'')) LIKE ? THEN " + bw + " ELSE 0 END)")
    .join(" + ");
  const pat = ([t, , , ex]) => (ex ? t : "%" + t + "%");
  return { all, score, pat };
}

// SUPERSEDED ROWS ARE NEVER SERVED AS CURRENT (2026-10-06, rebuild A7).
// findSupersededIds() below marks a replaced row's title, but nothing ever
// filtered on the mark, so a superseded row kept its place in every load. On
// the live store, asked "how should GET /rules be authenticated?", superseded
// row 658 (which says the opposite) tied with the owner's /rules decision and
// outranked it (memory 3175). This predicate drops a row from memory,
// relevant, lessons, pending and /search.
// bouios_get still returns it by id, so the history stays reachable.
// The shapes are the ones the store actually holds (survey 2026-10-06): the
// title mark, a body opening "SUPERSEDED", "RESOLVED <date>: superseded",
// "COMPLETED (superseded" or "[STALE". Anchored, so a row that merely mentions
// supersession (memory 3175's own title) stays. One shape is NOT whole-row:
// "SUPERSEDED <date> (owner ruling N): ..." is a dated note correcting one
// clause (11 rows, the deploy-by-Actions clause after ruling 2542); the rest
// of those rows is still true, so they stay. Identical in memory-gateway/src/index.js
// (retrieval-authority.test.mjs, worker-gateway-parity.test.mjs).
const NOT_SUPERSEDED =
  "title NOT LIKE '[SUPERSEDED]%' AND COALESCE(body,'') NOT LIKE '[STALE%' " +
  "AND COALESCE(body,'') NOT LIKE 'RESOLVED ____-__-__: superseded%' AND COALESCE(body,'') NOT LIKE 'COMPLETED (superseded%' " +
  "AND (COALESCE(body,'') NOT LIKE 'SUPERSEDED%' OR COALESCE(body,'') LIKE 'SUPERSEDED ____-__-__ (owner ruling%')";

// TIES BREAK BY AUTHORITY BEFORE AGE (2026-10-06, rebuild A7). The scorer
// counts matches only, so equal scores are common, and ties broke by id alone:
// the newest row won and the oldest - often the decision itself - lost. Row
// 138 tied at 31 with seven rows and ranked 9th. Now an owner ruling (title
// OWNER-RULING / OWNER-SAID / STANDING, or a body opening OWNER-SAID or
// PROVENANCE: OWNER-SAID, on a decision or pattern) comes first, then
// decision, pattern, mistake; id breaks what is left. Scores are unchanged
// (no keyword-weight tuning, owner ruling) - this only orders equal scores.
const AUTHORITY =
  "(CASE WHEN type IN ('decision','pattern') AND (title LIKE 'OWNER-RULING%' OR title LIKE 'OWNER-SAID%' OR title LIKE 'STANDING%' " +
  "OR COALESCE(body,'') LIKE 'PROVENANCE: OWNER-SAID%' OR COALESCE(body,'') LIKE 'OWNER-SAID%') THEN 0 " +
  "WHEN type = 'decision' THEN 1 WHEN type = 'pattern' THEN 2 WHEN type = 'mistake' THEN 3 ELSE 4 END)";

// LESSONS BY THE TOPIC, NOT BY AGE (2026-10-06, rebuild A7; plan item 8,
// memory 3177 gap 8). The 12 lessons were the newest 12 whatever the session
// was about, so the lesson that matched the work was usually not among them.
// Now 12 rows, THIS PROJECT AND GLOBAL ONLY (owner ruling 2938, 2026-09-29),
// 700-character clip: rows matching the topic come first (score, then
// authority), the newest fill the rest. With no topic every score is 0 and the
// order is exactly the old one (newest first). The 2026-09-17 split of 8
// in-project + 4 cross-project slots is gone (parity with the gateway): the
// owner ruled that a load must not carry other projects' rows, and a lesson for
// every project is saved as GLOBAL. rank stays in the projection (always 0) so
// the row shape the client reads is unchanged. The owner's latest words reach
// lessons through the per-message lookup (/search scores every row type,
// lessons included) on the gateway. Superseded rows are excluded.
function lessonsQuery(topic) {
  const { all, score, pat } = relevanceScore(topic);
  const rel = all.length ? "(" + score + ")" : "0";
  const sql =
    "SELECT id, type, title, body, rank, lscore FROM (" +
      "SELECT id, type, title, substr(body,1,500) AS body, 0 AS rank, " + rel + " AS lscore, " + AUTHORITY + " AS auth FROM memory " +
        "WHERE (domain = ? OR domain = 'GLOBAL') AND type IN ('mistake','pattern') AND " + NOT_SUPERSEDED + " " +
        "ORDER BY lscore DESC, CASE WHEN lscore > 0 THEN auth ELSE 0 END, id DESC LIMIT 8" +
    ")";
  const termBinds = [];
  for (const a of all) termBinds.push(pat(a), pat(a));
  return { sql, binds: (domain) => [...termBinds, domain] };
}
const lessonRow = ({ id, type, title, body, rank, lscore }) =>
  (lscore > 0 ? { id, type, title, body, rank, matched: true } : { id, type, title, body, rank });

// No function reads another project's rows for a load (owner ruling 2938,
// 2026-09-29, parity with the gateway). relatedElsewhere, ported here
// 2026-09-16 and widened to decision/pattern bodies 2026-09-25, is gone: the
// ruling supersedes both. A load is this project and GLOBAL.

async function relevantMemory(db, domain, topic, excludeIds) {
  const { all, score, pat } = relevanceScore(topic);
  if (!all.length) return [];
  // Row 2206 residue: exclusion used to happen HERE, in JS, after the SQL
  // had already applied LIMIT 24 - see memory-gateway/src/index.js for the
  // full note. Excluding in SQL means LIMIT 24 always yields 24 CANDIDATE
  // rows that are not already visible elsewhere in the load.
  const ids = Array.from(new Set((excludeIds || []).filter((n) => Number.isInteger(n))));
  const excludeClause = ids.length ? " AND id NOT IN (" + ids.map(() => "?").join(",") + ")" : "";
  const sql =
    // SCOPED TO ONE PROJECT, deliberately (2026-09-22). This search was
    // briefly widened to reach mistake/pattern rows in every project and the
    // owner rejected it the same evening: "Chats are not supposed to read each
    // others chats! It creates context issues". Cross-project reach in the
    // load is his call, not a retrieval optimisation to make on inference. He
    // later ruled out every cross-project path in the load (2938, 2026-09-29),
    // so this is not a slot that was left open for another query to fill.
    "SELECT id, domain, type, title, substr(body, 1, 400) AS body, (" + score + ") AS score " +
    "FROM memory WHERE (domain = ? OR domain = 'GLOBAL') AND type != 'pending' AND " + NOT_SUPERSEDED + excludeClause +
    " AND (" + score + ") > 0 " +
    "ORDER BY score DESC, " + AUTHORITY + ", id DESC LIMIT 24";
  const binds = [];
  for (const a of all) binds.push(pat(a), pat(a));
  binds.push(domain);
  for (const id of ids) binds.push(id);
  for (const a of all) binds.push(pat(a), pat(a));
  let rows;
  try {
    rows = await db.prepare(sql).bind(...binds).all();
  } catch (e) {
    // A search that fails must never take the load down with it.
    return [];
  }
  return (rows.results || []).slice(0, 8);
}

// GET /search?domain=<PROJECT>&q=<words> - the record for one message, from THIS customer's own
// database only (BOUIOS decision 173; owner rulings 2969: memory is found at the moment it is needed,
// and 3132: a customer's data never leaves their own account). The shape and ranking are the owner
// gateway's /search exactly: up to 6 memory rows (the best 3 with their body, up to 1500 characters),
// up to 5 log lines scored by the same terms, and the same two keys the hook reads, `transcripts` and
// `elsewhere`. `elsewhere` is always empty (ruling 2938: no other project's rows ride on a lookup).
// `transcripts` comes from the past-chat excerpt index (indexStoredTranscript), within the plan's history
// window. Read-only: it writes nothing, so a lookup can never arm the load guard or add a log row.
async function searchRoute(url, env, request) {
  const domain = normaliseProject(url.searchParams.get("domain"));
  const q = String(url.searchParams.get("q") || "").slice(0, 500);
  if (!domain || !relevanceTerms(q).length) return json({ error: "domain and a query with at least one content word are required" }, 400);
  try {
    await ensureSchema(env.DB);
    const mem = (await relevantMemory(env.DB, domain, q, [])).slice(0, 6)
      .map((r) => ({ id: r.id, type: r.type, title: r.title, excerpt: String(r.excerpt || r.body || "").slice(0, 240) }));
    const top = mem.slice(0, 3).map((r) => r.id);
    if (top.length) {
      const full = await env.DB.prepare("SELECT id, substr(body, 1, 1500) AS body FROM memory WHERE id IN (" + top.map(() => "?").join(",") + ")").bind(...top).all();
      const byId = new Map((full.results || []).map((x) => [x.id, x.body]));
      for (const r of mem) if (byId.has(r.id)) r.body = byId.get(r.id);
    }
    const terms = relevanceTerms(q);
    const score = terms.map(() => "(CASE WHEN lower(summary) LIKE ? THEN 1 ELSE 0 END)").join(" + ");
    const binds = [];
    for (const t of terms) binds.push("%" + t + "%");
    binds.push(domain);
    for (const t of terms) binds.push("%" + t + "%");
    const logRows = await env.DB.prepare(
      "SELECT id, ts, substr(summary, 1, 300) AS summary, (" + score + ") AS score FROM log " +
      "WHERE domain = ? AND summary NOT LIKE 'Session loaded%' AND summary NOT LIKE 'transcript PUT%' " +
      "AND summary NOT LIKE 'AUTO-CHECKPOINT%' AND summary NOT LIKE 'REFUSED %' AND summary NOT GLOB 'FETCH *' AND summary NOT GLOB 'LOOKUP *' AND (" + score + ") > 0 " +
      "ORDER BY score DESC, id DESC LIMIT 5"
    ).bind(...binds).all();
    const log = (logRows.results || []).map((r) => ({ id: r.id, ts: r.ts, summary: r.summary }));
    // Past chats: the log's term scoring against the excerpt index, within the plan's history window (an unknown
    // window is open, the worker's fail-open rule for the customer's own data); this project's chats or untagged.
    const days = await historyWindowDaysCached(request, url, env);
    const since = days === null || days === undefined ? null : new Date(Date.now() - days * 86400000).toISOString();
    const tscore = terms.map(() => "(CASE WHEN lower(excerpt) LIKE ? THEN 1 ELSE 0 END)").join(" + ");
    const tbinds = [];
    for (const t of terms) tbinds.push("%" + t + "%");
    tbinds.push(domain);
    if (since) tbinds.push(since);
    for (const t of terms) tbinds.push("%" + t + "%");
    const tx = await env.DB.prepare(
      "SELECT session_id, turn_index, ts, excerpt, (" + tscore + ") AS score FROM transcript_excerpts " +
      "WHERE (domain = ? OR domain = '')" + (since ? " AND ts >= ?" : "") + " AND (" + tscore + ") > 0 ORDER BY score DESC, id DESC LIMIT 5"
    ).bind(...tbinds).all();
    const transcripts = (tx.results || []).map((r) => ({ session_id: r.session_id, turn: r.turn_index, ts: r.ts, excerpt: r.excerpt }));
    return json({ domain, q, memory: mem, elsewhere: [], log, transcripts });
  } catch (e) {
    return json({ error: "search failed", detail: String(e) }, 500);
  }
}

async function sessionLoad(domain, surface, env, token) {
  const db = env.DB;
  await ensureSchema(db);
  let loadTopic = "";
  {
    const tm = / topic=(\S+)/.exec(String(surface || ""));
    if (tm) { try { loadTopic = decodeURIComponent(tm[1]); } catch (e) { loadTopic = tm[1]; } }
  }
  const lq = lessonsQuery(loadTopic);
  const [rules, hot, context, pending, recent, lessons, memTotal] = await Promise.all([
    fetchRules(env, token),
    db.prepare("SELECT state, updated_at FROM hot WHERE domain = ?").bind(domain).all(),
    db.prepare("SELECT key, content FROM context WHERE domain = ?").bind(domain).all(),
    // Memory rows load as TITLES ONLY (id, type, title - no body) to keep the
    // load small; bouios_get fetches the full body of a specific row on demand.
    // Must match the gateway (memory-gateway/src/index.js) - locked by the
    // gateway<->worker tool-parity test.
    db.prepare("SELECT id, type, title FROM memory WHERE (domain = ? OR domain = 'GLOBAL') AND type = 'pending' AND " + NOT_SUPERSEDED + " ORDER BY id").bind(domain).all(),
    // 15 newest non-pending titles, was 40 (2026-10-20, owner 3498/3512: titles first,
    // expand on demand). Same cut as the gateway; worker-gateway-parity pins both.
    db.prepare("SELECT id, type, title FROM memory WHERE (domain = ? OR domain = 'GLOBAL') AND type != 'pending' AND " + NOT_SUPERSEDED + " ORDER BY id DESC LIMIT 15").bind(domain).all(),
    // LESSONS - parity with the gateway (2026-09-05). 12 mistake and pattern
    // rows (the ones matching the topic first, then the newest) arrive WITH
    // their bodies, because those rows exist for one
    // purpose - to stop the same failure happening again - and a title cannot
    // do that. Everything else stays titles-only: this is a separate bounded
    // field BESIDE the query above, never a widening of it, so the size
    // decision titles-only exists to protect is kept intact on the customer
    // side exactly as it is on the owner's.
    db.prepare(
      // CROSS-PROJECT BY BEHAVIOUR, NOT BY PROJECT (2026-09-17). Measured in the
      // store: 937 mistake/pattern rows exist - AI 326, SARK 226, TRAVEL 176,
      // SYNDAKAT 89, REBUILD 26 - and a session saw at most 12, scoped to its own
      // project plus GLOBAL. So everything learned in another project was
      // structurally unreachable from the session about to repeat it, and it got
      // worse every month as new rows pushed the window past everything older.
      // The owner's complaint - "over and over again in every area we repeat the
      // same errors" - is that shape exactly.
      //
      // THIS PROJECT AND GLOBAL ONLY, TWELVE ROWS (owner ruling 2938,
      // 2026-09-29, parity with the gateway). The 2026-09-17 slots given to other
      // projects' newest mistake/pattern rows are gone; a lesson that applies to
      // every project belongs in GLOBAL, which this still reads.
      // Which 12: lessonsQuery() above - by the topic first, then newest.
      lq.sql
    ).bind(...lq.binds(domain)).all(),
    db.prepare("SELECT COUNT(*) AS n FROM memory WHERE domain = ? OR domain = 'GLOBAL'").bind(domain).first(),
  ]);
  // NO TOPIC GIVEN IS THE COMMON CASE, and an opt-in search that nobody opts
  // into is the same blindness it was built to fix (cb3c070 shipped the search;
  // nothing forces a caller to use it). The gateway already holds the one thing
  // that describes the current work on every surface - the hot state - so when
  // no topic is named, the terms come from that. It reaches Chat and Cowork,
  // where none of the hook-layer gates exist at all. Same term filter and the
  // same 8-row, 400-character cap, so the worst case is unchanged; an empty hot
  // state derives nothing and returns no relevant array rather than matching
  // everything.
  // hot is read BEFORE the search, because the search derives its terms from it
  // when no topic is named. Written the other way round first: node --check
  // passes on that, because using a const before its declaration is a runtime
  // ReferenceError and not a syntax error, so it would have shipped and broken
  // every customer load. Third time this class has bitten this codebase - see
  // the claims declaration dropped from licence issuance, and degraded_ok
  // defined below its own call site.
  const hotRow = (hot.results && hot.results[0]) || null;
  const hotState = hotRow ? hotRow.state : null;
  const hotDate = hotRow ? hotRow.updated_at : "none";
  const relevantRows = await relevantMemory(
    db, domain, loadTopic || String(hotState || "").slice(0, 600),
    [...(recent.results || []).map((r) => r.id), ...(lessons.results || []).map((r) => r.id)]
  );
  const openN = countOpenTasks(hotState);
  const openItemList = openItems(hotState, (pending.results || []));
  await db.prepare("INSERT INTO log (ts, domain, summary) VALUES (datetime('now'), ?, ?)").bind(domain, "Session loaded, surface=" + (surface || "mcp")).run();
  // THE OWNER'S LATEST INSTRUCTION LEADS THE LOAD (2026-10-06, step 3-4 item 2;
  // parity with the gateway). Parsed from the context row current-task
  // ("<ISO ts> | <surface> | <text>"); both fields are omitted when no row
  // exists, and the row is kept out of the context array so it is not sent twice.
  const _ctRow = (context.results || []).find((r) => r && r.key === "current-task" && typeof r.content === "string");
  const _ctParts = _ctRow ? _ctRow.content.split(" | ") : null;
  const currentTask = _ctParts && _ctParts.length >= 3
    ? { text: _ctParts.slice(2).join(" | "), saved_at: _ctParts[0], surface: _ctParts[1] }
    : null;
  const out = {
    // Parity with the gateway: the number in the line a customer reads is the
    // real count of what the record says is unfinished, not a heading match.
    confirmation: confirmationText(domain, rules.length, hotDate, openItemList.length, false),
    // Immediately after confirmation and never clamped (clampMcpLoadSize's
    // protected set): the task in hand is read before anything else.
    ...(currentTask ? {
      current_task: currentTask,
      current_task_note: "The owner's latest instruction, verbatim, saved per message. This is the task in hand: answer every part of it before anything else, and re-read it after any compaction or resume.",
    } : {}),
    domain,
    rules,
    hot: hotState,
    hot_updated: hotDate,
    open_tasks: openN,
    // Parity with the gateway - a customer session is told the same truth about
    // what is outstanding as the owner's is.
    open_items: openItemList,
    open_items_note: "open_items lists what the record itself says is unfinished: real pending rows, bullets under a STILL OPEN heading, a NEXT block, and lines carrying an explicit unfinished marker. It exists because open_tasks counted only one heading format that no working state had used in months, so every load reported 0 while a dozen things were outstanding - and a session told nothing is open leaves things open. Read it before starting new work, and close what you finish.",
    context: contextWindow((context.results || []).filter((r) => !(r && r.key === "current-task")), loadTopic),
    context_note: "context carries the reference material for this project. Rows that bind behaviour (preferences, instructions), rows under 1200 characters, and rows matching the topic you named come back IN FULL. The rest are an excerpt plus their real length, marked excerpt_only - because after the log was capped, context became the largest block in the payload and the size guard's last resort would otherwise have started cutting it. Nothing is hidden: every key is listed with its date, and the full content is one bouios_get({project, keys:[...]}) call away. Fetch the ones your task actually needs, never all of them.",
    memory: [...(pending.results || []), ...(recent.results || [])],
    memory_note: MEMORY_NOTE,
    memory_total: memTotal ? memTotal.n : 0,
    // Say out loud how little of the store this is - parity with the gateway.
    memory_coverage: relevantRows.length
      ? "Returned " + (recent.results || []).length + " newest titles + " + relevantRows.length + " rows matched on your topic, out of " + (memTotal ? memTotal.n : 0) + " total."
      : "Returned the " + (recent.results || []).length + " NEWEST titles out of " + (memTotal ? memTotal.n : 0) + " rows. The rest are not shown and their ids cannot be guessed from this window. If your task is not covered by what you see, call bouios_load again with a topic to search ALL rows by relevance - do not assume the store has nothing on it.",
    // No other project's rows ride along (owner ruling 2938, 2026-09-29, parity
    // with the gateway): the related_elsewhere block is gone. A load is this
    // project and GLOBAL.
    ...(relevantRows.length ? {
      relevant: relevantRows,
    } : {}),
    // The only rows here that arrive WITH a body - parity with the gateway.
    lessons: (lessons.results || []).map(lessonRow),
    lessons_note: "lessons carries 8 mistake and pattern rows WITH their bodies, clipped to 500 characters - the ones matching your topic first (marked matched - read those before anything else; they are the recorded answer to what you named), then the newest; superseded rows are never included - because these are the rows whose purpose is to stop a repeat and a title alone cannot do that. Read them before diagnosing or building - if one describes what you are about to do, you are about to repeat it. Everything in memory above is titles only by design; use bouios_get for any of those bodies.",
  };
  const _lt = await mintLoadToken(env, domain);
  if (_lt) {
    out.load_token = _lt;
    out.load_token_note = "Pass this back as load_token on your next bouios_save or bouios_handoff for this project. It proves THIS load happened even if the connection is re-established underneath you.";
  }
  return out;
}

// Constraint-row write gate - MUST stay in parity with memory-gateway/src/index.js.
// A decision/pattern row that ASSERTS a ban/prohibition needs provenance
// (OWNER-SAID/INFERRED/OBSERVED); an OWNER-SAID ban must quote the owner verbatim
// and must not reach beyond the quote. mistake/pending rows discussing a ban are
// not asserting one and are never gated. See constraint-row-gate.test.mjs.
const CONSTRAINT_RE = /\bban(?:ned|s|ning)?\b|\bnever (?:use|reuse|touch)\b|\bdo not (?:use|reuse|touch|copy|include)\b|\bdon['’]?t (?:use|reuse|touch|copy|include)\b|\bmust not (?:use|reuse|touch|copy|include)\b|\bprohibit(?:ed|ion|s)?\b|\bblacklist(?:ed|ing)?\b|\bforbidden\b/i;
const PROVENANCE_RE = /\b(OWNER-SAID|INFERRED|OBSERVED)\b/;
const VERBATIM_RE = /"[^"]{3,}"|'[^']{3,}'|“[^”]{3,}”|‘[^’]{3,}’/;
const REACH_RE = /everything derived|whole family|and its derivatives|all files (?:from|derived)|entire family|all derivatives|everything (?:from|based on) (?:it|that)/i;
function constraintRowError(m) {
  if (m.type !== "decision" && m.type !== "pattern") return null;
  const text = m.title + "\n" + m.body;
  if (!CONSTRAINT_RE.test(text)) return null;
  const prov = (text.match(PROVENANCE_RE) || [])[1];
  if (!prov) return "constraint refused: a ban/prohibition row must be tagged OWNER-SAID, INFERRED or OBSERVED (provenance)";
  if (prov === "OWNER-SAID" && !VERBATIM_RE.test(m.body)) return "constraint refused: an OWNER-SAID ban must quote the owner's actual words verbatim (in quotes)";
  if (prov === "OWNER-SAID" && REACH_RE.test(text)) return "constraint refused: reach beyond the owner's words ('everything derived from it' etc.) is a separate claim - tag it INFERRED and confirm before acting";
  return null;
}


// SUPERSEDE MARKER - ported from the gateway 2026-09-16, parity gap found by
// reading memory row 1867 rather than by any test. That row's whole subject is
// that a titles-only load can be trusted blind, and its candidate fix (c) was a
// first-class supersede link so a disproved row cannot come back as live
// guidance. The gateway has had it for weeks; the CUSTOMER worker never did, so
// on a customer's own deployment a row that has been refuted still returns with
// a clean title and no signal at all - which is exactly the failure the row
// describes, shipped to the people paying for it.
//
// Identical logic to memory-gateway/src/index.js on purpose: same regex, same
// idempotent UPDATE, same domain scoping. memory-gateway/test/supersede-marker
// .test.mjs asserts both copies.
function findSupersededIds(body) {
  const ids = new Set();
  const re = /supersedes\s+memory\s+(?:rows?\s+)?((?:\d+\s*(?:,|and|&)?\s*)+)/gi;
  let m;
  while ((m = re.exec(body))) {
    const nums = m[1].match(/\d+/g) || [];
    for (const n of nums) ids.add(Number(n));
  }
  return [...ids];
}

async function sessionWrite(domain, body, db, tz) {
  // Every log line a caller writes carries WHERE it was written from (2026-09-22),
  // mirroring the gateway. Loads recorded surface= and writes did not, so which
  // surfaces are actually working could not be read off the log at all. An
  // undeclared caller is tagged "undeclared" rather than left blank: a blank tag
  // is indistinguishable from a pre-2026-09-22 row. Additive - it gates nothing.
  // Local to sessionWrite on purpose: session-write-atomic.test.mjs extracts this
  // function by brace-match and evals it alone, so a module-level helper is not
  // in scope there and the extracted copy throws instead of asserting anything.
  const surfaceTag = (body) => {
    const raw = body && typeof body.surface === "string" ? body.surface.trim() : "";
    const clean = raw.slice(0, 24).replace(/[^A-Za-z0-9_.-]/g, "");
    return " [surface=" + (clean || "undeclared") + "]";
  };
  await ensureSchema(db);
  const batched = [];   // must land together or not at all - see db.batch() below
  // What counts as a stated done-condition. Deliberately loose: any of these
  // phrasings is a real commitment about what finished means, and a matcher
  // that demanded one exact spelling would just teach sessions the password.
  const DONE_RE = /\bdone when\b|\bclosed when\b|\bcomplete when\b|\bresolved when\b|\bsuccess (is|looks like)\b|\bacceptance\b/i;
  // CLAIM_RE feeds TWO paths (mirrors the gateway): the decision refusal AND the
  // log "[unevidenced claim]" tag, so widening it widens both. 2026-10-06 (step
  // 3-4 item 7): "is live" and "does not exist" are claims like "done".
  const CLAIM_RE = /\b(done|fixed|resolved|deployed|shipped|completed?|verified)\b|\b(?:is|are|now|went)\s+live\b|\b(?:does|do)\s*(?:not|n't)\s+exist\b/i;
  // THE LOWERCASE-"pass" HOLE, closed 2026-09-15 (memory row 2026). \bPASS\b
  // sat inside a case-INSENSITIVE regex, so any body containing the ordinary
  // word "pass" - "the second pass never ran" - counted as evidence and walked
  // straight through every gate that shares this escape. Split, not deleted:
  // real test output is upper-case, and the "tests pass/green/passing" arm
  // stays case-insensitive, so honest evidence is untouched and only the bare
  // word loses its free ride. hasEvidence() is the single call site for both
  // halves so they cannot drift apart.
  // A commit sha, not any hex-looking word (2026-10-06, step 3-4 item 7). A run of
  // 7-40 hex characters counts only if it has a digit (rules out "defaced",
  // "deadbeef", "accede") and either a letter a-f or exactly 7 characters (rules
  // out dates like 20261006 and epoch numbers; a real 7-char sha is all digits
  // about 3.7% of the time, so the 7-char all-digit case stays accepted). Shape
  // only: this worker has no repo access and cannot resolve a sha against git;
  // that resolution happens in the Code hook layer (the reasoning gate).
  const SHA_TOKEN_RE = /\b[0-9a-f]{7,40}\b/gi;
  const hasShaToken = (t) => (String(t).match(SHA_TOKEN_RE) || []).some((x) => /\d/.test(x) && (/[a-f]/i.test(x) || x.length === 7));
  const EVIDENCE_RE = /https?:\/\/\S+|\btests?\s+(pass|green|passing)\b|\blive[- ]?(verified|checked|tested|confirmed|reproduced)\b|\b(verified|checked|tested|confirmed|reproduced)[- ]?live\b/i;
  const EVIDENCE_PASS_RE = /\bPASS\b/;   // case-SENSITIVE on purpose
  const hasEvidence = (t) => EVIDENCE_RE.test(t) || EVIDENCE_PASS_RE.test(t) || hasShaToken(t);

  const applied = [];
  // Refusals are told to the caller, as the gateway does (2026-10-06, step 3-4
  // item 7): they used to be a silent `continue`. Reason strings are the
  // gateway's, verbatim, so parity tests can compare them.
  const rejected = [];
  // Rows saved but flagged (chat/cowork claims, step 3-4 item 13).
  const marked = [];
  const wasteMissing = [];
  // The load-before-write gate's ONLY evidence is a log row matching
  // 'Session loaded%' (domainLoadedRecently). Log summaries are caller-supplied,
  // so without this a caller could write its own precondition and arm the gate
  // without ever loading - proven live 2026-07-25: chat write 403, then an
  // ungated no-surface write of "Session loaded, surface=chat" returned 200,
  // then the same chat write returned 200. Reject rather than silently drop:
  // a silent drop would hide the attempt and quietly edit the caller's data.
  // Trimmed match, because a leading space evades a bare prefix check while
  // still landing close enough to the gate's LIKE pattern to matter.
  for (const s of (Array.isArray(body.log) ? body.log : typeof body.log === "string" ? [body.log] : [])) {
    if (typeof s === "string" && /^session loaded/i.test(s.trim())) {
      // ok:false maps to 403 on the REST route and surfaces as text on the tool
      // route. Not a thrown error: that returned 500 "write failed", which reads
      // as a server fault when this is a refused client request.
      return { ok: false, domain, applied: [], error: "refused: a log line may not impersonate the load record that the write gate depends on" };
    }
    // Same for the memory-use measure (logFetch): a caller-written FETCH or
    // LOOKUP row would falsify the count. Case-sensitive, like the counter.
    if (typeof s === "string" && /^(FETCH|LOOKUP) /.test(s.trim())) {
      return { ok: false, domain, applied: [], error: "refused: a log line may not impersonate a FETCH or LOOKUP measurement row that /status counts" };
    }
  }
  if (typeof body.hot === "string" && body.hot.length) {
    await db.prepare("INSERT INTO log (ts, domain, summary) SELECT datetime('now'), ?, 'HOT ARCHIVE: ' || state FROM hot WHERE domain = ?").bind(domain, domain).run();
    // PARITY with memory-gateway/src/index.js (row 1524, 2026-08-19): full
    // timestamp, not date('now'). hot is one row per domain written
    // last-write-wins, and a bare date made two same-day writes
    // indistinguishable, so a silently replaced save was invisible. TEXT column,
    // so a value change and not a schema change. These two statements must stay
    // identical - the gateway comment carries the full reasoning.
    await db.prepare("INSERT OR REPLACE INTO hot (domain, state, updated_at) VALUES (?, ?, datetime('now'))").bind(domain, body.hot).run();
    applied.push("hot");
  }
  if (Array.isArray(body.memory)) {
    // Evidence gate (Hard Rule 8, added 2026-07-15): a type=decision row claiming
    // done/fixed/deployed must carry a commit sha, url, or test-pass token, else
    // it is skipped. Mirrors the same gate in memory-gateway/src/index.js,
    // including the 2026-08-31 widening for live-verification phrasing.
    for (const m of body.memory) {
      if (!m || !MEMORY_TYPES.includes(m.type) || !m.title || !m.body) continue;
      // Constraint-row gate - mirrors memory-gateway/src/index.js (parity).
      const cErr = constraintRowError(m);
      if (cErr) { rejected.push({ title: m.title, reason: cErr }); continue; }
      if (m.type === "decision" && CLAIM_RE.test(m.body) && !hasEvidence(m.body)) {
        rejected.push({ title: m.title, reason: "decision refused (Hard Rule 8): a done/fixed/deployed claim needs a commit sha, url, or test-pass token in the body" });
        continue;
      }
      // ONE-READ ABSENCE WRITTEN INTO THE PERMANENT RECORD (2026-09-13, memory
      // row 2019). A session read a KV key once, saw nothing for the depth it
      // was chasing, and stated "no row at all, not even a start row" as fact -
      // into a commit message and a gate test's comment. A re-read of the same
      // key minutes later returned that row, written 0.3s after the value first
      // read. KV and R2 are eventually consistent: a stale read and an empty one
      // are indistinguishable, so a single read can never evidence absence.
      // SCOPED TO type=decision for the same reason CLAIM_RE is - a mistake or
      // pattern row DESCRIBING this failure (row 2019 itself does) must keep
      // saving. The hook layer catches it in the reply; this catches it on the
      // one path every surface goes through, which is where the damage lasts.
      const STALE_ABSENCE_RE = /(?:\bkv\b|\br2\b|the cache|the store|the bucket)[^.!?]{0,90}?\b(?:no|zero|not a single)\s+(?:rows?|entr(?:y|ies)|records?|values?|keys?)\b|\b(?:no|zero|not a single)\s+(?:rows?|entr(?:y|ies)|records?|values?|keys?)\b[^.!?]{0,90}?(?:\bkv\b|\br2\b|the cache|the store|the bucket)/i;
      if (m.type === "decision" && STALE_ABSENCE_RE.test(m.body) && !hasEvidence(m.body)) {
        rejected.push({ title: m.title, reason: "decision refused: an absence in KV/R2 stated from what reads as a single read. Those stores are eventually consistent - re-read before recording it, and cite both reads, or file it as a pattern/mistake row" });
        continue;
      }
      // AN OPEN ITEM WITH NO STATED DONE-CONDITION IS MARKED (2026-09-23).
      // Measured that day: 105 open items in the store and not one of them says
      // what finished would look like. That is why they sit - the oldest since
      // 2026-06-07 - because no session can close what has no closing condition,
      // and every session that meets one re-derives the question instead.
      //
      // MARKED, NEVER REFUSED, and the reason is not squeamishness: a refused
      // write is the worst failure this system has had (an overnight run lost
      // 2026-07-03, test-save-never-gated.sh exists for it), and refusing here
      // would push a session to file the item as some other type to get past the
      // gate, losing the item altogether - strictly worse than an unstated
      // condition. The mark is visible in the title every future load reads, so
      // the next session can supply the condition instead of guessing it.
      //
      // The counterpart at the other end is the evidence gate above: that one
      // refuses a DECISION claiming done with no proof. Opening without a
      // definition of done and closing without evidence are the same gap.
      // `m` is the loop's const, so the mark goes on a local rather than
      // reassigning it - the first cut assigned to m and threw
      // "Assignment to constant variable", turning every memory write into a
      // 500. The negative-space case caught it before it left this machine.
      let openTitle = m.type === "pending" && !DONE_RE.test(m.body)
        ? m.title + " [no done-condition]"
        : m.title;
      // CHAT/COWORK CLAIMS ARE MARKED, NEVER REFUSED (2026-10-06, step 3-4 item
      // 13; mirrors the gateway, whose comment carries the measurements). A
      // refused save is the worst failure on record, so the title carries the
      // mark and the caller is told in `marked`. An owner quote is the proof of
      // a decision. The done/fixed decision REFUSAL above is unchanged; pending
      // and pattern rows and the code surface are untouched.
      const surf = typeof body.surface === "string" ? body.surface.trim().toLowerCase() : "";
      if (surf === "chat" || surf === "cowork") {
        let why = "";
        if (m.type === "mistake" && CLAIM_RE.test(m.body) && !hasEvidence(m.body)) why = "a mistake row uses a done/fixed/live claim word with no commit sha, url or test-pass token in the body";
        else if (m.type === "decision" && /\b(decided|agreed|approved)\b/i.test(m.body) && !hasEvidence(m.body) && !/\bOWNER[- ](SAID|RULING|APPROVED|AGREED)\b|\bverbatim\b/i.test(m.body)) why = "a decision row says decided/agreed/approved with no proof and no owner quote in the body";
        if (why) { openTitle += " [unevidenced claim]"; marked.push({ title: m.title, reason: why }); }
      }
      // EVERY MISTAKE RECORDS ITS WASTE (owner ruling 2026-10-07: "log the error
      // and from now on log the waste as well"). A mistake row with no WASTE
      // line is saved unchanged and the answer names it in waste_missing, on
      // every surface - a note, never a refusal (gate freeze 2571; a refused
      // save is the worst failure on record). step34-claims.test.mjs S9.
      if (m.type === "mistake" && !/\bWASTE\b/.test(m.body)) wasteMissing.push(m.title);
      batched.push(db.prepare("INSERT INTO memory (domain, type, title, body, created_at) VALUES (?, ?, ?, ?, date('now'))").bind(domain, m.type, openTitle, m.body));
      applied.push("memory:" + m.title);
      for (const supId of findSupersededIds(m.body)) {
        batched.push(db.prepare(
          "UPDATE memory SET title = '[SUPERSEDED] ' || title WHERE id = ? AND domain = ? AND title NOT LIKE '[SUPERSEDED]%'"
        ).bind(supId, domain));
      }
    }
  }
  if (Array.isArray(body.context)) {
    for (const c of body.context) {
      if (!c || !c.key || typeof c.content !== "string") continue;
      batched.push(db.prepare("INSERT OR REPLACE INTO context (domain, key, content, updated_at) VALUES (?, ?, ?, date('now'))").bind(domain, c.key, c.content));
      applied.push("context:" + c.key);
    }
  }
  // The owner's latest instruction is the current task (2026-10-06, step 3-4
  // item 2; mirrors the gateway): a context row, key current-task, content
  // "<ISO ts> | <surface> | <text>", text verbatim capped at 4000. NOT hot, and
  // no log line. The load serves it first and keeps it out of the context array.
  if (typeof body.current_task === "string" && body.current_task.trim()) {
    const ctSurface = (typeof body.surface === "string" ? body.surface.trim().slice(0, 24).replace(/[^A-Za-z0-9_.-]/g, "") : "") || "undeclared";
    const ctContent = new Date().toISOString() + " | " + ctSurface + " | " + body.current_task.trim().slice(0, 4000);
    batched.push(db.prepare("INSERT OR REPLACE INTO context (domain, key, content, updated_at) VALUES (?, ?, ?, date('now'))").bind(domain, "current-task", ctContent));
    applied.push("current_task");
  }
  const logs = Array.isArray(body.log) ? body.log : typeof body.log === "string" ? [body.log] : [];
  for (const s of logs) {
    if (typeof s !== "string" || !s) continue;
    const line = clipLogLine(s);
    // A log line claiming done/fixed/deployed with no evidence is MARKED, not
    // refused (2026-09-22, mirroring the gateway). The evidence gate covered
    // type=decision memory rows only; the log is what the next session actually
    // reads, and an unbacked claim there was indistinguishable from a backed
    // one. Never refuses: a blocked save is the worst failure this system has.
    const claimTag = CLAIM_RE.test(line.text) && !hasEvidence(line.text) ? " [unevidenced claim]" : "";
    batched.push(db.prepare("INSERT INTO log (ts, domain, summary) VALUES (datetime('now'), ?, ?)").bind(domain, line.text + claimTag + surfaceTag(body)));
    applied.push("log");
  }
  // ONE TRANSACTION for the row writes, mirroring the gateway (parity). They were
  // separate awaited statements, so a failure part-way through left some rows
  // written and the rest not, with the caller told only that the write failed.
  // The hot write deliberately stays outside: it is one statement either way and
  // the gateway's compare-and-swap needs its own result.
  if (batched.length) await db.batch(batched);
  const savedAt = new Date();
  return { ok: true, domain, applied, ...(rejected.length ? { rejected } : {}), ...(marked.length ? { marked } : {}), ...(wasteMissing.length ? { waste_missing: wasteMissing, waste_note: "Each mistake row needs a WASTE line: time, tokens or cost, cycles repeated and owner turns lost, each with its source (owner ruling 2026-10-07). Add it with bouios_edit." } : {}), saved_at: savedAt.toISOString(), confirmation: saveConfirmation(applied, savedAt, tz, rejected.length) };
}

// SAVE TIME (2026-09-24). A save hands back the moment it was written and a
// ready confirmation line carrying it. Every "saved at HH:MM" line one evening
// was an estimate - 19:40 for a write logged at 19:52 UTC - because nothing
// gave the session a clock. The zone is DISPLAY_TZ (an IANA name); unset or
// unknown, the line says UTC, never an unlabelled time. Counts only what was
// applied. Kept identical in memory-gateway/src/index.js and
// worker/src/index.js; memory-gateway/test/save-time.test.mjs.
function saveConfirmation(applied, now, tz, refused) {
  const n = (p) => applied.filter((a) => a === p || a.startsWith(p + ":") || a.startsWith(p + " ")).length;
  const parts = [];
  if (n("hot")) parts.push("hot");
  if (n("log")) parts.push("log");
  let s = parts.join(" + ") || "nothing new";
  const plural = (k, one) => k + " " + one + (k === 1 ? "" : "s");
  if (n("memory")) s += ", " + plural(n("memory"), "new memory row");
  if (n("context")) s += ", " + plural(n("context"), "context row");
  if (n("resolved")) s += ", " + plural(n("resolved"), "resolved row");
  // A REFUSED ROW IS NAMED ON THE LINE THE OWNER SEES (AI 3939 part 1753): "saved: nothing new" hid a
  // decision row refused for missing evidence. The response also lists each one under rejected.
  if (refused > 0) s += ", " + plural(refused, "row") + " REFUSED (named under rejected, not stored)";
  const fmt = (zone) => new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" }).format(now);
  let t;
  try { t = fmt(tz || "UTC"); } catch (_) { t = fmt("UTC"); }
  return "Bouios memory saved: " + s + " at " + t + ".";
}

// Load-before-write gate, keyed to the PROJECT, not the MCP session id.
// PRIOR STATE (2026-07-19): this function existed but was never called -
// bouios_save and bouios_handoff below authenticated the caller via the
// /mcp/{token} bearer gate and treated that as sufficient, skipping any
// check that memory had actually been loaded first (comment: "the caller
// reached here only by passing the bearer gate, so it is already
// authenticated"). Bearer auth proves identity, not that a load happened -
// every deployment owner was fully exempt from the load-before-write gate.
// Fixed: check whether THIS PROJECT was loaded recently (mirrors
// memory-gateway/src/index.js domainLoadedRecently). Keying on the project
// instead of the session id also means it survives a reconnect/flap, so no
// bypass is needed to avoid false negatives.
// LOAD TOKEN - MUST stay in parity with memory-gateway/src/index.js.
//
// The gateway needs this because it keys the load record on the transport
// session id and any reconnect rotates it, so a save could be refused minutes
// after a real load. This deployment keys on the project instead and does not
// have that failure - the token is carried here so the two payloads and the two
// tool schemas stay identical, and so a session that passes the token is never
// refused for offering it. Same secret shape, same 24-hour bound, same
// additive-only placement after the existing check.
const LOAD_TOKEN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function loadTokenSecret(env) {
  return (env && (env.LOAD_TOKEN_SECRET || env.BEARER_TOKEN)) || "";
}

async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function mintLoadToken(env, domain) {
  const secret = loadTokenSecret(env);
  if (!secret || !domain) return null;
  const issued = Date.now();
  const body = domain + "." + issued;
  return body + "." + (await hmacHex(secret, body)).slice(0, 32);
}

async function verifyLoadToken(env, domain, token) {
  if (!domain || typeof token !== "string" || token.length > 400) return false;
  const secret = loadTokenSecret(env);
  if (!secret) return false;
  // Split from the RIGHT - a project name may contain a dot.
  const lastDot = token.lastIndexOf(".");
  if (lastDot < 0) return false;
  const body = token.slice(0, lastDot);
  const mac = token.slice(lastDot + 1);
  const sep = body.lastIndexOf(".");
  if (sep < 0) return false;
  if (body.slice(0, sep) !== domain) return false;
  const issued = Number(body.slice(sep + 1));
  if (!Number.isFinite(issued)) return false;
  const age = Date.now() - issued;
  if (!(age >= 0 && age < LOAD_TOKEN_MAX_AGE_MS)) return false;
  const expected = (await hmacHex(secret, body)).slice(0, 32);
  if (expected.length !== mac.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ mac.charCodeAt(i);
  return diff === 0;
}

async function domainLoadedRecently(db, domain) {
  if (!domain) return false;
  const row = await db.prepare("SELECT 1 AS ok FROM log WHERE domain = ? AND summary LIKE 'Session loaded%' AND ts > datetime('now', '-1 day') LIMIT 1").bind(domain).first();
  return !!row;
}

// AUTO-LOAD (A2, 2026-10-06). Decides only whether to load before another
// tool runs; the write refusals below still use domainLoadedRecently, so no
// refusal changes. It mirrors the gateway's loadedBeforeWrite: with a real
// session id only THIS session's load counts (domainLoadedRecently would let
// any other chat's load stand in, which is exactly the iOS chat that never
// loaded). The id must match SESSION_ID_RE, so the "session=none" a sessionless
// load writes can never be matched; with no id, a recent load of the project
// stands in, as on the gateway.
const SESSION_ID_RE = /^[A-Za-z0-9.:-]{8,128}$/;
async function loadedThisSession(db, domain, sessionId) {
  if (!domain) return false;
  if (typeof sessionId === "string" && SESSION_ID_RE.test(sessionId)) {
    const row = await db.prepare("SELECT 1 AS ok FROM log WHERE domain = ? AND summary LIKE 'Session loaded%' AND summary LIKE ? AND ts > datetime('now', '-1 day') LIMIT 1").bind(domain, "%session=" + sessionId + "%").first();
    return !!row;
  }
  return domainLoadedRecently(db, domain);
}

const AUTO_LOAD_TOOLS = new Set(["bouios_save", "bouios_handoff", "bouios_get", "bouios_edit", "bouios_delete", "bouios_no_marks", "bouios_transcripts"]);
const AUTO_LOAD_PREFACE = "Memory was not loaded in this chat; loaded it now.";

// The one MCP load path: bouios_load and the auto-load both come through here.
async function mcpLoad(domain, args, sessionId, env, request, url) {
  // The topic rides on `surface` URI-encoded, as on the gateway. Until
  // 2026-10-06 the worker never read args.topic and its schema had no
  // topic, so a customer load could not search by one at all.
  const surface = (args.surface || "mcp") + " session=" + (sessionId || "none") + (typeof args.topic === "string" && args.topic.trim() ? " topic=" + encodeURIComponent(args.topic.trim().slice(0, 160)) : "");
  const loaded = await sessionLoad(domain, surface, env, accessTokenFromRequest(request, url, env));
  // A skill that cannot be read never takes the load down with it.
  try {
    const cap = await skillsCapFor(request, url, env);
    if (cap !== null) loaded.skills = await ownSkills(env.DB, domain, cap, await defaultSkills(request, url, env));
  } catch (_) { /* no skills field, load unchanged */ }
  return loaded;
}

// Puts the preface, the load's confirmation line and its payload ahead of the
// tool's own result, in the same text block the model reads.
//
// SMALL BY DESIGN (2026-10-08, defect 3504): the load still runs here, because
// it writes the record the write gate reads, but only the arming fields ride
// back, about 1K. The model calls bouios_load with a topic for the full set.
function slimAutoLoad(loaded) {
  const slim = { confirmation: loaded.confirmation, load_token: loaded.load_token };
  if (loaded.current_task) slim.current_task = loaded.current_task;
  slim.pending_count = Array.isArray(loaded.pending) ? loaded.pending.length : 0;
  slim.note = "Session armed only. Call bouios_load with a topic for rules, pending, log and context.";
  return slim;
}

function prefaceAutoLoad(res, loaded) {
  const block = res && res.result && Array.isArray(res.result.content) ? res.result.content[0] : null;
  if (!block || typeof block.text !== "string") return res;
  block.text = AUTO_LOAD_PREFACE + "\n" + (loaded.confirmation || "") + "\n" + JSON.stringify(slimAutoLoad(loaded)) + "\n\n" + block.text;
  return res;
}

// ---- MCP (JSON-RPC 2.0, Streamable HTTP) ----

const MCP_PROTOCOL = "2025-03-26";
// Instruction text lives on our service behind the licence (decisions 173/863):
// this file keeps only a short neutral fallback, byte-identical to
// text-generator.js FREE_INSTRUCTIONS (rules-lock.test.mjs checks it).
const FALLBACK_INSTRUCTIONS = "This connector is Bouios, the user's own memory system. Bouios is loaded at the start of every conversation: before replying, call bouios_load with the one project the topic implies, and show the user only the confirmation line it returns. 'load memory', 'load rules' and 'load Bouios' each mean load now. Memory loads return titles only; call bouios_get for the full body of a row you need. Save with bouios_save, passing the load_token from the load, every few steps and before any long step. Near the end of the conversation call bouios_handoff and show its block to paste into a new chat. Never ask the user for a token, key or credential. If memory cannot be reached, say so once and carry on without it - do not stall; it reconnects.";

// Served from the gateway per licence and kept for ten minutes per token, so a
// reconnect loop costs one fetch. A failed fetch is never cached for the full
// ten minutes: it serves the last text this licensed install was sent (see
// LAST_GOOD_MAX_AGE_MS), held for 60 seconds so recovery is quick, or else the
// fallback, which is not cached, so the next initialize tries again.
const INSTRUCTIONS_TTL_MS = 10 * 60 * 1000;
const INSTRUCTIONS_STALE_TTL_MS = 60 * 1000;
const instructionsCache = new Map();
async function instructionsFor(env, token) {
  if (!env.GATEWAY_URL) return FALLBACK_INSTRUCTIONS;
  const key = token || "";
  const hit = instructionsCache.get(key);
  if (hit && Date.now() - hit.at < (hit.ttl || INSTRUCTIONS_TTL_MS)) return hit.text;
  try {
    const r = await fetch(env.GATEWAY_URL + "/instructions", {
      headers: token ? { "x-licence": token } : {},
      signal: AbortSignal.timeout(3000),
    });
    if (r.ok) {
      const data = await r.json();
      if (data && typeof data.instructions === "string" && data.instructions.length > 0) {
        if (data.licensed === true) await rememberLicensed(env, "instructions", data.instructions);
        instructionsCache.set(key, { text: data.instructions, at: Date.now() });
        return data.instructions;
      }
    }
  } catch {
    // fall through to the last known good
  }
  if (token) {
    const stored = await lastLicensed(env, "instructions");
    if (stored) {
      instructionsCache.set(key, { text: stored, at: Date.now(), ttl: INSTRUCTIONS_STALE_TTL_MS });
      return stored;
    }
  }
  return FALLBACK_INSTRUCTIONS;
}

// Tool identifiers are Bouios-branded (2026-07-02): the platform's own
// permission dialogs render the raw technical tool name with zero branding -
// confirmed by owner screenshot on the owner's own connector, applies
// identically to every customer's connector. Mirrors memory-gateway/src.
const MCP_TOOLS = [
  {
    name: "bouios_load",
    // A load can pass Claude Code's 50,000-character MCP result cap; declaring
    // a limit (max 500,000) stops the client reporting it as an error.
    // Mirrors memory-gateway/src. 2026-10-07; mcp-result-limit.test.mjs.
    _meta: { "anthropic/maxResultSizeChars": 200000 },
    description:
      "CALL THIS FIRST, before your first reply in every chat - even a greeting or a one-line question. " +
      "Load memory for a project (rules, working state, context, patterns). " +
      "Must be called first in every conversation before any other work. " +
      "Triggers on user messages: 'load memory', 'load rules', 'load Bouios'.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name (uppercase, 2-20 chars)." },
        surface: { type: "string", description: "Where this session runs: chat, cowork, code, dispatch, chatgpt (ChatGPT, any surface), codex (OpenAI Codex)." },
        topic: { type: "string", description: "Optional but strongly recommended: what this conversation is about, in a few words. With it, ALL rows are searched by relevance and the matches come back with a body excerpt in `relevant`, and lessons are chosen by it." },
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
        surface: { type: "string", description: "Where this session runs: chat, cowork, code, dispatch, chatgpt (ChatGPT, any surface), codex (OpenAI Codex). Pass it on every save - it is what makes the log show which surfaces are actually working." },
        load_token: { type: "string", description: "Optional but always pass it: the load_token returned by the bouios_load you are building on, so the save is not refused because the connection was re-established since the load." },
        hot: { type: "string", description: "Full current working state." },
        current_task: { type: "string", description: "The owner's latest message, verbatim, saved as the current task. Pass it on every save from chat or cowork (Code saves it by hook). It is shown first on every load and after every compaction or resume." },
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
  {
    name: "bouios_get",
    // Read-only (only SELECTs). ChatGPT treats a tool without this hint as a
    // write and asks the user to confirm every call. The other tools write
    // (a load logs itself), so they stay unmarked. chatgpt-ready.test.mjs.
    // The FETCH log row it writes (logFetch) is an audit record, not a write of
    // the user's data, so the hint stays: without it ChatGPT asks before every
    // fetch, and fetching is the thing that already happens too rarely.
    annotations: { readOnlyHint: true },
    _meta: { "anthropic/maxResultSizeChars": 200000 },
    description:
      "Fetch the FULL body of one or more specific memory rows by id. bouios_load returns titles only " +
      "(id, type, title - no body) to keep the load small; call this to read a specific row's full content " +
      "once you know from its title that you need it. Never call this for every row returned by bouios_load - " +
      "only for the ones actually relevant to the current task.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name, uppercase. Must match the row's domain or GLOBAL." },
        ids: { type: "array", items: { type: "integer" }, description: "One or more memory row ids to fetch in full." },
        surface: { type: "string", description: "Where this session runs: chat, cowork, code, dispatch, chatgpt (ChatGPT, any surface), codex (OpenAI Codex). Recorded with the fetch so memory use can be measured per surface." },
      },
      required: ["project", "ids"],
    },
  },
  // EDIT AND DELETE, ONLY WITH THE OWNER'S EXPLICIT YES (owner, 2026-09-30:
  // "Bouios needs to be able to delete edit d1/r2 but only with explicit
  // approval"). Until now a session that had to correct a stale row used the
  // raw store tool, which writes with no approval at all. These two tools are
  // the approved way: marked destructive so Chat/Cowork clients ask, and listed
  // in permissions.ask in the owner's settings so Code asks on every call. The gateway cannot see the approval itself, so it keeps
  // what it can: every change needs a stated reason, and the old value is
  // written to the log first, so an edit or a row delete can be undone.
  // Parity with the gateway (2026-09-30); transcripts and bundles live in this
  // install's own bucket (binding TRANSCRIPTS); without that binding a
  // transcript or bundle delete answers that storage is not configured.
  // edit-delete.test.mjs and worker/test/edit-delete.test.mjs.
  {
    name: "bouios_edit",
    annotations: { destructiveHint: true },
    description:
      "Change an existing memory row (title, body or type) or context row (content) in this project. " +
      "Before calling, ask the user in plain words for this exact change and wait for their explicit yes; the client also asks them. " +
      "Never call it to tidy up on your own initiative. The old value is archived to the log first (undoable). " +
      "reason is required and must say the user approved.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name, uppercase. The row must belong to it (or be GLOBAL, for a memory row)." },
        memory_id: { type: "integer", description: "Memory row to change." },
        title: { type: "string" },
        body: { type: "string" },
        type: { type: "string", enum: ["pattern", "mistake", "decision", "pending"] },
        context_key: { type: "string", description: "Context row to change (instead of memory_id)." },
        content: { type: "string", description: "New content for the context row." },
        reason: { type: "string", description: "Why, in a sentence, including the user's approval." },
        load_token: { type: "string" },
      },
      required: ["project", "reason"],
    },
  },
  {
    name: "bouios_delete",
    annotations: { destructiveHint: true },
    description:
      "Delete memory rows, context rows, or a stored transcript/bundle object in this project. " +
      "Before calling, ask the user in plain words for this exact deletion and wait for their explicit yes; the client also asks them. " +
      "Memory and context rows are archived to the log first (undoable); a transcript or bundle object cannot be restored. " +
      "reason is required and must say the user approved.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name, uppercase." },
        memory_ids: { type: "array", items: { type: "integer" } },
        context_keys: { type: "array", items: { type: "string" } },
        transcript: { type: "string", description: "Transcript object name: UUID.jsonl or UUID.jsonl.gz." },
        bundle: { type: "string", description: "Bundle object: <session-uuid>/<repo>." },
        reason: { type: "string", description: "Why, in a sentence, including the user's approval." },
        load_token: { type: "string" },
      },
      required: ["project", "reason"],
    },
  },
  {
    // Your own past chats, from YOUR bucket and YOUR database (2026-10-27, BOUIOS 4053): the owner's
    // bouios_transcripts, the same three actions, reading only this account's storage, within the plan's
    // history window. Nothing is sent anywhere.
    name: "bouios_transcripts",
    description:
      "Search and read your stored chat transcripts, to recover work or a decision from a past chat. " +
      "Actions: search (q, a few words: finds what you typed in past chats for the project), " +
      "list (recent transcripts for the project, newest first), " +
      "read (session_id + q: the lines of one stored transcript that contain the words, clipped, with their line numbers). " +
      "A transcript can hold anything that was in the chat, so quote only what the task needs.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project, uppercase. Only transcripts tagged with it, or never tagged, are returned." },
        action: { type: "string", enum: ["search", "list", "read"] },
        q: { type: "string", description: "Words to look for (search, read)." },
        session_id: { type: "string", description: "read: the transcript's session id (with or without .jsonl)." },
        limit: { type: "number", description: "search and list: how many rows, default 5, at most 20." },
        max_chars: { type: "number", description: "read: at most this many characters of matching lines, default 6000, at most 20000." },
      },
      required: ["project", "action"],
    },
  },
  {
    // No-marks, a Max Herder feature. Your settings stay in YOUR database; each
    // call sends the text or file, with your settings and licence, to the Bouios
    // service, which returns the report or the cleaned result and keeps nothing.
    name: "bouios_no_marks",
    description:
      "Check text or a file for marks you did not mean to publish, or clean them: hidden characters, tool attribution lines, " +
      "long dashes and curly quotes, look-alike letters, AI tool leftovers, generator tags, provenance links, private details " +
      "(reported, never edited), and file metadata such as GPS, credit, software and document properties. " +
      "Actions: scan_text, clean_text (text), scan_file, clean_file (file_base64 + name), get_settings, set_settings. " +
      "Editing: edit_brief (text) returns a line editor's brief and a measured style profile of the text - revise following it, then " +
      "edit_check (text + revised) verifies the revision: locked names and figures dropped, figures added, marks, stock phrases, and the style profile before and after. " +
      "Settings are saved per project and say, for each kind of mark, fix/report/off (text) or remove/keep/off (files), plus add.credit. " +
      "Scanning is included on every plan; cleaning, fixing and editing with Max Herder and the free trial.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project the settings belong to, uppercase." },
        action: { type: "string", enum: ["scan_text", "clean_text", "scan_file", "clean_file", "edit_brief", "edit_check", "get_settings", "set_settings"] },
        revised: { type: "string", description: "edit_check: your revision of text, checked against the original." },
        text: { type: "string", description: "The text to scan or clean (scan_text, clean_text)." },
        file_base64: { type: "string", description: "The file, base64 encoded (scan_file, clean_file)." },
        name: { type: "string", description: "The file name, used to report where a finding is." },
        return_file: { type: "boolean", description: "clean_file only: return the cleaned bytes as file_base64 when they are small enough." },
        settings: { type: "object", description: "set_settings: the settings to save (merged over the current ones). Other actions: settings for this call only." },
      },
      required: ["project", "action"],
    },
  },
];

// Layer settings: b over a, one level deep for text/file/add (same rule as the service).
// >>> NO-MARKS-LOCAL BEGIN: generated from memory-gateway/src/no-marks-core.js by memory-gateway/generate-worker-nomarks.mjs - do not edit by hand <<<
const NM = (() => {
// no-marks.js - the no-marks scanner and cleaner (pending 3043, owner checklist v4).
//
// WHY. Owner ruling 3037 (30 Sep): no labels, watermarks or text marks in code
// or text. That covers tool attribution lines in commits, invisible characters,
// look-alike letters, trailing-whitespace encodings, generator tags, provenance
// references, and internal identifiers leaking into anything published. This
// module is the ONE scanner the gateway, the hooks and the repo check share, so
// every layer judges text by the same rules (v4 decision (1): one JS module).
//
// CONSTRAINTS. Pure ESM with no node: imports, so the Worker bundle and plain
// `node` both import it. scanText and scanFile REPORT; cleanText returns fixed text
// and never edits homoglyphs or leaks (those stay for review / block). Every finding
// carries the rule id, 1-based line and column (in code points) and the code
// point where one applies, so a caller can show exactly where the mark sits.
//
// NEGATIVE SPACE. The same code points have ordinary uses: ZWJ inside emoji,
// VS16 after emoji, tag characters inside subdivision flags, ZWNJ in Persian
// and Indic text, a BOM at the start of a file, a single ideographic variation
// selector after a Han character, whole Greek or Cyrillic words, markdown's
// two-space line break. Each is allowed in context and locked by
// memory-gateway/test/no-marks-scanner.test.mjs. A scanner that flags ordinary
// writing gets switched off and then protects nothing.
//
// Visible marks count too (owner, 30 Sep): dashes, curly quotes, ellipses,
// box-drawing rules, and leftovers from AI tools. Images are not read here.
//
// CEILING, stated plainly: this reads characters and patterns. A statistical
// watermark carried by word choice is invisible to it and is out of scope.

// Who the feature is for (owner, 30 Sep: "only include in owner and highest
// tier"). The owner's own licence object in the gateway is tier "free" with
// sub "owner" (memory-gateway/src/index.js, ownerLicence), so a bare tier test
// would lock the owner out; customer licences with sub "owner" are refused at
// issue and verify, so sub cannot be forged into this. Trial licences are tier
// "max" and so are included - an open owner question, see the pending row.
function isEntitled(l) {
  if (!l || typeof l !== "object") return false;
  if (l.sub === "owner") return true;
  return l.valid === true && l.tier === "max";
}

// What the feature does, in the words a user sees. Plain ASCII, no internal
// names (CLAUDE.md Public/Private boundary), and no promise it cannot keep: it
// finds characters and patterns, it does not touch statistical watermarks.
const VALUE =
  "Clean publishing. Before anything you write with an AI assistant goes out - " +
  "a commit, a web page, a document - Bouios checks it for what you did not mean " +
  "to publish: tool attribution lines, invisible characters that can hide or " +
  "reorder text, look-alike letters, typographic marks such as long dashes and " +
  "curly quotes, leftovers from AI tools such as tracking links and citation " +
  "tokens, provenance links, and private details such " +
  "as keys, internal addresses and file paths. Each one is reported by line and " +
  "column, so what you publish says only what you wrote. Included with Max Herder.";

// One entry per rule. Ids are what findings carry and what tests assert on.
const RULES = [
  { id: "attribution-line", what: "a tool attribution line (co-author trailer, session trailer, generated-with footer)" },
  { id: "tool-author", what: "a commit author or email that names an AI tool" },
  { id: "hidden-char", what: "an invisible or format character outside its legitimate context" },
  { id: "c2pa-text", what: "a C2PA text manifest carried in variation selectors" },
  { id: "homoglyph", what: "a Latin word containing a look-alike Cyrillic or Greek letter" },
  { id: "trailing-whitespace", what: "trailing whitespace that can encode data (tabs, or more than two spaces)" },
  { id: "generator-tag", what: "an HTML generator tag naming an AI tool" },
  { id: "provenance-ref", what: "a provenance reference (c2pa-manifest link, .c2pa file, dcterms:provenance)" },
  { id: "leak", what: "a secret, internal host, internal path or denylisted identifier" },
  { id: "unusual-space", what: "a non-breaking, thin, wide or ideographic space, or a Unicode line/paragraph separator (checklist B: converted)" },
  { id: "typography", what: "a visible typographic mark: em or en dash, curly quote, ellipsis, box-drawing rule (off with typography:false)" },
  { id: "ai-artefact", what: "a leftover from an AI tool: tracking parameter, citation token, assistant phrase, markdown bold inside HTML" },
  { id: "jsonld-tool", what: "an AI tool named as author, creator, publisher or similar in JSON-LD structured data" },
  { id: "style-word", what: "a word typical of machine-written prose (opt-in with styleWords:true, never on by default)" },
];

// ---------------------------------------------------------------- helpers
// A tool's own name as the WHOLE name (optionally with a model or product word
// and a version), so a human called Claude Monet or Devin Smith is not a tool.
const TOOL_NAME = /^\s*(?:claude|anthropic|codex|openai|chatgpt|gpt-?[\d.o]+|github copilot|copilot|cursor|gemini|devin|aider|windsurf|grok|llama|opus|sonnet|haiku|fable)(?:\s+(?:opus|sonnet|haiku|fable|code|agent|assistant|pro|max|mini|turbo|[\d][\w.-]*))*\s*$/i;
// A tool's name standing alone at the end of a "generated with" phrase or in a
// generator tag: followed by end, a bracket, a paren or punctuation - so
// "generated with cursor position tracking" and "Gemini CMS" are ordinary.
const TOOL_TAIL = /^\s*\[?\s*(?:claude(?: code)?|chatgpt|codex|github copilot|copilot|cursor|gemini|grok|v0(?:\.dev)?|openai|anthropic)\s*[\d.]*\s*(?:\]|\(|[.!,;:]|$)/i;
const TOOL_EMAIL = /@(?:anthropic\.com|openai\.com|cursor\.com|cursor\.sh)\s*>?\s*$|copilot@users\.noreply\.github\.com/i;
const TOOL_AUTHOR_NAME = /^(?:claude|codex|copilot|cursor(?:\s?agent)?|chatgpt|devin|gemini|aider)\b|copilot[\w-]*\[bot\]/i;

const isEmojiBase = (ch) => /\p{Emoji}/u.test(ch) && !/[0-9#*]/.test(ch) || /\p{Extended_Pictographic}/u.test(ch);
const isKeycapBase = (ch) => /^[0-9#*]$/.test(ch);
const isPictographic = (ch) => /\p{Extended_Pictographic}/u.test(ch);
const isSkinTone = (cp) => cp >= 0x1F3FB && cp <= 0x1F3FF;
const isVS = (cp) => (cp >= 0xFE00 && cp <= 0xFE0F) || (cp >= 0xE0100 && cp <= 0xE01EF);
const isTag = (cp) => cp >= 0xE0020 && cp <= 0xE007F;
// Letters of scripts that use ZWJ/ZWNJ as part of ordinary spelling (Arabic,
// Persian, Indic, Sinhala ...): any letter or mark that is not Latin, Greek or
// Cyrillic, which do not.
const isJoiningScriptChar = (ch) => ch !== undefined && /[\p{L}\p{M}]/u.test(ch) && !/[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(ch);
// After a virama or other combining mark in a joining script, ZWJ/ZWNJ may end
// the word (Devanagari half forms, Malayalam chillu): no letter need follow.
const isJoiningMark = (ch) => ch !== undefined && /\p{M}/u.test(ch) && isJoiningScriptChar(ch);
const RTL = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}]/u;
// Controls other than tab, LF, CR; C1 controls; private use; unassigned tag block.
const isControlOrPrivate = (cp) => (cp < 0x20 && cp !== 9 && cp !== 10 && cp !== 13) || (cp >= 0x7F && cp <= 0x9F) || (cp >= 0xE000 && cp <= 0xF8FF) || (cp >= 0xF0000 && cp <= 0x10FFFF) || (cp >= 0xE0000 && cp <= 0xE001F) || (cp >= 0xE0080 && cp <= 0xE00FF) || (cp >= 0xE01F0 && cp <= 0xE0FFF);
// The only subdivision flags in the emoji standard: England, Scotland, Wales.
const RGI_FLAG_TAGS = new Set(["gbeng", "gbsct", "gbwls"]);
const isHan = (ch) => ch !== undefined && /\p{Script=Han}/u.test(ch);

// Always-invisible format characters with no ordinary use in published text.
const ALWAYS_HIDDEN = new Set([
  0x00AD, 0x034F, 0x115F, 0x1160, 0x180E, 0x200B, 0x2800,
  0x202A, 0x202B, 0x202C, 0x202D, 0x202E, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064,
  0x2066, 0x2067, 0x2068, 0x2069, 0x206A, 0x206B, 0x206C, 0x206D, 0x206E, 0x206F,
  0x3164, 0xFFA0, 0xFFF9, 0xFFFA, 0xFFFB, 0xE0001,
  // Reserved code points the Unicode standard lists as default-ignorable (rendered as nothing, no use): checked
  // against DerivedCoreProperties.txt of Unicode 18.0, which adds none to 17.0 (row 3638).
  0x2065, 0xFFF0, 0xFFF1, 0xFFF2, 0xFFF3, 0xFFF4, 0xFFF5, 0xFFF6, 0xFFF7, 0xFFF8,
]);

const hex = (cp) => "U+" + cp.toString(16).toUpperCase().padStart(4, "0");

// Map a UTF-16 index to 1-based line and code-point column. Linear setup and
// O(log n) per lookup: line starts and high-surrogate positions are indexed once.
// (It counted code points from the line start per finding, which made one long
// line of marks quadratic - 80k em dashes took 67 s; checker round 5, 30 Sep.)
function locator(text) {
  const starts = [0], astral = [];
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); if (c === 10) starts.push(i + 1); else if (c >= 0xD800 && c <= 0xDBFF) astral.push(i); }
  const below = (arr, x) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; };
  return (idx) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= idx) lo = mid; else hi = mid - 1; }
    const a = starts[lo];
    return { line: lo + 1, col: idx - a - (below(astral, idx) - below(astral, a)) + 1 };
  };
}

// ---------------------------------------------------------------- character pass
// Checklist B: these become a normal space (or a newline for U+2028/2029).
const UNUSUAL_SPACE = /[\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/g;

function scanChars(text, add) {
  for (const m of text.matchAll(UNUSUAL_SPACE)) add("unusual-space", m.index, { codepoint: hex(m[0].codePointAt(0)) });
  const cps = [];
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i);
    cps.push({ cp, ch: String.fromCodePoint(cp), idx: i });
    i += cp > 0xFFFF ? 2 : 1;
  }
  // Tag characters are legitimate only inside a subdivision flag:
  // U+1F3F4, one or more tags, then CANCEL TAG U+E007F.
  const flagTag = new Set();
  for (let k = 0; k < cps.length; k++) {
    if (cps[k].cp !== 0x1F3F4) continue;
    let j = k + 1;
    let name = "";
    while (j < cps.length && isTag(cps[j].cp) && cps[j].cp !== 0xE007F) name += String.fromCharCode(cps[j++].cp - 0xE0000);
    if (RGI_FLAG_TAGS.has(name) && j < cps.length && cps[j].cp === 0xE007F) for (let t = k + 1; t <= j; t++) flagTag.add(t);
  }
  // C2PA text manifest: U+FEFF then variation selectors carrying bytes
  // (b < 16 -> U+FE00+b, else U+E0100+b-16) that begin with "C2PATXT".
  for (let k = 0; k < cps.length; k++) {
    if (cps[k].cp !== 0xFEFF) continue;
    let bytes = "";
    for (let j = k + 1; j < cps.length && isVS(cps[j].cp) && bytes.length < 7; j++) {
      const cp = cps[j].cp;
      bytes += String.fromCharCode(cp <= 0xFE0F ? cp - 0xFE00 : cp - 0xE0100 + 16);
    }
    if (bytes === "C2PATXT") add("c2pa-text", cps[k].idx, { codepoint: hex(0xFEFF), detail: "C2PA text manifest wrapper" });
  }
  const hasRtl = RTL.test(text);
  for (let k = 0; k < cps.length; k++) {
    const { cp, idx } = cps[k];
    const prev = cps[k - 1], next = cps[k + 1];
    let hidden = false;
    if (cp === 0xFEFF) hidden = k !== 0;
    else if (ALWAYS_HIDDEN.has(cp) || isControlOrPrivate(cp)) hidden = true;
    else if (cp === 0x200E || cp === 0x200F || cp === 0x061C) hidden = !hasRtl; // direction marks belong in right-to-left text
    else if (cp === 0x200D) {
      // ZWJ: joins emoji into one glyph, or letters in joining scripts.
      const emojiJoin = prev && next && (isPictographic(prev.ch) || prev.cp === 0xFE0F || isSkinTone(prev.cp)) && isPictographic(next.ch);
      const scriptJoin = prev && (isJoiningMark(prev.ch) || (next && isJoiningScriptChar(prev.ch) && isJoiningScriptChar(next.ch)));
      hidden = !(emojiJoin || scriptJoin);
    } else if (cp === 0x200C) {
      hidden = !(prev && (isJoiningMark(prev.ch) || (next && isJoiningScriptChar(prev.ch) && isJoiningScriptChar(next.ch))));
    } else if (cp === 0xFE0E || cp === 0xFE0F) {
      hidden = !(prev && (isEmojiBase(prev.ch) || isKeycapBase(prev.ch)));
    } else if (cp >= 0xFE00 && cp <= 0xFE0D) {
      // Standardized variation sequences follow Han or maths symbols, one at a time.
      hidden = !(prev && (isHan(prev.ch) || /\p{Sm}/u.test(prev.ch)));
    } else if (cp >= 0xE0100 && cp <= 0xE01EF) {
      // Ideographic variation sequence: exactly one selector after a Han character.
      hidden = !(prev && isHan(prev.ch));
    } else if (isTag(cp)) {
      hidden = !flagTag.has(k);
    } else if (/\p{Cf}/u.test(cps[k].ch)) {
      hidden = true; // checklist A: any other Unicode format character
    }
    if (hidden) add("hidden-char", idx, { codepoint: hex(cp) });
  }
}

// ---------------------------------------------------------------- line pass
const CONFUSABLE = /[\u0430\u0435\u043E\u0440\u0441\u0443\u0445\u0456\u0458\u0455\u0501\u051B\u051D\u04CF\u0410\u0412\u0415\u041A\u041C\u041D\u041E\u0420\u0421\u0422\u0425\u0406\u0408\u0405\u03BF\u03BD\u03C1\u03B9\u03BA\u03C5\u0391\u0392\u0395\u0396\u0397\u0399\u039A\u039C\u039D\u039F\u03A1\u03A4\u03A5\u03A7\u0585\u0555\u13A0-\u13F4\uFF21-\uFF3A\uFF41-\uFF5A]/u;

function scanLines(text, add, opts = {}) {
  let offset = 0;
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    // attribution lines
    const trailer = line.match(/^\s*co-authored-by\s*:\s*([^<]*)(<[^>]*>)?/i);
    if (trailer && (TOOL_NAME.test(trailer[1]) || TOOL_EMAIL.test(trailer[2] || ""))) add("attribution-line", offset, { detail: "tool co-author trailer" });
    if (/^\s*(?:claude|codex|cursor|copilot|chatgpt)-session:/i.test(line)) add("attribution-line", offset, { detail: "tool session trailer" });
    // "Made-with: Cursor" (Cursor IDE and CLI commit trailer, rows 3638/3637). The key plus a tool's
    // own name as the value, so prose such as "Made with care" or "made-with: love" is untouched.
    if (/^\s*made-with\s*:\s*(?:claude(?: code)?|cursor|codex|github copilot|copilot|windsurf|gemini|chatgpt|aider|devin)\b/i.test(line)) add("attribution-line", offset, { detail: "tool made-with trailer" });
    for (const g of line.matchAll(/\b(?:generated|made|created|written|built) (?:with|by|using)\b/gi)) {
      if (TOOL_TAIL.test(line.slice(g.index + g[0].length))) add("attribution-line", offset + g.index, { detail: "generated-with footer" });
    }
    if (/claude\.ai\/code\/session_/i.test(line)) add("attribution-line", offset, { detail: "tool session link" });
    if (/claude\.com\/claude-code/i.test(line)) add("attribution-line", offset, { detail: "tool product link" });
    // trailing whitespace that can carry data; markdown's two-space break is allowed
    // Checklist A: any trailing whitespace, blank lines included (grep '[ \t]+$').
    // markdownBreaks:true keeps markdown's two-space line break for .md files.
    const tw = line.match(/[ \t\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+$/);
    if (tw && !(opts.markdownBreaks === true && tw[0] === "  " && tw.index > 0)) add("trailing-whitespace", offset + tw.index, { detail: JSON.stringify(tw[0]) });
    // homoglyphs: a word with at least two Latin letters and a look-alike letter
    for (const w of line.matchAll(/[\p{L}\p{M}]+/gu)) {
      const letters = [...w[0]].filter((c) => /\p{L}/u.test(c));
      const latin = letters.filter((c) => /\p{Script=Latin}/u.test(c) && !CONFUSABLE.test(c)).length;
      const looks = letters.filter((c) => CONFUSABLE.test(c)).length;
      // Greek look-alikes beside one Latin letter are ordinary units and symbols
      // (rho-v, nu-s, kappa-g): Greek needs two Latin letters in the word.
      const greek = letters.some((c) => /\p{Script=Greek}/u.test(c));
      if (latin >= (greek ? 2 : 1) && looks >= 1 && latin + looks === letters.length) add("homoglyph", offset + w.index, { detail: w[0] });
    }
    offset += raw.length + 1;
  }
}

// ---------------------------------------------------------------- pattern pass
const LEAKS = [
  [/\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{30,}/g, "GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}/g, "GitHub token"],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, "Anthropic key"],
  [/\bsk-(?:proj-)?(?=[A-Za-z0-9]*[A-Z])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{32,}/g, "OpenAI key"],
  [/\bAKIA(?![0-9A-Z]{9}EXAMPLE\b)[0-9A-Z]{16}\b/g, "AWS key"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "Slack token"],
  // Key material, not the bare header: code that strips or names the header is ordinary.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----(?:\\n|\s)+[A-Za-z0-9+\/=]{40,}/g, "private key"],
  [/\/root\/\.claude\b/g, "internal path"],
];

const JSONLD_FIELDS = new Set(["author", "creator", "contributor", "publisher", "sdPublisher", "editor", "funder", "sponsor", "producer", "accountablePerson", "copyrightHolder", "provider", "maintainer", "translator", "illustrator"]);

function scanPatterns(text, add, opts) {
  for (const m of text.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const cm = tag.match(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+(?:\s+[^\s>=]+(?=\s*\/?>))*))/i) || [];
    const content = cm[1] ?? cm[2] ?? cm[3] ?? "";
    if (/\bname\s*=\s*["']?generator\b/i.test(tag) && TOOL_TAIL.test(content)) add("generator-tag", m.index, { detail: content });
  }
  for (const m of text.matchAll(/<xmp:CreatorTool>([^<]*)</gi)) if (TOOL_TAIL.test(m[1])) add("generator-tag", m.index, { detail: m[1] });
  for (const m of text.matchAll(/digitalsourcetype\/(?:trainedAlgorithmicMedia|compositeWithTrainedAlgorithmicMedia|algorithmicMedia)\b/gi)) add("provenance-ref", m.index, { detail: "IPTC digital source type" });
  for (const m of text.matchAll(/rel\s*=\s*["']?c2pa-manifest\b/gi)) add("provenance-ref", m.index, { detail: "c2pa-manifest link" });
  for (const m of text.matchAll(/<dcterms:provenance\b|dcterms:provenance\s*=/gi)) add("provenance-ref", m.index, { detail: "dcterms:provenance" });
  for (const m of text.matchAll(/[\w\/%-]\.c2pa(?![\w.-])/gi)) add("provenance-ref", m.index, { detail: ".c2pa file" });
  for (const [re, what] of LEAKS) for (const m of text.matchAll(re)) add("leak", m.index, { detail: what });
  // Checklist E, owner 30 Sep "all relevant": a tool named as a PERSON-LIKE field
  // of JSON-LD. Whole-name match (TOOL_NAME), so "Claude Monet" and "Gemini CMS"
  // pass; a tool named in a description is ordinary text, not a field.
  for (const m of text.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([^]*?)<\/script>/gi)) {
    let data; try { data = JSON.parse(m[1]); } catch { continue; }
    const hits = [];
    const walk = (v) => {
      if (Array.isArray(v)) { v.forEach(walk); return; }
      if (!v || typeof v !== "object") return;
      for (const [k, val] of Object.entries(v)) {
        if (JSONLD_FIELDS.has(k)) for (const x of Array.isArray(val) ? val : [val]) {
          const nameStr = typeof x === "string" ? x : x && typeof x === "object" && typeof x.name === "string" ? x.name : "";
          if (nameStr && TOOL_NAME.test(nameStr)) hits.push(`${k}: ${nameStr}`);
        }
        walk(val);
      }
    };
    walk(data);
    for (const h of hits) add("jsonld-tool", m.index, { detail: h });
  }
  const lower = text.toLowerCase();
  for (const s of opts.denylist || []) {
    if (!s) continue;
    for (let i = lower.indexOf(String(s).toLowerCase()); i >= 0; i = lower.indexOf(String(s).toLowerCase(), i + 1)) add("leak", i, { detail: "denylisted identifier" });
  }
  for (const h of [...(opts.internalHosts || []), ...(opts.internalPaths || [])]) {
    if (!h) continue;
    for (let i = lower.indexOf(String(h).toLowerCase()); i >= 0; i = lower.indexOf(String(h).toLowerCase(), i + 1)) add("leak", i, { detail: "internal host" });
  }
}

// ---------------------------------------------------------------- visible marks
// Owner, 30 Sep: "Visible should have been included too". His plain-ASCII rule
// names em dash, en dash and smart quotes; an inventory of the served sites
// found those plus ellipses and box-drawing comment rules (all 971 of sark's in
// code comments, shipped in page source). Accented letters, currency, degree
// signs, arrows and emoji are ordinary content and are not listed here.
// Checker round 4 added the other dash, hyphen and ellipsis forms and the block
// elements. Primes, guillemets and the minus sign are left alone: they have
// ordinary uses (feet and inches, French quotes, arithmetic).
const TYPOGRAPHY = /[\u2010-\u2015\u2018-\u201F\u2024-\u2026\u22EE\u22EF\u2E3A\u2E3B\uFE58\uFE63\uFF0D\u2500-\u259F]/g;
const TYPO_NAME = (c) => c >= 0x2500 && c <= 0x259F ? "box-drawing or block" : (c >= 0x2024 && c <= 0x2026) || c === 0x22EE || c === 0x22EF ? "ellipsis" : c >= 0x2018 && c <= 0x201F ? "curly quote" : c === 0x2013 ? "en dash" : "dash or hyphen";
// ---------------------------------------------------------------- plug-in points
// The checks that use Bouios's own word lists (assistant phrases, AI tracking marks, style words)
// and the line editor live in no-marks-ip.js and are plugged in here by no-marks.js on the owner
// gateway. This core holds only the commodity checks (characters, spaces, dashes and quotes,
// attribution lines, leaks, file metadata) and is the part a customer worker runs in the
// customer's own account (owner decision 3512 for 3463). With nothing plugged in, the rules that
// need a word list report nothing and the editor actions answer that they are not available here.
const SCANNERS = [];
function registerScanner(fn) { if (typeof fn === "function" && !SCANNERS.includes(fn)) SCANNERS.push(fn); }
const ACTIONS = new Map();
function registerActions(map) { for (const [k, fn] of Object.entries(map || {})) if (typeof fn === "function") ACTIONS.set(k, fn); }


function scanVisible(text, add, opts) {
  if (opts.typography !== false) for (const m of text.matchAll(TYPOGRAPHY)) add("typography", m.index, { codepoint: hex(m[0].codePointAt(0)), detail: TYPO_NAME(m[0].codePointAt(0)) });
  for (const scan of SCANNERS) scan(text, add, opts);
}

// ---------------------------------------------------------------- settings
// Owner, 30 Sep: "user needs to be able to change what it removes / adds".
// Text rules: fix (change the text) | report (leave it, list it) | off (ignore).
// File kinds: remove | keep (leave it, list it) | off (ignore).
// C2PA manifests and AI-source labels can be kept or ignored, never removed:
// that is the line stated to the owner, and a setting must not become a way round it.
const TEXT_MODES = {
  "hidden-char": ["fix", "report", "off"], "c2pa-text": ["fix", "report", "off"], "unusual-space": ["fix", "report", "off"],
  "trailing-whitespace": ["fix", "report", "off"], "typography": ["fix", "report", "off"], "attribution-line": ["fix", "report", "off"],
  "generator-tag": ["fix", "report", "off"], "provenance-ref": ["fix", "report", "off"],
  "homoglyph": ["report", "off"], "leak": ["report", "off"], "ai-artefact": ["report", "off"], "jsonld-tool": ["report", "off"],
  "style-word": ["report", "off"], "tool-author": ["report", "off"],
};
const FILE_MODES = {
  gps: ["remove", "keep", "off"], credit: ["remove", "keep", "off"], software: ["remove", "keep", "off"], xmp: ["remove", "keep", "off"],
  provenance: ["remove", "keep", "off"], "office-meta": ["remove", "keep", "off"], "font-c2pa": ["remove", "keep", "off"], comment: ["remove", "keep", "off"],
  c2pa: ["keep", "off"], "ai-source": ["keep", "off"],
};
const DEFAULT_SETTINGS = Object.freeze({
  text: Object.fromEntries(Object.entries(TEXT_MODES).map(([k, m]) => [k, k === "style-word" ? "off" : m[0]])),
  file: Object.fromEntries(Object.entries(FILE_MODES).map(([k, m]) => [k, m[0]])),
  add: { credit: "" },
  denylist: [], internalHosts: [], internalPaths: [], markdownBreaks: false,
});
const SETTING_KEYS = new Set(["text", "file", "add", "denylist", "internalHosts", "internalPaths", "markdownBreaks"]);
const strList = (v, name, errors) => {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > 200 || v.some((x) => typeof x !== "string" || !x || x.length > 200)) { errors.push(`${name} must be a list of up to 200 non-empty strings of at most 200 characters`); return undefined; }
  return v.slice();
};
// Merge a user's settings over the defaults and validate every value.
function resolveSettings(input = {}) {
  const errors = [];
  const out = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  if (input !== undefined && input !== null && (typeof input !== "object" || Array.isArray(input))) return { ok: false, errors: ["settings must be an object"], settings: null };
  const src = input || {};
  for (const k of Object.keys(src)) if (!SETTING_KEYS.has(k)) errors.push(`unknown setting: ${k}`);
  for (const [group, modes] of [["text", TEXT_MODES], ["file", FILE_MODES]]) {
    const g = src[group];
    if (g === undefined) continue;
    if (!g || typeof g !== "object" || Array.isArray(g)) { errors.push(`${group} must be an object`); continue; }
    for (const [k, v] of Object.entries(g)) {
      // Own keys only: "constructor" or "__proto__" must read as unknown, not crash.
      if (!Object.hasOwn(modes, k)) { errors.push(`unknown ${group} rule: ${k}`); continue; }
      if (!modes[k].includes(v)) { errors.push(`${group}.${k} must be one of ${modes[k].join(", ")}` + (k === "c2pa" || k === "ai-source" ? " (C2PA manifests and AI-source labels are never removed)" : "")); continue; }
      out[group][k] = v;
    }
  }
  if (src.add !== undefined) {
    const c = src.add && src.add.credit;
    if (c !== undefined && (typeof c !== "string" || c.length > 80 || /[^\x20-\x7E]/.test(c))) errors.push("add.credit must be plain text of at most 80 characters");
    else if (c !== undefined) out.add.credit = c;
  }
  for (const k of ["denylist", "internalHosts", "internalPaths"]) { const v = strList(src[k], k, errors); if (v) out[k] = v; }
  if (src.markdownBreaks !== undefined) { if (typeof src.markdownBreaks !== "boolean") errors.push("markdownBreaks must be true or false"); else out.markdownBreaks = src.markdownBreaks; }
  return errors.length ? { ok: false, errors, settings: null } : { ok: true, errors: [], settings: out };
}
// Layer settings: b over a, one level deep for text/file/add, lists and flags replaced.
function mergeSettings(a = {}, b = {}) {
  const A = a && typeof a === "object" ? a : {}, B = b && typeof b === "object" ? b : {};
  const out = { ...A, ...B };
  for (const k of ["text", "file", "add"]) if (A[k] || B[k]) out[k] = { ...(A[k] && typeof A[k] === "object" ? A[k] : {}), ...(B[k] && typeof B[k] === "object" ? B[k] : {}) };
  return out;
}
// Old callers pass loose options (typography:false, styleWords, credit); map them in.
function settingsFrom(opts) {
  const base = opts && opts.settings ? resolveSettings(opts.settings) : { ok: true, settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) };
  if (!base.ok) throw new Error("invalid settings: " + base.errors.join("; "));
  const st = base.settings;
  if (opts) {
    if (opts.typography === false) st.text.typography = "off";
    if (opts.styleWords === true && st.text["style-word"] === "off") st.text["style-word"] = "report";
    if (typeof opts.credit === "string" && opts.credit) st.add.credit = opts.credit;
    if (opts.markdownBreaks === true) st.markdownBreaks = true;
    for (const k of ["denylist", "internalHosts", "internalPaths"]) if (Array.isArray(opts[k])) st[k] = opts[k];
  }
  return st;
}
const scanOptsFrom = (st) => ({ typography: st.text.typography !== "off", styleWords: st.text["style-word"] !== "off", markdownBreaks: st.markdownBreaks, denylist: st.denylist, internalHosts: st.internalHosts, internalPaths: st.internalPaths });

// ---------------------------------------------------------------- cleanText
// Owner checklist v4: A hidden characters REMOVED, B spaces CONVERTED, C
// homoglyphs FLAGGED, D attribution lines REMOVED, E generator tags and c2pa
// link tags REMOVED, G leaks BLOCKED (reported, never silently edited).
// Typography is converted to ASCII (the owner's plain-ASCII rule) unless
// typography:false. Genuine emoji, joining-script ZWJ/ZWNJ and a leading BOM
// are kept, because scanText does not report them.
// Returns { text, fixed: {rule: count}, remaining: findings not auto-fixed }.
const TYPO_ASCII = (c) => {
  if (c === 0x2026 || c === 0x22EE || c === 0x22EF) return "...";
  if (c === 0x2025) return "..";
  if (c === 0x2024) return ".";
  if (c === 0x2018 || c === 0x2019 || c === 0x201A || c === 0x201B) return "'";
  if (c >= 0x201C && c <= 0x201F) return "\"";
  return "-"; // dashes, hyphens, box-drawing and block elements
};
const lineSpan = (s, i) => {
  const a = s.lastIndexOf("\n", i - 1) + 1;
  const e = s.indexOf("\n", i);
  return [a, e < 0 ? s.length : e + 1];
};

function cleanText(text, opts = {}) {
  const st = settingsFrom(opts);
  const mode = (rule) => st.text[rule] || "report";
  const scanOpts = scanOptsFrom(st);
  let s = String(text ?? "");
  const fixed = {};
  let remaining = [];
  // Two passes: removing a line can expose nothing new, but converting a
  // character inside a removed line must not double-count, so edits are
  // collected, de-overlapped (wider span wins) and applied from the end.
  for (let pass = 0; pass < 2; pass++) {
    const edits = [];
    remaining = [];
    for (const f of scanText(s, scanOpts)) {
      if (mode(f.rule) === "off") continue;
      if (mode(f.rule) === "report") { remaining.push(f); continue; }
      const cp = f.codepoint ? parseInt(f.codepoint.slice(2), 16) : null;
      const w = cp !== null && cp > 0xFFFF ? 2 : 1;
      if (f.rule === "hidden-char" || f.rule === "c2pa-text") { if (f.rule === "hidden-char") edits.push([f.index, f.index + w, "", f.rule]); }
      else if (f.rule === "unusual-space") edits.push([f.index, f.index + w, cp === 0x2028 || cp === 0x2029 ? "\n" : " ", f.rule]);
      else if (f.rule === "trailing-whitespace") edits.push([f.index, f.index + JSON.parse(f.detail).length, "", f.rule]);
      else if (f.rule === "typography") edits.push([f.index, f.index + w, TYPO_ASCII(cp), f.rule]);
      else if (f.rule === "attribution-line") {
        const [a, e] = lineSpan(s, f.index);
        if (e - a <= 240) edits.push([a, e, "", f.rule]); else remaining.push(f);
      } else if (f.rule === "generator-tag" && s.startsWith("<meta", f.index)) {
        const m = s.slice(f.index).match(/^<meta\b[^>]*>/i);
        if (m) edits.push([f.index, f.index + m[0].length, "", f.rule]); else remaining.push(f);
      } else if (f.rule === "provenance-ref" && /c2pa-manifest/.test(f.detail || "")) {
        const a = s.lastIndexOf("<", f.index), e = s.indexOf(">", f.index);
        if (a >= 0 && e > a && /^<link\b/i.test(s.slice(a, a + 5))) edits.push([a, e + 1, "", f.rule]);
        else if (/^\s*Link\s*:/i.test(s.slice(lineSpan(s, f.index)[0]))) { const [la, le] = lineSpan(s, f.index); edits.push([la, le, "", f.rule]); }
        else remaining.push(f);
      } else remaining.push(f);
    }
    if (!edits.length) break;
    edits.sort((x, y) => x[0] - y[0] || y[1] - x[1]);
    const keep = [];
    let end = -1;
    for (const e of edits) if (e[0] >= end) { keep.push(e); end = e[1]; }
    // Built in one forward pass (slicing once per edit was quadratic on a long text).
    const parts = []; let at = 0;
    for (const [a, e, r, rule] of keep) { parts.push(s.slice(at, a), r); at = e; fixed[rule] = (fixed[rule] || 0) + 1; }
    parts.push(s.slice(at));
    s = parts.join("");
  }
  return { text: s, fixed, remaining };
}

// ---------------------------------------------------------------- scanFile
// Checklist F (files) and H (detect): EXIF GPS, credit and software tags, XMP
// provenance / creator tool / AI source type, C2PA manifests (JUMBF) in JPEG,
// PNG, WebP, PDF and video, a font's C2PA table, Office document properties,
// PDF Producer/Creator/Author, Matplotlib and similar software tags. It reads
// bytes only and changes nothing. Async because Office files are zips and
// deflate needs DecompressionStream (present in Workers and Node 18+).
// Findings: { rule, detail } with rule in gps | credit | software | provenance |
// ai-source | c2pa | font-c2pa | office-meta.
// Chunked: one String.fromCharCode per 32 KB, not per byte (a 5 MB PDF went from ~0.7 s to a fraction).
const latin1 = (b, a = 0, e = b.length) => { let o = ""; for (let i = a; i < e; i += 32768) o += String.fromCharCode.apply(null, b.subarray(i, Math.min(e, i + 32768))); return o; };
const u16 = (b, i, le) => le ? b[i] | (b[i + 1] << 8) : (b[i] << 8) | b[i + 1];
const u32 = (b, i, le) => (le ? (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) : ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3])) >>> 0;

function tiffFindings(b, out) {
  if (b.length < 8) return;
  const le = b[0] === 0x49;
  const ifd = u32(b, 4, le);
  if (ifd + 2 > b.length) return;
  const n = u16(b, ifd, le);
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > b.length) break;
    const tag = u16(b, e, le), count = u32(b, e + 4, le);
    const str = () => { const off = count > 4 ? u32(b, e + 8, le) : e + 8; return latin1(b, off, Math.min(b.length, off + count)).replace(/\u0000+$/, ""); };
    if (tag === 0x8825) out.push({ rule: "gps", detail: "EXIF GPS block" });
    if (tag === 0x013B || tag === 0x8298) out.push({ rule: "credit", detail: (tag === 0x013B ? "Artist: " : "Copyright: ") + str() });
    if (tag === 0x0131) out.push({ rule: "software", detail: "Software: " + str() });
  }
}
function xmpFindings(x, out) {
  if (/dcterms:provenance/i.test(x)) out.push({ rule: "provenance", detail: "XMP dcterms:provenance" });
  const tool = x.match(/CreatorTool(?:="|>)([^"<]{0,80})/i);
  if (tool) out.push({ rule: "software", detail: "XMP CreatorTool: " + tool[1] });
  if (/trainedAlgorithmicMedia|algorithmicMedia/i.test(x)) out.push({ rule: "ai-source", detail: "IPTC digital source type: AI" });
  if (/photoshop:Credit|dc:rights|dc:creator|plus:Licensor/i.test(x) && !/Matplotlib/i.test(x)) out.push({ rule: "credit", detail: "XMP credit or rights" + ((x.match(/photoshop:Credit="([^"]{0,80})"/) || [])[1] ? ": " + x.match(/photoshop:Credit="([^"]{0,80})"/)[1] : "") });
}
const hasC2pa = (str) => /jumb[\s\S]{0,64}c2pa|c2pa[\s\S]{0,64}jumb|application#2Fc2pa|urn:c2pa/i.test(str);

// PDF info strings, read the way a PDF reader does: a literal string runs to its
// MATCHING bracket, with "\x" escapes and balanced nested brackets inside; a hex
// string runs from < to >. A regex stopping at the first ")" cut a real Chromium
// Creator "(Mozilla/5.0 \(X11; ...\) ...)" short, and blanking that part left a
// backslash that escaped the real closing bracket - the cleaned PDF no longer
// opened (test pack, 30 Sep). Returns [{ key, start, end, value }] with start/end
// the content span inside the delimiters. A key inside another string (a
// Title reading "see /Author (x)") is text, not a key, and a key inside stream
// data is binary: one forward cursor tracks both, so each match costs only the
// text since the last one. An unclosed string runs to the end of the file, so
// the first one stops the walk - otherwise 100,000 unclosed "/Author (" made
// the scan quadratic (over 2 minutes on 900 KB).
function pdfInfoStrings(t, keys) {
  const out = [];
  let c = 0, d = 0;
  const hidden = (pos) => { // is pos inside a string or a stream?
    while (c < pos) {
      if (!d && t.startsWith("endstream", c)) { c += 9; continue; }
      if (!d && t.startsWith("stream", c) && (t[c + 6] === "\n" || t[c + 6] === "\r")) { const e = t.indexOf("endstream", c); c = e < 0 ? t.length : e + 9; continue; }
      if (!d && t[c] === "%") { const e = t.slice(c, c + 4096).search(/[\r\n]/); c += e < 0 ? 4096 : e; continue; }
      const ch = t[c];
      if (d && ch === "\\") { c += 2; continue; }
      if (ch === "(") d++;
      else if (ch === ")" && d) d--;
      c++;
    }
    return d > 0 || c > pos;
  };
  const re = new RegExp("/(" + keys.join("|") + ")\\s*([(<])", "g");
  for (const m of t.matchAll(re)) {
    if (hidden(m.index)) continue;
    const start = m.index + m[0].length;
    if (m[2] === "<") {
      if (t[start] === "<") continue; // "<<" is a dictionary, not a string
      const end = t.indexOf(">", start);
      if (end < 0) break;
      const hex = t.slice(start, end).replace(/\s+/g, "");
      let v = "", real = false;
      for (let i = 0; i + 1 < hex.length; i += 2) {
        const c = parseInt(hex.slice(i, i + 2), 16);
        if (c >= 32 && c < 127) v += String.fromCharCode(c);
        if (c !== 0x20 && c !== 0 && c !== 0xFE && c !== 0xFF) real = true;
      }
      // Any byte besides spaces, nulls and a byte-order mark is a real value,
      // printable or not (a name in Chinese can have no printable byte at all).
      out.push({ key: m[1], at: m.index, start, end, value: real ? (v.trim() || "<" + hex + ">") : "", hex: true });
      c = end + 1;
      continue;
    }
    let depth = 1, i = start;
    for (; i < t.length && depth > 0; i++) {
      const ch = t[i];
      if (ch === "\\") { i++; continue; }
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
    }
    if (depth !== 0) break;
    out.push({ key: m[1], at: m.index, start, end: i - 1, value: t.slice(start, i - 1) });
    c = i;
  }
  return out;
}

async function inflateRaw(bytes) {
  const ds = new DecompressionStream("deflate-raw");
  const w = ds.writable.getWriter();
  w.write(bytes); w.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}

async function scanFile(input, name = "") {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  const out = [];
  const head = latin1(b, 0, Math.min(b.length, 16));
  if (b[0] === 0xFF && b[1] === 0xD8) {                        // JPEG
    let i = 2;
    while (i + 4 <= b.length && b[i] === 0xFF) {
      const m = b[i + 1];
      if (m === 0xDA || m === 0xD9) break;
      const len = u16(b, i + 2, false), body = b.subarray(i + 4, i + 2 + len), h = latin1(body, 0, Math.min(body.length, 40));
      if (m === 0xE1 && h.startsWith("Exif\u0000")) tiffFindings(body.subarray(6), out);
      else if (m === 0xE1 && h.startsWith("http://ns.adobe.com/xap/")) xmpFindings(latin1(body), out);
      else if (m === 0xEB && hasC2pa(latin1(body))) out.push({ rule: "c2pa", detail: "C2PA manifest (JPEG APP11)" });
      else if (m === 0xED) out.push({ rule: "credit", detail: "IPTC/Photoshop block" });
      i += 2 + len;
    }
  } else if (head.startsWith("\u0089PNG")) {                     // PNG
    let i = 8;
    while (i + 8 <= b.length) {
      const len = u32(b, i, false), type = latin1(b, i + 4, i + 8), body = b.subarray(i + 8, i + 8 + len);
      if (type === "caBX") out.push({ rule: "c2pa", detail: "C2PA manifest (PNG caBX)" });
      else if (type === "eXIf") tiffFindings(body, out);
      else if (type === "tEXt" || type === "iTXt" || type === "zTXt") {
        const t = latin1(body), key = t.slice(0, t.indexOf("\u0000"));
        if (/^XML:com\.adobe\.xmp$/i.test(key)) xmpFindings(t, out);
        else if (/^Software$/i.test(key)) out.push({ rule: "software", detail: "PNG Software: " + t.slice(key.length + 1, key.length + 81) });
        else if (/^(Author|Copyright|Artist)$/i.test(key)) out.push({ rule: "credit", detail: "PNG " + key });
      }
      if (type === "IEND") break;
      i += 12 + len;
    }
  } else if (head.startsWith("%PDF")) {                          // PDF
    const t = latin1(b);
    for (const x of pdfInfoStrings(t, ["Producer", "Creator", "Author", "CreationDate", "ModDate"])) {
      if (!x.value.trim()) continue;
      if (/Date$/.test(x.key)) out.push({ rule: "office-meta", detail: "PDF " + x.key });
      else if (x.key === "Author") out.push({ rule: "credit", detail: "PDF Author" });
      else out.push({ rule: "software", detail: `PDF ${x.key}: ${x.value.slice(0, 120)}` });
    }
    if (/<x:xmpmeta/.test(t)) xmpFindings(t, out);
    if (hasC2pa(t)) out.push({ rule: "c2pa", detail: "C2PA manifest (PDF)" });
  } else if (u32(b, 0, false) === 0x00010000 || head.startsWith("OTTO") || head.startsWith("true")) { // font
    const n = u16(b, 4, false);
    for (let k = 0; k < n && 12 + k * 16 + 4 <= b.length; k++) if (latin1(b, 12 + k * 16, 16 + k * 16) === "C2PA") out.push({ rule: "font-c2pa", detail: "font C2PA table" });
  } else if (b[0] === 0x50 && b[1] === 0x4B && b[2] === 3 && b[3] === 4) { // zip: docx, pptx, xlsx
    let i = 0;
    while (i + 30 <= b.length && u32(b, i, true) === 0x04034b50) {
      const method = u16(b, i + 8, true), size = u32(b, i + 18, true), nlen = u16(b, i + 26, true), xlen = u16(b, i + 28, true);
      const fname = latin1(b, i + 30, i + 30 + nlen), data = b.subarray(i + 30 + nlen + xlen, i + 30 + nlen + xlen + size);
      if (/^docProps\/(core|app)\.xml$/.test(fname)) {
        const xml = new TextDecoder().decode(method === 8 ? await inflateRaw(data) : data);
        for (const m of xml.matchAll(OFFICE_META)) if (m[2].trim() && !OFFICE_STATS.test(m[1])) out.push({ rule: "office-meta", detail: `${m[1]}: ${m[2].slice(0, 80)}` });
      }
      if (/^docProps\/thumbnail\.[a-z]+$/i.test(fname)) out.push({ rule: "office-meta", detail: "thumbnail image " + fname });
      if (fname === "word/settings.xml" || /^customXml\/item\d+\.xml$/.test(fname)) {
        const xml = new TextDecoder().decode(method === 8 ? await inflateRaw(data) : data);
        if (/<w:rsids>/.test(xml)) out.push({ rule: "office-meta", detail: "editing-session ids (rsid)" });
        if (EMPTY_BIB.test(xml)) out.push({ rule: "office-meta", detail: "empty bibliography store (template id) " + fname });
      }
      if (size === 0 && (u16(b, i + 6, true) & 8)) break; // streamed entry without sizes: stop rather than guess
      i += 30 + nlen + xlen + size;
    }
  } else if (head.startsWith("RIFF") && latin1(b, 8, 12) === "WEBP") { // WebP
    const t = latin1(b);
    if (/EXIF/.test(latin1(b, 12, Math.min(b.length, 64)))) out.push({ rule: "credit", detail: "WebP EXIF chunk" });
    if (/<x:xmpmeta/.test(t)) xmpFindings(t, out);
    if (hasC2pa(t) || /C2PA/.test(t)) out.push({ rule: "c2pa", detail: "C2PA manifest (WebP)" });
  } else {                                                        // text formats (SVG, XML) and video
    const t = latin1(b, 0, Math.min(b.length, 4 << 20));
    if (/<svg\b|<\?xml/i.test(t.slice(0, 400))) {
      if (/Matplotlib|Created with matplotlib|Inkscape|Illustrator|generator="[^"]*"/i.test(t)) out.push({ rule: "software", detail: "SVG creator software" });
      if (/<x:xmpmeta|dcterms:provenance/.test(t)) xmpFindings(t, out);
    }
    if (hasC2pa(t)) out.push({ rule: "c2pa", detail: "C2PA manifest" });
  }
  // A C2PA manifest that declares the file AI-made (IPTC trainedAlgorithmicMedia
  // inside the manifest, as the sark crest worksheet PNG carries) is reported too.
  if (out.some((f) => f.rule === "c2pa") && /trainedAlgorithmicMedia/.test(latin1(b, 0, Math.min(b.length, 8 << 20)))) out.push({ rule: "ai-source", detail: "C2PA manifest declares AI-generated media" });
  return out;
}

// ---------------------------------------------------------------- cleanFile
// Checklist F REMOVES: EXIF GPS, credit (Artist, Copyright) and Software tags
// (orientation and the rest of EXIF are kept, and the removed values are zeroed
// in the bytes, not just unlinked); XMP packets and IPTC blocks; PNG text chunks
// naming software or an author; WebP EXIF/XMP chunks; PDF Producer, Creator and
// Author (blanked in place so xref offsets stay valid); a font's C2PA table
// (font rebuilt, other tables kept); Office core/app properties; SVG metadata and
// generator comments. opts.credit (e.g. "Syndakat") writes that credit into the
// cleaned image, for the owner's own content (checklist H).
// NOT removed, reported in `remaining`: embedded C2PA manifests (JUMBF) - a
// manifest can declare AI-generated media, and stripping that declaration is
// not something this module does. A file it cannot parse is returned unchanged.
// Returns { bytes, removed: [{rule, detail}], remaining: scanFile(result) }.
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
const concat = (parts) => { const n = parts.reduce((a, p) => a + p.length, 0), o = new Uint8Array(n); let i = 0; for (const p of parts) { o.set(p, i); i += p.length; } return o; };
const be32b = (v) => new Uint8Array([v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);
const be16b = (v) => new Uint8Array([(v >>> 8) & 255, v & 255]);
const le16b = (v) => new Uint8Array([v & 255, (v >>> 8) & 255]);
const le32b = (v) => new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, v >>> 24]);
const ascii = (str) => new TextEncoder().encode(str);
const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];
const DROP_TAGS = new Map([[0x8825, "gps"], [0x013B, "credit"], [0x8298, "credit"], [0x0131, "software"], [0x9C9D, "credit"]]);

// Edit a TIFF block in place (same length): drop IFD0 entries for GPS, credit
// and software, zero their value bytes and the whole GPS IFD.
function tiffClean(t, removed, want = () => true) {
  if (t.length < 8) return;
  const le = t[0] === 0x49, r16 = (i) => u16(t, i, le), r32 = (i) => u32(t, i, le);
  const w16 = (i, v) => { if (le) { t[i] = v & 255; t[i + 1] = v >> 8; } else { t[i] = v >> 8; t[i + 1] = v & 255; } };
  const zero = (a, n) => { for (let i = Math.max(0, a); i < Math.min(t.length, a + n); i++) t[i] = 0; };
  const ifd = r32(4); if (ifd + 2 > t.length) return;
  const n = r16(ifd); const keep = [];
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + k * 12; if (e + 12 > t.length) return;
    const tag = r16(e), type = r16(e + 2), count = r32(e + 4), size = (TYPE_SIZE[type] || 1) * count;
    if (!DROP_TAGS.has(tag) || !want(DROP_TAGS.get(tag))) { keep.push(t.slice(e, e + 12)); continue; }
    removed.push({ rule: DROP_TAGS.get(tag), detail: "EXIF tag 0x" + tag.toString(16) });
    if (tag === 0x8825) {
      const g = r32(e + 8);
      // Only a GPS IFD past the header whose whole block fits: a zero or corrupt
      // pointer would otherwise zero the TIFF header and every tag with it.
      if (g >= 8 && g + 2 <= t.length && g + 2 + r16(g) * 12 + 4 <= t.length) { const m = r16(g); for (let q = 0; q < m; q++) { const ge = g + 2 + q * 12; if (ge + 12 > t.length) break; const gs = (TYPE_SIZE[r16(ge + 2)] || 1) * r32(ge + 4); if (gs > 4) zero(r32(ge + 8), gs); } zero(g, 2 + m * 12 + 4); }
    } else if (size > 4) zero(r32(e + 8), size);
  }
  if (keep.length === n) return;
  const next = t.slice(ifd + 2 + n * 12, ifd + 2 + n * 12 + 4);
  w16(ifd, keep.length);
  keep.forEach((row, k) => t.set(row, ifd + 2 + k * 12));
  t.set(next, ifd + 2 + keep.length * 12);
  zero(ifd + 2 + keep.length * 12 + 4, (n - keep.length) * 12);
}
const xmpPacket = (credit) => ascii(`<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" photoshop:Credit="${credit.replace(/[<>&"]/g, "")}"/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`);

function cleanJpeg(b, removed, opts, want) {
  const out = [b.subarray(0, 2)]; let i = 2;
  const credit = opts.credit ? [new Uint8Array([0xFF, 0xE1]), be16b(0), ascii("http://ns.adobe.com/xap/1.0/"), new Uint8Array([0]), xmpPacket(opts.credit)] : null;
  if (credit) { const body = concat(credit.slice(2)); out.push(new Uint8Array([0xFF, 0xE1]), be16b(body.length + 2), body); removed.push({ rule: "credit-added", detail: opts.credit }); }
  while (i + 4 <= b.length && b[i] === 0xFF) {
    const m = b[i + 1];
    if (m === 0xDA || m === 0xD9) break;
    const len = u16(b, i + 2, false), end = i + 2 + len, body = b.subarray(i + 4, end), h = latin1(body, 0, Math.min(body.length, 40));
    if (m === 0xE1 && h.startsWith("Exif" + String.fromCharCode(0))) { const seg = b.slice(i, end); tiffClean(seg.subarray(10), removed, want); out.push(seg); }
    else if (m === 0xE1 && h.startsWith("http://ns.adobe.com/xap/") && want("xmp")) removed.push({ rule: "xmp", detail: "XMP packet" });
    else if (m === 0xED && want("credit")) removed.push({ rule: "credit", detail: "IPTC/Photoshop block" });
    else if (m === 0xFE && want("comment")) removed.push({ rule: "comment", detail: "JPEG comment" });
    else out.push(b.subarray(i, end));
    i = end;
  }
  out.push(b.subarray(i));
  return concat(out);
}
const pngChunk = (type, body) => { const tb = concat([ascii(type), body]); return concat([be32b(body.length), tb, be32b(crc32(tb))]); };
function cleanPng(b, removed, opts, want) {
  const out = [b.subarray(0, 8)]; let i = 8;
  while (i + 12 <= b.length) {
    const len = u32(b, i, false), type = latin1(b, i + 4, i + 8), body = b.subarray(i + 8, i + 8 + len), whole = b.subarray(i, i + 12 + len);
    if (type === "tEXt" || type === "iTXt" || type === "zTXt") {
      const t = latin1(body), key = t.slice(0, t.indexOf(String.fromCharCode(0)));
      const kind = /^(Software|Source)$/i.test(key) ? "software" : /^XML:com\.adobe\.xmp$/i.test(key) ? "xmp" : /^(Author|Copyright|Artist|Description)$/i.test(key) ? "credit" : /^(Comment|Creation Time)$/i.test(key) ? "comment" : null;
      if (kind && want(kind)) removed.push({ rule: kind, detail: "PNG " + key });
      else out.push(whole);
    } else if (type === "eXIf") { const t = body.slice(); tiffClean(t, removed, want); out.push(pngChunk("eXIf", t)); }
    else out.push(pngChunk(type, body)); // CRC recomputed: a kept chunk leaves valid either way
    if (type === "IHDR" && opts.credit) { out.push(pngChunk("tEXt", concat([ascii("Author"), new Uint8Array([0]), ascii(opts.credit)]))); removed.push({ rule: "credit-added", detail: opts.credit }); }
    if (type === "IEND") break;
    i += 12 + len;
  }
  return concat(out);
}
function cleanWebp(b, removed, want) {
  const out = []; let i = 12; let flags = -1, vp8x = -1;
  while (i + 8 <= b.length) {
    const id = latin1(b, i, i + 4), len = u32(b, i + 4, true), end = i + 8 + len + (len & 1);
    // A WebP EXIF chunk goes whole when any of its kinds is set to remove.
    if ((id === "EXIF" && (want("gps") || want("credit") || want("software"))) || (id === "XMP " && want("xmp"))) removed.push({ rule: id === "EXIF" ? "exif" : "xmp", detail: "WebP " + id.trim() + " chunk" });
    else { if (id === "VP8X") vp8x = out.reduce((a, p) => a + p.length, 0) + 8; out.push(b.subarray(i, end)); }
    i = end;
  }
  const bodyAll = concat(out);
  if (vp8x >= 0) bodyAll[vp8x] &= ~0x0C;
  return concat([ascii("RIFF"), le32b(bodyAll.length + 4), ascii("WEBP"), bodyAll]);
}
function cleanPdf(b, removed, want) {
  const o = b.slice(); const t = latin1(o);
  const blank = (a, e) => { for (let i = a; i < e; i++) o[i] = 0x20; };
  for (const x of pdfInfoStrings(t, ["Producer", "Creator", "Author", "CreationDate", "ModDate"])) {
    const rule = /Date$/.test(x.key) ? "office-meta" : x.key === "Author" ? "credit" : "software";
    if (!x.value.trim() || !want(rule)) continue;
    // The whole entry, key and value, becomes spaces: whitespace is legal
    // between dictionary entries, the length is unchanged so every xref offset
    // stays valid, and no emptied field is left behind to show a wipe.
    blank(x.at, x.end + 1);
    removed.push({ rule, detail: "PDF " + x.key });
  }
  for (const m of t.matchAll(/<(xmp:CreatorTool|pdf:Producer|dcterms:provenance|dc:creator)>([\s\S]*?)<\/\1>/g)) { if (!want("xmp")) continue; const a = m.index + m[1].length + 2; blank(a, a + m[2].length); removed.push({ rule: "xmp", detail: "PDF XMP " + m[1] }); }
  return o;
}
function cleanFont(b, removed) {
  const n = u16(b, 4, false), dir = [];
  for (let k = 0; k < n; k++) { const e = 12 + k * 16; dir.push({ tag: latin1(b, e, e + 4), sum: u32(b, e + 4, false), off: u32(b, e + 8, false), len: u32(b, e + 12, false) }); }
  const keep = dir.filter((d) => d.tag !== "C2PA");
  if (keep.length === n) return b;
  removed.push({ rule: "font-c2pa", detail: "font C2PA table" });
  const m = keep.length, es = Math.floor(Math.log2(m)), sr = (1 << es) * 16;
  let off = 12 + m * 16; const head = [b.subarray(0, 4), be16b(m), be16b(sr), be16b(es), be16b(m * 16 - sr)], rows = [], data = [];
  for (const d of keep) { rows.push(concat([ascii(d.tag), be32b(d.sum), be32b(off), be32b(d.len)])); const body = b.subarray(d.off, d.off + d.len); const pad = (4 - (d.len % 4)) % 4; data.push(body, new Uint8Array(pad)); off += d.len + pad; }
  return concat([...head, ...rows, ...data]);
}
async function deflateRaw(bytes) { const cs = new CompressionStream("deflate-raw"); const w = cs.writable.getWriter(); w.write(bytes); w.close(); return new Uint8Array(await new Response(cs.readable).arrayBuffer()); }
// Office document properties that name a person, a program or a moment of
// making: author, editor, company, the application and its template, editing
// time, revision count and the created/modified stamps (a script sets both to
// the same second, which is itself a tell). The saved statistics go too: a
// generated file keeps its template's "0 words", and the editor recounts them.
const OFFICE_META = /<(dc:creator|cp:lastModifiedBy|dc:description|Application|AppVersion|Template|TotalTime|Company|Manager|cp:revision|dcterms:created|dcterms:modified|cp:lastPrinted|Pages|Words|Characters|CharactersWithSpaces|Lines|Paragraphs)\b[^>]*>([^<]*)<\/\1>/g;
// Statistics are removed but not reported: "Words: 523" is not a mark on its own.
const OFFICE_STATS = /^(Pages|Words|Characters|CharactersWithSpaces|Lines|Paragraphs)$/;
const OFFICE_EMPTY = /<(dc:creator|cp:lastModifiedBy|dc:description|Company|Manager)\/>/g;
const RSID_ATTR = / w:rsid[A-Za-z]*="[0-9A-Fa-f]{8}"/g;
const EMPTY_BIB = /^\s*(?:<\?xml[^>]*\?>)?\s*<b:Sources\b[^>]*\/>\s*$/;
async function cleanZip(b, removed) {
  let rsidSeen = false;
  // Walk local headers (sizes from the central directory when a data descriptor is used).
  const central = new Map(); let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (u32(b, i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd >= 0) { let c = u32(b, eocd + 16, true); const cnt = u16(b, eocd + 10, true); for (let k = 0; k < cnt && u32(b, c, true) === 0x02014b50; k++) { const nl = u16(b, c + 28, true), xl = u16(b, c + 30, true), cl = u16(b, c + 32, true); central.set(u32(b, c + 42, true), { csize: u32(b, c + 20, true), usize: u32(b, c + 24, true), crc: u32(b, c + 16, true) }); c += 46 + nl + xl + cl; } }
  const entries = []; let i = 0;
  while (i + 30 <= b.length && u32(b, i, true) === 0x04034b50) {
    const flags = u16(b, i + 6, true), method = u16(b, i + 8, true), nl = u16(b, i + 26, true), xl = u16(b, i + 28, true);
    const cd = central.get(i); const csize = cd ? cd.csize : u32(b, i + 18, true), usize = cd ? cd.usize : u32(b, i + 22, true), crc = cd ? cd.crc : u32(b, i + 14, true);
    const name = b.subarray(i + 30, i + 30 + nl), start = i + 30 + nl + xl;
    let data = b.subarray(start, start + csize), e = { name, method, data, csize, usize, crc };
    const fname = latin1(name);
    let edit = null;
    if (/^docProps\/(core|app)\.xml$/.test(fname)) {
      // Each field goes whole, element and all (every one is optional in the
      // package schema): an emptied <dc:creator></dc:creator> still shows a wipe.
      edit = (xml) => xml.replace(OFFICE_META, (m0, tag, val) => { if (val.trim()) removed.push({ rule: "office-meta", detail: tag }); return ""; }).replace(OFFICE_EMPTY, "").replace(/\n[ \t]*(?=\n)/g, "");
    } else if (fname === "_rels/.rels") {
      edit = (xml) => xml.replace(/<Relationship\b[^>]*Target="\/?docProps\/thumbnail\.[a-z]+"[^>]*\/>/gi, "");
    } else if (/^word\/[^/]+\.xml$/.test(fname)) {
      // Editing-session ids (rsid): Word stamps every paragraph and run with the
      // session that touched it, so they tie copies of a file together, and a
      // template's fixed set with unstamped paragraphs marks a generated file.
      // Optional in the schema; the editor adds fresh ones on the next save.
      edit = (xml) => { const out = xml.replace(RSID_ATTR, "").replace(/<w:rsids>[\s\S]*?<\/w:rsids>/g, ""); if (out !== xml) rsidSeen = true; return out; };
    } else if (/^docProps\/thumbnail\.[a-z]+$/i.test(fname)) {
      removed.push({ rule: "office-meta", detail: "thumbnail image" });
      i = start + csize + ((flags & 8) ? (u32(b, start + csize, true) === 0x08074b50 ? 16 : 12) : 0);
      continue;
    }
    if (edit) {
      const xml = new TextDecoder().decode(method === 8 ? await inflateRaw(data) : data), cleaned = edit(xml);
      if (cleaned !== xml) { const raw = ascii(cleaned); const comp = method === 8 ? await deflateRaw(raw) : raw; e = { name, method, data: comp, csize: comp.length, usize: raw.length, crc: crc32(raw) }; }
    }
    e.fname = fname;
    entries.push(e);
    i = start + csize + ((flags & 8) ? (u32(b, start + csize, true) === 0x08074b50 ? 16 : 12) : 0);
  }
  if (!entries.length) return b;
  if (rsidSeen) removed.push({ rule: "office-meta", detail: "editing-session ids (rsid)" });
  // An EMPTY bibliography store carries a template's fixed item id, the same in
  // every file made from that template. Only an empty one goes: a store holding
  // real sources is the author's content. Its links go with it.
  const dropItems = [];
  for (const e of entries) {
    const m = /^customXml\/item(\d+)\.xml$/.exec(e.fname);
    if (m && EMPTY_BIB.test(new TextDecoder().decode(e.method === 8 ? await inflateRaw(e.data) : e.data))) dropItems.push(m[1]);
  }
  if (dropItems.length) {
    removed.push({ rule: "office-meta", detail: "empty bibliography store (template id)" });
    const gone = new Set(dropItems.flatMap((n) => [`customXml/item${n}.xml`, `customXml/itemProps${n}.xml`, `customXml/_rels/item${n}.xml.rels`]));
    for (let k = entries.length - 1; k >= 0; k--) if (gone.has(entries[k].fname)) entries.splice(k, 1);
    for (let k = 0; k < entries.length; k++) {
      const e = entries[k];
      let edit = null;
      if (/^word\/_rels\/[^/]+\.rels$/.test(e.fname)) edit = (x) => dropItems.reduce((a, n) => a.replace(new RegExp(`<Relationship\\b[^>]*Target="\\.\\./customXml/item${n}\\.xml"[^>]*/>`, "g"), ""), x);
      else if (e.fname === "[Content_Types].xml") edit = (x) => dropItems.reduce((a, n) => a.replace(new RegExp(`<Override\\b[^>]*PartName="/customXml/itemProps${n}\\.xml"[^>]*/>`, "g"), ""), x);
      if (!edit) continue;
      const xml = new TextDecoder().decode(e.method === 8 ? await inflateRaw(e.data) : e.data), cleaned = edit(xml);
      if (cleaned !== xml) { const raw = ascii(cleaned); const comp = e.method === 8 ? await deflateRaw(raw) : raw; entries[k] = { name: e.name, fname: e.fname, method: e.method, data: comp, csize: comp.length, usize: raw.length, crc: crc32(raw) }; }
    }
  }
  const parts = [], cdir = []; let off = 0;
  for (const e of entries) {
    const lh = concat([le32b(0x04034b50), le16b(20), le16b(0), le16b(e.method), le16b(0), le16b(0), le32b(e.crc), le32b(e.csize), le32b(e.usize), le16b(e.name.length), le16b(0), e.name]);
    cdir.push(concat([le32b(0x02014b50), le16b(20), le16b(20), le16b(0), le16b(e.method), le16b(0), le16b(0), le32b(e.crc), le32b(e.csize), le32b(e.usize), le16b(e.name.length), le16b(0), le16b(0), le16b(0), le16b(0), le32b(0), le32b(off), e.name]));
    parts.push(lh, e.data); off += lh.length + e.data.length;
  }
  const cd = concat(cdir);
  return concat([...parts, cd, le32b(0x06054b50), le16b(0), le16b(0), le16b(entries.length), le16b(entries.length), le32b(cd.length), le32b(off), le16b(0)]);
}
function cleanSvg(b, removed) {
  let t = new TextDecoder().decode(b); const before = t;
  t = t.replace(/<metadata\b[\s\S]*?<\/metadata>/gi, () => { removed.push({ rule: "software", detail: "SVG metadata" }); return ""; });
  t = t.replace(/<!--[^>]*?(?:Created with|Generator|Generated by|matplotlib|Inkscape|Illustrator)[\s\S]*?-->/gi, () => { removed.push({ rule: "software", detail: "SVG generator comment" }); return ""; });
  return t === before ? b : ascii(t);
}

async function cleanFile(input, name = "", opts = {}) {
  const st = settingsFrom(opts);
  const want = (kind) => st.file[kind] === "remove";
  opts = { ...opts, credit: st.add.credit || "" };
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  const removed = []; let out = b;
  const head = latin1(b, 0, Math.min(b.length, 16));
  try {
    if (b[0] === 0xFF && b[1] === 0xD8) out = cleanJpeg(b, removed, opts, want);
    else if (head.startsWith(String.fromCharCode(0x89) + "PNG")) out = cleanPng(b, removed, opts, want);
    else if (head.startsWith("RIFF") && latin1(b, 8, 12) === "WEBP") out = cleanWebp(b, removed, want);
    else if (head.startsWith("%PDF")) out = cleanPdf(b, removed, want);
    else if ((u32(b, 0, false) === 0x00010000 || head.startsWith("OTTO") || head.startsWith("true")) && want("font-c2pa")) out = cleanFont(b, removed);
    else if (b[0] === 0x50 && b[1] === 0x4B && b[2] === 3 && b[3] === 4 && want("office-meta")) out = await cleanZip(b, removed);
    else if (/<svg\b|<\?xml/i.test(head + latin1(b, 16, Math.min(b.length, 400))) && want("software")) out = cleanSvg(b, removed);
  } catch (e) { return { bytes: b, removed: [], remaining: await scanFile(b, name), error: String(e && e.message || e) }; }
  if (!removed.length) out = b;
  const remaining = (await scanFile(out, name)).filter((f) => (st.file[f.rule] || "keep") !== "off");
  return { bytes: out, removed, remaining };
}

// ---------------------------------------------------------------- runNoMarks
// The one entry point the gateway uses, for the owner's tool and the customer
// route alike. Validates the settings and the input, caps sizes, and returns a
// report. A cleaned file comes back as sha256 + size; the bytes themselves only
// when return_file is true and the result is small (tool results have a size
// limit, and a whole site belongs in a script, not a chat).
const NM_LIMITS = Object.freeze({ text: 2_000_000, file: 10_000_000, returnFile: 1_000_000, findings: 500 });
const b64decode = (s) => {
  if (typeof s !== "string" || !/^[A-Za-z0-9+/=\s]*$/.test(s)) return null;
  try { const bin = atob(s.replace(/\s+/g, "")); const o = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i); return o; } catch { return null; }
};
const b64encode = (b) => { let s = ""; for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode.apply(null, b.subarray(i, i + 32768)); return btoa(s); };
const hexOf = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
const capList = (list) => ({ count: list.length, items: list.slice(0, NM_LIMITS.findings) });

async function runNoMarks(args = {}, settingsInput = {}) {
  const rs = resolveSettings(settingsInput || {});
  if (!rs.ok) return { ok: false, error: "invalid settings", errors: rs.errors };
  const st = rs.settings, action = args.action;
  if (action === "scan_text" || action === "clean_text") {
    if (typeof args.text !== "string") return { ok: false, error: "text is required" };
    if (args.text.length > NM_LIMITS.text) return { ok: false, error: `text is over the ${NM_LIMITS.text} character limit; send it in parts` };
    if (action === "scan_text") return { ok: true, findings: capList(scanText(args.text, scanOptsFrom(st)).filter((f) => st.text[f.rule] !== "off")) };
    const r = cleanText(args.text, { settings: st });
    return { ok: true, text: r.text, changed: r.text !== args.text, fixed: r.fixed, remaining: capList(r.remaining) };
  }
  if (action === "scan_file" || action === "clean_file") {
    const bytes = b64decode(args.file_base64);
    if (!bytes) return { ok: false, error: "file_base64 is required and must be valid base64" };
    if (bytes.length > NM_LIMITS.file) return { ok: false, error: `file is over the ${NM_LIMITS.file} byte limit` };
    const name = typeof args.name === "string" ? args.name.slice(0, 200) : "";
    if (action === "scan_file") return { ok: true, findings: capList((await scanFile(bytes, name)).filter((f) => (st.file[f.rule] || "keep") !== "off")) };
    const r = await cleanFile(bytes, name, { settings: st });
    const out = { ok: true, changed: r.removed.length > 0, removed: r.removed, remaining: capList(r.remaining), size: r.bytes.length, sha256: hexOf(await crypto.subtle.digest("SHA-256", r.bytes)) };
    if (r.error) out.note = "file could not be parsed; returned unchanged";
    if (args.return_file === true) { if (r.bytes.length <= NM_LIMITS.returnFile) out.file_base64 = b64encode(r.bytes); else out.note = `cleaned file is over ${NM_LIMITS.returnFile} bytes; not returned inline`; }
    return out;
  }
  const plugged = ACTIONS.get(action);
  if (plugged) return plugged(args, st, { scanText, scanOptsFrom, capList, NM_LIMITS });
  return { ok: false, error: "action must be one of " + ["scan_text", "clean_text", "scan_file", "clean_file", ...ACTIONS.keys()].join(", ") };
}

// ---------------------------------------------------------------- public API
// scanText(text, { denylist?, internalHosts?, internalPaths?, typography?, styleWords? }) -> findings,
// sorted by position. Each finding: { rule, index, line, col, codepoint?, detail? }.
function scanText(text, opts = {}) {
  const s = String(text ?? "");
  const at = locator(s);
  const out = [];
  const add = (rule, index, extra = {}) => out.push({ rule, index, ...at(index), ...extra });
  scanChars(s, add);
  scanLines(s, add, opts || {});
  scanPatterns(s, add, opts || {});
  scanVisible(s, add, opts || {});
  return out.sort((a, b) => a.index - b.index || a.rule.localeCompare(b.rule));
}

// scanCommit({ message, authorName, authorEmail }, opts) -> findings for the
// message plus a tool-author finding when the author names an AI tool.
// "Syndakat" with an empty email is the owner's ruling (3048) and passes.
function scanCommit(c = {}, opts = {}) {
  const out = scanText(c.message || "", opts).map((f) => ({ ...f, where: "message" }));
  // Checklist D: the author AND the committer.
  for (const who of ["author", "committer"]) {
    const name = String(c[who + "Name"] || ""), email = String(c[who + "Email"] || "");
    if (TOOL_AUTHOR_NAME.test(name) || (email && TOOL_EMAIL.test(email))) out.push({ rule: "tool-author", where: who, detail: `${name} <${email}>` });
  }
  return out;
}
return { scanText, cleanText, runNoMarks, resolveSettings, mergeSettings, DEFAULT_SETTINGS, NM_LIMITS };
})();
// >>> NO-MARKS-LOCAL END <<<

function mergeNoMarksSettings(a = {}, b = {}) {
  const A = a && typeof a === "object" ? a : {}, B = b && typeof b === "object" ? b : {};
  const out = { ...A, ...B };
  for (const k of ["text", "file", "add"]) if (A[k] || B[k]) out[k] = { ...(A[k] || {}), ...(B[k] || {}) };
  return out;
}
// The one call to the no-marks service (checkAccess above calls /licence/verify,
// a different route with a different contract).
async function callNoMarks(env, token, body) {
  if (!token || !env.GATEWAY_URL) return { ok: false, error: "No-marks needs a Max Herder licence on this install." };
  try {
    const r = await fetch(env.GATEWAY_URL + "/no-marks", { method: "POST", headers: { "content-type": "application/json", "x-licence": token }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => null);
    return j && typeof j === "object" ? j : { ok: false, error: "No-marks service answered " + r.status };
  } catch (e) {
    return { ok: false, error: "No-marks service unreachable: " + String(e && e.message || e) };
  }
}


// THE SPLIT (2026-10-24, owner decision 3512 for pending 3463). The commodity checks (hidden characters,
// spaces, dashes and quotes, attribution lines, leaks, file metadata) run HERE, in your own account, on
// the core copied in above, so your text and files stay with you. Two things still use the service:
//   1. the licence and plan check, which carries no text (authorise_only);
//   2. the checks that use Bouios's own word lists (AI leftovers, style words), sent the text only when
//      you have left one of them on, and the editor (edit_brief, edit_check), which is the service's.
// Locked by worker/test/no-marks-forward.test.mjs.
const NM_WORDLIST_RULES = ["ai-artefact", "style-word"];
async function runNoMarksSplit(env, token, args, settings) {
  const action = args && args.action;
  const clean = { ...args, project: undefined };
  if (action === "edit_brief" || action === "edit_check") return callNoMarks(env, token, { ...clean, settings });
  if (!["scan_text", "clean_text", "scan_file", "clean_file"].includes(action)) return { ok: false, error: "action must be one of scan_text, clean_text, scan_file, clean_file, edit_brief, edit_check" };
  const rs = NM.resolveSettings(settings || {});
  if (!rs.ok) return { ok: false, error: "invalid settings", errors: rs.errors };
  const gate = await callNoMarks(env, token, { action, authorise_only: true });
  if (!gate.ok) return { ok: false, ...gate };
  const out = await NM.runNoMarks(clean, settings || {});
  if (!out.ok) return out;
  const text = action === "scan_text" || action === "clean_text";
  if (text && typeof args.text === "string" && NM_WORDLIST_RULES.some((r) => rs.settings.text[r] !== "off")) {
    const onlyWordlists = { text: Object.fromEntries(Object.keys(rs.settings.text).map((k) => [k, NM_WORDLIST_RULES.includes(k) ? rs.settings.text[k] : "off"])) };
    const remote = await callNoMarks(env, token, { action: "scan_text", text: args.text, settings: onlyWordlists });
    if (remote.ok && remote.findings && Array.isArray(remote.findings.items)) {
      const into = action === "scan_text" ? out.findings : out.remaining;
      into.items = [...into.items, ...remote.findings.items].sort((a, b) => a.index - b.index);
      into.count = into.items.length;
    } else {
      out.service_checks = "not run: " + ((remote && remote.error) || "the service did not answer") + ". The checks that run in your account are complete.";
    }
  }
  return out;
}

// MCP transport size ceiling - MIRROR of memory-gateway/src/index.js, added to
// this customer worker 2026-09-16. Until today it had NO ceiling at all: the
// bouios_load result went out at whatever size sessionLoad() produced, so a
// customer whose log and lessons had grown hit exactly the failure the owner
// hit on the gateway - the client rejects the whole tool result, the model
// never sees the load, and the load gate reads it as never loaded, leaving the
// session unable to write. Keep this function byte-equivalent to the gateway's.
//
// MCP transport size ceiling. sessionStart() output was measured at ~127KB for
// a real account (max tier, 46 memory rows, 6 full skill bodies) - proven
// 2026-07-02 to repeatedly trip the client's "exceeds maximum allowed tokens"
// error inside a live session. An oversized single-line tool result is a
// plausible cause of the chronic MCP disconnect/reconnect cycling (mem440/
// 469/609/642/etc) that survived the earlier 403/licence fix (c7833b9) -
// that fix addressed one confirmed 403 cause; this addresses a second,
// independent, now-measured cause. Shrinks in order of least information
// loss: skill bodies (re-derivable, rarely change) first, then memory row
// bodies (kept as a preview + id so nothing is silently lost - full body
// remains fetchable by asking for that memory id). Pending rows and hot
// state are NEVER touched - those are exactly what bouios_handoff and the
// checkpoint protocol depend on being complete every time.

// A LOG LINE IS ONE LINE, AND NOTHING EVER ENFORCED THAT (2026-09-16).
// Measured in the store: 3 September, 67 rows totalling 44,857 characters; 16
// September, 34 rows totalling 36,411; individual rows up to 3,995. Sessions -
// mine among them - write paragraphs into a field the load returns in full,
// twenty-five at a time, and that is what pushed the payload past the transport
// ceiling and started getting whole loads rejected.
//
// IT SURFACED ONLY NOW, and not as a regression: row 1518/1643 filtered the junk
// rows out of the window ("Session loaded", "transcript PUT", hot-archive
// echoes - eighteen of twenty-five on a real load, ~40 characters each). That
// fix is right and stays. It also replaced eighteen short rows with eighteen
// long real ones, roughly tripling the field, which is what made the missing cap
// start to hurt.
//
// Detail belongs in a memory row, which is retrievable by id; the log is the
// index of what was agreed and done. Clipping is visible, never silent: the
// stored line says so, and sessionWrite reports it back to the writer.
// CONTEXT: the same titles-and-ids discipline memory has had since 523933a.
//
// WHY NOW. After the log was capped (60726f4) context became the largest block
// in the payload - measured on a live load 2026-09-16, 34,806 of 58,924
// characters against a 60,000 ceiling, about a thousand characters of headroom.
// The size guard's last step would then have started cutting context again, and
// cutting the owner's context is the exact thing he objected to. Better that the
// load never carries the bulk in the first place than that a guard chops it.
//
// WHAT IS NEVER EXCERPTED, and this is the whole safety of it: anything that
// BINDS BEHAVIOUR. profile-preferences and layer2-instructions-for-claude are
// the instruction layer on surfaces where no hook can run - excerpting those
// would silently drop enforcement text, which is worse than any payload size.
// The one exception: a row that opens SUPERSEDED binds nothing and is excerpted
// like any reference row (2026-10-06, see contextWindow below). Small rows are not worth excerpting either, and a row that matches the topic
// the session actually named comes back whole, exactly like `relevant`.
//
// Nothing is lost: every key, its date and its length are always listed, and
// the full content is one bouios_get({project, keys:[...]}) away.
const CONTEXT_ALWAYS_FULL = /(instruction|preference|owner-behaviour|enforcement-config|gateway-url|gateway-config)/i;
// A row that declares itself superseded is not behaviour any more (2026-10-06,
// live AI load on the gateway, parity): profile-preferences (6755 characters)
// opens "SUPERSEDED 2026-06-15" yet its key matched the pattern above. So
// contextWindow and the size guard also test /^\s*\[?SUPERSEDED\b/i on the
// content, inline (the tests extract these functions one by one), and such a
// row falls through to the ordinary excerpt rule.
// A handoff is read whole (parity with the gateway, 2026-09-25).
const CONTEXT_FULL_UNDER = 1200;
const CONTEXT_EXCERPT = 300;
const CONTEXT_RELEVANT_MAX = 3;
function contextWindow(rows, topic) {
  const terms = relevanceTerms(topic || "");
  let promoted = 0;
  return (rows || []).map((c) => {
    if (!c || typeof c.content !== "string") return c;
    if (CONTEXT_ALWAYS_FULL.test(c.key || "") && !/^\s*\[?SUPERSEDED\b/i.test(c.content)) return c;
    if (/handoff/i.test(c.key || "")) return c;
    if (c.content.length <= CONTEXT_FULL_UNDER) return c;
    // MATCHED ON THE KEY, NOT THE BODY, and capped - measured live 2026-09-16,
    // minutes after the first version shipped. Loading with the topic "verify
    // context window live after 56327d1" returned all seventeen rows in FULL,
    // 34,806 characters, because the term "context" appears in almost every
    // body. So a topic that names the thing you are working on switched the
    // whole window off, silently, exactly when the payload was largest. A body
    // match is far too broad to be an escape hatch; the key is what identifies
    // a row, and CONTEXT_RELEVANT_MAX stops even a lucky key match from
    // promoting the entire store.
    const hay = (c.key || "").toLowerCase();
    if (terms.length && promoted < CONTEXT_RELEVANT_MAX && terms.some((t) => hay.includes(t))) { promoted++; return c; }
    return {
      ...c,
      content: c.content.slice(0, CONTEXT_EXCERPT) + "...",
      chars: c.content.length,
      excerpt_only: true,
    };
  });
}

const LOG_LINE_MAX = 400;
function clipLogLine(s) {
  if (typeof s !== "string" || s.length <= LOG_LINE_MAX) return { text: s, clipped: false };
  return {
    text: s.slice(0, LOG_LINE_MAX) + "...(clipped - a log line is one line; put the detail in a memory row)",
    clipped: true,
  };
}

// MEMORY USE IS MEASURED (rebuild A3, 2026-10-06) - same as the gateway's
// logFetch, same row shape, so one counter reads both. Each bouios_get writes
// one FETCH row: ids and counts only, never a title, body or content. A lost
// write never costs the caller the rows. memory-use-logging.test.mjs.
function measureIds(ids) {
  const shown = ids.slice(0, 40).join(",");
  return ids.length > 40 ? shown + " +" + (ids.length - 40) + " more" : shown;
}
async function logFetch(db, domain, sessionId, args, ids, keyCount, found) {
  try {
    let surface = typeof args.surface === "string" && /^[A-Za-z0-9_.-]{1,20}$/.test(args.surface) ? args.surface : "";
    if (!surface && sessionId) {
      const ld = await db.prepare("SELECT summary FROM log WHERE domain = ? AND summary LIKE 'Session loaded%' AND summary LIKE ? ORDER BY id DESC LIMIT 1")
        .bind(domain, "%session=" + sessionId + "%").first();
      const m = ld && /surface=([A-Za-z0-9_.-]+)/.exec(ld.summary);
      if (m) surface = m[1].replace(/\.$/, "");
    }
    const line = "FETCH " + domain + " ids=" + measureIds(ids) + " found=" + found + " keys=" + keyCount +
      " surface=" + (surface || "undeclared") + (sessionId ? " mcp-session=" + sessionId : "");
    await db.prepare("INSERT INTO log (ts, domain, summary) VALUES (datetime('now'), ?, ?)").bind(domain, line.slice(0, LOG_LINE_MAX)).run();
  } catch (_) { /* a lost measurement must never cost the caller the rows */ }
}

const MCP_LOAD_SIZE_CEILING = 60000;
function clampMcpLoadSize(out) {
  let size = JSON.stringify(out).length;
  if (size <= MCP_LOAD_SIZE_CEILING) return out;
  if (out.skills && Array.isArray(out.skills.skills)) {
    out.skills.skills = out.skills.skills.map((s) => ({ name: s.name, est_tokens: s.est_tokens, bodyOmitted: true }));
    out.skills.note = "Skill bodies omitted this load (response size guard). Names unchanged from your prior load in this session; ask if a body is needed.";
  }
  size = JSON.stringify(out).length;
  if (size <= MCP_LOAD_SIZE_CEILING) return out;
  if (Array.isArray(out.memory)) {
    out.memory = out.memory.map((m) => {
      if (m.type === "pending" || !m.body || m.body.length <= 300) return m;
      return { ...m, body: m.body.slice(0, 300) + "...(truncated, size guard - ask for memory id " + m.id + " if the rest is needed)", truncated: true };
    });
  }
  size = JSON.stringify(out).length;
  if (size <= MCP_LOAD_SIZE_CEILING) return out;
  if (Array.isArray(out.context)) {
    out.context = out.context.map((c) => {
      // Never cut a row that binds behaviour (2026-10-06, live AI load, parity
      // with the gateway: layer2-instructions-for-claude, 4085 characters, was
      // cut to 221 here after contextWindow had kept it whole). A superseded row
      // is not protected: contextWindow has already excerpted it.
      if (!c.content || c.content.length <= 300 || /handoff/i.test(c.key || "") || (CONTEXT_ALWAYS_FULL.test(c.key || "") && !/^\s*\[?SUPERSEDED\b/i.test(c.content))) return c;
      return { ...c, content: c.content.slice(0, 300) + "...(truncated, size guard - ask for context key " + c.key + " if the rest is needed)", truncated: true };
    });
  }

  // EXTENDED 2026-09-16, because this guard had been outgrown rather than
  // broken. It was written on 2026-07-02 against a 127KB payload made of
  // skills, memory and context, and it still trims exactly those three. Every
  // field added since is invisible to it: log, lessons (2026-09-05), relevant
  // (2026-09-09), recent_transcripts, hot_archives. Measured on a real load
  // from this account today - 62,037 bytes, of which log 24%, rules 19%,
  // lessons 16%, context 11% - so the three fields it knows are a minority of
  // the payload and it cannot get under the ceiling no matter how hard it trims.
  //
  // That is the regression the owner reported: loads went 50.0 -> 61.1KB
  // delivered, then 64.0 -> 77.0KB REJECTED whole by the harness, which reads
  // to the model AND to the load gate as a failed load, leaving the session
  // read-only. The growth was the session's own checkpoints - each save writes a
  // log row and the next load returns it - so diligent saving is what bricks it.
  //
  // Steps are ordered by what is least costly to lose and stop the moment it
  // fits. hot, pending and the confirmation line are never touched, here or
  // above.
  const _clip = (s, n) => (typeof s === "string" && s.length > n ? s.slice(0, n) + "...(truncated, size guard)" : s);
  const _fits = () => JSON.stringify(out).length <= MCP_LOAD_SIZE_CEILING;
  // A ROW THAT HOLDS THE OWNER'S OWN WORDS IS NEVER CUT (2026-10-08, owner: "stop
  // changing what i say"). Rule 2673 arrived as a 150-character stub, a session
  // read its title as the owner's ban, and told him he had a rule he never made.
  // The search already caps a body (lessons 700, relevant 400); this keeps the
  // guard from cutting it again. The generic halving loop below is the backstop
  // if such rows alone exceed the ceiling.
  const _own = (r) => !!r && (/OWNER-SAID/.test(String(r.body || "").slice(0, 300)) || /^(OWNER|RULE-|STANDING)/i.test(String(r.title || "")));
  // A ROW IS NEVER SENT AS PARTIAL TEXT (owner 2026-10-08: "why is it truncating
  // rows - that's not ok"). A cut body reads as complete and carries no way back:
  // the old marker named no id, so a session could not even ask for the rest.
  // Over the ceiling a row keeps its id, type and title and its body becomes a
  // pointer to bouios_get, the same titles-and-ids discipline as the memory list.
  const _ptr = (r) => { if (r && typeof r.body === "string" && r.body.length) { r.body_omitted = true; r.body = r.id != null ? "(body not sent, size guard: bouios_get ids [" + r.id + "] returns it whole)" : "(body not sent, size guard)"; } };
  const _steps = [
    () => { delete out.recent_transcripts; },
    () => { (out.log || []).forEach((r) => { if (r && r.summary) r.summary = _clip(r.summary, 400); }); },
    // The top 3 matches stay readable until late (parity with the gateway, 2026-09-30).
    () => { (out.relevant || []).forEach((r, i) => { if (i >= 3 && !_own(r)) _ptr(r); }); },
    // A LESSON MATCHED BY THE TOPIC STAYS READABLE (2026-10-06), same as the
    // top 3 relevant rows: the first 3 marked `matched` are skipped here and at
    // the 150 step, and cut only with the relevant top 3 below. Measured live:
    // the matched answer (row 99) arrived as 176 characters, without the half
    // naming the symptom, and 3 of 3 runs answered wrong. retrieval-authority LES7.
    () => { let k = 0; (out.lessons || []).forEach((r) => { if (r && r.matched && k++ < 3) return; if (_own(r)) return; _ptr(r); }); },
    () => { delete out.hot_archives; delete out.hot_archives_note; },
    () => { if (Array.isArray(out.log)) out.log = out.log.slice(0, 10); },
    () => { if (Array.isArray(out.memory)) out.memory = out.memory.slice(0, 20); },
    // Handoffs are read whole, so everything else pays first (parity with the
    // gateway, 2026-09-25).
    () => {
      (out.context || []).forEach((c) => {
        if (c && c.truncated && typeof c.content === "string" && c.content.length > 200) c.content = c.content.slice(0, 120) + "...(truncated, size guard - ask for context key " + c.key + " if the rest is needed)";
      });
    },
    () => { let k = 0; (out.lessons || []).forEach((r) => { if (r && r.matched && k++ < 3) return; if (_own(r)) return; _ptr(r); }); },
    () => { if (Array.isArray(out.memory)) out.memory = out.memory.slice(0, 12); },
    // Only then is the handoff clipped, to a visible pointer, before the last resort.
    () => {
      (out.context || []).forEach((c) => {
        if (c && /handoff/i.test(c.key || "") && typeof c.content === "string" && c.content.length > 1500) {
          c.content = c.content.slice(0, 1500) + "...(truncated, size guard - bouios_get({keys:[\"" + c.key + "\"]}) for the rest)";
          c.truncated = true;
        }
      });
    },
    // THE ANSWERS ARE CUT LAST (2026-10-06). Measured on the live store after
    // 6141f58: this step ran before the memory, related and handoff steps, so
    // the top 3 relevant rows and the matched lessons arrived as 176-character
    // stubs while the finished load sat 3.7KB under the ceiling. They are what
    // the session asked for; everything above pays first.
    () => { (out.relevant || []).forEach((r) => { _ptr(r); }); (out.lessons || []).forEach((r) => { _ptr(r); }); },
  ];
  for (const step of _steps) {
    if (_fits()) return out;
    step();
  }

  // AND A LAST RESORT THAT DOES NOT KNOW FIELD NAMES AT ALL, which is the whole
  // lesson of this regression: a guard that lists the fields it knows goes quietly
  // out of date the next time the payload gains one, and the failure it then
  // allows is a session that cannot write. Halve the largest remaining
  // non-protected field until it fits. The protected set is never eligible, so a
  // payload whose core alone exceeds the ceiling still goes out whole rather than
  // gutted - an oversized load is bad, a load missing its pending rows is worse.
  const _PROTECTED = new Set([
    "confirmation", "current_task", "current_task_note", "domain", "read_order", "pending", "pending_suspect",
    "open_items", "hot", "hot_updated", "load_token", "load_token_note",
  ]);
  let _guard = 0;
  while (!_fits() && _guard++ < 40) {
    let big = null, bigSize = 0;
    for (const k of Object.keys(out)) {
      if (_PROTECTED.has(k)) continue;
      const n = JSON.stringify(out[k] === undefined ? null : out[k]).length;
      if (n > bigSize) { big = k; bigSize = n; }
    }
    if (!big || bigSize < 200) break;
    const v = out[big];
    if (Array.isArray(v)) out[big] = v.slice(0, Math.max(1, Math.floor(v.length / 2)));
    else if (typeof v === "string") out[big] = v.slice(0, Math.max(200, Math.floor(v.length / 2))) + "...(truncated, size guard)";
    else delete out[big];
  }
  return out;
}

function rpcResult(id, result) { return { jsonrpc: "2.0", id, result }; }
function rpcError(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }
// bouios_transcripts on the customer's own storage (2026-10-27, BOUIOS 4053). The gateway's transcriptTool,
// adapted to this worker's object names (<session>.jsonl, untagged or tagged with customMetadata.project)
// and to the plan's history window, which this worker already applies to GET /transcript.
async function transcriptTool(env, domain, args, request, url) {
  const action = args && args.action;
  const clampN = (v, dflt, max) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? Math.min(n, max) : dflt; };
  const days = await historyWindowDaysCached(request, url, env);
  const sinceMs = days === null || days === undefined ? null : Date.now() - days * 86400000;
  if (action === "search") {
    const q = String(args.q || "").slice(0, 500);
    const terms = relevanceTerms(q);
    if (!terms.length) return { ok: false, error: "q needs at least one content word" };
    await ensureSchema(env.DB);
    const score = terms.map(() => "(CASE WHEN lower(excerpt) LIKE ? THEN 1 ELSE 0 END)").join(" + ");
    const like = terms.map((t) => "%" + t + "%");
    const since = sinceMs === null ? null : new Date(sinceMs).toISOString();
    const rows = await env.DB.prepare(
      "SELECT session_id, turn_index, ts, excerpt, (" + score + ") AS score FROM transcript_excerpts WHERE (domain = ? OR domain = '')" +
      (since ? " AND ts >= ?" : "") + " AND (" + score + ") > 0 ORDER BY score DESC, id DESC LIMIT ?"
    ).bind(...like, domain, ...(since ? [since] : []), ...like, clampN(args.limit, 5, 20)).all();
    return { ok: true, project: domain, q, history_days: days, matches: (rows.results || []).map((r) => ({ session_id: r.session_id, line: r.turn_index, ts: r.ts, excerpt: r.excerpt })), note: "What you typed only. To read a whole stretch of one chat use read with session_id and q." };
  }
  if (!env.TRANSCRIPTS) return { ok: false, error: "transcript storage is not set up on this install" };
  const inWindow = (o) => sinceMs === null || (o.uploaded && new Date(o.uploaded).getTime() >= sinceMs);
  if (action === "list") {
    const objects = [];
    let cursor;
    do {
      const page = await env.TRANSCRIPTS.list({ cursor, limit: 1000, include: ["customMetadata"] });
      for (const o of page.objects || []) {
        if (String(o.key).startsWith("chat/") || !inWindow(o)) continue;
        const project = (o.customMetadata && o.customMetadata.project) || null;
        if (project && project !== domain) continue;
        objects.push({ session_id: transcriptSessionId(o.key), size: o.size, uploaded: o.uploaded, project });
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    objects.sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded));
    return { ok: true, project: domain, history_days: days, transcripts: objects.slice(0, clampN(args.limit, 5, 20)) };
  }
  if (action === "read") {
    const sid = transcriptSessionId(String(args.session_id || ""));
    if (!TRANSCRIPT_ID.test(sid)) return { ok: false, error: "session_id is not a stored transcript name" };
    const terms = relevanceTerms(String(args.q || "").slice(0, 500));
    if (!terms.length) return { ok: false, error: "q needs at least one content word" };
    let obj = null;
    for (const key of [sid + ".jsonl", sid, sid + ".jsonl.gz"]) {
      obj = await env.TRANSCRIPTS.get(key);
      if (obj) { obj.__key = key; break; }
    }
    if (!obj || !obj.body) return { ok: false, error: "no stored transcript with that id" };
    if (!inWindow(obj)) return { ok: false, error: "this transcript is older than your plan's history period; it is still in your storage" };
    const tag = obj.customMetadata && obj.customMetadata.project;
    if (tag && tag !== domain) return { ok: false, error: "that transcript belongs to another project" };
    let src = obj.body;
    if (/\.gz$/.test(obj.__key)) {
      if (typeof DecompressionStream === "undefined") return { ok: false, error: "gzip not supported here" };
      src = src.pipeThrough(new DecompressionStream("gzip"));
    }
    const budget = clampN(args.max_chars, 6000, 20000);
    const hits = [];
    let used = 0, lineNo = 0, scanned = 0, carry = "", dropping = false, full = false;
    const check = (line) => {
      lineNo++;
      if (!line) return;
      scanned++;
      const low = line.toLowerCase();
      if (!terms.some((t) => low.includes(t))) return;
      const clip = line.length > 900 ? line.slice(0, 900) + "..." : line;
      if (used + clip.length > budget) { full = true; return; }
      used += clip.length;
      hits.push({ line: lineNo - 1, text: clip });
    };
    const reader = src.pipeThrough(new TextDecoderStream()).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const parts = value.split("\n");
      for (let k = 0; k < parts.length; k++) {
        if (!dropping) { carry += parts[k]; if (carry.length > TRANSCRIPT_LINE_MAX_CHARS) { carry = ""; dropping = true; } }
        if (k < parts.length - 1) { if (!dropping) check(carry); else lineNo++; carry = ""; dropping = false; }
      }
      if (full) { try { await reader.cancel(); } catch (_) {} break; }
    }
    if (!full && !dropping) check(carry);
    return { ok: true, project: domain, session_id: sid, lines_scanned: scanned, matches: hits, ...(full ? { truncated: true, note: "max_chars reached: narrow q or raise max_chars" } : {}), ...(tag ? {} : { untagged: true }) };
  }
  return { ok: false, error: "action must be search, list or read" };
}

function toolText(id, text, isError) {
  const result = { content: [{ type: "text", text }] };
  if (isError) result.isError = true;
  return rpcResult(id, result);
}

// SKILLS IN YOUR OWN STORE. How many skills a plan loads is a number the gateway
// returns with the licence check (skills_cap); this file holds no plan logic and
// only obeys it, like historyWindowDays above. With no licence set, or when the
// gateway cannot be reached or answers nonsense, no skills field is added and the
// load is byte-for-byte what it was. Only skill rows already in THIS account's
// own database are read; nothing is fetched or sent anywhere.
const SKILL_TOKEN_BUDGET = 8000;
async function skillsCapFor(request, url, env) {
  const token = accessTokenFromRequest(request, url, env);
  if (!token || !env.GATEWAY_URL) return null;
  try {
    const r = await fetch(env.GATEWAY_URL + "/licence/verify?licence=" + encodeURIComponent(token), { headers: { "x-licence": token } });
    if (!r.ok) return null;
    const v = await r.json();
    if (v && v.skills_cap === "unlimited") return Infinity;
    return v && Number.isInteger(v.skills_cap) && v.skills_cap > 0 ? v.skills_cap : null;
  } catch {
    return null;
  }
}
// The default skills are the service's content, not stored here: they come from
// the gateway behind the licence, count toward the cap, and any failure just
// means this account's own skills load alone.
async function defaultSkills(request, url, env) {
  const token = accessTokenFromRequest(request, url, env);
  if (!token || !env.GATEWAY_URL) return [];
  try {
    const r = await fetch(env.GATEWAY_URL + "/skills", { headers: { "x-licence": token } });
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j.skills) ? j.skills.filter((s) => s && typeof s.name === "string" && typeof s.body === "string") : [];
  } catch {
    return [];
  }
}
async function ownSkills(db, domain, cap, defaults = []) {
  const rows = await db.prepare("SELECT title, body FROM memory WHERE type = 'pattern' AND title LIKE 'skill-%' AND (domain = ? OR domain = 'GLOBAL') ORDER BY id").bind(domain).all();
  const skills = [];
  let tokens = 0;
  const have = new Set();
  for (const d of defaults) {
    if (skills.length >= cap || have.has(d.name)) continue;
    const est = Math.ceil(d.body.length / 4);
    if (tokens + est > SKILL_TOKEN_BUDGET && skills.length > 0) break;
    skills.push({ name: d.name, est_tokens: est, body: d.body });
    have.add(d.name);
    tokens += est;
  }
  for (const r of rows.results || []) {
    if (skills.length >= cap) break;
    if (have.has(String(r.title).slice(6))) continue;
    const est = Math.ceil(String(r.body || "").length / 4);
    if (tokens + est > SKILL_TOKEN_BUDGET && skills.length > 0) break;
    skills.push({ name: String(r.title).slice(6), est_tokens: est, body: r.body });
    tokens += est;
  }
  return { cap: cap === Infinity ? "unlimited" : cap, token_budget: SKILL_TOKEN_BUDGET, est_tokens: tokens, count: skills.length, skills };
}

async function handleMsg(msg, sessionId, env, request, url) {
  const id = msg && msg.id !== undefined ? msg.id : null;
  const method = msg && msg.method;
  if (!method) return rpcError(id, -32600, "invalid request");
  if (method === "initialize") {
    return rpcResult(id, {
      protocolVersion: MCP_PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: "memory", version: "2.0.0" },
      instructions: await instructionsFor(env, accessTokenFromRequest(request, url, env)),
    });
  }
  if (method === "ping") return rpcResult(id, {});
  if (method === "tools/list") return rpcResult(id, { tools: MCP_TOOLS });
  if (method === "tools/call") {
    const name = msg.params && msg.params.name;
    const args = (msg.params && msg.params.arguments) || {};
    const domain = normaliseProject(args.project || args.domain);
    if (!domain) return toolText(id, "Invalid project name. Use 2-20 chars, start with a letter.", true);
    // AUTO-LOAD (A2, 2026-10-06) - mirrors memory-gateway/src/index.js. A
    // Bouios tool called in a session that has not loaded this project loads
    // first and says so; a loaded session, or one carrying a valid load_token,
    // is unchanged; a failed load leaves today's refusals in place. The
    // try-block below is the unchanged dispatch, wrapped (not re-indented).
    let autoLoaded = null;
    if (AUTO_LOAD_TOOLS.has(name)
        && !(await loadedThisSession(env.DB, domain, sessionId))
        && !(await verifyLoadToken(env, domain, args.load_token))) {
      try { autoLoaded = clampMcpLoadSize(await mcpLoad(domain, { surface: args.surface }, sessionId, env, request, url)); } catch (_) { autoLoaded = null; }
    }
    const res = await (async () => {
    try {
      if (name === "bouios_load") {
        return toolText(id, JSON.stringify(clampMcpLoadSize(await mcpLoad(domain, args, sessionId, env, request, url))));
      }
      if (name === "bouios_save") {
        // Bearer auth (the /mcp/{token} gate this call already passed) proves
        // identity, not that memory was loaded - it is not a substitute for this
        // check (2026-07-19 fix, mirrors the gateway). sessionWrite archives hot
        // before overwrite, covering "load before you clobber" independently.
        // Additive second chance, same as the gateway: consulted only after the
        // existing check has refused, so no accepted save changes behaviour.
        if (!(await domainLoadedRecently(env.DB, domain))
            && !(await verifyLoadToken(env, domain, args.load_token))) {
          await logRefusal(env, domain, "bouios_save: memory not loaded for this project recently (no load record and no valid load_token)");
          return toolText(id, "Write refused: memory has not been loaded for this project recently. Call bouios_load for the project first, then retry - passing back the load_token it returns.", true);
        }
        const access = await checkAccess(env.DB, domain, request, url, env);
        if (!access.ok) { await logRefusal(env, domain, "bouios_save: " + (access.note || "access check refused")); return toolText(id, access.note || 'Write refused.', true); }
        return toolText(id, JSON.stringify(await sessionWrite(domain, args, env.DB, env.DISPLAY_TZ)));
      }
      if (name === "bouios_handoff") {
        // Same domain-keyed check as bouios_save (2026-07-19 fix, mirrors the gateway).
        if (!(await domainLoadedRecently(env.DB, domain))
            && !(await verifyLoadToken(env, domain, args.load_token))) {
          await logRefusal(env, domain, "bouios_handoff: memory not loaded for this project recently (no load record and no valid load_token)");
          return toolText(id, "Handoff refused: memory has not been loaded for this project recently. Call bouios_load for the project first, then retry - passing back the load_token it returns.", true);
        }
        const access = await checkAccess(env.DB, domain, request, url, env);
        if (!access.ok) { await logRefusal(env, domain, "bouios_handoff: " + (access.note || "access check refused")); return toolText(id, access.note || 'Handoff refused.', true); }
        const saved = [];
        if (typeof args.hot === "string" && args.hot.length) {
          const out = await sessionWrite(domain, { hot: args.hot, surface: args.surface, log: ["Session handoff."] }, env.DB, env.DISPLAY_TZ);
          saved.push(...out.applied);
        }
        const next = typeof args.next_step === "string" && args.next_step.length ? args.next_step : "resume open tasks";
        const block = "load memory\nProject: " + domain + ". Continue previous session. First action: " + next;
        return toolText(id, JSON.stringify({ saved, handoff_block: block, instruction: "Show handoff_block to the user in a code box." }));
      }
      if (name === "bouios_transcripts") {
        const out = await transcriptTool(env, domain, args, request, url);
        return toolText(id, JSON.stringify(out), out.ok === false);
      }
      if (name === "bouios_no_marks") {
        const token = accessTokenFromRequest(request, url, env);
        const row = await env.DB.prepare("SELECT content FROM context WHERE domain = ? AND key = 'no-marks:settings'").bind(domain).first();
        let stored = {};
        try { stored = row && row.content ? JSON.parse(row.content) : {}; } catch { stored = {}; }
        if (args.action === "get_settings") return toolText(id, JSON.stringify({ ok: true, project: domain, settings: stored, note: "Anything not listed uses the default." }));
        if (args.action === "set_settings") {
          const next = mergeNoMarksSettings(stored, args.settings || {});
          // Settings are checked here, in your own account (the same rules the service uses); a refused set is not saved.
          const check = NM.resolveSettings(next);
          if (!check.ok) return toolText(id, JSON.stringify({ ok: false, project: domain, error: "invalid settings", errors: check.errors }), true);
          await env.DB.prepare("INSERT OR REPLACE INTO context (domain, key, content, updated_at) VALUES (?, 'no-marks:settings', ?, ?)")
            .bind(domain, JSON.stringify(next), new Date().toISOString()).run();
          return toolText(id, JSON.stringify({ ok: true, project: domain, settings: next }));
        }
        const out = await runNoMarksSplit(env, token, args, mergeNoMarksSettings(stored, args.settings || {}));
        return toolText(id, JSON.stringify(out), out.ok === false);
      }
      if (name === "bouios_edit" || name === "bouios_delete") {
        // Same checks as bouios_save: a recent load for this project, and access.
        if (!(await domainLoadedRecently(env.DB, domain))
            && !(await verifyLoadToken(env, domain, args.load_token))) {
          await logRefusal(env, domain, name + ": memory not loaded for this project recently");
          return toolText(id, "Refused: load memory for this project first (bouios_load), then retry with its load_token.", true);
        }
        const access = await checkAccess(env.DB, domain, request, url, env);
        if (!access.ok) { await logRefusal(env, domain, name + ": " + (access.note || "access check refused")); return toolText(id, access.note || "Refused.", true); }
        const reason = typeof args.reason === "string" ? args.reason.trim() : "";
        if (reason.length < 10) return toolText(id, "Refused: reason is required - say why, and that the user approved this change.", true);
        const out = name === "bouios_edit" ? await editRecord(env, domain, args, reason) : await deleteRecords(env, domain, args, reason);
        return toolText(id, JSON.stringify(out), out.ok === false);
      }
      if (name === "bouios_get") {
        // Fetch full bodies on demand for titles-only loads. Scope isolation
        // preserved: only rows in the caller's own domain or GLOBAL. Mirrors the
        // gateway bouios_get handler exactly.
        const rawIds = Array.isArray(args.ids) ? args.ids : [];
        const ids = rawIds.map((x) => parseInt(x, 10)).filter((x) => Number.isInteger(x) && x > 0);
        if (!ids.length) return toolText(id, "Provide at least one valid memory row id in ids.", true);
        const placeholders = ids.map(() => "?").join(",");
        const rows = await env.DB.prepare(
          `SELECT id, type, title, body FROM memory WHERE id IN (${placeholders}) AND (domain = ? OR domain = 'GLOBAL')`
        ).bind(...ids, domain).all();
        await logFetch(env.DB, domain, sessionId, args, ids, 0, (rows.results || []).length);
        return toolText(id, JSON.stringify({ rows: rows.results || [] }));
      }
    } catch (e) {
      return toolText(id, "tool failed: " + String(e), true);
    }
    return toolText(id, "unknown tool: " + String(name), true);
    })();
    return autoLoaded ? prefaceAutoLoad(res, autoLoaded) : res;
  }
  if (msg.id === undefined || msg.id === null) return null;
  return rpcError(id, -32601, "method not found");
}

async function handleMcp(request, env, ctx) {
  if (request.method === "DELETE") return new Response(null, { status: 204 });
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST, DELETE" } });
  let body;
  try { body = await request.json(); } catch { return json(rpcError(null, -32700, "parse error"), 400); }
  let sessionId = request.headers.get("mcp-session-id");
  const msgs = Array.isArray(body) ? body : [body];
  if (!sessionId && msgs.some((m) => m && m.method === "initialize")) sessionId = crypto.randomUUID();
  // url parsed once, reused per message - accessTokenFromRequest inside
  // checkAccess is a no-op (no fetch, no DB read) whenever no token is
  // configured, so this costs nothing for the vast majority of deployments.
  const url = new URL(request.url);
  const responses = [];
  let text = "";
  for (const m of msgs) {
    const r = await handleMsg(m, sessionId, env, request, url);
    if (r) responses.push(r);
    // Session record (A11): paired with its response; notifications have none.
    text += chatLine(m, r, sessionId) || "";
  }
  // After the answer is built, and never part of it: waitUntil when the runtime
  // gives one, otherwise awaited. Either way the Response below is the same.
  const job = recordChatTurn(env, sessionId, text);
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(job); else await job;
  const headers = { "content-type": "application/json; charset=utf-8" };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  if (!responses.length) return new Response(null, { status: 202, headers });
  return new Response(JSON.stringify(Array.isArray(body) ? responses : responses[0]), { status: 200, headers });
}

// REFUSALS LEAVE A TRACE (2026-09-24, parity with the gateway's b5a0edc). A
// refused save used to go back to the caller only, so a session whose every
// save was refused looked in this log like one that never tried. One row per
// refusal, starting "REFUSED". It never matches the "Session loaded" rows the
// load check reads, and a failed insert never turns the refusal into an error.
// bouios_edit / bouios_delete (2026-09-30) - see the tool definitions.
const TRANSCRIPT_NAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl(\.gz)?$/;
const BUNDLE_NAME_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([A-Za-z0-9._-]{1,64})$/;

async function archiveOld(env, domain, what, old, reason) {
  await env.DB.prepare("INSERT INTO log (ts, domain, summary) VALUES (datetime('now'), ?, ?)")
    .bind(domain, what + " ARCHIVE (" + reason.slice(0, 200) + "): " + JSON.stringify(old)).run();
}

// One memory row or one context row; the old value is archived first.
async function editRecord(env, domain, args, reason) {
  const db = env.DB;
  if (Number.isInteger(args.memory_id)) {
    const old = await db.prepare("SELECT id, domain, type, title, body FROM memory WHERE id = ? AND (domain = ? OR domain = 'GLOBAL')").bind(args.memory_id, domain).first();
    if (!old) return { ok: false, error: "memory row " + args.memory_id + " not found in " + domain + " or GLOBAL" };
    const next = { title: old.title, body: old.body, type: old.type };
    if (typeof args.title === "string" && args.title.trim()) next.title = args.title;
    if (typeof args.body === "string" && args.body.trim()) next.body = args.body;
    if (typeof args.type === "string") {
      if (!MEMORY_TYPES.includes(args.type)) return { ok: false, error: "type must be one of " + MEMORY_TYPES.join(", ") };
      next.type = args.type;
    }
    if (next.title === old.title && next.body === old.body && next.type === old.type) return { ok: false, error: "nothing to change: give title, body or type" };
    await archiveOld(env, domain, "EDIT memory " + old.id, old, reason);
    await db.prepare("UPDATE memory SET title = ?, body = ?, type = ? WHERE id = ?").bind(next.title, next.body, next.type, old.id).run();
    return { ok: true, edited: { memory_id: old.id }, archived_to_log: true };
  }
  if (typeof args.context_key === "string" && args.context_key) {
    if (typeof args.content !== "string" || !args.content.trim()) return { ok: false, error: "content is required for a context row" };
    const old = await db.prepare("SELECT domain, key, content, updated_at FROM context WHERE domain = ? AND key = ? AND key != 'gateway-bearer-token'").bind(domain, args.context_key).first();
    if (!old) return { ok: false, error: "context key not found in " + domain };
    await archiveOld(env, domain, "EDIT context " + old.key, old, reason);
    await db.prepare("UPDATE context SET content = ?, updated_at = ? WHERE domain = ? AND key = ? AND key != 'gateway-bearer-token'").bind(args.content, new Date().toISOString(), domain, old.key).run();
    return { ok: true, edited: { context_key: old.key }, archived_to_log: true };
  }
  return { ok: false, error: "give memory_id (with title, body or type) or context_key (with content)" };
}

// Rows are archived then deleted; stored objects are logged then deleted.
async function deleteRecords(env, domain, args, reason) {
  const db = env.DB;
  const done = { memory_ids: [], context_keys: [], objects: [] };
  const missing = [];
  const objs = [];
  if (typeof args.transcript === "string" && args.transcript) {
    if (!TRANSCRIPT_NAME_RE.test(args.transcript)) return { ok: false, error: "transcript must be UUID.jsonl or UUID.jsonl.gz" };
    objs.push("transcript:" + args.transcript);
  }
  if (typeof args.bundle === "string" && args.bundle) {
    const m = args.bundle.match(BUNDLE_NAME_RE);
    if (!m || m[2].startsWith(".")) return { ok: false, error: "bundle must be <session-uuid>/<repo>" };
    objs.push("bundle:" + m[1] + ":" + m[2]);
  }
  if (objs.length && !env.TRANSCRIPTS) return { ok: false, error: "object storage not configured" };
  const ids = (Array.isArray(args.memory_ids) ? args.memory_ids : []).filter((x) => Number.isInteger(x) && x > 0).slice(0, 50);
  for (const mid of ids) {
    const old = await db.prepare("SELECT id, domain, type, title, body, created_at FROM memory WHERE id = ? AND (domain = ? OR domain = 'GLOBAL')").bind(mid, domain).first();
    if (!old) { missing.push("memory " + mid); continue; }
    await archiveOld(env, domain, "DELETE memory " + mid, old, reason);
    await db.prepare("DELETE FROM memory WHERE id = ?").bind(mid).run();
    done.memory_ids.push(mid);
  }
  const keys = (Array.isArray(args.context_keys) ? args.context_keys : []).filter((k) => typeof k === "string" && k).slice(0, 50);
  for (const k of keys) {
    const old = await db.prepare("SELECT domain, key, content, updated_at FROM context WHERE domain = ? AND key = ? AND key != 'gateway-bearer-token'").bind(domain, k).first();
    if (!old) { missing.push("context " + k); continue; }
    await archiveOld(env, domain, "DELETE context " + k, old, reason);
    await db.prepare("DELETE FROM context WHERE domain = ? AND key = ? AND key != 'gateway-bearer-token'").bind(domain, k).run();
    done.context_keys.push(k);
  }
  for (const key of objs) {
    const head = await env.TRANSCRIPTS.head(key);
    if (!head) { missing.push(key); continue; }
    await db.prepare("INSERT INTO log (ts, domain, summary) VALUES (datetime('now'), ?, ?)")
      .bind(domain, "DELETE object " + key + " (" + head.size + " bytes) - not restorable (" + reason.slice(0, 200) + ")").run();
    await env.TRANSCRIPTS.delete(key);
    done.objects.push(key);
  }
  if (!done.memory_ids.length && !done.context_keys.length && !done.objects.length) {
    return { ok: false, error: missing.length ? "nothing deleted - not found: " + missing.join(", ") : "give memory_ids, context_keys, transcript or bundle" };
  }
  return { ok: true, deleted: done, not_found: missing, archived_to_log: true };
}

async function logRefusal(env, domain, what) {
  if (!env || !env.DB) return;
  try {
    await env.DB.prepare("INSERT INTO log (ts, domain, summary) VALUES (datetime('now'), ?, ?)").bind(domain || "GLOBAL", "REFUSED " + String(what).slice(0, 300)).run();
  } catch (_) {}
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    // Build identity, mirroring the gateway (2026-09-03). A self-hoster has the
    // same problem the owner just hit: no way to tell whether the worker running
    // on their account is the code they deployed. null when unset - absent must
    // read as "unknown", never as a version claim.
    if (path === "/health") return json({ ok: true, service: "memory-vault", version: env.BUILD_SHA || null });

    if (path.startsWith("/mcp/")) {
      const token = path.slice(5);
      if (!env.BEARER_TOKEN || !token || !timingSafeEqual(token, env.BEARER_TOKEN)) return json({ error: "unauthorised" }, 401);
      return handleMcp(request, env, ctx);
    }
    // NO OAUTH - answer the discovery probes truthfully, same fix as the
    // gateway (b5c76ac). These paths fell through to the bearer check below
    // and answered 401, and a 401 on an OAuth-discovery probe is the
    // documented signal for a client to begin an OAuth flow: the claude.ai
    // add-connector probe obeys it, launches a sign-in against an OAuth
    // server that does not exist, and the customer's tokened connector URL
    // "doesn't work" even though its handshake is fine. 404 says what is
    // true, and the client then connects directly with the token in the URL.
    if (path === "/.well-known/oauth-authorization-server" ||
        path === "/.well-known/oauth-protected-resource" ||
        path === "/.well-known/openid-configuration") {
      return json({ error: "not found" }, 404);
    }
    // Remaining routes require bearer auth
    const h = request.headers.get("authorization") || "";
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m || !env.BEARER_TOKEN || !timingSafeEqual(m[1], env.BEARER_TOKEN)) return json({ error: "unauthorised" }, 401);
    // GET /search: the per-message record lookup the Claude Code prompt hook makes (BOUIOS decision
    // 173, owner 2026-10-25: a customer's lookup runs against THEIR OWN server). Same bearer as every
    // route below, same answer shape and ranking as the owner gateway's /search.
    if (path === "/search" && request.method === "GET") return searchRoute(url, env, request);
    if (path === "/transcript" || path.startsWith("/transcript/")) return transcriptRoute(request, env, url, path, ctx);
    if (path === "/chat" || path.startsWith("/chat/")) return chatRoute(request, env, url, path);
    return json({ error: "not found", routes: ["GET /health", "GET /search?domain=&q=", "POST /mcp/{token}", "POST /mcp (after sign-in)", "PUT /transcript/{id}", "GET /transcript", "GET /transcript/{id}", "GET /chat", "GET /chat/{session}/{part}.jsonl"] }, 404);
  },
};
