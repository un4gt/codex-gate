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

PROJECT_SLUG="$(basename "$ROOT_DIR")"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-/tmp/${PROJECT_SLUG}-prek-cache}"
export PREK_HOME="${PREK_HOME:-/tmp/${PROJECT_SLUG}-prek-home}"
mkdir -p "$XDG_CACHE_HOME" "$PREK_HOME" "$ROOT_DIR/.git/hooks"

"$PREK_BIN" install -c prek.toml --hook-type pre-commit --hook-type pre-push --overwrite >/dev/null

write_hook() {
  local hook_type="$1"
  cat >"$ROOT_DIR/.git/hooks/$hook_type" <<EOF
#!/bin/sh
HERE="\$(cd "\$(dirname "\$0")" && pwd)"
PREK="$PREK_BIN"
export XDG_CACHE_HOME="$XDG_CACHE_HOME"
export PREK_HOME="$PREK_HOME"
mkdir -p "\$XDG_CACHE_HOME" "\$PREK_HOME"

if [ ! -x "\$PREK" ]; then
    PREK="prek"
fi

exec "\$PREK" hook-impl --hook-dir "\$HERE" --script-version 4 --hook-type=$hook_type --config="prek.toml" -- "\$@"
EOF

  chmod +x "$ROOT_DIR/.git/hooks/$hook_type"
}

write_hook pre-commit
write_hook pre-push

echo "Installed prek hooks:"
echo "  - .git/hooks/pre-commit"
echo "  - .git/hooks/pre-push"
