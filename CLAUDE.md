# Memory Gateway (Bouios)

Cloudflare Worker fronting the `memory-vault` D1 database.
Deploy: `npm run deploy` (requires `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`).

## Sentinel invariant

`~/.claude/d1-loaded` is set **only** by `.session/session-start.sh` on HTTP 200 from `/session/start`.
No other code path may arm it (no PostToolUse touch, no pattern-match escape).

- `pre-tool-enforcement.sh` denies D1 writes and reads when the sentinel is absent.
- `session-start.sh` clears the sentinel on non-200 or empty response.

## Auth model

- Owner: `Authorization: Bearer <BEARER_TOKEN>` — exempt from `REQUIRE_LICENCE` gate.
- Customer: `POST /mcp/:token` — full licence validation via `requestLicence()`.

The bearer path bypasses the licence gate in `/session/start` and `/session/write`
via `ownerLicence = { required: false, valid: false, tier: "free", sub: null }`.
This must never be applied to the `/mcp/:token` route.

## Load size

`sessionStart()` caps context rows at 100 (most recent), memory at 40 + all pending, log at 25.
