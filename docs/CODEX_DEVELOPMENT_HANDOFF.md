# A-F development continuation - 2026-09-13

This is a source-development checkpoint, NOT a release or certification report.
Development is NOT complete. Continue Exact continuation below; do not start full
regression, builds, budgets, browser matrices, accessibility or independent review.

## Live workspace and scope

- Sole writer in `D:\Clay`, branch `codex/clay-project`.
- Starting clean HEAD and local origin tracking ref, also verified at handoff:
  `97d8b932be6e4531488651ebfcd266e318234f37`.
- New work is one uncommitted source/test/documentation diff on that base. The prior
  handoff is in that commit. No Git metadata was written or remote readback performed.
- No commit, push, fetch, merge, deployment, dependency download/install, production
  configuration, server start/stop or work in another checkout. Reserved ports and
  user browser/storage contexts were untouched.
- Local Node/Vitest/TypeScript work. No new infrastructure blocker. The root lacks
  `node_modules/typescript/bin/tsc`; use package-local tsc.
- Historical red certification/budget reports remain deferred and do not certify
  these bytes. No browser evidence or immutable review fingerprint was generated.

## Implemented in this continuation

### B: download recovery and external-backup retry edges

- New `ManualDownloadRecovery` stores immutable app/request/record metadata before
  browser handoff, checks storage readback, and survives modal teardown and full
  page reload in the same tab. It never stores archive/Recovery Kit bytes.
  Recovery Center can reconcile the record, choose the exact file for private
  reauthentication after worker restart, or explicitly discard only retry metadata.
  Discard never removes a file or durable download record.
- New read routes `manualBackupDownloadOutcome` and `validateManualBackupDownload`
  check the current canonical ledger and mirrored receipt, exact operation/source/
  request/reservation/response bindings. Historical acknowledgement does not repeat
  a download or relax generic replay. Records still mean unverified external save.
- Automatic candidates survive trust commit, response loss and candidate-removal
  failure until successful runner completion is acknowledged. Staged/published
  retries authenticate existing-file readback. A prepared retry uses closed
  `write_reconcile`: exclusive create if absent; on collision, read only, never
  reopen for writing or catch-delete a partial/ambiguous file.
- Recovery Center can explicitly retire an authority-proven unpublished attempt,
  preserving every file. Published attempts cannot use that path. Lost retirement
  cleanup responses are reconciled before a fresh attempt.
- Shared trusted-shell Web Lock covers trust enrollment/series activation and
  prepare/stage/publish/retirement. Active-series changes are denied while a
  candidate remains. Browser environments without exclusion fail closed; only
  owned non-browser fixtures use the serialized fallback.
- Retention retries treat an already-absent exact filename as idempotent, still
  revalidating directory permission immediately before deletion. The trusted-shell
  `completeAutomaticBackup` callback checks exact trust/catalog/candidate readback
  before releasing a completed candidate. This is NOT durable per-file accounting.
- Real WorkerClient/db-worker coverage now includes manual download recovery plus
  Create -> starter -> Fork -> Delete -> authenticated export -> restore-as-new ->
  reload, preserving panels/history and the unrelated original app.

### C/D: presentation recovery and bounded Undo

- New `presentation-intent.ts` retains immutable app/slot/request/payload metadata
  in session storage, bounded to 2,000,000 UTF-8 bytes, with closed payload parsing
  and readback. Corrupt/cross-slot/rebound metadata is retained and rejected before
  rendering. It cannot mint durable identity or grant app authority.
- `mutationOutcome` is a read-only worker/authority acknowledgement for a closed
  route set. It checks current canonical selection and original request hash,
  operation, source lineage, mirrored receipt and reservation binding, and reports
  whether the recorded result is still current. It never executes an old mutation.
  Generic stale historical replay remains fail-closed.
- RelationConversionDialog persists Keep and bounded Undo requests before invocation/
  presentation work. Closing/reloading retains exact intents. A lost presentation
  response reads the receipt, not a second conversion. New `undoRelationConversion`
  -> `schema.undoRelationConversion` requires the exact committed target and one-step
  history bound. Any intervening canonical write denies Undo; later edits stay.
- Shared relation/capture payload schemas validate both worker requests and shell
  retry metadata. Historical Keep/Undo acknowledgements are labeled recorded earlier,
  not claimed current. DataView refreshes before clearing request metadata; failed
  presentation leaves retry intact.
