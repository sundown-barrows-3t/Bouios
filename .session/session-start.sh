#!/bin/bash
# SessionStart hook: load full memory state from gateway and refresh hook scripts.
# Arms the d1-loaded sentinel ONLY on HTTP 200 with a non-empty response body.
GATEWAY_URL="https://memory-gateway.syndakat.com"
BEARER_TOKEN="${GATEWAY_BEARER_TOKEN:-$(cat ~/.claude/gateway-token 2>/dev/null)}"
CF_CLIENT_ID="${CF_ACCESS_CLIENT_ID:-$(cat ~/.claude/cf-access-client-id 2>/dev/null)}"
CF_CLIENT_SECRET="${CF_ACCESS_CLIENT_SECRET:-$(cat ~/.claude/cf-access-client-secret 2>/dev/null)}"
SENTINEL=~/.claude/d1-loaded
DOMAIN="${CLAUDE_MEMORY_DOMAIN:-AI}"

if [ -z "$BEARER_TOKEN" ]; then
  echo "[Memory] Gateway bearer token not set. Memory not loaded — sentinel cleared."
  rm -f "$SENTINEL"
  exit 0
fi

AUTH_HEADERS=(-H "Authorization: Bearer $BEARER_TOKEN")
[ -n "$CF_CLIENT_ID" ] && AUTH_HEADERS+=(-H "CF-Access-Client-Id: $CF_CLIENT_ID")
[ -n "$CF_CLIENT_SECRET" ] && AUTH_HEADERS+=(-H "CF-Access-Client-Secret: $CF_CLIENT_SECRET")

TMPFILE=$(mktemp /tmp/bouios-load.XXXXXX.json)
HTTP_STATUS=$(curl -s -o "$TMPFILE" -w "%{http_code}" --max-time 10 \
  "${AUTH_HEADERS[@]}" \
  "${GATEWAY_URL}/session/start?domain=${DOMAIN}" 2>/dev/null) || HTTP_STATUS="000"
BODY=$(cat "$TMPFILE" 2>/dev/null)
rm -f "$TMPFILE"

if [ "$HTTP_STATUS" = "200" ] && [ -n "$BODY" ]; then
  echo "$BODY"
  touch "$SENTINEL"
else
  echo "[Memory] Gateway load failed (HTTP $HTTP_STATUS). Memory not loaded — sentinel cleared."
  rm -f "$SENTINEL"
fi

HOOKS=("pre-tool-enforcement.sh" "post-tool-log.sh" "stop-hook-git-check.sh")
for hook in "${HOOKS[@]}"; do
  script=$(curl -sf --max-time 5 "${AUTH_HEADERS[@]}" "$GATEWAY_URL/hooks/$hook" 2>/dev/null)
  if [ $? -eq 0 ] && [ -n "$script" ] && [ "$script" != "not found" ]; then
    echo "$script" > "$HOME/.claude/$hook"
    chmod +x "$HOME/.claude/$hook"
  fi
done

exit 0
