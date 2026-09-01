# Clay

A malleable personal application: one app whose interface and features are
reshaped through natural language, while your data persists beneath every
change. The full specification lives in [`specs/`](specs/README.md).

## Run it (Windows)

Double-click **`clay.cmd`** (or run it from a terminal). It builds the app,
serves it on a fixed local port (4173 — a stable origin, so your data
persists between launches), and opens Clay in its own app window.

First run: pick a starter shell, then open **settings** in the right-hand
rail and give Clay model access one of two ways:

- **Hosted (no key in the browser):** run the backend with your key in its
  environment, then set the backend URL in settings to `http://localhost:8787`:
  ```
  # PowerShell:  $env:ANTHROPIC_API_KEY="sk-ant-..."; pnpm backend
  # bash:        ANTHROPIC_API_KEY=sk-ant-... pnpm backend
  ```
- **BYO key:** paste an Anthropic API key (stored locally, sent only to
  `api.anthropic.com`).

Then describe a change:

> add a priority field and show it as a colored badge

Open **Shape map** to inspect how permanent data becomes live views and how the
app has evolved. Every table node opens the exact underlying data, every view
node can point the reshape composer at that panel, and the evolution column
links back to the reversible timeline. The **Reshape** rail can collapse when
you want the whole canvas. Every proposed reshape now arrives as a **Change
contract** that shows the validated diff, panel data access, affected views,
shadow-test status, reversibility, and row-preservation guarantee before Keep.

After Keep, Clay leaves a **trust receipt** with the exact version, changed
views, touched tables, and rewind target. Every live panel can explain why it
exists from its creation and latest-change history. The app bar also offers
**situational lenses** such as Morning review, Focus, and Update data. Lenses
change only which views are visible; they never copy or alter records.

The current next-generation product thesis, competitor research, moat, and
execution sequence live in
[`specs/docs/15-next-generation-strategy.md`](specs/docs/15-next-generation-strategy.md).

## Development

```
pnpm install
pnpm dev          # Vite dev server with HMR (use the URL it prints)
pnpm typecheck    # strict TS across all packages
pnpm test         # vitest suites (unit, property, integration)
pnpm check:ordinary # current product gate; deferred boundary work excluded
```

Packages: `schema` (the Zod constitution), `kernel` (store, migrations,
query, validator, bridge, pipeline), `panel-runtime` (the sandboxed iframe
bootstrap), `mutation` (prompt assembly + model client), `shell` (the app).