- CommandPalette quick creation uses `dailyHomeQuickCapture` with stable semantic
  table ID and original app ID. Resolved dates, row and request survive remount/
  reload unchanged. WorkerClient now requires explicit context and original app
  argument; the worker rejects rebinding. Bounded receipts remain in Recovery
  Center. Invocation identity for the toast Undo is still live-only.
- Daily source CAS rejects concurrent changes to the same profile instead of
  overwriting them, and explicit reset cannot silently retry a newer revision.
  Favorite retries keep the original pin/unpin result. TodayView discards older
  setup/projection responses after a newer refresh or unmount.

Preserve committed A/P0, first-run import, header review, legacy OPFS adoption,
fencing, authenticated restore lifecycle, destination freshness, sample re-attestation,
exact copied-target receipts and private verifier channel. See ADR-055/056 and new
ADR-057 in `specs/docs/10-decisions.md`.

## A-F development matrix

Routes are DB-worker commands unless marked trusted-shell. Tests are relative to
the indicated package's `test/`. Connected means source integration with focused
coverage, NOT packaged certification. Baseline rows are not new test-pass claims.

| Phase / capability | Production route; UI | Recovery / boundary | Focused coverage; remaining code |
| --- | --- | --- | --- |
| A: Create/starter/Switch/Rename/Fork/Delete/legacy adoption | `boot`, `createApp`, `seed`, `switchApp`, `renameApp`, `forkApp`, `deleteApp`; App chooser/setup | Existing isolated targets, fenced lifecycle, receipts/adoption preserved | shell `worker-lifecycle-integration.test.ts` baseline; new `worker-manual-download-integration.test.ts` multi-app archive roundtrip |
| A/C: first-use and import-as-new | `importNewApp`, `undoNewAppImport`; ImportReview | Existing one-target first-use, header choice, Preview/Keep/Discard/Undo preserved | shell `worker-lifecycle-integration.test.ts` baseline |
| B: safe start over | `createApp` / `seed`; App setup | Fresh app, old apps retained; direct reset retired | shell `start-over-boundary.test.ts` baseline |
| B: authenticated export, enrollment, Kit import/activation | `collectArchiveSnapshot`, `validateBackupStage`; trusted-shell BackupTrustRuntime; Recovery Center | Format 5/private verifier unchanged; keys/Kit bytes outside worker; active-series exclusion | shell `backup-trust-runtime.test.ts`, `automatic-backup-recovery.test.ts`, `worker-restore-integration.test.ts` |
| B: manual download records/reload recovery | `recordManualBackupDownload`, `manualBackupDownloads`, `manualBackupDownloadOutcome`, `validateManualBackupDownload`; App export/Recovery Center | Per-app immutable intent, receipt-first recovery, exact-file reauthentication; unverified external save | shell `manual-download-recovery.test.ts`, `worker-manual-download-integration.test.ts`, `recovery-center.test.tsx`; owned fixtures, not browser proof |
| B: folder/automatic prepare, validate, publish | Trusted-shell prepare/complete/retire; `backupSelection`, `validateBackupStage`, `publishBackup`, `backupRecords`; folder action/scheduler/Recovery Center | Permission revalidation, lease-only refresh, exact trust/publication recovery, read-only collision recovery, unpublished retirement | shell `automatic-backup-recovery.test.ts`, `backup-target.browser.test.ts`, `production-backup.browser.test.ts`; combined real-worker/directory faults remain |
| B: retention | Catalog rotation -> external runner -> trusted-shell completion | Exact missing-file retry and candidate acknowledgement; no unrelated deletion | kernel `catalog-backup-recovery.test.ts`, `external-backup.test.ts`; durable per-file accounting/pagination and old-folder work retention remain |
| B: authenticated restore-as-new | `validateRestoreArchive`, `restoreAsNew`; Recovery Center | Existing authentication before ZIP, fresh reservation, fenced jobs/cleanup, exact receipt and retained intent | shell `worker-restore-integration.test.ts`, `worker-manual-download-integration.test.ts`; prior kernel restore fault suite preserved |
| B: row/batch/structure recovery | `recoveryCandidates`, `restoreRow`, `undoBatch`, `makeLatest`; Recovery Center | Existing bounded candidates and authority writes preserved | shell `worker-daily-relation-integration.test.ts`; stale/presentation audit remains |
| C: CSV/TSV/XLSX Preview/Keep/Discard/Undo | `beginImport`, `stageImportChunk`, `configureImport`, `previewImport`, `commitImport`, `cancelImport`, `undoImport`; ImportWizard | Bounds/semantics preserved; callerless `importTable` retired; no dependency installed | shell `release-c-import-coordinator.test.ts` baseline |
| C: text-to-relation | `previewRelationConversion`, `convertTextToRelation`, `mutationOutcome`, `undoRelationConversion`; RelationConversionDialog | Immutable Keep/Undo, fingerprint/shadow, historical acknowledgement, exact unchanged-target Undo | shell `relation-conversion-recovery.test.tsx`, real worker; kernel `production-roadmap-mutations.test.ts`; stale/failed intent reset remains |
| D: source/date/timezone/favorites/recents | `dailyHome`, source/navigation CAS, `dailyHomeInitializeTimeZone`; TodayView/RecordDetail | Same-profile conflicts denied, favorite retry stable, latest projection wins | kernel `daily-presentation-cas.test.ts`, shell `today-view.test.tsx`; persistent CAS intent/source-app recovery remains |
| D: Quick Capture and Undo | `dailyHomeResolveDate`, `dailyHomeQuickCapture`, `dailyHomeUndoCapture`, `mutationOutcome`; CommandPalette/Recovery Center | Original app/semantic ID/date/row/request retained; exact receipt and bounded Undo | shell `quick-capture.test.tsx`, `presentation-intent.test.ts`, real worker; persisted Undo invocation/failed-intent recovery remain |
| D: Inbox/Complete/Snooze/Dismiss | Read projection only; no action writer/UI yet | ADR-054 physical disposition/canonical/archive/action-CAS contract required | kernel `daily-home-projection.test.ts` baseline only; writers absent |
| E: recipe/custom draft/create/edit/simulate/enable/pause/delete | Existing `saveAutomationDraft`, `saveAutomationRecipeDraft`, `simulateAutomation`, `enableAutomation`, `pauseAutomation`, `deleteAutomation`; AutomationCenter | Authority baseline; both automation disable flags remain | shell `automation-release-e-ui.test.tsx` baseline; lossless V2 editor, persistent requests/retries/timezone UI remain |
| E: manual/due runs, history/status/notifications/Undo | Existing `runAutomations`, `runAutomationNow`, `automationRuns`, `automationRuntimeStatus`, `undoAutomationRun`, `markNotificationRead`; AutomationCenter | Preserve bounded effects/receipts and truthful foreground status | shell `automation-enable.test.tsx` baseline; enabled worker/UI journey required |
| F: local Print/CSV | `projectPlaintextV1`, `cancelProjectionV1`; ExportDialog | Existing source-bound projection/egress fencing preserved | shell `export-dialog.test.tsx` baseline |
| F: encrypted immutable sharing, attachments/expiry/revocation | Projection -> trusted-shell/backend; App/share | Default-denied origin configuration; no real values/deployment | shell `share-security-integration.test.ts` baseline; custody/UI/source/attachment reconciliation remains |
| F: intake lifecycle/delivery/review/accept/reject | Existing `saveIntakeForm`, publication/revoke/expire/staging/delivery-failure/accept/reject routes; IntakeCenter | Staged authority; owner secret fields must leave app DB contracts | shell `intake-vertical.test.ts` baseline; trusted-shell custody/full local journey remain |
| F: auto-accept/simulation/receipts/Undo | `simulateIntakeAutoAccept`, enable/disable/process auto-accept, `intakeReceipts`, `undoIntakeReceipt`; IntakeCenter | Bounded receipts, reversible outcomes, trusted-shell HTTP | shell `intake-ui.test.tsx` baseline; full local UI/worker integration remains |

