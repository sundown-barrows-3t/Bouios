-- memory-gateway schema (reference copy).
-- The Worker creates these tables automatically on first use, so you do not
-- need to run this by hand. Kept here for transparency and manual re-runs.

CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS hot (
  domain TEXT PRIMARY KEY, state TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS context (
  domain TEXT NOT NULL, key TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (domain, key)
);
CREATE TABLE IF NOT EXISTS memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT, domain TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('pattern','mistake','decision','pending')),
  title TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, source TEXT
);
CREATE TABLE IF NOT EXISTS log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, domain TEXT NOT NULL, summary TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS hooks (
  name TEXT PRIMARY KEY, content TEXT NOT NULL, updated_at TEXT NOT NULL
);
