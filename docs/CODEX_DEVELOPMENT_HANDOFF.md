# A-F development continuation - 2026-09-12

This is a development checkpoint, not a release or certification report.
Development is NOT complete. Continue the ordered code work below, not a formal
review, browser matrix, budget campaign, or final regression.

## Workspace and workflow

- Sole writer in `D:\Clay`, branch `codex/clay-project`.
- Starting and final live HEAD/local origin ref:
  `ad76c940e18b31eff0b6d78c8c3dd18568b8ef55`. Starting tree was clean.
- No commit, push, fetch, merge, deployment, dependency download/install, production
  configuration, or server start/stop was performed. Reserved ports untouched.
- All new work below is an uncommitted source/test/documentation diff on that base.
  The prior handoff and its finder results are preserved in the base commit.
- Repository-local Node/Vitest/TypeScript binaries work. No newly verified
  infrastructure blocker. Remaining development gaps are code/integration work.
- Do not certify these bytes with historical reports. Existing red browser/budget
  reports remain deferred; no new evidence report or immutable review cycle exists.

## A-F development matrix

Routes are DB-worker commands except where explicitly described as trusted-shell.
Test names are paths under the indicated package's `test/` directory. "Connected"
means source integration with focused coverage, NOT packaged certification.

| Phase / capability | Production route and UI | Recovery / authority behavior | Focused coverage and remaining development |
| --- | --- | --- | --- |
| A: blank/starter Create, Switch, Rename, Fork, Delete, legacy adoption | `boot`, `createApp`, `seed`, `switchApp`, `renameApp`, `forkApp`, `deleteApp`; App chooser/setup | P0 identities, isolated files, fencing, no-op/terminal receipts and legacy adoption preserved. Copied starter provenance is now re-attested atomically with its final receipt. | shell `worker-lifecycle-integration.test.ts`; kernel `production-restore-lifecycle.test.ts`. No new packaged proof. |
| A/C: first-run import and import-as-new | `importNewApp`, `undoNewAppImport`; ImportReview | Target-bound first-use, header choice, Preview/Keep/Discard, immutable requests and bounded Undo preserved. | shell `worker-lifecycle-integration.test.ts`; prior header/acquisition coverage retained. |
| B: reset/start over | `createApp` / `seed`; App setup | Creates a fresh app, retains old apps; unsafe direct reset/replacement remains retired. | Prior `start-over-boundary.test.ts`; no destructive fallback added. |
| B: portable authenticated export | `collectArchiveSnapshot`, `validateBackupStage`; export action | Trusted-shell authentication, worker snapshot/readback, format 5 unchanged; all nonterminal jobs block collection. | shell `worker-restore-integration.test.ts`, `worker-daily-relation-integration.test.ts`, `archive-verification-channel.test.ts`. Connected. |
| B: trust enrollment, Recovery Kit import/test/activation | Trusted-shell BackupTrustRuntime through WorkerClient; Recovery Center | Existing IndexedDB vault CAS; keys and Kit bytes never enter the DB worker. | Enrollment/private authentication exercised by real worker tests; existing trust-runtime coverage preserved. Activation race audit remains. |
| B: folder selection and automatic backup | `backupSelection`, `validateBackupStage`, `publishBackup`, `backupRecords`; directory adapter/Recovery Center/scheduler | Permission checks remain immediately before writes. Cross-tab trust exclusion; exact candidate readback; lease-only refresh; folder/source change reconciles a published outcome before retirement; staged retries read the same file. | shell `automatic-backup-recovery.test.ts`, `automatic-backup-worker.test.ts`, real worker packet. Prepared-but-unvalidated partial files and final retention completion remain code work. |
| B: retention | Catalog publication and external directory runner | Publication replay no longer drops rotation work. Keep newest 32 per app/folder/certification, return at most 64 deletions; never rotate the receipt's artifact or another target. | kernel `catalog-backup-recovery.test.ts`. Physical retry/acknowledgement after process loss still needs integration. |
| B: manual download records | `recordManualBackupDownload` -> `backup.manualDownload`, `manualBackupDownloads`; export action and Recovery Center | Authenticated readback required before journaled, bounded 100-entry app ledger. Explicit unverified external-save status; download does not stamp verified-backup status. Same live retry retains record and request. | shell `worker-restore-integration.test.ts`. Modal/App teardown and full-reload recovery of pending download intent remain code work; not declared complete. |
| B: archive validation and restore-as-new | `validateRestoreArchive` (ephemeral grant), `restoreAsNew` (lifecycle authority); Recovery Center controls connected | Private authentication before ZIP or target creation; exact source grant; fresh catalog reservation; fenced install/publication; closed terminal receipts. Restore never replaces source. Session retry intent survives modal/reload; interrupted cleanup requires fresh validation. | kernel `production-restore-lifecycle.test.ts`; shell `worker-restore-integration.test.ts`, `restore-intent.test.ts`, `recovery-center.test.tsx`. Connected; browser certification deferred. |
| B: record/batch/structure recovery | `recoveryCandidates`, `restoreRow`, `undoBatch`, `makeLatest`; Recovery Center | Existing authority candidates and bounded recovery preserved; null creation-only history is not a before-image. | Real daily/relation worker journey; remaining staleness/presentation audit. |
| C: CSV/TSV/XLSX migration | `beginImport`, `stageImportChunk`, `configureImport`, `previewImport`, `commitImport`, `cancelImport`, `undoImport`; ImportWizard | Preview-first bounded staging preserved; callerless `importTable` remains explicitly retired. Exact 2,000,000-byte full production JSON cap unchanged. | Existing import packets, P0 worker journey. No new dependency or XLSX parser installed. |
| C: text-to-relation | `previewRelationConversion`, `convertTextToRelation`, `makeLatest`; RelationConversionDialog | Authority/semantic identity/SHA-256 bound shadow Preview, guarded Keep/replay, original text preserved; 5,000 rows per side. | Real worker conversion/rewind/archive coverage preserved; dedicated bounded Undo and durable modal intent still required. |
| D: source/date/timezone, favorites and recents | `dailyHomeSourceCompareAndSet`, `dailyHomeInitializeTimeZone`, `dailyHomeNavigationCompareAndSet`, `dailyHome`; TodayView/RecordDetail | Prior guarded CAS, semantic field validation, durable local-calendar timezone and sample exclusion preserved. No hardcoded Daily mutation disable flag. | Real worker packet. Source/projection stale-action CAS and full presentation recovery audit remain. |
| D: Quick Capture/date/Undo | `dailyHomeResolveDate`, `dailyHomeQuickCapture`, `dailyHomeUndoCapture`; CommandPalette | Prior immutable click payload/request, 200-receipt bound and unchanged-record Undo preserved. Lost-response client replacement now explicitly releases unknown-outcome waiters. | Real worker replay/Undo plus prior React midnight retry coverage. Full modal/reload intent persistence remains. |
| D: Inbox / Complete / Snooze / Dismiss | Existing projection contracts only; new writers not yet connected | Follow ADR-054 and current roadmap; no guessed recovery identities or off-device reminder promises. | Still code work: disposition storage/archive transaction integration, source/action/projection CAS and UI. |
| E: recipe/custom creation, draft/edit, simulation, enable/pause/delete | Existing `saveAutomationDraft`, `saveAutomationRecipeDraft`, `simulateAutomation`, `enableAutomation`, `pauseAutomation`, `deleteAutomation`; AutomationCenter | Authority baseline retained; both automation mutation flags remain false until the real journey is connected. | Still code work: lossless V2 editing, persistent draft/request identity, immutable retries, per-rule timezone UI. |
| E: due/manual runs, history, notifications and Undo | Existing `runAutomations`, `runAutomationNow`, `automationRuns`, `automationRuntimeStatus`, `undoAutomationRun`, `markNotificationRead` | Preserve bounded engine, exact receipts, reversible effects and truthful foreground runtime status. | Still UI/worker journey work; no new completion claim. |
| F: local Print/CSV | `projectPlaintextV1`, `cancelProjectionV1`; ExportDialog | Existing source-bound projection and egress fencing preserved. | Existing baseline tests; integrated campaign deferred. |
| F: encrypted immutable sharing | Projection -> trusted-shell/backend sharing; App/export/share surfaces | No deployment or production values; maintain origin-bound default denial, read-only immutable payload and revocation. | Still custody/UI/configuration-boundary reconciliation; not newly exercised. |
| F: intake, attachments, expiry/revocation, delivery/review/accept/reject | Existing `saveIntakeForm`, publication/revocation/expiry, staging/delivery failure, accept/reject authority routes; IntakeCenter | Preserve staged receipts/Undo and trusted-shell HTTP. Owner secret fields must be removed from durable app DB contracts before completion. | Still code work: trusted-shell custody, lifecycle/attachment/delivery wiring and failure recovery. |
| F: auto-accept, simulation, receipts/Undo | Existing `simulateIntakeAutoAccept`, `enableIntakeAutoAccept`, `disableIntakeAutoAccept`, `processIntakeAutoAccept`, `intakeReceipts`, `undoIntakeReceipt` | Existing bounded primitives; no direct Store bypass or production configuration. | Still end-to-end local journey work. |

