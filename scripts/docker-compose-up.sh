#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PROJECT_SLUG="$(basename "$ROOT_DIR")"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-/tmp/${PROJECT_SLUG}-prek-cache}"
export PREK_HOME="${PREK_HOME:-/tmp/${PROJECT_SLUG}-prek-home}"
mkdir -p "$XDG_CACHE_HOME" "$PREK_HOME"

if command -v prek >/dev/null 2>&1; then
  PREK_BIN="$(command -v prek)"
elif [[ -x "$ROOT_DIR/node_modules/.bin/prek" ]]; then
  PREK_BIN="$ROOT_DIR/node_modules/.bin/prek"
else
  echo "prek 未安装，无法运行 compose up hook。" >&2
  exit 1
fi

"$PREK_BIN" run docker-compose-up-check --stage manual
docker compose up "$@"
