# Worker FIX phase 3A — core transition foundation — 2026-09-14

Base: `f53ac67eb3541b56c5d6bedadc0acbfd78563c64`, `D:\Clay`,
`codex/clay-project`. Clean HEAD and origin tracking ref matched at entry.
One writer, one uncommitted source/test diff. No Git writes, dependency changes,
deployment, production configuration, credential access, other-worktree edits,
server termination, browser launches, collector/budget changes or release evidence.
All A–F development and prior fixes are preserved. This is a verified development
checkpoint, **not completion of the aggregate optimization or certification**.

## Phase 3A source boundary

- `production-core-routes.ts` now owns one immutable closed `ProductionRouteSpec`
  registry and `ProductionTransition` interpreter for **18 existing routes**:
  `timeline.setCheckpoint`, `timeline.makeLatest`, `panel.rename`, `panel.remove`,
  `panel.revert`, `schema.addColumn`, `schema.addRelationColumn`,
  `schema.renameColumn`, `schema.convertTextToRelation`,
  `schema.undoRelationConversion`, `daily.source`, `daily.navigation`,
  `daily.timeZone`, `daily.capture`, `daily.undoCapture`, `daily.inbox`,
  `daily.undoInbox`, and `backup.manualDownload`.
- Each descriptor fixes its existing route, exact capture, pure preparation,
  closed command tuple, pinned Store executor and bounded JSON result validator.
  The closed `canonical-shadow-journal-v1` policy requires the existing exact
  target/catalog/fence, shadow, operation/fingerprint, reservation/invocation,
  guarded mutation, canonical/Merkle, publication/receipt/readback and recovery
  order. These obligations are unconditional coordinator behavior, not optional
  metadata booleans. Only the trusted-clock requirement varies within this family.
  The physical automation requirement on unmigrated routes is unchanged.
- A `StoreCommand` is only `[known route, that route's captured payload, requestId]`.
  Private WeakSets retain captured-request and compiled-transition identity;
  requests/programs are frozen, and forged/copied/cross-route programs fail closed.
  No raw SQL, arbitrary setting/column operation, executable input, caller-selected
  function, public package export or WorkerClient program transport was added.
  Existing descriptor/prototype/density/identifier checks and Store semantic
  validation remain. Durable ownership remains in the DB worker.
- `production-mutation-coordinator.ts` uses the registry for core capture/dispatch
  and clock/transaction policy, removing duplicate core route lists. Shared
  `#canonical()` performs each original read afresh, with no caching or omitted
  validation. `capturedJsonExecution` replaces 30 identical result wrappers.
  `production-json-capture.ts` shares the unchanged strict JSON capture and error
  mapping; the full production payload cap remains exactly 2,000,000 UTF-8 bytes.
  Existing separately bounded internal import/intake staging budgets are unchanged.
- Six repeated queue implementations now use the original serialized read/write
  queue. Synchronous capture, poison checks, rejection scheduling and post-response
  intake validation retain their order. Operational metrics keep their dedicated
  canonical-preservation/no-op behavior: no canonical receipt or reservation is
  introduced for an operational no-op.
- Uncalled, source-private test fault maps are allocated only by the test armer,
  allowing normal static tree shaking to remove injected-failure branches from
  production. Real failure/abandonment/recovery handlers remain unchanged. There
  is no environment switch or production no-lock/no-transaction fallback.
- Lifecycle create/delete/restore remain dedicated. The substantial transaction
  body in `#executeMeaningful` is **not yet consolidated into a new stage engine**;
  it still owns the original physical protocol. Samples, automation, intake,
  import and other route families have not joined the core descriptor registry.
  No DB-worker dispatch/census generation was introduced. The 25 callerless
  compatibility routes remain retired and fail closed.

## Independent oracle and RED/GREEN record

- Before production switching, captured the complete old coordinator and core
  routes in `packages/kernel/test/oracles/`. Only relative imports, provenance and
  the test capture export differ from the base. Old coordinator uses old core.
  LF-normalized SHA-256 pins in `production-transition-modules.test.mjs`:
  core `81a0b0caaa38995b2ef03f6938099315ca54217fb077e171db48e28f3622d92b`;
  coordinator `cbe246a43ee4ff91c6b87ee740c6bb855c167a5146a63e3688cf078561a1ce1d`.
  The Phase 2 independent catalog/archive readers remain untouched.
- `production-transition.test.ts` uses separate owned user/system/catalog copies
  with exact SQLite DDL/rows and the real LiveWriteGuard. Fixed synthetic time and
  randomness permit comparison of returned responses, error code/message/order,
  all physical rows/DDL, user/system export bytes, canonical/Merkle and catalog
  target/reservation/receipt state. Catalog bytes are compared as physical
  schema/rows, not claimed as a serialized catalog-file byte comparison.
- Coverage includes commit/replay/no-op, payload collision/stale replay, immutable
  queue capture/read barriers, poison propagation, source/navigation CAS, Capture
  and Undo/cancellation, all Inbox actions/Undo, relation Keep/Undo, manual download
  metadata, bounded descriptor capture, and forged/cross-route program rejection.
  Reservation, invocation, publication and readback faults run independently for
  panel, Daily and relation families. Additional failures cover live mutation,
  after-mutation rollback, stale fence, failed abandonment and worker loss/reopen
  through unchanged ProductionStoreAuthority reservation recovery.
- Initial small-family differential: 12 passed / one missing-spec RED, then
  14 passed. Daily/relation and direct-column expansion each exposed missing
  registry REDs before switching. Manual download and cross-route preparation
  likewise failed before fixes. Queue behavior tests passed against the old
  scheduling while the seven-queue structural test was RED, then GREEN.
- An intermediate run reported 38 passing assertions but exited 1 with Vitest
  `Timeout calling "onTaskUpdate"`; this was **not a passing gate**. Real event-loop
  yields between independent WASM executions fixed worker RPC starvation, without
  changing test/product timeouts. Subsequent focused and full runs had no reported
  unhandled errors. Intermediate focused packet: 118 passed / 9 files, 219.34s,
  `test-results/fix-batch/transition-focused.json` (superseded by final suites).
- Final new tests: **40 differential/behavior tests + 6 module/source tests**.
  The latter pin oracles, enforce a single queue and closed policy, reject forged
  module reports and test/oracle inclusion, and require injected test branches to
  be absent in emitted production code. The additional
  `scripts/production-transition-module-check.mjs` checks the actual artifact;
  it does not replace or alter frozen collectors.

## Phase 3A final verification and actual size

All six full suites passed on final production source: **2,943 passed / 1 skipped**.
Installed package-local commands were run serially:
`node node_modules/vitest/vitest.mjs run --maxWorkers=1 --minWorkers=1 --reporter=dot --reporter=json --outputFile.json=../../test-results/fix-batch/<package>-transition.json`.

| Final-source gate | Actual result |
| --- | --- |
| Full kernel | PASS: 1,313 passed / 1 skipped; 117 passing / 1 skipped files; 584.91s |
| Full schema | PASS: 512 tests / 22 files; 18.02s |
| Full mutation | PASS: 60 tests / 8 files; 5.02s |
| Full panel-runtime | PASS: 66 tests / 4 files; 7.29s |
| Full backend | PASS: 111 tests / 11 files; 10.01s |
| Full shell, including A–F WorkerClient/db-worker, native recovery and renderer fixtures | PASS: 881 tests / 137 files; 404.44s; no unhandled-error report |
| Package-local `node node_modules/typescript/bin/tsc --noEmit` | All six exited 0 |
| Panel package-local `node node_modules/vite/bin/vite.js build` | PASS: 5 modules; 653ms |
| `node scripts/bundle-module-report.mjs` | PASS: actual production build; 162 modules; 14.85s |
| Renderer, standalone, AuthorityGraph and production-transition module guards | All four exited 0; one Preact/validator/graph/transition closure; no production test/oracle or injected fault branch |
| `node --test scripts/bundle-budget.test.mjs` | PASS: 19 tests; 134.63ms |
| `node scripts/bundle-diagnostic.mjs` | Exit 1: only completeWorker and completeBrowser remain over budget |
| Unchanged `node scripts/bundle-budget.mjs` | Freshness PASS, then exit 1 at complete worker (exact error below) |
| `node scripts/roadmap-development-census.mjs` | Exit 0: developmentComplete=true; 21 capabilities; zero development blockers/hard-disable flags; 25 explicitly retired routes. Inventory only |
| `git diff --check`; read-only collector/limit/lockfile/census/evidence comparison | Exit 0; those frozen inputs and release evidence are unchanged |
| Bounded scan of three changed production modules and new module guard | Zero flagged dynamic execution, debugger, unsafe HTML assignment or private-key/bearer literal; not security certification |

```text
Error: database worker JavaScript closure: 1371604 B raw / 376955 B gzip exceeds 1010000 B / 280000 B
```

Final ignored development reports: `test-results/fix-batch/bundle-modules.json`,
`bundles.json`, and the six `<package>-transition.json` suite reports. No checked-in
release/browser evidence was regenerated. The source/test/handoff change is ten
paths. A separate untracked **tool-generated** PowerShell cache remains at
`Microsoft/Windows/PowerShell/ModuleAnalysisCache` (8,246 bytes). The exact-path
`Remove-Item -LiteralPath 'D:\Clay\Microsoft\Windows\PowerShell\ModuleAnalysisCache'`
cleanup command was rejected before execution with `blocked by policy`; it was
not retried through another mechanism. This regenerable cache is not application
source or evidence and should not enter the checkpoint. Final sizes supersede intermediate
measurements, including the first five-route build's size regression:

| Boundary | Entry raw / gzip | Final raw / gzip | Frozen raw / gzip | Result |
| --- | ---: | ---: | ---: | --- |
| totalShellJavaScript | 892,215 / 279,167 | **892,215 / 279,148** | 980,000 / 290,000 | PASS |
| applicationStyles | 60,905 / 16,825 | **60,905 / 16,825** | 67,000 / 17,000 | PASS |
| workerAuthority | 221,857 / 56,461 | **218,340 / 56,428** | 240,000 / 60,000 | PASS |
| completeWorker | 1,375,121 / 376,966 | **1,371,604 / 376,955** | 1,010,000 / 280,000 | FAIL: 361,604 / 96,955 over |
| completeBrowser | 3,300,156 / 1,110,244 | **3,296,639 / 1,110,214** | 3,250,000 / 1,100,000 | FAIL: 46,639 / 10,214 over |

Actual savings: complete worker **3,517 raw / 11 gzip**; complete browser
**3,517 raw / 30 gzip**. This is a small raw reduction, **not a meaningful gzip
solution**. Shared strings/queue/canonical calls already compressed well, and the
new closed registry offsets part of the deletion. Shell raw and all styles are
unchanged; asset-reference changes account for shell's 19-byte gzip variation.
All other measured boundaries pass. No worker code moved to shell.

Rendered membership (not additive bundle savings): coordinator **99,433**, core
routes **14,531**, Store **265,257**, DeviceCatalog **166,513**, AuthorityGraph
**17,689**, archive-authority **53,450**, production-authority **67,350**.
The unchanged asyncstore file is **498,392 / 143,296**, target-authority
**191,808 / 41,104**, shared SQLite **210,779 / 62,560**. These dominate the remaining
complete-worker gap; moving them between emitted files is not a reduction.

## Exact continuation after phase 3A

1. Preserve the frozen coordinator/core and graph oracles and the current green
   A–F integration suite. Do not migrate the physical lifecycle/restore engines.
   Preserve the operational-metrics policy, strict capture/error order and the
   native automation guard. No command/census names or caller reachability changed.
2. Next descriptor family: samples, using independent old/new copies before any
   production switch. Its provenance, empty/removal/no-op, operation/batch identity
   and result wrapper differ from the core JSON routes; declare those differences
   as a closed policy, not default-open flags. Then automation/intake/import only
   after their own fault/replay/source/transaction parity. Retired routes must not
   become callable merely because an internal legacy implementation exists.
3. Current coordinator seams: `captureMutation` line 618 (11,336 source chars),
   `executeCapturedMutation` line 1065 (12,192), `#executeMeaningful` line 2341
   (11,477). The latter's reservation/invoke/mutate/publish/readback algorithm is
   intentionally intact. Extending the descriptor scaffold alone will not close
   the gap; pursue actual repeated-policy/reducer deletion, with measurements.
4. Store reducer work has **not** started and no frozen Store oracle was captured.
   Before each move, capture independent original behavior and physical/fault
   fixtures. Exact unchanged seams: `prepareSemanticAssignments` line 969 (15,720
   source chars), `runDueAutomations` line 4731 (9,905), `acceptIntakeSubmission`
   line 3132 (7,436), `commitImport` line 5220 (6,742), `rawArchiveSchemaIssues`
   line 493 (6,228). Do not treat these source lengths as promised bundle savings.
5. Remaining controlling gaps are **361,604 / 96,955 worker** and **46,639 / 10,214
   browser**. Frozen collectors/limits, renderer/standalone/graph/module boundaries,
   shell/style headroom and all user journeys must remain intact. Another worker
   architecture phase is required; FIX completion is not claimed.
6. Parent runs source-bound packaged browsers after stabilization. Release B
   source rebinding/frozen-runtime certification, clean-tree local-export,
   human NVDA and final review remain later gates. No certification/shipment
   claim and no commit/push in this sandbox.

---

# Worker FIX phase 2 — shared AuthorityGraph — 2026-09-14

Base: `28db0b9ed11eb6e169325d4cfc9250bdf83e1414`, `D:\Clay`,
`codex/clay-project`. Clean HEAD and origin tracking ref matched at entry.
Sole writer, one uncommitted diff; no Git writes, dependency changes, deployment,
production configuration, credential access, other-worktree edits, browser
launches, server termination, collector/budget changes or release evidence.
All prior A–F, renderer/CSS, SQLite, planner and standalone-validator work stays.

## Phase 2 source boundary

- `packages/kernel/src/authority-graph.ts` now contains the shared relationship
  engine and retained-ID ledger. It receives only bounded, already captured and
  codec-validated rows/maps. Its only runtime import is ClayError: no SQL,
  database handle, schema factory, network, worker command, or mutation authority.
- Closed modes are `live`, `recovery`, and `archive-v1` / `archive-v2` /
  `archive-v3`. The archive labels refer to **catalog evidence versions inside
  authenticated archive format 5**, not a change to the outer archive format.
  Archive modes require the selected-target revision mirror; unknown modes fail.
- Shared checks cover active/genesis binding, revision chains and target mirrors,
  reservation/lease/finalizer epoch/time binding, known target evidence, backup
  publication uniqueness, event ordering and forward/reverse publication links,
  lease issuance, selected-app and metadata history, lifecycle terminal-event /
  physical-generation relationships, and retained identity reference accounting.
  Lease issuance uses one epoch/time index, preserving the archive's bounded
  lookup cost instead of introducing a nested lease/event scan.
- Live and archive adapters call stages in their original public error order.
  Live errors retain the existing E_CATALOG_UNAVAILABLE catch boundary; archive
  graph errors retain E_VALIDATION and the original reason text/prefix. Nullable
  retained references are permitted only for archive optional fields, not live.
- `device-catalog.ts` retains exact DDL/object allowlists, physical field codecs,
  cardinality, closed pending-row decoding, tombstones, pending lifecycle/restore
  fencing, manifest/storage identities, no-op identity migration and quarantine.
  `archive-authority.ts` retains authentication-before-ZIP/target creation,
  member/checksum/canonical JSON/Merkle/cardinality checks, target request-response
  mirrors, version compatibility and nonterminal/quarantined-work rejection.
  Distinct lifecycle provenance/canonical-result policies remain at the adapters.
  Existing shared retention, lifecycle reattestation and private owner-history
  validators stay authoritative; they were not replaced with permissive graph
  defaults or duplicated behind a new generic command.
- No StoreCommand/transition interpreter was started (phase 3 remains untouched).
  The actual size gain is modest; graph sharing does not close aggregate budgets.

## Independent oracle and RED/GREEN record

- Before switching production, captured both complete readers from the base into
  `packages/kernel/test/oracles/`. Only relative imports were relocated; test-only
  exports expose the old readers. Source hashes (LF-normalized) prevent silently
  editing these oracles to agree with a refactor. They never enter production.
- `authority-graph-fixtures.ts` captures the pre-switch physical/archive builder.
  `authority-graph.test.ts` compares independent owned SQLite copies and separately
  authenticated synthetic archive copies, including exact accepted output and
  public failure code/message. No real credential or owner store is consulted.
- Differential states: empty, committed multi-app, retained tombstone, active and
  abandoned reservations, expiry takeover, pending restore/create, rename receipt,
  35 backup publications plus a durable removal acknowledgement, and all three
  format-5 catalog evidence versions. Corruptions cover identities/discriminators,
  missing/extra rows, ordering, generation/epoch/time, finalizer and publication
  mirrors, selection/metadata, pending jobs, retention and authentication.
- Initial RED: missing graph module. After adding the engine but before adapter
  switching, **51 passed / 1 failed** (production wiring remained absent).
  Switched core checks: **52 passed**, then **118 passed** across graph/catalog/
  archive packets. Expanded graph differential: **61 passed**. A dedicated null-
  reference RED caught archive-only optionality leaking into the live ledger;
  fixed with closed-mode behavior: **62 passed**.
- Final focused packet (graph, DeviceCatalog, archive authority, retention,
  app lifecycle, production restore lifecycle): **156 passed / 6 files, 80.96s**,
  `test-results/fix-batch/authority-graph-focused.json`.
- `authority-graph-modules.test.mjs`: **3 passed** after missing-guard RED. It pins
  oracles, enforces no graph I/O/schema factories, and tests rejection of missing,
  duplicated or shell graph modules and any production test/oracle module.
  `node scripts/authority-graph-module-check.mjs` checks the actual build report;
  it is an additional architecture guard, not a collector or certificate.

## Phase 2 final verification and measurement

All six full suites passed on the final production source: **2,897 passed /
1 skipped**. Commands used installed package-local binaries, serially:
`node node_modules/vitest/vitest.mjs run --maxWorkers=1 --minWorkers=1 --reporter=dot --reporter=json --outputFile.json=../../test-results/fix-batch/<package>-authority-graph.json`.

| Final-source gate | Actual result |
| --- | --- |
| Full kernel | PASS: 1,267 passed / 1 skipped, 116 files, 470.03s |
| Full schema | PASS: 512 tests / 22 files, 17.97s |
| Full mutation | PASS: 60 tests / 8 files, 4.97s |
| Full panel-runtime | PASS: 66 tests / 4 files, 7.20s |
| Full backend | PASS: 111 tests / 11 files, 9.98s |
| Full shell, including A–F WorkerClient/db-worker and native recovery fixtures | PASS: 881 tests / 137 files, 399.05s; no unhandled-error report |
| `node node_modules/typescript/bin/tsc --noEmit` in each package | All six exited 0 |
| Panel package-local `node node_modules/vite/bin/vite.js build` | PASS: 5 modules, 666ms |
| `node scripts/bundle-module-report.mjs` | PASS: actual production build, 162 modules, 14.84s |
| `node scripts/renderer-module-check.mjs` | PASS: one Preact closure; raw shell planner / closed worker decoder |
| `node scripts/standalone-module-check.mjs` | PASS: no Zod/authoring factories; one shared engine |
| `node scripts/authority-graph-module-check.mjs` | PASS: one worker graph; no shell graph or test oracle |
| `node scripts/bundle-diagnostic.mjs` | Exit 1: exactly completeWorker and completeBrowser remain over budget |
| Unchanged `node scripts/bundle-budget.mjs` | Freshness PASS, then exit 1 at the complete worker closure; exact error below |
| `node --test scripts/bundle-budget.test.mjs` | PASS: 19 tests, 134.01ms |
| `node scripts/roadmap-development-census.mjs` | Exit 0: developmentComplete=true, 21 capabilities, no development blockers/hard-disable flags, 25 retired compatibility routes; inventory only |
| `git diff --check` and bounded changed-source scan | Exit 0; 11 changed/new paths; no flagged dynamic execution, debugger, unsafe HTML assignment or private-key literal. Not security certification |
| Read-only diff comparison of collectors, limits, lockfile, route census and `evidence/` | Unchanged |

The unchanged frozen gate's actual failure:

```text
Error: database worker JavaScript closure: 1375121 B raw / 376966 B gzip exceeds 1010000 B / 280000 B
```

Final diagnostic artifacts are ignored development outputs at
`test-results/fix-batch/bundle-modules.json` and `bundles.json`. No historical
release report was regenerated. The first intermediate measurement (6,033 /
608 worker bytes saved) is superseded by these final-source measurements:

