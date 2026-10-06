#!/bin/bash
# transcript-upload.sh - keep this session's transcript in YOUR OWN Cloudflare
# storage.
#
# It runs as a Claude Code Stop hook and a PreCompact hook. It reads the hook
# input, finds the transcript file, and PUTs it to
# $BOUIOS_URL/transcript/<session>.jsonl with your bearer token - your worker,
# your bucket; nothing goes anywhere else. A re-upload replaces the stored copy
# with the longer one. To avoid re-sending on every turn it uploads when the
# file has grown by 200KB or 30 minutes have passed since the last upload, and
# always before a compaction.
#
# It NEVER blocks a session: every path exits 0, and each outcome is one line in
# ~/.claude/transcript-status.log so a dead backup is visible, not silent.
set -u
input=$(cat)
ENV_FILE="${BOUIOS_ENV_FILE:-$HOME/.claude/bouios.env}"
[ -f "$ENV_FILE" ] && . "$ENV_FILE"
LOG="$HOME/.claude/transcript-status.log"
[ -n "${BOUIOS_URL:-}" ] && [ -n "${BOUIOS_TOKEN:-}" ] || exit 0
command -v jq >/dev/null 2>&1 && command -v curl >/dev/null 2>&1 || exit 0

tp=$(printf '%s' "$input" | jq -r '.transcript_path // ""' 2>/dev/null)
event=$(printf '%s' "$input" | jq -r '.hook_event_name // ""' 2>/dev/null)
[ -n "$tp" ] && [ -f "$tp" ] || exit 0
name=$(basename "$tp")
case "$name" in *.jsonl) ;; *) name="$name.jsonl" ;; esac
printf '%s' "$name" | grep -qE '^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$' || exit 0

size=$(stat -c%s "$tp" 2>/dev/null || stat -f%z "$tp" 2>/dev/null || echo 0)
mark="$HOME/.claude/transcript-sent-$name"
if [ "$event" != "PreCompact" ] && [ -f "$mark" ]; then
  last=$(cat "$mark" 2>/dev/null || echo 0)
  age=$(( $(date +%s) - $(stat -c %Y "$mark" 2>/dev/null || stat -f %m "$mark" 2>/dev/null || date +%s) ))
  [ $(( size - last )) -lt 204800 ] && [ "$age" -lt 1800 ] && exit 0
fi

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 60 -X PUT \
  -H "Authorization: Bearer $BOUIOS_TOKEN" -H "Content-Type: application/x-ndjson" \
  --data-binary "@$tp" "${BOUIOS_URL%/}/transcript/$name" 2>/dev/null)
[ -n "$code" ] || code=000
printf '%s %s %s size=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$code" "$name" "$size" >> "$LOG" 2>/dev/null
[ "$code" = "200" ] && printf '%s' "$size" > "$mark" 2>/dev/null
exit 0