## New architecture to preserve

- `production-restore.ts` is a worker-only lifecycle entry, exported through
  `worker-authority.ts`, not generic/panel mutation dispatch. Its only production
  staging caller consumes the private verifier port's authenticated payload.
  At most four pending payload proofs live in memory; they are zeroed on eviction
  or completed/failed declared installation. Presentation stores only the grant
  and immutable request ID, never archive bytes or keys.
- Closed `CatalogRestoreJobV2` adds install/cleanup phase, exact request hash,
  source and fence. Legacy pending jobs remain readable for fenced cleanup.
  A pre-existing destination file or sidecar is rejected before declaring a job;
  it cannot become cleanup-owned merely because its name matches a fresh intent.
  Boot reconciles job-explained orphan pairs/sidecars BEFORE strict inventory.
  Cleanup atomically claims a job and revalidates it before each unlink. A live
  receipt wins over cleanup; an ambiguous post-install result is never catch-deleted.
- Catalog evidence retains restore and restore-aborted terminal receipts.
  Nonterminal restore/lifecycle rows block format-5 collection. No authenticated
  archive envelope weakening or version change.
- `lifecycle-reattestation-evidence.ts` validates one exact reservation/commit suffix
  for fresh restore/fork sample producer re-attestation. The install transaction
  preserves user records, panels, prior history and sample coordinates while the
  lifecycle receipt records both initial publication and the final target.