| Boundary | Entry raw / gzip | Final raw / gzip | Frozen raw / gzip | Result |
| --- | ---: | ---: | ---: | --- |
| totalShellJavaScript | 892,215 / 279,135 | **892,215 / 279,167** | 980,000 / 290,000 | PASS |
| applicationStyles | 60,905 / 16,825 | **60,905 / 16,825** | 67,000 / 17,000 | PASS |
| workerAuthority | 231,268 / 58,286 | **221,857 / 56,461** | 240,000 / 60,000 | PASS |
| completeWorker | 1,381,089 / 377,530 | **1,375,121 / 376,966** | 1,010,000 / 280,000 | FAIL: 365,121 / 96,966 over |
| completeBrowser | 3,306,124 / 1,110,773 | **3,300,156 / 1,110,244** | 3,250,000 / 1,100,000 | FAIL: 50,156 / 10,244 over |

Net savings: complete worker **5,968 raw / 564 gzip**; complete browser **5,968 /
529**. Shell raw bytes and all CSS are unchanged; rebuilt asset references vary
the shell gzip total by +32 bytes. No worker code moved into shell. All other
measured boundaries pass. Authority headroom is now 18,143 / 3,539; shell gzip
headroom 10,833 and styles gzip headroom 175. Do not assume estimated future gains.

Actual rendered membership: shared graph **17,689** and DeviceCatalog **166,513**
in target-authority; archive-authority **53,450** and coordinator **106,003** in
worker-authority; Store **265,257** in asyncstore. These rendered source lengths
are not additive bundle/gzip savings. Aggregate closure reduction is much smaller
than the source deletion because the shared graph replaces repeated predicates
and retains their differing policies/errors. Phase 3 is still required; neither
aggregate gate is represented as passing.

## Exact continuation after phase 2

1. Preserve the shared graph and frozen independent readers. Do not merge live
   and archive stage order, drop physical/authentication adapters, or weaken
   retention/legacy/owner-history policies to simplify a graph mode.
2. The next architectural phase is a closed transition kernel, one route family
   at a time with independent-store/failpoint differential tests BEFORE switching.
   Retain stable persisted route strings and original capture/error ordering,
   no-op/receipt policy, reservation/fencing, native transaction prerequisite,
   poisoning/abandonment and exact readback. Lifecycle create/delete/restore stay
   dedicated. No raw SQL, arbitrary setting/table/code, helper-worker authority
   or shell final-write path may be introduced.
3. Exact unchanged coordinator seams: `captureMutation` at line 666 (11,967 source
   characters), `executeCapturedMutation` at 1129 (13,062), `#executeMeaningful`
   at 2438 (11,794). Operational metrics have deliberately different canonical
   and no-op policies: do not collapse these using default-open booleans.
   `production-core-routes.ts` is already a closed capture/execution union; keep
   its strict descriptor/prototype/payload checks when evaluating a family.
4. Large remaining Store seams: `prepareSemanticAssignments` at 969 (15,720),
   `runDueAutomations` at 4731 (9,905), `acceptIntakeSubmission` at 3132 (7,436),
   `commitImport` at 5220 (6,742), `rawArchiveSchemaIssues` at 493 (6,228).
   These are source character counts, not projected bundle savings. Use actual
   closure membership and measurements; graph sharing alone is far from enough.
5. Parent runs packaged browsers after source stabilizes. Release B rebinding,
   frozen-runtime certification, clean-tree local export, manual NVDA and final
   review remain external later gates. No FIX completion, certification or
   shipment is claimed by this development/optimization checkpoint.

---

# Historical worker FIX phase 1 — closed standalone validators — 2026-09-14

Base: `da925383ea11398291ca4bbc5163a1ad99c2d7f9`, `D:\Clay`,
`codex/clay-project`; HEAD and the origin tracking ref matched at entry. This is
one uncommitted source/test refactor by the sole writer, not a release candidate.
No dependency installation, Git write, deployment, credential access, other
worktree, browser launch, server termination, collector change or budget change.
Prior A–F, Preact, CSS, shared SQLite and Acorn specialization are preserved.

## Current worker-refactor boundary

- Added a deterministic, build-time compiler and 18 source-bound standalone
  contract modules (368 named validators; 38 generated source/type files).
  `@clay/schema/standalone/*` exposes parse/safeParse and typed enum options;
  the original Zod exports remain the development/test oracle. Import/staging,
  metrics, saved-view, intake-state and command schemas were lifted verbatim
  into authoring files so no production caller constructs a Zod schema.
- The closed compiler pins all authoring/helper inputs and the complete pinned
  Zod ESM dependency closure, checks the resolved package identity, rejects
  unexpected input paths and schema AST/hooks, and has no auto-approval flag.
  Refinement code remains ordinary static source, with distinct spans for
  chained refinements. Arbitrary transforms, coercion, defaults, recursion,
  custom validators and maps fail closed. The existing JSON recursion and import
  ArrayBuffer predicate are explicitly supported, not generalized fallbacks.
- `standalone/runtime.mjs` interprets generated validation data only; programs
  are not accepted through any worker command. A deterministic literal pool
  removes repeated inert program data; callbacks, lexical references, stateful
  regexes and externally exposed enum options are not pooled. Whole schema
  construction uses PURE IIFEs, preserving the existing narrow-import boundary
  under both Rollup and esbuild. Parse calls themselves are never marked pure.
- Kernel and trusted-shell value imports now use standalone modules. Existing
  captureStrictJson, the full 2,000,000-byte input envelope, ClayError adapters,
  request/receipt identity, journal/fence checks, SQL and durable writes remain
  in their original worker/authority paths. No authority relationship or
  transition algorithm has yet been consolidated (phases 2/3 are NOT done).
- Build guards run deterministic generation `--check`, reject authoring/Zod
  production modules, and verify a single shared interpreter asset. Existing
  renderer and planner transport guards still pass. Generator operation and
  supported contracts are documented in `packages/schema/scripts/README.md`.
- `node scripts/schema-production-inventory.mjs --output` records actual-module
  source imports plus source-bound per-declaration policies/checks in ignored
  `test-results/fix-batch/schema-production-inventory.json`: **117 imports,
  zero authoring factories, 18 contract sources**. This is development inventory,
  not certification. The unchanged A–F route census remains authoritative.

## Worker-refactor verification

Deterministic REDs caught issue-order/own-property differences, chained-hook
identity collision, unsupported AST/manifest handling, enum-option aliasing,
and old-runtime module presence. Differential packets now cover every generated
public validator, nested alternatives/bounds, canonical outputs, issue paths and
messages, unknown keys, prototypes/accessors, symbols, sparse arrays, Unicode,
non-finite inputs, defaults, transforms supported as string checks, and refinements.
This is executable differential coverage, not a claim of exhaustive equivalence.

Real results so far (repository-local installed binaries, broad commands serial):

| Command / working directory | Result |
| --- | --- |
| Package-local Vitest, initial full kernel after adapter switch | PASS: 1,202 passed / 1 skipped, 114 files, 463.03s |
| Package-local Vitest, initial full schema | PASS: 505 tests / 21 files, 17.95s |
| Full shell with JSON output `shell-standalone.json` | RED: 878 passed / 1 failed, 137 files, 408.05s; no unhandled-error report |
| Full shell with JSON output `shell-standalone-final.json`, before final proxy read-order adjustment | PASS: 881 tests / 137 files, 397.48s; no unhandled-error report |
| `test/schema-tree-shaking.test.mjs` after construction fix / shell | GREEN: 3 tests; original staging-only assertion retained |
| `test/shared-validation-runtime.test.mjs test/schema-tree-shaking.test.mjs` / shell | PASS: 6 tests, including independent standalone realm compilation |
| Standalone compiler/pool/runtime/effects/generated focused packet / schema | PASS: 351 tests / 5 files, 8.54s |
| `node packages/schema/scripts/generate-standalone.mjs --check` / root | PASS: 18 modules, 368 validators, 38 files |
| Kernel and shell package-local `tsc --noEmit` after import/type adaptation | Both exited 0 |
| Panel Vite build / panel-runtime | PASS: 5 modules, 660ms |
| `node scripts/bundle-module-report.mjs` / root, final construction source | PASS: actual production build, 162 modules, 14.84s |
| `node scripts/renderer-module-check.mjs` / root | PASS: one Preact closure; no React/ReactDOM/Scheduler; raw shell planner + closed worker decoder |
| `node scripts/standalone-module-check.mjs` / root | PASS: no Zod/authoring factories; one shared standalone interpreter asset |
| `node scripts/bundle-diagnostic.mjs` / root | Exit 1: only completeWorker and completeBrowser are over budget |

Final full-suite/typecheck/collector reruns are complete and recorded below.
The initial kernel/schema results precede the final literal-pooling/construction
adjustments and must not be substituted for final-source package results.
An additional RED/GREEN accessor test corrected exact-length array read order
and the simultaneous-too-big/too-small issue shape for a changing proxy.
The runtime packet is now seven tests. Reports/builds preceding that adjustment
are explicitly superseded by the final-source reruns below.

Final-source results (all six package suites passed; 2,832 tests passed / 1 skipped):

| Gate | Result |
| --- | --- |
| Full schema, `schema-standalone-verified.json` | PASS: 512 tests / 22 files, 18.09s |
| Full mutation, `mutation-standalone-verified.json` | PASS: 60 tests / 8 files, 5.19s |
| Full panel-runtime, `panel-runtime-standalone-verified.json` | PASS: 66 tests / 4 files, 6.90s |
| Full backend, `backend-standalone-verified.json` | PASS: 111 tests / 11 files, 10.48s |
| Full kernel, `kernel-standalone-verified.json` | PASS: 1,202 passed / 1 skipped, 114 files, 463.88s |
| Full shell, `shell-standalone-verified.json` | PASS: 881 tests / 137 files, 398.40s; no unhandled-error report |
| `node node_modules/typescript/bin/tsc --noEmit` in each of six packages | All six exited 0; the shell finder first caught a missing build-guard declaration, now provided without an any-cast |
| `node node_modules/vite/bin/vite.js build` / panel-runtime | PASS: 5 modules, 676ms |
| `node scripts/bundle-module-report.mjs` / root | PASS: actual production build, 162 modules, 15.03s |
| Renderer/planner and standalone module checks / root | Both exited 0: one Preact closure, closed worker decoder, no Zod/authoring factories, one shared standalone engine |
| `node scripts/bundle-diagnostic.mjs` / root | Exit 1: exactly completeWorker and completeBrowser remain red; measurements below |
| `node scripts/bundle-budget.mjs` / root, unchanged | Exit 1: freshness PASS, then `database worker JavaScript closure: 1381089 B raw / 377530 B gzip exceeds 1010000 B / 280000 B` |
| `node --test scripts/bundle-budget.test.mjs` / root | PASS: 19 tests, 124.49ms |
| `node scripts/schema-production-inventory.mjs --output` / root | Exit 0: 117 imports, zero authoring factories, 18 contract sources |
| `node scripts/roadmap-development-census.mjs` / root | Exit 0: developmentComplete=true, 21 capabilities; inventory only, no tests/browser proof executed by this command |
| Added-content scan / root | No flagged dynamic execution, unsafe HTML assignment, debugger or credential literal. Bounded scan, not security certification |

Full package commands used the installed package-local Vitest binary, serially:
`node node_modules/vitest/vitest.mjs run --maxWorkers=1 --minWorkers=1 --reporter=dot --reporter=json --outputFile.json=../../test-results/fix-batch/<package>-standalone-verified.json`.
The full kernel/shell runs include the catalog, target, archive, planner, import,
Daily Home, automation, intake, lifecycle, restore, owner-recovery and native
recovery packets, including real WorkerClient/db-worker integration fixtures.
These are not packaged browser certification. A prior generated historical
bundle-report side effect was reverted to exact HEAD bytes; current measurements
remain only in ignored diagnostic outputs. Collectors, limits and lockfile are
unchanged.

## Measured worker-refactor checkpoint

The latest actual module report and full diagnostic are in
`test-results/fix-batch/bundle-modules.json` and `bundles.json` (not release evidence).

| Boundary | Entry raw / gzip | Current raw / gzip | Frozen raw / gzip | Result |
| --- | ---: | ---: | ---: | --- |
| totalShellJavaScript | 947,561 / 289,911 | **892,215 / 279,135** | 980,000 / 290,000 | PASS |
| applicationStyles | 60,905 / 16,825 | **60,905 / 16,825** | 67,000 / 17,000 | PASS |
| completeWorker | 1,434,812 / 387,687 | **1,381,089 / 377,530** | 1,010,000 / 280,000 | FAIL: 371,089 / 97,530 over |
| completeBrowser | 3,369,405 / 1,122,212 | **3,306,124 / 1,110,773** | 3,250,000 / 1,100,000 | FAIL: 56,124 / 10,773 over |
| workerAuthority | 212,957 / 53,228 | **231,268 / 58,286** | 240,000 / 60,000 | PASS |

Actual net savings: worker **53,723 raw / 10,157 gzip**; browser **63,281 / 11,439**;
shell **55,346 / 10,776**. The proposed standalone design target of 83,000 / 20,000
was NOT reached. Schema representation and chunk membership offset part of the
removed runtime. Splitting assets is not a substitute for further source deletion.
All other measured boundaries pass. Worker-authority headroom is now only
8,732 / 1,714; styles gzip headroom remains 175. Do not assume new headroom.

## Exact continuation — shared authority graph, not certification

1. Preserve this standalone implementation and its oracle/build guards. Begin
   phase 2 at `device-catalog.ts:821` (`readValidatedCatalog`, 34,236 source
   characters) and `archive-authority.ts:866` (`validateAuthorityHistory`, 26,398).
   Capture independent live/archive fixtures and corruption differentials FIRST.
   Normalize only already-captured, bounded rows into a shared `AuthorityGraph`;
   use closed live/recovery/archive-version discriminants, not permissive booleans.
   Keep exact DDL/object allowlists, physical cardinality, codecs and live pending
   job semantics in the live adapter. Keep authentication-before-ZIP, member/
   canonical JSON/checksum/Merkle/cardinality and archive compatibility at the
   archive adapter. Do not mask nonterminal lifecycle work or legacy quarantine.
2. Concrete duplicated relationship seams are generation/app/genesis binding;
   retained identity reference accounting; reservation-to-lease and finalizer
   time/epoch binding; generation event ordering/reservation publication mirrors;
   lifecycle/backup receipt history. Live and archive have real differences in
   pending work, tombstones, old no-op identity migration and sealed history.
   Preserve them explicitly and retain error adapters. No graph implementation
   or graph differential oracle has been added in this turn.
3. Actual rendered source membership: DeviceCatalog **181,701** bytes in target
   authority; archive-authority **69,728** and production-mutation-coordinator
   **106,003** in worker authority; Store **265,257** in asyncstore. These are
   Rollup rendered lengths, NOT additive gzip savings. Current large chunks:
   asyncstore ~498 KB, target authority ~188 KB, DB entry ~160 KB, focused worker
   authority ~231 KB, SQLite ~211 KB. Use fresh reports after every structural move.
4. Only after shared graph parity and measurement, attempt phase 3. The next
   coordinator seams are captureMutation / executeCapturedMutation /
   #executeMeaningful; Store prepareSemanticAssignments, runDueAutomations,
   acceptIntakeSubmission and commitImport remain large. Migrate one closed
   route family at a time with independent-store/failpoint differentials;
   lifecycle/create/delete/restore stay dedicated. Preserve stable routes,
   error ordering, no-op/replay, poisoning, native recovery and sole worker ownership.
5. Browser execution, Release B rebinding/frozen runtime, clean-tree local export,
   manual NVDA and final integrated review remain for the parent workflow after
   source stabilizes. No certification, release or full FIX completion is claimed.

---

# Historical checkpoint — Preact and shared styles — 2026-09-14

Base: `7b4a905351a97fe2f7d0c79e7ba028a9d22a037c`, `D:\Clay`,
`codex/clay-project`. The base and origin tracking ref matched at entry. Sole
writer; no commit, push, merge, deployment, dependency installation, credential
access, other-worktree edit, browser launch, or server termination. Parent's
exact Preact dependency checkpoint and prior A–F/native-recovery work are intact.
The dependency blocker described in the historical section below is RESOLVED.

## Current source changes

- Vite and Vitest share exact renderer aliases and Preact deduplication.
  `react-dom/client` uses `preact/compat/client`: the pinned compat root does NOT
  export `createRoot`. React types remain compile-only. A build-time module
  assertion and `scripts/renderer-module-check.mjs` reject React, ReactDOM,
  Scheduler, mixed/duplicate Preact, and renderer code in workers. Actual module
  reports have passed with one core/hooks/compat/client/JSX closure.
- Tests use Preact's `act`. Compatibility covers controlled input/checkbox/select,
  native blur/capture/bubble, refs/layout effects, external stores, iframe mounts,
  lazy/Suspense, class error boundaries, portals/drag/drop, modal Tab/Escape,
  background inert/aria-hidden, scroll locks and trigger restoration.
  `FocusControl.tsx` explicitly preserves mount-time autofocus; Preact does not
  emulate React's imperative autofocus on newly inserted controls.
- Private metrics, Shape Map and Import Wizard reuse `ModalDialog`.
  Shape Map navigation can preserve destination focus; inline cancellation retains
  first-Escape ownership. A deterministic RED caught parent + delayed-child teardown
  restoring `inert=true`; per-background reference counting fixes it without
  weakening nested modal isolation. Ten repeated App lazy wrappers now share the
  small `SurfaceBoundary`; literal dynamic imports and independent error boundaries
  remain. Loading/failure/ready states are tested independently.
- Automation draft edits read the latest retained fields before applying another
  input event. Today setup is disabled until the original authority read completes;
  a failed read now has an explicit error and read-only retry instead of a stuck
  loading claim. Existing request identities, cancellation, CAS, Undo, and custody
  boundaries are unchanged.
- `primitives.css` consolidates exact shared declarations and native selector
  aliases. JSX keeps semantic classes plus zero-specificity utility parameters.
  Geometry, overflow, responsive/print overrides, motion and stacking remain in
  their feature sheets. Cascade-sensitive exceptions stay at their original source
  positions. Empty component rules are deliberate ownership anchors for the
  declaration-equivalence fixture; the minifier emits no empty rules.
  CSS class names retain deterministic component-family locality after compaction;
  public panel theme tokens, runtime-only names and reserved symbols are preserved.
- New style tests re-expand every factored declaration against the original source
  fixture, check carrier literals, and compare actual JSX selector witnesses under
  source/shell-first/reverse-lazy sheet orders, rest/engaged/disabled states,
  overlapping 1280/320/160px breakpoints, dark/reduced-motion and print contexts.
  Unsupported selectors/media fail the finder. This is NOT browser layout or human
  accessibility certification. Eight rendered A–F control-state inventories are
  integrated into existing UI tests; they read labels/states, never input values
  or custody. They supplement rather than replace full browser accessible names.
- `@clay/mutation/raw-client` owns the unchanged bounded HTTP/provider transport.
  WorkerClient relays opaque bytes; the worker's closed `decodePlannerRaw` remains
  the Preview/commit validator. The parsed MutationClient API is retained for
  other callers. Differential tests cover malformed JSON, wire migration/query
  hydration, clipping, Board/Timeline width, issue paths and the single repair
  capability. No kernel validation, route or durable authority source was edited.
  The module guard rejects a duplicate parsed shell planner or provider transport
  in the worker. A generated wire schema precomputes ONLY the old `$comment`
  removal; original prompt bytes and every transmitted schema field remain equal,
  with an independent source-digest/equality test. No packed/executable model data.
- Identical error-to-message expressions share a tested presentation-only helper;
  there is no new logging, persistence, sanitization or retry. Already-loaded
  catalog/presentation validators use narrow static imports, removing redundant
  async namespace wrappers. Safe Terser compression remains free of unsafe flags.

## Verification during implementation

The first Preact full-shell finder run was RED: 838 passed, 18 failed and one
unhandled error (`test-results/fix-batch/shell-preact-first.json`). Compatibility
fixes and fixtures now wait for actual retained/readback completion, not an old
render/React scheduling assumption. Assertions about durable payloads and errors
were retained. The final full-shell rerun passed: **879 tests, 137 files, zero
failures**, 411.67s. No unhandled-error report. The initial finder is retained as
RED feedback, not the final checkpoint.

Confirmed focused GREEN packets so far include 28 renderer/modal/Today tests;
14 shared-boundary/modal/renderer tests; 37 mutation raw/client/assets/wire-schema
tests; 33 operational/editor/readback/error-conversion tests; 53 tests across the
eight A–F census files; and eight style-equivalence/finder tests.

