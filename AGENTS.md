# Repository Guidelines

## Project Structure & Module Organization

`little-gate` is an OpenAI-compatible gateway with a Rust backend and Solid/Vite admin console. Backend source lives in `backend/src/`, with cache code in `backend/src/cache/` and colocated tests behind `#[cfg(test)]`. Frontend source lives in `frontend/src/`: UI primitives in `components/ui/`, console widgets in `components/console/`, helpers in `lib/`, and translations in `i18n/`. Operational material lives in `scripts/`, `deploy/`, `docs/`, `Dockerfile`, and `docker-compose.yml`. Treat `backend/target/`, `frontend/dist/`, `frontend/node_modules/`, and local `data/` as generated.

## Build, Test, and Development Commands

- `npm --prefix frontend ci`: install frontend dependencies.
- `npm --prefix frontend run dev`: start Vite on port `4173`.
- `npm --prefix frontend run build`: type-check and bundle the console.
- `cargo build --manifest-path backend/Cargo.toml --locked`: build the backend.
- `cargo test --manifest-path backend/Cargo.toml --locked`: run Rust tests.
- `cargo fmt --manifest-path backend/Cargo.toml --all -- --check`: check formatting.
- `cargo clippy --manifest-path backend/Cargo.toml --all-targets --all-features --locked -- -D warnings`: run lints.
- `python3 scripts/run_regression.py --archive-compress`: run routing/archive regressions.
- `cp .env.example .env` then `docker compose up -d --build`: run the stack locally.

## Coding Style & Naming Conventions

Rust uses edition 2024 and `rustfmt`. Prefer `Result` for fallible paths, avoid `unwrap()`/`expect()` outside tests, and use `snake_case` for modules/functions, `PascalCase` for types, and `SCREAMING_SNAKE_CASE` for constants. Frontend code uses TypeScript, Solid, Tailwind CSS, and the `@/` alias. Name components `PascalCase.tsx`, utilities `lowerCamelCase`, and keep UI copy concise and operator-focused.

## Testing Guidelines

Add backend tests near the code they exercise with clear names such as `rejects_empty_admin_token`. Run `cargo test --manifest-path backend/Cargo.toml --locked` before backend PRs. There is no dedicated frontend test runner; use `npm --prefix frontend run build` for frontend validation. Use Python regression scripts for routing, failover, and archive behavior.

## Commit & Pull Request Guidelines

Recent history follows Conventional Commits: `feat(stats): ...`, `fix(proxy): ...`, `chore(repo): ...`, and `feat!:` for breaking changes. Keep each commit focused. Pull requests should include a summary, linked issue when applicable, validation commands, env or schema changes, and screenshots for visible frontend work.

## Security & Configuration Tips

Use `.env.example` as the configuration template. Never commit real `ADMIN_TOKEN`, `MASTER_KEY`, provider keys, database files, or archived request logs. Document new environment variables in `.env.example` and deployment docs.

## Agent-Specific Instructions

Spend time on thinking before editing. Inspect structure and history first, keep changes scoped, and do not overwrite user work.
