import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright";
import {
  isExpectedProductGateRequest, monitorProductGatePage,
  productGateAssetPaths, productGateBuildDigest, productGateBuildEntry,
} from "./product-gate-url.mjs";
import {
  RELEASE_A_ASSERTION_IDS, assertReleaseAEvidenceReport,
} from "./release-a-evidence-lib.mjs";

const root = new URL("../", import.meta.url);
const rootPath = fileURLToPath(root);
const evidenceDir = new URL("../evidence/", import.meta.url);
const distRoot = new URL("../packages/shell/dist/", import.meta.url);
const reportUrl = new URL("release-a-report.json", evidenceDir);
const requestedBaseUrl = process.env.CLAY_RELEASE_A_URL;
if (!requestedBaseUrl) throw new Error("CLAY_RELEASE_A_URL must select a temporary loopback port");
const parsedBaseUrl = new URL(requestedBaseUrl);
if (parsedBaseUrl.protocol !== "http:" || parsedBaseUrl.hostname !== "127.0.0.1"
    || !parsedBaseUrl.port || parsedBaseUrl.username || parsedBaseUrl.password
    || parsedBaseUrl.pathname !== "/" || parsedBaseUrl.search || parsedBaseUrl.hash
    || ["4173", "4174", "4175"].includes(parsedBaseUrl.port))
  throw new Error("Release A evidence must use a temporary 127.0.0.1 port, not 4173-4175");
const baseUrl = parsedBaseUrl.origin;
const sourceTree = process.env.CLAY_RELEASE_A_SOURCE_TREE;
if (!sourceTree || !/^[0-9a-f]{40}$/.test(sourceTree))
  throw new Error("CLAY_RELEASE_A_SOURCE_TREE must be an exact Git tree");

const screenshotNames = [
  "release-a-onboarding-desktop.png",
  "release-a-import-review-desktop.png",
  "release-a-import-published-desktop.png",
  "release-a-import-undo-desktop.png",
  "release-a-first-success-desktop.png",
  "release-a-first-real-record-desktop.png",
  "release-a-first-success-desktop-bottom.png",
  "release-a-onboarding-390.png",
  "release-a-first-success-390.png",
  "release-a-first-success-390-bottom.png",
  "release-a-onboarding-320-text-200.png",
  "release-a-onboarding-chunk-failure.png",
  "release-a-checklist-chunk-failure.png",
];
await mkdir(evidenceDir, { recursive: true });
await Promise.all([...screenshotNames.map(name => rm(new URL(name, evidenceDir), { force: true })),
  rm(reportUrl, { force: true })]);

const sha256 = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const gitText = args => execFileSync("git", args, {
  cwd: rootPath, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
}).trim();
const gitBytes = args => execFileSync("git", args, {
  cwd: rootPath, encoding: null, maxBuffer: 64 * 1024 * 1024,
});

async function collectSourceIdentity() {
  const indexTree = gitText(["write-tree"]);
  if (indexTree !== sourceTree)
    throw new Error(`frozen index tree ${indexTree} does not match ${sourceTree}`);
  const status = gitText(["status", "--porcelain=v1", "--untracked-files=all"]);
  const dirtyOutsideEvidence = status ? status.split(/\r?\n/).filter(line => {
    const code = line.slice(0, 2);
    const path = line.slice(3).replace(/^"|"$/g, "");
    if (path.startsWith("evidence/")) return false;
    return code === "??" || code[1] !== " ";
  }) : [];
  if (dirtyOutsideEvidence.length)
    throw new Error(`unstaged source differs from the frozen tree: ${dirtyOutsideEvidence.join(" | ")}`);
  const paths = gitText(["diff", "--name-only", "HEAD", sourceTree, "--"])
    .split(/\r?\n/).filter(path => path && !path.startsWith("evidence/"));
  const changedSourceFiles = paths.map(path => {
    const entry = gitText(["ls-tree", sourceTree, "--", path]);
    const match = entry.match(/^(\d+) blob ([0-9a-f]{40})\t(.+)$/);
    if (!match || match[3] !== path) throw new Error(`cannot resolve frozen source ${path}`);
    const bytes = gitBytes(["show", `${sourceTree}:${path}`]);
    return { path, mode: match[1], gitBlob: match[2], byteLength: bytes.byteLength, sha256: sha256(bytes) };
  });
  if (!changedSourceFiles.length) throw new Error("frozen source tree contains no Release A changes");
  return { sourceTree, indexTree, baseCommit: gitText(["rev-parse", "HEAD"]), changedSourceFiles };
}

async function listBuildFiles(directory, prefix = "") {
  const entries = await readdir(new URL(prefix || "./", directory), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) files.push(...await listBuildFiles(directory, `${relative}/`));
    else if (entry.isFile()) files.push(relative);
  }
  return files.sort();
}