Final commands actually run, serially (repository-local installed tools; no
dependency download or installation):

| Command / working directory | Actual result |
| --- | --- |
| `node node_modules/vitest/vitest.mjs run --maxWorkers=1 --minWorkers=1 --reporter=dot --reporter=json --outputFile.json=../../test-results/fix-batch/shell-preact-final.json` / `packages/shell` | PASS: 879 tests / 137 files, 411.67s |
| `node node_modules/vitest/vitest.mjs run --maxWorkers=1 --minWorkers=1 --reporter=dot` / `packages/mutation` | PASS: 60 tests / 8 files, 4.80s |
| Same package-local Vitest command / `packages/backend` | PASS: 111 tests / 11 files, 9.62s |
| `node node_modules/typescript/bin/tsc --noEmit` / each of schema, kernel, mutation, panel-runtime, shell, backend | All six exited 0 |
| `node node_modules/vite/bin/vite.js build` / `packages/panel-runtime` | PASS: 5 modules; 1.36s |
| `node scripts/bundle-module-report.mjs` / root | PASS: actual shell production build, 169 modules; 16.70s; regenerated module report |
| `node scripts/renderer-module-check.mjs` / root | PASS: one pinned Preact closure; no React/ReactDOM/Scheduler or worker renderer; raw shell transport and closed worker decoder |
| `node scripts/bundle-diagnostic.mjs` / root | Exit 1: only completeWorker and completeBrowser remain red; all other boundaries pass |
| `node scripts/bundle-budget.mjs` / root | Exit 1: freshness and shell gates pass; fails at complete worker closure, exact error below |
| `node --test scripts/bundle-budget.test.mjs` / root | PASS: 19 tests, no failures |
| `node scripts/roadmap-development-census.mjs` / root | Exit 0: 21 capabilities, developmentComplete=true, no development blockers or hard-disable flags; 25 explicitly retired compatibility routes. Inventory, NOT certification |
| `git diff --check` / root | Exit 0 |

The final production source was unchanged throughout the successful full-shell,
affected-suite, six-typecheck and final-build sequence. Only this handoff was
updated during/after it. Kernel/schema/panel-runtime source, dependency lockfile,
shell dependency manifest, frozen collectors/limits and checked-in `evidence/`
are unchanged. A changed-content scan found no added eval/Function execution,
unsafe HTML assignment, private-key/token literal pattern or debugger statement.
This bounded scan is not a security review.

## Final measured phase-1 checkpoint

Raw / gzip bytes from the actual regenerated `test-results/fix-batch/bundles.json`:

| Boundary | Before this turn | Final | Frozen limit | Status |
| --- | ---: | ---: | ---: | --- |
| totalShellJavaScript | 1,137,878 / 342,872 | **947,561 / 289,911** | 980,000 / 290,000 | PASS |
| applicationStyles | 78,807 / 20,198 | **60,905 / 16,825** | 67,000 / 17,000 | PASS |
| completeBrowser | 3,577,700 / 1,178,465 | **3,369,405 / 1,122,212** | 3,250,000 / 1,100,000 | FAIL: 119,405 / 22,212 over |
| completeWorker | 1,434,879 / 387,588 | **1,434,812 / 387,687** | 1,010,000 / 280,000 | FAIL: 424,812 / 107,687 over |
| workerAuthority | — | 212,957 / 53,228 | 240,000 / 60,000 | PASS |
| ProductionBackupRuntime | — | 32,099 / 10,853 | 45,000 / 14,000 | PASS |

Phase-1 shell/style size targets are closed. Shell saves 190,317 raw / 52,961 gzip;
styles save 17,902 / 3,373; complete browser saves 208,295 / 56,253. Shell gzip
headroom is only **89 bytes** and styles gzip headroom **175 bytes**: future
changes must remeasure, not assume durable headroom. Safe compression changed
worker output slightly; no worker architecture reduction is claimed.

The unchanged frozen gate's exact terminal error was:
`database worker JavaScript closure: 1434812 B raw / 387687 B gzip exceeds
1010000 B / 280000 B`. It exits before later aggregate checks; the full diagnostic
uses the same collector and reports styles green and complete browser red.

Local feedback paths (not immutable release evidence):

- `test-results/fix-batch/shell-preact-first.json` — retained RED finder.
- `test-results/fix-batch/shell-preact-final.json` — final 879-test GREEN run.
- `test-results/fix-batch/bundle-modules.json` — actual final build/module graph.
- `test-results/fix-batch/bundles.json` — all final measured boundaries.

The coherent uncommitted diff contains 77 modified tracked paths and 21 new paths;
HEAD remains `7b4a905351a97fe2f7d0c79e7ba028a9d22a037c`. No remote network readback,
commit or push was performed.

## Exact continuation / remaining gates

Phase 1 source/tests/size work is complete, not browser-certified. The next code
boundary is the deferred complete-worker architectural phase: use the final module
report to reduce actual Store/validation/target-catalog/DB closure duplication.
Largest actual emitted worker files are asyncstore 480,997 / 138,303;
worker-authority 212,957 / 53,228; sqlite-initializer 210,779 / 62,560;
target-authority 193,667 / 41,161; db-worker 180,638 / 44,972; shared validation
55,684 / 12,701. Splitting those into additional assets alone cannot close the
424,812 / 107,687 worker gap. Do not remove authority, native recovery, syntax
validation or user capability to meet it. Complete-browser remains 119,405 /
22,212 over and should benefit from actual shared/worker source reductions.

Keep shell/styles green (especially their narrow gzip headroom),
all worker routes, pinned SQLite/SAHPool/native journal recovery, Acorn validation,
archive authentication, trusted-shell custody and frozen collectors intact.
Release B source binding/frozen-runtime certification and parent-owned packaged
browser gates wait for stabilized source. Parent must check the Preact native
focus/event/portal/modal behavior and responsive/print/dark/zoom/lazy CSS in real
browsers; source/DOM compatibility tests are not a substitute. Human NVDA and
optional credentialed model regression remain external; do not request credentials
or call them passed. No browser matrix or formal review ran in this phase.

No certification, release or shipment is claimed.

---

# Historical shell renderer preflight - 2026-09-14 (resolved dependency blocker)

Started CLEAN at `a75c9bf8af68aa1efefb6b6679844160fa665226`, `D:\Clay`,
`codex/clay-project`; local origin tracking ref matches (no network remote
readback). The requested Preact/CSS phase is NOT complete. This is a bounded,
uncommitted renderer-contract/modal-fix checkpoint, not a size certificate.
Preserve all three previous optimization checkpoints and all A-F functionality.

## Verified new environment blocker

`corepack.cmd pnpm --version` exited 1 with:
`EPERM: operation not permitted, opendir
'C:\Users\nakul\AppData\Local\node\corepack\v1\pnpm'`.

The exact requested install was also attempted using an isolated repository-local
Corepack cache (the environment override applied only to that command):

```powershell
$env:COREPACK_HOME = 'D:\Clay\node_modules\.cache\corepack'
corepack.cmd pnpm --filter @clay/shell add preact@10.29.8 --save-exact --ignore-scripts
```

Exit 1 BEFORE pnpm ran. Corepack cannot obtain the repository's already-pinned
pnpm 11.9.0: request to `https://registry.npmjs.org/pnpm/-/pnpm-11.9.0.tgz`
failed with `AggregateError [EACCES]`, including
`connect EACCES 104.16.3.34:443`. The local-cache `--version` probe failed for the
same reason. No installed Preact package exists under this repository's `.pnpm`.
No package manifest, lockfile, dependency, production alias, or collector was
changed. Do not fake a Preact resolution, vendor an unverified copy, fabricate a
lockfile checksum, or bypass the sandbox network restriction.

An asynchronous request asked the parent to provision the exact dependencies in
an accessible repository-local cache without source changes. This is an
environment dependency, NOT a proven Preact product incompatibility. Parent-side
provisioning is required before the renderer swap and its equivalence checks can
run. No restart or weaker sandbox is requested.

## Completed safe preflight work

- Added `packages/shell/test/renderer-compatibility.test.tsx`, executing the
  installed React runtime: controlled text/checkbox/select input, blur/focusout,
  native capture/bubble, refs and layout effects, external-store updates and
  unsubscribe, sandboxed iframe mount/unmount, lazy/Suspense, class error recovery,
  portal drag/drop payload/preventDefault, nested modal/feedback portals, Tab,
  Escape, background inert/aria-hidden, scroll locking and trigger restoration.
  These are baseline contracts, NOT evidence of Preact equivalence.
- RED: Escape from an ordinary nested-modal control that stops propagation did
  not close the child; the parent remained inert. `ModalDialog` now uses one
  native capture trap for ALL content instead of a synthetic path plus a special
  native feedback-only path. Only the top layer can dismiss through its backdrop.
- Preserved intentional Escape-to-cancel editors using explicit trusted-shell
  `data-modal-escape-owner="true"` markers on the nine DataView editor sites and
  the two RecordDetail editor sites. These editors retain their existing handlers;
  the marker exempts only Escape, never Tab. A focused test verifies cancellation
  does not dismiss the modal or escape its focus trap. No durable write path or
  retained request/receipt behavior changed.
- RED: lazy modal failure had no alertdialog/scroll-lock contract. Added the
  non-dismissible mode to `ModalDialog`; `LazySurfaceBoundary` now reuses it,
  removing its duplicate modal focus/inert/key handling. The recovery button and
  error label remain; modal failure uses `role="alertdialog"`, whereas non-modal
  failure remains `role="alert"`. Escape/backdrop clicks cannot dismiss a failed
  surface. No fallback exposes raw authority or retries a durable operation.
- Read-only CSS diagnostic `test-results/fix-batch/css-primitives-plan.mjs`
  enumerates repeated declarations from 393 simple, top-level class rules in
  main/Operations styles. It made NO source rewrite; all CSS, themes, responsive,
  reduced-motion, print and lazy-style behavior is untouched. CSS consolidation,
  the full A-F accessible-control census and the production renderer-module guard
  remain required; none is claimed complete by this preflight packet.

## Actual verification

- Initial renderer/modal packet: 9 passed, one failure from a stale test-held
  portal DOM node. Fixed the fixture to requery the live relocated feedback node.
- Deterministic ordinary-child Escape RED: 4 passed, one failed. Native capture
  fix GREEN: 10 passed across renderer/modal/lazy-boundary files.
- Added explicit editor-cancellation test: 10 passed across renderer/modal files.
- Lazy modal failure RED: 6 passed, one failed. Shared non-dismissible modal GREEN:
  12 passed across 3 files, 3.75 s, exit 0.
- First full shell run: 849 passed / one failed, 394.84 s, exit 1;
  `test-results/fix-batch/shell-renderer-preflight.json`. Existing
  `operations-ui.test.tsx` correctly caught add-column Escape closing DataView.
  Four delegated add-column cancellation handlers needed the same explicit marker;
  all nine DataView editor sites are now covered. No assertion was weakened.
- Corrected operations/renderer/modal packet: 24 passed across 3 files, 5.48 s,
  exit 0. Command (from shell): `node node_modules/vitest/vitest.mjs run
  test/operations-ui.test.tsx test/renderer-compatibility.test.tsx
  test/modal-dialog.test.tsx --maxWorkers=1 --minWorkers=1 --reporter=dot`.
- Shell `node node_modules/typescript/bin/tsc --noEmit`: exit 0. No other package's
  source/API/dependencies changed; their full suites/typechecks were not rerun.
- Panel `node node_modules/vite/bin/vite.js build`: exit 0, 664 ms. Root
  `node scripts/bundle-module-report.mjs`: exit 0, 14.41 s; ordinary static/dynamic
  import and >500 KB warnings remain. The actual module report still contains
  React/ReactDOM/Scheduler, with no Preact: no renderer swap was certified by this
  build. Prior Acorn/shared SQLite/shared Zod assets are preserved.
- `node --test scripts/bundle-budget.test.mjs`: 19 passed, exit 0.
- `node scripts/bundle-diagnostic.mjs`: exit 1; four red aggregate boundaries.
  `node scripts/bundle-budget.mjs`: exit 1, freshness and entry/boot/lazy checks
  pass, then `total shell JavaScript: 1137878 B raw / 342872 B gzip exceeds
  980000 B / 290000 B`. Fresh reports: `test-results/fix-batch/bundles.json` and
  `bundle-modules.json`. This is not release evidence.
- `node scripts/roadmap-development-census.mjs`: exit 0, 21 capabilities,
  `developmentComplete: true`, no disabled UI flags, 25 explicitly retired
  unavailable compatibility routes. This preserves the prior A-F inventory; it
  does NOT mean the new renderer/CSS optimization phase is complete, or constitute
  the requested rendered accessible-control census.
- Final full shell rerun: 850 passed across 130 files, 394.83 s, exit 0; no
  unhandled-error report. Actual JSON:
  `test-results/fix-batch/shell-renderer-preflight-green.json`. Both full runs used
  `node node_modules/vitest/vitest.mjs run --maxWorkers=1 --minWorkers=1
  --reporter=dot --reporter=json --outputFile.json=../../test-results/fix-batch/<name>.json`
  from `packages/shell`, serially with other broad work.

| Boundary | Current raw / gzip | Frozen limit | Remaining raw / gzip |
| --- | --- | --- | --- |
| Shell JavaScript | 1,137,878 / 342,872 | 980,000 / 290,000 | 157,878 / 52,872 |
| Application styles | 78,807 / 20,198 | 67,000 / 17,000 | 11,807 / 3,198 |
| Complete browser | 3,577,700 / 1,178,465 | 3,250,000 / 1,100,000 | 327,700 / 78,465 |
| Complete worker | 1,434,879 / 387,588 | 1,010,000 / 280,000 | 424,879 / 107,588 |

No material budget reduction occurred: shell raw changed by -66 bytes, styles and
worker bytes are unchanged, and tiny gzip/hash variation is not an architectural
saving. Other measured boundaries remain green; DataView is 43,797 / 12,821
(45,000 / 14,000 limit), so monitor its own headroom when adding class tokens.

Six changed paths: this handoff; shell `src/app/ModalDialog.tsx`,
`src/app/LazySurfaceBoundary.tsx`, `src/app/DataView.tsx`,
`src/app/RecordDetail.tsx`, and new `test/renderer-compatibility.test.tsx`.
`git diff --check` and the targeted changed-code safety scan passed. No new
unsafe HTML/dynamic evaluation/provider HTTP/credential-shaped literal was found.
Manifests, lockfile, CSS, collectors, authority packages and `evidence/` are
unchanged. No review fingerprint or formal evidence was generated. No Git writes,
other worktree access, server stops, deployment or production changes occurred.

## Exact continuation

1. Parent must provision pinned pnpm 11.9.0 and preact 10.29.8 accessibly. Then use
   the exact Corepack command above; inspect package/lock diff for only the
   requested change. Keep the sandbox intact and existing preview servers alone.
2. Finish the A-F rendered accessible-control census and renderer-module report
   rejection tests BEFORE aliasing. The new baseline contract packet and existing
   modal/editor tests must remain green under the proposed runtime, not merely
   under React. Cover the literal JSX runtimes and reject mixed/duplicate renderers.
3. Alias production AND Vitest as requested; use Preact test-utils act where needed,
   measure the real closure, and fix observed product incompatibilities. No alias
   has been landed while its target dependency is unavailable.
4. Continue modal/surface and zero-specificity CSS primitives only with cascade,
   editor, focus and responsive finder tests. The remaining PrivateMetrics/ShapeMap/
   ImportWizard scaffolds have distinct Escape/restore behavior: preserve inline
   confirmations and intentional focus handoff when migrating them. Do not infer
   CSS savings from the declaration inventory or run broad redesign blindly.
5. Close shell JS and styles, then hand off the separately red worker engine and
   final parent browser campaign. No commits, pushes, deployment, production
   configuration, credentials, budget edits, formal review or browser launch.

---

# Aggregate bundle FIX continuation - 2026-09-14

Started clean at `5043099b407d0af7523af298e1e894d0db88487f` in `D:\Clay`,
`codex/clay-project`; local origin tracking ref matches. No network remote
readback, commits, pushes, deployments, dependency downloads, other-worktree
edits, credential access or existing-server changes. A-F development remains
complete. This is a PARTIAL size FIX, not a certificate or release.

## Implemented: closed production panel-parser specialization

Preserved the prior shared Zod/SQLite assets and minified panel bootstrap.
The complete worker really uses Acorn for V1-V7 validation and syntactic field
rename, including archived panels. The replacement is NOT a regex scanner or a
new JavaScript grammar. The same installed Acorn 8.17.0 grammar, Unicode tables,
scope/private-field checks, regexp validation, AST positions and errors remain.

- New kernel `panel-program.ts` exposes ONLY the two existing modes: ECMAScript
  2023 module validation and latest-module rewriting. `validate.ts` and
  `panel-rewrite.ts` call those entry points; their safety checks are unchanged.
- New shell `config/panel-parser-specialization.mjs` partially evaluates the
  pinned dependency at build time. It folds unused options and edition tests
  with the SAME result for both supported modes. It removes unreachable public
  parser/plugin/reflection APIs, and minifies only private Parser.prototype
  method names inside that isolated dependency compilation. AST fields, error
  fields, syntax strings and other Clay properties are not mangled.
- Exact hashes guard both installed parser bytes and the closed wrapper's
  normalized source. Alternate importers, direct-path bypasses, dynamic imports,
  or missing loaded-module identity fail the build. No vendor file was edited.
  The plugin runs for both ordinary and worker builds; development/Node paths
  continue to use the original parser through the same closed wrapper.
- Added the `.d.mts` declaration, a compiled real-validator/rewrite fixture and
  `panel-parser-specialization.test.mjs`. The RED test reproduced retention of
  unused parser callbacks. GREEN compares full ASTs (including regexp/bigint
  literal values), exact syntax error metadata, V1-V7 issue lists and rewrite
  results against the original parser/validator. It covers starter panels,
  forbidden identifiers, private names, imports, hashbangs, Unicode, both grammar
  versions, string/depth bounds and deterministic syntax faults. No fixture code
  is executed as panel/model output; only the compiled trusted checks run in VM.

## Measured hypotheses and limits of this pass

1. Parser specialization yielded a real worker reduction: complete worker
   1,459,870 / 391,399 -> 1,434,879 / 387,588 raw/gzip in the first build.
   This is 24,991 raw / 3,811 gzip, not the much larger pre-minification change
   (Acorn rendered length 231,930 -> 91,373). No bytes were moved outside the
   collector or merely put into another lazy chunk.
2. AST caller inventory of Store, DeviceCatalog, authority and coordinator did
   NOT identify a large safely removable public-method block. Apparent small
   orphans (`rollForwardTo`, `markSuggestionShown`, `dumpTable`, catalog
   `generationDescriptors`) are not grounds to delete compatibility APIs; dynamic
   dispatch and the writer census still need to be accounted for. No method or
   route was removed. The 15 identical retired-intake throws are already reduced
   to one emitted throw by Terser; rewriting those cases would not save bytes.
3. CSS membership was checked against actual rendered production modules, not
   every file in the source tree. Almost all selectors are used; unmatched names
   are mostly runtime suffixes, so blind pruning is invalid. Source analysis found
   611 main and 271 Operations rules, with repeated display/color/control styling.
   Straight grouping/minification is already substantially handled by CSSO.
   No CSS was changed without a cascade-equivalence proof. The CSS gate stays RED.
4. Seed inventory found 34 literal code bodies totaling 22,670 characters, with
   only seven async form bodies and differing payload/default semantics. Moving
   seed material alone does not remove browser bytes; do not estimate a 60 KB
   reduction from that module's rendered length or change persisted panel bytes.

The read-only investigation scripts in ignored `test-results/fix-batch/` are
`source-seams.mjs`, `css-seams.mjs`, `css-membership.mjs`, and `parser-size.mjs`.
They are development diagnostics, not release evidence or a proven call graph.

## Verification and current measurements

Serial package-local test command:
`node node_modules/vitest/vitest.mjs run [files] --maxWorkers=1 --minWorkers=1 --reporter=dot`.
Full-suite JSON outputs use `*-optimization-2.json` in `test-results/fix-batch/`.

- Parser/runtime boundary packet: 4 files, 8 passed, 8.05 s.
- Expanded compiled parser/validator/rewrite packet: 2 passed, 3.61 s.
- Final packet including the real direct-path import bypass: 3 passed, 4.51 s.
- Kernel validator, exemplar, hostile-corpus and rewrite packet: 4 files,
  121 passed, 2.86 s. The nonexistent `archive-fuzz.test.ts` filter in that command
  added no tests; it is NOT an archive-fuzz pass.
