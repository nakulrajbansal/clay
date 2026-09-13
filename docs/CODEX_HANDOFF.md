# Clay Codex engineering and release handoff

## Purpose

This document gives Codex the compact engineering, product, safety, and release context needed to continue Clay without importing private chat transcripts or rediscovering the campaign history.

## Active development mission (2026-09-12)

The active user instruction supersedes the per-feature release sequence below:
finish A-F development first using targeted RED/GREEN tests and affected package
typechecks. Defer broad regression, builds/budgets, browser/accessibility
certification, and independent review to the single integrated test phase.
Do not commit or push: `.git` is intentionally protected. Sole writer, `D:\Clay`,
branch `codex/clay-project`, development base `ad76c940e18b31eff0b6d78c8c3dd18568b8ef55`.
The uncommitted development continuation, capability matrix, real finder-loop
results, and next code tasks are recorded in `docs/CODEX_DEVELOPMENT_HANDOFF.md`.
Neither development completion nor release completion is currently claimed.

## Repository identity

- Codex checkout: `D:\Clay`
- Branch: `codex/clay-project`
- Remote: `https://github.com/nakulrajbansal/clay.git`
- Base commit: `1e6245c3363874642d49f22b371dad48543f53d8`
- Base tree: `5af88c75a2eca8e4bad8a2edd7cb9e200d994ca5`
- Integration branch upstream reference: `agent/af-fast-integration`
- Canonical Git repository storage: `C:\Users\nakul\OneDrive\Project Folder\clay`

The OneDrive checkout and the older linked Codex worktree are not the active project. Development in Codex must occur in the standalone `D:\Clay` repository unless Nakul explicitly changes the target.

## Product goal

Clay is a local-first malleable app for mainstream nontechnical owner-operators. It should let a person start useful work quickly, retain custody of durable data, reshape their interface safely, recover mistakes, automate bounded tasks, and share or collect outcomes without hidden authority.

The A through F roadmap is:

- A: Managed first-use activation and first useful result.
- B: Truthful external protection, Recovery Center, Recovery Kit, authenticated archives, and restore-as-new.
- C: Preview-first migration with bounded production spreadsheet support.
- D: Trusted Daily Home, Inbox, capture, and projections.
- E: Bounded, understandable, recoverable automations.
- F: Local Print/CSV plus separately gated encrypted sharing and intake.

## Delivered MVP

The base commit produces a runnable local MVP with:

- First-run blank or recommended Tracker starter.
- Canonical worker-selected first-run app identity.
- Records, tables, panels, layouts, history, attachments, search, and local persistence.
- OPFS storage with honest device-only custody messaging.
- Supported structural reshaping through validated MutationPlan, Preview, Keep, and Discard.
- New generated panels constrained to a closed declarative blueprint. Existing custom code can be reused only byte-for-byte.
- Bounded CSV, TSV, and XLSX acquisition, mapping, preview, commit, cancellation, and current-app Undo.
- Local Print and canonical CSV export.
- Read-only Daily Home projection.
- Recovery Center status and adapter diagnostics.
- Intake and encrypted-sharing implementation surfaces, subject to backend configuration and independent deployment gates.
- Responsive packaged Chromium behavior at 320px.

The packaged MVP was verified with 27 passing browser checks, zero failed checks, zero page errors, zero console errors, no horizontal overflow at 320px, OPFS persistence across reload, and zero serious or critical axe violations.

The local release artifact created from the base source is:

- `C:\Users\nakul\Clay-MVP-1e6245c.zip`
- Live local server when running: `http://127.0.0.1:4180`

Do not confuse the runnable MVP with full A through F certification.

## P0 gap: multi-app regression

Multi-app worked in the earlier product by storing app IDs in `localStorage` and letting the worker open an OPFS namespace directly from the requested ID. The stronger authority model now rejects any requested app not present in the durable `DeviceCatalog`:

```text
requested app is not in the authoritative catalog
```

That rejection is correct, but the replacement lifecycle layer was omitted from the integrated lineage.

Reference commit:

`bb26c16f3c18b7e613aff48a828f0c98bc597631` (`feat: add worker-owned app lifecycle`)

It added:

- `packages/kernel/src/app-generation.ts`
- `packages/kernel/src/app-lifecycle-request.ts`
- `packages/kernel/src/production-app-lifecycle.ts`
- Create, fork, switch, rename, and delete worker routes.
- Catalog generation reservations, lifecycle receipts, retry handling, and tests.

Git confirmed this commit is not an ancestor of the base branch. Reconcile its intent and tests with current authority code rather than cherry-picking without review.

Required user journey:

1. Create a second app.
2. Seed it from a starter.
3. Add distinct records to both apps.
4. Switch repeatedly with no data crossover.
5. Rename and reload.
6. Duplicate with independent storage, history, and catalog identity.
7. Delete with explicit confirmation and deterministic fallback selection.
8. Retry interrupted or lost-response operations without duplicate entries.
9. Preserve and adopt earlier OPFS namespaces without deletion, rebinding, or silent replacement.
10. Restore import-as-new and its bounded Undo semantics.

## Other user-facing gaps

### B: backup and recovery

The integrated worker currently keeps archive export/import, automatic backup, backup records, Recovery Kit enrollment/import, recovery candidate validation, and restore-as-new fail-closed. Recovery Center UI existence is not completion. A real external backup and restore-as-new browser journey must pass.

Archive format 5 work exists in other campaign branches and authenticates before ZIP parsing. Preserve that invariant during reconciliation.

### D: Daily Home

Today projections and navigation are available, but the shell explicitly passes `dailyHomeMutationsAvailable={false}`. Source configuration, recents, favorites, durable timezone initialization, Quick Capture, and capture Undo are not shipped.

