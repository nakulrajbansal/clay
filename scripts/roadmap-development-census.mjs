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
  ["E", "Due/manual execution, runtime/history/notifications/Undo", ["automationPresentation", "automationCommand", "simulateAutomation"], ui("AutomationCenter.tsx"), test("worker-automation-integration.test.ts"), "Conditional: real worker owned-memory journey passes; source-bound retained due tick, manual preview/confirm, history, notifications and Undo connected. Local checks defer for retained review/Undo/draft. OPFS capability gate remains closed"],
  ["F", "Local Print/CSV and projection fencing", ["projectPlaintextV1", "cancelProjectionV1"], ui("ExportDialog.tsx"), test("export-dialog.test.tsx"), "Baseline preserved; integrated campaign deferred"],
  ["F", "Encrypted immutable read-only sharing and revocation", ["projectPlaintextV1"], ui("App.tsx"), test("share-security-integration.test.ts"), "Trusted-shell/backend route audit and configuration boundary work remain"],
  ["F", "Intake lifecycle/attachments/expiry/revoke/staging/review/delivery", ["saveIntakeForm", "markIntakeFormPublished", "revokeIntakeForm", "markIntakeFormExpired", "stageIntakeSubmission", "recordIntakeDeliveryFailure", "resolveIntakeDeliveryFailure", "acceptIntakeSubmission", "rejectIntakeSubmission"], ui("IntakeCenter.tsx"), test("intake-vertical.test.ts"), "Partial: secret-free V2 metadata and origin/source-bound shell custody foundation tested, but legacy private/token DB contracts and UI callers are NOT migrated. Do not claim new custody is the production path"],
  ["F", "Intake auto-accept simulation/control/receipts/Undo", ["simulateIntakeAutoAccept", "enableIntakeAutoAccept", "disableIntakeAutoAccept", "processIntakeAutoAccept", "intakeReceipts", "undoIntakeReceipt"], ui("IntakeCenter.tsx"), test("intake-ui.test.tsx"), "Authority baseline exists; final journey not established"],
];
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
const head = git("rev-parse", "HEAD");
const changed = git("status", "--porcelain=v1");
const retiredBlock = source.slice(source.indexOf("export const RETIRED_DB_WORKER_ROUTES"), source.indexOf("export function productionWorkerRouteAvailable"));
const retired = new Map([...retiredBlock.matchAll(/^  (\w+): "([^"]+)",$/gm)].map(match => [match[1], match[2]]));
for (const [, capability, names, entry, focused] of entries) {
  for (const name of names) if (!routes.has(name)) throw new Error(`${capability}: unknown route ${name}`);
  for (const file of [entry, focused]) if (!existsSync(resolve(root, file))) throw new Error(`Missing census input ${file}`);
}
console.log(JSON.stringify({
  kind: "development_inventory_not_certification", candidateHead: head,
  sourceAncestry: changed ? "HEAD plus uncommitted working-tree changes; not an immutable release" : "HEAD",
  testsExecutedByThisCommand: false, packagedBrowserProof: "deferred; no pass claimed",
  developmentComplete: false,
  developmentBlockers: [
    { phase: "E", kind: "code", boundary: "Production OPFS physical automation transaction capability is unavailable; the test_memory certificate is not a production certificate. Preserve the guard." },
    { phase: "F", kind: "code", boundary: "Integrate V2 secret-free intake metadata and trusted-shell custody with safe legacy state/receipt handling, exact immutable worker commands, publication/delivery/review/Undo UI and sharing source/configuration boundaries." },
  ],
  partialFoundations: [{ phase: "F", source: "packages/shell/src/intake/owner-custody.browser.ts", productionUiCaller: false,
    recovery: "Immutable origin/app/generation/lineage/form custody, commit/readback, key-pair proof, conflict and ambiguous commit recovery; legacy app data untouched",
    focusedTests: [test("intake-owner-custody.test.ts"), test("intake-owner-vault.browser.test.ts")] }],
  disabledUiFlags: [...readFileSync(resolve(root, ui("App.tsx")), "utf8").matchAll(/(automationMutationsAvailable|dailyHomeMutationsAvailable|mutationsAvailable)=\{false\}/g)].map(match => match[1]),
  unavailableRoutes: [...routes].filter(([, enforcement]) => enforcement === "unavailable")
    .map(([name]) => ({ name, retiredReason: retired.get(name) ?? null })),
  capabilities: entries.map(([phase, capability, names, entry, focused, status]) => ({
    phase, capability, routes: names.map(name => ({ name, enforcement: routes.get(name) })),
    uiEntry: entry, focusedTest: focused, status,
  })),
}, null, 2));