- All six final package typechecks exited 0, run serially from each package with
  `node node_modules/typescript/bin/tsc --noEmit`.
- Full suites ran serially with `--reporter=dot --reporter=json
  --outputFile.json=../../test-results/fix-batch/<package>-optimization-2.json`:

| Package | Files passed / skipped | Tests passed / skipped | Duration | Exit |
| --- | --- | --- | --- | --- |
| Kernel | 113 / 1 | 1,202 / 1 | 466.47 s | 0 |
| Shell | 129 / 0 | 843 / 0 | 394.80 s | 0 |
| Schema | 15 / 0 | 157 / 0 | 5.75 s | 0 |
| Mutation | 6 / 0 | 48 / 0 | 3.97 s | 0 |
| Backend | 11 / 0 | 111 / 0 | 9.57 s | 0 |
| Panel runtime | 4 / 0 | 66 / 0 | 6.83 s | 0 |

Total: 2,427 passed, one skipped. No unhandled-error report. Kernel projection
benchmarks passed (30 samples: 1k p95 8.559 ms; 5k p95 26.854 ms). These package
runs do not substitute for the deferred production browser/certification campaign.

- `node --test scripts/bundle-budget.test.mjs`: 19 passed, zero failed, exit 0.
- Panel package `node node_modules/vite/bin/vite.js build`: exit 0, 660 ms;
  output 44,487 raw / 14,376 gzip bytes.
- Final root `node scripts/bundle-module-report.mjs`: production build exit 0,
  14.63 s; regenerated `test-results/fix-batch/bundle-modules.json`. Existing
  static/dynamic import and >500 KB chunk warnings remain; no warning limit changed.
- `node scripts/bundle-diagnostic.mjs`: exit 1; regenerated the full development
  diagnostic `test-results/fix-batch/bundles.json`, with exactly four red boundaries.
- Actual frozen `node scripts/bundle-budget.mjs`: exit 1, freshness PASS,
  entry/boot/lazy boundaries PASS, then the unchanged fail-fast error:
  `total shell JavaScript: 1137944 B raw / 342911 B gzip exceeds 980000 B / 290000 B`.
  The full diagnostic, not an inferred later gate pass, supplies worker/style/
  browser measurements below. No checked-in release evidence was regenerated.

| Boundary | Current raw / gzip | Frozen limit | Remaining raw / gzip |
| --- | --- | --- | --- |
| Shell JavaScript | 1,137,944 / 342,911 | 980,000 / 290,000 | 157,944 / 52,911 |
| Complete worker | 1,434,879 / 387,588 | 1,010,000 / 280,000 | 424,879 / 107,588 |
| Application styles | 78,807 / 20,198 | 67,000 / 17,000 | 11,807 / 3,198 |
| Complete browser | 3,577,766 / 1,178,506 | 3,250,000 / 1,100,000 | 327,766 / 78,506 |

These are FINAL build readbacks for this diff; all four remain RED. Complete
worker savings are 24,991 raw / 3,811 gzip, complete browser savings 24,991 raw /
3,839 gzip. Shell raw bytes and CSS bytes are unchanged; the 27-byte shell gzip
variation is not a structural saving. `asyncstore-CikdDNyU.js` is 481,016 raw /
138,307 gzip. Worker authority remains green at 212,973 / 53,318;
ProductionBackupRuntime remains green at 32,098 / 10,846. All other diagnostic
boundaries are green. Collectors, frozen limits and prior shared assets are intact.

Changed paths: kernel `src/panel-program.ts`, `src/validate.ts`,
`src/panel-rewrite.ts`; shell `vite.config.ts`,
`config/panel-parser-specialization.mjs`, its `.d.mts` declaration,
`test/panel-parser-specialization.test.mjs`,
`test/fixtures/compiled-panel-validation.ts`; this handoff. No route, authority,
catalog, CSS, dependency or existing-user-data code was changed. `git diff --check`
and both new JavaScript syntax checks passed. The changed code's targeted scan
found no dynamic eval/Function constructor, unsafe HTML assignment, provider HTTP
call or credential-shaped literal. VM execution is confined to the test-owned
compiled trusted validator, never the panel strings supplied to that validator.
Build/test diagnostics remain under ignored `test-results/fix-batch/`.
HEAD and local origin tracking ref remain
`5043099b407d0af7523af298e1e894d0db88487f`; this is one UNCOMMITTED nine-path diff,
not an immutable/reviewed or certified candidate.

## Exact continuation

1. Preserve this source/test/config diff and both prior FIX checkpoints. Do not
   reopen the parser grammar or replace it with a permissive scanner. A future
   Acorn/wrapper change must deliberately rerun the equivalence packet; do not
   silently update its pinned hashes to bypass the build guard.
2. The large remaining worker seam is still Store/catalog/authority code, not an
   unused parser import. In `device-catalog.ts`, examine `readValidatedCatalog`,
   `mapCatalogGenerationEvent`, `mapRevisionReservation`, and target publication
   against `archive-authority.ts`'s `mapEvent`, `mapReceipt`, and
   `validateAuthorityHistory`. Public event-row mapping is genuinely repeated;
   receipt error/null handling and history checks differ and cannot be merged
   blindly. Start with bounded row/fault/roundtrip equivalence tests, preserve
   validation order, physical cardinality, all pending kinds and error boundaries.
   Existing finder packets: `device-catalog.test.ts`,
   `device-catalog-metadata.test.ts`, `catalog-backup-recovery.test.ts`,
   `archive-authority.test.ts`, `archive-authentication.test.ts`, and
   `intake-archive-boundary.test.ts`. These are next seams to test and measure,
   not a claim that their consolidation can close the 424,879-byte worker gap.
3. Shell/controller reduction still needs source-level consolidation. It is not
   fixed by extracting more chunks. CSS candidates are the history/data overlay
   shell, record/relation/automation inputs and focus states in `styles.css` and
   `Operations.css`. Prove default, focus, disabled, theme, embedded and 320px
   cascade behavior before introducing shared primitives. Keep each lazy style's
   activation contract. No CSS or shell saving from those candidates is claimed.
4. Parent-side owned sandboxed browser execution and Release B rebinding remain
   deferred until source stabilizes. No browser was launched or historical
   release evidence rewritten in this continuation. All four aggregate limits
   still require code work; no certification/shipment claim is made.

---

# Aggregate bundle FIX checkpoint - 2026-09-14

This section supersedes the prior FIX continuation below. A-F development remains
complete; aggregate optimization is PARTIAL, not certification or shipment.
Started clean in `D:\Clay`, `codex/clay-project`, HEAD and local origin tracking ref
`b8187ed98cfea42381250c0c016d4e33cc816e66`. No network remote readback or Git writes.
Preserve this coherent uncommitted diff; no other worktree or existing server was
touched. No dependency download, production configuration, credential access,
deployment, formal review, or historical release-evidence regeneration occurred.

## What changed and why

Read the complete actual module report and both frozen collector implementations
before editing. Neither collector, their limits, nor the diagnostic scripts changed.
Chunk sizes below are emitted bytes; Rollup `renderedLength` is pre-minification
and must not be mistaken for emitted-byte savings.

1. **Remove unused schema construction.** `packages/schema/src/*.ts` (except the
   evidence-only factories) and kernel `import-contracts.ts` /
   `import-staging-contracts.ts` now mark entire pure factory expressions, including
   nested constructors. A lone annotation on the outer Zod call was insufficient.
   The initial RED tests proved that importing only an app ID or parser chunk
   validator still constructed intake/migration/bridge contracts. A third RED test
   demonstrated the same backup-to-catalog-to-Daily-Home expansion. Validators,
   refinements, defaults, strictness, schema versions and export identities remain
   unchanged. The first four-file change saved 28,194 raw / 7,143 gzip browser bytes;
   it saved only 2,816 raw / 654 gzip in the complete DB worker.
2. **Deduplicate Zod across realms.** New schema `validation-runtime.ts` exposes a
   closed, frozen vocabulary of the ORIGINAL installed Zod factories and authoring
   types, not a replacement validator. Runtime imports use this facade. New shell
   `config/shared-runtime-chunks.mjs` puts this dependency-only closure in the same
   content-addressed asset in the shell, DB worker and import worker. A first
   manual-chunk-only experiment emitted three different files and was insufficient;
   the stable facade makes actual bytes identical. No schema instance, parse state,
   authority or custody is shared across JavaScript realms. After schema pruning
   plus actual runtime deduplication, browser payload was 3,889,226 / 1,255,066.
3. **Minify the fixed panel bootstrap.** `packages/panel-runtime/vite.config.ts`
   previously used `minify: false`. Standard Terser minification now reduces the
   fixed IIFE from 81,093 / 19,380 to 44,487 / 14,376. The shell also stops embedding
   that extra development whitespace/identifier copy. Saved/generated panel code,
   persisted panel identities, CSP and component capabilities are NOT rewritten.
   The new compiled-IIFE test renders components, evaluates the existing expression
   API and checks captured native transport after the mutable port is changed.
4. **Deduplicate the pinned SQLite initializer.** New shell
   `config/shared-sqlite-runtime.mjs` extracts the intact bundler-friendly initializer
   from the installed SQLite 3.53.0-build1 distribution at build time. Both the
   public index/promiser facade and support-worker bootstrap import that identical
   module. No dependency file, VFS/journal/lock implementation or production driver
   guard was edited. Exact input SHA-256 checks reject any upstream drift, rather
   than attempting a best-effort rewrite. Original licenses are retained. The
   standard support-worker API still opens, executes, reports errors and closes;
   the full initializer is counted in the DB and browser closures. This saved a
   real second initializer copy, not bytes hidden from a collector. Production
   `sqlite-initializer-BdPRzjJX.js` is 210,791 / 62,575 and is emitted once.

Additional source changes are imports of the validation facade in kernel
`daily-home-projection`, `inbox-dispositions`, `intake`, `private-metrics`,
`production-daily`, `production-manual-backup`, and `production-relation`.
Shell `vite.config.ts` wires the same sharing rules into ordinary and worker builds;
the two new config helpers have `.d.mts` declarations. Use `git status --short
--untracked-files=all` for the complete source/test/config inventory.

## Rejected shortcuts / remaining source seams

- Acorn is NOT incidentally imported provider/model HTTP code. The worker uses it
  through `validate.ts` and `panel-rewrite.ts`: plan checks, syntactic field rename,
  and archived live/historical panel validation in `store.ts`. The shell-only
  `static-javascript-strings.ts` module does not appear in the worker report.
  Removing or replacing Acorn without preserving those executable safety checks
  would not be a valid optimization. It remains 231,930 *pre-minification* bytes.
- The complete worker still contains `asyncstore` 506,007 / 142,114, authority
  212,973 / 53,319, target/catalog authority 193,667 / 41,161, DB entry
  180,649 / 44,746, shared SQLite 210,791 / 62,575 and validation 55,684 / 12,701.
  `store.ts` is 265,257 rendered bytes; `device-catalog.ts` is 181,701. A next
  structural pass must identify genuinely redundant/unused methods and repeated
  validation/coordination routines, with route/caller and recovery tests first.
  Moving these between lazy chunks alone will not reduce the complete closure.
- CSS remains unchanged and RED. Another CSSO pass over actual emitted styles
  saved only about 40 raw bytes and made aggregate gzip worse. Combining files
  experimentally did not materially reduce raw bytes and would change lazy loading
  and cascade order; it was NOT applied. Almost all static class names are already
  compacted. The main stylesheet (48,391 raw) and Operations (19,471 raw) need
  source-level shared primitive/declaration work with responsive/cascade coverage,
  not weaker collection, omitted styles or blind rule deletion.
- Shell-specific residuals include the React app/controller and retained workflows,
  DataView/AutomationCenter, immutable prompt assets, and the remaining fixed frame.
  These must retain all A-F controls, previews, recovery and immutable intents.

## Actual verification for this optimization diff

Package-local command form:
`node node_modules/vitest/vitest.mjs run [files] --maxWorkers=1 --minWorkers=1 --reporter=dot`.
Full suites additionally use `--reporter=json --outputFile.json=../../test-results/fix-batch/NAME-optimization.json`.
Builds and broad suites are serial, using installed repository-local binaries.

| Check | Observed result |
| --- | --- |
| Schema pruning boundary RED/GREEN | 2 initial failures, then 1 additional failure; all 3 GREEN |
| Shell sharing/pruning focused packet | 3 files, 6 passed, 5.43 s |
| Compiled panel bootstrap RED/GREEN | RED: 2,135 lines; GREEN: real compiled rendering/compute/port test |
| Full kernel | 113 files passed / 1 skipped; 1,202 passed / 1 skipped; 465.83 s |
| Full schema | 15 files, 157 passed, 5.92 s |
| Full panel runtime | 4 files, 66 passed, 7.07 s |
| Full shell | 128 files, 840 passed, 388.60 s; no reported unhandled errors |
| Full mutation | 6 files, 48 passed, 4.29 s |
| Full backend | 11 files, 111 passed, 10.05 s |
| All six package typechecks | `node node_modules/typescript/bin/tsc --noEmit`: all exit 0 (shell helper declarations fixed after initial TS7016 RED) |
| Frozen collector unit tests | `node --test scripts/bundle-budget.test.mjs`: 19 passed |
| Panel production build | Exit 0; final 655 ms, IIFE 44,487 / 14,376 |
| Production module-report build | `node scripts/bundle-module-report.mjs`: exit 0; final 13.42 s |
| Full bundle diagnostic | Exit 1; 24 boundaries measured, four RED |
| Actual frozen gate | `node scripts/bundle-budget.mjs`: freshness PASS, then exit 1 at total shell JavaScript (1,137,944 / 342,938 exceeds 980,000 / 290,000) |
| Diff hygiene | `git diff --check`: exit 0; collectors, diagnostics and `evidence/` unchanged |

The SQLite focused test executes the production-extracted initializer with the real
pinned WASM: memory SQL write/rollback/readback, then support-worker open/query/error/
close messages in an owned VM. It also rejects changed upstream bytes. This is NOT
physical OPFS or browser certification. The validation test checks original factory
identity, rejection/result equivalence and byte-identical independent realm builds.
Changed-content hygiene found only the test-owned `clay.compute.eval("2 + 3", {})`
fixture; no added credential literals, unsafe HTML, production eval, debug logging
or shell execution were found by that bounded scan. This is not a security review.
All six suite JSON reports were read back as successful with zero failed tests.
The source-binding helper already inventories all package/config and installed
dependency inputs; it was inspected, not changed or run as a certification gate.

## Latest aggregate measurements (raw / gzip bytes)

| Boundary | Starting checkpoint | Current | Frozen limit | Remaining gap |
| --- | --- | --- | --- | --- |
| Total shell JavaScript | 1,183,647 / 349,690 | 1,137,944 / 342,938 | 980,000 / 290,000 | 157,944 / 52,938 |
| Complete worker | 1,461,057 / 392,375 | 1,459,870 / 391,399 | 1,010,000 / 280,000 | 449,870 / 111,399 |
| Application styles | 78,807 / 20,198 | 78,807 / 20,198 | 67,000 / 17,000 | 11,807 / 3,198 |
| Complete browser | 4,027,944 / 1,287,860 | 3,602,757 / 1,182,345 | 3,250,000 / 1,100,000 | 352,757 / 82,345 |

Complete browser savings: **425,187 raw / 105,515 gzip**. Worker authority remains
green at 212,973 / 53,319; ProductionBackupRuntime remains green at 32,098 / 10,845.
All other measured boundaries remain green. Ordinary full bundle output and module
membership are generated in ignored `test-results/fix-batch/bundles.json` and
`bundle-modules.json`; they are diagnostics, not a certified immutable candidate.

## Exact continuation

1. Preserve this diff on `b8187ed...`. Do not redo the first FIX checkpoint, remove
   roadmap capability, weaken validation/native exclusion or change frozen limits.
2. Finish the four measured aggregate code gaps above. Shared content addressing
   already removes duplicate Zod/SQLite copies; do not claim another split alone
   solves the worker or shell aggregate. Preserve lazy semantic chunk identities.
3. After source stabilizes, the parent workflow runs its owned sandboxed browser
   gates. Parent-side Playwright launches successfully; Codex's earlier Windows
   token/sandbox launch failures are a host limitation, not a product defect. Do not
   bypass sandboxing or inflate product timeouts. No browser was launched this turn.
4. Release B source binding and frozen-runtime evidence still require honest
   regeneration after stabilization. Historical evidence was not changed. Retain
   the clean immutable candidate requirement for local export, explicit loopback URL
   for Release A, optional external credential-dependent model gate, and human-only
   NVDA certification. No credentials are requested or configured here.

No claim of all-green FIX, certification, release, or shipment is made.

---

# Integrated deterministic FIX checkpoint - 2026-09-13

This section supersedes the old "integrated campaign is next" instruction below.
The campaign collected the deterministic batch; this is its partial FIX checkpoint,
not certification or shipment. The batch is NOT all green. Preserve the whole
uncommitted diff. No commit/push, production change, dependency download, formal
review, release-evidence regeneration, or change to frozen budget rules occurred.

## Current FIX baseline and outcome

- Started clean in `D:\Clay`, branch `codex/clay-project`, HEAD and local tracking
  origin `2da7760c5ad9a255a233505ccb9f4d5b0aebc458`. No network remote readback.
- Kernel and shell full-suite regressions are fixed with test-only corrections to
  obsolete fixtures. Real production exclusion, authority, recovery and availability
  checks are unchanged. Production without `navigator.locks` still fails closed.
- Backup writer lazy closure is now under both frozen limits through narrow public
  imports. Kit enrollment and archive authentication remain in the trusted shell;
  their code is no longer an incidental static dependency of directory publication.
- Eight browser scripts were updated for current source/UI. Their packaged journeys
  are NOT passed: every owned browser launch failed before page creation on this
  host. Cold-start performance is unmeasured, not explained away by longer waits.
- Four aggregate budget boundaries remain RED (including two previously hidden by
  the fail-fast backup check). Release B's old source/runtime certificate is still
  invalid for this source. Do not alter old evidence or equate hash rebinding with
  a freshly observed certificate.

## Fixes and changed-file scope

Use `git status --short --untracked-files=all` for the exact source/test/script list.

1. Kernel fixtures: `test/helpers/owned-lifecycle-locks.ts`,
   `production-authority.test.ts`, `production-native-recovery.test.ts`, and
   `lifecycle-recovery-inventory.test.ts`.
   - Reused the disposable serialized lock fixture. Current memory-catalog tests
     explicitly stub native browser preflight, retention migration and restore
     discovery instead of accidentally opening real OPFS. The native suite still
     runs its actual owned recovery implementation; no production seam was changed.
   - Audited reader expectation now includes `listIntakeAutoAcceptRules`.
   - New tests reject absent navigator/locks before work, prove serialization and
     release after failure. On this Node host, the initial six stale fixtures failed
     at `strictBrowserPool` (no durable browser storage), rather than at locks.
     Stubbing native recovery alone still left the migration/restore OPFS seams RED.
2. Shell fixtures: `start-over-boundary.test.ts`, `operations-ui.test.tsx`,
   `recurring-entry.test.tsx`, `data-export-integration.test.tsx`.
   - Safe new-app Start Over stays; authenticated restore is correctly available.
   - Paired automation presentation/commands, original source IDs, receipt/outcome
     readback and independent capture Undo IDs replace old incomplete mocks.
   - Share-preview export binds `presentationSource` AND DataView's app identity.
   - Tests cover available/unavailable automation, retain exact retry assertions,
     isolate owned jsdom session state, and assert collected errors. No async error
     suppression or timeout inflation was added; both unhandled errors are gone.
3. Production import boundaries: `packages/kernel/package.json` exposes narrow
   `external-backup`, `backup-trust`, `recovery-kit` entry points. Shell
   `backup-target.browser.ts`, `production-backup.browser.ts`, `automatic-backup.ts`,
   `backup-trust-runtime.ts`, `restore-as-new.ts` import actual implementations and
   closed schemas directly; existing barrel/type compatibility remains. An attempted
   db-worker narrow import did not reduce complete bytes and was reverted.
