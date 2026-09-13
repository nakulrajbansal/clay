# A-F development continuation — 2026-09-12

This is an uncommitted development checkpoint, not a release, review fingerprint,
browser report, or declaration of development completion. Continue development;
do not start the integrated certification campaign yet.

## Workspace and workflow

- Sole writer in `D:\Clay`, `codex/clay-project`.
- HEAD remained `f96f674059c806bcd8483344e1eda16b86b472cc`; no commit/push attempted.
- The starting tree was clean. All changes recorded here are this development turn.
- No dependency installation/download, production action, server start/stop, or
  worktree outside `D:\Clay` was used. Reserved preview ports were untouched.
- Repository-local Node/Vitest/TypeScript entrypoints worked. Broad suites,
  production build, frozen budgets, browser/accessibility certification, independent
  reviews, and new immutable evidence remain deferred by the active user instruction.
- `node scripts/roadmap-development-census.mjs` is a read-only executable route/UI/test
  inventory. It validates references, reads live HEAD/status, and explicitly does
  not execute tests or claim packaged proof. It exited 0 in this turn.

## Capability matrix

Routes below are DB-worker command names unless explicitly marked trusted shell.
Tests are focused coverage, not proof of an entire phase shipping.

| Phase/capability | Production route and UI | Recovery/authority behavior | Focused coverage and development status |
| --- | --- | --- | --- |
| A: blank/starter Create, Switch, Rename, Fork, Delete, legacy adoption | `boot`, `createApp`, `seed`, `switchApp`, `renameApp`, `forkApp`, `deleteApp`; App chooser/setup | Existing P0 catalog, exact identities, physical isolation, receipts, fencing, recovery retained | `worker-lifecycle-integration`, `app-setup-intent`: green in this turn; packaged certification deferred |
| A/C: first-run/import-as-new and header review | `importNewApp`, `undoNewAppImport`; ImportReview | Existing target-bound first-run import, bounded Undo, request replay and header choice retained | P0 worker journey and first-run confirmation tests green; not new browser proof |
| B: reset/start over | `createApp`/`seed`; ConversationRail → App setup | Old apps retained; removed direct OPFS wiping and unsafe worker-failure fallback entirely | `start-over-boundary`: green; no destructive reset route or WorkerClient method |
| B: portable authenticated export | `collectArchiveSnapshot`, `validateBackupStage`; export action | Read-only authority snapshot, format 5, trusted-shell MAC verification before ZIP parsing, exact source readback | Real worker combined journey green, including export after conversion rewind |
| B: trust enrollment/Kit export, test import, import, activation | Trusted-shell BackupTrustRuntime through WorkerClient; Recovery Center | Existing IndexedDB key-vault CAS; keys/Kit bytes never sent to DB worker; no namespace authority in the vault | Trust-runtime and private-channel packets green; enrollment included in real worker journey |
| B: choose backup folder | Backup-directory adapter + `backupSelection`; Recovery Center | Existing explicit picker, permission revalidation and certified-runtime prerequisite preserved | Source preserved; external permission/restart campaign deferred; no new certification claimed |
| B: automatic preparation, validation, publication, records, retention | Trusted-shell automatic coordinator; `collectArchiveSnapshot`, `validateBackupStage`, `publishBackup`, `backupRecords`; Recovery Center/scheduler | Durable candidate and trust reservation; worker-validated stage; catalog fence; lost-response reconciliation and exact publication replay | Real SQLite/worker journey green for prepare/readback/publish/lost response/retry/no duplicate record; external physical retention and additional crash edges remain |
| B: manual backup records | Not completed | Must record an authenticated format-5 download attempt as **unverified external persistence**, never as a verified external backup just because a download started | Still code work; old ManualBackupDownload schema describes format 4 and needs reconciliation |
| B: record/batch/structural recovery | `recoveryCandidates`, `restoreRow`, `undoBatch`, `makeLatest`; Recovery Center | Bounded candidate discovery through authority reader; creation-only null history is not a restorable snapshot | Candidate discovery, Capture Undo and timeline rewind execute in real worker journey; full recovery UX/staleness audit remains |
| B: candidate archive validation and restore-as-new | `validateRestoreArchive`, `restoreAsNew` remain unavailable | UI now checks census and does not offer an unwired restore action; no replacement import fallback | Still code work: private verifier → fresh target reservation/install/publication/recovery lifecycle |
| C: existing CSV/TSV/XLSX import | `beginImport`, `stageImportChunk`, `configureImport`, `previewImport`, `commitImport`, `cancelImport`, `undoImport`; ImportWizard | Existing bounded Preview/Keep/Discard preserved; callerless direct `importTable` explicitly retired | Existing import coverage retained; full C package campaign deferred |
| C: text-to-relation | `previewRelationConversion`, `convertTextToRelation`, `makeLatest`; RelationConversionDialog | Real shadow preview; immutable input capture; SHA-256 fingerprint + semantic IDs + exact target; 5,000-row bounds per side; original text retained; guarded Keep/replay/rewind | Kernel and real-worker tests green, including stale/fault rejection and archive after rewind; dedicated bounded Undo UX and durable modal retry restoration remain |
| D: trusted source/date setup and durable timezone | `dailyHomeSourceCompareAndSet`, `dailyHomeInitializeTimeZone`, `dailyHome`; TodayView | CAS revisions, field identity/type validation, explicit empty-library malformed-state reset, recognized IANA zones, no transient timezone fallback | Kernel and real-worker tests green; Daily mutation flag removed for connected actions |
| D: favorites and recents | `dailyHomeNavigationCompareAndSet`; TodayView/RecordDetail | CAS + live semantic record validation; existing dangling references can be removed; record-open reporting guarded against reload loops | Kernel and real-worker persistence/projection coverage green |
| D: Quick Capture/date parsing/Undo | `dailyHomeResolveDate`, `dailyHomeQuickCapture`, `dailyHomeUndoCapture`; CommandPalette | Guarded batch, stable table identity, 200-receipt bound, exact unchanged-record Undo; same immutable click payload/request through ambiguous retry, including midnight | Kernel, worker lost-response/replay/Undo, and React retry tests green; presentation intent persistence across modal teardown/full reload remains |
| D: Inbox/dispositions/projection CAS | Partially present projection contracts | No guessed recovery items, Complete/Snooze/Dismiss, or off-device reminder claims added | Still code work and roadmap-contract audit; D is not declared complete |
| E: recipe/custom draft, edit, preview, enable/pause/delete | Existing authority automation routes; AutomationCenter | Existing production primitives retained | Still code work: V2 edit, retained save/run intents, per-rule timezone UI, full journey; two automation UI flags remain false |
| E: scheduled/manual execution, runtime/history/notifications/Undo | Existing `runAutomations`, `runAutomationNow`, `automationRuns`, `undoAutomationRun`, `markNotificationRead` | Existing bounded authority engine retained; no off-device runtime claims | Still integration/UX work; not exercised as a new complete journey this turn |
| F: local Print/CSV | Existing `projectPlaintextV1`, `cancelProjectionV1`; ExportDialog | Existing source-bound projection/egress fencing retained | Unchanged baseline; final campaign deferred |
| F: encrypted immutable sharing/access/revocation | Existing trusted-shell/backend sharing boundaries | No deployment or real configuration performed | Still source/UI/configuration-boundary audit; existing tests not represented as fresh proof |
| F: intake lifecycle, attachments, expiry/revocation, delivery recovery, review, auto-accept, receipts/Undo | Existing intake authority routes; IntakeCenter | Existing primitives retained | Still code work, notably eliminating owner secret material from app DB state and reconciling shell custody |

