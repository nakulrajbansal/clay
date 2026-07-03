# Clay

A malleable personal application: one app whose interface and features are
reshaped through natural language, while your data persists beneath every
change. The full specification lives in [`specs/`](specs/README.md).

## Run it (Windows)

Double-click **`clay.cmd`** (or run it from a terminal). It builds the app,
serves it on a fixed local port (4173 — a stable origin, so your data
persists between launches), and opens Clay in its own app window.

First run: pick a starter shell, then open **settings** in the right-hand
rail to paste an Anthropic API key (BYO mode — stored locally, sent only to
`api.anthropic.com`). Then describe a change:

> add a priority field and show it as a colored badge

## Development

```
pnpm install
pnpm dev          # Vite dev server with HMR (use the URL it prints)
pnpm typecheck    # strict TS across all packages
pnpm test         # vitest suites (unit, property, integration)
```

Packages: `schema` (the Zod constitution), `kernel` (store, migrations,
query, validator, bridge, pipeline), `panel-runtime` (the sandboxed iframe
bootstrap), `mutation` (prompt assembly + model client), `shell` (the app).
