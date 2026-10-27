#!/bin/bash
# install-customer-hooks.sh <licence> [worker-url] [worker-key] - put the licence on THIS machine and wire the
# session-checks fetch into Claude Code (2026-10-25, BOUIOS decision 173).
#
# Called by install.sh and install-rest.sh when LICENCE is given. It stores the licence
# as BOUIOS_LICENCE in ~/.claude/bouios.env (readable by you only, beside the lines the
# transcript hook keeps there). With the worker address and key as well (the installers pass
# them) it stores those as BOUIOS_URL and BOUIOS_TOKEN: the per-message record lookup in the
# served hook asks YOUR worker with them, so it works whether or not transcript storage was
# set up. They are never sent anywhere else, copies fetch-customer-hooks.sh to ~/.claude, adds it as a
# SessionStart hook in ~/.claude/settings.json beside whatever is there and never twice,
# and runs it once. The checks themselves are not in this repo or on your disk until a
# licensed fetch brings them; without a valid licence the fetch installs nothing.
# Locked by .session/test-customer-hooks-fetch.sh.
set -u
lic="${1:-}"; wurl="${2:-}"; wkey="${3:-}"
if [ -z "$lic" ]; then
  echo "  Session checks: skipped (no licence given)."
  exit 0
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "  Session checks: skipped (python3 is needed to update Claude Code settings)."
  exit 0
fi
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dir="$HOME/.claude"
mkdir -p "$dir"
cp "$here/fetch-customer-hooks.sh" "$dir/bouios-fetch-hooks.sh" && chmod +x "$dir/bouios-fetch-hooks.sh"
( umask 077
  drop='^BOUIOS_LICENCE='; [ -n "$wurl" ] && [ -n "$wkey" ] && drop='^(BOUIOS_LICENCE|BOUIOS_URL|BOUIOS_TOKEN)='
  [ -f "$dir/bouios.env" ] && grep -Ev "$drop" "$dir/bouios.env" > "$dir/bouios.env.tmp" || : > "$dir/bouios.env.tmp"
  printf 'BOUIOS_LICENCE=%q\n' "$lic" >> "$dir/bouios.env.tmp"
  [ -n "$wurl" ] && [ -n "$wkey" ] && printf 'BOUIOS_URL=%q\nBOUIOS_TOKEN=%q\n' "$wurl" "$wkey" >> "$dir/bouios.env.tmp"
  mv "$dir/bouios.env.tmp" "$dir/bouios.env" )
chmod 600 "$dir/bouios.env"
python3 - "$dir/settings.json" <<'PY'
import json, os, sys
p = sys.argv[1]
try:
    s = json.load(open(p)) if os.path.exists(p) else {}
except Exception:
    print("  Session checks: ~/.claude/settings.json is not valid JSON - left untouched; add the SessionStart hook by hand.")
    sys.exit(0)
cmd = "bash ~/.claude/bouios-fetch-hooks.sh"
groups = s.setdefault("hooks", {}).setdefault("SessionStart", [])
if not any(h.get("command") == cmd for g in groups for h in g.get("hooks", [])):
    groups.append({"hooks": [{"type": "command", "command": cmd}]})
with open(p, "w") as f:
    json.dump(s, f, indent=2)
PY
bash "$dir/bouios-fetch-hooks.sh"
echo "  Session checks: fetched from Bouios at the start of every Claude Code session while your licence is valid."