4. Browser finders: `product-onboarding.mjs`/`.test.mjs`, `shape-map.mjs`,
   `change-contract.mjs`, `provider-connections.mjs`, `lazy-boundaries.mjs`,
   `connected-operations.mjs`, `workspace-mode.mjs`, `multi-app-archive.mjs`,
   `browsers.mjs`, and kernel `product-gate-panels.test.ts`.
   - Use recommended starter or explicitly open "See all templates". Workspace
     mode creates/switches real catalog apps, never mints localStorage identities.
   - Current import/close, conversion Keep/finalize and automation draft/simulation/
     Preview run/Confirm run controls replace obsolete labels and callbacks.
   - Model interception fixtures now use closed `//#blueprint` directives. Their
     old executable JavaScript is rejected by the existing production boundary;
     deterministic tests reproduced this independent of browser availability.
   - Multi-app archive checks Kit enrollment, download record readback, authenticated
     restore-as-new, exactly three apps, restored write/reload, original and sibling
     isolation. Kit bytes are never read/printed/copied into evidence; only an owned
     temporary download path is passed to the real Kit-check UI.
   - Boot error gate checks safe retry and absence of unavailable lifecycle actions.
     Existing modal/keyboard/axe/network/sibling checks remain. Browser matrix no
     longer calls a memory fallback a successful persistence journey.
   - Chromium sandbox is explicitly enabled. Default uses Playwright's installed
     browser; `CLAY_TEST_CHROMIUM_CHANNEL=chrome` or `msedge` is an explicit owned
     finder override, not frozen-version certification. External CDP is rejected.
5. Diagnostic scripts (not certification): `bundle-module-report.mjs` builds with
   ordinary production options and reports actual Rollup membership;
   `bundle-diagnostic.mjs` measures all current frozen boundaries with the unchanged
   budget library; `product-cold-start.mjs` records separate launch/document/boot/
   starter/write/reload phases without increasing timeout limits. Outputs are in
   ignored `test-results/fix-batch/`, not checked-in `evidence/`.

## Actual commands and results

All Vitest commands below use package-local
`node node_modules/vitest/vitest.mjs run ... --maxWorkers=1 --minWorkers=1 --reporter=dot`.
Broad suites/builds were serialized. No pnpm dependency install was attempted.

| Finder / affected gate | Real result |
| --- | --- |
| Kernel `test/production-authority.test.ts`, initial RED | 7 failed / 62 passed, 52.73 s |
| Kernel intermediate native-only seam fix | 6 failed / 76 passed; migration still entered real OPFS |
| Kernel authority + lifecycle-inventory GREEN | 82 passed, 57.99 s |
| Shell initial five-file packet | 6 failed / 18 passed, 2 unhandled errors, 17.17 s |
| Shell same packet GREEN | 25 passed, no unhandled errors, 8.68 s |
| Full kernel suite | 112 files passed / 1 skipped; 1,200 tests passed / 1 skipped; 495.54 s |
| Full shell suite | 125 files and 834 tests passed; no unhandled errors; 397.75 s |
| New kernel product-gate model fixtures RED | 2 failed: new model output was executable JavaScript |
| Product-gate fixtures + blueprints GREEN | 11 passed, 1.64 s |
| Shell planner bridge + production backup + directory adapter + automatic recovery + trust packet | 65 passed, 39.09 s |
| Root onboarding / product-gate config / frozen-budget unit tests | `node --test scripts/product-onboarding.test.mjs scripts/product-gate-config.test.mjs scripts/bundle-budget.test.mjs`: 32 passed |
| Kernel and shell affected typechecks | package-local `node node_modules/typescript/bin/tsc --noEmit`: exit 0 |
| Panel production build | package-local `node node_modules/vite/bin/vite.js build`: exit 0; final run 198 ms |
| Shell production build with module diagnostic | `node scripts/bundle-module-report.mjs`: exit 0; final run 14.52 s |
| Frozen gate | `node scripts/bundle-budget.mjs`: exit 1 at total shell JS; freshness and all named lazy checks preceding it passed |
| Full diagnostic | `node scripts/bundle-diagnostic.mjs`: exit 1; all 24 boundaries measured, four RED |

Final `git diff --check` exited 0. Added tracked lines and seven new source files
were scanned for runtime eval, unsafe HTML assignment, private-key/credential
patterns and debugger statements: zero matches. All 13 changed/new JavaScript
scripts passed `node --check`. These are targeted hygiene checks, not security
review or a certificate. HEAD and the local origin ref remain `2da7760...`.

Full-suite results above are development finder results, not an immutable candidate
certificate. The later model-fixture test and script-only changes have focused
coverage; the final exact-tree campaign still follows completion of the FIX work.

### Final measured bundles (raw / gzip bytes)

| Boundary | Measured | Frozen limit | Result |
| --- | --- | --- | --- |
| ProductionBackupRuntime | 32,057 / 10,833 | 45,000 / 14,000 | PASS (was 45,250 / 15,509) |
| Worker authority | 212,676 / 53,290 | 240,000 / 60,000 | PASS, unchanged |
| Total shell JavaScript | 1,183,647 / 349,690 | 980,000 / 290,000 | FAIL |
| Complete worker closure | 1,461,057 / 392,375 | 1,010,000 / 280,000 | FAIL, unchanged |
| Application styles | 78,807 / 20,198 | 67,000 / 17,000 | FAIL |
| Complete browser payload | 4,027,944 / 1,287,860 | 3,250,000 / 1,100,000 | FAIL |

All other measured boundaries passed, including entry/boot, other named lazy
surfaces, planner chunks, SQLite support workers/WASM, and panel bootstrap.
`scripts/bundle-budget.mjs` and `bundle-budget-lib.mjs` are unchanged. No measurements
exclude dynamic imports, support assets or styles. Splitting a chunk alone cannot
fix these remaining aggregate boundaries.

## Browser and external gate status

Owned finder commands actually attempted:

```powershell
node scripts/product-cold-start.mjs
$env:CLAY_TEST_CHROMIUM_CHANNEL='chrome'; node scripts/product-cold-start.mjs
$env:CLAY_TEST_CHROMIUM_CHANNEL='msedge'; node scripts/product-cold-start.mjs
```

- Default: exit 1, missing
  `C:\Users\nakul\AppData\Local\ms-playwright\chromium_headless_shell-1228\chrome-headless-shell-win64\chrome-headless-shell.exe`.
- Installed Chrome 152.0.7977.76 and Edge 153.0.4234.32: exit 1 before page creation;
  launch reports Windows access/token failures, "DevTools remote debugging requires
  a non-default data directory" despite an owned temporary profile, and GPU process
  exit `-1073741790`. Sandboxing stayed enabled. No existing browser context was used.
- A final `launchPersistentContext` attempt using an owned new
  `D:\Clay\test-results\fix-batch\owned-chrome-lBAC5E` directory also failed before
  page creation, with `GPU process isn't usable. Goodbye.` No app timing or packaged
  browser success is claimed. Its launch diagnostic is `owned-profile-launch.json`;
  the last regular finder failure is `cold-start.json` in the same ignored folder.
- The only preview started was local Vite on 127.0.0.1:4181 with `--strictPort`.
  It was stopped via its owned exec session after the failed attempts. Reserved
  4173/4174/4175/4177/4180 servers and unrelated workloads were not touched.
- Release B's frozen Chromium 149.0.7827.55 runtime was not found in the available
  default/installed locations. Its verifier was NOT weakened or rerun using a
  substitute runtime, and its historical evidence was NOT rewritten. Current
  `backup-target.browser.ts` SHA-256 is
  `441e83ef9824e5697f181c26603ef850b3097aa204da0b13edd7a840bc22385e`, not the old
  `6b6832f14b5c1b932424b082f67d7a0771fb86ec9fc1d34bb64fa272019d8fc1` binding.
- Preserve collector classifications: canonical transaction certificate 180/180
  PASSED in D:\Clay (not rerun here); detached junction WASM error is not a product
  regression. Release C parser and other package checks were reported passed by
  the collector. Live Anthropic regression remains optional/external; no credentials
  were requested, inspected, added or used. Local export must run on a clean final
  candidate, with its clean-tree requirement unchanged. Release A needs its explicit
  loopback URL; the collector omission was not a source defect.

## Exact continuation - finish FIX, then immutable campaign

1. Preserve this entire diff on base `2da7760...`; one writer, no Git writes here.
   Do not redo the fixed fixture defects or disable production native recovery.
2. CODE: finish aggregate budget work. Inspect ignored `bundle-modules.json` and
   `bundles.json`, not a guessed source size. The worker's largest shared chunk
   contains pinned SQLite, ClayStore, Acorn and closed schema validation; shell
   contains independent schema/React/domain code. Vite's nested worker diagnostic
   can list identical emitted import-worker filenames twice; the budget collector
   correctly counts each emitted file once. Preserve parser/validation/recovery
   functionality. All four aggregate red boundaries above require real reduction;
   do not remove capabilities, raise limits or alter the collector.
3. HOST / BROWSER: run the updated owned journeys on a host that can launch a
   sandboxed browser. Rebuild this exact source first. Start only an owned 4181
   preview (`node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4181
   --strictPort` from packages/shell), then from root set
   `$env:URL='http://127.0.0.1:4181'`. Use `product-cold-start.mjs` to isolate timings,
   and the eight updated product scripts, with output dirs under ignored
   `test-results/fix-batch/`. An explicit installed Chrome finder override is not
   Release B or cross-browser certification. No timeout inflation/storage clearing/
   external-CDP/sandbox bypass. More selector drift may remain until execution.
4. SOURCE BINDING + CERTIFICATION: after bundle/source fixes stabilize, regenerate
   Release B code/build/matrix/suite binding AND genuinely observed frozen-runtime
   restart/memory evidence through `node scripts/release-b-backup-certification.mjs`.
   Do not merely rebind the shared certification object to new bytes and call its
   historical `verdict: pass` current. If frozen runtime/human evidence is unavailable,
   retain an explicit external gate. Authentication-before-ZIP and key custody stay.
5. On the clean immutable final candidate, run remaining campaign gates, including
   `CLAY_RELEASE_A_URL` on the owned loopback preview and clean-tree local export.
   Manual NVDA remains human-only. Do not start formal independent review until the
   coherent deterministic FIX batch and requested automated campaign are ready.

No claim of P0, A-F, release certification, or shipment is made by this checkpoint.

---

# Historical A-F source-development completion - 2026-09-13

Source/UI development is complete under the bounded compatibility outcomes in
ADR-070. This is NOT certification, shipment, or a claim that all release gates
pass. The requested single integrated test campaign is NEXT, not run in this turn.
This current section supersedes all historical development/code-blocker notes below.

## Current completion on 18d88eeb

Started clean in `D:\Clay`, branch `codex/clay-project`. HEAD and the local tracking
origin both read `18d88eebca78353322257ca73a50eca557a80f52`; no network remote readback
or Git metadata write was attempted. Leave this source/test/documentation diff for
the parent workflow to preserve. No commit, push, download, production setting,
deployment, user browser/storage access or release evidence regeneration occurred.

### Completed final bounded source work

- Closed public `LegacyOwnerCandidateV1`/inventory/proof contracts. WorkerClient
  `legacyOwnerInventory` -> db-worker -> serialized ProductionStoreAuthority reads
  only receipt metadata. Original catalog/generation, mirrored receipt/reservation
  history and route-anchored operation IDs must match. The existing public
  `intakeOwnerWitness` and proven deleted-original recovery remain unchanged.
- `transferLegacyOwner` carries only that public candidate and an owned private
  port through WorkerClient. A separately serialized internal kernel sink validates
  exact original response byte length/hash, the closed historical envelope and
  reconstructed route payload. It never normalizes or replaces original bytes.
  AES-GCM ciphertext with RSA-OAEP wrapping is bound to the actual worker/shell
  origin, nonce and public proof. Neither plaintext responses nor private fields
  enter ordinary worker responses, panel runtime, diagnostics, logs or archives.
- The trusted shell preserves exact historical bytes in a bounded insert-only
  IndexedDB vault, commits and reads back, verifies original private key evidence,
  then commits/readbacks applicable active owner custody before acknowledgement.
  Interrupted insertion, owner commit and readback retry the same source/form/
  receipt with the same original keys. Public historical responses never mint
  missing private custody. Superseded definitions are recoverable as custody-only.
- Recovery Center -> Legacy ownership compatibility exposes explicit discovery,
  proven recovery, original-definition activation, exact retry and safe cancellation.
  Activation is an immutable public `intake.command` intent retained before the
  effect, original app/generation/lineage-bound, receipt-first across reload and
  later presentation changes. Renew only after exact cancellation/readback and
  a fresh explicit original-target review; preserve every previous request ID.
- A separate V2 intake state can coexist with quarantined V1 without reading,
  stripping, overwriting or adopting it implicitly. Underlying app data stays
  usable. Explicit new form/share/app actions do not claim old work is terminal.
  Old source-free sharing receipts are detected by storage KEY only; private URLs
  and tokens are never read to guess ownership. Copied metadata never gains custody.
- Native recovery and conditional automation code were NOT redesigned. Focused
  owned SAHPool/real-worker and native capability/bounds checks pass; unexplained
  tuples, oversized corpora and uncertain slots remain fail-closed. Scheduler
  reconciliation, intake deferral, relay tombstones and default-denied config stay
  intact. ADR-070 documents development completion vs compatibility vs certification.

### Explicit safe compatibility outcomes (not open code work)

- Source-free/unanchored V1 records, missing exact response bodies, malformed
  envelopes, wrong-source copies and old source-free share receipts cannot prove
  automatic ownership. Keep originals untouched/quarantined. Reconnect the proven
  original app if available, or create an independent reviewed form/share/app.
  Possession of a key/URL, semantic IDs, cache state or HTTP absence is not proof.
- The original catalog can prove public deletion history even when a new fork no
  longer has the original response bytes. Do not reconstruct a private body from
  that witness. Existing proven deleted-original publication recovery still uses
  original shell custody and exact relay tombstones. Missing proof/custody remains
  an explained compatibility state, not fabricated closure or automatic retargeting.
- Legacy private app state and historical responses remain archive-export denied,
  INCLUDING after sealed adoption, because originals are deliberately preserved.
  Sealed shell custody is not an external backup. No secret-bearing archive,
  silent scrubbing, source replacement or inherited fork/restore ownership exists.
- Limits: 100,000 receipt metadata rows, 16 per page; each response at most
  2,000,000 bytes; 32 recovered histories; eight retained activation attempts per
  history. No eviction to make room. Unknown old invocations stay retained and may
  still be active remotely; new publication is not their revocation.

### A-F source/UI inventory (not certification)

The executable census has 21 capability entries with exact route classifications,
UI files, recovery behavior and focused test paths. The grouped map below includes
preserved work; this turn did not rerun all earlier A-F tests.

| Phase / capability | Production/trusted-shell route and UI | Durable retry/recovery / focused finder |
| --- | --- | --- |
| A lifecycle, first use, starter/import-as-new | boot/createApp/seed/switchApp/renameApp/forkApp/deleteApp/importNewApp/undoNewAppImport; App, ImportReview | Catalog identities/fences/receipts, independent targets, Preview/Keep/Discard/Undo; worker-lifecycle-integration |
| B start over, authenticated export/Kit/restore, manual download, folders/automatic backup/retention and record recovery | New-app setup; shell key vault/verifier; collectArchiveSnapshot/validateBackupStage/publishBackup/restoreAsNew, manual/retention routes, recoveryCandidates/restoreRow/undoBatch/makeLatest; RecoveryCenter | Format 5 authentication before installation, fresh restore jobs, retained manual receipt, permission revalidation, per-file retention acknowledgements; worker-restore-integration, worker-manual-download-integration, worker-backup-retention-integration |
| C preview-first CSV/TSV/XLSX and relation conversion | beginImport/stageImportChunk/configureImport/previewImport/commitImport/cancelImport/undoImport; previewRelationConversion/convertTextToRelation/undoRelationConversion; ImportWizard, RelationConversionDialog | Exact 2,000,000-byte input bound, retained immutable Keep/Undo and terminal cancellation; release-c-import-coordinator, relation-conversion-recovery |
| D sources/timezone/favorites/recents, Capture/Undo, Inbox/Complete/Snooze/Dismiss/Undo | dailyPresentation, dailyHome source/navigation CAS/timezone/Capture/Undo, dailyInboxAction/dailyInboxUndo; TodayView, CommandPalette | Original source/projection/semantic IDs, immutable desired-value CAS, local-calendar disposition storage, receipts and bounded inverse; worker-daily-relation-integration, quick-capture, daily-inbox-authority |
| E recipes/custom lossless V2 editor, preview, create/edit/enable/pause/delete, manual/due runtime, history/notifications/Undo | automationPresentation/automationCommand/simulateAutomation; AutomationCenter, TodayView | Original-connection native capability is conditional; retained command reconciliation and intake deferral; worker-automation-integration, production-native-recovery, automation-retained-ui |
| F local Print/CSV, immutable sharing/attachments/expiry/revocation/delivery | projectPlaintextV1/cancelProjectionV1/attachmentsForRecord/readAttachment; shell source/origin-bound vault and authenticated relay; ExportDialog, ShareDialog | Immutable encrypted projection/ciphertext, original source custody and exact relay terminal proof; export-dialog, share-custody, share-terminal |
| F intake V2, publication/delivery/attachments/expiry/revoke, review/accept/reject, auto-accept/receipts/Undo | intakePresentation/intakeCommand plus outcome/cancellation; shell-only custody/decryption/HTTP; IntakeCenter | Original source/request contexts, retained workflows, staged review, exact terminal/tombstone/renewal and inverse; worker-intake-integration, intake-ui |
| F original-owner recovery and legacy compatibility | intakeOwnerWitness, legacyOwnerInventory/transferLegacyOwner, intakeCommand/mutationOutcome/cancelPresentation; RecoveryCenter/OriginalOwnerRecovery/LegacyOwnerRecovery | Public history proof, sealed exact bytes, custody readback before actions, retained activation and bounded safe unprovable states; worker-owner-recovery-integration, worker-legacy-owner-integration, legacy-owner-custody, legacy-owner-ui |

`node scripts/roadmap-development-census.mjs` now reports `developmentComplete:
true`, zero development blockers/disabled UI flags, and 25 unavailable routes,
ALL explicitly callerless retired compatibility routes. It is read-only inventory,
not executable user-journey proof, a source fingerprint or a release gate.

### Actual focused output in this turn

Repository-local commands ran serially, without downloads. Vitest suffix for each
packet: `--maxWorkers=1 --minWorkers=1 --reporter=dot`, package-local cwd.

| Command after `node node_modules/vitest/vitest.mjs run` | Actual final output |
| --- | --- |
| kernel: test/legacy-owner-recovery.test.ts test/intake-owner-witness.test.ts test/intake-v2-authority.test.ts test/intake-archive-boundary.test.ts | 4 files / 32 passed; 40.01s |
| shell: test/legacy-owner-custody.test.ts test/worker-legacy-owner-integration.test.ts test/legacy-owner-ui.test.tsx test/original-owner-recovery.test.tsx test/production-mutation-route-census.test.ts test/intake-ui.test.tsx test/intake-workflows.test.ts test/share-custody.test.ts test/share-owner-ui.test.tsx test/share-terminal.test.ts | 10 files / 67 passed; 29.38s |
| shell: test/worker-automation-integration.test.ts -t owned_sahpool | 1 file / 1 passed, 1 skipped; 18.10s |
| kernel: test/production-native-recovery.test.ts -t 'grants automation\|bounds the actual\|rejects a corrupted' | 1 file / 3 passed, 27 skipped; 21.16s |

These disjoint selections contain 103 passing tests, not a comprehensive regression
campaign. Earlier repeated packets are not extra tests; output lost at a context
boundary was rerun, not invented. Missing authority/custody paths and legacy V2
coexistence were exercised RED before implementation. Malformed later state now
allows proven custody-only history; no proof guard was removed. A fixture initially
assumed a new fork retained original response bodies: actual production readback
showed it does not, and the test now proves rejection instead of fabricating bytes.

- Schema, kernel and shell: `node node_modules/typescript/bin/tsc --noEmit`, all
  exit 0. Shell initially reported two TEST-fixture typing errors (an indexed
  byte and incomplete MessageEvent); corrected using bounded bytes/real MessageEvent,
  then reran its focused packet and typecheck successfully.
- Census: exit 0, candidate HEAD 18d88eeb, 21 capabilities, developmentComplete true,
  testsExecutedByThisCommand false, disabledUiFlags 0, unavailableRoutes 25,
  unretiredUnavailable 0, developmentBlockers 0.
- No production build, full ordinary suite, budget, packaged browser matrix,
  accessibility or formal review was run. Earlier red/stale release evidence is
  NOT changed into passing evidence. Human NVDA remains pending.

### Changed paths in this final source diff