The executable development census now lists 19 capabilities, both remaining
automation disable flags, and retirement reasons for unavailable worker compatibility
routes. It deliberately reports `developmentComplete: false`; it runs no tests/build
and produces no browser proof.

## Actual finder-loop results

Commands used repository-local binaries, serially. Development feedback only.
Documentation edits after these runs do not change executable source.

Kernel, from `packages/kernel` (final executable source):

```text
node node_modules/vitest/vitest.mjs run test/production-roadmap-mutations.test.ts test/daily-presentation-cas.test.ts test/daily-source-profile.test.ts test/daily-navigation.test.ts test/external-backup.test.ts test/catalog-backup-recovery.test.ts --maxWorkers=1 --minWorkers=1 --reporter=dot
6 files passed; 47 tests passed; 19.07s.
```

Shell, from `packages/shell` (final executable source):

```text
node node_modules/vitest/vitest.mjs run test/today-view.test.tsx test/operations-ui.test.tsx test/quick-capture.test.tsx test/relation-conversion-recovery.test.tsx test/presentation-intent.test.ts --maxWorkers=1 --minWorkers=1 --reporter=dot
5 files passed; 26 tests passed; 8.34s.

node node_modules/vitest/vitest.mjs run test/worker-manual-download-integration.test.ts test/worker-daily-relation-integration.test.ts test/worker-restore-integration.test.ts test/worker-client-replacement.test.ts --maxWorkers=1 --minWorkers=1 --reporter=dot
4 files passed; 4 tests passed; 45.68s.
```

