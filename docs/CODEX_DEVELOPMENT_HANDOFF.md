# A-F development continuation - 2026-09-13

Source-development checkpoint only. Development is NOT complete; no certification
or shipping claim. Continue from Exact continuation. Do not start the integrated
regression/build/budget/browser/accessibility/review campaign yet.

## Workspace and preserved baseline

- Sole writer in `D:\Clay`, branch `codex/clay-project`.
- Clean starting HEAD and local origin tracking ref, rechecked after development:
  `0d1ecc2ad6d214dbe759b92285da200867653762`.
- One uncommitted source/test/documentation diff. No Git metadata writes, commits,
  pushes, fetches or remote-server readback. Hermes may preserve this checkpoint.
- A/P0, authenticated export/restore, manual-download recovery, durable retention,
  relation Keep/Undo, Daily CAS and stale Keep/Capture cancellation are preserved.
  Their prior implementation detail is in this handoff at the starting commit.
- No other checkout, dependency installation/download, production configuration,
  deployment, server start/stop, external browser attachment or user storage was
  touched. Reserved ports stayed untouched. No credentials were inspected.
- Package-local Node/Vitest/TypeScript binaries work. No new infrastructure blocker.
- No build artifact, browser evidence, certification report or review fingerprint
  was generated. Historical red/invalidated certification remains deferred.

## Implemented in this continuation

### C/D: original-source presentation recovery

- Capture Undo now carries the original capture request/payload, batch, app,
  generation, lineage and exact original result target. Authority verifies the
  producer hash, mirrored receipt, reservation/operation identity, semantic table,
  bounded capture ledger and unchanged canonical state before the inverse.
- Persist immutable Undo before success callbacks. Session-storage presentation
  intents survive modal teardown/full reload; they never mint durable app identity.
  Wrong-app, forked, rebound or intervening-write use rejects. Historical outcome
  acknowledgement is not another invocation.
- Capture and relation dialogs retain uncertain Undo. Keep/Keep linked records
  first terminalizes the original Undo through authority. Cancellation is an
  explicitly enumerated contract, not an arbitrary-route escape hatch.
- `dailyPresentation` pairs a trusted projection with its authority target and
  source/navigation readback. Source and navigation CAS carry that original target,
  projection basis/digest, semantic IDs, original revision and immutable desired
  value through WorkerClient/db-worker/authority. Retry cannot retoggle a favorite
  or rebase a reviewed request. Today exposes Retry/Cancel for retained work.
- RecordDetail recents and first-use progress defer during retained presentation
  work so opening a freshly captured record does not consume its Undo window.
- ADR-060 documents these choices and the bounded closed cancellation expansion.

### D: physical Daily Inbox actions and Undo

- New optional `sys.inbox_dispositions` uses exact closed DDL and rows with source
  key/generation, globally monotonic revision token, request identity and a strict
  active/snoozed/dismissed disposition. Snooze binds local date, stored IANA zone
  and resolved UTC midnight. It is not a generic setting or copied task queue.
- No read or boot creates the table. First authorized mutation creates it inside
  the journaled transaction. Pre-D2 absent-table canonical fingerprints remain
  unchanged. Every physical row, schema object and cardinality is validated.
- Canonical state, shadow/database copy, snapshot/open and format-5 authenticated
  archive participation include the optional table. Extra DDL, malformed rows,
  duplicated tokens and inconsistent local dates fail closed.
- `dailyInboxAction` / `dailyInboxUndo` call authority `daily.inbox` /
  `daily.undoInbox`. Whole reviewed item/action/projection/source CAS is required.
  Complete updates only an explicitly bound completion field; Dismiss only changes
  presentation. Snooze accepts a reviewed date 1..30 local days ahead with DST.
- Undo binds the exact original action receipt and current result target; record
  effects and disposition are reverted together, with a new monotonic tombstone
  token. Any intervening canonical write closes the bounded inverse.
- Disposition filtering occurs before paging. Time-only expiry invalidates the
  projection. Fixed equal-timestamp source sorting to use the shared canonical
  comparator rather than a conflicting row-ID tie break.