- Kernel: package.json, production-authority.ts, store.ts, new
  legacy-owner-recovery.ts; intake-owner-witness.test.ts, new
  legacy-owner-recovery.test.ts and helpers/legacy-intake-history.ts.
- Schema: package.json and new legacy-owner.ts.
- Shell app: App.tsx, IntakeCenter.tsx, OriginalOwnerRecovery.tsx, worker-client.ts
  and new LegacyOwnerRecovery.tsx. Shell intake: workflows.ts.
- Shell custody/worker: new legacy/owner-protocol.ts, legacy/owner-recovery.ts,
  legacy/owner-vault.browser.ts, worker/legacy-owner-channel.ts;
  worker/db-worker.ts and worker/mutation-route-census.ts.
- Shell tests: new legacy-owner-custody.test.ts, legacy-owner-ui.test.tsx,
  worker-legacy-owner-integration.test.ts.
- Inventory: this handoff, CODEX_HANDOFF.md current-status pointer,
  scripts/roadmap-development-census.mjs and specs/docs/10-decisions.md (ADR-070).

## Exact continuation

1. Preserve the complete current diff externally; verify live HEAD/status first.
   No Git write is authorized inside this sandbox. Read this current section, not
   the superseded historical task lists below. Keep one writer in D:\Clay.
2. Source-development is complete. STOP development slicing and hand off to the
   parent's SINGLE integrated test campaign. Do not keep the roadmap open merely
   because an intrinsically unprovable historical format cannot grant ownership;
   its tested, explicit safe compatibility outcome is the intended product behavior.
3. When that campaign is explicitly authorized: exercise one exact integrated
   source tree through ordinary/security/property suites, typechecks, production
   build, unchanged frozen budgets, source-bound owned browser journeys and the
   requested Chromium/Firefox/WebKit/keyboard/axe gates, then formal review and
   fix/retest actual findings. No fabricated source binding or passing evidence.
   Real human NVDA certification stays pending until performed by a human.
4. Certification and external configuration/deployment remain separate: no real
   relay/provider values are configured, origin authentication remains default-
   denied, and deployment is not authorized. Native browser crash certification,
   bundle limits and historical blocked/stale browser reports are still open
   release gates. No certification, shipment or full roadmap release is claimed.

## Historical development continuation on 674a001f (superseded)

This section and the new Exact continuation below supersede the historical notes.
Started clean in D:\Clay, codex/clay-project, local HEAD and tracking origin both
674a001f47f6abf05a107206d4cae1cf0135e4fb. The current work is one uncommitted
source/test/documentation diff. No Git metadata write, deployment, dependency
download, user browser/storage access, formal review or certification was performed.

### Implemented in this continuation

- Public original-owner witness: closed `@clay/schema/owner-witness`,
  `WorkerClient.intakeOwnerWitness` -> db-worker -> serialized
  `ProductionStoreAuthority.intakeOwnerWitness` -> closed catalog/original target
  and reservation/receipt metadata proof. The client rejects private/unknown
  fields before transport. The worker never selects `response_json` on this path.
  Exact V2 creation request/public response hashes and route-anchored operation
  IDs are required. Source-free V1, private/malformed/wrong-route response hashes,
  unanchored operations and copied/rebound source claims are denied.
- `DeviceCatalog.completedOwnerRetirement` proves an exact completed schema-2
  deletion of the retained original app/generation. Live, history-only and deleted
  witnesses are distinct. Neither a missing app nor another selected app grants
  ownership or terminal exclusion. Fork/create/delete/reload tests exercise the
  retained original receipt and catalog history; copied metadata stays non-owner.
- Recovery Center -> Original owner recovery lists only bounded public workflow
  keys (closed physical cardinality, up to 1000; eight records per UI page), then
  requires explicit original-owner review. `IntakePublication.closeDeletedOriginal`
  persists the reviewed permanent deletion evidence before existing original shell
  custody/key readback and exact authenticated relay tombstone. Revalidate owner
  history afterward, close/read back the public ledger, preserve every request,
  closure/renewal, receipt and private record. Lost ledger/cache/relay/close-readback
  and configuration-switch cases resume exact originals after teardown/reload.
  A delayed original worker command cannot mutate another app; delayed HTTP
  registration meets the relay's permanent terminal conflict. Active forms and
  history-only witnesses remain ineligible for this deletion-only action.
- Genuine production native recovery is connected, not just prototyped. Before
  catalog migration, restore or lifecycle reads, `bootBrowser` runs the coordinator
  under physical lifecycle exclusion. The adapter is installed immediately after
  preserving initialization, before any durable main has opened. The same original
  SAHs remain held. A bounded disposable exact-path SQLite VFS rolls back only
  private copies to prove the original closed modern OR pre-retention catalog,
  all physical pending rows, owner tuples, all live canonical state and Merkle
  roots. Revalidate original bytes, grant only the exact real tuple's native
  rollback, then recheck the real catalog and all targets before ordinary boot.
  No global reserved-lock change and no raw catalog/target sidecar bypass.
- Torn/malformed association headers and cleared associations with retained
  payload now remain quarantined under their original handles, excluded from SDK
  enumeration/reuse. Duplicate valid names and actual handle/I/O uncertainty still
  fail closed. A possibly quarantined catalog cannot be silently replaced. Count-
  only Recovery Center warning states that current-app backups exclude these
  unknown bytes. No uncertain file was deleted/rebound to satisfy inventory.
- Automation now obtains an unforgeable original-connection runtime capability
  only after closed boot proof and live rechecks of held handles, exact main/sys/
  catalog topology, DELETE journals and FULL-or-higher synchronization. The grant
  explicitly has `releaseCertificate: false`. Every original SAH write/truncate
  during synchronous automation reserve/invoke/commit/rollback is bounded BEFORE
  I/O, including cache spill and journal growth. Runtime I/O bound: 32,000,000
  bytes; private shadow corpus: 64,000,000 bytes; max 4096 slots. Larger/unproven
  data stays untouched and automation stays unavailable with truthful UI wording.
  Serialized capability labels and closed/copied connections cannot authorize it.
  A real WorkerClient/db-worker journey uses the installed browser WASM/SAHPool
  over owned protocol handles, in addition to the memory fixture. Editor, manual/
  scheduled execution, notifications, history, exact retries and Undo are exercised.
  The scheduler still reads trusted-shell intake work before minting another ID.
- Added ADR-068/069. Format 5, archive private-state/export denial, A-D source,
  original closure/renewal chains, relay authentication and default-denied origin
  configuration are preserved. No frozen bundle limit or release evidence changed.

### A-F source inventory (not certification)

| Capability | Production route / UI | Recovery / focused finder |
| --- | --- | --- |
| A lifecycle, first use, preview-first import | createApp/switchApp/renameApp/forkApp/deleteApp/importNewApp; App/ImportReview | Exact catalog jobs/receipts, fallback and independent identities; worker-lifecycle-integration and production-native-recovery |
| B export/Kit/manual download/folder retention/restore | Trusted-shell vault/verifier; collectArchiveSnapshot/validateBackupStage/publishBackup/restoreAsNew and retention routes; RecoveryCenter | Preserved authenticated format 5 and receipts; native recovery now precedes migration and fenced restore/lifecycle reads; production-restore-lifecycle |
| C preview-first migration/relation Keep/Undo | Existing import coordinator and conversion/Undo routes; ImportWizard/RelationConversionDialog | Original immutable intents and bounded inverse preserved; no new C certification this slice |
| D Capture/Undo/source/navigation/Inbox dispositions | Existing daily authority/CAS/action/Undo routes; CommandPalette/TodayView | Original app/source/projection/semantic bindings preserved; no new D certification this slice |
| E editor, recipes, runtime/history/notifications/Undo | automationPresentation/automationCommand/simulateAutomation; AutomationCenter/TodayView | Conditional real native recovery grant; retained scheduler reconciliation/intake deferral; worker-automation-integration, production-authority-automation, production-native-recovery |
| F new sharing and intake V2 | Source-bound projections/attachments, intakeCommand; ShareDialog/IntakeCenter; shell-only vault and HTTP | Preserved exact terminal/tombstone/retry/receipt/Undo paths; worker-intake-integration |
| F proven deleted-original publication | intakeOwnerWitness; RecoveryCenter/OriginalOwnerRecovery | Existing original custody, immutable deletion witness, exact relay tombstone, retained ledger close; worker-owner-recovery-integration and original-owner-recovery |
| F private legacy intake/receipts and old source-free sharing | Still quarantined; no ordinary private read or advertised adoption action | CODE remains: sealed trusted-shell transfer after original witness proof; ambiguity cannot be converted into ownership |

The executable census is inventory only. `developmentComplete` remains false.
Unavailable compatibility routes remain explicitly retired, not newly enabled.

### Current focused finder output

Commands use repository-local binaries, serialized, with no downloads:
`node node_modules/vitest/vitest.mjs run <files> --maxWorkers=1 --minWorkers=1 --reporter=dot`.

| Package / exact files | Actual output |
| --- | --- |
| kernel: test/production-native-recovery.test.ts test/sahpool-initialization.test.ts test/sahpool-recovery.test.ts test/intake-owner-witness.test.ts | 4 files / 82 passed; 144.78s |
| shell: test/worker-owner-recovery-integration.test.ts test/worker-automation-integration.test.ts test/worker-intake-integration.test.ts test/worker-lifecycle-integration.test.ts | 4 files / 9 passed; 164.50s |
| kernel: test/app-lifecycle.test.ts test/production-restore-lifecycle.test.ts test/lifecycle-recovery-inventory.test.ts test/durable-inventory.test.ts test/intake-v2-authority.test.ts test/intake-archive-boundary.test.ts test/production-authority-automation.test.ts | 7 files / 82 passed; 122.22s |
| shell: test/original-owner-recovery.test.tsx test/recovery-center.test.tsx test/intake-workflows.test.ts test/intake-publication-terminal.test.ts test/intake-revocation-renewal.test.ts test/intake-ui.test.tsx test/automation-retained-ui.test.tsx test/automation-tick.test.ts test/production-mutation-route-census.test.ts | 9 files / 104 passed; 22.34s |
| schema: test/intake.test.ts test/catalog.test.ts test/share.test.ts | 3 files / 15 passed; 1.51s |

These disjoint selected packets contain 292 passing tests across 27 files.
Repeated subset finder runs are not added to this count.
These are not a source-bound production build, browser durability certificate,
frozen-budget result or comprehensive regression campaign. Earlier failed runs
are not passes: missing dispatch/methods and original recovery/initialization
faults were reproduced, then fixed; fixture-only issues (worker module reuse,
kernel dependency resolution, memory/native recovery substitution and modal portal
selection) were corrected without weakening production boundaries. One owned
worker packet was interrupted during the module-reuse fixture failure and is not
counted; its corrected complete rerun is the 9-test result above.

Final development checks on the preserved source diff:

- Kernel, schema and shell: `node node_modules/typescript/bin/tsc --noEmit`
  from each package directory, all exit 0 with no diagnostics (serialized).
- Final kernel subset: `node node_modules/vitest/vitest.mjs run
  test/production-native-recovery.test.ts -t 'recovers exact' --maxWorkers=1
  --minWorkers=1 --reporter=dot`: 12 passed / 18 skipped, 43.60s. This repeats
  the create/fork/restore fault cases already counted above, after the final
  pending-row preflight change; it is not 12 additional distinct tests.
- `node scripts/roadmap-development-census.mjs`: exit 0; developmentComplete
  false, disabledUiFlags empty, 25 unavailable compatibility routes all explicitly
  retired, no unretired unavailable route. F legacy adoption remains a code gap
  even though its unsafe compatibility routes are correctly closed.
- `git diff --check`: exit 0. Git status: 41 changed paths (31 tracked edits and
  10 new files). HEAD and local tracking origin remain 674a001f; no network remote
  readback, commit, push or Git metadata write was attempted.

### Changed source/test scope

- Kernel: db.ts, device-catalog.ts, production-authority.ts,
  production-automation-observer-routes.ts, production-mutation-coordinator.ts,
  sahpool-initialization.ts, sahpool-journal-recovery.ts; new
  native-recovery-bounds.ts, native-recovery-shadow.ts,
  production-native-recovery.ts and production-owner-witness.ts.
- Kernel tests: new intake-owner-witness.test.ts and
  production-native-recovery.test.ts; sahpool-initialization.test.ts and owned
  browser-storage/SAHPool helpers.
- Schema: package.json export, intake-workflow.ts and new owner-witness.ts.
- Shell: App.tsx, AutomationCenter.tsx, RecoveryCenter.tsx, automation-tick.ts,
  worker-client.ts, new OriginalOwnerRecovery.tsx, intake/publication.ts,
  intake/workflows.ts, worker/db-worker.ts and mutation-route-census.ts.
- Shell tests: new original-owner-recovery.test.tsx and
  worker-owner-recovery-integration.test.ts; automation-retained-ui,
  intake-workflows, recovery-center, worker-automation-integration,
  worker-intake-integration, worker-lifecycle-integration and owned-idb helper.
- Inventory/decisions: this handoff, scripts/roadmap-development-census.mjs and
  specs/docs/10-decisions.md (ADR-068/069). No generated release evidence, lockfile,
  production configuration or dependency installation changed.

## Historical continuation on 674a001f (superseded)

1. Preserve this entire working diff or the externally saved checkpoint on
   674a001f47f6abf05a107206d4cae1cf0135e4fb. Check live HEAD/status, read this
   section first, and remain the only writer in D:\Clay. No Git writes, downloads,
   production actions or integrated certification in development.

2. Finish F sealed private legacy adoption, not the completed public V2 witness
   again. This is CODE, not a configuration/deployment gate. The new witness never
   selects response_json and cannot validate/transfer private historical bytes.
   - Next narrow boundary: `production-owner-witness.ts` accepts only the exact
     original public V2 save invocation. Do not broaden its ordinary response to
     include old private rows or response_json. Design a separately sealed trusted-
     shell channel only after closed original catalog/history/owner and route-
     anchored operation evidence. Validate exact historical response bytes privately
     without normalizing their identity. Custody commit/readback must precede owner
     actions; a lost commit must resume the same original record, never mint keys.
   - V1 forms lack ownerSource; old sharing receipts lack app/generation/lineage.
     Neither an app cache, key/URL possession, copied semantic IDs, current selection
     nor an invented positive fixture establishes original authority. Investigate
     actual historical producers and retained catalog/history proof. Where proof
     genuinely does not exist, keep explicit quarantine and explain the limitation.
   - Preserve all original rows/responses/vault records and authenticated archive
     denial of private/malformed historical envelopes. Never inspect real values,
     strip/delete/rebind originals, archive private data, or pass it through
     WorkerClient. Test synthetic private/public/malformed legacy envelopes,
     wrong-source copies, lost custody commits and create/fork/delete/restore/reload.
     No sealed transfer/adoption path was implemented in this continuation.

3. Finish remaining original-source loss cases. A completed exact original app
   deletion plus retained V2 creation receipt is NOW supported for public retained
   publication in Recovery Center; preserve that path and its relay tombstone.
   Missing/unproven generation, missing custody, cache-only work without a retained
   original creation receipt, deleted-original revocation jobs, private legacy and
   old sharing receipts still stay quarantined. Extend only with original history
   or equivalent permanent exclusion, not absence. Active-form behavior and prior
   closure/revoke renewal chains must remain unchanged. Preserve public-key
   inventory bounds and original-source UI review; never auto-retarget old work.

4. Preserve the connected native coordinator and runtime guard. Read
   production-native-recovery.ts, native-recovery-shadow.ts, sahpool-initialization.ts,
   sahpool-journal-recovery.ts and ADR-069 before editing. Original tuple proof is
   from a privately recovered, closed catalog BEFORE real rollback, not from names.
   Both modern and exact legacy retention shapes participate without shadow
   migration. All-target canonical/Merkle readback and fenced partial-file recovery
   remain mandatory. Quarantine is not successful file deletion or a backup.
   Runtime capability is conditional and not a certificate. Keep the pre-I/O
   automation scope, bounds, topology/FULL/DELETE checks and scoped reserved-lock
   behavior. Do not convert unknown/legacy files into an owner tuple or reuse them.
   Physical browser crash certification remains the later integrated campaign.

5. Update the census/handoff as inventory after source/UI work. Only when all
   intended A-F source/custody/recovery boundaries exist, stop for the single
   integrated test campaign; do not start it as another development finder loop.

## Historical development continuation on 6dc0e3f4

This section and Exact continuation supersede the historical notes below. A-D,
E editor/scheduler and the committed F custody/terminal protocols were preserved.
Development is NOT complete; there is no new certificate or release evidence.

- Completed bounded reviewed `IntakePublication.renewClosure(target, requestId)`:
  recover the retained ledger, match the reviewed ORIGINAL invocation and target,
  prove existing original-source private custody in shell, cancel/read back that
  exact request, verify its exact relay tombstone, recheck source, then commit/read
  back a new immutable closure intent. At most eight renewals; no retargeting,
  eviction, key generation or replacement under an ambiguous/committed outcome.
  Original `authorityClosure` and every renewal remain retained. Closure/relay
  receipts commit before finish and are immutable. Cancellation, readback, relay,
  ledger commit, cache acknowledgement and reload faults preserve prior work.
- IntakeCenter exposes Review closure recovery -> Confirm renewed publication
  closure / Keep original closure. It captures both target and prior request ID
  during review. Retry uses the retained replacement; active local forms still
  require explicit revoke, not a misleading completion message.
- Fixed a separate cache-only recovery regression: claiming an already-closing
  job preserves its existing termination/invocation rather than creating a new
  one. Physical ledger parsing now also cross-validates the original termination
  chain; independently valid jobs cannot discard an original closure ID/receipt.
- Real WorkerClient/db-worker coverage holds a closure message, advances the
  source through another authority mutation, reviews/renews/cancels the original,
  delivers the cancelled message, clears presentation cache, reads exact closure
  receipts, and reopens SQLite/catalog. Existing sharing, intake attachments,
  review, auto-accept and Undo parts of that journey remain intact.
- Production `db.ts` now uses `sahpool-initialization.ts` before installing the
  pinned VFS. It acquires and validates every existing association under exclusive
  handles before any SDK repair; the same handles are handed directly to the SDK
  without an unlock/reacquire gap. The scoped worker-only storage facade denies
  recursive pool cleanup, unexpected header writes and collisions, then restores
  the original storage method. Malformed/doubled associations, unassociated retained
  payload, pre-existing VFS, acquisition/read failure and uncertain init fail closed
  with static errors and original files preserved. Capacity is bounded at 4096 slots.
- This fixed reproduced native SDK behavior: malformed headers were disassociated
  and failed handle acquisition deleted the existing `.opaque` directory. The
  owned fixture now observes actual handle acquire/close and read callbacks.
  Both failure paths have executable regressions through the production initializer.
- Catalog probe and production-target open now reject unresolved relevant child
  journals/WAL/SHM or super-journals BEFORE SQLite opens/reads them. This includes
  the migration/restore probes at the beginning of `bootBrowser`. Pending lifecycle
  target sidecars remain eligible for existing exact job-fenced cleanup without
  opening the unpublished target. No general native rollback is permitted yet.
- Actual production authority boots and reopens on the installed browser WASM /
  owned SAH protocol fixture with data/identity persistence. Faults in real authority
  user/system/catalog commits preserve all bytes on reopen before any SQL page read.
  This proves FAIL-CLOSED behavior, NOT successful crash recovery. The existing
  native journal adapter remains unconnected and the automation capability remains
  `unavailable`; no observer or paired UI guard was weakened.
- Remaining F private legacy adoption was investigated, not implemented. V1 form
  rows lack ownerSource; old share receipts lack app/generation/lineage. Production
  request receipts can contain source metadata, but their historical responses may
  contain private fields and copied source metadata is not sufficient. Existing
  archive/quarantine boundaries stay closed. See the concrete next proof boundary
  below; no real secret, app storage or private historical value was inspected.

### Current focused finder-loop results

Commands use package-local Node binaries, serialized, with no downloads:
`node node_modules/vitest/vitest.mjs run <files> --maxWorkers=1 --minWorkers=1 --reporter=dot`.

