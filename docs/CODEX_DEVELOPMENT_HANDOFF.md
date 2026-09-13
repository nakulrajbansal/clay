# A-F development continuation - 2026-09-13

Source-development checkpoint only. Development is NOT complete; no release,
certification or shipping claim. Continue from Exact continuation. Do not start
the full regression/build/budget/browser/accessibility/review campaign yet.

## Workspace and preserved baseline

- Sole writer in `D:\Clay`, branch `codex/clay-project`.
- Starting clean HEAD and local origin tracking ref, rechecked after development:
  `88f959568f0adfa3b20a873f580999759dc5c293`.
- One uncommitted source/test/documentation diff. No Git metadata writes, commits,
  pushes, fetches, or remote-server readback. Prior handoff is in the starting commit.
- Preserve committed A/P0 lifecycle, first-use/import/header review/legacy adoption,
  authenticated export/restore, manual-download recovery, relation Keep/Undo,
  Capture intents, Daily CAS, backup retry/trust-lock and multi-app archive work.
- No other checkout, dependency installation/download, production configuration,
  deployment, server start/stop, external browser attachment or user storage was
  touched. Reserved ports stayed untouched. No credentials were inspected.
- Package-local Node/Vitest/TypeScript work. No new infrastructure blocker.
- Historical red/invalidated certification and budgets remain deferred. No new
  build artifact, browser evidence, certification report or review fingerprint.

## Implemented in this continuation

### B: durable per-file retention and recovery

- Closed catalog `backup_retention_root` / `backup_retention_events` tables retain
  each exact request/operation/hash, victim/keeper, planning revision, catalog
  generation, lease and observed `absent` or `failed` outcome. Publication JSON
  stays immutable. Retention has its own contiguous revision; acknowledgement
  does not change app canonical state, selected identity or catalog generation.
- `backupRetentionPlan`, `backupRetentionHistory`, `authorizeBackupRemoval` and
  `acknowledgeBackupRemoval` traverse WorkerClient/db-worker/production authority.
  Both effect authorization and acknowledgement check the current fence. Archived
  receipts must match the known lease at their catalog generation, not any old lease.
- Protect newest 32 publications per exact app/folder/certification scope. Pages
  contain at most 64 outstanding files. Failed attempts move behind untouched/older
  attempts; acknowledged absence leaves the queue and cannot starve older work.
- Trusted-shell retention stores immutable retry metadata before unlink, verifies
  exact keeper/victim bytes, refreshes authority and uses the adapter's immediately
  revalidated permission. Missing differs from denied/unreachable. Replaced bytes
  are kept. Interrupted unlink and lost acknowledgement reconcile the same request
  before another removal; inspected buffers are cleared.
- Removed the external runner's direct-delete loop. Publication rotation hints
  alone cannot authorize deletion. Production uses the fenced per-file runner;
  candidate completion waits for the page/backlog outcome. Unknown results retain
  retry metadata and do not claim that files were kept.
- Durable history derives work independently of the vault candidate cache.
  Folder/source switches keep old work and separate original folder hints/handles.
  Recovery Center inventories all-app retention, offers exact prior-folder retry,
  or shows quarantined work when the original capability is unavailable. App data
  remains usable. Current file availability is explicitly not continuously monitored;
  history distinguishes publication validation, acknowledged absence and failures.
- Atomic additive boot migration accepts only exact known physical catalog
  schemas/relationships under worker authority and lifecycle exclusion. Interrupted
  DDL rolls back. Logical app snapshot, selection and publications are unchanged.
- Archive catalog evidence schema 3 carries closed retention history and exact new
  schema objects. Evidence 1/2 stays readable with exact legacy schema objects.
  Format-5 authentication, authentication-before-ZIP and restore-as-new are unchanged.
  Missing/rebound retention evidence is rejected.
- Combined real WorkerClient/db-worker plus owned-directory coverage now exercises
  lease expiry, staged/partial files, trust-commit failure after publication,
  folder/source switches, removal faults, lost acknowledgement and reload. It is
  not physical browser/File System Access certification.

### C/D: terminal cancellation before correcting stale requests

- New `cancelPresentation` uses the original immutable Capture or conversion Keep
  payload/request ID and explicit mutation context. It serializes against invocation,
  checks original app/current canonical authority and persists a mirrored no-op
  cancellation receipt before the UI can replace the intent.
- A delayed invocation of that cancelled ID is permanently rejected. A winning
  commit is acknowledged, never cancelled. Failed requests are replaceable only
  after exact mirrored abandoned reservations prove no effects. Prepared/invoked
  or poisoned/ambiguous outcomes remain closed for recovery.
