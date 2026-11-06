#!/usr/bin/env bash
# Arranca la API local (base temporal, no toca Turso) y el frontend.
# Abre http://localhost:5173 en el computador y la URL "Network" en el celular.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

cleanup() {
  trap - EXIT INT TERM
  kill "$API_PID" "$WEB_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "· API local  → http://localhost:8787 (base temporal, sin Turso)"
echo "· Frontend   → http://localhost:5173 (y la URL de red para el celular)"
echo

pnpm --filter @keyko/api demo &
API_PID=$!

pnpm --filter @keyko/web dev &
WEB_PID=$!

# `wait` sin -n: macOS trae bash 3.2.
wait "$API_PID" "$WEB_PID" 2>/dev/null || true