### E: automations

Automation definitions, recipes, simulation, history, runtime data, and much authority code exist. The shell explicitly passes `automationMutationsAvailable={false}` and `mutationsAvailable={false}`. Users cannot create, save, enable, pause, delete, run, undo, or acknowledge automation state in the MVP.

### F: sharing and intake

Local Print/CSV is usable. Hosted encrypted sharing and public intake require backend configuration, authentication, service deployment, and separate browser/security certification. Do not deploy from this context without explicit authorization.

### Other gaps

- Text-to-relation preview exists, but the production conversion route is unavailable.
- New arbitrary JavaScript panel generation remains disallowed.
- Firefox, WebKit, and genuine manual NVDA certification are incomplete.
- Default-branch CI, merge, and post-merge verification are incomplete.

## Current production-route truth

Always inspect `packages/shell/src/worker/mutation-route-census.ts` before claiming a capability. Routes marked `unavailable` are not shipped even when supporting code or UI exists.

The DB worker, physical transaction layer, target catalog, request journal, and `ProductionStoreAuthority` must remain the sole path to durable mutation. UI cache entries are never authority.

## Bundle status at the base source

Passing:

- Total shell JavaScript: 954,542 raw / 283,854 gzip, limits 980,000 / 290,000.
- Database-worker entry: 191,771 raw / 47,818 gzip, limits 765,000 / 220,000.

Failing:

- Worker authority chunk: 288,337 raw / 65,838 gzip, limits 240,000 / 60,000.
- Gap: 48,337 raw / 5,838 gzip.
- Complete worker closure: 1,251,678 raw / 333,011 gzip, limits 1,010,000 / 280,000.
- Gap: 241,678 raw / 53,011 gzip.
- Complete browser runtime: 3,593,541 raw / 1,163,874 gzip, limits 3,250,000 / 1,100,000.
- Gap: 343,541 raw / 63,874 gzip.

Do not raise these frozen limits to manufacture a pass. User-visible restoration currently has priority over further bundle optimization, but every release candidate must report the honest gate result.

## Important implementation invariants

- Local-first and user-owned.
- One durable Store/catalog authority.
- Physical transaction completion before logical publication.
- Target identity and catalog generation are explicit.
- Duplicate request IDs are replay-safe and return exact receipts.
- Stale writers are fenced.
- Structural changes use shadow Preview, explicit Keep, and Discard.
- Model output is untrusted and declarative.
- Executable model output is rejected even when no model credential is active.
- Provider credentials and HTTP stay in the trusted shell or backend, never the DB worker or panel runtime.
- Archives authenticate before parsing or target creation.
- Restore creates a new target and never silently replaces the source.
- Exports freeze one canonical projection and wait for pending writes.
- Same-origin OPFS may claim only `Protected on this device`.
- Full production payload cap remains exactly 2,000,000 UTF-8 bytes.
- Do not install public npm `xlsx` version 0.18.5. Clay uses a bounded reviewed OOXML path.

## Key files

- `packages/shell/src/app/App.tsx`: shell orchestration and current feature gates.
- `packages/shell/src/app/apps.ts`: presentation app cache.
- `packages/shell/src/app/worker-client.ts`: trusted-shell worker bridge.
- `packages/shell/src/worker/db-worker.ts`: DB-worker route dispatch.
- `packages/shell/src/worker/mutation-route-census.ts`: production route classifications.
- `packages/kernel/src/production-authority.ts`: durable authority boot and mutation coordination.
- `packages/kernel/src/device-catalog.ts`: durable target catalog.
- `packages/kernel/src/store.ts`: Store implementation and feature domains.
- `packages/kernel/src/projection.ts`: canonical snapshot-fenced projection.
- `packages/shell/src/app/RecoveryCenter.tsx`: backup and recovery owner UI.
- `packages/shell/src/app/TodayView.tsx`: Daily Home UI.
- `packages/shell/src/app/AutomationCenter.tsx`: Release E UI.
- `packages/shell/src/app/ImportWizard.tsx`: migration journey.
- `packages/shell/src/app/ExportDialog.tsx`: local export journey.
- `scripts/bundle-budget.mjs`: release size budgets.
- `scripts/browsers.mjs`: browser-gate harness.

## Test and release discipline

Use one writer per worktree. Do not edit other campaign worktrees. Before changing code, inspect HEAD, status, applicable specs, and production route classification.

For each regression:

1. Add or identify an executable failing test.
2. Confirm it fails for the expected reason.
3. Implement the smallest complete fix.
4. Run focused tests and package typechecks.
5. Run the full affected package suite.
6. Build with an exact source-tree identity.
7. Exercise the packaged user journey.
8. Obtain independent review against immutable bytes when required.

A feature is not shipped unless its commit is in final ancestry, its production route and UI are enabled, durable readback works, recovery works, and the packaged journey passes.

## Operational environment

- Windows 11 host.
- Use `corepack.cmd pnpm`, not bare `pnpm`.
- Python executables differ: `python3` is 3.13 and `python` is 3.11.
- Broad test/build work can hit Windows paging pressure. Serialize heavy operations.
- Existing reserved preview ports: 4173, 4174, 4175, 4177, and 4180.
- Do not stop unrelated processes or existing preview servers.

## Permissions

This handoff gives engineering context, not blanket side-effect authorization. Codex may inspect and edit this project when the user asks. It must not commit, push, merge, deploy, publish, alter production, handle secrets, or modify other worktrees without explicit instruction in the active Codex session.

Never import or summarize old private chat/session exports. This file is the approved compact context.
