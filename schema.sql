-- Personal memory schema. Rules are served by our gateway, not stored here.
-- The Worker creates these tables automatically on first use (CREATE TABLE
-- IF NOT EXISTS), so you never need to run this by hand. Kept here for
-- transparency, and matches src/index.js's SCHEMA array exactly - if this
-- file and that array ever disagree, the array is what actually runs.

CREATE TABLE IF NOT EXISTS hot (
  domain     TEXT PRIMARY KEY,
  state      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS context (
  domain     TEXT NOT NULL,
  key        TEXT NOT NULL,
  content    TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (domain, key)
);
CREATE TABLE IF NOT EXISTS memory (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  domain     TEXT    NOT NULL,
  type       TEXT    NOT NULL CHECK (type IN ('pattern','mistake','decision','pending')),
  title      TEXT    NOT NULL,
  body       TEXT    NOT NULL,
  created_at TEXT    NOT NULL,
  source     TEXT
);
CREATE TABLE IF NOT EXISTS log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT NOT NULL,
  domain  TEXT NOT NULL,
  summary TEXT NOT NULL
);
