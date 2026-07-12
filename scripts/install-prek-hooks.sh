#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if command -v prek >/dev/null 2>&1; then
  PREK_BIN="$(command -v prek)"
elif [[ -x "$ROOT_DIR/node_modules/.bin/prek" ]]; then
  PREK_BIN="$ROOT_DIR/node_modules/.bin/prek"
else
  echo "prek 未安装，无法安装 hooks。" >&2
  exit 1
fi

PREK_VERSION="${PREK_VERSION:-0.3.9}"
ACTUAL_PREK_VERSION="$("$PREK_BIN" --version)"
if [[ "$ACTUAL_PREK_VERSION" != "prek ${PREK_VERSION}" ]]; then
  echo "prek 版本不匹配：当前 ${ACTUAL_PREK_VERSION}，要求 prek ${PREK_VERSION}。" >&2
  exit 1
fi

PROJECT_SLUG="$(basename "$ROOT_DIR")"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-/tmp/${PROJECT_SLUG}-prek-cache}"
export PREK_HOME="${PREK_HOME:-/tmp/${PROJECT_SLUG}-prek-home}"
mkdir -p "$XDG_CACHE_HOME" "$PREK_HOME"

"$PREK_BIN" install -c prek.toml --overwrite --prepare-hooks

HOOKS_DIR="$(git rev-parse --git-path hooks)"

echo "Installed prek hooks:"
echo "  - ${HOOKS_DIR}/pre-commit"
echo "  - ${HOOKS_DIR}/pre-push"