- `mutationOutcome` has closed `cancelled` and `failed` outcomes. Historical
  acknowledgement remains read-only. Lost cancellation responses retain the same
  request; modal teardown/reload never mints a substitute automatically.
- CommandPalette exposes pending Capture cancellation/correction; relation setup
  exposes pending Keep cancellation/re-preview. Neither unlocks after uncertainty
  or a winning commit.
- No-op receipts now retain operation IDs, fixing an archive failure exposed by
  cancellation. Guarded migration repairs exact parsed legacy no-op identity
  accounting without rewriting receipts or app state. No archive check was relaxed.
- Capture Undo invocation persistence and full source/navigation recovery are NOT
  finished. ADR-058/059 record the development decisions and remaining boundaries.

## A-F development matrix

Commands are DB-worker routes unless marked trusted-shell. Baseline rows are
preserved source, not fresh test-pass or packaged-product claims. Tests are
package-local under `test/`; executed packets are listed separately below.

| Capability | Production route / UI | Recovery / boundary | Focused test / state |
| --- | --- | --- | --- |
| A: lifecycle/starters/legacy adoption | `boot`, `createApp`, `seed`, `switchApp`, `renameApp`, `forkApp`, `deleteApp`; App/setup/chooser | Existing fenced jobs, exact receipts, isolated storage, adoption | shell `worker-lifecycle-integration.test.ts` baseline; archive roundtrip below rerun |
| A/C: first-use/import-as-new | `importNewApp`, `undoNewAppImport`; ImportReview | Header choice, Preview/Keep/Discard/Undo, one-target first use preserved | shell `worker-lifecycle-integration.test.ts` baseline |
| B: safe start over | `createApp` / `seed`; App setup | Fresh app, prior apps retained; reset retired | shell `start-over-boundary.test.ts` baseline |
| B: export/Kit enrollment/import/activation | `collectArchiveSnapshot`, `validateBackupStage`; trusted-shell vault/Recovery Center | Private verifier, keys/Kit outside worker, active-series exclusion | shell `worker-restore-integration.test.ts`, `worker-manual-download-integration.test.ts`; connected |
| B: manual download recovery | `recordManualBackupDownload`, `manualBackupDownloads`, `manualBackupDownloadOutcome`, `validateManualBackupDownload`; Recovery Center | Immutable per-app intent, exact-file reauthentication; external save unverified | shell `worker-manual-download-integration.test.ts`, `recovery-center.test.tsx`; connected |
| B: folder/automatic publication | Trusted-shell prepare/complete/retire; `backupSelection`, `validateBackupStage`, `publishBackup`, `backupRecords`; folder/trigger | Immediate permission check, immutable retry, partial files kept, trust recovery | shell `worker-backup-retention-integration.test.ts`, `backup-target.browser.test.ts`; connected |
| B: retention | `backupRetentionPlan`, `backupRetentionHistory`, `authorizeBackupRemoval`, `acknowledgeBackupRemoval`; runner/Recovery Center | Durable fenced receipts, fair bounded pages, prior-folder quarantine/retry | kernel `catalog-backup-retention.test.ts`, `archive-authority.test.ts`; shell `backup-retention.browser.test.ts` and real worker; connected |
| B: authenticated restore-as-new | `validateRestoreArchive`, `restoreAsNew`; Recovery Center | Original untouched, fresh catalog destination/jobs, fenced partial-file recovery | shell `worker-restore-integration.test.ts`; create/fork/delete/archive/restore/reload in `worker-manual-download-integration.test.ts`; connected |
| B: row/batch/structure recovery | `recoveryCandidates`, `restoreRow`, `undoBatch`, `makeLatest`; Recovery Center | Existing bounded authority recovery | shell `worker-daily-relation-integration.test.ts`; presentation/source audit remains |
| C: CSV/TSV/XLSX migration | `beginImport`, `stageImportChunk`, `configureImport`, `previewImport`, `commitImport`, `cancelImport`, `undoImport`; ImportWizard | Existing Preview/Keep/Discard/Undo and full 2,000,000-byte input cap | shell `release-c-import-coordinator.test.ts` baseline; no dependency changes |
| C: text-to-relation | `previewRelationConversion`, `convertTextToRelation`, `mutationOutcome`, `cancelPresentation`, `undoRelationConversion`; relation setup | Fingerprint/shadow/Keep, terminalize before correction, exact unchanged-target Undo | kernel `production-roadmap-mutations.test.ts`; shell `relation-conversion-recovery.test.tsx`, real worker; Undo-dismissal race audit remains |
| D: sources/timezone/favorites/recents | `dailyHome`, source/navigation CAS, `dailyHomeInitializeTimeZone`; TodayView/RecordDetail | Revision CAS/latest projection; original-source persistent intent incomplete | kernel `daily-presentation-cas.test.ts`, shell `today-view.test.tsx` baseline; partial |
| D: Capture/Undo | `dailyHomeResolveDate`, `dailyHomeQuickCapture`, `dailyHomeUndoCapture`, `mutationOutcome`, `cancelPresentation`; CommandPalette | Capture identity/date/source retained; correction terminalizes old request | shell `quick-capture.test.tsx`, `presentation-intent.test.ts`, real worker; persistent bound Undo remains |
| D: Inbox/Complete/Snooze/Dismiss | Read projection only; writers/UI absent | ADR-054 closed dispositions, canonical/archive migration, source/action/projection CAS required | kernel `daily-home-projection.test.ts` baseline; absent writers |
| E: recipe/custom create/edit/preview/enable/pause/delete | Existing `saveAutomationDraft`, `saveAutomationRecipeDraft`, `simulateAutomation`, `enableAutomation`, `pauseAutomation`, `deleteAutomation`; AutomationCenter | Lossless V2 editor/drafts/immutable retry/timezone work remains | shell `automation-release-e-ui.test.tsx` baseline; both disable flags remain |
| E: manual/due runs/history/status/notifications/Undo | Existing `runAutomations`, `runAutomationNow`, `automationRuns`, `automationRuntimeStatus`, `undoAutomationRun`, `markNotificationRead`; AutomationCenter | Bounded authority effects/receipts; complete enabled journey remains | shell `automation-enable.test.tsx` baseline; partial |
| F: Print/CSV | `projectPlaintextV1`, `cancelProjectionV1`; ExportDialog | Source/egress fences preserved | shell `export-dialog.test.tsx` baseline |
| F: encrypted sharing/attachments/expiry/revoke | Projection -> trusted-shell/backend; App/share | Origin-bound default deny; custody/source/UI reconciliation remains | shell `share-security-integration.test.ts` baseline; partial |
| F: intake lifecycle/delivery/review/auto-accept/Undo | Existing intake authority routes; IntakeCenter | Move owner private/token fields out of DB; shell custody/HTTP, staged review/receipts | shell `intake-vertical.test.ts`, `intake-ui.test.ts` baseline; incomplete |

