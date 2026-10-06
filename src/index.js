// Thin client worker for customer deployment.
// Personal memory D1 (hot/context/memory/log) + auth + MCP.
// Rules are served by our gateway; never stored in the customer D1.
// Secrets required: BEARER_TOKEN
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

async function fetchRules(env) {
  if (!env.GATEWAY_URL) return [];
  try {
    // The gateway serves the full rules only to a valid licence (6 Oct 2026); with
    // none it serves a short neutral set, so this still returns an array.
    const r = await fetch(env.GATEWAY_URL + "/rules", env.LICENCE ? { headers: { "x-licence": env.LICENCE } } : undefined);
    if (!r.ok) return [];
    const data = await r.json();
    return Array.isArray(data.rules) ? data.rules : [];
  } catch {
    return [];
  }
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
async function transcriptRoute(request, env, url, path) {
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
    const opts = { httpMetadata: { contentType: request.headers.get("content-type") || "application/x-ndjson" } };
    const declared = Number(request.headers.get("content-length") || 0);
    const existing = await env.TRANSCRIPTS.head(id);
    const tooShort = (n) => existing && n < existing.size;
    if (Number.isFinite(declared) && declared > 0 && request.body && typeof FixedLengthStream !== "undefined") {
      if (tooShort(declared)) return json({ error: "a transcript with this id is already stored and is longer; upload under a new id" }, 409);
      const { readable, writable } = new FixedLengthStream(declared);
      const [put] = await Promise.all([env.TRANSCRIPTS.put(id, readable, opts), request.body.pipeTo(writable)]);
      return json({ ok: true, id, size: put ? put.size : declared });
    }
    const bytes = await request.arrayBuffer();
    if (tooShort(bytes.byteLength)) return json({ error: "a transcript with this id is already stored and is longer; upload under a new id" }, 409);
    const put = await env.TRANSCRIPTS.put(id, bytes, opts);
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
      for (const o of page.objects) if (inWindow(o)) items.push({ id: o.key, size: o.size, uploaded: o.uploaded });
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
// relevant, lessons, pending, owner_rulings, related_elsewhere and /search.
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
// Same 12 rows, same 8 in-project + 4 cross-project behaviour slots, same
// 700-character clip: rows matching the topic come first (score, then
// authority), the newest fill the rest. With no topic every score is 0 and
// the order is exactly the old one (newest first). The owner's latest words
// reach lessons through the per-message lookup (/search scores every row
// type, lessons included) on the gateway. Superseded rows are excluded.
function lessonsQuery(topic) {
  const { all, score, pat } = relevanceScore(topic);
  const rel = all.length ? "(" + score + ")" : "0";
  const part = (rank, where, limit) =>
    "SELECT id, type, title, body, rank, lscore, CASE WHEN lscore > 0 THEN auth ELSE 0 END AS tie FROM (" +
      "SELECT id, type, title, substr(body,1,700) AS body, " + rank + " AS rank, " + rel + " AS lscore, " + AUTHORITY + " AS auth FROM memory " +
        "WHERE " + where + " AND type IN ('mistake','pattern') AND " + NOT_SUPERSEDED + " " +
        "ORDER BY lscore DESC, CASE WHEN lscore > 0 THEN auth ELSE 0 END, id DESC LIMIT " + limit +
    ")";
  const sql =
    part(0, "(domain = ? OR domain = 'GLOBAL')", 8) +
    " UNION ALL " +
    part(1, "domain != ? AND domain != 'GLOBAL' AND (title LIKE '%verif%' OR title LIKE '%claim%' OR title LIKE '%stale%' " +
      "OR title LIKE '%record%' OR title LIKE '%duplicat%' OR title LIKE '%already%' " +
      "OR title LIKE '%regress%' OR title LIKE '%broke%')", 4) +
    " ORDER BY rank, lscore DESC, tie, id DESC";
  const termBinds = [];
  for (const a of all) termBinds.push(pat(a), pat(a));
  return { sql, binds: (domain) => [...termBinds, domain, ...termBinds, domain] };
}
const lessonRow = ({ id, type, title, body, rank, lscore }) =>
  (lscore > 0 ? { id, type, title, body, rank, matched: true } : { id, type, title, body, rank });

// ROWS MATCHING THIS TOPIC IN ANOTHER PROJECT. Ported from the
// gateway 2026-09-16, same reason: relevantMemory below is scoped to this project
// plus GLOBAL, so a row in another project cannot be returned by any load at any
// topic, and the only way to reach it is for someone to name its id. Decision
// and pattern rows (rulings and lessons) carry their full body, because a ruling
// seen only as a title was ignored and contradicted (2026-09-25, parity with the
// gateway). Mistake and pending bodies are never fetched - the split is in the
// SQL. Errors return [] and the load stands.
async function relatedElsewhere(db, domain, topic) {
  const { all, score, pat } = relevanceScore(topic);
  if (!all.length) return [];
  const sql =
    "SELECT id, domain, type, title, CASE WHEN type IN ('decision','pattern') THEN body END AS body, (" + score + ") AS score " +
    "FROM memory WHERE domain != ? AND domain != 'GLOBAL' AND " + NOT_SUPERSEDED + " AND (" + score + ") > 0 " +
    "ORDER BY score DESC, " + AUTHORITY + ", id DESC LIMIT 5";
  const binds = [];
  for (const a of all) binds.push(pat(a), pat(a));
  binds.push(domain);
  for (const a of all) binds.push(pat(a), pat(a));
  try {
    const rows = await db.prepare(sql).bind(...binds).all();
    return (rows.results || []).map((r) => {
      const o = { id: r.id, project: r.domain, type: r.type, title: r.title };
      if (typeof r.body === "string") o.body = r.body;
      return o;
    });
  } catch (e) {
    return [];
  }
}

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
    // load is his call, not a retrieval optimisation to make on inference -
    // and the lessons query above already carries the cross-project slots he
    // has sanctioned, so widening HERE also double-counted that decision.
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

async function sessionLoad(domain, surface, env) {
  const db = env.DB;
  await ensureSchema(db);
  let loadTopic = "";
  {
    const tm = / topic=(\S+)/.exec(String(surface || ""));
    if (tm) { try { loadTopic = decodeURIComponent(tm[1]); } catch (e) { loadTopic = tm[1]; } }
  }
  const lq = lessonsQuery(loadTopic);
  const [rules, hot, context, pending, recent, lessons, memTotal] = await Promise.all([
    fetchRules(env),
    db.prepare("SELECT state, updated_at FROM hot WHERE domain = ?").bind(domain).all(),
    db.prepare("SELECT key, content FROM context WHERE domain = ?").bind(domain).all(),
    // Memory rows load as TITLES ONLY (id, type, title - no body) to keep the
    // load small; bouios_get fetches the full body of a specific row on demand.
    // Must match the gateway (memory-gateway/src/index.js) - locked by the
    // gateway<->worker tool-parity test.
    db.prepare("SELECT id, type, title FROM memory WHERE (domain = ? OR domain = 'GLOBAL') AND type = 'pending' AND " + NOT_SUPERSEDED + " ORDER BY id").bind(domain).all(),
    db.prepare("SELECT id, type, title FROM memory WHERE (domain = ? OR domain = 'GLOBAL') AND type != 'pending' AND " + NOT_SUPERSEDED + " ORDER BY id DESC LIMIT 40").bind(domain).all(),
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
      // The four classes that recur every single month (unverified claim, did not
      // read the record, rebuilt what existed, regression) are NOT project
      // specific: trusting a stale note in TRAVEL is the same failure as trusting
      // one in AI. So 4 of the 12 slots are given to cross-project rows whose
      // titles carry that vocabulary, and the other 8 stay in-project.
      //
      // TWELVE EITHER WAY - this REPLACES, it does not add. The load is already
      // 31% behaviour instruction and the owner's stated aim is fewer tokens, so a
      // retrieval fix that grows the payload would trade one complaint for another.
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
  const relatedRows = await relatedElsewhere(db, domain, loadTopic || String(hotState || "").slice(0, 600));
  const openN = countOpenTasks(hotState);
  const openItemList = openItems(hotState, (pending.results || []));
  await db.prepare("INSERT INTO log (ts, domain, summary) VALUES (datetime('now'), ?, ?)").bind(domain, "Session loaded, surface=" + (surface || "mcp")).run();
  const out = {
    // Parity with the gateway: the number in the line a customer reads is the
    // real count of what the record says is unfinished, not a heading match.
    confirmation: confirmationText(domain, rules.length, hotDate, openItemList.length, false),
    domain,
    rules,
    hot: hotState,
    hot_updated: hotDate,
    open_tasks: openN,
    // Parity with the gateway - a customer session is told the same truth about
    // what is outstanding as the owner's is.
    open_items: openItemList,
    open_items_note: "open_items lists what the record itself says is unfinished: real pending rows, bullets under a STILL OPEN heading, a NEXT block, and lines carrying an explicit unfinished marker. It exists because open_tasks counted only one heading format that no working state had used in months, so every load reported 0 while a dozen things were outstanding - and a session told nothing is open leaves things open. Read it before starting new work, and close what you finish.",
    context: contextWindow(context.results || [], loadTopic),
    context_note: "context carries the reference material for this project. Rows that bind behaviour (preferences, instructions), rows under 1200 characters, and rows matching the topic you named come back IN FULL. The rest are an excerpt plus their real length, marked excerpt_only - because after the log was capped, context became the largest block in the payload and the size guard's last resort would otherwise have started cutting it. Nothing is hidden: every key is listed with its date, and the full content is one bouios_get({project, keys:[...]}) call away. Fetch the ones your task actually needs, never all of them.",
    memory: [...(pending.results || []), ...(recent.results || [])],
    memory_note: MEMORY_NOTE,
    memory_total: memTotal ? memTotal.n : 0,
    // Say out loud how little of the store this is - parity with the gateway.
    memory_coverage: relevantRows.length
      ? "Returned " + (recent.results || []).length + " newest titles + " + relevantRows.length + " rows matched on your topic, out of " + (memTotal ? memTotal.n : 0) + " total."
      : "Returned the " + (recent.results || []).length + " NEWEST titles out of " + (memTotal ? memTotal.n : 0) + " rows. The rest are not shown and their ids cannot be guessed from this window. If your task is not covered by what you see, call bouios_load again with a topic to search ALL rows by relevance - do not assume the store has nothing on it.",
    // Own field, not inside relevant: a load whose own project matched nothing
    // dropped it (2026-09-30, parity with the gateway).
    ...(relatedRows.length ? {
      related_elsewhere: relatedRows,
      related_elsewhere_note: "Rows from your other projects matched on the same topic. Decisions and patterns come with their full body so they are read, not skimmed. Mistakes and pending rows stay title only. SEEING A RULING HERE IS NOT PERMISSION TO WORK IN THAT PROJECT: obey a ruling that bears on the work you were given, and ask before any work over there.",
    } : {}),
    ...(relevantRows.length ? {
      relevant: relevantRows,
    } : {}),
    // The only rows here that arrive WITH a body - parity with the gateway.
    lessons: (lessons.results || []).map(lessonRow),
    lessons_note: "lessons carries 12 mistake and pattern rows WITH their bodies, clipped to 700 characters - the ones matching your topic first (marked matched - read those before anything else; they are the recorded answer to what you named), then the newest; superseded rows are never included - because these are the rows whose purpose is to stop a repeat and a title alone cannot do that. Read them before diagnosing or building - if one describes what you are about to do, you are about to repeat it. Everything in memory above is titles only by design; use bouios_get for any of those bodies.",
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
  const CLAIM_RE = /\b(done|fixed|resolved|deployed|shipped|completed?|verified)\b/i;
  // THE LOWERCASE-"pass" HOLE, closed 2026-09-15 (memory row 2026). \bPASS\b
  // sat inside a case-INSENSITIVE regex, so any body containing the ordinary
  // word "pass" - "the second pass never ran" - counted as evidence and walked
  // straight through every gate that shares this escape. Split, not deleted:
  // real test output is upper-case, and the "tests pass/green/passing" arm
  // stays case-insensitive, so honest evidence is untouched and only the bare
  // word loses its free ride. hasEvidence() is the single call site for both
  // halves so they cannot drift apart.
  const EVIDENCE_RE = /\b[0-9a-f]{7,40}\b|https?:\/\/\S+|\btests?\s+(pass|green|passing)\b|\blive[- ]?(verified|checked|tested|confirmed|reproduced)\b|\b(verified|checked|tested|confirmed|reproduced)[- ]?live\b/i;
  const EVIDENCE_PASS_RE = /\bPASS\b/;   // case-SENSITIVE on purpose
  const hasEvidence = (t) => EVIDENCE_RE.test(t) || EVIDENCE_PASS_RE.test(t);

  const applied = [];
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
      if (constraintRowError(m)) continue;
      if (m.type === "decision" && CLAIM_RE.test(m.body) && !hasEvidence(m.body)) continue;
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
      if (m.type === "decision" && STALE_ABSENCE_RE.test(m.body) && !hasEvidence(m.body)) continue;
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
      const openTitle = m.type === "pending" && !DONE_RE.test(m.body)
        ? m.title + " [no done-condition]"
        : m.title;
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
  return { ok: true, domain, applied, saved_at: savedAt.toISOString(), confirmation: saveConfirmation(applied, savedAt, tz) };
}

// SAVE TIME (2026-09-24). A save hands back the moment it was written and a
// ready confirmation line carrying it. Every "saved at HH:MM" line one evening
// was an estimate - 19:40 for a write logged at 19:52 UTC - because nothing
// gave the session a clock. The zone is DISPLAY_TZ (an IANA name); unset or
// unknown, the line says UTC, never an unlabelled time. Counts only what was
// applied. Kept identical in memory-gateway/src/index.js and
// worker/src/index.js; memory-gateway/test/save-time.test.mjs.
function saveConfirmation(applied, now, tz) {
  const n = (p) => applied.filter((a) => a === p || a.startsWith(p + ":") || a.startsWith(p + " ")).length;
  const parts = [];
  if (n("hot")) parts.push("hot");
  if (n("log")) parts.push("log");
  let s = parts.join(" + ") || "nothing new";
  const plural = (k, one) => k + " " + one + (k === 1 ? "" : "s");
  if (n("memory")) s += ", " + plural(n("memory"), "new memory row");
  if (n("context")) s += ", " + plural(n("context"), "context row");
  if (n("resolved")) s += ", " + plural(n("resolved"), "resolved row");
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

const AUTO_LOAD_TOOLS = new Set(["bouios_save", "bouios_handoff", "bouios_get", "bouios_edit", "bouios_delete", "bouios_no_marks"]);
const AUTO_LOAD_PREFACE = "Memory was not loaded in this chat; loaded it now.";

// The one MCP load path: bouios_load and the auto-load both come through here.
async function mcpLoad(domain, args, sessionId, env, request, url) {
  // The topic rides on `surface` URI-encoded, as on the gateway. Until
  // 2026-10-06 the worker never read args.topic and its schema had no
  // topic, so a customer load could not search by one at all.
  const surface = (args.surface || "mcp") + " session=" + (sessionId || "none") + (typeof args.topic === "string" && args.topic.trim() ? " topic=" + encodeURIComponent(args.topic.trim().slice(0, 160)) : "");
  const loaded = await sessionLoad(domain, surface, env);
  // A skill that cannot be read never takes the load down with it.
  try {
    const cap = await skillsCapFor(request, url, env);
    if (cap !== null) loaded.skills = await ownSkills(env.DB, domain, cap, await defaultSkills(request, url, env));
  } catch (_) { /* no skills field, load unchanged */ }
  return loaded;
}

// Puts the preface, the load's confirmation line and its payload ahead of the
// tool's own result, in the same text block the model reads.
function prefaceAutoLoad(res, loaded) {
  const block = res && res.result && Array.isArray(res.result.content) ? res.result.content[0] : null;
  if (!block || typeof block.text !== "string") return res;
  block.text = AUTO_LOAD_PREFACE + "\n" + (loaded.confirmation || "") + "\n" + JSON.stringify(loaded) + "\n\n" + block.text;
  return res;
}

// ---- MCP (JSON-RPC 2.0, Streamable HTTP) ----

const MCP_PROTOCOL = "2025-03-26";
// Tool identifiers are Bouios-branded (2026-07-02): the platform's own
// permission dialogs render the raw technical tool name with zero branding -
// confirmed by owner screenshot on the owner's own connector, applies
// identically to every customer's connector. Mirrors memory-gateway/src.
const MCP_INSTRUCTIONS =
  // CORE FIRST (2026-09-28): Claude Code keeps only the first 2,048 characters
  // of these, and the canonical block below is 3,733 (measured 2026-10-06). A copy of
  // CORE_INSTRUCTIONS in memory-gateway/src/text-generator.js - edit it there
  // and paste it here; instructions-core.test.mjs fails if the served text does
  // not start with it byte for byte.
  "This connector is Bouios, the user's own memory system, expected in every conversation. Some apps keep only the first 2,048 characters of these instructions, so the rules that matter most come first. 1. Before replying, call bouios_load with the ONE project the topic implies (ask which if unclear; never load all). A short task is not exempt. Show the user only the confirmation line it returns, verbatim. Read pending, the log and rules before acting; never re-propose what the log shows is built. List open tasks before new work. 2. Verify, never guess. Done, fixed or working needs evidence in the same reply - a file, a live check, a saved record, a test result or a link - or say plainly it is unverified. Absence is known only by looking this turn. Nothing is live until it answers. 3. Do the task in full: never defer, narrow the scope or ask what you can check yourself; ask only a genuine decision, once, plainly. Answer a yes/no question in the first line. 4. Save with bouios_save (pass the load_token) every few substantive steps and before any long step, and show its returned line verbatim. A load or save with no line in the reply is a failure. 5. Near the context limit call bouios_handoff and show its block in a code box; after a compaction or resume, call bouios_load again before any write. 6. Do not write, edit, send or publish until memory is loaded and the user approves that action. Never ask the user for a token, key or credential. 7. Never show accounts, ids, urls, queries or backend detail. Be terse: action, evidence, next. Named failures, each has happened: reporting an inference as a finding; naming a cause from a count without opening it; concluding something does not exist from searching a name you invented; reporting silence from the only way in you checked; quoting a stale note as the user's rule. The full rules follow; the rules bouios_load returns also bind and take precedence." +
  " " +
  // CANONICAL BLOCK - byte-identical to .session/canonical-load-block.txt and
  // memory-gateway/src/text-generator.js CANONICAL_LOAD_BLOCK. Inlined, not
  // imported, because this worker deploys as a single self-contained module
  // (a cross-directory import fails Cloudflare upload with error 10021 - proven
  // live 2026-07-24). DO NOT EDIT HERE: edit text-generator.js and run
  // .session/sync-canonical-block.mjs, which rewrites the line between the
  // markers below. The byte-identity test fails the build on any difference.
  // BOUIOS-CANONICAL-BLOCK-START
  "Bouios is my memory system. Load it at the START of every conversation, before replying. Infer the ONE project from the topic; if unclear, ASK me which - never default, never load all. 'load memory', 'load rules' and 'load Bouios' each mean do this now. A short or self-contained task is not exempt. Use the bouios_load TOOL - never curl, fetch or bash the memory address yourself; that address is the connector's, not a URL to call by hand. If the tool is genuinely missing, the only fallback is your store's own query tool against the same store; if neither exists, say so once and carry on without it - do not stall; it reconnects. Never substitute an unrelated tool that merely mentions memory (knowledge graph, read_graph, create_entities); an empty result from one is not evidence mine is empty. Calling the tool is not loading, and neither is memory being shown to you automatically at the start - only your own load call counts. Read every row, including the log of what was agreed and done; never re-propose what it shows is built. Show me ONLY the confirmation line the tool returns, verbatim - it is already branded, do not retype it in your own words and do not replace it with a plainer one. Never show the account, database, ids or queries. List my open tasks before new work. Loaded rules take precedence. Never ask me for a token, key or credential - the tools already carry what they need. THESE BIND EVERY REPLY, they are not advice: Read the record FIRST - memory, the log, the history, audits, transcripts - before diagnosing, proposing or acting; never re-derive or re-propose what the record shows is decided or built. Verify, never guess: state no fact, capability, done, fixed or working from assumption - ground each in a file, a live check, a saved record, a test result or a link, and tag which; never assert from a hunch. Never claim done, fixed or working without that evidence, never narrate around a failure, never step around a gate. Do the task in full: never defer, never resist or deflect, never narrow the scope I set or fix one sliver in place of the whole, never ask what you can verify yourself - resolve each issue with evidence, do not just describe it, and ask only a genuine decision, once, framed plainly. Every load, save and handoff ends with its own branded line in the reply itself, never buried in a tool call I do not read: the returned line verbatim after a load, 'Bouios memory saved: hot + log{, N rows} at {HH:MM}.' after a save, 'Bouios handoff saved.' after a handoff - a load or save with no line is a failure, not a style choice. These five are the real failures, each one has happened, recognise the shape as you are about to do it: reporting an inference as a finding; reading a count and naming a cause without opening what it counted; searching for a name you invented and concluding from finding nothing that the thing does not exist; checking the only way in you could reach and reporting its silence as evidence; reading a stale note and quoting it back to me as my own rule. Answer a yes/no question in the first line. Be terse - Action, Evidence, Next - no verbose narration, no restating. When memory and this note disagree, memory wins; when neither can be reached, say so once and continue - never stall. Do not write, edit, send or publish until memory is loaded and I approve that action; never revert or reset my work without that same approval. Save full state to hot every few substantive steps and before any long step, counting steps because you cannot read a percentage, and say what was saved. After a compaction or resume, load again before any write. When context or usage nears the limit, output a handoff block in a code box to paste into a new chat. Choose the model per task from the current routing table: today that means opusplan to plan and write, and a cheaper sub-agent model to read, build from a fully written spec, check and deploy." +
  // BOUIOS-CANONICAL-BLOCK-END
  // Leading space: the block ends "...new chat." with none, and without it
  // customers were served "new chat.Surface only" (worker-gateway-parity).
  " Surface only the returned confirmation line to the user. " +
  "Memory loads return TITLES ONLY (id, type, title - no body); call bouios_get({project, ids:[...]}) for the full body of any specific row you actually need, never all of them. " +
  "Save via bouios_save; call bouios_handoff when the conversation nears its limit and show the user the returned block to paste into a new chat.";

const MCP_TOOLS = [
  {
    name: "bouios_load",
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
  // Parity with the gateway (2026-09-30); this worker stores no transcripts,
  // so a transcript or bundle delete answers that storage is not configured.
  // edit-delete.test.mjs.
  {
    name: "bouios_edit",
    annotations: { destructiveHint: true },
    description:
      "Change an existing memory row (title, body or type) or context row (content) in this project. " +
      "ONLY after the user has explicitly approved this exact change - the client asks them; never call it to " +
      "tidy up on your own initiative. The old value is archived to the log first (undoable). reason is required.",
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
      "ONLY after the user has explicitly approved this exact deletion - the client asks them. Memory and context " +
      "rows are archived to the log first (undoable); a transcript or bundle object cannot be restored. reason is required.",
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
// Small rows are not worth excerpting either, and a row that matches the topic
// the session actually named comes back whole, exactly like `relevant`.
//
// Nothing is lost: every key, its date and its length are always listed, and
// the full content is one bouios_get({project, keys:[...]}) away.
const CONTEXT_ALWAYS_FULL = /(instruction|preference|owner-behaviour|enforcement-config|gateway-url|gateway-config)/i;
// A handoff is read whole (parity with the gateway, 2026-09-25).
const CONTEXT_FULL_UNDER = 1200;
const CONTEXT_EXCERPT = 300;
const CONTEXT_RELEVANT_MAX = 3;
function contextWindow(rows, topic) {
  const terms = relevanceTerms(topic || "");
  let promoted = 0;
  return (rows || []).map((c) => {
    if (!c || typeof c.content !== "string") return c;
    if (CONTEXT_ALWAYS_FULL.test(c.key || "")) return c;
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
      if (!c.content || c.content.length <= 300 || /handoff/i.test(c.key || "")) return c;
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
  const _steps = [
    () => { delete out.recent_transcripts; },
    () => { (out.log || []).forEach((r) => { if (r && r.summary) r.summary = _clip(r.summary, 400); }); },
    // The top 3 matches stay readable until late (parity with the gateway, 2026-09-30).
    () => { (out.relevant || []).forEach((r, i) => { if (i >= 3 && r && r.body) r.body = _clip(r.body, 150); }); },
    // A LESSON MATCHED BY THE TOPIC STAYS READABLE (2026-10-06), same as the
    // top 3 relevant rows: the first 3 marked `matched` are skipped here and at
    // the 150 step, and cut only with the relevant top 3 below. Measured live:
    // the matched answer (row 99) arrived as 176 characters, without the half
    // naming the symptom, and 3 of 3 runs answered wrong. retrieval-authority LES7.
    () => { let k = 0; (out.lessons || []).forEach((r) => { if (r && r.matched && k++ < 3) return; if (r && r.body) r.body = _clip(r.body, 250); }); },
    () => { delete out.hot_archives; delete out.hot_archives_note; },
    () => { if (Array.isArray(out.log)) out.log = out.log.slice(0, 10); },
    () => { if (Array.isArray(out.memory)) out.memory = out.memory.slice(0, 20); },
    // Handoffs and other projects' rulings are read whole, so everything else
    // pays first (parity with the gateway, 2026-09-25).
    () => {
      (out.context || []).forEach((c) => {
        if (c && c.truncated && typeof c.content === "string" && c.content.length > 200) c.content = c.content.slice(0, 120) + "...(truncated, size guard - ask for context key " + c.key + " if the rest is needed)";
      });
    },
    () => { let k = 0; (out.lessons || []).forEach((r) => { if (r && r.matched && k++ < 3) return; if (r && r.body) r.body = _clip(r.body, 150); }); },
    () => { if (Array.isArray(out.memory)) out.memory = out.memory.slice(0, 12); },
    // Only then are they clipped, to a visible pointer, before the last resort.
    () => {
      (out.related_elsewhere || []).forEach((r) => {
        if (r && typeof r.body === "string" && r.body.length > 400) r.body = r.body.slice(0, 400) + "...(truncated, size guard - bouios_get({project:\"" + r.project + "\", ids:[" + r.id + "]}) for the rest)";
      });
    },
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
    () => { (out.relevant || []).forEach((r) => { if (r && r.body) r.body = _clip(r.body, 150); }); (out.lessons || []).forEach((r) => { if (r && r.body) r.body = _clip(r.body, 150); }); },
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
    "confirmation", "domain", "read_order", "pending", "pending_suspect",
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
      if (name === "bouios_no_marks") {
        const token = accessTokenFromRequest(request, url, env);
        const row = await env.DB.prepare("SELECT content FROM context WHERE domain = ? AND key = 'no-marks:settings'").bind(domain).first();
        let stored = {};
        try { stored = row && row.content ? JSON.parse(row.content) : {}; } catch { stored = {}; }
        if (args.action === "get_settings") return toolText(id, JSON.stringify({ ok: true, project: domain, settings: stored, note: "Anything not listed uses the default." }));
        if (args.action === "set_settings") {
          const next = mergeNoMarksSettings(stored, args.settings || {});
          // The service validates settings; a refused set is not saved.
          const check = await callNoMarks(env, token, { action: "scan_text", text: "", settings: next });
          if (!check.ok) return toolText(id, JSON.stringify({ ok: false, project: domain, error: check.error, errors: check.errors }), true);
          await env.DB.prepare("INSERT OR REPLACE INTO context (domain, key, content, updated_at) VALUES (?, 'no-marks:settings', ?, ?)")
            .bind(domain, JSON.stringify(next), new Date().toISOString()).run();
          return toolText(id, JSON.stringify({ ok: true, project: domain, settings: next }));
        }
        const out = await callNoMarks(env, token, { ...args, project: undefined, settings: mergeNoMarksSettings(stored, args.settings || {}) });
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

async function handleMcp(request, env) {
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
  for (const m of msgs) {
    const r = await handleMsg(m, sessionId, env, request, url);
    if (r) responses.push(r);
  }
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
  async fetch(request, env) {
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
      return handleMcp(request, env);
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
    if (path === "/transcript" || path.startsWith("/transcript/")) return transcriptRoute(request, env, url, path);
    return json({ error: "not found", routes: ["GET /health", "POST /mcp/{token}", "POST /mcp (after sign-in)", "PUT /transcript/{id}", "GET /transcript", "GET /transcript/{id}"] }, 404);
  },
};
