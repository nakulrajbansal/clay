# Clay project instructions for Codex

## Workspace identity

- Project: Clay, a local-first malleable personal application.
- Open this directory: `D:\Clay`.
- Active Codex branch: `codex/clay-project`.
- Starting source commit: `1e6245c3363874642d49f22b371dad48543f53d8`.
- Starting source tree: `5af88c75a2eca8e4bad8a2edd7cb9e200d994ca5`.
- Detailed engineering and release handoff: `docs/CODEX_HANDOFF.md`.

Do not use `C:\Users\nakul\OneDrive\Project Folder\clay` as the active Codex checkout. It is a separate worktree on an older feature branch. Do not edit worktrees under `C:\Users\nakul\AppData\Local\hermes\profiles\clay\workspace\roadmap-campaign\worktrees\` unless Nakul explicitly asks.

Read `docs/CODEX_HANDOFF.md` before roadmap, authority, release, or integration work.

## Product principles

1. Data outlives every interface.
2. User-owned local state is authoritative.
3. Structural changes require a validated MutationPlan, shadow Preview, explicit Keep, and Discard.
4. User actions must be reversible or have an explicit recovery path.
5. Model and panel output are untrusted and receive no raw authority.
6. Mainstream user outcomes have priority over architectural ceremony.
7. A feature is complete only when the packaged user journey passes.

## Sources of truth

- `specs/README.md`: specification map.
- `specs/docs/10-decisions.md`: architecture decisions.
- `specs/docs/11-gap-resolutions.md`: accepted gap resolutions.
- `packages/schema`: closed shared contracts.
- `packages/shell/src/worker/mutation-route-census.ts`: production-route truth table.
- `scripts/bundle-budget.mjs`: frozen bundle limits.
- `docs/CODEX_HANDOFF.md`: current integrated state and roadmap gap.

When code and specification conflict, do not silently widen a capability. Resolve the conflict explicitly and add an ADR or gap resolution when required.

## Architecture boundary

- `packages/schema`: Zod and transport contracts.
- `packages/kernel`: SQLite, validation, projections, catalog, history, automation, intake, archive, and recovery primitives.
- `packages/mutation`: provider-agnostic planning clients and prompt contracts.
- `packages/panel-runtime`: sandboxed VNode renderer and trusted component vocabulary.
- `packages/shell`: React UI, DB worker, model boundary, browser storage, and release surfaces.
- `packages/backend`: hosted authentication, relay, sharing, intake, and Codex bridge services.

The DB worker and `ProductionStoreAuthority` are the sole durable write authority. `localStorage` is a presentation cache only. Never restore the old behavior in which an arbitrary shell app ID directly selected an OPFS namespace.

## Current MVP and immediate priority

The integrated source builds a tested local single-app MVP. It includes starter creation, records, views, panels, OPFS persistence, preview/Keep/Discard, bounded declarative reshaping, CSV/TSV/XLSX import into the current app, local Print/CSV export, read-only Daily Home, and Recovery Center status.

The next P0 is safe multi-app restoration. Commit `bb26c16f3c18b7e613aff48a828f0c98bc597631` contains a worker-owned lifecycle implementation but is not an ancestor of this branch. Reconcile it carefully. Do not blindly cherry-pick it and do not revive the old localStorage-authoritative flow.

A multi-app restoration must prove Create, Switch, Rename, Duplicate, Delete, independent data, deterministic fallback selection, lost-response retry, crash recovery, and adoption of existing OPFS namespaces in a packaged browser test.

Other known user-facing gaps are full backup/restore, writable Daily Home, enabled automation mutations, turnkey hosted sharing/intake, and committed text-to-relation conversion. Do not call these shipped merely because supporting code or UI exists.

## Windows commands

Use `corepack.cmd pnpm`, never bare `pnpm`.

```text
corepack.cmd pnpm install --frozen-lockfile
corepack.cmd pnpm typecheck
corepack.cmd pnpm test:ordinary
corepack.cmd pnpm build
corepack.cmd pnpm budget
```

Focused tests:

```text
node node_modules/vitest/vitest.mjs run <test-files> --maxWorkers=1 --minWorkers=1 --reporter=dot
```

Run package-local Vitest from that package directory. Serialize broad tests and builds when Windows memory is constrained. Do not stop unrelated WSL, Docker, browser, Discord, editor, or user workloads.

Reserved ports are `4173`, `4174`, `4175`, `4177`, and `4180`. Use another free port for new preview work unless Nakul explicitly replaces one.

## Definition of shipped

A roadmap feature is shipped only when:

- Its implementation commit is an ancestor of candidate HEAD.
- Its production routes are enabled and authority-backed.
- Its UI controls are enabled.
- Durable readback succeeds.
- Undo or recovery succeeds.
- A fresh packaged-browser journey passes.

Use RED, GREEN, REFACTOR for regressions. Run focused tests, package typechecks, affected package suites, a source-bound build, and the real browser journey. Changed bytes invalidate prior review evidence.

## Safety and Git boundaries

- Never read, print, copy, or commit secrets, tokens, passwords, connection strings, credentials, or private user data.
- Never add `eval`, raw HTML, unsafe panel capabilities, or broad panel network access.
- Keep provider HTTP and credentials in the trusted shell or backend, never the DB worker or panel runtime.
- Preserve request IDs, target identities, catalog generations, replay receipts, and existing user data.
- Do not weaken fail-closed routes merely to enable a button.
- Do not raise frozen bundle limits without explicit approval.
- Inspect and preserve current work before edits. Never reset or clean blindly.
- Do not commit, push, merge, deploy, publish, or alter production unless Nakul explicitly requests that action in the Codex session.
- Public deployment is not authorized by this project file.

## Working style

Inspect the live repository and Git state before claims. Work one vertical user journey at a time. Give concise checkbox updates with actual test output. Separate implementation, integration, certification, and shipping status. Never fabricate output or describe an isolated implementation as delivered.
