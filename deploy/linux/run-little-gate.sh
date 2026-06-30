#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")"

if [ -f ./.env ]; then
  set -a
  . ./.env
  set +a
fi

: "${ADMIN_TOKEN:?set ADMIN_TOKEN in .env or environment}"

export MASTER_KEY="${MASTER_KEY:-}"
export LISTEN_ADDR="${LISTEN_ADDR:-0.0.0.0:8080}"
export STATIC_DIR="${STATIC_DIR:-./static}"
export DB_DSN="${DB_DSN:-sqlite://./data/little_gate.sqlite}"
export RUST_LOG="${RUST_LOG:-info}"

mkdir -p ./data
exec ./little-gate
