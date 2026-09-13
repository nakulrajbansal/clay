import { chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { assertTestOrigin, rejectExternalBrowser, markOwnedContext, assertOwnedPage } from "./p0-browser-safety.mjs";
import { buildP0Candidate, snapshotBuildInputs } from "./p0-source-binding.mjs";

rejectExternalBrowser(process.env);

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const shellDir = new URL("../packages/shell/", import.meta.url);
const distDir = new URL("../packages/shell/dist/", import.meta.url);
const outputDir = new URL("../evidence/p0-multi-app-ui/", import.meta.url);
const reportFile = new URL("report.json", outputDir);
const port = Number.parseInt(process.env.PORT || "4181", 10);
const url = assertTestOrigin(`http://127.0.0.1:${port}`);
let server = null;
let serverOutput = "";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const mapFingerprint = map => sha256(Buffer.from(JSON.stringify(map)));
async function artifactHashes(directory, root = directory, result = {}) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
    if (entry.isDirectory()) await artifactHashes(child, root, result);
    else {
      const relative = decodeURIComponent(child.href.slice(root.href.length));
      result[relative] = sha256(await readFile(child));
    }
  }
  return result;
}
async function allArtifactHashes() {
  const shell = await artifactHashes(distDir);
  const panel = await artifactHashes(new URL("../packages/panel-runtime/dist/", import.meta.url));
  for (const [name, digest] of Object.entries(panel)) shell[`@panel-runtime/${name}`] = digest;
  return shell;
}
const git = args => execFileSync("git", args, {
  cwd: projectRoot, encoding: "utf8", windowsHide: true,
}).trim();

await mkdir(outputDir, { recursive: true });
const baseHead = git(["rev-parse", "HEAD"]);
await writeFile(reportFile, JSON.stringify({ verdict: "INVALIDATED", status: "BUILDING_REVIEWED_SOURCE", baseHead }, null, 2));
let sourceSha256;
try {
  sourceSha256 = await buildP0Candidate(projectRoot, new URL("build.log", outputDir));
} catch (error) {
  await writeFile(reportFile, JSON.stringify({ verdict: "INVALIDATED", status: "SOURCE_BUILD_BLOCKED", baseHead,
    failures: [error.message], releaseCertificate: false }, null, 2));
  throw error;
}
const artifactSha256 = await allArtifactHashes();
const testedSourceFingerprint = mapFingerprint(sourceSha256);
const testedArtifactFingerprint = mapFingerprint(artifactSha256);
await writeFile(reportFile, JSON.stringify({
  schema: 1,
  verdict: "INVALIDATED",
  status: "RUNNING",
  baseHead,
  testedSourceFingerprint,
  testedArtifactFingerprint,
}, null, 2));

