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
  ["B", "Record/batch/structure recovery candidates", ["recoveryCandidates", "restoreRow", "undoBatch", "makeLatest"], ui("RecoveryCenter.tsx"), test("worker-daily-relation-integration.test.ts"), "Source connected; bounded recovery UI and packaged campaign remain"],
  ["B", "Authenticated restore-as-new", ["validateRestoreArchive", "restoreAsNew"], ui("RecoveryCenter.tsx"), test("worker-restore-integration.test.ts"), "Connected: private authentication, fresh catalog job, fenced install/recovery, exact receipts and retained UI retry; packaged proof deferred"],
  ["C", "CSV/TSV/XLSX preview-first migration and Undo", ["beginImport", "stageImportChunk", "configureImport", "previewImport", "commitImport", "cancelImport", "undoImport"], ui("ImportWizard.tsx"), test("release-c-import-coordinator.test.ts"), "Preserved baseline; integrated campaign deferred"],
  ["C", "Text-to-relation shadow Preview/Keep/replay/Undo", ["previewRelationConversion", "convertTextToRelation", "mutationOutcome", "cancelPresentation", "undoRelationConversion"], ui("RelationConversionDialog.tsx"), test("relation-conversion-recovery.test.tsx"), "Connected: original-result-bound immutable Keep/Undo; Keep linked records first terminalizes Undo; ambiguous outcomes retained; exact bounded inverse, no rebase"],
  ["D", "Source setup/timezone/favorites/recents", ["dailyPresentation", "dailyHomeSourceCompareAndSet", "dailyHomeNavigationCompareAndSet", "dailyHomeInitializeTimeZone"], ui("TodayView.tsx"), test("worker-daily-relation-integration.test.ts"), "Connected: paired authority/projection, original source and semantic IDs, revision and immutable desired-value CAS retained across reload; explicit Retry/Cancel without retoggle or rebase"],
  ["D", "Quick Capture/date resolution/Undo", ["dailyHomeResolveDate", "dailyHomeQuickCapture", "dailyHomeUndoCapture", "mutationOutcome", "cancelPresentation"], ui("CommandPalette.tsx"), test("quick-capture.test.tsx"), "Connected: Undo identity persisted before presentation, original app/generation/source/table/batch/payload/receipt binding, exact unchanged-target inverse; original outcome reconciliation or terminal cancellation required before replacement"],
  ["D", "Inbox/Complete/Snooze/Dismiss/Undo", ["dailyPresentation", "dailyInboxAction", "dailyInboxUndo", "mutationOutcome", "cancelPresentation"], ui("TodayView.tsx"), "packages/kernel/test/daily-inbox-authority.test.ts", "Connected: closed physical disposition table and global CAS tokens, canonical/archive copy, exact item/action/projection CAS, local-day Snooze, original-target bounded Undo; real worker archive roundtrip covered"],
  ["E", "Recipes/custom create/edit/simulate/enable/pause/delete", ["automationPresentation", "automationCommand", "simulateAutomation"], ui("AutomationCenter.tsx"), test("automation-retained-ui.test.tsx"), "Conditional: lossless V2 editor, persisted recipe/custom draft and semantic mappings, per-rule timezone, immutable command/receipt/Retry/Cancel connected; actual OPFS transaction capability still unavailable"],
  ["E", "Due/manual execution, runtime/history/notifications/Undo", ["automationPresentation", "automationCommand", "simulateAutomation", "mutationOutcome", "cancelPresentation"], ui("AutomationCenter.tsx"), test("worker-automation-integration.test.ts"), "Conditional: real worker owned-memory journey; retained due requests reconcile/terminalize before another ID. Local checks defer for retained review/Undo/draft/intake. Manual preview/confirm, history, notifications and Undo connected. OPFS capability gate remains closed"],
  ["F", "Local Print/CSV and projection fencing", ["projectPlaintextV1", "cancelProjectionV1"], ui("ExportDialog.tsx"), test("export-dialog.test.tsx"), "Baseline preserved; integrated campaign deferred"],
  ["F", "Encrypted immutable read-only sharing and revocation", ["presentationSource", "projectPlaintextV1", "cancelProjectionV1", "attachmentsForRecord", "readAttachment"], "packages/shell/src/share/ShareDialog.tsx", test("share-custody.test.ts"), "Connected for new shares: exact reviewed worker projection/attachments, shell-only source/origin-bound IndexedDB custody before HTTP, immutable ciphertext/create/revoke intent, reload/retry, exact relay acknowledgement and expiry. Publication is authenticated and origin-allowlisted; no configured relay defaults. Prepared/expired recovery uses exact relay tombstones before fresh reviewed replacement; legacy receipt adoption remains code work"],
  ["F", "Intake lifecycle/attachments/expiry/revoke/staging/review/delivery", ["intakePresentation", "intakeCommand", "mutationOutcome", "cancelPresentation"], ui("IntakeCenter.tsx"), test("worker-intake-integration.test.ts"), "New V2 production path connected: secret-free metadata, closed original-source commands, shell-only custody/decryption/HTTP, retained form/save/publish/revoke IDs, bounded delivery/partial files, review, reload and readback. Legacy rows/secret-bearing receipts are quarantined/export-denied, never silently migrated. New public-only IndexedDB CAS jobs survive cache loss; explicit Close cancels original worker IDs and verifies exact remote terminal receipts. Cache-only legacy work is unfenced/quarantined, not silently adopted; legacy adoption and stale local-revocation renewal remain"],
  ["F", "Intake auto-accept simulation/control/receipts/Undo", ["intakePresentation", "intakeCommand", "mutationOutcome", "cancelPresentation"], ui("IntakeCenter.tsx"), test("intake-ui.test.tsx"), "Connected: exact simulation-receipt target and immutable draft bind enable; file forms require manual review; enabled rules run on local inbox refresh; authority receipts and bounded Undo survive reload. Copied/forked metadata is read-only; no off-device claim. Real worker journey covers manual/auto accept, reject, duplicate processing and Undo"],
];
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
const head = git("rev-parse", "HEAD");
const changed = git("status", "--porcelain=v1");
const retiredBlock = source.slice(source.indexOf("export const RETIRED_DB_WORKER_ROUTES"), source.indexOf("export function productionWorkerRouteAvailable"));
const retired = new Map([...retiredBlock.matchAll(/^  (\w+): "([^"]+)",$/gm)].map(match => [match[1], match[2]]));
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
  developmentComplete: false,
  terminalRelayBoundaries: {
    routes: ["POST /intake/forms/:formId/terminalize", "POST /shares/:shareId/terminalize"],
    enforcement: "Authenticated exact allowed Origin, original owner/request/capability identity, serialized tombstones until expiry, closed request-digest acknowledgement; 404/410 is not proof",
    shellWorkflow: "packages/shell/src/intake/workflows.ts",
    recovery: "New jobs commit before presentation/effects; original worker IDs terminalize before replacement; cache-only legacy work is quarantined, not promoted to fenced authority",
    focusedTests: ["packages/backend/test/relay-terminal.test.ts", "packages/backend/test/intake-terminal-postgres.test.ts", "packages/backend/test/share-postgres.test.ts",
      test("intake-publication-terminal.test.ts"), test("share-terminal.test.ts"), test("worker-intake-integration.test.ts")],
  },
  developmentBlockers: [
    { phase: "E", kind: "code", boundary: "Production OPFS physical automation transaction capability is unavailable; the test_memory certificate is not a production certificate. Preserve the guard." },
    { phase: "F", kind: "code", boundary: "Legacy intake custody/state/historical receipt, cache-only unfenced workflow, and old sharing-receipt adoption remain unimplemented. Originals are untouched/quarantined and legacy archive export denied. New durable-ledger publication/sharing terminalization is connected. Stale pre-invocation local revocation still needs explicit reviewed renewal after terminal proof; wrong generation/original-source recovery remains fail-closed." },
  ],
  custodyBoundaries: [{ phase: "F", source: "packages/shell/src/intake/owner-custody.browser.ts", productionUiCaller: true,
    recovery: "Immutable origin/app/generation/lineage/form custody, commit/readback and key proof precede publication; original IDs survive lost commit/worker/relay responses. Legacy material stays quarantined.",
    focusedTests: [test("intake-owner-custody.test.ts"), test("intake-owner-vault.browser.test.ts"), test("intake-publication.test.ts"), test("intake-workflows.test.ts"), test("intake-publication-terminal.test.ts"), test("worker-intake-integration.test.ts")] },
  { phase: "F", source: "packages/shell/src/share/owner-custody.browser.ts", productionUiCaller: true,
    recovery: "Atomic source/origin-bound custody CAS/readback before immutable ciphertext delivery, retained create/revoke retry; old localStorage receipt writers retired, original records untouched.",
    focusedTests: [test("share-custody.test.ts"), test("share-terminal.test.ts"), test("share-owner-ui.test.tsx"), test("worker-intake-integration.test.ts")] }],
  disabledUiFlags: [...readFileSync(resolve(root, ui("App.tsx")), "utf8").matchAll(/(automationMutationsAvailable|dailyHomeMutationsAvailable|mutationsAvailable)=\{false\}/g)].map(match => match[1]),
  unavailableRoutes: [...routes].filter(([, enforcement]) => enforcement === "unavailable")
    .map(([name]) => ({ name, retiredReason: retired.get(name) ?? null })),
  capabilities: entries.map(([phase, capability, names, entry, focused, status]) => ({
    phase, capability, routes: names.map(name => ({ name, enforcement: routes.get(name) })),
    uiEntry: entry, focusedTest: focused, status,
  })),
}, null, 2));
