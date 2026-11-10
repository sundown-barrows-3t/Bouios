#!/bin/bash
# add-transcript-storage.sh - the second step after a one-button install: add transcript
# storage once your memory service is running.
#
# WHY A SECOND STEP. The button sets up the memory service with its database only.
# Asking for a storage bucket in the same step could make the whole setup fail on an
# account that does not have object storage, whereas memory works fine without it. So the
# button stays storage-free, and this step adds the bucket afterwards, only when the
# account has it.
#
# WHAT IT DOES, in order, stopping at the first thing that cannot be done:
#   1. Checks that object storage is available on your account. If it is not, it tells
#      you how to enable it and stops with exit 0: memory works without transcripts,
#      nothing was changed.
#   2. Creates the bucket <service>-transcripts when it is not there yet.
#   3. Connects the bucket to your memory service, keeping every connection and secret
#      it already has (secrets are carried over as they are, so their values are never
#      read or resent). Already connected: nothing is changed.
#   4. Installs the transcript backup hook on this machine.
#   5. Proves it: stores a tiny test file (always the same name) through your memory
#      service and reads it back.
# Nothing is sent anywhere but your own account and your own memory service.
#
# Needs: an account API token allowed to edit scripts and storage, the memory service
# address and the access password from the button's setup. Optional: the account id
# (found by itself when the token sees one account) and the service name (default
# memory-vault). The exact variable names are read near the top of this script. One
# further variable only redirects the API address for the automated test.
set -u
API="${CF_API_BASE:-https://api.cloudflare.com/client/v4}"
NAME="${WORKER_NAME:-memory-vault}"
BUCKET="${TX_BUCKET:-$NAME-transcripts}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] || [ -z "${WORKER_URL:-}" ] || [ -z "${BEARER_TOKEN:-}" ]; then
  echo "Transcript storage: set CLOUDFLARE_API_TOKEN, WORKER_URL and BEARER_TOKEN, then run this again."
  echo "  CLOUDFLARE_API_TOKEN: a token with Workers Scripts Edit and R2 Edit (Cloudflare dashboard, My Profile, API Tokens)."
  echo "  WORKER_URL and BEARER_TOKEN: the web address and the password from your Deploy step."
  exit 2
fi
for c in curl jq; do command -v "$c" >/dev/null 2>&1 || { echo "Transcript storage: $c is needed."; exit 2; }; done
cf() { curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$@"; }

ACC="${CLOUDFLARE_ACCOUNT_ID:-}"
if [ -z "$ACC" ]; then
  A=$(cf "$API/accounts")
  [ "$(printf '%s' "$A" | jq -r '.success // false')" = "true" ] || { echo "Transcript storage: the token was refused ($(printf '%s' "$A" | jq -r '.errors[0].message // "no answer"'))."; exit 1; }
  [ "$(printf '%s' "$A" | jq -r '.result | length')" = "1" ] || { echo "Transcript storage: the token sees more than one account. Set CLOUDFLARE_ACCOUNT_ID and run again."; exit 1; }
  ACC=$(printf '%s' "$A" | jq -r '.result[0].id')
fi

# 1. Is object storage available on this account?
L=$(cf "$API/accounts/$ACC/r2/buckets")
if [ "$(printf '%s' "$L" | jq -r '.success // false')" != "true" ]; then
  code=$(printf '%s' "$L" | jq -r '.errors[0].code // 0')
  if [ "$code" = "10042" ]; then
    echo "Transcript storage: not added. R2 storage is not enabled on this Cloudflare account."
    echo "  To keep your chat transcripts, enable R2 in the Cloudflare dashboard (R2 Object Storage, then Enable;"
    echo "  Cloudflare asks for a payment method and has a free allowance), then run this step again."
    echo "  Memory works without it. Nothing was changed."
    exit 0
  fi
  echo "Transcript storage: could not check R2 ($(printf '%s' "$L" | jq -r '.errors[0].message // "no answer"')). Nothing was changed."
  exit 1
fi

# 2. The bucket.
if printf '%s' "$L" | jq -e --arg b "$BUCKET" '[.result.buckets[]?.name] | index($b)' >/dev/null 2>&1; then
  echo "  Bucket '$BUCKET' is already there."
else
  C=$(cf -X POST "$API/accounts/$ACC/r2/buckets" -H "Content-Type: application/json" --data "$(jq -n --arg n "$BUCKET" '{name: $n}')")
  if [ "$(printf '%s' "$C" | jq -r '.success // false')" != "true" ] && [ "$(printf '%s' "$C" | jq -r '.errors[0].code // 0')" != "10004" ]; then
    echo "Transcript storage: the bucket could not be created ($(printf '%s' "$C" | jq -r '.errors[0].message // "no answer"')). Nothing else was changed."
    exit 1
  fi
  echo "  Bucket '$BUCKET' created."
fi

# 3. The connection, keeping everything the memory service already has.
S=$(cf "$API/accounts/$ACC/workers/scripts/$NAME/settings")
if [ "$(printf '%s' "$S" | jq -r '.success // false')" != "true" ]; then
  echo "Transcript storage: your worker '$NAME' could not be read ($(printf '%s' "$S" | jq -r '.errors[0].message // "no answer"')). Check WORKER_NAME. Nothing else was changed."
  exit 1
fi
if printf '%s' "$S" | jq -e '[.result.bindings[]?.name] | index("TRANSCRIPTS")' >/dev/null 2>&1; then
  echo "  Binding TRANSCRIPTS is already on the worker."
else
  NEW=$(printf '%s' "$S" | jq -c --arg b "$BUCKET" '{bindings: ([.result.bindings[]? | if (.type == "secret_text" or .type == "secret_key") then {type: "inherit", name: .name} else . end] + [{type: "r2_bucket", name: "TRANSCRIPTS", bucket_name: $b}])}')
  P=$(cf -X PATCH "$API/accounts/$ACC/workers/scripts/$NAME/settings" -F "settings=$NEW;type=application/json")
  if [ "$(printf '%s' "$P" | jq -r '.success // false')" != "true" ]; then
    echo "Transcript storage: the binding could not be added ($(printf '%s' "$P" | jq -r '.errors[0].message // "no answer"'))."
    echo "  Add it by hand: Cloudflare dashboard, Workers, $NAME, Settings, Bindings, Add, R2 bucket,"
    echo "  name it TRANSCRIPTS and choose '$BUCKET'. Then run this step again. The bucket is ready."
    exit 1
  fi
  echo "  Binding TRANSCRIPTS added."
fi

# 4. The backup hook on this machine.
bash "$here/install-transcript-hook.sh" "$WORKER_URL" "$BEARER_TOKEN"

# 5. Proof: store a tiny test file through the memory service and read it back. It always uses the
# same name, so running this again replaces it instead of adding another.
BODY='{"type":"user","message":"bouios storage check"}'
PUT=$(curl -sS -o /dev/null -w '%{http_code}' -X PUT "$WORKER_URL/transcript/bouios-storage-check" -H "Authorization: Bearer $BEARER_TOKEN" --data-binary "$BODY")
GOT=$(curl -sS "$WORKER_URL/transcript/bouios-storage-check" -H "Authorization: Bearer $BEARER_TOKEN" 2>/dev/null)
if [ "$PUT" = "200" ] && [ "$GOT" = "$BODY" ]; then
  echo "Transcript storage: working. A test file was stored in your bucket and read back."
else
  echo "Transcript storage: the binding is in place but a test upload did not read back (store answered $PUT). Wait a minute for Cloudflare to apply it and run this step again."
  exit 1
fi