if (!process.env.URL) {
  const vite = fileURLToPath(new URL("node_modules/vite/bin/vite.js", shellDir));
  server = spawn(process.execPath, [vite, "preview", "--host", "127.0.0.1",
    "--port", String(port), "--strictPort"], {
    cwd: fileURLToPath(shellDir),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", chunk => { serverOutput += String(chunk); });
  server.stderr.on("data", chunk => { serverOutput += String(chunk); });
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (server.exitCode !== null) break;
    if (!serverOutput.includes(`127.0.0.1:${port}`)) {
      await new Promise(resolve => setTimeout(resolve, 100));
      continue;
    }
    try { if ((await fetch(url)).ok) { ready = true; break; } } catch { /* retry startup */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error(`packaged preview did not start: ${serverOutput}`);
}
process.on("exit", () => { try { server?.kill(); } catch { /* stopped */ } });

let browser;
try {
  browser = await chromium.launch({
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : { channel: "chrome" }),
    chromiumSandbox: true,
    timeout: 30_000,
  });
} catch (error) {
    const failure = `owned sandboxed Chromium launch failed: ${error.message}`;
    const endingSourceFingerprint = mapFingerprint(await snapshotBuildInputs(projectRoot));
    const endingArtifactFingerprint = mapFingerprint(await allArtifactHashes());
    const blockedReport = {
      schema: 1,
      verdict: "INVALIDATED",
      status: "BROWSER_LAUNCH_BLOCKED",
      releaseCertificate: false,
      generatedAt: new Date().toISOString(),
      url,
      baseHead,
      testedSourceFingerprint,
      endingSourceFingerprint,
      testedArtifactFingerprint,
      endingArtifactFingerprint,
      sourceSha256,
      artifactSha256,
      evidence: {
        browserLaunch: {
          mode: "owned-process-fresh-context", chromiumSandbox: true,
        },
      },
      failures: [failure],
      limitations: [
        "No existing browser session was attached to or stopped.",
        "No browser-sandbox disabling flag was used.",
        "This blocked report is not packaged-browser proof and does not certify P0.",
      ],
    };
    await writeFile(reportFile, JSON.stringify(blockedReport, null, 2));
    if (server) server.kill();
    console.error(JSON.stringify({
      verdict: blockedReport.verdict,
      status: blockedReport.status,
      failures: blockedReport.failures,
      report: "evidence/p0-multi-app-ui/report.json",
    }));
    process.exit(1);
}
const context = await browser.newContext();
await markOwnedContext(context);
const page = await context.newPage();
page.setDefaultTimeout(45_000);
const consoleErrors = [];
page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("pageerror", error => consoleErrors.push(error.message));

const requiredCases = [
  "firstRunStarter",
  "secondAppStarter",
  "switchKeepsAppDataSeparate",
  "renameSurvivesReload",
  "duplicateCopiesHistoryAndPanels",
  "duplicateWritesAreIndependent",
  "deleteUsesExplicitConfirmation",
  "spreadsheetPreviewBeforeCreation",
  "spreadsheetDiscardSurvivesReload",
  "newAppImportReadback",
  "newAppImportUndo",
  "selectionAndUndoSurviveReload",
  "sourceBytesStable",
  "renderedSourceBinding",
  "artifactBytesStable",
];
const cases = Object.fromEntries(requiredCases.map(name => [name, false]));
const evidence = { screenshots: [] };
evidence.browserLaunch = {
  mode: "owned-process-fresh-context", chromiumSandbox: true,
};
const failures = [];
const certify = (name, condition, detail) => {
  cases[name] = Boolean(condition);
  if (!condition) failures.push(`${name}: ${detail}`);
};
const invariant = (condition, message) => {
  if (!condition) throw new Error(message);
};
const screenshot = async name => {
  const file = new URL(`${name}.png`, outputDir);
  await page.screenshot({ path: fileURLToPath(file), fullPage: true });
  evidence.screenshots.push(`evidence/p0-multi-app-ui/${name}.png`);
};
const currentButton = () => page.locator(".appbar-current");
const waitForCurrent = async name => {
  await currentButton().waitFor({ state: "visible" });
  await page.waitForFunction(expected =>
    document.querySelector(".appbar-current")?.textContent?.includes(expected), name);
};
const openAppMenu = async () => {
  await currentButton().click();
  await page.locator(".appbar-menu").waitFor({ state: "visible" });
};
const visibleCatalogNames = async () => page.locator(".appbar-menu").evaluate(menu => {
  const names = [];
  for (const child of menu.children) {
    if (child.classList.contains("appbar-sep")) break;
    if (child.tagName === "BUTTON") names.push(child.textContent.trim());
  }
  return names;
});
const chooseMenu = async pattern => {
  const candidate = page.locator(".appbar-menu button.appbar-item")
    .filter({ hasText: pattern }).last();
  await candidate.click();
};
const chooseCustomize = async () => {
  const customize = page.getByRole("button", { name: "Customize", exact: true });
  if ((await customize.getAttribute("aria-pressed")) !== "true") await customize.click();
};
const panelTitles = async () => page.locator(".panel-title-text").allTextContents();
const panelText = async title => {
  const frame = page.frameLocator(`iframe[title="${title}"]`);
  await frame.locator("body").waitFor({ state: "visible" });
  return frame.locator("body").innerText();
};
const versionText = async () => page.locator(".appbar-trust").innerText();

try {
  const neutralArtifact = Object.keys(artifactSha256).find(path => path.endsWith(".css"));
  invariant(neutralArtifact, "the production build has no neutral same-origin artifact");
  await page.goto(new URL(neutralArtifact, `${url}/`).href, { waitUntil: "domcontentloaded" });
  await assertOwnedPage(page);
  // Fresh contexts must be empty. Never clear an existing origin, even in a test.
  await page.evaluate(async () => {
    if (localStorage.length || sessionStorage.length) throw new Error("disposable context is not empty");
    const storage = navigator.storage;
    const getDirectory = storage.getDirectory;
    if (!getDirectory) throw new Error("OPFS is unavailable in the packaged browser");
    const root = await getDirectory.call(storage);
    for await (const _ of root.entries()) throw new Error("disposable OPFS is not empty");
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await assertOwnedPage(page);
  const renderedIdentity = await page.locator('meta[name="clay-source-fingerprint"]').getAttribute("content");
  invariant(renderedIdentity === testedSourceFingerprint, "preview is not the reviewed source build");
  certify("renderedSourceBinding", true, "rendered source binding matched");
  await page.getByRole("heading", { name: "Welcome to Clay" }).waitFor();
  await page.getByRole("button", { name: /Use a recommended starter/ }).click();
  await waitForCurrent("Tracker");
  await chooseCustomize();
  await page.locator(".panel-title-text", { hasText: "Progress" }).waitFor();
  const trackerTitles = await panelTitles();
  const trackerVersion = await versionText();
  certify("firstRunStarter",
    trackerTitles.includes("Progress") && trackerTitles.includes("Items")
      && /version\s+1/i.test(trackerVersion),
    `Tracker did not read back its starter: ${JSON.stringify({ trackerTitles, trackerVersion })}`);
  await screenshot("01-tracker-starter");

  await openAppMenu();
  await chooseMenu("+ New app");
  await page.getByRole("heading", { name: "Create another app" }).waitFor();
  await page.getByRole("button", { name: /See all templates/ }).click();
  await page.locator("#starter-gallery button.shell-card", { hasText: "Inventory" }).click();
  await waitForCurrent("Inventory");
  await chooseCustomize();
  await page.locator(".panel-title-text", { hasText: "Stock at a glance" }).waitFor();
  const inventoryTitles = await panelTitles();
  const inventoryVersion = await versionText();
  certify("secondAppStarter",
    inventoryTitles.includes("Stock at a glance") && inventoryTitles.includes("All products")
      && !inventoryTitles.includes("Progress") && /version\s+1/i.test(inventoryVersion),
    `Inventory did not read back independently: ${JSON.stringify({ inventoryTitles, inventoryVersion })}`);

  await openAppMenu();
  await chooseMenu("Rename");
  const renameInput = page.locator(".appbar-rename input");
  await renameInput.fill("Warehouse Ops");
  await page.locator(".appbar-rename button", { hasText: "Save" }).click();
  await waitForCurrent("Warehouse Ops");
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForCurrent("Warehouse Ops");
  await chooseCustomize();
  await page.locator(".panel-title-text", { hasText: "All products" }).waitFor();
  certify("renameSurvivesReload", (await currentButton().innerText()).includes("Warehouse Ops"),
    `renamed app did not survive reload: ${await currentButton().innerText()}`);
  await screenshot("02-renamed-inventory");

  await openAppMenu();
  await chooseMenu(/^Tracker/);
  await waitForCurrent("Tracker");
  await chooseCustomize();
  await page.locator(".panel-title-text", { hasText: "Progress" }).waitFor();
  const trackerAfterSwitch = await panelTitles();
  await openAppMenu();
  await chooseMenu(/^Warehouse Ops/);
  await waitForCurrent("Warehouse Ops");
  await chooseCustomize();
  await page.locator(".panel-title-text", { hasText: "Stock at a glance" }).waitFor();
  const inventoryAfterSwitch = await panelTitles();
  certify("switchKeepsAppDataSeparate",
    trackerAfterSwitch.includes("Progress") && !trackerAfterSwitch.includes("Stock at a glance")
      && inventoryAfterSwitch.includes("Stock at a glance")
      && !inventoryAfterSwitch.includes("Progress"),
    `starter state crossed apps: ${JSON.stringify({ trackerAfterSwitch, inventoryAfterSwitch })}`);

  const sourceTitles = await panelTitles();
  const sourceVersion = await versionText();
  await openAppMenu();
  await chooseMenu("Duplicate");
  await waitForCurrent("Warehouse Ops (copy)");
  await chooseCustomize();
  await page.locator(".panel-title-text", { hasText: "All products" }).waitFor();
  const copiedTitles = await panelTitles();
  const copiedVersion = await versionText();
  certify("duplicateCopiesHistoryAndPanels",
    JSON.stringify(copiedTitles) === JSON.stringify(sourceTitles)
      && copiedVersion === sourceVersion,
    `duplicate did not copy history/panels: ${JSON.stringify({ sourceTitles, copiedTitles, sourceVersion, copiedVersion })}`);

  const addProduct = page.frameLocator('iframe[title="add_product"]');
  await addProduct.getByLabel("Product", { exact: true }).fill("Fork-only Widget");
  await addProduct.getByLabel("SKU", { exact: true }).fill("FORK-001");
  await addProduct.getByRole("button", { name: "Add product", exact: true }).click();
  await page.locator(".toast", { hasText: "Product added" }).waitFor();
  await page.frameLocator('iframe[title="inv_table"]')
    .getByText("Fork-only Widget", { exact: true }).waitFor();
  const forkTable = await panelText("inv_table");
  await screenshot("03-duplicate-independent-row");
  await openAppMenu();
  await chooseMenu(/^Warehouse Ops$/);
  await waitForCurrent("Warehouse Ops");
  await chooseCustomize();
  await page.locator(".panel-title-text", { hasText: "All products" }).waitFor();
  const sourceTable = await panelText("inv_table");
  certify("duplicateWritesAreIndependent",
    forkTable.includes("Fork-only Widget") && !sourceTable.includes("Fork-only Widget"),
    `duplicate write crossed into its source: ${JSON.stringify({ forkTable, sourceTable })}`);

  await openAppMenu();
  await chooseMenu(/^Warehouse Ops \(copy\)$/);
  await waitForCurrent("Warehouse Ops (copy)");
  await openAppMenu();
  await chooseMenu("Delete");
  const confirm = page.getByRole("button", { name: "Confirm", exact: true });
  await confirm.waitFor();
  evidence.deleteConfirmationText = await page.locator("#confirm-message").innerText();
  await confirm.click();
  await page.waitForFunction(() => {
    const current = document.querySelector(".appbar-current")?.textContent ?? "";
    return current.length > 0 && !current.includes("Warehouse Ops (copy)");
  });
  await openAppMenu();
  const menuAfterDelete = await page.locator(".appbar-menu").innerText();
  const appsBeforePreview = await visibleCatalogNames();
  await page.locator(".appbar-backdrop").click();
  certify("deleteUsesExplicitConfirmation",
    /cannot be undone/i.test(evidence.deleteConfirmationText)
      && !menuAfterDelete.includes("Warehouse Ops (copy)"),
    `duplicate deletion was not confirmed/read back: ${JSON.stringify({ confirmation: evidence.deleteConfirmationText, menuAfterDelete })}`);

  await openAppMenu();
  await chooseMenu("+ New app");
  await page.getByRole("heading", { name: "Create another app" }).waitFor();
  await page.locator('input[type="file"]').setInputFiles({
    name: "expenses.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("Item,Amount\nCoffee,4.50\nRent,1200\n", "utf8"),
  });
  await page.getByRole("heading", { name: "Bring in expenses.csv" }).waitFor();
  const reviewText = await page.locator(".import-review").innerText();
  certify("spreadsheetPreviewBeforeCreation",
    reviewText.includes("No records have changed. No additional app has been created for this import.")
      && reviewText.includes("Rows accepted") && reviewText.includes("2"),
    `spreadsheet review was incomplete: ${reviewText}`);
  await screenshot("04-spreadsheet-review");
  await page.getByRole("button", { name: "Go back", exact: true }).click();
  await page.getByRole("button", { name: "Back to my apps", exact: true }).click();
  await page.reload({ waitUntil: "domcontentloaded" });
  await currentButton().waitFor({ state: "visible" });
  await openAppMenu();
  const appsAfterDiscard = await visibleCatalogNames();
  evidence.discardCatalogReadback = { before: appsBeforePreview, afterReload: appsAfterDiscard };
  certify("spreadsheetDiscardSurvivesReload", JSON.stringify(appsAfterDiscard) === JSON.stringify(appsBeforePreview),
    "discarding the spreadsheet preview changed the durable catalog after reload");
  await chooseMenu("+ New app");
  await page.getByRole("heading", { name: "Create another app" }).waitFor();
  await page.locator('input[type="file"]').setInputFiles({
    name: "expenses.csv", mimeType: "text/csv", buffer: Buffer.from("Item,Amount\nCoffee,4.50\nRent,1200\n", "utf8"),
  });
  await page.getByRole("heading", { name: "Bring in expenses.csv" }).waitFor();
  await page.getByRole("button", { name: "Import accepted rows (2)", exact: true }).click();
  await waitForCurrent("expenses");
  await page.locator(".toast", { hasText: "Imported 2 rows into a new app" }).waitFor();
  await page.locator(".panel-title-text", { hasText: "expenses" }).waitFor();
  const importedTable = await panelText("expenses_view");
  certify("newAppImportReadback",
    importedTable.includes("Coffee") && importedTable.includes("Rent"),
    `imported records did not read back in the packaged UI: ${importedTable}`);
  await screenshot("05-import-readback");

  await page.locator(".toast button", { hasText: "Undo" }).click();
  await page.locator(".toast", { hasText: "Import undone" }).waitFor();
  await page.locator(".empty-canvas", { hasText: "What do you want to build?" }).waitFor();
  certify("newAppImportUndo",
    (await page.locator(".panel-title-text").count()) === 0,
    "import Undo left a live panel behind");
  await screenshot("06-import-undone");

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForCurrent("expenses");
  await chooseCustomize();
  await page.locator(".empty-canvas", { hasText: "What do you want to build?" }).waitFor();
  certify("selectionAndUndoSurviveReload",
    (await currentButton().innerText()).includes("expenses")
      && (await page.locator(".panel-title-text").count()) === 0,
    "selected empty imported app did not survive reload");
  await screenshot("07-reloaded-empty-import-app");
} catch (error) {
  failures.push(`journey aborted: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  try { await screenshot("failure"); } catch { /* primary error remains */ }
}

const endingSourceSha256 = await snapshotBuildInputs(projectRoot);
const endingArtifactSha256 = await allArtifactHashes();
const endingSourceFingerprint = mapFingerprint(endingSourceSha256);
const endingArtifactFingerprint = mapFingerprint(endingArtifactSha256);
certify("sourceBytesStable",
  testedSourceFingerprint === endingSourceFingerprint,
  `source changed during UI journey: ${testedSourceFingerprint} -> ${endingSourceFingerprint}`);
certify("artifactBytesStable",
  testedArtifactFingerprint === endingArtifactFingerprint,
  `packaged bytes changed during UI journey: ${testedArtifactFingerprint} -> ${endingArtifactFingerprint}`);

const valid = failures.length === 0 && consoleErrors.length === 0
  && requiredCases.every(name => cases[name] === true);
const report = {
  schema: 1,
  verdict: valid ? "PACKAGED_LIFECYCLE_UI_PASSED" : "INVALIDATED",
  releaseCertificate: false,
  generatedAt: new Date().toISOString(),
  browser: await browser.version(),
  url,
  baseHead,
  testedSourceFingerprint,
  endingSourceFingerprint,
  testedArtifactFingerprint,
  endingArtifactFingerprint,
  sourceSha256,
  artifactSha256,
  cases,
  evidence,
  failures,
  consoleErrors,
  limitations: [
    "This is the packaged Chromium P0 journey; cross-engine release certification remains out of scope.",
    "The mission tree cannot be committed, so SHA-256 hashes bind dirty source and artifact bytes rather than a Git tree object.",
    "This report covers only the listed UI cases. It does not certify P0, Release B, or the roadmap.",
    "Legacy OPFS adoption and interrupted physical cleanup need their own current browser proof; unit/transport fixtures do not substitute for it.",
  ],
};
await writeFile(reportFile, JSON.stringify(report, null, 2));
await browser.close();
if (server) server.kill();
console.log(JSON.stringify({
  verdict: report.verdict,
  releaseCertificate: false,
  testedSourceFingerprint,
  testedArtifactFingerprint,
  cases,
  failures,
  consoleErrors,
  screenshots: evidence.screenshots,
  report: "evidence/p0-multi-app-ui/report.json",
}));
if (!valid) process.exit(1);
