#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

npm --prefix frontend test
npm --prefix frontend run build
cargo test --manifest-path backend/Cargo.toml --locked
