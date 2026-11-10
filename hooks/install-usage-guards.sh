#!/bin/bash
# install-usage-guards.sh - wire the usage guards into THIS machine's Claude Code
# as part of the customer hook set.
#
# Called by the setup beside the transcript hook. It puts
# usage-guard.sh in ~/.claude and, in ~/.claude/settings.json, beside whatever is there
# and never twice:
#   - adds the script as a PreToolUse hook (the context-size note and, only if you set
#     BOUIOS_REFUSE_NEW_WORK=1, the ceiling on starting more work in a full session);
#   - sets CLAUDE_CODE_SUBAGENT_MODEL=sonnet when the setting is not there yet, so a
#     sub-agent that names no model runs on a cheaper one than the session. A value you
#     already chose is never changed.
# Needs python3 to edit settings.json; without it, or with a settings file that is not
# valid JSON, nothing is changed and one line says so.
set -u
if ! command -v python3 >/dev/null 2>&1; then
  echo "  Usage guards: skipped (python3 is needed to update Claude Code settings)."
  exit 0
fi
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dir="$HOME/.claude"
mkdir -p "$dir"
cp "$here/usage-guard.sh" "$dir/bouios-usage-guard.sh" && chmod +x "$dir/bouios-usage-guard.sh"
python3 - "$dir/settings.json" <<'PY'
import json, os, sys
p = sys.argv[1]
try:
    s = json.load(open(p)) if os.path.exists(p) else {}
except Exception:
    print("  Usage guards: ~/.claude/settings.json is not valid JSON - left untouched; add the hook by hand.")
    sys.exit(0)
cmd = "~/.claude/bouios-usage-guard.sh"
groups = s.setdefault("hooks", {}).setdefault("PreToolUse", [])
if not any(h.get("command") == cmd for g in groups for h in g.get("hooks", [])):
    groups.append({"hooks": [{"type": "command", "command": cmd}]})
env = s.setdefault("env", {})
if "CLAUDE_CODE_SUBAGENT_MODEL" not in env:
    env["CLAUDE_CODE_SUBAGENT_MODEL"] = "sonnet"
with open(p, "w") as f:
    json.dump(s, f, indent=2)
PY
echo "  Usage guards: Claude Code on this machine now notes a very large conversation and runs sub-agents on a cheaper model by default."