- Today/Inbox toggle, Complete/Snooze/Dismiss, immutable Retry/Cancel and Undo/Keep
  are wired. Copy describes local source coverage, not off-device execution.
- Focused real worker tests cover lost responses/reload; authenticated create/fork/
  delete/restore-as-new roundtrip retains the disposition table and source data.
  These are owned memory/directory fixtures, NOT physical browser certification.

### E: retained automation workspace and real worker commands

- New `automationPresentation` returns paired source, actual adapter availability,
  rules, recipes, semantic trace, history, notifications and runtime facts.
- New `automationCommand` wraps exactly nine existing writers in an immutable
  original-target envelope: saveDraft, saveRecipeDraft, enable, pause, delete,
  runNow, runDue, undoRun and markNotificationRead. Full input limits, shadow/live
  journal, request identity, fencing and existing physical transaction guard remain.
  Unknown V2 draft fields reject before normalizers can silently discard them.
- AutomationCenter retains custom/recipe/legacy-review/full-V2 workspaces and
  immutable requests through remount/reload. The full V2 editor preserves all
  conditions/actions/value sources/runtime/recipe metadata. Semantic recipe option
  identity is retained instead of relying on array position.
- Per-rule IANA timezone includes due-date recipes. Save yields a disabled draft,
  simulation is reviewed before enable, manual Run now previews/asks confirmation,
  and delete confirms. Edit/pause/history/status/read notifications/Undo are wired.
  Recovery reads the original outcome before retry; cancellation precedes replacement.
- Local due polling retains its request before invocation and reconciles a lost
  worker response. It defers for user review/Undo/drafts, does not create receipts
  for an empty ruleset, and never claims off-device execution.
- Hardcoded automation feature-off props are removed. UI availability instead uses
  the REAL storage prerequisite, with no false Saving label when unavailable.
- IMPORTANT CODE BOUNDARY: current `db.ts` capability union has only
  `test_memory + releaseCertificate:true` or unavailable. Actual OPFS has no
  supported production automation transaction capability and stays closed.
  An owned-memory worker success is NOT a production certificate. E is conditional,
  not development-complete on OPFS. Do not bypass this guard. See ADR-061.

### F: tested custody foundation only, NOT migrated intake

- New strict `LocalIntakeFormV2` contains public definition metadata and original
  owner app/generation/lineage, but no owner-private, owner-token or submit-token
  fields. Public encrypted-delivery transport V1 remains unchanged.
- New trusted-shell IndexedDB vault binds material to shell origin, original source,
  relay origin, retained form ID and exact public definition. Commit/readback must
  succeed before returning metadata; ambiguous commit retry reads the original
  identity without replacing key material. Conflicts preserve the first record.
- Capture reviewed metadata synchronously before async custody work. Key-pair
  possession is verified before capabilities are returned; probe bytes are cleared.
  Parser failures are sanitized. Tests do not print generated capabilities.
- Owned transaction-serialized IndexedDB protocol tests cover commit abort, adapter
  reload, exact replay, conflict preservation and late successful open cleanup.
  No host IndexedDB, private user record or production configuration was accessed.
- IMPORTANT: `kernel/intake.ts`, Store, WorkerClient, `intake/client.ts` and
  IntakeCenter STILL use legacy LocalIntakeFormV1. The new custody foundation has
  no production UI caller. Legacy app state and historical receipts may contain
  private material; no destructive schema substitution or silent stripping occurred.
- Sharing source/custody/UI/configuration reconciliation and intake publication/
  delivery/review/auto-accept/Undo migration remain required. See ADR-062.

## A-F development matrix

These are development inventory entries, not packaged-product or certification
claims. Routes are worker commands unless marked trusted-shell. Baseline tests
are preserved references, not newly run passes.

