# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Frontend for **codex-gate**, an LLM API gateway/proxy. This is a Solid.js SPA that provides an admin dashboard for managing providers, API keys, pricing, and viewing usage analytics. The UI is in Chinese (zh-CN).

Part of a monorepo — the Rust backend lives in `../backend/`. In production, this frontend is built to `dist/` and served as static files by the backend on port 8080.

## Commands

```bash
npm run dev        # Dev server on http://localhost:4173
npm run build      # TypeScript check + Vite production build (tsc -b && vite build)
npm run preview    # Preview production build on http://localhost:4173
```

There are no test or lint scripts configured.

## Architecture

**Framework**: Solid.js 1.9 (NOT React — uses signals, `<Show>`, `<For>`, `<Switch>`/`<Match>` instead of hooks and conditional JSX)

**Styling**: Tailwind CSS v4 with shadcn/ui components adapted for Solid.js. Design tokens defined as CSS custom properties in `src/styles.css` using oklch color space. Dark theme only.

**Build**: Vite 5 with `vite-plugin-solid` and `@tailwindcss/vite`.

### Key Patterns

- **Routing**: No router library. Views are switched via URL query param `?view=<name>` and a signal in `App.tsx`. Views: `dashboard`, `providers`, `keys`, `prices`, `logs`, `settings`.
- **State**: All state lives in Solid.js signals (`createSignal`, `createMemo`, `createEffect`). No global state store — state is lifted to `App.tsx` and passed via props.
- **API layer**: `src/lib/api.ts` provides `fetchJson`, `postJson`, `patchJson` helpers. All calls require `ConnectionSettings` (apiBase URL + adminToken) and use Bearer token auth. API base and token are stored in localStorage.
- **Demo mode**: When no backend connection is configured, the app uses mock data generators from `src/lib/demo.ts` for offline UI development. Connection errors also fall back to demo mode.

### Source Layout

- `src/App.tsx` — Root component (~600 lines): navigation, view routing, dashboard data fetching
- `src/components/` — Page-level components (ProvidersPage, ApiKeysPage, LogsPage, PricesPage, SettingsPage) and dashboard widgets (StatCard, TrendChart, ActivityHeatmap, TopModels, RecentLogs)
- `src/components/ui/` — shadcn primitives (button, card, input, select, table, etc.)
- `src/lib/types.ts` — All TypeScript interfaces for API responses and domain models
- `src/lib/api.ts` — REST client functions grouped by resource (providers, keys, prices, logs, stats)
- `src/lib/format.ts` — Number/date/cost formatting utilities using Intl API
- `src/lib/demo.ts` — Mock data generators for preview mode
- `src/lib/dashboard.ts` — Dashboard data transformation logic

### Backend API

The frontend expects a REST API at the configured base URL with endpoints under `/api/v1/`:
- `stats/daily`, `logs` — Analytics
- `providers`, `providers/{id}/endpoints`, `providers/{id}/keys` — Provider management
- `api-keys` — Customer API key management
- `prices`, `routes` — Pricing and routing config

### Adding shadcn Components

Config is in `components.json` (style: "new-york", icons: lucide). Components go in `src/components/ui/` and use `cn()` from `src/lib/utils.ts` for class merging.
