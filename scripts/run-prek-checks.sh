#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

STAGE="${1:-pre-push}"
if [[ $# -gt 0 ]]; then
  shift
fi

case "$STAGE" in
  manual|commit-msg|post-checkout|post-commit|post-merge|post-rewrite|pre-commit|pre-merge-commit|pre-push|pre-rebase|prepare-commit-msg)
    ;;
  *)
    echo "unsupported prek stage: $STAGE" >&2
    exit 2
    ;;
esac

PROJECT_SLUG="$(basename "$ROOT_DIR")"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-/tmp/${PROJECT_SLUG}-prek-cache}"
export PREK_HOME="${PREK_HOME:-/tmp/${PROJECT_SLUG}-prek-home}"
mkdir -p "$XDG_CACHE_HOME" "$PREK_HOME"

PREK_VERSION="${PREK_VERSION:-0.3.9}"
if [[ -n "${PREK_BIN:-}" ]]; then
  PREK_COMMAND=("$PREK_BIN")
elif command -v prek >/dev/null 2>&1; then
  PREK_COMMAND=("$(command -v prek)")
elif command -v uvx >/dev/null 2>&1; then
  PREK_COMMAND=(uvx --from "prek==${PREK_VERSION}" prek)
else
  echo "prek is required; install prek ${PREK_VERSION} or install uv/uvx." >&2
  exit 1
fi

ACTUAL_PREK_VERSION="$("${PREK_COMMAND[@]}" --version)"
if [[ "$ACTUAL_PREK_VERSION" != "prek ${PREK_VERSION}" ]]; then
  echo "unsupported prek version: ${ACTUAL_PREK_VERSION}; expected prek ${PREK_VERSION}" >&2
  exit 1
fi

exec "${PREK_COMMAND[@]}" run \
  --stage "$STAGE" \
  --all-files \
  --show-diff-on-failure \
  --fail-fast \
  "$@"
