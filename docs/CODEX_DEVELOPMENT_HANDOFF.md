# A-F development continuation - 2026-09-13

Development checkpoint only. Development is NOT complete. No certification or
shipping claim. Continue from Exact continuation; do not start the integrated
regression/build/budget/browser/accessibility/review campaign yet.

## Workspace and preserved baseline

- Sole writer in `D:\Clay`, branch `codex/clay-project`.
- HEAD and local origin tracking ref remain
  `49d1b777c4d23df83af9ba0936e7d28bcbd88f7d`. Live location, clean starting
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

## Current continuation: terminal publication and durable owner work

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

## New F production intake path

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
| E manual/due/history/status/notifications/Undo | same read/command routes + mutationOutcome/cancelPresentation; AutomationCenter/App tick | Original due command terminalization, local runtime and exact bounded receipts/Undo | shell automation-tick and worker-automation-integration; OPFS capability BLOCKED |
| F local Print/CSV | projectPlaintextV1/cancelProjectionV1; ExportDialog | Source/egress fences unchanged | shell export-dialog; preserved |
| F encrypted sharing/files/expiry/revoke | presentationSource/projectPlaintextV1/attachmentsForRecord/readAttachment -> trusted-shell vault/relay; ShareDialog | Immutable ciphertext, owner CAS/readback, exact remote tombstones before replacement, explicit fresh preview | shell share-custody/share-terminal/share-owner-ui/share-security-integration and real worker; legacy adoption/source-loss recovery open |
| F intake publication/delivery/review | intakePresentation/intakeCommand/mutationOutcome/cancelPresentation; IntakeCenter + shell owner custody/ledger | Original IDs, durable workflow CAS before effects, exact worker/relay terminal proofs, cache-loss recovery, bounded staging/review | shell intake-publication-terminal/intake-workflows/intake-ui/intake-delivery-boundary/worker-intake-integration; legacy/cache-only and stale local-revoke renewal open |
| F auto-accept/receipts/Undo | same closed intake command/read routes; IntakeCenter | Receipt-target-bound simulation/enable, file review required, bounded inverse/history | shell intake-ui/worker-intake-integration; kernel intake/V2 authority |

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

## Current finder-loop results

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

## Exact continuation

1. Verify live Git status/HEAD and preserve this diff or its externally saved
   checkpoint. Base is 49d1b777c4d23df83af9ba0936e7d28bcbd88f7d, not the older
   1f24 checkpoint. One writer; no commits/pushes/downloads/production actions.
   Keep development-first sequencing; do not start certification.

2. Next F boundary: narrow authority-backed adoption/terminalization of legacy
   cache-only work and stale local revoke renewal.
   - New ledger-owned publication/sharing closure and cache-loss recovery are
     connected and tested. Do not restart those primitives or revert terminal
     HTTP to a DELETE/404 shortcut.
   - IntakeWorkflowSlot.recover deliberately rejects a cache-only original with
     no durable slot. A legacy client may still mint/send an unknown save/publish
     request after a read-only snapshot. Copying its cache, adding a protocol flag,
     or cancelling only known IDs does not exclude those later requests.
   - Design an original-form/owner/source-bound authority terminal protocol (or
     equivalently proven exclusion) before granting legacy workflow closure.
     Preserve original metadata, keys, IDs and responses. Add deterministic old
     client/new client, delayed unknown-ID and cancel/readback/persist faults first.
   - A local revocation retained before invocation can become stale if another
     canonical write wins. It currently fails closed and remains retained.
     Add explicitly reviewed source renewal ONLY after the original request is
     terminally cancelled/reconciled and the exact remote identity is terminal.
     Preserve all prior invocation identities; do not mutate the old immutable
     job/receipt, change a form's identity, or retarget unknown work.
   - If a publication already committed locally, Close stops the relay but asks
     the user to review/revoke the local form, then finish closure. That path is
     intentional; never report a still-active local form as reconciled.
   - Original app/generation loss/change remains quarantined. A narrow catalog/
     owner-history recovery grant is needed where the original target cannot be
     selected. Wrong-source copies must never gain owner custody. Keep source data
     usable outside the quarantine and make recovery prerequisites explicit.

3. Finish F legacy intake/private historical receipt and old share receipt adoption.
   - Originals stay untouched. Do not inspect real private values, silently strip/
     delete state, rebind copied/forked/restored metadata, archive legacy secrets,
     or send private material through ordinary WorkerClient.
   - Implement the narrow trusted-shell path with original authority/owner proof
     and custody commit/readback BEFORE publication metadata/owner actions.
     Test synthetic legacy state, responses/archives, wrong-source copies, lost
     commits and teardown/reload. A possession-only old share URL/receipt without
     app/source evidence must not be silently assigned to the currently open app.
   - Extend real worker/catalog/archive fixtures through create/fork/delete/
     restore-as-new. Metadata copies keep original source binding and cannot gain
     the source vault's owner authority. Existing quarantine/export denial is not
     a completed migration and must not be bypassed to enable UI.

4. Finish E's real production physical transaction/recovery capability.
   - Guard remains test_memory or unavailable in db.ts. No OPFS label/certificate
     was added. Re-read durable-inventory, boot order, lifecycle/restore recovery,
     observer guards and the pinned sqlite-wasm SAHPool VFS.
   - Add deterministic user/system/catalog commit, hot/super-journal, flush/delete,
     partial-publication, worker-loss and reopen faults before implementing.
     Recovery must explain exact owned files under fencing/exclusion, then rerun
     strict catalog/canonical classification; preserve unrelated and legacy files.
   - SAHPool xSync flush and its xCheckReservedLock behavior need real VFS-level
     investigation. A memory-driver fixture or route/UI label cannot grant OPFS
     capability. Physical/browser certification remains the later campaign.
   - Preserve retained scheduled-command reconciliation and the new durable intake
     check before scheduling any replacement invocation.

5. Update census/handoff as inventory. Once every A-F source/UI/custody/recovery
   boundary is genuinely implemented, stop for the single integrated testing
   phase. No full regression/build/budget/browser/accessibility/formal-review
   campaign now; never raise frozen budgets or fabricate a passing certificate.

Remaining development blockers are CODE: legacy/unfenced owner recovery and
stale local-revoke renewal in F, and actual OPFS transaction capability in E.
There is no verified host blocker. This is a coherent continuation checkpoint,
not development-complete, certified, P0 shipped, or roadmap shipped.

## Changed-file scope

Use `git status --short --untracked-files=all` for the exact current path list.
This continuation currently changes 38 paths (including 8 new files).

- Kernel: no source changes in this continuation; preserved authority/archive
  boundary finder tests and typecheck passed.
- Schema: closed terminal acknowledgements/request and retained revocation/closure
  job validation. No archive version, catalog identity or secret transport changes.
- Shell: App scheduler, IntakeCenter, ShareDialog, original publication/revocation,
  new public-only workflow ledger and terminal relay request helpers, shared request
  digest, trusted-shell relay client/configuration, focused protocol/UI/worker tests.
- Backend: immutable terminal relay endpoints, memory/Postgres identity retention,
  serialized clock revalidation, exact share replay, owned SQL/HTTP fault tests.
- Inventory/specification: development census, this handoff, ADR-064.
- No dependency/lockfile, production configuration, generated release artifact,
  evidence report or Git metadata changes.