- `production-manual-backup.ts` joins reserved-setting ownership and the guarded
  request journal. Download metadata remains separate from verified folder records.
- Trusted-shell automatic backup now serializes prepare/stage/publish/retirement
  with Web Locks. Vault CAS and worker fences remain independent checks. A missing
  response is NOT a cancellation. WorkerClient replacement rejects old waiters
  with an unknown-outcome error, does not terminate the worker, and keeps transport
  IDs monotonic so late responses cannot satisfy a different call.
- Historical `src/worker/restore-as-new.ts` is still callerless in production
  (legacy unit-test scaffold). Do not wire its key-bearing interface into the DB
  worker; the production route uses the private verifier and new catalog lifecycle.
- See ADR-056. Earlier ADR-055 and all committed A/C/D authority work still apply.

## Actual finder-loop results

These are real command results, not release evidence. Commands use local binaries.
Broad suites, builds, budgets, browser/accessibility certification and independent
review were deliberately NOT run.

Kernel (from `packages/kernel`):

```text
node node_modules/vitest/vitest.mjs run test/production-restore-lifecycle.test.ts test/catalog-backup-recovery.test.ts test/archive-authority.test.ts test/production-samples.test.ts test/sample-provenance-proof.test.ts --maxWorkers=1 --minWorkers=1 --reporter=dot
5 files passed; 69 tests passed; 80.26s (before the final destination-footprint guard).
```