Backup packet earlier in this continuation, before final shared relation/capture
schema and historical Undo presentation changes (from `packages/shell`):

```text
node node_modules/vitest/vitest.mjs run test/automatic-backup-recovery.test.ts test/automatic-backup-worker.test.ts test/automatic-backup-trigger.browser.test.ts test/backup-trust-runtime.test.ts test/backup-target.browser.test.ts test/production-backup.browser.test.ts test/manual-download-recovery.test.ts test/recovery-center.test.tsx test/production-mutation-route-census.test.ts test/backup-entry-boundary.test.ts --maxWorkers=1 --minWorkers=1 --reporter=dot
10 files passed; 80 tests passed; 6.08s.
```

- `node node_modules/typescript/bin/tsc --noEmit` in schema, kernel and shell each
  exited 0 after final executable edits.
- `node scripts/roadmap-development-census.mjs` exited 0: 19 capabilities,
  `developmentComplete=false`, 2 hardcoded automation disable flags, 10 explicitly
  retired unavailable compatibility routes. Counts are not product proof.
- Initial root tsc failed `MODULE_NOT_FOUND`; package-local commands above worked
  without downloading dependencies.
- `git diff --check` has no whitespace errors at handoff.

RED loops reproduced missing download/outcome methods; candidate loss after trust
commit/cleanup failure; trust activation racing publication; retirement cleanup;
prepared-file collision; missing-file retention retry; missing modal intent/outcome/
Undo; shadow receipt-journal access; app-bound capture; source CAS overwrite/reset
and favorite retoggle; late projection overwrite; malformed cached rendering; and
historical Undo presented as current. Focused GREEN results above cover the fixes.
Intermediate fixture/type errors were corrected, not relabeled passes.

Integration fixtures execute actual WorkerClient -> db-worker -> catalog ->
ProductionStoreAuthority against owned SQLite/file storage and private verifier
ports. They do NOT certify browser OPFS or File System Access APIs. No user browser
was attached or cleared; no browser evidence path exists. No full suite, production
build, frozen budget, browser matrix, axe/NVDA or independent review was run.

## Exact continuation

1. Inspect live status in `D:\Clay` and preserve the diff. User/Hermes may preserve a
   checkpoint externally; do not commit/push or assume HEAD. Continue development,
   not certification. No hard external blocker exists.
2. Finish B durable retention accounting:
   - `DeviceCatalog.backupRotation` still uses newest-32 exclusion / max-64 work from
     records whose state stays `valid` after physical deletion. The new completion
     callback is exact-candidate acknowledgement, not per-file catalog accounting.
     Add interrupted remove/acknowledge/reload RED tests first, then an authority-
     fenced receipt-bound contract with closed catalog/archive coverage. Do not
     silently update `record_json`, reuse publication events for deletion, weaken
     DDL checks or turn vault metadata into app/catalog authority. Existing catalogs
     must remain adoptable.
   - Paginate acknowledged work so missing files cannot occupy the 64-entry window
     and starve older failed deletions. History must distinguish validation at
     publication from current file availability.
   - `AutomaticBackupCoordinator.#prepare` still reconciles/removes a published
     candidate on folder/source change; this can drop prior-folder retention work.
     Preserve/quarantine exact old-folder work with explicit recovery while keeping
     all files. Do not delete another app/folder or block source data.
   - Combine real WorkerClient transport and an owned directory fixture for lease
     expiry, folder/source switch, staged/partial files, trust-commit failure and
     removal faults. Separate coordinator/directory tests are not that combined
     journey. Adapter certification stays deferred, never bypassed.