| Capability | Production route / UI entry | Recovery behavior | Focused test / state |
| --- | --- | --- | --- |
| A lifecycle/starters/legacy adoption | boot/createApp/seed/switchApp/renameApp/forkApp/deleteApp; App chooser/setup | Existing fenced jobs, exact receipts, isolated physical targets, adoption | shell worker-lifecycle-integration; preserved |
| A/C first-use/import-as-new | importNewApp/undoNewAppImport; ImportReview | Header review, Preview/Keep/Discard/Undo, one first-use target | shell worker-lifecycle-integration; preserved |
| B safe start over | createApp/seed; App setup | Fresh app, originals retained; reset retired | shell start-over-boundary; preserved |
| B authenticated export/Kit/trust | collectArchiveSnapshot/validateBackupStage + shell vault; Recovery Center | Private verifier, keys/Kit outside worker, series activation exclusion | shell worker-restore-integration baseline; worker-manual-download-integration rerun |
| B manual download | recordManualBackupDownload/manualBackupDownloadOutcome/validateManualBackupDownload; Recovery Center | Per-app immutable intent, exact-file reauthentication, external save unverified | shell worker-manual-download-integration; preserved/rerun |
| B folder/automatic/retention | backupSelection/validateBackupStage/publishBackup/backupRecords/backupRetentionPlan/backupRetentionHistory/authorizeBackupRemoval/acknowledgeBackupRemoval; runner/Recovery Center | Immediate permission revalidation, durable per-file fences/receipts, fair pages, original-folder quarantine/retry | shell worker-backup-retention-integration baseline; no retention code changed |
| B authenticated restore-as-new | validateRestoreArchive/restoreAsNew; Recovery Center | Fresh destination/fenced jobs/partial-file recovery; source untouched | shell worker-restore-integration baseline; multi-app/disposition roundtrip in worker-manual-download-integration |
| B row/batch/structure recovery | recoveryCandidates/restoreRow/undoBatch/makeLatest; Recovery Center | Existing bounded authority recovery | shell worker-daily-relation-integration |
| C CSV/TSV/XLSX | beginImport/stageImportChunk/configureImport/previewImport/commitImport/cancelImport/undoImport; ImportWizard | Preview/Keep/Discard/Undo and exactly 2,000,000-byte production input cap preserved | shell release-c-import-coordinator baseline |
| C relation conversion | previewRelationConversion/convertTextToRelation/undoRelationConversion/mutationOutcome/cancelPresentation; relation dialog | Retained original Keep/Undo; bounded inverse; terminalize before correction or forgetting Undo | kernel production-roadmap-mutations; shell relation-conversion-recovery and real worker |
| D source/timezone/favorites/recents | dailyPresentation/dailyHomeSourceCompareAndSet/dailyHomeNavigationCompareAndSet/dailyHomeInitializeTimeZone; Today/RecordDetail | Exact source/projection/revision/value CAS, immutable reload retry/cancel, no retoggle/rebase | shell daily-intent/today-view/record-detail-error and real worker |
| D Capture/Undo | dailyHomeResolveDate/dailyHomeQuickCapture/dailyHomeUndoCapture/mutationOutcome/cancelPresentation; CommandPalette | Persist original producer-bound Undo before presentation; unknown retained; exact bounded inverse | shell quick-capture/presentation-intent and real worker; kernel production-roadmap-mutations |
| D Inbox/Complete/Snooze/Dismiss/Undo | dailyPresentation/dailyInboxAction/dailyInboxUndo; Today/Inbox | Closed physical dispositions, item/action/source/projection CAS, local-day Snooze, original result-bound inverse | kernel daily-inbox-authority/inbox-dispositions; shell today-view and real worker/archive |
| E recipe/custom/edit/preview/enable/pause/delete | automationPresentation/automationCommand/simulateAutomation; AutomationCenter | Lossless retained V2/recipe workspaces, timezone, disabled draft/simulation, original request/outcome/cancel | shell automation-retained-ui/automation-release-e-ui and real worker; OPFS capability BLOCKED |
| E manual/due/history/status/notifications/Undo | same closed command/read routes; AutomationCenter/App tick | Manual preview/confirm, retained due requests, exact effects/receipts/Undo, deferred local scheduler | shell worker-automation-integration/automation-tick; kernel production-authority-automation; OPFS capability BLOCKED |
| F Print/CSV | projectPlaintextV1/cancelProjectionV1; ExportDialog | Source/egress fences preserved | shell export-dialog baseline |
| F encrypted sharing/attachments/expiry/revoke | projection -> shell/backend; ShareDialog/App | Immutable encryption/custody/source/configuration reconciliation remains | shell share-security-integration baseline; incomplete |
| F intake lifecycle/delivery/review | existing intake worker routes; IntakeCenter | Legacy custody migration and immutable delivery/staging/accept/reject recovery remain | shell intake-vertical/intake-ui baseline; new custody tests are foundation ONLY |
| F intake auto-accept/receipts/Undo | simulateIntakeAutoAccept/enableIntakeAutoAccept/disableIntakeAutoAccept/processIntakeAutoAccept/intakeReceipts/undoIntakeReceipt; IntakeCenter | Simulation/control and bounded inverse must join the migrated source-bound journey | existing authority baseline; incomplete |