Shell (from `packages/shell`):

```text
node node_modules/vitest/vitest.mjs run test/worker-restore-integration.test.ts test/worker-daily-relation-integration.test.ts test/recovery-center.test.tsx test/restore-intent.test.ts test/worker-client-replacement.test.ts test/automatic-backup-worker.test.ts test/automatic-backup-recovery.test.ts test/production-mutation-route-census.test.ts test/archive-verification-channel.test.ts --maxWorkers=1 --minWorkers=1 --reporter=dot
9 files passed; 45 tests passed; 28.80s.
```

Additional finder packets in this continuation:

- After the final destination-footprint guard, kernel
  `node node_modules/vitest/vitest.mjs run test/production-restore-lifecycle.test.ts
  --maxWorkers=1 --minWorkers=1 --reporter=dot`: 1 file / 10 passed, 41.93s.
  Kernel typecheck was rerun and exited 0.
- After that guard, shell
  `node node_modules/vitest/vitest.mjs run test/worker-restore-integration.test.ts
  --maxWorkers=1 --minWorkers=1 --reporter=dot`: 1 file / 1 passed, 9.80s.
- Shell `automatic-backup-recovery.test.ts automatic-backup-worker.test.ts
  worker-client.test.ts worker-client-replacement.test.ts`: 4 files / 81 passed,
  4.89s (before final buffer-release and error-storage handling edits).
- Kernel `catalog-backup-recovery.test.ts device-catalog-metadata.test.ts`:
  2 files / 3 passed, 2.31s.
- Each of `packages/schema`, `packages/kernel`, `packages/shell`:
  `node node_modules/typescript/bin/tsc --noEmit` exited 0 after fixes.
- Shell `node node_modules/vitest/vitest.mjs run test/worker-client.test.ts
  test/worker-client-cancellation.test.ts test/worker-lifecycle-integration.test.ts
  --maxWorkers=1 --minWorkers=1 --reporter=dot`: 3 files / 77 passed, 46.00s.
- `node scripts/roadmap-development-census.mjs`: exited 0; 18 capabilities,
  developmentComplete=false, no tests or packaged proof claimed by the inventory.
- `git diff --check`: no whitespace errors. HEAD and local origin tracking ref
  still equal the starting commit; no remote write/readback was performed.

RED loops actually reproduced missing restore routes/module, interrupted physical
creation/install/publication, sample-provenance divergence on restore/fork, missing
manual record route, stale lease/folder candidates, trust-commit failure recovery,
staged retry using fresh-file creation, unknown-generation lease refresh, missing
retention on publication replay, and restore intent/callback mismatches.
A final deterministic collision test reproduced adoption of a pre-existing
destination footprint. Restore now rejects it before opening or reserving that
destination; the focused restore packet was rerun after this guard.
A real worker test timed out at 60 seconds when a lost-response client held the new
backup lock. The replacement regression first returned "still pending"; transport
ownership fixed it. The initial transport property caused four credential-boundary
tests to fail on circular JSON; it became native-private and that packet passed.
Shell typecheck caught the Web Locks nested-Promise typing issue; it was fixed.
No failed gate was relabeled a pass.

All new integration storage is an owned in-memory SQLite/file fixture. It executes
the actual WorkerClient, db-worker, catalog and ProductionStoreAuthority, but is
NOT OPFS/browser certification. No external browser context or user OPFS namespaces
were opened, cleared or deleted. No browser evidence paths were generated.

## Exact continuation

1. Re-read live status and this handoff in `D:\Clay`. Preserve this sole-writer
   diff. Do not commit/push or regenerate final evidence. HEAD/origin may be moved
   by the user's checkpoint-preservation workflow; inspect rather than assuming.
