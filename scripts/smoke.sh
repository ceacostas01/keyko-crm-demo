#!/usr/bin/env bash
# Smoke test de solo lectura contra una API desplegada o local.
#
#   BASE_URL=https://api-staging... SMOKE_EMAIL=... SMOKE_PASSWORD=... ./scripts/smoke.sh
#
# No crea ni modifica datos.
set -euo pipefail

BASE="${BASE_URL:-http://localhost:8787}"
EMAIL="${SMOKE_EMAIL:-demo@keyko.local}"
PASSWORD="${SMOKE_PASSWORD:-Demo1234!}"

say() { printf '%s\n' "$*"; }
fail() { printf 'FALLO: %s\n' "$*" >&2; exit 1; }

say "1. Health"
curl -fsS "$BASE/health" | grep -q '"status":"ok"' || fail "health"

say "2. Login"
TOKEN="$(curl -fsS -X POST "$BASE/api/v1/auth/login" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))')"
[ -n "$TOKEN" ] || fail "login sin token"
AUTH="authorization: Bearer $TOKEN"

say "3. Identidad"
curl -fsS "$BASE/api/v1/auth/me" -H "$AUTH" | grep -q '"business"' || fail "me"

say "4. Listados"
for resource in pets clients conversations; do
  curl -fsS "$BASE/api/v1/$resource?limit=1" -H "$AUTH" >/dev/null || fail "$resource"
done

say "5. Calidad de datos"
curl -fsS "$BASE/api/v1/stats/data-quality" -H "$AUTH" >/dev/null || fail "stats"

say "6. CORS (preflight desde el origen configurado)"
curl -fsS -o /dev/null -X OPTIONS "$BASE/api/v1/pets" \
  -H "origin: ${SMOKE_ORIGIN:-http://localhost:5173}" \
  -H 'access-control-request-method: GET' || fail "cors"

say "OK — API responde y autentica."