async function localBuildIdentity() {
  const manifest = JSON.parse(await readFile(new URL(".vite/manifest.json", distRoot), "utf8"));
  const paths = await listBuildFiles(distRoot);
  const assets = await Promise.all(paths.map(async path => {
    const bytes = await readFile(new URL(path, distRoot));
    return { path, size: bytes.byteLength, sha256: sha256(bytes).slice(7) };
  }));
  const chunks = {
    onboarding: manifest["src/app/Onboarding.tsx"]?.file,
    checklist: manifest["src/app/FirstSuccessChecklist.tsx"]?.file,
  };
  for (const [label, path] of Object.entries(chunks)) {
    if (typeof path !== "string" || !productGateAssetPaths(manifest).includes(path))
      throw new Error(`manifest has no ${label} lazy chunk`);
  }
  return {
    manifest, paths, chunks,
    expectedBuildEntry: productGateBuildEntry(manifest),
    expectedBuildDigest: productGateBuildDigest(manifest, assets),
  };
}

const report = {
  schema: 3,
  verdict: "RUNNING",
  baseUrl,
  generatedAt: new Date().toISOString(),
  sourceIdentity: null,
  buildIdentity: null,
  browser: null,
  assertions: [],
  scenarios: [],
  accessibility: [],
  screenshots: [],
  expectedChunkErrors: [],
  unexpectedConsoleErrors: [],
  unexpectedPageErrors: [],
  externalRequests: [],
};
const passed = new Set();
function pass(id, detail) {
  if (!RELEASE_A_ASSERTION_IDS.includes(id)) throw new Error(`unknown assertion id ${id}`);
  if (passed.has(id)) throw new Error(`duplicate assertion id ${id}`);
  passed.add(id);
  report.assertions.push({ id, passed: true, detail });
}

const expectedChunkFailure = text =>
  /dynamically imported module|failed to fetch|net::err_failed|importing a module script failed|lazy surface/i.test(text);
let browser = null;
let scenario = "initialization";

async function createPage(viewport, options = {}) {
  const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
  const page = await context.newPage();
  const assertOrigin = monitorProductGatePage(page, baseUrl);
  page.on("request", request => {
    const url = request.url();
    if (url.startsWith("about:") || url.startsWith("blob:") || url.startsWith("data:")) return;
    if (!isExpectedProductGateRequest(baseUrl, url)) report.externalRequests.push({ scenario, url });
  });
  page.on("console", message => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (options.allowChunkFailure && expectedChunkFailure(text))
      report.expectedChunkErrors.push({ scenario, source: "console", text });
    else report.unexpectedConsoleErrors.push({ scenario, text });
  });
  page.on("pageerror", error => {
    const text = String(error);
    if (options.allowChunkFailure && expectedChunkFailure(text))
      report.expectedChunkErrors.push({ scenario, source: "page", text });
    else report.unexpectedPageErrors.push({ scenario, text });
  });
  return { context, page, assertOrigin };
}

async function assertBuildId(page) {
  await page.waitForFunction(expected =>
    document.documentElement.dataset.clayBuildId === expected, sourceTree, { timeout: 30_000 });
  const renderedId = await page.locator("html").getAttribute("data-clay-build-id");
  if (renderedId !== sourceTree)
    throw new Error(`served build id ${renderedId ?? "missing"} does not match ${sourceTree}`);
  return renderedId;
}