## Actual finder-loop results

All tests used package-local
`node node_modules/vitest/vitest.mjs run <files> --maxWorkers=1 --minWorkers=1 --reporter=dot`.
These packets are development feedback, NOT full package/workspace regression.

| Working directory / exact test files | Real result |
| --- | --- |
| kernel: test/daily-inbox-authority.test.ts test/daily-home-projection.test.ts test/production-roadmap-mutations.test.ts test/inbox-dispositions.test.ts | 4 files / 26 passed; 41.11s |
| kernel: test/production-authority-automation.test.ts | 1 file / 27 passed; 44.41s |
| shell: test/quick-capture.test.tsx test/relation-conversion-recovery.test.tsx test/presentation-intent.test.ts test/today-view.test.tsx test/today-wiring.test.ts test/record-detail-error.test.tsx test/daily-intent.test.ts test/automation-enable.test.tsx test/automation-release-e-ui.test.tsx test/automation-retained-ui.test.tsx test/automation-presentation.test.ts test/automation-tick.test.ts test/intake-owner-custody.test.ts test/intake-owner-vault.browser.test.ts test/production-mutation-route-census.test.ts | 15 files / 68 passed; 15.00s |
| shell: test/worker-daily-relation-integration.test.ts test/worker-manual-download-integration.test.ts test/worker-automation-integration.test.ts | 3 files / 3 passed; 52.74s |
| schema: test/daily-home.test.ts test/intake.test.ts | 2 files / 16 passed; 942ms |

- Disjoint final packets above: 140 passed in 25 files.
- `node node_modules/typescript/bin/tsc --noEmit` in schema, kernel and shell:
  each exited 0 with no diagnostics after executable changes; shell was rerun
  after the final census scanner test change. No build was substituted.
- `node scripts/roadmap-development-census.mjs`: exited 0; 19 capabilities,
  developmentComplete=false, no hardcoded false UI flags, ten explicitly retired
  unavailable compatibility routes, E/F code boundaries listed. No tests/build run.
- `git diff --check`: exited 0 at handoff, including the documentation diff.
- RED cases included unbound Capture Undo, forgotten ambiguous Undo, incidental
  recents consuming Undo, unbound source CAS, missing Inbox and automation routes,
  equal-timestamp projection ordering, silent unknown-action-field loss, false recipe
  Saving status, mutable async custody metadata and mismatched owner key custody.
- The route census initially failed because its scanner missed delegated physical
  Inbox writes. Its explicit external-writer inventory and regression now include
  that writer, not a removed authority classification. The focused packet reran green.
- Fixture/import errors (including missing current_version in a physical tamper
  fixture and a schema import cycle) were fixed; failing runs were not relabeled
  as passing gates.
- Actual WorkerClient/db-worker/SQLite/catalog/private-verifier code runs against
  owned memory files/directory maps. Coverage includes lost response/worker replacement,
  original request reconciliation, isolation, lease expiry, due-run deduplication,
  and authenticated multi-app/disposition archive restore-as-new.
- No packaged browser evidence path exists for this continuation. Full suites,
  builds/budgets, browser matrices, axe/NVDA and reviews were deliberately NOT run.

## Exact continuation

