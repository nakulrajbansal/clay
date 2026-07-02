# 02 — System Architecture

## 1. Topology

Client-first. The browser holds the product; the backend is an accessory.

```
BROWSER ─────────────────────────────────────────────────────────────
 Main thread
   Shell (React, trusted)
     ├─ ConversationRail ── MutationClient
     ├─ PanelHost (one per live panel; owns iframe lifecycle)
     ├─ PreviewHost (shadow panel + diff card)
     ├─ TimeSlider / HistoryView
     └─ DataView / Settings / Onboarding
   Kernel (TypeScript, trusted, framework-free)
     ├─ Bridge (postMessage router, Zod-validated)
     ├─ QueryCompiler (Query object -> SQL + params)
     ├─ MigrationEngine (plan executor + inverse verifier)
     ├─ VersionLog (commit chain, rollback executor)
     ├─ Validator (acorn AST walk, budgets, query consistency)
     ├─ Observer (usage events -> heuristics -> suggestions)
     └─ ExpressionEngine (safe eval for computed columns)
 DB Worker
   SQLite WASM + OPFS VFS; owns user.db and system.db exclusively
 Panel iframes (untrusted, N ≈ 3–20)
   PanelRuntime (tiny fixed script): receives code blob, executes module,
   injects `clay` proxy, renders vnode vocabulary into its own DOM
──────────────────────────────────────────────────────────────────────
BACKEND (hosted mode only)
   Hono app: /auth/magic-link, /me, /mutations/plan (model proxy)
   Postgres: accounts, quotas, mutation counters. NO user app data.
ANTHROPIC API
```

## 2. Trust boundaries

B1 Shell/Kernel <-> Panel iframes. Crossed only by the Bridge protocol
   (doc 06). Everything on the panel side is permanently untrusted.
B2 Browser <-> Backend. Carries auth + mutation requests (schema-shapes
   and intent only, never records).
B3 Backend <-> Anthropic. Server-held key; per-user rate limits upstream.
B4 (BYO mode) Browser <-> Anthropic directly; B2/B3 not exercised.

Rule: data records cross NO boundary. They live and die inside B1's
trusted side.

## 3. Threading and ownership

The DB Worker exclusively owns SQLite (OPFS sync access handles require a
worker; exclusivity avoids lock contention). All DB access is async message
RPC: {id, op, payload} -> {id, ok, result | error}. The Kernel exposes typed
async wrappers; the Shell and Bridge never speak to the worker directly.

Panel iframes never touch the worker. Their db calls route:
iframe -> Bridge (main) -> Kernel -> DB Worker -> back. Watch subscriptions
are registered in the Kernel; on relevant table writes, the Kernel re-runs
compiled queries (debounced 50ms, batched per commit) and pushes rows to
subscribed panels.

## 4. State model

Three state stores, deliberately separate:
- Persistent app state: SQLite (user.db + system.db). Source of truth.
- Shell UI state: React state (panel layout cache, open dialogs, slider pos).
  Reconstructible from SQLite at any time; never authoritative.
- Panel-local state: inside each iframe (form inputs, chart hover). Ephemeral
  by design; a panel reload must be lossless for user DATA (which is in the DB),
  only losing transient interaction state.

## 5. Sequence: a mutation end to end

```
User types intent
 -> ConversationRail -> MutationClient.assembleContext()
      reads: schema registry, panel manifest, last 5 summaries   [local]
 -> POST plan request (hosted proxy | direct Anthropic)          [remote]
 <- MutationPlan JSON (or clarifying_question -> render, stop)
 -> Kernel.Validator.check(plan)                                 [local]
      fail -> repair round (once) -> fail -> amber card, stop
 -> Kernel.dryRun(plan):
      DB Worker: BACKUP user.db -> shadow.db
      MigrationEngine.apply(plan.migration, shadow)
      PreviewHost boots panel iframes against shadow binding
      smoke render; runtime error -> repair round (once)
 -> PreviewHost shows proposed panels + diff card
 User: Keep
 -> Kernel.commit(plan):  [single transaction]
      MigrationEngine.apply(migration, user.db)
      VersionLog.append(commit{migration, inverse, blobs, summary})
      PanelHost hot-swaps iframes (new blob URLs)
      Observer.record("mutation_kept")
 User: Discard -> shadow dropped, nothing recorded but the attempt count
```

## 6. Sequence: rollback to version K

```
Slider drag -> TimeSlider (preview mode, read-only render at K)
 "Make this the latest"
 -> Kernel.rollback(K): [single transaction]
      for v in N..K+1 desc: MigrationEngine.apply(commit[v].inverse)
      VersionLog.truncateAbove(K)  (after explicit warn)
      PanelHost restores manifest at K from blobs
```

Preview mode does NOT run inverses; it renders panels at K against current
data, with fields unknown at K simply not selected. Only "make latest"
touches the schema. This keeps scrubbing instant and side-effect free.

## 7. Module dependency rules (enforced by lint)

kernel/* imports nothing from shell/*. shell/* may import kernel public API
only (kernel/index.ts). panels have no imports at all (validated). The
backend shares one package with the client: schema/ (Zod definitions for
MutationPlan, Bridge messages, Query) — single source of truth for shapes.

## 8. Performance budgets

Cold start (returning user, warm cache): interactive < 1.5s.
Panel render after data write: < 100ms p95 (debounced watch).
Slider scrub: version render < 500ms p95.
Mutation round trip (model included): < 15s p50, < 30s p95.
Memory: < 250MB with 20 panels and 50k rows.
Budgets are asserted in the perf test harness (doc 08), not aspirational.

## 9. Directory layout (target repo)

```
clay/
  packages/
    schema/        zod types shared client/server
    kernel/        bridge, query, migrate, version, validate, observe, expr
    shell/         react app (vite)
    panel-runtime/ the fixed iframe bootstrap (built to a single file)
    backend/       hono app
  specs/           THIS PACKAGE, checked in; CLAUDE.md points here
  tests/           regression intents, property tests, fixtures
```