async function verifyServedBuild(page, local) {
  const manifest = await page.evaluate(async () => {
    const response = await fetch("/.vite/manifest.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`served manifest returned ${response.status}`);
    return response.json();
  });
  const buildEntry = productGateBuildEntry(manifest);
  const assets = await page.evaluate(async paths => Promise.all(paths.map(async path => {
    const response = await fetch(`/${path}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`served asset ${path} returned ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return {
      path,
      size: bytes.byteLength,
      sha256: [...digest].map(value => value.toString(16).padStart(2, "0")).join(""),
    };
  })), local.paths);
  const servedBuildDigest = productGateBuildDigest(manifest, assets);
  if (buildEntry !== local.expectedBuildEntry || servedBuildDigest !== local.expectedBuildDigest)
    throw new Error("the served preview does not match the complete local production build");
  return {
    renderedId: await assertBuildId(page), buildEntry,
    expectedBuildEntry: local.expectedBuildEntry,
    expectedBuildDigest: local.expectedBuildDigest,
    servedBuildDigest,
    assetCount: assets.length,
  };
}

async function openFirstRun(viewport, options = {}) {
  const created = await createPage(viewport, options);
  await created.page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  created.assertOrigin();
  await assertBuildId(created.page);
  await created.page.getByRole("heading", { name: "Welcome to Clay" }).waitFor({ timeout: 30_000 });
  return created;
}

async function capture(page, name, fullPage = true) {
  const url = new URL(name, evidenceDir);
  await page.screenshot({ path: fileURLToPath(url), fullPage });
  const bytes = await readFile(url);
  const item = { path: `evidence/${name}`, byteLength: bytes.byteLength, sha256: sha256(bytes) };
  report.screenshots.push(item);
  return item;
}

async function axe(page, name) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const blockers = result.violations.filter(item =>
    item.impact === "critical" || item.impact === "serious");
  const item = { scenario: name, seriousOrCritical: blockers.length,
    ruleIds: blockers.map(value => value.id).sort() };
  report.accessibility.push(item);
  if (blockers.length)
    throw new Error(`${name} Axe blockers: ${item.ruleIds.join(", ")}`);
  return item;
}

async function targetSize(locator, label) {
  const box = await locator.boundingBox();
  if (!box || box.width < 44 || box.height < 44)
    throw new Error(`${label} touch target is ${box ? `${box.width.toFixed(1)}x${box.height.toFixed(1)}` : "missing"}`);
  return { label, width: Math.round(box.width), height: Math.round(box.height) };
}

async function geometry(page) {
  return page.evaluate(() => {
    const measure = element => element ? {
      clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
      clientHeight: element.clientHeight, scrollHeight: element.scrollHeight,
    } : null;
    return {
      viewport: { width: innerWidth, height: innerHeight },
      document: measure(document.documentElement),
      body: measure(document.body),
      regions: measure(document.querySelector(".regions")),
    };
  });
}

function assertNoHorizontalOverflow(value, label) {
  for (const [name, item] of Object.entries(value)) {
    if (!item || name === "viewport") continue;
    if (item.scrollWidth > item.clientWidth + 1)
      throw new Error(`${label} ${name} overflows horizontally: ${item.scrollWidth}/${item.clientWidth}`);
  }
}

async function frameEvidence(page, expected, absent = []) {
  const deadline = Date.now() + 30_000;
  let frames = [];
  while (Date.now() < deadline) {
    frames = await Promise.all(page.frames().filter(frame => frame !== page.mainFrame()).map(async frame => {
      try {
        const body = frame.locator("body");
        return {
          name: frame.name(), url: frame.url(), text: await body.innerText(),
          geometry: await frame.evaluate(() => ({
            clientWidth: document.documentElement.clientWidth,
            scrollWidth: document.documentElement.scrollWidth,
          })),
        };
      } catch { return { name: frame.name(), url: frame.url(), text: "", geometry: null }; }
    }));
    const combined = frames.map(frame => frame.text).join("\n");
    const normalized = combined.toLocaleLowerCase();
    if (expected.every(text => normalized.includes(text.toLocaleLowerCase()))
        && absent.every(text => !normalized.includes(text.toLocaleLowerCase()))) break;
    await page.waitForTimeout(100);
  }
  const combined = frames.map(frame => frame.text).join("\n");
  const normalized = combined.toLocaleLowerCase();
  for (const text of expected)
    if (!normalized.includes(text.toLocaleLowerCase()))
      throw new Error(`iframe content never rendered: ${text}`);
  for (const text of absent)
    if (normalized.includes(text.toLocaleLowerCase()))
      throw new Error(`iframe content did not disappear: ${text}`);
  for (const frame of frames)
    if (frame.geometry && frame.geometry.scrollWidth > frame.geometry.clientWidth + 1)
      throw new Error(`iframe ${frame.name || frame.url} overflows horizontally`);
  return {
    count: frames.length,
    matchedText: expected,
    absentText: absent,
    frames: frames.map(frame => ({ name: frame.name, url: frame.url, geometry: frame.geometry })),
  };
}

async function activateSmallBusiness(page) {
  const refine = page.getByRole("button", { name: /Change recommendation/i });
  if (await refine.getAttribute("aria-expanded") !== "true") await refine.click();
  await page.getByRole("button", { name: "Run customers and jobs" }).click();
  const recommendation = page.getByRole("button", { name: /Use a recommended starter/i });
  await recommendation.waitFor();
  const recommendationLabel = (await recommendation.innerText()).trim();
  await recommendation.click();
  const workspace = page.getByRole("main", { name: "Work workspace" });
  await workspace.waitFor({ timeout: 30_000 });
  await page.getByRole("heading", { name: "Make this app yours" }).waitFor({ timeout: 30_000 });
  const announcement = page.getByRole("status").filter({ hasText: "Small Business is ready. Work is open." });
  await announcement.waitFor({ timeout: 10_000 });
  const announcementText = (await announcement.innerText()).trim();
  await page.waitForFunction(() =>
    document.activeElement?.getAttribute("aria-label") === "Work workspace", null, { timeout: 10_000 });
  const focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
  const workButton = page.getByRole("button", { name: "Work", exact: true });
  const customizeButton = page.getByRole("button", { name: "Customize", exact: true });
  if (await workButton.getAttribute("aria-pressed") !== "true"
      || await customizeButton.getAttribute("aria-pressed") !== "false")
    throw new Error("activated workspace did not default to Work");
  const checklist = await page.locator("#first-success-title + ol li").allInnerTexts();
  const expectedChecklist = [
    "Start with a working app: Complete",
    "Add your first real record: Next",
    "Review your Work view: Not started",
    "Keep your first customization: Not started",
  ];
  if (JSON.stringify(checklist) !== JSON.stringify(expectedChecklist))
    throw new Error(`unexpected first-success state: ${JSON.stringify(checklist)}`);
  const provenanceRegion = page.getByRole("region", { name: "Example data" });
  await provenanceRegion.waitFor();
  const provenance = (await provenanceRegion.innerText()).trim();
  if (!/16 example records/.test(provenance)
      || !["customers", "jobs", "invoices", "items", "expenses"].every(name => provenance.includes(name)))
    throw new Error(`sample provenance is incomplete: ${provenance}`);
  const appName = (await page.locator(".appbar-current").innerText()).trim();
  if (!appName.includes("Small Business")) throw new Error(`wrong activated app: ${appName}`);
  const iframe = await frameEvidence(page, ["Open jobs", "Kitchen faucet fix", "Alice Nguyen", "Add job"]);
  const body = await page.locator("body").innerText();
  if (body.includes("Your data lives only in this browser — keep a backup file")
      || body.includes("Last backup"))
    throw new Error("sample-only starter triggered a real-data backup nudge");
  return {
    recommendationLabel, appName, checklist, provenance, announcementText, focused,
    workspaceMode: { work: true, customize: false }, iframe,
  };
}

async function createFirstRealRecord(page) {
  const recordName = "Release A real customer";
  await page.getByRole("button", { name: "Add a real record" }).click();
  const command = page.getByRole("dialog", { name: "Search and act" });
  await command.waitFor({ timeout: 15_000 });
  await command.getByRole("button", { name: /New customers/i }).click();
  await command.getByLabel("Name").fill(recordName);
  await command.getByRole("button", { name: "Create record" }).click();
  const data = page.getByRole("dialog", { name: "Your data" });
  await data.waitFor({ timeout: 15_000 });
  await frameEvidence(page, [recordName]);
  await data.getByRole("button", { name: "Close data view" }).click();
  const complete = page.locator("#first-success-title + ol li").filter({ hasText: "Add your first real record: Complete" });
  await complete.waitFor({ timeout: 15_000 });
  const next = page.locator("#first-success-title + ol li").filter({ hasText: "Review your Work view: Next" });
  await next.waitFor();
  const beforeClear = (await page.getByRole("region", { name: "Example data" }).innerText()).trim();
  await page.getByRole("button", { name: "Clear examples" }).click();
  await page.getByRole("region", { name: "Example data" }).waitFor({ state: "detached", timeout: 15_000 });
  const afterClearFrames = await frameEvidence(
    page, [recordName], ["Alice Nguyen", "Kitchen faucet fix"],
  );
  return { recordName, checklist: await page.locator("#first-success-title + ol li").allInnerTexts(),
    beforeClear, examplesCleared: true, realRecordSurvived: true, iframe: afterClearFrames };
}

async function scrollRegionsToBottom(page) {
  return page.locator(".regions").evaluate(element => {
    element.scrollTop = element.scrollHeight;
    return { scrollTop: element.scrollTop, scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight };
  });
}

function boundedImportFixture() {
  const headers = ["Name", "Amount", ...Array.from({ length: 20 }, (_, index) => `Extra ${index + 1}`)];
  const row = index => [`Accepted ${index}`, String(index + 1),
    ...Array.from({ length: 20 }, (_, field) => `v${field + 1}`)].join(",");
  return [
    headers.join(","),
    ...Array.from({ length: 2_500 }, (_, index) => row(index)),
    "",
    ...Array.from({ length: 2_501 }, (_, index) => row(index + 2_500)),
  ].join("\n");
}

try {
  report.sourceIdentity = await collectSourceIdentity();
  const localBuild = await localBuildIdentity();
  browser = await chromium.launch({ headless: true, channel: "msedge" });
  report.browser = { family: "msedge", version: browser.version() };

  scenario = "desktop-onboarding";
  const desktop = await openFirstRun({ width: 1440, height: 1000 });
  const page = desktop.page;
  report.buildIdentity = await verifyServedBuild(page, localBuild);
  desktop.assertOrigin();
  pass("identity.source-tree", { sourceTree, hashedFiles: report.sourceIdentity.changedSourceFiles.length });
  pass("identity.build-digest", report.buildIdentity);
  const focusedHeading = await page.evaluate(() => document.activeElement?.textContent?.trim());
  if (focusedHeading !== "Welcome to Clay") throw new Error("first-run heading did not receive focus");
  const refineRecommendation = page.getByRole("button", { name: /Change recommendation/i });
  if (await refineRecommendation.getAttribute("aria-expanded") !== "false")
    throw new Error("recommendation refinement is not secondary by default");
  await refineRecommendation.click();
  const defaultGoal = page.getByRole("button", { name: "Track tasks and projects" });
  if (await defaultGoal.getAttribute("aria-pressed") !== "true")
    throw new Error("safe default goal is not selected");
  const recommended = page.getByRole("button", { name: /Use a recommended starter/i });
  const importAction = page.getByRole("button", { name: /Import a spreadsheet/i });
  const blankAction = page.getByRole("button", { name: /Start from scratch/i });
  await Promise.all([recommended.waitFor(), importAction.waitFor(), blankAction.waitFor()]);
  const primaryActions = await page.locator('button[data-start-priority="primary"]').evaluateAll(nodes =>
    nodes.map(node => {
      const style = getComputedStyle(node);
      const box = node.getBoundingClientRect();
      return {
        label: node.textContent?.trim() ?? "",
        className: node.className,
        width: box.width,
        height: box.height,
        style: {
          backgroundColor: style.backgroundColor,
          borderColor: style.borderColor,
          borderWidth: style.borderWidth,
          borderRadius: style.borderRadius,
          boxShadow: style.boxShadow,
        },
      };
    }));
  if (primaryActions.length !== 2
      || !primaryActions[0].label.includes("Import a spreadsheet")
      || !primaryActions[1].label.includes("Use a recommended starter")
      || primaryActions[0].className !== primaryActions[1].className
      || JSON.stringify(primaryActions[0].style) !== JSON.stringify(primaryActions[1].style)
      || Math.abs(primaryActions[0].width - primaryActions[1].width) > 1
      || Math.abs(primaryActions[0].height - primaryActions[1].height) > 1)
    throw new Error(`primary onboarding actions are not exactly equal: ${JSON.stringify(primaryActions)}`);
  const order = await page.evaluate(() => {
    const text = [...document.querySelectorAll("button")].map(node => node.textContent?.trim() ?? "");
    return {
      importAction: text.findIndex(value => value.includes("Import a spreadsheet")),
      recommended: text.findIndex(value => value.includes("Use a recommended starter")),
      blankAction: text.findIndex(value => value.includes("Start from scratch")),
    };
  });
  if (!(order.importAction >= 0 && order.importAction < order.recommended
      && order.recommended < order.blankAction))
    throw new Error(`import/recommended/blank order is wrong: ${JSON.stringify(order)}`);
  pass("desktop.primary-actions", {
    count: primaryActions.length,
    labels: primaryActions.map(action => action.label),
    equalClassAndStyle: true,
    order,
  });
  const chooser = page.locator('input[type="file"]');
  if (!(await chooser.isHidden()) || await chooser.getAttribute("tabindex") !== "-1"
      || await chooser.getAttribute("aria-hidden") !== "true")
    throw new Error("native import chooser is exposed to layout or focus");
  const [fileChooser] = await Promise.all([
    page.waitForEvent("filechooser"), importAction.click(),
  ]);
  if ((await fileChooser.element().getAttribute("type")) !== "file")
    throw new Error("import trigger did not activate the native file input");
  pass("desktop.hidden-file-input-activation", { hidden: true, tabIndex: -1, nativeFileChooser: true });
  await page.getByRole("button", { name: /See all templates/i }).click();
  await page.getByRole("heading", { name: "All templates" }).waitFor();
  const desktopOnboardingAxe = await axe(page, scenario);
  const desktopOnboardingGeometry = await geometry(page);
  assertNoHorizontalOverflow(desktopOnboardingGeometry, scenario);
  await capture(page, "release-a-onboarding-desktop.png");
  pass("desktop.onboarding", { focusedHeading, defaultGoal: "tasks", primaryOrder: order,
    geometry: desktopOnboardingGeometry, axe: desktopOnboardingAxe });

  scenario = "desktop-activation";
  const activatedDesktop = await activateSmallBusiness(page);
  const desktopActivationGeometry = await geometry(page);
  assertNoHorizontalOverflow(desktopActivationGeometry, scenario);
  const desktopActivationAxe = await axe(page, scenario);
  await capture(page, "release-a-first-success-desktop.png", false);
  pass("desktop.activation", { appName: activatedDesktop.appName,
    checklist: activatedDesktop.checklist, geometry: desktopActivationGeometry,
    screenshot: "evidence/release-a-first-success-desktop.png" });
  pass("desktop.focus", { activeElementLabel: activatedDesktop.focused });
  pass("desktop.live-announcement", { text: activatedDesktop.announcementText });
  pass("desktop.work-default", activatedDesktop.workspaceMode);
  pass("desktop.iframe", activatedDesktop.iframe);
  pass("desktop.no-early-backup", { realRecordCount: 0, backupNudgePresent: false });

  scenario = "desktop-first-real-record";
  const realRecord = await createFirstRealRecord(page);
  await capture(page, "release-a-first-real-record-desktop.png", false);
  const desktopBottom = await scrollRegionsToBottom(page);
  await capture(page, "release-a-first-success-desktop-bottom.png", false);
  pass("desktop.first-real-record", { recordName: realRecord.recordName,
    checklist: realRecord.checklist, canonicalPanelReadback: true });
  pass("desktop.sample-provenance", { beforeClear: realRecord.beforeClear,
    examplesCleared: true, realRecordSurvived: true, iframe: realRecord.iframe });
  report.scenarios.push({ id: "desktop", viewport: "1440x1000", activatedDesktop,
    realRecord, geometry: desktopActivationGeometry, bottom: desktopBottom,
    accessibility: [desktopOnboardingAxe, desktopActivationAxe] });
  desktop.assertOrigin();
  await desktop.context.close();

  scenario = "desktop-import-review";
  const importRun = await openFirstRun({ width: 1280, height: 900 });
  const importPage = importRun.page;
  const cacheBeforeReview = await importPage.evaluate(() => ({
    apps: localStorage.getItem("clay_apps"),
    current: localStorage.getItem("clay_current_app"),
  }));
  await importPage.locator('input[type="file"]').setInputFiles({
    name: "release-a-import.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(boundedImportFixture()),
  });
  const reviewDialog = importPage.getByRole("dialog", { name: /Bring in release-a-import.csv/i });
  await reviewDialog.waitFor({ timeout: 30_000 });
  const reviewCounts = await reviewDialog.locator("dt").evaluateAll(terms =>
    Object.fromEntries(terms.map(term => [
      term.textContent?.trim() ?? "", term.nextElementSibling?.textContent?.trim() ?? "",
    ])));
  const expectedReviewCounts = {
    "Proposed table": "release_a_import",
    "Rows in file": "5002",
    "Rows accepted": "5000",
    "Rows skipped": "1",
    "Rows truncated": "1",
    "Fields in file": "22",
    "Fields accepted": "20",
    "Fields truncated": "2",
  };
  if (JSON.stringify(reviewCounts) !== JSON.stringify(expectedReviewCounts))
    throw new Error(`import review counts are not exact: ${JSON.stringify(reviewCounts)}`);
  const proposedFields = await reviewDialog.locator(
    'section[aria-labelledby="import-schema-title"] li',
  ).allInnerTexts();
  if (proposedFields.length !== 20 || !proposedFields[0]?.includes("name · text")
      || !proposedFields[1]?.includes("amount · number"))
    throw new Error(`import review schema is not exact: ${JSON.stringify(proposedFields)}`);
  const cacheDuringReview = await importPage.evaluate(() => ({
    apps: localStorage.getItem("clay_apps"),
    current: localStorage.getItem("clay_current_app"),
  }));
  if (JSON.stringify(cacheDuringReview) !== JSON.stringify(cacheBeforeReview)
      || cacheDuringReview.apps !== null || cacheDuringReview.current !== null)
    throw new Error("import review changed the app cache before confirmation");
  const importReviewAxe = await axe(importPage, scenario);
  await capture(importPage, "release-a-import-review-desktop.png", false);
  pass("desktop.import-review", {
    counts: reviewCounts,
    proposedFieldCount: proposedFields.length,
    appCacheUnchanged: true,
    screenshot: "evidence/release-a-import-review-desktop.png",
    axe: importReviewAxe,
  });

  scenario = "desktop-import-publication";
  await reviewDialog.getByRole("button", { name: "Import accepted rows (5000)" }).click();
  const importReceipt = importPage.getByRole("region", { name: "Import publication receipt" });
  await importReceipt.waitFor({ timeout: 120_000 });
  const importReceiptText = (await importReceipt.innerText()).trim();
  if (!importReceiptText.includes("5000 accepted rows are in release_a_import")
      || !importReceiptText.includes("app default · revision 1")
      || !/operation import-[a-zA-Z0-9_-]{16,}/.test(importReceiptText))
    throw new Error(`import publication receipt is incomplete: ${importReceiptText}`);
  await importPage.getByRole("main", { name: "Work workspace" }).waitFor({ timeout: 30_000 });
  await importPage.locator("#first-success-title + ol li")
    .filter({ hasText: "Add your first real record: Complete" }).waitFor();
  const publishedFrame = await frameEvidence(importPage, ["Accepted"]);
  const publishedCache = await importPage.evaluate(() => ({
    apps: JSON.parse(localStorage.getItem("clay_apps") ?? "[]"),
    current: localStorage.getItem("clay_current_app"),
  }));
  if (publishedCache.current !== "default" || publishedCache.apps.length !== 1
      || publishedCache.apps[0]?.id !== "default")
    throw new Error(`published app cache is not canonically bound: ${JSON.stringify(publishedCache)}`);
  const importPublicationAxe = await axe(importPage, scenario);
  await capture(importPage, "release-a-import-published-desktop.png", false);
  pass("desktop.import-publication", {
    acceptedRows: 5_000,
    appId: "default",
    revision: 1,
    receipt: importReceiptText,
    cache: publishedCache,
    iframe: publishedFrame,
    screenshot: "evidence/release-a-import-published-desktop.png",
    axe: importPublicationAxe,
  });

  scenario = "desktop-import-undo";
  await importReceipt.getByRole("button", { name: "Undo import" }).click();
  await importReceipt.getByText("Import undone.", { exact: false }).waitFor({ timeout: 120_000 });
  const undoneReceiptText = (await importReceipt.innerText()).trim();
  if (!undoneReceiptText.includes("5000 imported rows were removed")
      || !undoneReceiptText.includes("release_a_import table and view remain"))
    throw new Error(`Undo receipt is incomplete: ${undoneReceiptText}`);
  await importPage.locator("#first-success-title + ol li")
    .filter({ hasText: "Add your first real record: Next" }).waitFor({ timeout: 30_000 });
  const undoneFrame = await frameEvidence(importPage, ["No rows yet"], ["Accepted"]);
  const importUndoAxe = await axe(importPage, scenario);
  await capture(importPage, "release-a-import-undo-desktop.png", false);
  pass("desktop.import-undo", {
    removedRows: 5_000,
    structureRetained: true,
    receipt: undoneReceiptText,
    iframe: undoneFrame,
    screenshot: "evidence/release-a-import-undo-desktop.png",
    axe: importUndoAxe,
  });
  report.scenarios.push({
    id: "import-review-publication-undo", viewport: "1280x900",
    review: reviewCounts, receipt: importReceiptText, undo: undoneReceiptText,
    accessibility: [importReviewAxe, importPublicationAxe, importUndoAxe],
  });
  importRun.assertOrigin();
  await importRun.context.close();

  scenario = "mobile-onboarding";
  const mobile = await openFirstRun({ width: 390, height: 844 });
  await mobile.page.getByRole("button", { name: /Change recommendation/i }).click();
  const mobileBefore = await geometry(mobile.page);
  assertNoHorizontalOverflow(mobileBefore, scenario);
  const mobileTargets = await Promise.all([
    targetSize(mobile.page.getByRole("button", { name: "Track tasks and projects" }), "mobile default goal"),
    targetSize(mobile.page.getByRole("button", { name: /Use a recommended starter/i }), "mobile recommended starter"),
    targetSize(mobile.page.getByRole("button", { name: /Import a spreadsheet/i }), "mobile import"),
    targetSize(mobile.page.getByRole("button", { name: /Start from scratch/i }), "mobile blank"),
  ]);
  const mobileOnboardingAxe = await axe(mobile.page, scenario);
  await capture(mobile.page, "release-a-onboarding-390.png");
  pass("mobile.onboarding", { viewport: "390x844", geometry: mobileBefore,
    defaultGoal: "tasks", primaryTargets: mobileTargets, axe: mobileOnboardingAxe });

  scenario = "mobile-activation";
  const activatedMobile = await activateSmallBusiness(mobile.page);
  const mobileAfter = await geometry(mobile.page);
  assertNoHorizontalOverflow(mobileAfter, scenario);
  const mobileActivationTargets = await Promise.all([
    targetSize(mobile.page.getByRole("button", { name: "Work", exact: true }), "mobile Work"),
    targetSize(mobile.page.getByRole("button", { name: "Customize", exact: true }), "mobile Customize"),
    targetSize(mobile.page.getByRole("button", { name: "Add a real record" }), "mobile add record"),
    targetSize(mobile.page.getByRole("button", { name: "Dismiss" }), "mobile dismiss checklist"),
    targetSize(mobile.page.getByRole("button", { name: "Clear examples" }), "mobile clear examples"),
  ]);
  const mobileActivationAxe = await axe(mobile.page, scenario);
  await capture(mobile.page, "release-a-first-success-390.png", false);
  const mobileBottom = await scrollRegionsToBottom(mobile.page);
  await capture(mobile.page, "release-a-first-success-390-bottom.png", false);
  pass("mobile.activation", { viewport: "390x844", geometry: mobileAfter,
    focused: activatedMobile.focused, announcement: activatedMobile.announcementText,
    workDefault: activatedMobile.workspaceMode });
  pass("mobile.touch-targets", { minimum: "44x44", targets: [...mobileTargets, ...mobileActivationTargets] });
  pass("mobile.iframe", activatedMobile.iframe);
  report.scenarios.push({ id: "mobile", viewport: "390x844", before: mobileBefore,
    after: mobileAfter, targets: [...mobileTargets, ...mobileActivationTargets],
    activated: activatedMobile, bottom: mobileBottom,
    accessibility: [mobileOnboardingAxe, mobileActivationAxe] });
  mobile.assertOrigin();
  await mobile.context.close();

  scenario = "mobile-reflow";
  const reflow = await openFirstRun({ width: 320, height: 800 });
  await reflow.page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  await reflow.page.waitForFunction(() => getComputedStyle(document.documentElement).fontSize === "32px");
  const reflowGeometry = await geometry(reflow.page);
  assertNoHorizontalOverflow(reflowGeometry, scenario);
  const reflowAxe = await axe(reflow.page, scenario);
  await capture(reflow.page, "release-a-onboarding-320-text-200.png");
  pass("mobile.reflow", { viewport: "320x800", rootTextSize: "200%",
    geometry: reflowGeometry, axe: reflowAxe });
  report.scenarios.push({ id: "reflow", viewport: "320x800", textSize: "200%",
    geometry: reflowGeometry, accessibility: reflowAxe });
  reflow.assertOrigin();
  await reflow.context.close();

  scenario = "onboarding-lazy-failure";
  const onboardingFailure = await createPage({ width: 1024, height: 768 }, { allowChunkFailure: true });
  let onboardingAbortCount = 0;
  await onboardingFailure.page.route(`**/${localBuild.chunks.onboarding}`, route => {
    onboardingAbortCount++; return route.abort();
  });
  await onboardingFailure.page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await assertBuildId(onboardingFailure.page);
  const setupAlert = onboardingFailure.page.getByRole("alert", { name: "setup failed to load" });
  await setupAlert.waitFor({ timeout: 30_000 });
  const setupReload = setupAlert.getByRole("button", { name: "Reload Clay" });
  await setupReload.waitFor();
  await onboardingFailure.page.waitForFunction(() =>
    document.activeElement?.textContent?.trim() === "Reload Clay");
  if (onboardingAbortCount < 1) throw new Error("the actual onboarding chunk was not aborted");
  await capture(onboardingFailure.page, "release-a-onboarding-chunk-failure.png", false);
  pass("lazy.onboarding-chunk-failure", { chunk: localBuild.chunks.onboarding,
    abortCount: onboardingAbortCount, alert: (await setupAlert.innerText()).trim(), recoveryFocused: true });
  onboardingFailure.assertOrigin();
  await onboardingFailure.context.close();

  scenario = "checklist-lazy-failure";
  const checklistFailure = await openFirstRun(
    { width: 1024, height: 768 }, { allowChunkFailure: true });
  let checklistAbortCount = 0;
  await checklistFailure.page.route(`**/${localBuild.chunks.checklist}`, route => {
    checklistAbortCount++; return route.abort();
  });
  await checklistFailure.page.getByRole("button", { name: /Use a recommended starter/i }).click();
  const checklistAlert = checklistFailure.page.getByRole("alert", { name: "first steps failed to load" });
  await checklistAlert.waitFor({ timeout: 30_000 });
  const checklistReload = checklistAlert.getByRole("button", { name: "Reload Clay" });
  await checklistFailure.page.waitForFunction(() =>
    document.activeElement?.textContent?.trim() === "Reload Clay");
  if (checklistAbortCount < 1) throw new Error("the actual checklist chunk was not aborted");
  await capture(checklistFailure.page, "release-a-checklist-chunk-failure.png", false);
  pass("lazy.checklist-chunk-failure", { chunk: localBuild.chunks.checklist,
    abortCount: checklistAbortCount, alert: (await checklistAlert.innerText()).trim(), recoveryFocused: true });
  checklistFailure.assertOrigin();
  await checklistFailure.context.close();

  const axeScenarios = report.accessibility.map(result => result.scenario);
  pass("accessibility.axe", { scenarios: axeScenarios,
    scans: report.accessibility.length, seriousOrCritical: 0 });
  if (report.unexpectedConsoleErrors.length || report.unexpectedPageErrors.length
      || report.externalRequests.length)
    throw new Error("unexpected browser errors or external requests were recorded");
  report.verdict = "PASS";
  assertReleaseAEvidenceReport(report, sourceTree);
} catch (error) {
  report.verdict = "FAIL";
  report.error = error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) };
  throw error;
} finally {
  if (browser) await browser.close();
  report.generatedAt = new Date().toISOString();
  await writeFile(reportUrl, JSON.stringify(report, null, 2) + "\n");
}

console.log(JSON.stringify(report));
