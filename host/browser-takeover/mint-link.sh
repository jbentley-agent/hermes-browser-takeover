#!/bin/bash
set -euo pipefail

AGENT="${1:-${TAKEOVER_AGENT:-${DEFAULT_AGENT_NAME:-agent}}}"
TTL="${2:-${TAKEOVER_DEFAULT_TTL:-900}}"
MINT_URL="${TAKEOVER_MINT_URL:-http://127.0.0.1:9388/api/mint}"

curl -s -X POST "$MINT_URL" \
  -H 'Content-Type: application/json' \
  -d "{\"agent\":\"${AGENT}\",\"ttlSeconds\":${TTL}}"
