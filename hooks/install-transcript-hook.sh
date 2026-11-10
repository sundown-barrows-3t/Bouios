#!/bin/bash
# install-transcript-hook.sh <service-url> <bearer-token> - wire the transcript
# backup into THIS machine's Claude Code.
#
# Called by the setup once the memory service answers and has
# transcript storage. It puts transcript-upload.sh in ~/.claude, writes the
# service address and token to ~/.claude/bouios.env (readable by you only), and
# adds the script as a Stop and a PreCompact hook in ~/.claude/settings.json -
# beside whatever is there, never replacing it, and never twice.
set -u
url="${1:-}"; tok="${2:-}"
if [ -z "$url" ] || [ -z "$tok" ]; then
  echo "  Transcript backup: skipped (no worker address or token)."
  exit 0
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "  Transcript backup: skipped (python3 is needed to update Claude Code settings)."
  exit 0
fi
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dir="$HOME/.claude"
mkdir -p "$dir"
cp "$here/transcript-upload.sh" "$dir/bouios-transcript-upload.sh" && chmod +x "$dir/bouios-transcript-upload.sh"
# The licence line install-customer-hooks.sh keeps in the same file survives a re-run.
( umask 077; { [ -f "$dir/bouios.env" ] && grep '^BOUIOS_LICENCE=' "$dir/bouios.env"; printf 'BOUIOS_URL=%q\nBOUIOS_TOKEN=%q\n' "$url" "$tok"; } > "$dir/bouios.env.tmp"; mv "$dir/bouios.env.tmp" "$dir/bouios.env" )
chmod 600 "$dir/bouios.env"
python3 - "$dir/settings.json" <<'PY'
import json, os, sys
p = sys.argv[1]
try:
    s = json.load(open(p)) if os.path.exists(p) else {}
except Exception:
    print("  Transcript backup: ~/.claude/settings.json is not valid JSON - left untouched; add the hook by hand.")
    sys.exit(0)
cmd = "~/.claude/bouios-transcript-upload.sh"
hooks = s.setdefault("hooks", {})
for ev in ("Stop", "PreCompact"):
    groups = hooks.setdefault(ev, [])
    if not any(h.get("command") == cmd for g in groups for h in g.get("hooks", [])):
        groups.append({"hooks": [{"type": "command", "command": cmd}]})
with open(p, "w") as f:
    json.dump(s, f, indent=2)
PY
echo "  Transcript backup: Claude Code sessions on this machine now save their transcript to your own storage."