## Architecture changes to retain

- `production-daily.ts` and `production-relation.ts` join the guarded mutation
  coordinator, including full-envelope capture and reserved setting ownership.
- `ProductionStoreAuthority` now supplies semantic trusted-shell registry reads,
  source-bound conversion shadow preview, Daily Home projection, read-only archive
  snapshots, consistency inspection, backup selection/records/publication and
  bounded recovery candidates.
- Production Daily Home derives sample exclusion from the validated provenance
  ledger, not obsolete `sample_rows`. First-use sample coordinates also use the
  semantic registry instead of a stripped public projection.
- Inverse rename removes an empty reservation marker. This fixes exact active
  registry readback after conversion rewind without weakening archive checks.
- Creation-only `null` batch history is excluded from snapshot restoration/history
  presentation. It is not a before-image of an existing record.
- Format-5 catalog evidence schema 2 carries every terminal lifecycle receipt with
  physical generation/namespace binding. Schema 1 stays readable; nonterminal jobs
  still block collection. No authentication envelope change. See ADR-055.
- `archive-verification.ts` is trusted-shell-only. A one-use private port returns
  authenticated payloads and non-secret metadata. `production-backup-routes.ts`
  waits for that proof before parsing or staging, then fences publication.
- `trusted-backup-runtime.ts` composes the existing trust/coordinator primitives
  in the shell. Their historical files still live under `src/worker`, but the DB
  worker does **not** import those key-bearing runtime implementations.
- `RETIRED_DB_WORKER_ROUTES` documents callerless reset, direct import/replacement,
  and former secret-bearing backup commands. Tests ensure they stay closed and
  have no WorkerClient transport caller. Current shell key-vault APIs are distinct.

