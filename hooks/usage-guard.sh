#!/bin/bash
# usage-guard.sh - the context-size note and the work-spawn ceiling for a customer
# install.
#
# WHY. Most of the spend in long sessions is re-reading a huge conversation on every
# turn. This hook adds a note at a size warning and, if you switch it on, a ceiling on
# starting MORE work on top of a full context. It is small enough to read in one sitting.
#
# WHAT IT DOES, as a PreToolUse hook (stdin is the hook input as JSON):
#   - Reads the size of the conversation from the transcript: the tokens the last
#     assistant turn read (input + cache creation + cache read).
#   - At or above BOUIOS_CONTEXT_WARN (default 200000) it adds ONE short note to the
#     model's context, again only after BOUIOS_CONTEXT_NOTE_EVERY (default 50000) more
#     tokens of growth. The note says to finish the step, save, and continue in a
#     fresh session. It never stops anything.
#   - At or above BOUIOS_CONTEXT_STOP (default 300000), and ONLY when
#     BOUIOS_REFUSE_NEW_WORK=1 is set, it refuses the tools that start more work on
#     top of that context (Agent, Workflow, create_session, send_message). Off by
#     default: the refusal stopped small sub-agents that
#     run in their own contexts and so cut the cost it meant to cut.
#   - A sub-agent's transcript is exempt, and so is every other tool: memory tools,
#     Read, Edit, Bash and git all pass untouched, so a session can always save and
#     finish.
#
# FAILS OPEN, ALWAYS. No jq, no transcript, an unreadable file, a number that does not
# parse: it prints nothing and exits 0. It never blocks a session by accident.
set -u
input=$(cat)
command -v jq >/dev/null 2>&1 || exit 0
tp=$(printf '%s' "$input" | jq -r '.transcript_path // ""' 2>/dev/null)
tool=$(printf '%s' "$input" | jq -r '.tool_name // ""' 2>/dev/null)
[ -n "$tp" ] && [ -f "$tp" ] || exit 0
case "$tp" in */subagents/*) exit 0 ;; esac

num() { case "${1:-}" in ''|*[!0-9]*) printf '%s' "$2" ;; *) printf '%s' "$1" ;; esac; }
WARN=$(num "${BOUIOS_CONTEXT_WARN:-}" 200000)
STOP=$(num "${BOUIOS_CONTEXT_STOP:-}" 300000)
EVERY=$(num "${BOUIOS_CONTEXT_NOTE_EVERY:-}" 50000)

size=$(stat -c%s "$tp" 2>/dev/null || echo 0)
ctx=""
for n in 400000 4000000; do
  ctx=$(tail -c "$n" "$tp" 2>/dev/null | tail -n 200 | jq -Rrn '
    [inputs | try fromjson catch empty] | map(select(type=="object"))
    | map(select((.isSidechain // false) == false))
    | map(select(.message?.role? == "assistant" and (.message?.model? // "") != "<synthetic>" and .message?.usage? != null))
    | map((.message.usage.input_tokens // 0) + (.message.usage.cache_creation_input_tokens // 0) + (.message.usage.cache_read_input_tokens // 0))
    | map(select(. > 0)) | if length == 0 then empty else .[-1] end' 2>/dev/null)
  case "$ctx" in ''|*[!0-9]*) ctx="" ;; *) break ;; esac
  [ "$size" -le "$n" ] 2>/dev/null && break
done
[ -n "$ctx" ] || exit 0
[ "$ctx" -ge "$WARN" ] 2>/dev/null || exit 0

if [ "$ctx" -ge "$STOP" ] && [ "${BOUIOS_REFUSE_NEW_WORK:-}" = "1" ]; then
  case "$tool" in
    Agent|Workflow|*__create_session|*__send_message)
      jq -n --arg r "This session is full: the conversation is $ctx tokens, over the stop limit set for this machine, so starting more work here is refused. Say so in one line. Saving, reading, editing and git are not blocked." \
        '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
      exit 0 ;;
  esac
fi

state="${BOUIOS_STATE_DIR:-$HOME/.claude}/bouios-context-note-$(basename "$tp" | tr -cd 'A-Za-z0-9_-' | head -c 80)"
last=$(cat "$state" 2>/dev/null || echo 0)
case "$last" in ''|*[!0-9]*) last=0 ;; esac
[ "$ctx" -lt "$last" ] && last=0        # the conversation shrank: a compaction or a fresh start
if [ "$last" -eq 0 ] || [ "$ctx" -ge $(( last + EVERY )) ]; then
  printf '%s\n' "$ctx" > "$state" 2>/dev/null || true
  jq -n --arg c "Context is $ctx tokens; every step now re-reads all of it. Finish the current step, save your working state, and continue in a fresh session." \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:$c}}'
fi
exit 0
