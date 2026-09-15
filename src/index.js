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
function confirmationText(domain, rulesN, hotDate, openN, branded = false) {
  if (branded) {
    return `Bouios loaded - working set ${domain}, ${rulesN} rules loaded, ${openN} items flagged for follow-up.`;
  }
  return `Memory loaded: ${domain}, ${rulesN} rules, hot from ${hotDate}, ${openN} open tasks.`;
}
const MEMORY_NOTE = "titles only - call bouios_get({project, ids:[...]}) for full body of any row you need";

const MEMORY_TYPES = ["pattern", "mistake", "decision", "pending"];
const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS hot (domain TEXT PRIMARY KEY, state TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS context (domain TEXT NOT NULL, key TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (domain, key))",
  "CREATE TABLE IF NOT EXISTS memory (id INTEGER PRIMARY KEY AUTOINCREMENT, domain TEXT NOT NULL, type TEXT NOT NULL CHECK (type IN ('pattern','mistake','decision','pending')), title TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, source TEXT)",
  "CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, domain TEXT NOT NULL, summary TEXT NOT NULL)",
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
    const r = await fetch(env.GATEWAY_URL + "/rules");
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

async function relevantMemory(db, domain, topic, excludeIds) {
  const terms = relevanceTerms(topic);
  if (!terms.length) return [];
  const score = terms
    .map(() => "(CASE WHEN lower(title) LIKE ? THEN 3 ELSE 0 END) + (CASE WHEN lower(COALESCE(body,'')) LIKE ? THEN 1 ELSE 0 END)")
    .join(" + ");
  const sql =
    "SELECT id, type, title, substr(body, 1, 400) AS body, (" + score + ") AS score " +
    "FROM memory WHERE (domain = ? OR domain = 'GLOBAL') AND type != 'pending' AND (" + score + ") > 0 " +
    "ORDER BY score DESC, id DESC LIMIT 24";
  const binds = [];
  for (const t of terms) binds.push("%" + t + "%", "%" + t + "%");
  binds.push(domain);
  for (const t of terms) binds.push("%" + t + "%", "%" + t + "%");
  let rows;
  try {
    rows = await db.prepare(sql).bind(...binds).all();
  } catch (e) {
    // A search that fails must never take the load down with it.
    return [];
  }
  const skip = new Set(excludeIds || []);
  return (rows.results || []).filter((r) => !skip.has(r.id)).slice(0, 8);
}

async function sessionLoad(domain, surface, env) {
  const db = env.DB;
  await ensureSchema(db);
  const [rules, hot, context, pending, recent, lessons, memTotal] = await Promise.all([
    fetchRules(env),
    db.prepare("SELECT state, updated_at FROM hot WHERE domain = ?").bind(domain).all(),
    db.prepare("SELECT key, content FROM context WHERE domain = ?").bind(domain).all(),
    // Memory rows load as TITLES ONLY (id, type, title - no body) to keep the
    // load small; bouios_get fetches the full body of a specific row on demand.
    // Must match the gateway (memory-gateway/src/index.js) - locked by the
    // gateway<->worker tool-parity test.
    db.prepare("SELECT id, type, title FROM memory WHERE (domain = ? OR domain = 'GLOBAL') AND type = 'pending' ORDER BY id").bind(domain).all(),
    db.prepare("SELECT id, type, title FROM memory WHERE (domain = ? OR domain = 'GLOBAL') AND type != 'pending' ORDER BY id DESC LIMIT 40").bind(domain).all(),
    // LESSONS - parity with the gateway (2026-09-05). The newest mistake and
    // pattern rows arrive WITH their bodies, because those rows exist for one
    // purpose - to stop the same failure happening again - and a title cannot
    // do that. Everything else stays titles-only: this is a separate bounded
    // field BESIDE the query above, never a widening of it, so the size
    // decision titles-only exists to protect is kept intact on the customer
    // side exactly as it is on the owner's.
    db.prepare("SELECT id, type, title, substr(body, 1, 700) AS body FROM memory WHERE (domain = ? OR domain = 'GLOBAL') AND type IN ('mistake','pattern') ORDER BY id DESC LIMIT 12").bind(domain).all(),
    db.prepare("SELECT COUNT(*) AS n FROM memory WHERE domain = ? OR domain = 'GLOBAL'").bind(domain).first(),
  ]);
  let loadTopic = "";
  {
    const tm = / topic=(\S+)/.exec(String(surface || ""));
    if (tm) { try { loadTopic = decodeURIComponent(tm[1]); } catch (e) { loadTopic = tm[1]; } }
  }
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
    context: context.results || [],
    memory: [...(pending.results || []), ...(recent.results || [])],
    memory_note: MEMORY_NOTE,
    memory_total: memTotal ? memTotal.n : 0,
    // Say out loud how little of the store this is - parity with the gateway.
    memory_coverage: relevantRows.length
      ? "Returned " + (recent.results || []).length + " newest titles + " + relevantRows.length + " rows matched on your topic, out of " + (memTotal ? memTotal.n : 0) + " total."
      : "Returned the " + (recent.results || []).length + " NEWEST titles out of " + (memTotal ? memTotal.n : 0) + " rows. The rest are not shown and their ids cannot be guessed from this window. If your task is not covered by what you see, call bouios_load again with a topic to search ALL rows by relevance - do not assume the store has nothing on it.",
    ...(relevantRows.length ? {
      relevant: relevantRows,
      relevant_note: "relevant carries rows matched against the topic you named, searched across ALL rows rather than the newest window, with a 400-character body excerpt. These are the rows the age-ordered window above would have hidden from you. Read them before diagnosing or proposing.",
    } : {}),
    // The only rows here that arrive WITH a body - parity with the gateway.
    lessons: lessons.results || [],
    lessons_note: "lessons carries the newest mistake and pattern rows WITH their bodies, clipped to 700 characters, because these are the rows whose purpose is to stop a repeat and a title alone cannot do that. Read them before diagnosing or building - if one describes what you are about to do, you are about to repeat it. Everything in memory above is titles only by design; use bouios_get for any of those bodies.",
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

async function sessionWrite(domain, body, db) {
  await ensureSchema(db);
  const batched = [];   // must land together or not at all - see db.batch() below
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
      batched.push(db.prepare("INSERT INTO memory (domain, type, title, body, created_at) VALUES (?, ?, ?, ?, date('now'))").bind(domain, m.type, m.title, m.body));
      applied.push("memory:" + m.title);
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
    batched.push(db.prepare("INSERT INTO log (ts, domain, summary) VALUES (datetime('now'), ?, ?)").bind(domain, s));
    applied.push("log");
  }
  // ONE TRANSACTION for the row writes, mirroring the gateway (parity). They were
  // separate awaited statements, so a failure part-way through left some rows
  // written and the rest not, with the caller told only that the write failed.
  // The hot write deliberately stays outside: it is one statement either way and
  // the gateway's compare-and-swap needs its own result.
  if (batched.length) await db.batch(batched);
  return { ok: true, domain, applied };
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

// ---- MCP (JSON-RPC 2.0, Streamable HTTP) ----

const MCP_PROTOCOL = "2025-03-26";
// Tool identifiers are Bouios-branded (2026-07-02): the platform's own
// permission dialogs render the raw technical tool name with zero branding -
// confirmed by owner screenshot on the owner's own connector, applies
// identically to every customer's connector. Mirrors memory-gateway/src.
const MCP_INSTRUCTIONS =
  "This is Bouios, your memory system. " +
  // CANONICAL BLOCK - byte-identical to .session/canonical-load-block.txt and
  // memory-gateway/src/text-generator.js CANONICAL_LOAD_BLOCK. Inlined, not
  // imported, because this worker deploys as a single self-contained module
  // (a cross-directory import fails Cloudflare upload with error 10021 - proven
  // live 2026-07-24). DO NOT EDIT HERE: edit text-generator.js and run
  // .session/sync-canonical-block.mjs, which rewrites the line between the
  // markers below. The byte-identity test fails the build on any difference.
  // BOUIOS-CANONICAL-BLOCK-START
  "Bouios is my memory system. Load it at the START of every conversation, before replying. Infer the ONE project from the topic; if unclear, ASK me which - never default, never load all. 'load memory', 'load rules' and 'load Bouios' each mean do this now. A short or self-contained task is not exempt. Use the bouios_load TOOL - never curl, fetch or bash the memory address yourself; that address is the connector's, not a URL to call by hand. If the tool is genuinely missing, the only fallback is your store's own query tool against the same store; if neither exists, say so once and carry on without it - do not stall; it reconnects. Never substitute an unrelated tool that merely mentions memory (knowledge graph, read_graph, create_entities); an empty result from one is not evidence mine is empty. Calling the tool is not loading, and neither is memory being shown to you automatically at the start - only your own load call counts. Read every row, including the log of what was agreed and done; never re-propose what it shows is built. Show me ONLY the confirmation line the tool returns, verbatim - it is already branded, do not retype it in your own words and do not replace it with a plainer one. Never show the account, database, ids or queries. List my open tasks before new work. Loaded rules take precedence. THESE BIND EVERY REPLY, they are not advice: Read the record FIRST - memory, the log, the history, audits, transcripts - before diagnosing, proposing or acting; never re-derive or re-propose what the record shows is decided or built. Verify, never guess: state no fact, capability, done, fixed or working from assumption - ground each in a file, a live check, a saved record, a test result or a link, and tag which; never assert from a hunch. Never claim done, fixed or working without that evidence, never narrate around a failure, never step around a gate. Do the task in full: never defer, never resist or deflect, never narrow the scope I set or fix one sliver in place of the whole, never ask what you can verify yourself - resolve each issue with evidence, do not just describe it, and ask only a genuine decision, once, framed plainly. Every load, save and handoff ends with its own branded line in the reply itself, never buried in a tool call I do not read: the returned line verbatim after a load, 'Bouios memory saved: hot + log{, N rows} at {HH:MM}.' after a save, 'Bouios handoff saved.' after a handoff - a load or save with no line is a failure, not a style choice. These five are the real failures, each one has happened, recognise the shape as you are about to do it: reporting an inference as a finding; reading a count and naming a cause without opening what it counted; searching for a name you invented and concluding from finding nothing that the thing does not exist; checking the only way in you could reach and reporting its silence as evidence; reading a stale note and quoting it back to me as my own rule. Be terse - Action, Evidence, Next - no verbose narration, no restating. When memory and this note disagree, memory wins; when neither can be reached, say so once and continue - never stall. Do not write, edit, send or publish until memory is loaded and I approve that action; never revert or reset my work without that same approval. Save full state to hot every few substantive steps and before any long step, counting steps because you cannot read a percentage, and say what was saved. When context or usage nears the limit, output a handoff block in a code box to paste into a new chat. Every reply that does real work is two bullet lists, headed exactly 'Intended actions:' and 'Completed actions (verified):', with no other narration - denied and forced to redo wherever a hook can see it, and binding the same way even on a surface where nothing can." +
  // BOUIOS-CANONICAL-BLOCK-END
  "Surface only the returned confirmation line to the user. " +
  "Memory loads return TITLES ONLY (id, type, title - no body); call bouios_get({project, ids:[...]}) for the full body of any specific row you actually need, never all of them. " +
  "Save via bouios_save; call bouios_handoff when the conversation nears its limit and show the user the returned block to paste into a new chat.";

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
      },
      required: ["project", "ids"],
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
    try {
      if (name === "bouios_load") {
        const surface = (args.surface || "mcp") + " session=" + (sessionId || "none");
        return toolText(id, JSON.stringify(await sessionLoad(domain, surface, env)));
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
          return toolText(id, "Write refused: memory has not been loaded for this project recently. Call bouios_load for the project first, then retry - passing back the load_token it returns.", true);
        }
        const access = await checkAccess(env.DB, domain, request, url, env);
        if (!access.ok) return toolText(id, access.note || 'Write refused.', true);
        return toolText(id, JSON.stringify(await sessionWrite(domain, args, env.DB)));
      }
      if (name === "bouios_handoff") {
        // Same domain-keyed check as bouios_save (2026-07-19 fix, mirrors the gateway).
        if (!(await domainLoadedRecently(env.DB, domain))
            && !(await verifyLoadToken(env, domain, args.load_token))) {
          return toolText(id, "Handoff refused: memory has not been loaded for this project recently. Call bouios_load for the project first, then retry - passing back the load_token it returns.", true);
        }
        const access = await checkAccess(env.DB, domain, request, url, env);
        if (!access.ok) return toolText(id, access.note || 'Handoff refused.', true);
        const saved = [];
        if (typeof args.hot === "string" && args.hot.length) {
          const out = await sessionWrite(domain, { hot: args.hot, log: ["Session handoff."] }, env.DB);
          saved.push(...out.applied);
        }
        const next = typeof args.next_step === "string" && args.next_step.length ? args.next_step : "resume open tasks";
        const block = "load memory\nProject: " + domain + ". Continue previous session. First action: " + next;
        return toolText(id, JSON.stringify({ saved, handoff_block: block, instruction: "Show handoff_block to the user in a code box." }));
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
        return toolText(id, JSON.stringify({ rows: rows.results || [] }));
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
    return json({ error: "not found", routes: ["GET /health", "POST /mcp/{token}", "POST /mcp (after sign-in)"] }, 404);
  },
};