3. Finish C/D recovery and Inbox:
   - A rejected stale/failed Keep or Capture still locks its saved request. Add safe
     recovery/re-preview/correction. Do not clear `not_invoked` while a non-cancelled
     old invocation can still arrive. Terminalize/cancel or otherwise prove the old
     request cannot execute before allowing a new intent. Corrupt metadata is now
     rejected, but cache absence must not imply absence of a durable outcome.
   - Persist Capture Undo invocation identity, not just the toast; audit original
     source binding across app switching/forked receipts. Relation Undo is already
     bounded/persistent, but historical acknowledgement must not advertise a
     currently available inverse without a fresh bound check.
   - Source/nav CAS detects concurrent same-profile changes, but still needs the
     original reviewed-source/app binding and retained immutable CAS intent through
     reload. Action CAS must bind original projection/semantic IDs, not reselect
     current names after awaits.
   - Implement Inbox/Complete/Snooze/Dismiss per ADR-054: closed physical disposition
     storage, canonical/archive participation, source/action/projection CAS,
     reversible outcomes and local-calendar semantics. Writers are absent; do not
     hide them in generic settings or imply off-device runtime.
4. Complete E through existing authority routes: lossless V2 editing (preserve all
   unrepresented actions), recipe/custom drafts, persistent draft/request identity,
   immutable retries, per-rule timezone UI, preview/validation, create/edit/enable/
   pause/delete, manual/due runs, history/status/notifications and Undo. Both
   `automationMutationsAvailable={false}` and `mutationsAvailable={false}` remain in
   App; remove only after the actual WorkerClient/db-worker journey works.
5. Complete F: move intake owner private/token fields out of app DB contracts
   (`LocalIntakeForm` / `saveIntakeForm`) into trusted-shell custody; never inspect
   real credentials. Wire immutable encrypted sharing, attachments, expiry/revoke,
   intake delivery recovery, staged review/accept/reject, auto-accept simulation and
   receipt Undo. Keep HTTP trusted-shell/backend and configuration default-denied/
   origin-bound. No real production values or deployment.
6. Update the development census/handoff as inventory. Only after ALL A-F code is
   developed begin the single integrated regression/build/frozen-budget/cross-
   browser/accessibility/security/product review campaign. Do not raise limits.
   Manual NVDA certification remains a human task.

This turn needs continuation at step 2. Remaining blockers are code/integration,
not a newly verified infrastructure failure. Release certification, human
accessibility and hosted configuration/deployment remain separate later gates.
A-F development, P0 shipment and full roadmap completion are NOT claimed.

## Changed-file scope

- Schema: `backup.ts`, `catalog.ts` (closed download/presentation payload/outcome
  schemas and automatic retry discriminator).
- Kernel: `production-authority.ts`, `production-mutation-coordinator.ts`,
  `production-core-routes.ts`, `production-daily.ts`, `production-relation.ts`,
  `production-manual-backup.ts`, `external-backup.ts`, `daily-source-profile.ts`,
  `daily-navigation.ts`; tests `production-roadmap-mutations.test.ts`,
  `external-backup.test.ts`, new `daily-presentation-cas.test.ts`.
- Shell app: `App.tsx`, `CommandPalette.tsx`, `DataView.tsx`, `RecoveryCenter.tsx`,
  `RelationConversionDialog.tsx`, `TodayView.tsx`, `worker-client.ts`,
  `backup-target.browser.ts`, `production-backup.browser.ts`, new
  `manual-download-recovery.ts`, `presentation-intent.ts`.
- Shell worker boundary / trusted-shell support: `db-worker.ts`,
  `mutation-route-census.ts`, `production-backup-routes.ts`, `automatic-backup.ts`,
  `backup-trust-runtime.ts`, new `backup-operation-lock.ts`. Historical folder names
  do not mean the key-bearing runtime is imported into db-worker.
- Shell tests: `automatic-backup-recovery.test.ts`, `automatic-backup-worker.test.ts`,
  `backup-target.browser.test.ts`, `operations-ui.test.tsx`,
  `production-backup.browser.test.ts`, `quick-capture.test.tsx`,
  `recovery-center.test.tsx`, `today-view.test.tsx`,
  `worker-daily-relation-integration.test.ts`; new `manual-download-recovery.test.ts`,
  `presentation-intent.test.ts`, `relation-conversion-recovery.test.tsx`,
  `worker-manual-download-integration.test.ts`.
- This handoff, `scripts/roadmap-development-census.mjs` and ADR-057 in
  `specs/docs/10-decisions.md`. No dependency, production-value or evidence artifact
  changed. Use the live diff for exact files/bytes, not historical review reports.