## Actual finder-loop results

These are recorded command outcomes, not a substitute for certification. Run
commands from the stated package directory. No full package suite was run.

| Working directory | Command after fixes | Real result |
| --- | --- | --- |
| `packages/kernel` | `node node_modules/vitest/vitest.mjs run test/production-roadmap-mutations.test.ts test/migrate.test.ts test/rollback-preservation.test.ts test/archive-authority.test.ts --maxWorkers=1 --minWorkers=1 --reporter=dot` | 4 files, 57 tests passed, 35.31s |
| `packages/shell` | `node node_modules/vitest/vitest.mjs run test/production-mutation-route-census.test.ts test/worker-daily-relation-integration.test.ts test/archive-verification-channel.test.ts test/quick-capture.test.tsx test/today-view.test.tsx test/start-over-boundary.test.ts test/recovery-center.test.tsx test/automatic-backup-worker.test.ts test/backup-trust-runtime.test.ts --maxWorkers=1 --minWorkers=1 --reporter=dot` | 9 files, 50 tests passed, 18.01s |
| `packages/shell` | `node node_modules/vitest/vitest.mjs run test/worker-lifecycle-integration.test.ts test/app-setup-intent.test.ts test/app-first-run-import-confirmation.test.ts --maxWorkers=1 --minWorkers=1 --reporter=dot` | 3 files, 8 tests passed, 28.19s; confirmation test is the existing `.tsx` file |
| Each of `packages/schema`, `packages/kernel`, `packages/shell` | `node node_modules/typescript/bin/tsc --noEmit` | Each exited 0 after fixes |
| `D:\Clay` | `git diff --check` | Exited 0 |

Earlier focused loops also exercised `production-authority.test.ts` read-only
archive snapshot (1 passed/68 skipped), archive-authority + app-lifecycle (45
passed), and shell DB-worker/backup entry boundaries. New RED failures reproduced:
missing production routes; malformed Daily source reset; Capture payload/ID change
across midnight; obsolete sample provenance read; mutable input across Preview's
async yield; archive shape failure after rewind; publication replay after byte
cache release; missing candidate route; and unwired restore UI. These were fixed
and rerun in the green packets above. An intermediate candidate-discovery failure
also exposed creation-only null history; no failing gate was relabeled a pass.

No new browser evidence paths exist. Existing browser/build/budget reports were
not regenerated and cannot certify these changed bytes. Historical red budgets
and browser certification are still open, not newly verified host blockers.

## Exact continuation

1. Re-read live status and this handoff; preserve this one-writer diff. Do not
   commit/push or begin a formal review cycle. Start with the B restoration work
   below, not with final evidence regeneration.
2. Finish B before enabling restore: extend the private verifier flow into
   `validateRestoreArchive`; issue a source-bound worker grant; reserve a fresh
   destination through the catalog. Reconcile `restore_as_new` jobs with the P0
   recovery fence, complete/orphan file inventory classification, exact publication
   receipts, selected-app fencing and boot recovery. Add deterministic interrupted
   create/install/publish/unlink and stale-tab tests **before** implementation.
   Do not authenticate by accepting a boolean or install into the source namespace.
3. Finish manual-download records (format 5, truthful unverified external-save
   status). Audit folder-switch/stale-candidate retry, lease expiry, trust commit
   failure after catalog publication, and retention recovery. Add multi-app
   create/fork/delete archive roundtrips for the new evidence schema, not just the
   existing terminal no-op receipt fixture.
4. Finish C/D presentation recovery: retained immutable modal intents across
   teardown/reload, explicit bounded conversion Undo, source/projection compare-and-set
   and Inbox/disposition contracts. Preserve source snapshot/semantic identity
   binding and the exact 2,000,000-byte JSON envelope cap.
5. Finish E through the existing authority routes: V2 editing without dropping
   unrepresented actions; persistent draft identity and immutable retries; per-rule
   timezone controls; enable flags only after the full bounded WorkerClient journey
   works. Run local schedules/manual runs, inspect history/notifications and Undo.
6. Complete F secret custody and source/UI wiring, attachments, delivery recovery,
   staged review/auto-accept/Undo, and default-denied origin-bound configuration.
   Production values/deployment are not authorized. Do not inspect real secrets.
7. Only when the complete feature surface is developed: perform the single
   integrated regression/build/frozen-budget/cross-browser/accessibility/security
   review campaign. Budgets must be reduced, never raised. Manual NVDA certification
   remains a human task. Do not claim development complete or shipped before its
   respective requirements have actually passed.

There is no newly verified infrastructure blocker. The remaining development
work is code/integration work, not a reason to weaken authority or fabricate gates.
