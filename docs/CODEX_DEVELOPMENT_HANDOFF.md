# A-F source-development completion - 2026-09-13

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
