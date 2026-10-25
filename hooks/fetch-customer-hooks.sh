#!/bin/bash
# fetch-customer-hooks.sh - install the current session checks from Bouios into
# ~/.claude (2026-10-25, BOUIOS decision 173: the checks are Bouios's control plane,
# served per session to a licensed customer and never committed to the customer's own
# store; a lapsed licence leaves the customer on data-only).
#
# Run by SessionStart (the public Bouios repo's .claude/settings.json and the user-level
# entry install-customer-hooks.sh adds). It carries no product logic: it asks the
# gateway's licensed route for a list of files with a sha256 each, fetches only the ones
# that changed, checks that each one parses, and installs them. What it does and does
# not do, each locked by .session/test-customer-hooks-fetch.sh:
#   - WITHOUT a valid licence it installs nothing. No licence at all, or a licence the
#     gateway refuses, leaves ~/.claude as it was; the repo's own PreToolUse stub then
#     refuses every edit because ~/.claude/pre-tool-enforcement.sh is absent.
#   - A licence the gateway REFUSES (403) also takes back what an earlier licensed fetch
#     installed (only the files and settings entries listed in the marker): a lapsed
#     licence is data-only. A gateway that cannot be reached, or answers 5xx or 429, never
#     removes anything: an outage degrades to the last good copy, not to a dead product.
#   - It does nothing at all in an owner session (CLAUDE_OWNER, ~/.claude/owner or
#     GATEWAY_BEARER_TOKEN), and never overwrites a ~/.claude/pre-tool-enforcement.sh it
#     did not install.
#   - It sends the licence in a header read from stdin, never on a command line.
#   - The marker ~/.claude/bouios-customer is written last and only after every file
#     was verified and installed; the scripts read it to switch on customer mode.
# The licence comes from BOUIOS_LICENCE, LICENCE, or BOUIOS_LICENCE in ~/.claude/bouios.env.
set -u
dir="${HOME}/.claude"
mkdir -p "$dir" 2>/dev/null || exit 0
note() { echo "[bouios] $*"; }

if [ -n "${CLAUDE_OWNER:-}" ] || [ -f "$dir/owner" ] || [ -n "${GATEWAY_BEARER_TOKEN:-}" ]; then exit 0; fi

lic="${BOUIOS_LICENCE:-${LICENCE:-}}"
if [ -z "$lic" ] && [ -f "$dir/bouios.env" ]; then
  lic=$( ( . "$dir/bouios.env" >/dev/null 2>&1; printf '%s' "${BOUIOS_LICENCE:-}" ) 2>/dev/null )
fi
if [ -z "$lic" ]; then
  note "session checks not installed: no licence found (set BOUIOS_LICENCE, or add it to ~/.claude/bouios.env)."
  exit 0
fi

marker="$dir/bouios-customer"
if [ -f "$dir/pre-tool-enforcement.sh" ] && [ ! -f "$marker" ]; then
  note "session checks not installed: ~/.claude/pre-tool-enforcement.sh is already there and was not installed by this script."
  exit 0
fi

# Several repos can start at once; one fetch per minute is plenty.
lock="$dir/bouios-customer-fetched"
if [ -f "$lock" ] && [ -f "$marker" ]; then
  age=$(( $(date +%s) - $(stat -c %Y "$lock" 2>/dev/null || echo 0) ))
  [ "$age" -ge 0 ] && [ "$age" -lt 60 ] && exit 0
fi

base="${BOUIOS_HOOKS_URL:-https://memory-gateway.syndakat.com}"
command -v curl >/dev/null 2>&1 || exit 0
command -v python3 >/dev/null 2>&1 || { note "session checks not installed: python3 is needed."; exit 0; }
tmp=$(mktemp -d 2>/dev/null) || exit 0
trap 'rm -rf "$tmp"' EXIT

# curl reads the header from stdin (-K -), so the licence never shows in a process list.
get() { # $1 = path, $2 = output file -> prints the http code
  printf 'header = "x-licence: %s"\n' "$lic" | curl -sS --max-time 8 -K - -o "$2" -w '%{http_code}' "$base$1" 2>/dev/null || echo 000
}

code=$(get /customer-hooks "$tmp/manifest.json")
case "$code" in
  200) ;;
  403)
    if [ -f "$marker" ]; then
      python3 - "$dir" "$marker" <<'PY'
import json, os, sys
d, m = sys.argv[1], sys.argv[2]
try:
    meta = json.load(open(m))
except Exception:
    meta = {}
for n in meta.get("files", []):
    try: os.remove(os.path.join(d, n))
    except OSError: pass