| Package / exact files | Actual latest result |
| --- | --- |
| shell: test/intake-publication-terminal.test.ts test/intake-workflows.test.ts test/intake-revocation-renewal.test.ts test/intake-ui.test.tsx | 4 files / 57 passed; 13.46s |
| shell: test/worker-intake-integration.test.ts | 1 file / 1 passed; 41.21s (test 38.42s) |
| kernel: test/sahpool-initialization.test.ts test/sahpool-recovery.test.ts | 2 files / 45 passed; 9.70s |
| kernel: test/app-lifecycle.test.ts test/production-restore-lifecycle.test.ts test/lifecycle-recovery-inventory.test.ts test/durable-inventory.test.ts test/intake-v2-authority.test.ts test/intake-archive-boundary.test.ts | 6 files / 55 passed; 57.99s |
| schema: test/intake.test.ts test/catalog.test.ts test/share.test.ts | 3 files / 15 passed; 1.51s |
| shell: test/intake-session.test.ts test/intake-publication.test.ts test/automation-tick.test.ts test/production-mutation-route-census.test.ts | 4 files / 38 passed; 2.89s |

- Disjoint selected packets: **211 tests passed across 20 files**. Repeated
  finder-loop runs are not added. This is not the integrated regression campaign.
- `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`, run in schema,
  kernel and shell: exit 0, no diagnostics, after the source/test edits.
- `git diff --check`: exit 0. Live location is D:\Clay; HEAD and local tracking
  ref remain 6dc0e3f4bf40cf8dc20a6be7509fd684280f4411. No remote-server readback.
- The uncommitted checkpoint has 15 paths (13 tracked modifications, 2 new).
  No Git metadata, dependency, lockfile, server, real storage, production value,
  release artifact/evidence or frozen limit changed. No build/certification run.
- `node scripts/roadmap-development-census.mjs`: exit 0, 19 capability entries,
  developmentComplete=false, zero scanned hardcoded false UI flags, 25 unavailable
  routes all explicitly retired. Preserving initialization has a production caller;
  the native recovery adapter still has none and capabilityGranted=false. This is
  a read-only inventory, not executable evidence of product completion.

Earlier RED runs reproduced missing closure renewal/UI, discarded original closure
identity, eight initializer failures and premature hot-catalog reads. Finder-loop
fixture/type errors were corrected and rerun, never reported as passes. One root
TypeScript invocation failed with MODULE_NOT_FOUND for `D:\Clay\node_modules\typescript\bin\tsc`;
package-local TypeScript works. No host blocker or escalation was needed.

## Historical development continuation on ad6d9db0

This section and Exact continuation supersede the preserved earlier checkpoint
notes below. A-D and the committed E/F baseline were preserved. No certification.

- `intakeCommand` -> `intake.command` now accepts the sixteenth closed inner
  route, `intake.closePublication`. It checks original app/generation/lineage and
  public definition, journals the immutable request and returns the exact canonical
  closure receipt. Optional bounded `publicationClosures` in closed intake_v2
  excludes every future save/publish of that form ID, including unknown old-client
  IDs with fresh targets. It never deletes, relabels or revokes a local form.
- Revoked metadata cannot be resurrected by a higher save revision. Repeated
  revoke IDs cannot rewrite the original revokedAt/terminalReason. This permanent
  terminal state is required before treating unknown old-client revoke work as
  harmless; a read-only not_invoked snapshot is still not a request fence.
- Trusted-shell `IntakePublication.terminalizeLegacy` first proves the original
  V2 source, proposal, existing vault/key pair and relay. It claims closure-only
  public work while preserving `legacyOriginal`, cancels/reads every known original
  request, persists the authority closure intent before invoking, validates its
  receipt, and obtains the exact relay tombstone. Active published forms still need
  explicit local revoke; UI never calls them reconciled. Missing custody or original
  generation remains quarantined, without minting keys or discarding work.
- `IntakeOwnerClient.adoptLegacyRevocation(reviewedTarget)` proves original local
  metadata and existing private custody/readback before retaining a cache-only
  revoke. Adoption itself neither invokes nor declares local/remote completion.
  `renewRevocation(reviewedTarget)` cancels/reads the preceding invocation and
  verifies the exact relay tombstone before retaining a new immutable request.
  Reviewed source is checked again after asynchronous proofs. Prior requests remain
  in a maximum-eight renewal chain. A racing unknown revoke can win only once;
  reconciliation still terminalizes the known original and preserves that winner.
- Public terminal proof contains exact form, target, invocation status/ID and relay
  acknowledgement. It commits/readbacks before workflow finish and is immutable.
  Completed workflow slots retain up to 100 original jobs; capacity fails closed,
  not silent eviction. Cache teardown, cancellation/readback/claim/persist faults,
  wrong source/configuration and lost acknowledgements preserve all identities.
- IntakeCenter exposes confirmed legacy publication closure, reviewed original-
  owner revoke adoption, normal original retry, and explicit stale-revoke renewal.
  Adoption of an active local form is labeled incomplete. Copied source metadata
  and already-closed-form renewal prerequisites do not advertise a usable renewal.
- Archive guards now understand the existing prefixed canonical production
  response envelope. SQLite checks private property names before selecting values;
  public bodies then undergo canonical decode in bounded pages with exact physical
  cardinality. Malformed envelopes, escaped private keys, legacy rows/private
  receipts still reject. No original row or format-5 authentication was rewritten.
- E: the actual installed browser sqlite-wasm/SAHPool binary, running only against
  owned protocol handles, reproduced mixed `[2,1,1]` / `[2,2,1]` values on ordinary
  reopen after a three-file commit interruption. EXCLUSIVE mode alone also failed.
  New `sahpool-journal-recovery.ts` is an UNCONNECTED low-level adapter. It scopes
  the reserved-lock correction to an unopened exact tuple; bounds/prevalidates
  super-journal members; uses SQLite for hot/cold journal recovery; restricts native
  open/access/delete; and poisons uncertain recovery instances until reopen.
  Faults cover journal/master allocation/write/flush/delete, each database write
  and flush, write-through versus flush-only persistence, interrupted rollback,
  unowned side paths and unchanged unrelated legacy namespace bytes.
- No production boot call, capability grant, observer weakening or OPFS certificate
  was added. Catalog-proven exclusion/boot ordering is still CODE work. A pinned
  native-WASM protocol fixture is not physical browser certification.
- ADR-065/066 and the census record these boundaries as inventory only. Private V1
  intake/historical receipt adoption and old unbound share-receipt adoption remain
  required. Do not infer original owner authority from a copied source, URL or key.

Latest focused command results are recorded in the final finder-loop section.

## Workspace and preserved baseline

- Sole writer in `D:\Clay`, branch `codex/clay-project`.
- HEAD and local origin tracking ref remain
  `6dc0e3f4bf40cf8dc20a6be7509fd684280f4411`. Live location, clean starting
  status, HEAD and local origin tracking ref were verified. No fetch or actual
  remote-server readback. This continuation leaves one uncommitted diff on that base.
- The earlier 13-path intake continuation and its expanded F implementation are
  now committed baseline work. They were preserved, not reset or reimplemented.
- A/P0, B recovery/retention/authenticated archives, C conversion, D Capture/Inbox/CAS
  and E editor/workspace/history/Undo are preserved. Their implementation details
  remain in this handoff at the starting commit and ADR-060/061/062.
- One uncommitted source/test/documentation diff. No Git metadata writes, commits,
  pushes, installations/downloads, other checkout changes, server operations,
  deployment, production configuration or user-owned browser/storage access.
- The previous continuation's external development-6 context read was denied;
  this continuation did not retry it or read real credentials/user-owned storage.
- Package-local Node/Vitest/TypeScript binaries work. No current host blocker.
- No build, bundle report, browser evidence, release fingerprint or independent
  review was generated. Historical certification failures remain deferred.

## Preserved committed baseline: terminal publication and durable owner work

The following detailed baseline notes describe ad6d9db0's predecessor work.
Where they say a workflow fix is still required, the latest section above and
Exact continuation take precedence. They are not new test or completion claims.

- Added `POST /intake/forms/:formId/terminalize` and
  `POST /shares/:shareId/terminalize`. Authentication and exact allowlisted shell
  Origin precede body allocation. Both endpoints bind the original immutable
  request, owner capabilities/account and expiry, and acknowledge its canonical
  SHA-256 only after terminal persistence. Missing objects/404/410 are not proof.
- Memory and Postgres adapters retain revoked identities until original expiry,
  including absent-ID terminal allocations. Existing count/byte limits also count
  tombstones; limits were not increased. Share create replay requires exact owner,
  envelope, expiry and revocation hash. No second link is created. Intake IP/source
  hashes remain original quota labels; changing network does not change owner
  identity or rewrite those labels. Publisher and capability checks remain exact.
- Postgres create/terminal operations serialize, and read the trusted clock after
  locking. An expired terminal acknowledgement cannot be followed by a delayed
  create that used a stale pre-lock clock. Transaction failure and acknowledgement
  loss are never reported as terminal success. No hosted PostgreSQL was contacted;
  the adapter tests use an owned transactional SQL protocol fixture.
- `intake/workflows.ts` adds a bounded public-only shell IndexedDB CAS ledger,
  separate from private custody and the app DB. New publication begin is async:
  initial identity commits before presentation, custody, worker commands or HTTP.
  Each subsequent intent/transition commits and reads back before its effect.
  Completed slots can be reused; original custody, app metadata and worker receipts
  are not deleted. Both publication and revocation recover without sessionStorage.
- New publication closure claims the ledger, cancels/reconciles each exact original
  worker invocation, validates outcome readback, and obtains the remote terminal
  receipt where HTTP could have been invoked. A committed active local form needs
  explicit local revocation before closure finishes. An inactive draft remains
  intact. No source is silently renewed and no key/form/ciphertext is replaced.
- IntakeCenter exposes confirmed Close original publication and retained closure
  recovery. ShareDialog uses terminal receipts for revoke/abandon, disables retries
  under the wrong relay/expired publication prerequisite, and offers Review a fresh
  snapshot (which does not itself approve or publish anything). Both keep exact
  private material in their existing trusted-shell vaults.
- An old cache-only intake workflow is intentionally NOT adopted by copying it to
  the new ledger. An older tab might still mint/send requests outside the ledger;
  neither a read-only not_invoked result nor a newly added cache marker excludes
  that work. These originals stay untouched/quarantined. Authority-level legacy
  identity terminalization/adoption is still required (see Exact continuation).
- The scheduler checks durable intake workflow presence before minting a new due
  request; ledger read/conflict failure defers it. Retained due reconciliation is
  unchanged. E's actual production OPFS capability was not relabeled or enabled.
- RED/GREEN packets covered resurrection after revoke/cleanup, missing terminal
  routes, identical share replay, stale pre-lock time, fabricated 404/410 success,
  cache-loss persistence, stale-tab CAS, conflicting caches, cache-only legacy
  non-fencing, and scheduler cache-loss behavior. Additional deterministic fault
  tests cover delayed worker/HTTP, expiry/source/configuration changes, lost cancel
  commits, SQL commit abort/lost acknowledgement and original custody preservation.
- ADR-064 records the protocol and explicitly preserves the remaining legacy and
  OPFS boundaries. This is source development, not certification.

## Committed F production intake path (historical baseline)

### Worker, authority and physical metadata

- `WorkerClient.intakeCommand(payload, context)` requires an explicit immutable
  context and captures the payload before asynchronous work. db-worker routes it
  to authority `intake.command`, a closed original-target envelope.
- Exactly fifteen inner commands are supported:
  `intake.saveForm`, `markPublished`, `revokeForm`, `markExpired`,
  `stageSubmission`, `recordDeliveryFailure`, `authorizeDeliveryDiscard`,
  `resolveDeliveryFailure`, `rejectSubmission`, `simulateAutoAccept`,
  `enableAutoAccept`, `disableAutoAccept`, `processAutoAccept`,
  `acceptSubmission`, `undoReceipt` (all with the intake. prefix).
- Existing exact request hash/receipt, shadow/live execution, fencing, trusted
  execution instant, full 2,000,000 UTF-8-byte input bound and closed
  mutationOutcome/cancelPresentation contracts apply. Old direct intake writer
  methods are removed from WorkerClient and explicitly retired in db-worker/census.
- `intakePresentation` is a paired authority read of target, tables/semantic trace,
  V2 forms, rules, inbox, receipts and failures. New state is `intake_v2`, with
  `LocalIntakeFormV2` public metadata and original app/generation/lineage only.
- The old attachment/state normalizer does not run on V2. Malformed physical V2
  rows reject without rewriting their original bytes. Undo receipts remain bounded
  but survive a submission returning to pending; the former retention filter lost
  this history during real-worker testing.
- `production-intake-boundary.ts` checks owner/source binding before commands.
  Copied/forked/restored metadata keeps its original owner binding; it is explicitly
  read-only in IntakeCenter rather than advertising unusable owner actions.

### Legacy custody is quarantined, NOT adopted

- `intake_v1` is not exposed by ordinary worker settings/intake reads. If only
  legacy state exists, the paired presentation reports quarantine, not fake success.
  Original rows and historical responses are not stripped, rewritten, deleted,
  rebound or returned as redacted responses under their old request IDs.
- `intake-archive-boundary.ts` protects BOTH Store export paths and production
  collection. SQLite property-name checks detect escaped private capability keys
  before selecting archive values. Legacy rows, malformed V2 and secret-bearing
  historical responses deny export; valid V2 is subsequently closed-parsed.
- Safe legacy adoption is still required. Do not reopen an ordinary WorkerClient
  secret-bearing route, scrub original data or call this a completed migration.

### Trusted-shell custody, publication and review

- `intake/session.ts` retains public-only immutable commands in the presentation
  cache, reconciles the original outcome, and only clears after readback or a
  terminal cancellation. `commandOutcome` returns the exact receipt target;
  a newer UI refresh cannot become the source of a reviewed simulation.
- `intake/publication.ts` + `schema/intake-workflow.ts` retain the original form,
  proposal, source, configuration and save/publish requests before each effect.
  Custody commit/readback and key proof precede publication. Lost custody/save/
  relay/publish responses resume the same form and capabilities.
- Job parsing binds form IDs, immutable proposal, original owner and command
  identities, flags and terminal response; inconsistent jobs fail before writes.
  The save payload is checked against custody before invocation; the publication
  target must equal its exact save receipt. Relay acknowledgement must match form
  ID and expiry. Completed work stays retained until presentation acknowledgement.
- `intake/owner-client.ts` hydrates private material only in trusted shell after
  source/form/relay checks. Local revocation precedes HTTP; its original request
  and remote acknowledgement are retained. Expiry is based on the local clock,
  not a fabricated future timestamp after a remote 404.
- `IntakeCenter` is wired to these paths: preview/create/publish, recover public
  link, explicit revoke confirmation, encrypted fetch, delivery recovery/discard
  confirmation, partial-file review, accept/reject, simulation/enable/disable,
  receipts and Undo. Auto-accept uses the simulation's exact result target and
  original draft; files always require manual approval. Enabled rules execute on
  local inbox refresh, not off-device.
- Owner delivery JSON is bounded before parse, static errors do not echo remote
  bodies, redirects/ambient cookies are rejected, foreign form labels/duplicate
  delivery identities reject, and failed acknowledgement is truthfully reported
  after durable staging. Retrying stages idempotently before acknowledgement.
- Missing/reconfigured relay does not hide retained work. UI errors preserve
  pending requests; owner actions on copied metadata are disabled/read-only.
- The old transport-only refresh/revoke helpers and direct private-form creation/
  publication helpers are removed. Their lifecycle coverage now runs through
  OwnerClient/UI/real worker; retirement itself is tested.
- New ledger-owned stale/expired publication and full cache-loss recovery are now
  connected. Remaining: unfenced cache-only legacy work, source/generation recovery
  where original authority is unavailable, and explicit renewal of a stale local
  revocation that never committed. Never clear unknown work to unblock a new form.

## New F sharing and relay boundary

- `ShareDialog` uses paired worker source proof around the immutable projection
  and explicit reviewed attachments. `presentationSource`, `projectPlaintextV1`,
  `attachmentsForRecord` and `readAttachment` provide no private keys or HTTP.
- `share/owner-custody.ts` and `owner-custody.browser.ts` implement a separate
  trusted-shell IndexedDB CAS vault. Original source/origin, approval, immutable
  ciphertext and owner receipt commit/read back before HTTP. Prepared/invoked/
  published/revoke_pending/revoked transitions preserve original identity.
- Invoked delivery retry reuses the original ciphertext, not a projection of the
  now-changed app. Revocation retains its original timestamp and receipt. Reload
  recovery lists only the original app/generation/lineage and configured origins.
  Conflicting custody is not overwritten; records are bounded, not silently evicted.
- ShareDialog exposes Retry original share/revocation and truthful publication/
  expiry state. A failed delivery survives teardown without minting/reprojecting.
  Unpublished records are not presented as ready links.
- Legacy localStorage share receipt load/replace/revoke helpers are removed.
  Existing records are left untouched and the UI reports legacy unbound custody.
  Safe legacy access/revocation adoption is still required. New stale/expired
  prepared shares use the exact terminal relay protocol; custody is never rebound.
- `relay-owner-configuration.ts` denies unconfigured owner publication. App,
  DataView and IntakeCenter no longer guess a same-origin relay. Account tokens
  are hydrated only at the trusted-shell HTTP boundary and are origin-bound.
- Backend intake/share publication now requires an authenticated owner AND an
  explicitly allowed exact shell Origin, before body allocation. The old no-auth
  local-open intake and nullable-owner share creation are closed. Public recipient
  capabilities retain expiry/revocation semantics. All relay requests reject
  redirects and bounded readers sanitize malformed/error bodies.
- Owned backend fixtures configure a synthetic authenticated account/origin; no
  hosted endpoint, real credential or production value was used. ADR-063 records
  these decisions and the still-open legacy/recovery boundaries.

## E work and the unchanged production blocker

- Retained scheduled commands now inspect original outcome before another ID.
  Failed/cancelled or stale not-invoked commands terminalize first; a racing commit
  is reconciled. Unknown work is never cleared. Scheduling also defers during
  retained intake commands/publication/revocation.
- Real WorkerClient/db-worker automation tests pass with owned memory storage.
  The actual OPFS capability was NOT enabled or relabeled.
- `kernel/src/db.ts` still exposes only test_memory + releaseCertificate:true
  or unavailable. The observer-route and paired UI capability guards stay closed
  on production OPFS. This is a CODE blocker, not just deferred certification.
- Investigated next boundary: strict durable inventory rejects journal/sidecar
  files before normal target open. Lifecycle/restore recovery handles only exact
  job-explained partial files; it is not general SQLite crash recovery.
  Installed sqlite-wasm 3.53.0-build1 SAHPool uses SyncAccessHandle.flush in xSync;
  its xCheckReservedLock returns 1. Verify actual hot/super-journal behavior with
  deterministic VFS faults rather than assuming an ordinary reopen recovers it.
  No production journal/capability implementation is present in this diff.

## A-F development matrix

Routes below are worker commands unless identified as trusted-shell. A-D/E baseline
test references are preserved coverage, not rerun release gates. No row is a
packaged-product certification claim.

