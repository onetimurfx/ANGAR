#!/usr/bin/env bash
# Applies supabase/migrations over an IPv4-capable connection (GitHub runners have no IPv6; the direct
# DB host db.<ref>.supabase.co is IPv6-only). Order of preference:
#   1. supabase/.temp/pooler-url written by `supabase link`  -> supabase db push --linked
#   2. SUPABASE_POOLER_HOST (GitHub *variable*, not a secret) -> --db-url built here
#   3. Supabase Management API pooler config (needs a token allowed to read Connection Pooling) -> --db-url
# Secrets used: SUPABASE_DB_PASSWORD, SUPABASE_ACCESS_TOKEN (only from the environment). Nothing secret is printed.
# DRY_RUN=1 prints what would run (password hidden) and executes nothing.
set -euo pipefail

REF="${SUPABASE_PROJECT_REF:?SUPABASE_PROJECT_REF is not set}"
POOLER_FILE="${POOLER_FILE:-supabase/.temp/pooler-url}"
API="${SUPABASE_API_URL:-https://api.supabase.com}"

run_push() { # args: extra supabase args
  if [ "${DRY_RUN:-0}" = 1 ]; then echo "[dry-run] supabase db push $(printf '%s ' "$@" | sed -E 's#(://[^:@/]*):[^@]*@#\1:***@#')"; else supabase db push "$@"; fi
}

# URL-encodes the password (it may contain @ / : #) and masks the encoded form in the runner log too.
# Must run in the main shell (not inside $(...)), otherwise the ::add-mask:: line would end up in the URL.
encode_password() {
  : "${SUPABASE_DB_PASSWORD:?SUPABASE_DB_PASSWORD is not set}"
  ENC_PW="$(python3 -c 'import os,urllib.parse as u; print(u.quote(os.environ["SUPABASE_DB_PASSWORD"], safe=""))')"
  if [ "$ENC_PW" != "$SUPABASE_DB_PASSWORD" ]; then echo "::add-mask::$ENC_PW"; fi
}

valid_host() { [[ "$1" =~ ^[A-Za-z0-9.-]+\.pooler\.supabase\.com$ ]]; }

if [ -s "$POOLER_FILE" ]; then
  echo "Using the pooler address stored by 'supabase link' (host: $(sed -E 's#^[a-z]+://[^@]*@##; s#[:/].*$##' "$POOLER_FILE"))"
  run_push --linked
  exit 0
fi
echo "::warning::'supabase link' did not store $POOLER_FILE (the CLI could not read the pooler config; a scoped access token without Connection Pooling read access is the usual cause)."

host="${SUPABASE_POOLER_HOST:-}"; user="postgres.${REF}"
if [ -n "$host" ]; then
  echo "Using SUPABASE_POOLER_HOST from GitHub variables."
else
  echo "Asking the Management API for the pooler address..."
  if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then echo "::error::SUPABASE_ACCESS_TOKEN is not set"; exit 1; fi
  body="$(mktemp)"; trap 'rm -f "$body"' EXIT
  code="$(curl -sS -o "$body" -w '%{http_code}' -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" "$API/v1/projects/${REF}/config/database/pooler" || true)"
  echo "pooler config HTTP status: $code"
  if [ "$code" = 200 ]; then
    host="$(python3 - "$body" <<'PY'
import json,sys
try: items=json.load(open(sys.argv[1]))
except Exception: items=[]
items=items if isinstance(items,list) else [items]
pick=[i for i in items if isinstance(i,dict) and i.get("db_host")]
pick.sort(key=lambda i:(i.get("pool_mode")!="session", i.get("database_type")!="PRIMARY"))
print(pick[0]["db_host"] if pick else "")
PY
)"
  fi
fi

if [ -z "$host" ] || ! valid_host "$host"; then
  cat <<MSG
::error::Could not determine an IPv4-capable database address.
Fix (one-time, no secret needed): Supabase dashboard > Connect > "Session pooler" shows a host like
aws-0-<region>.pooler.supabase.com. Save only that host as GitHub repository VARIABLE SUPABASE_POOLER_HOST
(Settings > Secrets and variables > Actions > Variables), then run the workflow again.
MSG
  exit 1
fi

echo "Pooler host: $host (session mode, port 5432)"
encode_password
run_push --db-url "postgresql://${user}:${ENC_PW}@${host}:5432/postgres?sslmode=require"