2. Continue B recovery edges, not a rewrite of the now-connected restore lifecycle:
   - Persist manual-download record intents per authority-owned app across App/
     modal teardown and full reload. Current App ref survives live retries only.
     Preserve immutable record/request identity; a download attempt must never
     claim a saved or verified external backup. On worker restart, reconcile an
     exact terminal receipt first; otherwise re-authenticate the exact file before
     recording, without restarting a download or silently minting another request.
     Add deterministic response-loss/storage-failure/source-switch UI tests first.
   - A prepared (not staged) candidate may have an absent/partial/colliding file
     after interrupted create/write/readback. Present explicit safe recovery;
     never overwrite/delete an ambiguous external file or loop forever on "fresh".
     Staged/published candidate retries now use publication_reconcile with current
     selection, preserving bytes/identity and authenticating existing-file readback.
   - If trust commit succeeds but candidate removal fails, next prepare currently
     removes the orphan candidate and prepares fresh. Finish exact publication/
     retention recovery through this edge, and audit trust-series activation/import
     racing with publication. Preserve cross-tab exclusion and vault CAS.
   - Complete physical retention acknowledgement/retry and truthful history after
     interrupted removal (catalog records currently still describe validation,
     not confirmed ongoing existence). Rotation replay alone is not full recovery.
   - Exercise these through the production external runner with owned directory
     faults and real worker transport; keep permission revalidation before writes.
     Runtime/certification gating is not permission to falsify an adapter pass.
3. Finish remaining C/D presentation recovery: retained immutable modal intents,
   explicit bounded conversion Undo, source/projection CAS, and Inbox dispositions/
   Complete/Snooze/Dismiss under the accepted physical/archive transaction contract.
   Preserve semantic identity, local-calendar/timezone correctness and the exact
   2,000,000 UTF-8 byte production JSON cap.
4. Complete E via existing authority routes: lossless V2 editing (do not drop
   unrepresented actions), persistent draft/request identity, immutable retries,
   per-rule timezone UI, recipe/custom create, preview/validate/enable/pause/delete,
   run now/due execution, history/notifications/Undo. Remove both hardcoded false
   flags only after the actual client/worker/authority journey works.
5. Complete F secret custody and source/UI wiring: remove owner private/token
   material from app DB contracts, use trusted-shell custody and HTTP, preserve
   source-bound immutable sharing, attachments, expiry/revocation, delivery recovery,
   staged review/accept/reject, auto-accept simulation, receipts/Undo. Configuration
   stays default-denied and origin-bound. No real production values or deployment.
6. Run `node scripts/roadmap-development-census.mjs` as an inventory only. It now
   includes manual records and enabled restore routes, but deliberately reports
   developmentComplete=false. Keep status descriptions honest as code changes.
7. Only when ALL A-F development is complete, begin the one integrated regression,
   build, frozen-budget, cross-browser, accessibility and security/product review
   campaign. Existing worker/closure/browser limits must be met without raising
   them. Manual NVDA certification remains a human task.

This turn needs continuation at step 2. No hard external blocker was established.
A-F development and shipment are not claimed complete.

## Changed-file scope

The live diff has 40 files: 15 kernel source files (catalog/archive/authority,
copied-sample evidence, restore and manual-download modules); 3 schema contracts
(`archive.ts`, `backup.ts`, `catalog.ts`); 8 shell source files (App, RecoveryCenter,
WorkerClient, restore intent, automatic backup, db-worker, backup routes, census);
10 focused tests/owned fixtures; and this handoff, `CODEX_HANDOFF.md`, ADR-056 in
`specs/docs/10-decisions.md`, and `scripts/roadmap-development-census.mjs`.
No release-evidence artifact, dependency manifest/lockfile, production value or
Git metadata was changed. Use the live diff for exact bytes, not a review fingerprint.