## Actual finder-loop results

All test commands used `node node_modules/vitest/vitest.mjs run <files>
--maxWorkers=1 --minWorkers=1 --reporter=dot` from the corresponding package.
Final relevant packets, not the full package/workspace regression:

| Working directory / test files | Real result |
| --- | --- |
| kernel: `test/catalog-backup-retention.test.ts test/archive-authority.test.ts test/external-backup.test.ts test/production-roadmap-mutations.test.ts` | 4 files / 77 passed; 57.90s |
| kernel: `test/device-catalog.test.ts test/device-catalog-metadata.test.ts test/catalog-backup-recovery.test.ts test/production-request-journal.test.ts` | 4 files / 42 passed; 4.51s |
| shell: `test/backup-retention.browser.test.ts test/backup-target.browser.test.ts test/production-backup.browser.test.ts test/recovery-center.test.tsx test/presentation-intent.test.ts test/relation-conversion-recovery.test.tsx test/quick-capture.test.tsx test/production-mutation-route-census.test.ts` | 8 files / 75 passed; 7.25s |
| shell: `test/worker-daily-relation-integration.test.ts test/worker-backup-retention-integration.test.ts` | 2 files / 3 passed; 52.22s |
| shell: `test/worker-manual-download-integration.test.ts test/worker-restore-integration.test.ts` | 2 files / 2 passed; 27.04s |

- Total across these disjoint packets: 199 passed in 20 files.
- `node node_modules/typescript/bin/tsc --noEmit` in schema, kernel and shell:
  each exited 0 after final executable changes, with no diagnostics.
- `node scripts/roadmap-development-census.mjs`: exit 0; 19 capabilities,
  `developmentComplete=false`, two automation flags, ten explicitly retired
  unavailable compatibility routes. Inventory only; it runs no tests/build.
- RED outputs reproduced missing retention/worker methods, direct deletion from
  rotation hints, missing-file misclassification, old-lease rebinding, missing
  old-folder hints/UI, missing cancellation, and no-op archive identity accounting.
  Fixture import/portal assertion errors were corrected before treating tests as
  regression evidence; they were not relabeled as passing product gates.
- Integration executes real WorkerClient/db-worker/SQLite/catalog/private-verifier
  code with owned in-memory files/directory maps. No user browser, host OPFS or
  File System Access directory was used. No browser evidence path exists.
