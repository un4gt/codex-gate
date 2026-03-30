# Repository Guidelines

## Project Structure & Module Organization
`backend/` contains the Rust gateway service; core modules live in `backend/src/`. `frontend/` is a SolidJS dashboard built with Vite; page components are in `frontend/src/components/`, shared helpers are in `frontend/src/lib/`, and UI primitives live in `frontend/src/components/ui/`. SQLite files and archived logs live under `data/`. Validation helpers live in `scripts/`. Treat `backend/target/`, `frontend/dist/`, and `frontend/node_modules/` as generated output.

## Build, Test, and Development Commands
`docker compose up -d --build` builds and starts the full stack with the root `.env`.
`cargo build --manifest-path backend/Cargo.toml` builds the backend binary.
`cargo run --manifest-path backend/Cargo.toml` runs the API; set `ADMIN_TOKEN` first.
`npm --prefix frontend run dev` starts the dashboard on port `4173`.
`npm --prefix frontend run build` type-checks and produces the frontend bundle.
`python3 scripts/mock_upstream.py` starts a local upstream simulator for failover and auth scenarios.
`python3 scripts/run_regression.py --archive-compress` runs the main local regression pipeline.

## Coding Style & Naming Conventions
Follow the existing style in each subproject: Rust uses 4-space indentation, snake_case modules, and small single-purpose files; run `cargo fmt` before committing and `cargo clippy --manifest-path backend/Cargo.toml` for lint checks. Frontend code uses TypeScript with Solid components in PascalCase (`ProvidersPage.tsx`), utilities in camelCase, and the `@/` alias for `frontend/src`. Keep new files close to the feature they support.

## Testing Guidelines
There is no large committed unit-test suite yet, so rely on focused validation. Run `cargo test --manifest-path backend/Cargo.toml` when adding backend logic, `npm --prefix frontend run build` for frontend smoke coverage, and the Python regression scripts for routing and failover behavior. Name new Rust tests after the behavior they prove, and keep fixtures in `data/tmp/` or temporary SQLite files instead of committed production data.

## Commit & Pull Request Guidelines
Git history currently starts with a single `Initial commit`, so there is no strict house style to copy. Use short imperative commit subjects, keep each commit to one logical change, and mention the area touched when helpful, for example `backend: tighten request log retention`. Pull requests should explain the effect, list the commands you ran, note any env or schema changes, and include screenshots for dashboard changes.

## Security & Configuration Tips
Copy `.env.example` to `.env` for local or Docker work. Always set `ADMIN_TOKEN`, prefer a separate `MASTER_KEY`, and do not commit populated `.env` files or live SQLite data. If you change archive behavior, double-check `REQUEST_LOG_ARCHIVE_DIR` and retention settings so tests do not write outside `data/`.