1. Re-read live status/HEAD and this handoff in D:\Clay. Preserve this diff or the
   externally saved checkpoint. One writer; no commits/pushes/downloads/production
   actions. Do not restart completed Capture Undo, Inbox or basic E editor work.
2. Next substantive code boundary is F intake production migration:
   - The candidate contracts are LocalIntakeFormV2 / IntakeFormDefinitionV1 in
     schema/intake.ts. Shell-only custody is intake/owner-custody.ts and
     intake/owner-custody.browser.ts, with seven owned-fixture tests.
   - Legacy kernel/intake.ts still parses LocalIntakeFormV1 inside intake_v1;
     Store.saveIntakeForm/listIntakeForms and worker/client/UI still transport it.
     Switch new writes/readback to secret-free metadata with original source and
     explicit immutable request context. Do not just alias V1 to V2 and brick data.
   - Design/test safe handling of existing secret-bearing state AND historical
     request responses. Never inspect real material, silently strip fields, delete
     archives, rebind a fork, or copy a private capability into an ordinary worker
     payload, app setting, archive, diagnostic or test failure output.
     Custody must commit/read back before publication; a lost commit resumes the
     same retained form ID. Legacy bytes remain untouched in this checkpoint.
   - Wire intake/client.ts and IntakeCenter to hydrate only inside trusted shell
     for HTTP/decryption; carry no keys/tokens through WorkerClient. Bind original
     owner app/generation/lineage and shell/relay origins; existing source freshness,
     semantic IDs, preview, payload limits and default-denied config remain.
   - Add real WorkerClient/db-worker coverage for publication/delivery loss,
     staged/partial attachments, expiry/revocation, review/accept/reject,
     auto-accept simulation/control/receipts/Undo and teardown/reload. Existing
     IntakeCenter and client calls still mint implicit contexts; new custody is not
     yet their runtime path. The owned vault fixture is NOT browser certification.
3. Finish F sharing: source-bound immutable encrypted projection/attachments,
   owner custody and retained immutable create/revoke/delivery intents, expiry,
   local error/retry UX and origin-bound default-denied configuration. Existing
   ShareDialog/owner-receipts/relay paths need reconciliation. No real hosted
   credentials, production values, deployment or provider HTTP in worker/panels.
4. Finish the E production physical capability implementation after F source work,
   not by weakening the guard. Current db.ts supports only test_memory/unavailable.
   Locate production crash-safe transaction and recovery prerequisites, implement
   them with deterministic faults, and keep final physical certification deferred.
   A successful memory fixture or a new label cannot authorize OPFS automation.
   Retained scheduled commands must be reconciled/cancelled before another ID.
5. Update census/handoff as inventory. Only when every intended A-F control, route,
   durable readback and recovery path is actually implemented start the single
   integrated regression/build/budget/browser/accessibility/security/product
   campaign. Do not raise limits. NVDA requires a human; real hosted configuration
   and deployment are separate external gates.

Remaining development blockers: E production physical transaction capability and
F legacy custody/source/UI integration. No verified host blocker. This continuation
does not claim development-complete, P0 shipped, or the full roadmap shipped.

## Changed-file scope

- Kernel: production coordinator/authority/core/Daily/relation routes, new original
  presentation proof and paired Daily read, new physical Inbox/storage/action
  modules, canonical/database copy/Store integration, closed automation input,
  recipe timezone and canonical projection ordering.
- Schema: catalog presentation/command/workspace contracts, Daily Inbox schemas
  and intake V2 metadata candidate.
- Shell: App/Today/RecordDetail/DataView, Capture/relation recovery, AutomationCenter,
  retained Daily/automation intents and scheduler, WorkerClient/db-worker/route census,
  new trusted-shell intake owner custody/vault.
- Tests: focused schema-referenced/kernel/shell packets above; new owned worker
  automation journey and UI fixture. Use live git status for the exact file list.
- Inventory/specs: this handoff, roadmap-development-census, ADR-060/061/062 and
  the physical Inbox data-model section. No dependency, production configuration,
  generated release artifact or evidence changes.
