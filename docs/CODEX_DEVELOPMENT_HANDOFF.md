# A-F development continuation - 2026-09-13

Development checkpoint only. Development is NOT complete. No certification or
shipping claim. Continue from Exact continuation; do not start the integrated
regression/build/budget/browser/accessibility/review campaign yet.

## Workspace and preserved baseline

- Sole writer in `D:\Clay`, branch `codex/clay-project`.
- HEAD and local origin tracking ref remain
  `1f24f2898858deab40e7e63888fdc07f1aa27db7`. No fetch/remote-server readback.
- The prior process's uncommitted 13-path intake diff was preserved and inspected,
  not reset or assumed complete. Its kernel intake/V2 packet independently passed
  11 tests and kernel typecheck before this continuation expanded the work.
- A/P0, B recovery/retention/authenticated archives, C conversion, D Capture/Inbox/CAS
  and E editor/workspace/history/Undo are preserved. Their implementation details
  remain in this handoff at the starting commit and ADR-060/061/062.
- One uncommitted source/test/documentation diff. No Git metadata writes, commits,
  pushes, installations/downloads, other checkout changes, server operations,
  deployment, production configuration or user-owned browser/storage access.
- The requested external development-6 events.jsonl read returned Access is denied.
  This was context-only, not an implementation blocker; no bypass was attempted.
- Package-local Node/Vitest/TypeScript binaries work. No current host blocker.
- No build, bundle report, browser evidence, release fingerprint or independent
  review was generated. Historical certification failures remain deferred.

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
- Remaining: explicit recovery for stale/expired prepared publications, unknown
  publication outcomes after source/configuration change, and recovery after loss
  of the session-storage workflow (not merely modal teardown/same-tab reload).
  Do not clear these jobs to unblock a new form.

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
  Safe legacy access/revocation adoption and stale/expired prepared-share recovery
  are still required. New custody is not silently bound to a fork.
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
| F encrypted sharing/files/expiry/revoke | presentationSource/projectPlaintextV1/attachmentsForRecord/readAttachment -> trusted-shell vault/relay; ShareDialog | Immutable ciphertext and owner CAS/readback before delivery, retained create/revoke retry | shell share-custody/share-owner-ui/share-security-integration and real worker; new path connected, legacy/stale recovery open |
| F intake publication/delivery/review | intakePresentation/intakeCommand/mutationOutcome/cancelPresentation; IntakeCenter + shell owner custody | Original form/save/publish/revoke IDs, private hydration outside worker, bounded staging, accept/reject/reload | shell intake-publication/intake-ui/intake-delivery-boundary/worker-intake-integration; legacy/stale recovery open |
| F auto-accept/receipts/Undo | same closed intake command/read routes; IntakeCenter | Receipt-target-bound simulation/enable, file review required, bounded inverse/history | shell intake-ui/worker-intake-integration; kernel intake/V2 authority |

## Actual current finder-loop results

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

## Exact continuation

1. Re-read live Git status/HEAD and preserve this entire uncommitted diff or its
   externally saved checkpoint. One writer. No commits/pushes/downloads/production
   actions. Do not restart A-D, the E editor, or the now-connected basic F migration.
2. The next F code boundary is SAFE terminalization/recovery of stale/expired
   retained publication, not enabling another UI flag:
   - IntakePublication preserves original work and fails closed when the original
     save/publication target becomes stale. It currently has Resume, not a complete
     explicit re-review/abandonment protocol. Add deterministic stale source,
     configuration switch, expiry, late original worker/HTTP completion, cache
     teardown/loss and crash-between-cancel/readback/persist tests first.
   - Prove or terminalize each original worker invocation before replacing any
     request. A read-only not_invoked snapshot is insufficient. Never relabel
     committed metadata or replace the retained form/key/ciphertext.
   - An ambiguous POST may still arrive after a DELETE. A missing remote form is
     not alone proof that a delayed publication cannot create it. Reconcile exact
     original relay identity or use a verified tombstone/terminal protocol.
   - Keep originals quarantined if safe terminalization cannot be established.
     Explicit reviewed source renewal must not be automatic retargeting.
   - Sharing has the corresponding stale/expired prepared-record boundary. Its
     invoked path safely replays exact ciphertext, but prepared recovery/abandonment
     and legacy receipt owner recovery are still open. Extend ShareOwnerSession/
     ShareDialog without deleting custody or minting a replacement for unknown work.
3. Finish safe legacy intake/receipt and old sharing receipt adoption:
   - Originals stay untouched; never inspect real private values, silently strip/
     delete state, rebind a fork/restore, archive legacy secrets or route them through
     WorkerClient. Ordinary replay refuses historical private responses unchanged.
   - Design the narrow trusted-shell adoption path with original authority/owner
     evidence and custody commit/readback first. Test synthetic legacy state AND
     historical responses/archives, wrong-source copies, lost commits and teardown.
     Current quarantine/export denial is deliberate, not completed adoption.
   - Extend the real worker/archive fixture to cover V2 metadata on create/fork/
     delete/restore-as-new without granting copied metadata original owner custody.
4. Finish E's actual production physical transaction/recovery capability:
   - Preserve the current fail-closed guard. A new label or memory fixture is not
     production authority. Inspect db.ts, durable-inventory.ts, boot ordering,
     lifecycle/restore recovery, the pinned SAHPool VFS and observer-route guard.
   - Add deterministic faults for user/sys/catalog commit, hot/super-journal,
     flush/deletion/partial publication, worker loss and reopen before enabling.
     Recovery must explain exact owned files under fencing/exclusion, rerun strict
     catalog/canonical classification and preserve unrelated/legacy files.
   - Establish real production runtime prerequisites before granting capability;
     keep physical browser/release certification separately deferred. Scheduled
     request reconciliation is implemented here; do not regress it.
5. Update the census/handoff as inventory. Only when every A-F control, route,
   durable readback and recovery path is implemented start the one integrated
   regression/build/budget/browser/accessibility/security/product campaign.
   Do not raise budgets. Human NVDA and real hosted configuration/deployment remain
   later external gates, not fabricated local completion.

Remaining development blockers are CODE: F legacy/stale workflow recovery and E
production OPFS transaction capability. No verified environment blocker prevents
continuation. This checkpoint does not claim development complete, P0 shipped or
the roadmap shipped.

## Changed-file scope

Use `git status --short --untracked-files=all` for the exact current path list.

- Kernel: intake V2 primitives, Store/receipt retention, production coordinator/
  authority, new source/private-response and archive boundaries, focused tests.
- Schema: intake metadata/publication ack, closed catalog command/cancellation,
  new public-only workflow contract and its package subpath export.
- Shell: App/DataView/IntakeCenter/ShareDialog, WorkerClient/db-worker/census,
  new intake session/publication/owner/relay configuration modules, new share
  custody/vault, bounded relay parser, scheduler recovery and focused tests.
- Backend: authenticated origin-allowlisted owner publication and owned relay tests.
- Inventory/specification: development census, this handoff, ADR-063.
- No dependency/lockfile, production configuration, generated release artifact,
  evidence report or Git metadata changes.