| Capability | Route / enabled UI entry | Recovery behavior | Focused test / development state |
| --- | --- | --- | --- |
| A lifecycle/starters/adoption | boot/createApp/seed/switchApp/renameApp/forkApp/deleteApp; App chooser/setup | Exact catalog identity, fenced jobs, physical isolation, replay/adoption | shell worker-lifecycle-integration; preserved |
| A/C first-use/import-as-new | importNewApp/undoNewAppImport; ImportReview | Header review, Preview/Keep/Discard/Undo, original target | shell worker-lifecycle-integration; preserved |
| B safe start over | createApp/seed; App setup | Fresh app, source retained; reset retired | shell start-over-boundary; preserved |
| B authenticated export/Kit/trust | collectArchiveSnapshot/validateBackupStage + shell vault; Recovery Center | Private verifier/Kit custody, series exclusion, legacy intake export denial added | shell worker-restore-integration baseline; kernel intake-archive-boundary |
| B manual download | recordManualBackupDownload/manualBackupDownloadOutcome/validateManualBackupDownload; Recovery Center | Exact-file reauthentication, immutable request, external-save uncertainty | shell worker-manual-download-integration; preserved |
| B folder/automatic/retention | backupSelection/validateBackupStage/publishBackup/backupRecords/backupRetentionPlan/backupRetentionHistory/authorizeBackupRemoval/acknowledgeBackupRemoval; runner/Recovery Center | Per-write permission checks, fenced per-file acknowledgements, fair pages, prior-folder quarantine | shell worker-backup-retention-integration; preserved |
| B authenticated restore-as-new | validateRestoreArchive/restoreAsNew; Recovery Center | Fresh destination, fenced install/partial files, exact receipts; no replacement | shell worker-restore-integration; preserved |
| B row/batch/structure recovery | recoveryCandidates/restoreRow/undoBatch/makeLatest; Recovery Center | Bounded authority recovery | shell worker-daily-relation-integration; preserved |
| C CSV/TSV/XLSX | beginImport/stageImportChunk/configureImport/previewImport/commitImport/cancelImport/undoImport; ImportWizard | Preview/Keep/Discard/Undo, exact 2,000,000-byte input cap | shell release-c-import-coordinator; preserved |
| C relation conversion | previewRelationConversion/convertTextToRelation/undoRelationConversion/mutationOutcome/cancelPresentation; relation dialog | Original Keep/Undo, exact bounded inverse, terminalize before replacement | shell relation-conversion-recovery and real worker; preserved |
| D source/timezone/favorites/recents | dailyPresentation/dailyHomeSourceCompareAndSet/dailyHomeNavigationCompareAndSet/dailyHomeInitializeTimeZone; Today/RecordDetail | Original source/projection/revision/desired-value CAS, reload Retry/Cancel | shell daily-intent/today-view and real worker; preserved |
| D Capture/Undo | dailyHomeResolveDate/dailyHomeQuickCapture/dailyHomeUndoCapture/mutationOutcome/cancelPresentation; CommandPalette | Original producer-bound immutable Undo and receipt | shell quick-capture/presentation-intent and real worker; preserved |
| D Inbox/actions/Undo | dailyPresentation/dailyInboxAction/dailyInboxUndo; Today/Inbox | Closed physical dispositions, item/action/source/projection CAS, local-calendar Snooze, bounded inverse | kernel daily-inbox-authority; shell today-view/real worker; preserved |
| E editor/recipes/custom/preview/enable/pause/delete | automationPresentation/automationCommand/simulateAutomation; AutomationCenter | Lossless retained V2 drafts, timezone and immutable retries | shell automation-retained-ui baseline; OPFS capability BLOCKED |
| E manual/due/history/status/notifications/Undo | same read/command routes + mutationOutcome/cancelPresentation; AutomationCenter/App tick | Original due command terminalization; preserving SAHPool init and pre-SQL journal guard connected, native rollback/capability still not connected | shell automation-tick, worker-automation-integration; kernel sahpool-initialization/sahpool-recovery (owned pinned WASM); OPFS capability BLOCKED |
| F local Print/CSV | projectPlaintextV1/cancelProjectionV1; ExportDialog | Source/egress fences unchanged | shell export-dialog; preserved |
| F encrypted sharing/files/expiry/revoke | presentationSource/projectPlaintextV1/attachmentsForRecord/readAttachment -> trusted-shell vault/relay; ShareDialog | Immutable ciphertext, owner CAS/readback, exact remote tombstones before replacement, explicit fresh preview | shell share-custody/share-terminal/share-owner-ui/share-security-integration and real worker; legacy adoption/source-loss recovery open |
| F intake publication/delivery/review | intakePresentation/intakeCommand/mutationOutcome/cancelPresentation, inner intake.closePublication; IntakeCenter + shell custody/ledger | Permanent publication exclusion, original-custody cache-only recovery, explicitly reviewed bounded stale-revoke AND closure renewal, immutable terminal proof/history, bounded staging/review | shell intake-publication-terminal/intake-revocation-renewal/intake-workflows/intake-ui/worker-intake-integration; private legacy/source-loss remain |
| F auto-accept/receipts/Undo | same closed intake command/read routes; IntakeCenter | Receipt-target-bound simulation/enable, file review required, bounded inverse/history | shell intake-ui/worker-intake-integration; kernel intake/V2 authority |

## Historical finder-loop results on ad6d9db0 (not current-tree certification)

These are selected development packets, not full package/workspace regression.
Package-local command:
`node node_modules/vitest/vitest.mjs run <files> --maxWorkers=1 --minWorkers=1 --reporter=dot`.

| Package / exact final selected files | Actual output |
| --- | --- |
| kernel: test/intake.test.ts test/intake-v2-authority.test.ts test/intake-archive-boundary.test.ts test/sahpool-recovery.test.ts | 4 files / 53 passed; 19.02s |
| shell: test/intake-session.test.ts test/intake-publication.test.ts test/intake-workflows.test.ts test/intake-publication-terminal.test.ts test/intake-revocation-renewal.test.ts test/intake-owner-custody.test.ts test/intake-owner-vault.browser.test.ts test/intake-ui.test.tsx test/automation-tick.test.ts test/production-mutation-route-census.test.ts | 10 files / 88 passed; 11.53s |
| shell: test/worker-intake-integration.test.ts | 1 file / 1 passed; 36.50s (test 33.90s) |
| schema: test/intake.test.ts test/catalog.test.ts test/share.test.ts | 3 files / 15 passed; 1.47s |

- Disjoint final packets: **157 passed in 18 files**. Earlier repeated finder
  packets are not added again. No full suites or release gates were run.
- `node node_modules/typescript/bin/tsc --noEmit` in schema, kernel and shell:
  exit 0, no diagnostics. An intermediate test passed a non-driver adapter to a
  DbDriver-only capability function; that redundant assertion was removed and
  the real production-driver guard test retained. No type error was called a pass.
- RED observations included the absent authority closure, unknown-ID terminal
  time overwrite, missing cache-only revoke adoption method/UI, archive rejection
  of a valid prefixed response, pinned native-WASM mixed commit values and unowned
  native file callbacks. The final packets above include their GREEN regressions.
- The real WorkerClient/db-worker fixture retains the complete committed intake/
  encrypted-share flow and now also loses the owned workflow ledger/cache, adopts
  an original-custody cache-only revoke, explicitly renews stale source after exact
  cancellation, delivers the cancelled original, loses relay acknowledgement,
  reloads, closes a cache-only publication, rejects unknown future save/publish IDs
  and preserves terminal time after authority reopen. No private field enters its
  WorkerClient transport. SQLite/catalog, IDB and backend are owned fixtures.
- The 29 SAHPool tests use the actual installed unmodified browser WASM/VFS with
  owned in-process directory/SyncAccessHandle objects. No host browser/profile,
  OPFS directory, provider HTTP or real credentials were accessed. This is NOT
  physical OPFS certification and grants no production capability.
- Census command exited 0: 19 capabilities; developmentComplete=false; zero scanned
  hardcoded false UI flags; 25 unavailable routes, all explicitly callerless retired;
  OPFS productionBootCaller=false and capabilityGranted=false. The census executes
  no tests/build and writes no release evidence.
- Live HEAD/local origin tracking ref remain ad6d9db0a4ae37cba2953dd572b304c0cf07292b.
  No remote-server readback, Git metadata write, commit/push, installation/download,
  build/budget, browser/accessibility/formal review, deployment or configuration.

## Previous checkpoint finder-loop results (historical, not rerun wholesale)

All tests used package-local
`node node_modules/vitest/vitest.mjs run <files> --maxWorkers=1 --minWorkers=1 --reporter=dot`.
These are targeted development packets, NOT full package/workspace regression.

| Directory / exact selected test files | Real output |
| --- | --- |
| kernel: test/intake.test.ts test/intake-v2-authority.test.ts test/intake-archive-boundary.test.ts | 3 files / 18 passed; 5.30s |
| kernel: test/production-authority.test.ts with -t "routes intake staging" | 1 passed, 68 skipped; 5.01s; NOT the whole file |
| shell: test/intake-session.test.ts test/intake-publication.test.ts test/intake-owner-custody.test.ts test/intake-owner-vault.browser.test.ts test/intake-crypto.test.ts test/intake-ui.test.tsx test/intake-vertical.test.ts test/intake-delivery-boundary.test.ts test/relay-owner-configuration.test.ts test/bounded-relay-response.test.ts test/share-custody.test.ts test/share-owner-ui.test.tsx test/share-client.test.ts test/share-security-integration.test.ts test/automation-tick.test.ts test/production-mutation-route-census.test.ts | 16 files / 79 passed; 12.68s |
| shell: test/worker-intake-integration.test.ts test/worker-automation-integration.test.ts | 2 files / 2 passed; 41.50s |
| schema: test/intake.test.ts test/catalog.test.ts test/share.test.ts | 3 files / 15 passed; 1.25s |
| backend: test/intake-relay.test.ts test/share-relay.test.ts test/relay-publication-authority.test.ts | 3 files / 17 passed; 2.82s |

- Disjoint packets above: 132 passed in 28 files, plus the explicitly filtered
  68 skipped tests. No complete ordinary suite was run.
- `node node_modules/typescript/bin/tsc --noEmit` in schema, kernel, shell and
  backend: exit 0, no diagnostics. Earlier fixture callback/signature errors were
  fixed and checks rerun; they were not reported as passes.
- `node scripts/roadmap-development-census.mjs`: exit 0, 19 capabilities,
  developmentComplete=false, no scanned hardcoded false UI flags, 25 explicitly
  retired unavailable routes. Intended entries cannot name an unavailable route.
  This command executes no tests/build and writes no evidence report.
- RED/GREEN cases include response/custody/relay loss, wrong source/fork, old private
  response refusal, escaped-key/invalid V2 archive denial, erased Undo history,
  owner publication default-deny, stale simulation rebase, hidden retained work
  after config loss, copied-form actions, malformed/foreign delivery pages, ignored
  failed acknowledgement, inconsistent retained publication payloads and obsolete
  compatibility writers. A too-strict first job validator rejected legitimate
  metadata; it was corrected and the real-worker packet rerun.
- Real WorkerClient/db-worker code executes against owned SQLite/catalog fixtures:
  publication + lost response + worker replacement, partial attachments, review/
  reject/manual acceptance, receipt Undo, auto-accept simulation/control/repeated
  execution, local expiry/revocation loss, full authority reopen and readback.
  The same worker projects an accepted record/attachment into an encrypted share,
  publishes/reads/revokes against an owned authenticated backend fixture.
- IndexedDB protocol fixtures exercise the actual vault adapter's transaction/
  readback/abort/reload/CAS behavior; they are NOT physical browser certification.
- No packaged-browser evidence, builds/budgets, full ordinary suites, accessibility,
  formal review, immutable fingerprint or release evidence was produced.

## Previous checkpoint finder-loop results (historical ad6d9db0 baseline)

Package-local commands were used; no dependency download or Corepack cache access
was needed. Test command in each package:
`node node_modules/vitest/vitest.mjs run <files> --maxWorkers=1 --minWorkers=1 --reporter=dot`.

| Directory / exact final selected files | Actual result |
| --- | --- |
| backend: test/intake-relay.test.ts test/share-relay.test.ts test/relay-publication-authority.test.ts test/relay-terminal.test.ts test/share-postgres.test.ts test/intake-terminal-postgres.test.ts | 6 files / 34 passed; 4.32s |
| schema: test/intake.test.ts test/catalog.test.ts test/share.test.ts | 3 files / 15 passed; 1.33s |
| kernel: test/intake.test.ts test/intake-v2-authority.test.ts test/intake-archive-boundary.test.ts | 3 files / 18 passed; 5.39s |
| shell: test/intake-session.test.ts test/intake-publication.test.ts test/intake-workflows.test.ts test/intake-publication-terminal.test.ts test/intake-owner-custody.test.ts test/intake-owner-vault.browser.test.ts test/intake-ui.test.tsx test/intake-delivery-boundary.test.ts test/relay-owner-configuration.test.ts test/share-custody.test.ts test/share-terminal.test.ts test/share-owner-ui.test.tsx test/share-recipient-ui.test.tsx test/share-client.test.ts test/share-security-integration.test.ts test/automation-tick.test.ts test/production-mutation-route-census.test.ts | 17 files / 96 passed; 16.30s |
| shell: test/worker-intake-integration.test.ts | 1 file / 1 passed; 29.99s |

- Disjoint final packets: 164 passed in 30 files. Repeated finder runs above are
  not counted again. This is NOT a full package/workspace regression campaign.
- Final UI/ledger recovery-error recheck: test/intake-ui.test.tsx plus
  test/intake-workflows.test.ts, 2 files / 16 passed; 3.34s. A cached read cannot
  erase a failed durable-recovery prerequisite in the UI. These tests overlap
  the selected shell packet and are not added to the disjoint total.
- Real WorkerClient/db-worker fixture now additionally loses the entire owned
  presentation cache during publication/revocation, changes the source while a
  publication is retained, terminally cancels its exact original request, rejects
  that delayed original WorkerClient invocation, and reopens the durable public
  metadata. Original draft, private custody, data, attachments and receipt Undo
  paths are preserved. Actual browser OPFS is not substituted by this fixture.
- Earlier worker finder runs failed on a test helper excluding base32 digits from
  authenticated terminal paths, then on the old /uncertain/ error assertion after
  the new /unconfirmed/ response. Both were fixed; the final worker run passed.
- TypeScript: `node node_modules/typescript/bin/tsc --noEmit` in schema, kernel,
  shell and backend exited 0. Intermediate errors from missing new test-double
  methods and a widened test parameter were fixed, not described as passing.
- `git diff --check`: exit 0. No commit/push, network deployment, browser/profile,
  production value, evidence artifact, bundle limit or Git metadata was touched.
- Census remains a read-only inventory: developmentComplete=false. It executes
  no tests/build and generates no release report. The command exited 0.

## Historical exact continuation from 6dc0e3f4 (superseded)

1. Verify live status/HEAD and preserve the entire diff or Hermes-saved checkpoint
   on 6dc0e3f4bf40cf8dc20a6be7509fd684280f4411. One writer, D:\Clay only; no
   commits/pushes/downloads/production actions. Continue finder loops, not certification.

2. Finish the remaining F owner-recovery edges, not the completed cache-only V2
   protocol again. Existing original-custody cache-only publication/revoke recovery
   and stale local-revoke AND authority-closure renewal have UI/worker/fault coverage.
   Preserve the reviewed prior request ID, immutable chains/receipts, exact physical
   ledger adoption cross-check and original termination on cache-only re-adoption.
   Never replace
   their exact tombstone/cancellation protocols with absence or a cache marker.
   - Original app/generation loss or missing original custody remains quarantined.
     It requires a narrow catalog/owner-history proof, not assignment to another
     selected app or minting replacement keys. A missing app is not proof that a
     delayed original request or HTTP publication cannot arrive.
   - Local publication closure intentionally leaves active forms active. Revoke
     explicitly, then finish closure. Cache-only revoke adoption also does not mean
     completion until local terminal metadata and exact relay proof read back.

3. Implement safe private legacy intake/historical response and old sharing receipt
   adoption in trusted shell. This is still unimplemented, not a configuration gate.
   - Never inspect real values, strip/delete original rows/responses, archive private
     material, rebind a fork/restore, or pass private values through WorkerClient.
     Use synthetic fixtures. Current quarantine/export denial must remain.
   - LocalIntakeFormV1 lacks original ownerSource. Old OwnerShareReceiptV1 contains
     no app/generation/lineage; its projection scope contains semantic IDs, which a
     fork copies. Neither key/URL possession nor a matching table proves original
     authority. First establish a narrow original catalog/history/owner proof and
     custody commit/readback protocol; ordinary private-form routes stay retired.
   - Exact next investigation/code boundary: `production-request-journal.ts` has
     metadata-only `parseProductionRequestReceiptRow` and source/operation/request/
     response hashes mirrored into catalog. `readProductionRequestReceipt`, however,
     uses SELECT * and selects response_json; it must NOT become an ordinary legacy
     worker read. `productionOperationIdV2` anchors a route to authority incarnation
     and request; V1 operation IDs do not anchor a route. Investigate a narrow public
     original-owner witness using closed catalog + original target/history/receipt
     evidence, before any sealed trusted-shell custody transfer. Validate historical
     response bytes without exposing private values or changing their identity.
     No such witness/transfer/adoption implementation was added this turn.
   - `share/owner-receipts.ts` confirms the legacy receipt has no source proof.
     `ShareOwnerSession` V2 records do have an original target but this cannot be
     inferred for an old receipt using matching semantic scope or possession. Where
     original evidence genuinely does not exist, retain quarantine explicitly. Do
     not turn a synthetic positive fixture into authority for arbitrary old data.
   - Existing prefixed public response envelopes now export correctly; malformed
     or private historical envelopes still fail before values are selected. Do not
     change old response IDs/bytes to make them public or weaken format 5.
   - Cover synthetic state/responses/archives, lost custody commits, wrong-source
     copies, teardown/reload and create/fork/delete/restore-as-new ownership. Copied
     metadata must not acquire original vault authority.

4. Integrate real production physical transaction/recovery capability. Preserving
   initialization IS connected to db.ts; the native recovery adapter is NOT.
   Automation production capability remains unavailable, not merely uncertified.
   - Read sahpool-journal-recovery.ts and its actual pinned-WASM owned-file fault
     tests. They are not memory DbDriver substitutes, but also not a physical browser
     certificate. All callback correction is scoped; do not make xCheckReservedLock
     globally return 0. Keep native side-path rejection and poison/reopen behavior.
   - Exact next architectural boundary: establish original catalog-proven ownership
     of an unopened recovery tuple under physical exclusion BEFORE first durable
     catalog read/rollback. A hot catalog creates a proof-order dependency. A tuple
     assembled solely from filenames or super-journal members is not owner proof.
     A separately validated shadow/preflight recovery may be needed; no such proof
     implementation exists yet. Do not silently recover an unadopted legacy app.
   - Preserve `sahpool-initialization.ts`: original `.opfs-sahpool/.opaque` handles
     acquired/validated before SDK code, exact entry readback, same handles handed
     off, original storage method restored, pre-existing VFS rejected, destructive
     SDK cleanup denied. `assertPreservedSahpoolHandles` is only handle provenance,
     not catalog ownership or a native rollback grant. Do not replace this with
     a preflight which closes/reacquires handles, nor use a post-init empty adapter
     tracking map as proof that older handles never existed.
   - Important extra recovery case found: SAHPool setAssociatedPath clears and
     flushes the association BEFORE truncating its old payload, with no separate
     post-truncate flush. A crash can leave a valid empty header plus retained bytes.
     Startup now preserves/rejects that slot; it does NOT hand it to SDK reuse.
     Its missing name is not proof that the bytes are disposable. Define durable
     owned unlink/association proof or quarantine that excludes reuse without data
     loss. Include flush-only and write-through faults; do not silently discard it.
   - bootBrowser currently runs catalog-retention migration and restore recovery
     before normal strict inventory, then lifecycle recovery. Resolve hot/super-
     journals BEFORE those paths can read/write partial state, while preserving exact
     job-fenced partial-file recovery. Re-run strict catalog/canonical/Merkle/target
     classification for every active target after native recovery. Do not create or
     unlink unexplained files, acknowledge uncertain cleanup, or publish partial data.
   - `openBrowserCatalogProbe` and `openBrowserProductionTarget` currently fail
     before SQL if a relevant journal/WAL/SHM or any super-journal is present. Do
     not remove this barrier to get a green boot. Supply an unforgeable coordinator
     grant only after original ownership is proven; native rollback then reclassifies.
   - Existing sahpool-initialization tests now run actual ProductionStoreAuthority
     clean boot/reopen and real user/system/catalog commit interruption. They prove
     no pre-proof page reads or writes on failed reopen, NOT successful recovery.
     Extend with deterministic successful native/canonical recovery and lifecycle/
     restore partial publication faults around the new coordinator. Only then grant
     a genuine runtime capability and wire observer/paired availability.
     Preserve scheduler reconciliation/intake deferral.

5. Update inventory/handoff. Once all A-F source/UI/custody/recovery boundaries really
   exist, stop for the single integrated testing campaign. No full regression,
   build/budget, browser/accessibility or formal-review campaign in development.

Remaining blockers are CODE: private legacy owner adoption and original-source
recovery in F; catalog-proven production OPFS recovery and
capability in E. No verified host blocker. This checkpoint is not development-
complete, certified, P0 shipped or roadmap shipped.

## Changed-file scope

Use `git status --short --untracked-files=all` for the exact current path list.
This continuation leaves one coherent source/test/documentation diff:
kernel/schema/shell code and focused tests plus inventory and ADR/handoff documents.
Use live Git status for any subsequent externally saved checkpoint.

- Kernel: production preserving SAHPool initializer/pre-SQL journal gate, owned
  native-WASM initializer/handle/boot/commit faults; existing native recovery adapter
  stays unconnected. No production capability grant.
- Schema: bounded closure-renewal chain and immutable terminal proof validation.
  No new private transport or archive version change.
- Shell: IntakeCenter reviewed closure renewal, retained original closure history,
  adoption readback validation, protocol/UI/real-worker regressions. Sharing/backend,
  scheduler and A-D sources are preserved; no hosted configuration changes.
- Inventory/specification: census, this handoff, ADR-067.
- No dependency/lockfile, production configuration, generated release artifact,
  evidence report or Git metadata changes.
