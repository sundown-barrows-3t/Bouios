-- Personal memory schema. Rules are served by the Bouios service at memory-gateway.bouios.com, not stored here.
-- This is applied automatically on first use; manual re-run is safe (CREATE IF NOT EXISTS).

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
CREATE TABLE IF NOT EXISTS hooks (
  name       TEXT PRIMARY KEY,
  content    TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS usage (
  sub        TEXT    NOT NULL,
  window     TEXT    NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT    NOT NULL,
  PRIMARY KEY (sub, window)
);