- Full suites, builds, frozen budgets, browser matrices, axe/NVDA, immutable or
  independent review were deliberately NOT run. Certification is not implied.

## Exact continuation

1. Inspect live status/HEAD in `D:\Clay`; preserve this diff or its externally saved
   checkpoint. One writer; no commits/pushes/downloads/production changes. Continue
   finder-loop development, not certification. No hard infrastructure blocker.
2. Next code boundary is persistent, original-source-bound Capture Undo:
   - `CommandPalette.tsx` still mints an Undo context in the live success callback;
     `undoQuickCapture(batchId, context)` still transports only `batchId`.
   - Persist immutable Undo invocation before presentation, preserve it across
     teardown/reload, bind original app/source/semantic table and receipt. Reject
     stale/forked/wrong-app use; never clear unknown Undo just to allow new capture.
     The canonical capture ledger is bounded to 200 entries.
   - Audit relation setup's "Keep linked records" cleanup: it must not forget
     a non-cancelled Undo with an ambiguous outcome. Cancellation currently permits
     only `daily.capture` and `schema.convertTextToRelation`. Extend a closed
     source-bound contract with tests, not generic arbitrary-route cancellation.
     Preserve the exact conversion Undo bound.
3. Finish retained source/navigation CAS intents across reload:
   - Carry original app/source fingerprint, reviewed projection/semantic IDs and
     immutable value/revision/request through WorkerClient and authority.
   - Current CAS prevents same-revision overwrite but still lacks full original
     app/projection binding. Never rebase an old reviewed action onto a new app
     or re-toggle a favorite on retry.
4. Implement ADR-054 Inbox/Complete/Snooze/Dismiss with closed physical dispositions,
   schema/canonical/archive participation, reversible outcomes and exact source/
   action/projection CAS. Preserve local-calendar/per-rule timezone semantics.
   No generic-setting hiding or off-device reminder/automation claims.
5. Complete E: lossless V2 editing including unrepresented actions, recipe/custom
   persistent drafts, immutable request/retry, per-rule timezone, preview/validation,
   create/edit/enable/pause/delete, manual/due runs, receipts/history/status/
   notifications/Undo. Remove both flags only after focused real-worker journeys.
6. Complete F: replace secret-bearing intake owner DB contracts with trusted-shell
   custody; never inspect real secrets. Wire immutable encrypted shares, attachments,
   expiry/revocation, source binding, delivery recovery, staged review/accept/reject,
   auto-accept simulation/controls and Undo. Keep HTTP/credentials shell/backend,
   default-denied origin config; no real production values or deployment.
7. Update census/handoff as inventory. Only after the entire A-F source/UI surface
   is developed start the single integrated regression/build/budget/browser/
   accessibility/security/product campaign. Never raise limits. NVDA requires a
   human; hosted configuration/deployment are separate later external gates.

Remaining blockers are unfinished code/integration, not a verified host failure.
Development-complete, P0 shipped and full-roadmap completion are NOT claimed.

## Changed-file scope

- Schema: `archive.ts`, `backup.ts`, `catalog.ts`.
- Kernel: `archive-authority.ts`, `device-catalog.ts`, `external-backup.ts`,
  `production-authority.ts`, `production-mutation-coordinator.ts`,
  `production-request-journal.ts`; new `backup-retention.ts`,
  `production-catalog-migration.ts`.
- Shell app: `App.tsx`, `CommandPalette.tsx`, `RecoveryCenter.tsx`,
  `RelationConversionDialog.tsx`, `backup-target.browser.ts`,
  `presentation-intent.ts`, `production-backup.browser.ts`, `worker-client.ts`;
  new `backup-retention.browser.ts`.
- Worker boundary: `db-worker.ts`, `mutation-route-census.ts`.
- Kernel tests: `archive-authority.test.ts`, `external-backup.test.ts`,
  `production-roadmap-mutations.test.ts`; new `catalog-backup-retention.test.ts`.
- Shell tests: `backup-target.browser.test.ts`, `presentation-intent.test.ts`,
  `production-backup.browser.test.ts`, `quick-capture.test.tsx`,
  `recovery-center.test.tsx`, `relation-conversion-recovery.test.tsx`,
  `worker-daily-relation-integration.test.ts`; new `backup-retention.browser.test.ts`,
  `worker-backup-retention-integration.test.ts`.
- This handoff, `scripts/roadmap-development-census.mjs`, ADR-058/059 in
  `specs/docs/10-decisions.md`. No dependency, production-value or release-evidence
  artifacts changed. Use the live diff for exact bytes.
