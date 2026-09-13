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
  ["B", "Authenticated export and key-vault enrollment/Kit import/activation", ["collectArchiveSnapshot", "validateBackupStage"], ui("RecoveryCenter.tsx"), test("worker-daily-relation-integration.test.ts"), "Shell-only key vault; no restore or manual-download record completion claim"],
  ["B", "Folder selection and automatic prepare/readback/publish/retention", ["backupSelection", "backupRecords", "validateBackupStage", "publishBackup"], ui("production-backup.browser.ts"), test("worker-daily-relation-integration.test.ts"), "Partial: external permission/certification and remaining crash edges"],
  ["B", "Record/batch/structure recovery candidates", ["recoveryCandidates", "restoreRow", "undoBatch", "makeLatest"], ui("RecoveryCenter.tsx"), test("worker-daily-relation-integration.test.ts"), "Source connected; bounded recovery UI and packaged campaign remain"],
  ["B", "Authenticated restore-as-new", ["validateRestoreArchive", "restoreAsNew"], ui("RecoveryCenter.tsx"), test("recovery-center.test.tsx"), "Unimplemented lifecycle integration; controls gated"],
  ["C", "CSV/TSV/XLSX preview-first migration and Undo", ["beginImport", "stageImportChunk", "configureImport", "previewImport", "commitImport", "cancelImport", "undoImport"], ui("ImportWizard.tsx"), test("release-c-import-coordinator.test.ts"), "Preserved baseline; integrated campaign deferred"],
  ["C", "Text-to-relation shadow Preview/Keep/replay/rewind", ["previewRelationConversion", "convertTextToRelation", "makeLatest"], ui("RelationConversionDialog.tsx"), test("worker-daily-relation-integration.test.ts"), "Connected; dedicated bounded Undo and UI reload/retry audit remain"],
  ["D", "Source setup/timezone/favorites/recents", ["dailyHome", "dailyHomeSourceCompareAndSet", "dailyHomeNavigationCompareAndSet", "dailyHomeInitializeTimeZone"], ui("TodayView.tsx"), test("worker-daily-relation-integration.test.ts"), "Connected; Inbox/dispositions and stale projection audit remain"],
  ["D", "Quick Capture/date resolution/Undo", ["dailyHomeResolveDate", "dailyHomeQuickCapture", "dailyHomeUndoCapture"], ui("CommandPalette.tsx"), test("quick-capture.test.tsx"), "Connected; durable presentation-intent recovery across UI reload remains"],
  ["E", "Recipes/custom create/edit/simulate/enable/pause/delete", ["saveAutomationDraft", "saveAutomationRecipeDraft", "simulateAutomation", "enableAutomation", "pauseAutomation", "deleteAutomation"], ui("AutomationCenter.tsx"), test("automation-release-e-ui.test.tsx"), "Partial: UI mutation flags still false; edit and retry work remain"],
  ["E", "Due/manual execution, runtime/history/notifications/Undo", ["runAutomations", "runAutomationNow", "automationRuns", "automationRuntimeStatus", "undoAutomationRun", "markNotificationRead"], ui("AutomationCenter.tsx"), test("automation-enable.test.tsx"), "Authority baseline exists; complete user journey not yet enabled"],
  ["F", "Local Print/CSV and projection fencing", ["projectPlaintextV1", "cancelProjectionV1"], ui("ExportDialog.tsx"), test("export-dialog.test.tsx"), "Baseline preserved; integrated campaign deferred"],
  ["F", "Encrypted immutable read-only sharing and revocation", ["projectPlaintextV1"], ui("App.tsx"), test("share-security-integration.test.ts"), "Trusted-shell/backend route audit and configuration boundary work remain"],
  ["F", "Intake lifecycle/attachments/expiry/revoke/staging/review/delivery", ["saveIntakeForm", "markIntakeFormPublished", "revokeIntakeForm", "markIntakeFormExpired", "stageIntakeSubmission", "recordIntakeDeliveryFailure", "resolveIntakeDeliveryFailure", "acceptIntakeSubmission", "rejectIntakeSubmission"], ui("IntakeCenter.tsx"), test("intake-vertical.test.ts"), "Partial: secret custody and end-to-end UI/configuration reconciliation remain"],
  ["F", "Intake auto-accept simulation/control/receipts/Undo", ["simulateIntakeAutoAccept", "enableIntakeAutoAccept", "disableIntakeAutoAccept", "processIntakeAutoAccept", "intakeReceipts", "undoIntakeReceipt"], ui("IntakeCenter.tsx"), test("intake-ui.test.tsx"), "Authority baseline exists; final journey not established"],
];
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
const head = git("rev-parse", "HEAD");
const changed = git("status", "--porcelain=v1");
for (const [, capability, names, entry, focused] of entries) {
  for (const name of names) if (!routes.has(name)) throw new Error(`${capability}: unknown route ${name}`);
  for (const file of [entry, focused]) if (!existsSync(resolve(root, file))) throw new Error(`Missing census input ${file}`);
}
console.log(JSON.stringify({
  kind: "development_inventory_not_certification", candidateHead: head,
  sourceAncestry: changed ? "HEAD plus uncommitted working-tree changes; not an immutable release" : "HEAD",
  testsExecutedByThisCommand: false, packagedBrowserProof: "deferred; no pass claimed",
  developmentComplete: false,
  capabilities: entries.map(([phase, capability, names, entry, focused, status]) => ({
    phase, capability, routes: names.map(name => ({ name, enforcement: routes.get(name) })),
    uiEntry: entry, focusedTest: focused, status,
  })),
}, null, 2));
