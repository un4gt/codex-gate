#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

node scripts/check_frontend_solid_init_order.mjs
npm --prefix frontend run build
cargo build --manifest-path backend/Cargo.toml
