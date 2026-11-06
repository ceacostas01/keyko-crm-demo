#!/usr/bin/env bash
# Prueba el Worker real en local, sin crear recursos externos.
#
#   ./scripts/worker-smoke.sh
#
# Levanta `turso dev` (base temporal), aplica las migraciones, crea un admin
# ficticio, arranca `wrangler dev --local` con el binding R2 local y ejecuta
# el smoke test + un ciclo completo de foto. No toca Turso ni Cloudflare.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="$(mktemp -t keyko-worker-XXXXXX).db"
TURSO_PORT="${TURSO_PORT:-8099}"
API_PORT="${API_PORT:-8790}"
TDB="http://127.0.0.1:${TURSO_PORT}"
API="http://127.0.0.1:${API_PORT}"
EMAIL="worker-smoke@local.test"
PASSWORD="WorkerLocal123!"
JWT_SECRET="local-worker-smoke-secret-0123456789"

TURSO_PID=""
WAL_PID=""

cleanup() {
  trap - EXIT INT TERM
  if [ -n "$WAL_PID" ]; then kill "$WAL_PID" 2>/dev/null || true; fi
  if [ -n "$TURSO_PID" ]; then kill "$TURSO_PID" 2>/dev/null || true; fi
  wait 2>/dev/null || true
  rm -f "$DB" "$DB-wal" "$DB-shm" /tmp/keyko-worker-photo.bin /tmp/keyko-worker-pixel.png
}
trap cleanup EXIT INT TERM

fail() { printf 'FALLO: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }

for port in "$TURSO_PORT" "$API_PORT"; do
  if lsof -ti "tcp:$port" >/dev/null 2>&1; then
    fail "el puerto $port está ocupado; define TURSO_PORT/API_PORT libres"
  fi
done

command -v turso >/dev/null || fail "falta Turso CLI"
command -v curl >/dev/null || fail "falta curl"

say "1. Turso local"
turso dev -f "$DB" -p "$TURSO_PORT" >/tmp/keyko-worker-turso.log 2>&1 &
TURSO_PID=$!
for _ in $(seq 1 80); do
  curl -fsS "$TDB/health" >/dev/null 2>&1 && break
  kill -0 "$TURSO_PID" 2>/dev/null || fail "turso dev terminó: $(tail -5 /tmp/keyko-worker-turso.log)"
  sleep 0.25
done
curl -fsS "$TDB/health" >/dev/null || fail "turso dev no respondió"

say "2. Migraciones"
cd "$ROOT"
TURSO_DATABASE_URL="$TDB" pnpm db:migrate --allow-remote >/tmp/keyko-worker-migrate.log 2>&1 \
  || fail "migraciones: $(tail -10 /tmp/keyko-worker-migrate.log)"

say "3. Administrador ficticio"
TURSO_DATABASE_URL="$TDB" BUSINESS_ID=keyko BUSINESS_NAME=Keyko BUSINESS_SLUG=keyko \
  ADMIN_EMAIL="$EMAIL" ADMIN_PASSWORD="$PASSWORD" \
  pnpm --filter @keyko/api create-admin --allow-remote >/tmp/keyko-worker-admin.log 2>&1 \
  || fail "create-admin: $(tail -10 /tmp/keyko-worker-admin.log)"

say "4. Worker con wrangler dev (R2 local)"
cd "$ROOT/apps/api"
pnpm dlx wrangler dev -c wrangler.staging.toml --local --port "$API_PORT" \
  --var TURSO_DATABASE_URL:"$TDB" \
  --var TURSO_AUTH_TOKEN:dummy \
  --var JWT_SECRET:"$JWT_SECRET" \
  --var ALLOWED_ORIGINS:http://localhost:5173 \
  --var AI_ENABLED:false >/tmp/keyko-worker-wrangler.log 2>&1 &
WAL_PID=$!
for _ in $(seq 1 160); do
  curl -fsS "$API/health" >/dev/null 2>&1 && break
  kill -0 "$WAL_PID" 2>/dev/null || fail "wrangler dev terminó: $(tail -15 /tmp/keyko-worker-wrangler.log)"
  sleep 0.5
done
curl -fsS "$API/health" >/dev/null || fail "el Worker no respondió"

say "5. Smoke de API"
BASE_URL="$API" SMOKE_EMAIL="$EMAIL" SMOKE_PASSWORD="$PASSWORD" \
  "$ROOT/scripts/smoke.sh"

say "6. Ciclo de foto (subida, servido privado, desactivación)"
TOKEN="$(curl -fsS -X POST "$API/api/v1/auth/login" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')"
AUTH="authorization: Bearer $TOKEN"

CLIENT="$(curl -fsS -X POST "$API/api/v1/clients" \
  -H "$AUTH" -H 'content-type: application/json' \
  -d '{"fullName":"Prueba Worker","phone":"+573109998877"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["id"])')"
PET="$(curl -fsS -X POST "$API/api/v1/pets" \
  -H "$AUTH" -H 'content-type: application/json' \
  -d "{\"clientId\":$CLIENT,\"name\":\"R2 Local\",\"species\":\"perro\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["id"])')"

python3 - <<'PY'
import base64
png = base64.b64decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
)
open('/tmp/keyko-worker-pixel.png', 'wb').write(png)
PY

UP="$(curl -fsS -X POST "$API/api/v1/pets/$PET/photo" \
  -H "$AUTH" -H 'content-type: image/png' \
  --data-binary @/tmp/keyko-worker-pixel.png)"
PHOTO_URL="$(printf '%s' "$UP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["photoUrl"])')"
MEDIA="$API$PHOTO_URL"

CODE="$(curl -s -o /tmp/keyko-worker-photo.bin -w '%{http_code}' "$MEDIA")"
BYTES="$(wc -c < /tmp/keyko-worker-photo.bin | tr -d ' ')"
[ "$CODE" = "200" ] && [ "$BYTES" -gt 0 ] || fail "la foto no se sirvió (HTTP $CODE)"
say "   foto servida: HTTP $CODE, $BYTES bytes"

curl -fsS -X DELETE "$API/api/v1/pets/$PET" -H "$AUTH" >/dev/null
CODE="$(curl -s -o /dev/null -w '%{http_code}' "$MEDIA")"
[ "$CODE" = "200" ] || fail "la foto se perdió al desactivar (HTTP $CODE)"
say "   foto tras desactivar: HTTP $CODE"

say "7. Egreso y resumen"
TODAY="$(date +%F)"
EXPENSE="$(curl -fsS -X POST "$API/api/v1/expenses" \
  -H "$AUTH" -H 'content-type: application/json' \
  -H "idempotency-key: worker-smoke-expense-$(date +%s)" \
  -d "{\"category\":\"luz\",\"reason\":\"Prueba de egreso\",\"amountCents\":15000000,\"incurredAt\":\"$TODAY\"}")"
printf '%s' "$EXPENSE" | python3 -c 'import sys,json; d=json.load(sys.stdin)["data"]; assert d["category"]=="luz" and d["amountCents"]==15000000' \
  || fail "el egreso no se creó"
SUMMARY="$(curl -fsS "$API/api/v1/sales/summary?from=$TODAY&to=$TODAY" -H "$AUTH")"
printf '%s' "$SUMMARY" | python3 -c 'import sys,json; d=json.load(sys.stdin)["data"]; assert d["expensesCents"] >= 15000000' \
  || fail "el resumen no incluyó el egreso"
say "   egreso y resumen: OK"

say "OK — runtime del Worker + Turso local + R2 local verificados."
