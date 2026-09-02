# Clay

A malleable personal application: one app whose interface and features are
reshaped through natural language, while your data persists beneath every
change. The full specification lives in [`specs/`](specs/README.md).

## Run it (Windows)

Double-click **`clay.cmd`** (or run it from a terminal). It builds the app,
serves it on a fixed local port (4173 — a stable origin, so your data
persists between launches), and opens Clay in its own app window.

First run: pick a starter shell, then open **settings** in the right-hand
rail and choose a model connection:

- **Local Codex subscription (Preview):** double-click `clay-codex.cmd` (or run
  `pnpm codex` beside the normal launcher), select **Local Codex**, and Clay
  uses the Codex login already stored on this computer. No credential is
  copied into the browser.
- **OpenAI Responses:** run the backend with `MODEL_PROVIDER=openai` and a
  server-side `OPENAI_API_KEY`, then select **OpenAI** and save its URL.
- **Clay hosted:** select the managed or self-hosted Clay backend URL. Account,
  quota, and model credentials stay on that server.
- **Anthropic BYO:** select **Anthropic** and paste a browser-local API key.

Local backend examples in **PowerShell**:
```powershell
# Anthropic
$env:MODEL_PROVIDER = "anthropic"
$env:ANTHROPIC_API_KEY = "sk-ant-..."
pnpm backend

# OpenAI
$env:MODEL_PROVIDER = "openai"
$env:OPENAI_API_KEY = "sk-..."
pnpm backend

# Existing ChatGPT/Codex subscription
pnpm codex
```

In bash, the equivalent hosted-backend form is
`MODEL_PROVIDER=openai OPENAI_API_KEY=sk-... pnpm backend`.

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

## The shipped moat

Clay's defensibility is a compounding system, not a model or a feature count:

1. **A permanent semantic substrate.** Trusted kernel metadata gives tables,
   fields, and typed relationships stable UUIDv7 identities that survive rename,
   rollback, reactivation, fork, and archive import. Concept classification is
   optional and must be reviewed; Clay never infers it from labels. Generated
   panels, queries, the model, and the Bridge never receive private semantics.
2. **One reversible change protocol.** Structural reshapes pass through shadow
   validation, a Change contract, Keep or Discard, a trust receipt, and the
   same rewindable version history.
3. **Trust as an interface.** Shape Map exposes permanent data, live views,
   field-level provenance, dependencies, and evolution without widening panel
   authority.
4. **Context without duplication.** Built-in and user-saved situational lenses
   preserve panel incarnations and bounded layout as per-app projections. They
   never copy records or create shape versions. Saved filter restoration and a
   full lens editor remain later extensions.
5. **Private improvement evidence.** Clay reduces a closed event vocabulary
   directly into local daily counters. The Private activity & trust dashboard
   has independent disable and erase controls; its state is excluded from
   archives, forks, diagnostics, model context, and network requests.

Heavy trusted surfaces are loaded only when opened. PanelFrame, Data, History,
Shape Map, and Private activity each have semantic bundle boundaries enforced
from Vite's manifest. Lens persistence and commands live behind a dedicated
controller rather than adding more storage logic to the main app component.

The current next-generation product thesis, competitor research, moat, and
execution sequence live in
[`specs/docs/15-next-generation-strategy.md`](specs/docs/15-next-generation-strategy.md).

## Development

```
pnpm install
pnpm dev          # Vite dev server with HMR (use the URL it prints)
pnpm typecheck    # strict TS across all packages
pnpm test         # vitest suites (unit, property, integration)
pnpm check:ordinary # full local typecheck, boundary tests, build, and bundle gate
pnpm verify:product # Shape Map, change contract, lenses, metrics, providers
pnpm verify:multi-app # app-local archive replacement and sibling isolation
pnpm verify:browsers # Chromium, Firefox, and WebKit persistence/privacy
```

Packages: `schema` (the Zod constitution), `kernel` (store, migrations,
query, validator, bridge, pipeline), `panel-runtime` (the sandboxed iframe
bootstrap), `mutation` (prompt assembly + model client), `shell` (the app).