sp = os.path.join(d, "settings.json")
try:
    s = json.load(open(sp))
    cmds = set(meta.get("commands", []))
    for ev in list(s.get("hooks", {})):
        groups = s["hooks"][ev]
        for g in groups:
            g["hooks"] = [h for h in g.get("hooks", []) if h.get("command") not in cmds]
        s["hooks"][ev] = [g for g in groups if g.get("hooks")]
        if not s["hooks"][ev]: del s["hooks"][ev]
    json.dump(s, open(sp, "w"), indent=2)
except Exception:
    pass
try: os.remove(m)
except OSError: pass
PY
      note "licence not valid: the session checks were taken off this machine (memory itself is untouched)."
    else
      note "session checks not installed: the licence was not accepted."
    fi
    exit 0 ;;
  *) exit 0 ;;
esac

files=$(python3 -c 'import json,sys
for f in json.load(open(sys.argv[1])).get("files", []): print(f["name"], f["sha256"])' "$tmp/manifest.json" 2>/dev/null) || exit 0
[ -n "$files" ] || exit 0

installed=""
while read -r name sha; do
  case "$name" in
    pre-tool-enforcement.sh|stop-reasoning-gate.sh|reasoning-gate-analyse.py|user-prompt-gate.sh) dest="$dir/$name" ;;
    settings.json|enforcement.json) dest="$tmp/$name.in" ;;
    *) continue ;;
  esac
  have=""
  [ -f "$dest" ] && have=$(sha256sum "$dest" 2>/dev/null | cut -d' ' -f1)
  if [ "$have" != "$sha" ] || [ "${dest#$tmp}" != "$dest" ]; then
    [ "$(get "/customer-hooks/$name" "$tmp/$name")" = 200 ] || { note "a session check could not be fetched; nothing was changed."; exit 0; }
    got=$(sha256sum "$tmp/$name" | cut -d' ' -f1)
    [ "$got" = "$sha" ] || { note "a session check failed its checksum; nothing was changed."; exit 0; }
    case "$name" in
      *.sh) bash -n "$tmp/$name" 2>/dev/null || { note "a session check did not parse; nothing was changed."; exit 0; } ;;
      *.py) python3 -c 'import ast,sys; ast.parse(open(sys.argv[1]).read())' "$tmp/$name" 2>/dev/null || { note "a session check did not parse; nothing was changed."; exit 0; } ;;
      *.json) python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$tmp/$name" 2>/dev/null || { note "a session check did not parse; nothing was changed."; exit 0; } ;;
    esac
  fi
  installed="$installed $name"
done <<< "$files"

for need in pre-tool-enforcement.sh stop-reasoning-gate.sh reasoning-gate-analyse.py user-prompt-gate.sh settings.json enforcement.json; do
  case " $installed " in *" $need "*) ;; *) note "the list of session checks was incomplete; nothing was changed."; exit 0 ;; esac
done

for name in pre-tool-enforcement.sh stop-reasoning-gate.sh reasoning-gate-analyse.py user-prompt-gate.sh; do
  if [ -f "$tmp/$name" ]; then mv "$tmp/$name" "$dir/$name.new" && chmod +x "$dir/$name.new" && mv "$dir/$name.new" "$dir/$name"; fi
done

python3 - "$dir" "$marker" "$tmp/settings.json" "$tmp/enforcement.json" <<'PY'
import json, os, sys, time
d, marker, frag, enf = sys.argv[1:5]
try:
    meta = json.load(open(marker))
except Exception:
    meta = {}
files = ["pre-tool-enforcement.sh", "stop-reasoning-gate.sh", "reasoning-gate-analyse.py", "user-prompt-gate.sh"]
# enforcement.json: ours only when absent or written by an earlier fetch; never over the customer's own.
ep = os.path.join(d, "enforcement.json")
if (not os.path.exists(ep)) or "enforcement.json" in meta.get("files", []):
    with open(ep, "w") as f: f.write(open(enf).read())
    files.append("enforcement.json")
# settings.json: add the hook entries, beside whatever is there, never twice.
sp = os.path.join(d, "settings.json")
try:
    s = json.load(open(sp)) if os.path.exists(sp) else {}
except Exception:
    s = None
cmds = list(meta.get("commands", []))
if s is not None:
    add = json.load(open(frag)).get("hooks", {})
    hooks = s.setdefault("hooks", {})
    for ev, groups in add.items():
        have = hooks.setdefault(ev, [])
        for g in groups:
            for h in g.get("hooks", []):
                if not any(x.get("command") == h.get("command") for gg in have for x in gg.get("hooks", [])):
                    have.append({**{k: v for k, v in g.items() if k != "hooks"}, "hooks": [h]})
                    if h.get("command") not in cmds: cmds.append(h.get("command"))
    json.dump(s, open(sp, "w"), indent=2)
json.dump({"files": files, "commands": cmds, "at": int(time.time())}, open(marker, "w"))
PY
touch "$lock"
note "session checks are installed on this machine (licensed)."
exit 0
