# Your memory for Claude

This is a small Cloudflare Worker that gives Claude a persistent memory that
follows you across conversations. It runs entirely on your own Cloudflare
account and your data stays in your own database.

Deploy: push to `main`. Cloudflare auto-deploys the worker on push.

## What it does

- `GET /health` — liveness check.
- `POST /mcp/{your-token}` — the connector endpoint Claude talks to
  (`memory_load`, `memory_write`, `session_handoff`), protected by your
  `BEARER_TOKEN`.

Your memory (working state, notes, and history) is stored in your own
`memory-vault` database. Writes are refused until memory has been loaded in a
session, so nothing is saved before your context is loaded.

Keep your `BEARER_TOKEN` private — it is the password to your memory.
