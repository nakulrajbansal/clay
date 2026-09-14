// Read-only development inventory, NOT browser evidence or a release gate.
// Run: node scripts/roadmap-development-census.mjs
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(resolve(root, "packages/shell/src/worker/mutation-route-census.ts"), "utf8");
const block = source.slice(source.indexOf("export const DB_WORKER_ROUTE_CENSUS"), source.indexOf("/** No current WorkerClient caller."));
const routes = new Map([...block.matchAll(/^  (\w+): route\("([^"]+)", "([^"]+)"\),$/gm)]
  .map(match => [match[1], match[2]]));
if (!routes.size) throw new Error("Cannot parse the closed production route census");
const ui = file => `packages/shell/src/app/${file}`;
const test = file => `packages/shell/test/${file}`;
const entries = [
  ["A", "Create/starter/switch/rename/fork/delete/legacy adoption", ["boot", "createApp", "seed", "switchApp", "renameApp", "forkApp", "deleteApp"], ui("App.tsx"), test("worker-lifecycle-integration.test.ts"), "P0 development baseline; certification deferred"],
  ["A", "First-use and import-as-new Preview/Keep/Discard/Undo", ["importNewApp", "undoNewAppImport"], ui("ImportReview.tsx"), test("worker-lifecycle-integration.test.ts"), "P0 development baseline; certification deferred"],
  ["B", "Safe start over", ["createApp", "seed"], ui("App.tsx"), test("start-over-boundary.test.ts"), "Preserves old apps; packaged proof deferred"],
  ["B", "Authenticated export and key-vault enrollment/Kit import/activation", ["collectArchiveSnapshot", "validateBackupStage"], ui("RecoveryCenter.tsx"), test("worker-restore-integration.test.ts"), "Shell-only key vault and private verifier port; connected, not certified"],
  ["B", "Manual download records", ["recordManualBackupDownload", "manualBackupDownloads", "manualBackupDownloadOutcome", "validateManualBackupDownload"], ui("RecoveryCenter.tsx"), test("worker-manual-download-integration.test.ts"), "Connected: per-app immutable session intent, exact receipt-first reload recovery, private file reauthentication, unverified external-save wording"],
  ["B", "Folder selection and automatic prepare/readback/publish/retention", ["backupSelection", "backupRecords", "validateBackupStage", "publishBackup", "backupRetentionPlan", "backupRetentionHistory", "authorizeBackupRemoval", "acknowledgeBackupRemoval"], ui("RecoveryCenter.tsx"), test("worker-backup-retention-integration.test.ts"), "Connected in development: closed migrated catalog accounting, authority-fenced per-file receipts, bounded fair pages, immutable unlink/ack retry, prior-folder quarantine/retry, publication-versus-availability UI; owned real-worker/directory faults covered, not browser certification"],
  ["B", "Record/batch/structure recovery candidates", ["recoveryCandidates", "restoreRow", "undoBatch", "makeLatest"], ui("RecoveryCenter.tsx"), test("worker-daily-relation-integration.test.ts"), "Connected: Recovery Center record/batch/structural controls call App authority handlers with bounded recovery and conflict readback; packaged campaign deferred"],
  ["B", "Authenticated restore-as-new", ["validateRestoreArchive", "restoreAsNew"], ui("RecoveryCenter.tsx"), test("worker-restore-integration.test.ts"), "Connected: private authentication, fresh catalog job, fenced install/recovery, exact receipts and retained UI retry; packaged proof deferred"],
  ["C", "CSV/TSV/XLSX preview-first migration and Undo", ["beginImport", "stageImportChunk", "configureImport", "previewImport", "commitImport", "cancelImport", "undoImport"], ui("ImportWizard.tsx"), test("release-c-import-coordinator.test.ts"), "Preserved baseline; integrated campaign deferred"],
  ["C", "Text-to-relation shadow Preview/Keep/replay/Undo", ["previewRelationConversion", "convertTextToRelation", "mutationOutcome", "cancelPresentation", "undoRelationConversion"], ui("RelationConversionDialog.tsx"), test("relation-conversion-recovery.test.tsx"), "Connected: original-result-bound immutable Keep/Undo; Keep linked records first terminalizes Undo; ambiguous outcomes retained; exact bounded inverse, no rebase"],
  ["D", "Source setup/timezone/favorites/recents", ["dailyPresentation", "dailyHomeSourceCompareAndSet", "dailyHomeNavigationCompareAndSet", "dailyHomeInitializeTimeZone"], ui("TodayView.tsx"), test("worker-daily-relation-integration.test.ts"), "Connected: paired authority/projection, original source and semantic IDs, revision and immutable desired-value CAS retained across reload; explicit Retry/Cancel without retoggle or rebase"],
  ["D", "Quick Capture/date resolution/Undo", ["dailyHomeResolveDate", "dailyHomeQuickCapture", "dailyHomeUndoCapture", "mutationOutcome", "cancelPresentation"], ui("CommandPalette.tsx"), test("quick-capture.test.tsx"), "Connected: Undo identity persisted before presentation, original app/generation/source/table/batch/payload/receipt binding, exact unchanged-target inverse; original outcome reconciliation or terminal cancellation required before replacement"],
  ["D", "Inbox/Complete/Snooze/Dismiss/Undo", ["dailyPresentation", "dailyInboxAction", "dailyInboxUndo", "mutationOutcome", "cancelPresentation"], ui("TodayView.tsx"), "packages/kernel/test/daily-inbox-authority.test.ts", "Connected: closed physical disposition table and global CAS tokens, canonical/archive copy, exact item/action/projection CAS, local-day Snooze, original-target bounded Undo; real worker archive roundtrip covered"],
  ["E", "Recipes/custom create/edit/simulate/enable/pause/delete", ["automationPresentation", "automationCommand", "simulateAutomation"], ui("AutomationCenter.tsx"), test("automation-retained-ui.test.tsx"), "Connected conditionally to genuine OPFS prerequisites: original held handles, catalog-proven native preflight/rollback and canonical/Merkle audit, exact DELETE/FULL three-file topology, unforgeable per-connection grant with bounded I/O. Lossless V2 editor, timezone and immutable retries preserved; no release certificate claimed"],
  ["E", "Due/manual execution, runtime/history/notifications/Undo", ["automationPresentation", "automationCommand", "simulateAutomation", "mutationOutcome", "cancelPresentation"], ui("AutomationCenter.tsx"), test("worker-automation-integration.test.ts"), "Connected: real WorkerClient/db-worker with installed browser WASM/SAHPool on owned protocol handles, not only memory DbDriver. Runtime grant is rechecked on execution and actual SAH I/O is bounded during reserve/invoke/commit/rollback. Retained due commands reconcile/terminalize before another ID; trusted-shell intake recovery and review/Undo/draft deferrals preserved. Browser certification deferred"],
  ["F", "Local Print/CSV and projection fencing", ["projectPlaintextV1", "cancelProjectionV1"], ui("ExportDialog.tsx"), test("export-dialog.test.tsx"), "Baseline preserved; integrated campaign deferred"],
  ["F", "Encrypted immutable read-only sharing and revocation", ["presentationSource", "projectPlaintextV1", "cancelProjectionV1", "attachmentsForRecord", "readAttachment"], "packages/shell/src/share/ShareDialog.tsx", test("share-custody.test.ts"), "Connected: exact reviewed worker projection/attachments, shell-only source/origin-bound IndexedDB custody before HTTP, immutable ciphertext/create/revoke intent, reload/retry, exact relay acknowledgement and expiry. Publication is authenticated and origin-allowlisted; no configured relay defaults. Exact tombstones precede fresh replacement. Old source-free localStorage receipts have no original catalog/route evidence: Recovery Center preserves them without reading private URLs and offers an independent reviewed share, never inherited ownership"],
  ["F", "Intake lifecycle/attachments/expiry/revoke/staging/review/delivery", ["intakePresentation", "intakeCommand", "mutationOutcome", "cancelPresentation"], ui("IntakeCenter.tsx"), test("worker-intake-integration.test.ts"), "Connected: source/request contexts, shell-only custody/HTTP, staging/review and reload. Proven cache-only work retains exact authority exclusion, tombstone and reviewed renewal protocols; active forms require revoke. Deleted-original publication recovery preserved. Provable legacy receipt custody now uses a sealed port; unprovable old state has an explicit safe compatibility journey. New V2 forms can coexist with preserved V1 state; unknown old invocations are not called closed"],
  ["F", "Intake auto-accept simulation/control/receipts/Undo", ["intakePresentation", "intakeCommand", "mutationOutcome", "cancelPresentation"], ui("IntakeCenter.tsx"), test("intake-ui.test.tsx"), "Connected: exact simulation-receipt target and immutable draft bind enable; file forms require manual review; enabled rules run on local inbox refresh; authority receipts and bounded Undo survive reload. Copied/forked metadata is read-only; no off-device claim. Real worker journey covers manual/auto accept, reject, duplicate processing and Undo"],
  ["F", "Public original-owner proof and deleted-original publication recovery", ["intakeOwnerWitness"], ui("OriginalOwnerRecovery.tsx"), test("worker-owner-recovery-integration.test.ts"), "Connected: Recovery Center discovers bounded public ledger keys, explicitly reviews catalog/history/route-anchored request and public response hashes, retains exact completed original deletion evidence before original vault/key readback and exact relay terminalization. No current-source rebase, key minting, response_json transport or active-form closure. Ambiguous/source-free private legacy and unproven generation loss stay quarantined"],
  ["F", "Sealed historical custody and bounded legacy compatibility", ["legacyOwnerInventory", "transferLegacyOwner", "intakeCommand", "mutationOutcome", "cancelPresentation"], ui("LegacyOwnerRecovery.tsx"), test("worker-legacy-owner-integration.test.ts"), "Connected: metadata-only closed history/route proof; exact response bytes validated privately and encrypted to an origin-bound owned shell port. Immutable vault commit/readback/key verification precedes owner use. Original-definition activation uses durable immutable request history, receipt-first retry and terminal cancellation before reviewed renewal. Missing original evidence/bytes, malformed state, old source-free shares and unproven generation loss remain explicit compatibility states, with originals preserved, app usability and independent new form/share/app actions; never fabricated ownership or closure"],
];
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
const head = git("rev-parse", "HEAD");
const changed = git("status", "--porcelain=v1");
const retiredBlock = source.slice(source.indexOf("export const RETIRED_DB_WORKER_ROUTES"), source.indexOf("export function productionWorkerRouteAvailable"));
const retired = new Map([...retiredBlock.matchAll(/^  (\w+): "([^"]+)",$/gm)].map(match => [match[1], match[2]]));
const disabledUiFlags = [...readFileSync(resolve(root, ui("App.tsx")), "utf8").matchAll(/(automationMutationsAvailable|dailyHomeMutationsAvailable|mutationsAvailable)=\{false\}/g)].map(match => match[1]);
if (disabledUiFlags.length || [...routes].some(([name, enforcement]) => enforcement === "unavailable" && !retired.has(name)))
  throw new Error("Source-development inventory still has a disabled intended surface or unretired route");
for (const [, capability, names, entry, focused] of entries) {
  for (const name of names) {
    if (!routes.has(name)) throw new Error(`${capability}: unknown route ${name}`);
    if (routes.get(name) === "unavailable") throw new Error(`${capability}: intended journey still names closed route ${name}`);
  }
  for (const file of [entry, focused]) if (!existsSync(resolve(root, file))) throw new Error(`Missing census input ${file}`);
}
console.log(JSON.stringify({
  kind: "development_inventory_not_certification", candidateHead: head,
  sourceAncestry: changed ? "HEAD plus uncommitted working-tree changes; not an immutable release" : "HEAD",
  testsExecutedByThisCommand: false, packagedBrowserProof: "deferred; no pass claimed",
  developmentComplete: true,
  completionMeaning: "Source/UI development complete under ADR-070 bounded legacy compatibility; NOT a tested release or shipment. Single integrated campaign is next.",
  terminalRelayBoundaries: {
    routes: ["POST /intake/forms/:formId/terminalize", "POST /shares/:shareId/terminalize"],
    enforcement: "Authenticated exact allowed Origin, original owner/request/capability identity, serialized tombstones until expiry, closed request-digest acknowledgement; 404/410 is not proof",
    shellWorkflow: "packages/shell/src/intake/workflows.ts",
    recovery: "New jobs commit before effects; proven original-custody cache-only publication uses permanent authority form exclusion, not the cache claim, against unknown delayed IDs. Revocation terminal metadata is immutable; reviewed renewal requires original cancel/readback and exact relay proof. Original requests, closure proofs and bounded workflow history survive reload",
    focusedTests: ["packages/backend/test/relay-terminal.test.ts", "packages/backend/test/intake-terminal-postgres.test.ts", "packages/backend/test/share-postgres.test.ts",
      test("intake-publication-terminal.test.ts"), test("intake-revocation-renewal.test.ts"), test("share-terminal.test.ts"), test("worker-intake-integration.test.ts")],
  },
  intakeAuthorityClosure: {
    workerRoute: "intakeCommand", authorityRoute: "intake.command", innerRoute: "intake.closePublication",
    storage: "Optional closed publicationClosures in intake_v2; canonical/archive participating, at most 100, never silently evicted",
    recovery: "Original app/generation/lineage and public definition; immutable request before effect, exact receipt replay, per-ID future save/publish exclusion. Stale closure renewal requires explicit reviewed target AND prior request, exact cancellation/readback and relay tombstone before retaining at most 8 chained immutable invocations. Original closure/renewal history and receipts survive cache/ledger readback. Does not relabel, delete or revoke a still-active form",
    focusedTests: ["packages/kernel/test/intake-v2-authority.test.ts", "packages/kernel/test/intake-archive-boundary.test.ts", test("intake-publication-terminal.test.ts"), test("worker-intake-integration.test.ts")],
  },
  opfsRecoveryDevelopment: {
    source: "packages/kernel/src/production-native-recovery.ts", productionBootCaller: true, capabilityGranted: "conditional_original_connection_only",
    scope: "Pinned 3.53.0-build1 native rollback before catalog migration/restore/lifecycle reads, under lifecycle exclusion and original SAHs. A disposable exact-path SQLite shadow validates the original closed modern/legacy catalog and all live targets before real rollback; exact readback follows. No global reserved-lock change. NOT physical browser certification",
    bounds: { shadowCorpusBytes: 64000000, automationIoCorpusBytes: 32000000, slots: 4096,
      behavior: "Oversized/unproven connections stay unavailable. Each original write/truncate is checked BEFORE I/O throughout automation reserve/invoke/commit/rollback; half-shadow headroom permits rollback with old journals. No user file is truncated to fit a capability." },
    focusedTests: ["packages/kernel/test/production-native-recovery.test.ts", "packages/kernel/test/sahpool-recovery.test.ts", test("worker-automation-integration.test.ts")],
    initialization: { source: "packages/kernel/src/sahpool-initialization.ts", productionCaller: "db.ts strictBrowserPool",
      behavior: "Same original exclusive SAHs handed to pinned SDK; duplicated valid names/pre-existing VFS/I/O uncertainty fail closed. Malformed/torn/cleared associations with retained payload are quarantined under held handles, never handed to SDK reuse. Missing catalog plus quarantine forbids replacement authority. Recovery Center exposes count-only quarantine and backup exclusion. Raw catalog/target opens still reject unproven sidecars before SQL",
      focusedTest: "packages/kernel/test/sahpool-initialization.test.ts" },
    remaining: "Integrated physical browser/crash certification deferred. Unexplained or legacy-unadopted tuples, uncertain slots and corpus over the explicit bounds remain fail-closed, not silently repaired or discarded",
  },
  developmentBlockers: [],
  compatibilityLimits: [
    "V1 intake without original catalog/reservation/route-anchored receipt evidence, absent exact response bytes, malformed envelopes and old source-free share receipts cannot establish owner authority. Preserve/quarantine; never inspect real values to guess ownership.",
    "Exact provable private history is sealed into shell custody; superseded or schema-stale definitions are custody-only. At most 32 historical responses (2,000,000 bytes each), eight immutable activation attempts per record, with exact terminal cancellation before renewal. Existing originals are never evicted to fit bounds.",
    "Original app/generation/custody loss without proof cannot be inferred terminal. Existing proven deleted-original publication protocol remains enabled. Unprovable work remains retained, not described as reconciled; current data remains usable and an independent new app/form/share is offered.",
    "Historical private app bytes remain export-denied even after adoption. New V2 metadata and key custody are separate; no silent stripping, deletion, source replacement, or secret-bearing archive is introduced.",
  ],
  custodyBoundaries: [{ phase: "F", source: "packages/shell/src/intake/owner-custody.browser.ts", productionUiCaller: true,
    recovery: "Immutable origin/app/generation/lineage/form custody, commit/readback and key proof precede publication; original IDs survive lost commit/worker/relay responses. Legacy material stays quarantined.",
    focusedTests: [test("intake-owner-custody.test.ts"), test("intake-owner-vault.browser.test.ts"), test("intake-publication.test.ts"), test("intake-workflows.test.ts"), test("intake-publication-terminal.test.ts"), test("worker-intake-integration.test.ts")] },
  { phase: "F", source: "packages/shell/src/share/owner-custody.browser.ts", productionUiCaller: true,
    recovery: "Atomic source/origin-bound custody CAS/readback before immutable ciphertext delivery, retained create/revoke retry; old localStorage receipt writers retired, original records untouched.",
    focusedTests: [test("share-custody.test.ts"), test("share-terminal.test.ts"), test("share-owner-ui.test.tsx"), test("worker-intake-integration.test.ts")] }],
  disabledUiFlags,
  unavailableRoutes: [...routes].filter(([, enforcement]) => enforcement === "unavailable")
    .map(([name]) => ({ name, retiredReason: retired.get(name) ?? null })),
  capabilities: entries.map(([phase, capability, names, entry, focused, status]) => ({
    phase, capability, routes: names.map(name => ({ name, enforcement: routes.get(name) })),
    uiEntry: entry, focusedTest: focused, status,
  })),
}, null, 2));
