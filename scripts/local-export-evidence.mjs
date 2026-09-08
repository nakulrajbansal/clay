// F-GATE-010 browser certificate: exact local current-view/record Print + CSV.
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  isExpectedProductGateRequest, monitorProductGatePage, productGateUrl,
} from "./product-gate-url.mjs";
import { runExportDialogStateEvidence } from "./local-export-browser-benchmark.mjs";
import {
  assertBenchmarkEvidence, assertExactCleanSource, assertLocalExportActionEgress,
  buildDirectoryDigest,
  deriveCleanHeadSource, ingestManualScreenReaderEvidence, sha256Evidence,
  pdfTextMatchesExactSequence,
  summarizeExportDialogStateEvidence, writeReleaseEvidenceDirectory,
} from "./local-export-evidence-lib.mjs";
import {
  LOCAL_EXPORT_REQUIRED_REQUIREMENTS_V2, LocalExportEvidenceManifestV2,
} from "../packages/schema/src/evidence.ts";

const url = productGateUrl();
const checkout = process.cwd();
const outDir = process.argv[2];
const benchmarkFile = process.argv[3];
if (!outDir || !benchmarkFile || !isAbsolute(outDir) || !isAbsolute(benchmarkFile))
  throw new Error("inner browser evidence requires absolute output and benchmark paths");
for (const path of [outDir, benchmarkFile]) {
  const fromCheckout = relative(checkout, resolve(path));
  if (fromCheckout === "" || (!fromCheckout.startsWith(`..${sep}`) && fromCheckout !== ".."))
    throw new Error("inner browser evidence outputs must be outside the isolated checkout");
}
const source = deriveCleanHeadSource(checkout);
if (process.env.CLAY_SOURCE_TREE !== source.tree)
  throw new Error("wrapper-derived source tree does not match browser-evidence checkout tree");
const build = await buildDirectoryDigest(join(checkout, "packages", "shell", "dist"));
const benchmarkEvidence = assertBenchmarkEvidence(
  JSON.parse(await readFile(benchmarkFile, "utf8")),
);
if (benchmarkEvidence.source.commit !== source.commit
    || benchmarkEvidence.source.tree !== source.tree)
  throw new Error("benchmark source does not match the isolated browser-evidence source");
if (benchmarkEvidence.build.sha256 !== build.sha256
    || benchmarkEvidence.build.bytes !== build.bytes
    || benchmarkEvidence.build.files !== build.files)
  throw new Error("benchmark build does not match the isolated browser-evidence build");
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
const manualScreenReader = await ingestManualScreenReaderEvidence(
  process.env.CLAY_MANUAL_SCREEN_READER_INPUT,
  { source, build, outputDirectory: outDir, sourceDirectory: checkout },
);
const checks = [];
const check = (condition, label, detail = undefined) => {
  checks.push({ ok: Boolean(condition), label, ...(detail === undefined ? {} : { detail }) });
  console.log(`${condition ? "PASS" : "FAIL"} ${label}`);
  if (!condition && detail !== undefined) console.error(JSON.stringify(detail));
  if (!condition) throw new Error(label);
};

async function artifactDigest(file) {
  const data = await readFile(join(outDir, file));
  return {
    file,
    bytes: data.byteLength,
    sha256: `sha256:${createHash("sha256").update(data).digest("hex")}`,
  };
}

async function opfsSnapshot(page) {
  return page.evaluate(async () => {
    if (typeof navigator.storage?.getDirectory !== "function")
      return { supported: false, files: [] };
    const files = [];
    const visit = async (directory, prefix) => {
      for await (const [name, handle] of directory.entries()) {
        const path = prefix ? `${prefix}/${name}` : name;
        if (handle.kind === "directory") await visit(handle, path);
        else {
          const file = await handle.getFile();
          const bytes = new Uint8Array(await file.arrayBuffer());
          const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
          files.push({
            path,
            bytes: bytes.byteLength,
            sha256: [...digest].map(value => value.toString(16).padStart(2, "0")).join(""),
          });
        }
      }
    };
    await visit(await navigator.storage.getDirectory(), "");
    files.sort((left, right) => left.path.localeCompare(right.path));
    return { supported: true, files };
  });
}

async function settledOpfsSnapshot(page) {
  let previous = await opfsSnapshot(page);
  if (!previous.supported) return previous;
  for (let attempt = 0; attempt < 30; attempt++) {
    await page.waitForTimeout(100);
    const current = await opfsSnapshot(page);
    if (JSON.stringify(current) === JSON.stringify(previous)) return current;
    previous = current;
  }
  throw new Error("OPFS did not settle before the read-only export interval");
}

function parseCsv(text) {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') { cell += '"'; index++; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(cell); cell = ""; }
    else if (char === "\r" && source[index + 1] === "\n") {
      row.push(cell); rows.push(row); row = []; cell = ""; index++;
    } else cell += char;
  }
  if (quoted) throw new Error("downloaded CSV has an unterminated quote");
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function csvSafe(value) {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

async function scaleRenderedText200(page, rootSelector, representatives = []) {
  const observation = await page.evaluate(({ selector, representativeSelectors }) => {
    const root = document.querySelector(selector);
    if (!root) throw new Error(`text-scale root is unavailable: ${selector}`);
    const existingScales = [...document.querySelectorAll("[data-clay-evidence-text-scale='200']")]
      .filter(element => element instanceof HTMLElement)
      .map(element => ({ element, value: element.style.getPropertyValue("font-size"),
        priority: element.style.getPropertyPriority("font-size") }));
    for (const { element } of existingScales) element.style.removeProperty("font-size");
    const pseudoSheet = document.querySelector("#clay-evidence-pseudo-scale");
    const previousPseudoRules = pseudoSheet?.textContent ?? "";
    if (pseudoSheet) pseudoSheet.textContent = "";
    void root.getBoundingClientRect();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const records = [];
    const parents = new Set();
    let node = walker.nextNode();
    while (node) {
      const parent = node.parentElement;
      const range = document.createRange();
      range.selectNodeContents(node);
      if (parent && node.textContent?.trim() && range.getClientRects().length > 0) {
        const style = getComputedStyle(parent);
        if (style.display !== "none" && style.visibility !== "hidden") {
          records.push({ parent, kind: "text" });
          parents.add(parent);
        }
      }
      node = walker.nextNode();
    }
    const controls = [root, ...root.querySelectorAll("input,textarea,select,button")]
      .filter(element => element instanceof HTMLElement
        && element.getClientRects().length > 0
        && getComputedStyle(element).visibility !== "hidden");
    let placeholderControls = 0;
    let selectedOptions = 0;
    for (const control of controls) {
      records.push({ parent: control, kind: "control" });
      parents.add(control);
      if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement)
        placeholderControls += control.placeholder ? 1 : 0;
      if (control instanceof HTMLSelectElement) selectedOptions += control.selectedOptions.length;
    }
    const pseudoRecords = [];
    for (const element of [root, ...root.querySelectorAll("*")]) {
      if (!(element instanceof HTMLElement) || element.getClientRects().length === 0) continue;
      for (const pseudo of ["::before", "::after"]) {
        const style = getComputedStyle(element, pseudo);
        if (!style.content || style.content === "none" || style.content === '""'
            || style.display === "none" || style.visibility === "hidden") continue;
        const beforeCssPixels = Number.parseFloat(style.fontSize);
        if (!Number.isFinite(beforeCssPixels) || beforeCssPixels <= 0)
          throw new Error("generated text has no measurable baseline font size");
        pseudoRecords.push({ element, pseudo, beforeCssPixels });
      }
    }
    const baselines = new Map();
    for (const parent of parents) {
      const beforeCssPixels = Number.parseFloat(getComputedStyle(parent).fontSize);
      if (!Number.isFinite(beforeCssPixels) || beforeCssPixels <= 0)
        throw new Error("rendered text has no measurable baseline font size");
      baselines.set(parent, beforeCssPixels);
    }
    for (const { element, value, priority } of existingScales)
      element.style.setProperty("font-size", value, priority);
    if (pseudoSheet) pseudoSheet.textContent = previousPseudoRules;
    for (const parent of parents) {
      const beforeCssPixels = baselines.get(parent);
      parent.dataset.clayEvidenceTextBefore = String(beforeCssPixels);
      parent.dataset.clayEvidenceTextScale = "200";
      parent.style.setProperty("font-size", `${beforeCssPixels * 2}px`, "important");
    }
    let generatedSheet = pseudoSheet;
    if (!generatedSheet) {
      generatedSheet = document.createElement("style");
      generatedSheet.id = "clay-evidence-pseudo-scale";
      document.head.append(generatedSheet);
    }
    const pseudoStart = Number.parseInt(
      document.documentElement.dataset.clayEvidencePseudoSequence ?? "0", 10,
    );
    const pseudoRules = pseudoRecords.map((record, index) => {
      const id = String(pseudoStart + index + 1);
      record.element.dataset.clayEvidencePseudo = id;
      return `[data-clay-evidence-pseudo="${id}"]${record.pseudo}{font-size:${
        record.beforeCssPixels * 2}px!important}`;
    });
    document.documentElement.dataset.clayEvidencePseudoSequence =
      String(pseudoStart + pseudoRecords.length);
    generatedSheet.textContent = `${previousPseudoRules}\n${pseudoRules.join("\n")}`;
    void root.getBoundingClientRect();
    const measured = records.map(({ parent }) => {
      const beforeCssPixels = Number.parseFloat(parent.dataset.clayEvidenceTextBefore ?? "");
      return {
        parent,
        beforeCssPixels,
        afterCssPixels: Number.parseFloat(getComputedStyle(parent).fontSize),
      };
    });
    const measuredPseudo = pseudoRecords.map(record => ({
      beforeCssPixels: record.beforeCssPixels,
      afterCssPixels: Number.parseFloat(getComputedStyle(record.element, record.pseudo).fontSize),
    }));
    const representativeFontSizes = representativeSelectors.map(({ label, selector: targetSelector }) => {
      const element = root.querySelector(targetSelector);
      const record = measured.find(item => item.parent === element);
      if (!record) throw new Error(`missing rendered text measurement for ${label}`);
      return {
        label, beforeCssPixels: record.beforeCssPixels,
        afterCssPixels: record.afterCssPixels,
      };
    });
    return {
      method: "computed-font-size-per-rendered-text-node",
      coverage: {
        textNodes: records.filter(record => record.kind === "text").length,
        formControls: controls.length,
        placeholderControls,
        selectedOptions,
        pseudoElements: pseudoRecords.length,
      },
      renderedTextNodes: measured.length + measuredPseudo.length,
      scaledTextNodes: [...measured, ...measuredPseudo].filter(item =>
        Math.abs(item.afterCssPixels - item.beforeCssPixels * 2) <= 0.05).length,
      representativeFontSizes,
    };
  }, { selector: rootSelector, representativeSelectors: representatives });
  textScaleObservations.push({ surface: rootSelector, ...observation });
  return observation;
}

async function reachControlByTab(page, control, maxStops = 200) {
  await page.evaluate(() => {
    const body = document.body;
    const prior = body.getAttribute("tabindex");
    body.tabIndex = -1;
    body.focus();
    if (prior === null) body.removeAttribute("tabindex");
    else body.setAttribute("tabindex", prior);
  });
  for (let stop = 1; stop <= maxStops; stop++) {
    await page.keyboard.press("Tab");
    if (await control.evaluate(element => document.activeElement === element)) return stop;
  }
  throw new Error(`control was not reachable within ${maxStops} Tab stops`);
}

async function activateJourneyControl(page, control, keyboard) {
  if (keyboard) {
    await reachControlByTab(page, control);
    await page.keyboard.press("Enter");
  } else {
    await control.click();
  }
}

async function bootData(page, viewportLabel, options = {}) {
  const { keyboard = false, textScalePercent = null } = options;
  if (textScalePercent !== null && textScalePercent !== 200)
    throw new Error("browser evidence supports only exact 200% text scaling");
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const renderedTree = await page.locator('meta[name="clay-source-tree"]').getAttribute("content");
  check(renderedTree === source.tree,
    `${viewportLabel}: served build is bound to the staged source tree`, { renderedTree, expected: source.tree });
  const template = page.getByText("Sales CRM", { exact: true });
  await template.waitFor({ timeout: 15_000 });
  // Normalize the parent boot's blank presentation cache before first seeding.
  await page.evaluate(() => {
    localStorage.removeItem("clay_apps");
    localStorage.removeItem("clay_current_app");
  });
  await template.click();
  await page.locator(".panel-frame").first().waitFor({ timeout: 25_000 });
  if (textScalePercent === 200) await scaleRenderedText200(page, "body");
  await activateJourneyControl(
    page, page.getByRole("button", { name: "Customize", exact: true }), keyboard,
  );
  if (textScalePercent === 200) await scaleRenderedText200(page, "body");
  await activateJourneyControl(page, page.getByRole("button", { name: "Open data" }), keyboard);
  await page.locator(".dataview").waitFor({ timeout: 15_000 });
  if (textScalePercent === 200) await scaleRenderedText200(page, ".dataview");
  await page.waitForTimeout(700); // includes the eagerly prefetched local ExportDialog chunk
  check(await page.locator('.dataview[role="dialog"]').count() === 1,
    `${viewportLabel}: trusted Data dialog is open`);
}

async function blockingAxe(page, selector) {
  const result = await new AxeBuilder({ page }).include(selector).analyze();
  return result.violations.filter(item => item.impact === "serious" || item.impact === "critical")
    .map(item => ({ id: item.id, impact: item.impact,
      targets: item.nodes.map(node => node.target) }));
}

async function observeMobileAppbarPopover(page, triggerSelector, menuSelector, itemSelector, label) {
  await page.locator(triggerSelector).click();
  const menu = page.locator(menuSelector);
  await menu.waitFor();
  await scaleRenderedText200(page, menuSelector);
  const observation = await menu.evaluate((element, selector) => {
    const items = [...element.querySelectorAll(selector)];
    if (items.length === 0 || items.some(item => !(item instanceof HTMLElement)))
      throw new Error("popover items are unavailable");
    const itemReachability = items.map(item => {
      item.scrollIntoView({ block: "nearest", inline: "nearest" });
      const rect = item.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      const fullyInViewport = rect.width > 0 && rect.height > 0
        && rect.left >= 0 && rect.top >= 0
        && rect.right <= innerWidth && rect.bottom <= innerHeight;
      return {
        rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
        fullyInViewport,
        itemWinsHitTest: Boolean(hit && (hit === item || item.contains(hit))),
      };
    });
    return {
      itemReachability,
      allItemsReachable: itemReachability.every(item =>
        item.fullyInViewport && item.itemWinsHitTest),
      appbarOverflowY: getComputedStyle(document.querySelector(".appbar")).overflowY,
      position: getComputedStyle(element).position,
    };
  }, itemSelector);
  check(observation.allItemsReachable,
    `mobile: every ${label} item is pointer reachable after app-bar reflow`, observation);
  await page.mouse.click(319, 799);
  await menu.waitFor({ state: "detached" });
  return observation;
}

const browser = await chromium.launch({ args: ["--enable-precise-memory-info"] });
const browserVersion = browser.version();
const errors = [];
let desktopEvidence;
let mobileEvidence;
let printTextSha256;
let accessibilityTreeEvidence;
let dialogStateObservations;
const keyboardAssertions = [];
const textScaleObservations = [];

try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1050 }, acceptDownloads: true,
  });
  await context.addInitScript(() => {
    window.__f3Evidence = {
      printCalls: 0, historyPush: 0, historyReplace: 0,
      blobUrls: [], downloadUrls: [],
    };
    window.print = () => { window.__f3Evidence.printCalls++; };
    const push = history.pushState.bind(history);
    const replace = history.replaceState.bind(history);
    history.pushState = (...args) => { window.__f3Evidence.historyPush++; return push(...args); };
    history.replaceState = (...args) => { window.__f3Evidence.historyReplace++; return replace(...args); };
    const createObjectUrl = URL.createObjectURL.bind(URL);
    URL.createObjectURL = value => {
      const objectUrl = createObjectUrl(value);
      window.__f3Evidence.blobUrls.push(objectUrl);
      return objectUrl;
    };
    const clickAnchor = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click() {
      if (this.download) window.__f3Evidence.downloadUrls.push(this.href);
      return clickAnchor.call(this);
    };
  });
  const page = await context.newPage();
  const requests = [];
  const webSockets = [];
  const assertDesktopOrigin = monitorProductGatePage(page, url);
  context.on("request", request => {
    requests.push(request.url());
    if (!isExpectedProductGateRequest(url, request.url()))
      errors.push(`unexpected network origin: ${request.url()}`);
  });
  context.on("requestfailed", request =>
    errors.push(`requestfailed: ${request.url()} (${request.failure()?.errorText ?? "unknown"})`));
  const monitorWebSockets = candidate =>
    candidate.on("websocket", socket => webSockets.push(socket.url()));
  context.on("page", monitorWebSockets);
  monitorWebSockets(page);
  page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
  page.on("console", message => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  await bootData(page, "desktop");
  await page.getByRole("button", { name: "deals", exact: true }).click();
  await page.getByText("Referral lead", { exact: true }).waitFor();

  // Establish a spreadsheet-hostile source value before the read-only export interval.
  const formulaCell = page.locator('td[aria-label^="title for Referral lead"]').first();
  await formulaCell.click();
  await formulaCell.locator("input").fill("=1+1");
  await formulaCell.locator("input").press("Enter");
  await page.getByText("=1+1", { exact: true }).waitFor();

  await page.getByLabel("Filter records").selectOption({ label: "source: referral" });
  const valueSort = page.getByRole("button", { name: "Sort by value" });
  await valueSort.click(); await valueSort.click();
  await page.locator(".field-picker summary").click();
  await page.locator(".field-picker label").filter({ hasText: /^owner$/ }).locator("input").uncheck();

  const grid = page.locator(".dataview-grid");
  const screenHeadings = await grid.locator("thead th:not(.dataview-select-cell):not(.dataview-addcol-th)")
    .evaluateAll(nodes => nodes.map(node => node.querySelector(".dataview-sort-button")?.childNodes[0]?.textContent?.trim() ?? ""));
  const screenRows = await grid.locator("tbody tr:not(.dataview-new):not(.dataview-hist)")
    .evaluateAll(rows => rows.map(row => [...row.querySelectorAll("td[data-grid-cell]")]
      .map(cell => cell.textContent?.replace(/ ↗$/, "").trim() ?? "")));
  check(screenRows.length === 3, "desktop: filter produces three exact visible rows");
  check(screenRows[0]?.[0] === "BrightLab expansion" && screenRows[2]?.[0] === "=1+1",
    "desktop: descending numeric sort is visible before preview", screenRows.map(row => row[0]));
  const opfsBefore = await settledOpfsSnapshot(page);
  check(opfsBefore.supported && opfsBefore.files.length > 0,
    "desktop: OPFS content snapshot is available before export", opfsBefore);

  const trigger = page.getByRole("button", { name: "Preview Print / CSV for current Data view" });
  await trigger.focus();
  const requestBaseline = requests.length;
  const webSocketBaseline = webSockets.length;
  const historyBaseline = await page.evaluate(() => ({ ...window.__f3Evidence }));
  await trigger.press("Enter");
  const dialog = page.locator(".export-dialog");
  await dialog.locator("tbody").waitFor({ timeout: 15_000 });
  const previewRequests = requests.slice(requestBaseline);
  check(previewRequests.length === 0, "desktop: projection/preview makes zero network requests", previewRequests);
  check(await dialog.getByText("3 rows × 8 fields", { exact: true }).count() >= 1,
    "desktop: preview discloses exact row and field count");
  for (const policy of [
    "Friendly labels; relation IDs excluded", "Attachments excluded",
    "Hidden and unselected fields excluded", "No redactions", "Complete — no truncation",
  ]) check((await dialog.textContent()).includes(policy), `desktop: preview discloses ${policy}`);

  const previewHeadings = await dialog.locator("thead th").allTextContents();
  const previewRows = await dialog.locator("tbody tr").evaluateAll(rows => rows.map(row =>
    [...row.querySelectorAll(".projection-cell-value")].map(cell => cell.textContent ?? "")));
  check(JSON.stringify(previewHeadings.map(label => label.toLocaleLowerCase("en-US")))
      === JSON.stringify(screenHeadings.map(label => label.toLocaleLowerCase("en-US"))),
    "desktop: preview field order/logical labels exactly match visible Data", { screenHeadings, previewHeadings });
  check(JSON.stringify(previewRows) === JSON.stringify(screenRows),
    "desktop: preview values/row order exactly match visible Data");
  check((await dialog.textContent()).includes("CSV: '=1+1"),
    "desktop: formula neutralization is visible before download");
  check((await dialog.getByRole("button", { name: "Print / Save as PDF", exact: true }).textContent())
    === "Print / Save as PDF", "desktop: native print action has the exact required label");
  check(await dialog.getByText("Download PDF", { exact: true }).count() === 0,
    "desktop: no direct PDF download exists");

  const axe = await blockingAxe(page, ".export-dialog");
  check(axe.length === 0, "desktop: export preview has zero serious/critical axe violations", axe);
  const accessibilitySession = await context.newCDPSession(page);
  const fullTree = await accessibilitySession.send("Accessibility.getFullAXTree");
  accessibilityTreeEvidence = fullTree.nodes.filter(node => !node.ignored).map(node => ({
    role: node.role?.value ?? null,
    name: node.name?.value ?? null,
    description: node.description?.value ?? null,
  })).filter(node => node.role || node.name);
  check(accessibilityTreeEvidence.some(node => node.role === "dialog"
      && String(node.name).includes("Preview Print / CSV")),
    "desktop: Chromium accessibility tree exposes the named export dialog");
  check(accessibilityTreeEvidence.some(node => node.role === "table"),
    "desktop: Chromium accessibility tree exposes the semantic preview table");
  check(accessibilityTreeEvidence.some(node => node.role === "columnheader"),
    "desktop: Chromium accessibility tree exposes semantic column headers");
  check(accessibilityTreeEvidence.some(node => node.role === "cell"),
    "desktop: Chromium accessibility tree exposes semantic data cells");
  check(accessibilityTreeEvidence.some(node => node.role === "heading"
      && String(node.name).length > 0),
    "desktop: Chromium accessibility tree exposes the print-document heading");
  check(accessibilityTreeEvidence.some(node => node.role === "button"
      && String(node.name).includes("Download CSV")),
    "desktop: Chromium accessibility tree exposes the named CSV action");
  await writeFile(join(outDir, "accessibility-tree.json"),
    `${JSON.stringify(accessibilityTreeEvidence, null, 2)}\n`);
  await page.screenshot({ path: join(outDir, "desktop-current-view.png"), fullPage: true });

  const downloadPromise = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download CSV", exact: true }).click();
  const download = await downloadPromise;
  const csvPath = join(outDir, "current-view.csv");
  await download.saveAs(csvPath);
  const csvBytes = await readFile(csvPath);
  const csvRows = parseCsv(csvBytes.toString("utf8"));
  const expectedCsv = [previewHeadings.map(csvSafe), ...previewRows.map(row => row.map(csvSafe))];
  check(JSON.stringify(csvRows) === JSON.stringify(expectedCsv),
    "desktop: downloaded RFC 4180 CSV exactly matches preview plus disclosed formula safety",
    { expectedCsv, csvRows });
  check(csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf,
    "desktop: CSV is deterministic UTF-8 with BOM");
  const csvSha256 = createHash("sha256").update(csvBytes).digest("hex");

  await dialog.getByRole("button", { name: "Print / Save as PDF", exact: true }).click();
  await page.waitForFunction(() => window.__f3Evidence.printCalls === 1
    && document.querySelector('.projection-print-root[data-print-ready="true"]') !== null);
  check(await page.evaluate(() => window.__f3Evidence.printCalls) === 1,
    "desktop: print action invokes only browser-native window.print");
  const printRoot = page.locator('body > .projection-print-root[data-print-ready="true"]');
  check(await dialog.locator("tbody tr").count() === previewRows.length,
    "desktop: print preparation leaves the bounded React preview unchanged");
  const orderedPrintValues = await printRoot.locator("h1, p, h2, caption, th, td").allTextContents();
  await page.emulateMedia({ media: "print" });
  check(await dialog.locator(".export-dialog-actions").evaluate(element =>
    getComputedStyle(element).display === "none"), "print CSS excludes export controls");
  check(await page.locator(".dataview").evaluate(element =>
    getComputedStyle(element).visibility === "hidden"), "print CSS excludes Data controls/navigation");
  check(await printRoot.locator("thead").first().evaluate(element =>
    getComputedStyle(element).display === "table-row-group"),
  "print CSS keeps one header inside each deterministic horizontal segment");
  check(await printRoot.isVisible(),
    "print CSS keeps only the bounded trusted print document visible");
  await page.screenshot({ path: join(outDir, "desktop-print-media.png"), fullPage: true });
  const printPdfPath = join(outDir, "desktop-print.pdf");
  await page.pdf({ path: printPdfPath, format: "A4", landscape: true, printBackground: true });
  const printPdfBytes = await readFile(printPdfPath);
  check(printPdfBytes.subarray(0, 5).toString("ascii") === "%PDF-" && printPdfBytes.byteLength > 1_000,
    "desktop: browser print renderer emits a non-empty PDF document");
  const printText = execFileSync("pdftotext", ["-enc", "UTF-8", "-raw", printPdfPath, "-"],
    { encoding: "utf8" });
  check(pdfTextMatchesExactSequence(printText, orderedPrintValues),
    "desktop: selectable PDF text exactly matches the complete print document",
    orderedPrintValues);
  printTextSha256 = sha256Evidence(Buffer.from(printText));
  const printPdf = await artifactDigest("desktop-print.pdf");
  await page.emulateMedia({ media: "screen" });

  await dialog.press("Escape");
  await dialog.waitFor({ state: "detached" });
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label")
    === "Preview Print / CSV for current Data view", undefined, { timeout: 2_000 });
  check(await trigger.evaluate(element => element === document.activeElement),
    "desktop: Escape closes preview and restores keyboard focus");
  const historyAfter = await page.evaluate(() => ({ ...window.__f3Evidence }));
  check(historyAfter.historyPush === historyBaseline.historyPush
      && historyAfter.historyReplace === historyBaseline.historyReplace,
    "desktop: preview/CSV/print does not mutate browser history", { historyBaseline, historyAfter });
  const exportRequests = requests.slice(requestBaseline);
  const exportEgress = assertLocalExportActionEgress({
    actions: [
      ...(historyAfter.downloadUrls.length > historyBaseline.downloadUrls.length ? ["csv"] : []),
      ...(historyAfter.printCalls === historyBaseline.printCalls + 1 ? ["print"] : []),
    ],
    requests: exportRequests,
    webSockets: webSockets.slice(webSocketBaseline),
    blobUrls: historyAfter.blobUrls.slice(historyBaseline.blobUrls.length),
    downloadUrls: historyAfter.downloadUrls.slice(historyBaseline.downloadUrls.length),
  });
  check(exportEgress.httpRequests === 0 && exportEgress.webSockets === 0,
    "desktop: preview, CSV download, and print make zero network or WebSocket egress",
    exportEgress);

  const firstRow = grid.locator("tbody tr:not(.dataview-new):not(.dataview-hist)").first();
  const recordOpen = firstRow.getByRole("button", { name: /record details/ });
  const selectedRecordId = await recordOpen.getAttribute("data-id");
  check(typeof selectedRecordId === "string" && selectedRecordId.length > 0,
    "record: selected Data row exposes its stable record identity");
  await recordOpen.click();
  const record = page.locator(".record-detail");
  await record.waitFor();
  await page.waitForTimeout(500);
  check((await record.locator("h2").textContent())?.trim() === screenRows[0]?.[0],
    "record: detail heading matches the selected visible row");
  const recordFieldPairs = (await record.locator(".record-field").evaluateAll(fields => fields
    .flatMap(field => {
      if (!(field instanceof HTMLElement) || field.classList.contains("record-file-field")) return [];
      const label = (field.querySelector(":scope > label, :scope > span")?.textContent ?? "").trim();
      const select = field.querySelector("select");
      const input = field.querySelector("input");
      const textarea = field.querySelector("textarea");
      const output = field.querySelector("output");
      let value = "";
      if (select instanceof HTMLSelectElement) value = [...select.selectedOptions]
        .map(option => option.value === "" ? "" : option.textContent?.trim() ?? "").join(", ");
      else if (input instanceof HTMLInputElement) value = input.type === "checkbox"
        ? String(input.checked) : input.value;
      else if (textarea instanceof HTMLTextAreaElement) value = textarea.value;
      else if (output) value = output.textContent?.trim() === "—" ? "" : output.textContent?.trim() ?? "";
      return label ? [[label, value]] : [];
    })));
  const recordBaseline = requests.length;
  const recordWebSocketBaseline = webSockets.length;
  const recordEvidenceBaseline = await page.evaluate(() => ({ ...window.__f3Evidence }));
  const recordTrigger = record.getByRole("button", { name: "Preview Print / CSV for this record" });
  await recordTrigger.focus(); await recordTrigger.press("Enter");
  const recordDialog = page.locator(".export-dialog");
  await recordDialog.locator("tbody").waitFor();
  check(requests.slice(recordBaseline).length === 0,
    "record: projection/preview makes zero network requests", requests.slice(recordBaseline));
  check(await recordDialog.locator("tbody tr").count() === 1,
    "record: exactly one canonical row is previewed");
  const recordHeadings = await recordDialog.locator(".projection-field-label").allTextContents();
  const recordPreviewRows = await recordDialog.locator("tbody tr").evaluateAll(rows => rows.map(row =>
    [...row.querySelectorAll(".projection-cell-value")].map(cell => cell.textContent ?? "")));
  check(JSON.stringify(recordHeadings) === JSON.stringify(recordFieldPairs.map(pair => pair[0])),
    "record: preview headings exactly match visible record fields",
    { recordHeadings, recordFieldPairs });
  check(JSON.stringify(recordPreviewRows) === JSON.stringify([recordFieldPairs.map(pair => pair[1])]),
    "record: preview values exactly match the selected record",
    { selectedRecordId, recordFieldPairs, recordPreviewRows });
  check((await recordDialog.textContent()).includes("1 rows × 9 fields"),
    "record: exact one-record field count is disclosed");
  const recordAxe = await blockingAxe(page, ".export-dialog");
  check(recordAxe.length === 0, "record: export preview has zero serious/critical axe violations",
    recordAxe);
  const recordDownloadPromise = page.waitForEvent("download");
  await recordDialog.getByRole("button", { name: "Download CSV", exact: true }).click();
  const recordDownload = await recordDownloadPromise;
  const recordCsvPath = join(outDir, "record.csv");
  await recordDownload.saveAs(recordCsvPath);
  const recordCsvBytes = await readFile(recordCsvPath);
  const recordCsvRows = parseCsv(recordCsvBytes.toString("utf8"));
  const expectedRecordCsv = [recordHeadings.map(csvSafe),
    ...recordPreviewRows.map(row => row.map(csvSafe))];
  check(JSON.stringify(recordCsvRows) === JSON.stringify(expectedRecordCsv),
    "record: downloaded CSV exactly matches its one-record preview",
    { recordCsvRows, expectedRecordCsv });
  const recordPrintBaseline = await page.evaluate(() => window.__f3Evidence.printCalls);
  await recordDialog.getByRole("button", { name: "Print / Save as PDF", exact: true }).click();
  await page.waitForFunction(expected => window.__f3Evidence.printCalls === expected
    && document.querySelector('.projection-print-root[data-print-ready="true"]') !== null,
  recordPrintBaseline + 1);
  check(await page.evaluate(expected => window.__f3Evidence.printCalls === expected,
    recordPrintBaseline + 1),
    "record: native Print action is invoked exactly once");
  await page.screenshot({ path: join(outDir, "desktop-record.png"), fullPage: true });
  const opfsAfter = await settledOpfsSnapshot(page);
  check(JSON.stringify(opfsAfter) === JSON.stringify(opfsBefore),
    "desktop: current-view/record preview, CSV, and print leave OPFS byte-identical",
    { before: opfsBefore, after: opfsAfter });
  const recordEvidenceAfter = await page.evaluate(() => ({ ...window.__f3Evidence }));
  const recordExportRequests = requests.slice(recordBaseline);
  const recordEgress = assertLocalExportActionEgress({
    actions: [
      ...(recordEvidenceAfter.downloadUrls.length > recordEvidenceBaseline.downloadUrls.length
        ? ["csv"] : []),
      ...(recordEvidenceAfter.printCalls === recordEvidenceBaseline.printCalls + 1
        ? ["print"] : []),
    ],
    requests: recordExportRequests,
    webSockets: webSockets.slice(recordWebSocketBaseline),
    blobUrls: recordEvidenceAfter.blobUrls.slice(recordEvidenceBaseline.blobUrls.length),
    downloadUrls: recordEvidenceAfter.downloadUrls.slice(recordEvidenceBaseline.downloadUrls.length),
  });
  check(recordEgress.httpRequests === 0 && recordEgress.webSockets === 0,
    "record: preview, CSV download, and print make zero network or WebSocket egress",
    recordEgress);
  assertDesktopOrigin();
  check(true, "desktop: browser remained on the configured preview origin");

  desktopEvidence = {
    viewport: { width: 1440, height: 1050 }, totalRequests: requests.length,
    screenHeadings, screenRows, previewHeadings, previewRows,
    exportRequests, recordExportRequests,
    csv: { bytes: csvBytes.byteLength, sha256: `sha256:${csvSha256}`, rows: csvRows.length - 1,
      fields: csvRows[0]?.length ?? 0 },
    record: {
      id: selectedRecordId, fieldPairs: recordFieldPairs,
      headings: recordHeadings, rows: recordPreviewRows,
      csv: { bytes: recordCsvBytes.byteLength, sha256: sha256Evidence(recordCsvBytes) },
      printCalls: 1,
    },
    printPdf,
    egress: { currentView: exportEgress, record: recordEgress },
    axeBlocking: axe,
    recordAxeBlocking: recordAxe,
    opfs: { before: opfsBefore, after: opfsAfter, unchanged: true },
    printCalls: historyAfter.printCalls,
    historyDelta: {
      push: historyAfter.historyPush - historyBaseline.historyPush,
      replace: historyAfter.historyReplace - historyBaseline.historyReplace,
    },
  };
  await context.close();

  const mobile = await browser.newContext({
    viewport: { width: 320, height: 800 },
    reducedMotion: "reduce", forcedColors: "active",
  });
  const mobilePage = await mobile.newPage();
  const mobileRequests = [];
  const assertMobileOrigin = monitorProductGatePage(mobilePage, url);
  mobilePage.on("request", request => {
    mobileRequests.push(request.url());
    if (!isExpectedProductGateRequest(url, request.url()))
      errors.push(`mobile unexpected network origin: ${request.url()}`);
  });
  mobilePage.on("requestfailed", request =>
    errors.push(`mobile requestfailed: ${request.url()} (${request.failure()?.errorText ?? "unknown"})`));
  mobilePage.on("pageerror", error => errors.push(`mobile pageerror: ${error.message}`));
  mobilePage.on("console", message => {
    if (message.type() === "error") errors.push(`mobile console: ${message.text()}`);
  });
  await bootData(mobilePage, "mobile", { keyboard: true, textScalePercent: 200 });
  await activateJourneyControl(
    mobilePage, mobilePage.getByRole("button", { name: "Close data view" }), true,
  );
  await mobilePage.locator(".dataview").waitFor({ state: "detached" });
  const appbarReflow = await mobilePage.locator(".appbar").evaluate(element => ({
    clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
    appbarFitsViewport: element.scrollWidth <= element.clientWidth,
  }));
  check(appbarReflow.appbarFitsViewport,
    "mobile: app-bar controls reflow without internal horizontal scrolling", appbarReflow);
  const appbarPopovers = {
    appMenu: await observeMobileAppbarPopover(
      mobilePage, ".appbar-current", ".appbar-menu", ".appbar-item", "app menu",
    ),
    themeMenu: await observeMobileAppbarPopover(
      mobilePage, ".appbar-theme-btn", ".appbar-theme-menu", ".theme-swatch", "theme menu",
    ),
  };
  await activateJourneyControl(
    mobilePage, mobilePage.getByRole("button", { name: "Open data" }), true,
  );
  await mobilePage.locator(".dataview").waitFor({ timeout: 15_000 });
  await scaleRenderedText200(mobilePage, ".dataview");
  const adaptationMedia = await mobilePage.evaluate(() => ({
    forcedColors: matchMedia("(forced-colors: active)").matches,
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
  }));
  check(adaptationMedia.forcedColors && adaptationMedia.reducedMotion,
    "mobile: forced-colors and reduced-motion adaptations are active", adaptationMedia);
  const mobileBaseline = mobileRequests.length;
  const recordKeyboardAssertion = (condition, label, detail = undefined) => {
    check(condition, label, detail);
    keyboardAssertions.push(label);
  };
  const mobileTrigger = mobilePage.getByRole(
    "button", { name: "Preview Print / CSV for current Data view" },
  );
  await reachControlByTab(mobilePage, mobileTrigger);
  await mobilePage.keyboard.press("Enter");
  const mobileDialog = mobilePage.locator(".export-dialog");
  await mobileDialog.locator("tbody").waitFor();
  recordKeyboardAssertion(await mobileDialog.count() === 1,
    "Enter opened the export preview from its focused trigger.");
  const textResize = await scaleRenderedText200(mobilePage, ".export-dialog", [
    { label: "dialog title", selector: "#export-dialog-title" },
    { label: "local-only badge", selector: ".export-local-badge" },
    { label: "primary print action", selector: ".export-dialog-actions .primary" },
  ]);
  check(textResize.renderedTextNodes > 0
      && textResize.scaledTextNodes === textResize.renderedTextNodes,
  "mobile: every rendered export-dialog text node measures at actual 200% text size",
  textResize);
  const dialogGeometry = await mobileDialog.evaluate(element => {
    const tableRegion = element.querySelector(".projection-table-scroll");
    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      dialogInternalHorizontalOverflow: element.scrollWidth > element.clientWidth,
      tableRegionHorizontalScrollOnly: tableRegion instanceof HTMLElement
        && tableRegion.scrollWidth >= tableRegion.clientWidth,
    };
  });
  check(!dialogGeometry.dialogInternalHorizontalOverflow,
    "mobile: export dialog reflows without dialog-level horizontal scrolling", dialogGeometry);
  const targetActions = ["Cancel", "Download CSV", "Print / Save as PDF"];
  const targetReachability = [];
  for (const name of targetActions) targetReachability.push(await mobileDialog
    .getByRole("button", { name, exact: true }).evaluate(element => {
      element.scrollIntoView({ block: "center", inline: "nearest" });
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return rect.width > 0 && rect.height > 0
        && rect.left >= 0 && rect.top >= 0
        && rect.right <= innerWidth && rect.bottom <= innerHeight
        && Boolean(hit && (hit === element || element.contains(hit)));
    }));
  check(targetReachability.every(Boolean),
    "mobile: every export action remains scroll-reachable after 200% text resizing",
    { actions: targetActions, reachable: targetReachability });
  check(mobileRequests.slice(mobileBaseline).length === 0,
    "mobile: projection/preview makes zero network requests", mobileRequests.slice(mobileBaseline));
  const dialogFitsViewport = await mobileDialog.evaluate(element =>
    element.getBoundingClientRect().width <= innerWidth);
  check(dialogFitsViewport, "mobile: preview fits the viewport");
  const mobileReflow = await mobilePage.evaluate(() => {
    window.scrollTo(0, 0);
    const root = document.documentElement;
    const viewportWidth = root.clientWidth;
    const overflowingElements = [...document.body.querySelectorAll("*")].flatMap(element => {
      const rect = element.getBoundingClientRect();
      if (rect.left >= -0.5 && rect.right <= viewportWidth + 0.5) return [];
      const style = getComputedStyle(element);
      return [{
        tag: element.tagName.toLocaleLowerCase("en-US"),
        id: element.id.slice(0, 80),
        className: typeof element.className === "string" ? element.className.slice(0, 160) : "",
        left: Math.round(rect.left * 100) / 100,
        right: Math.round(rect.right * 100) / 100,
        width: Math.round(rect.width * 100) / 100,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        overflowX: style.overflowX,
      }];
    }).slice(0, 25);
    return {
      horizontalDocumentOverflow: root.scrollWidth > viewportWidth,
      documentClientWidth: viewportWidth,
      documentScrollWidth: root.scrollWidth,
      overflowingElements,
    };
  });
  const horizontalDocumentOverflow = mobileReflow.horizontalDocumentOverflow;
  await mobilePage.screenshot({ path: join(outDir, "mobile-320px-200pct.png"), fullPage: true });
  check(!horizontalDocumentOverflow,
    "mobile: 320 CSS px at 200% text scale has no document-level horizontal overflow",
    mobileReflow);
  check(await mobileDialog.getByRole("button", { name: "Print / Save as PDF" }).evaluate(element =>
    element.getBoundingClientRect().height >= 44), "mobile: primary print target is at least 44px high");
  const mobileAxe = await blockingAxe(mobilePage, ".export-dialog");
  check(mobileAxe.length === 0, "mobile: export preview has zero serious/critical axe violations", mobileAxe);
  const focusableSelector = [
    "button:not([disabled]):not([tabindex='-1'])", "[href]:not([tabindex='-1'])",
    "input:not([disabled]):not([tabindex='-1'])", "select:not([disabled]):not([tabindex='-1'])",
    "textarea:not([disabled]):not([tabindex='-1'])", "[tabindex]:not([tabindex='-1'])",
  ].join(",");
  await mobileDialog.evaluate((element, selector) => {
    const controls = [...element.querySelectorAll(selector)]
      .filter(control => control instanceof HTMLElement && control.getClientRects().length > 0);
    const lastControl = controls.at(-1);
    if (!(lastControl instanceof HTMLElement)) throw new Error("dialog has no final focus control");
    lastControl.focus();
  }, focusableSelector);
  await mobilePage.keyboard.press("Tab");
  recordKeyboardAssertion(await mobileDialog.evaluate((element, selector) => {
    const firstControl = [...element.querySelectorAll(selector)]
      .find(control => control instanceof HTMLElement && control.getClientRects().length > 0);
    return document.activeElement === firstControl;
  }, focusableSelector), "Tab wrapped from the final control to the first control.");
  await mobileDialog.evaluate((element, selector) => {
    const firstControl = [...element.querySelectorAll(selector)]
      .find(control => control instanceof HTMLElement && control.getClientRects().length > 0);
    if (!(firstControl instanceof HTMLElement)) throw new Error("dialog has no first focus control");
    firstControl.focus();
  }, focusableSelector);
  await mobilePage.keyboard.press("Shift+Tab");
  recordKeyboardAssertion(await mobileDialog.evaluate((element, selector) => {
    const controls = [...element.querySelectorAll(selector)]
      .filter(control => control instanceof HTMLElement && control.getClientRects().length > 0);
    const lastControl = controls.at(-1);
    return document.activeElement === lastControl;
  }, focusableSelector), "Shift+Tab wrapped from the first control to the final control.");
  recordKeyboardAssertion(await mobilePage.evaluate(() => {
    const outside = document.querySelector(".appbar button");
    const activeDialog = document.querySelector(".export-dialog");
    if (!(outside instanceof HTMLElement) || !(activeDialog instanceof HTMLElement)) return false;
    outside.focus();
    return document.activeElement !== outside && activeDialog.contains(document.activeElement);
  }), "Inert app content could not receive focus outside the export preview.");
  const mobileCancel = mobileDialog.getByRole("button", { name: "Cancel", exact: true });
  await mobileCancel.focus();
  await mobilePage.keyboard.press("Space");
  await mobileDialog.waitFor({ state: "detached" });
  recordKeyboardAssertion(await mobileDialog.count() === 0,
    "Space activated Cancel and closed the export preview.");
  recordKeyboardAssertion(await mobileTrigger.evaluate(element => element === document.activeElement),
    "Focus returned to the export trigger after Space activated Cancel.");
  await reachControlByTab(mobilePage, mobileTrigger);
  await mobilePage.keyboard.press("Enter");
  await mobileDialog.locator("tbody").waitFor();
  await scaleRenderedText200(mobilePage, ".export-dialog");
  recordKeyboardAssertion(await mobileDialog.count() === 1,
    "Enter reopened the export preview from its focused trigger.");
  await mobilePage.keyboard.press("Escape");
  await mobileDialog.waitFor({ state: "detached" });
  recordKeyboardAssertion(await mobileTrigger.evaluate(element => element === document.activeElement),
    "Escape closed the export preview and restored focus to its trigger.");
  assertMobileOrigin();
  check(true, "mobile: browser remained on the configured preview origin");
  mobileEvidence = {
    viewport: { width: 320, height: 800 },
    textScalePercent: 200,
    textResize: { ...textResize, surfaces: textScaleObservations },
    reflow: {
      horizontalDocumentOverflow, dialogFitsViewport,
      appbar: appbarReflow, dialog: dialogGeometry,
    },
    appbarPopovers,
    keyboardAssertions,
    targetReachability: { actions: targetActions, reachable: targetReachability },
    adaptations: adaptationMedia,
    totalRequests: mobileRequests.length,
    exportRequests: mobileRequests.slice(mobileBaseline), axeBlocking: mobileAxe,
  };
  await mobile.close();
  dialogStateObservations = await runExportDialogStateEvidence({ browser, url });
} finally {
  await browser.close();
}

assertExactCleanSource(checkout, source, "browser evidence after browser");
const browserClean = errors.length === 0;
checks.push({ ok: browserClean, label: "browser run has zero console, page, request, or origin errors",
  detail: errors });
console.log(`${browserClean ? "PASS" : "FAIL"} browser run has zero console, page, request, or origin errors`);
const passed = label => checks.some(item => item.label === label && item.ok);
const cases = [
  { id: "current-view-preview-exact", status:
    passed("desktop: preview field order/logical labels exactly match visible Data")
      && passed("desktop: preview values/row order exactly match visible Data") ? "PASS" : "FAIL" },
  { id: "current-view-csv-exact", status:
    passed("desktop: downloaded RFC 4180 CSV exactly matches preview plus disclosed formula safety")
      && passed("desktop: CSV is deterministic UTF-8 with BOM") ? "PASS" : "FAIL" },
  { id: "print-document-exact", status:
    passed("desktop: selectable PDF text exactly matches the complete print document")
      && passed("desktop: print action invokes only browser-native window.print") ? "PASS" : "FAIL" },
  { id: "record-preview-exact", status:
    passed("record: preview headings exactly match visible record fields")
      && passed("record: preview values exactly match the selected record") ? "PASS" : "FAIL" },
  { id: "record-actions-exact", status:
    passed("record: downloaded CSV exactly matches its one-record preview")
      && passed("record: native Print action is invoked exactly once") ? "PASS" : "FAIL" },
  { id: "network-local-only", status: browserClean
    && passed("desktop: preview, CSV download, and print make zero network or WebSocket egress")
    && passed("record: preview, CSV download, and print make zero network or WebSocket egress")
    && passed("mobile: projection/preview makes zero network requests") ? "PASS" : "FAIL" },
  { id: "durable-state-unchanged", status:
    passed("desktop: current-view/record preview, CSV, and print leave OPFS byte-identical")
      && passed("desktop: preview/CSV/print does not mutate browser history") ? "PASS" : "FAIL" },
  { id: "mobile-reflow", status:
    passed("mobile: every rendered export-dialog text node measures at actual 200% text size")
      && passed("mobile: export dialog reflows without dialog-level horizontal scrolling")
      && passed("mobile: 320 CSS px at 200% text scale has no document-level horizontal overflow")
      ? "PASS" : "FAIL" },
  { id: "mobile-controls-reachable", status:
    passed("mobile: every app menu item is pointer reachable after app-bar reflow")
      && passed("mobile: every theme menu item is pointer reachable after app-bar reflow")
      && passed("mobile: every export action remains scroll-reachable after 200% text resizing")
      ? "PASS" : "FAIL" },
  { id: "keyboard-complete", status: keyboardAssertions.length >= 7 ? "PASS" : "FAIL" },
  { id: "automated-accessibility", status:
    passed("desktop: export preview has zero serious/critical axe violations")
      && passed("record: export preview has zero serious/critical axe violations")
      && passed("mobile: export preview has zero serious/critical axe violations")
      ? "PASS" : "FAIL" },
];
const generatedArtifacts = await Promise.all([
  "accessibility-tree.json", "current-view.csv", "record.csv", "desktop-current-view.png",
  "desktop-print-media.png", "desktop-print.pdf", "desktop-record.png",
  "mobile-320px-200pct.png",
].map(artifactDigest));
const artifacts = manualScreenReader.artifact
  ? [...generatedArtifacts, manualScreenReader.artifact] : generatedArtifacts;
const automatedPass = cases.every(item => item.status === "PASS") && browserClean;
const observedAccessibility = summarizeExportDialogStateEvidence(dialogStateObservations);
const report = LocalExportEvidenceManifestV2.parse({
  schema: "LocalExportEvidenceManifestV2",
  generatedAt: new Date().toISOString(),
  source,
  build,
  browser: { name: "chromium", version: browserVersion, headless: true },
  url,
  requirements: [...LOCAL_EXPORT_REQUIRED_REQUIREMENTS_V2],
  gates: [
    { id: "local-print-csv", status: "PASS" },
    { id: "direct-pdf", status: "NOT_SHIPPED" },
    { id: "hosted-encrypted-snapshots", status: "NOT_SHIPPED" },
    { id: "hosted-public-intake", status: "NOT_SHIPPED" },
    { id: "hosted-file-requests", status: "NOT_SHIPPED" },
  ],
  observations: {
    desktop: {
      currentView: {
        headings: desktopEvidence.previewHeadings,
        rows: desktopEvidence.previewRows,
        csv: { ...desktopEvidence.csv, exact: true },
      },
      record: {
        id: desktopEvidence.record.id,
        headings: desktopEvidence.record.headings,
        rows: desktopEvidence.record.rows,
        csv: desktopEvidence.record.csv,
        csvExact: true,
        printCalls: desktopEvidence.record.printCalls,
      },
      print: {
        artifact: desktopEvidence.printPdf.file,
        extractedSha256: printTextSha256,
        exact: true,
      },
      opfsUnchanged: desktopEvidence.opfs.unchanged,
      historyUnchanged: desktopEvidence.historyDelta.push === 0
        && desktopEvidence.historyDelta.replace === 0,
      axeBlocking: desktopEvidence.axeBlocking.length
        + desktopEvidence.recordAxeBlocking.length,
    },
    mobile: {
      viewport: mobileEvidence.viewport,
      textScalePercent: mobileEvidence.textScalePercent,
      surfaces: mobileEvidence.textResize.surfaces,
      horizontalDocumentOverflow: mobileEvidence.reflow.horizontalDocumentOverflow,
      dialogFitsViewport: mobileEvidence.reflow.dialogFitsViewport,
      appMenuReachable: mobileEvidence.appbarPopovers.appMenu.allItemsReachable,
      themeMenuReachable: mobileEvidence.appbarPopovers.themeMenu.allItemsReachable,
      keyboardAssertions: mobileEvidence.keyboardAssertions,
      actionsReachable: mobileEvidence.targetReachability.reachable.every(Boolean),
      axeBlocking: mobileEvidence.axeBlocking.length,
    },
    network: {
      desktopExportRequests: desktopEvidence.exportRequests.length,
      recordExportRequests: desktopEvidence.recordExportRequests.length,
      mobileExportRequests: mobileEvidence.exportRequests.length,
      desktopActions: desktopEvidence.egress.currentView.actions,
      recordActions: desktopEvidence.egress.record.actions,
      desktopWebSockets: desktopEvidence.egress.currentView.webSockets,
      recordWebSockets: desktopEvidence.egress.record.webSockets,
      desktopBlobUrls: desktopEvidence.egress.currentView.blobUrls.length,
      recordBlobUrls: desktopEvidence.egress.record.blobUrls.length,
      desktopDownloadBlobUrls: desktopEvidence.egress.currentView.downloadUrls.length,
      recordDownloadBlobUrls: desktopEvidence.egress.record.downloadUrls.length,
      unexpected: errors.filter(error => error.includes("network")
        || error.includes("requestfailed")),
    },
  },
  cases,
  artifacts,
  errors,
  accessibility: {
    schema: "AccessibilityEvidenceV1",
    axe: observedAccessibility.axe,
    keyboard: {
      status: "PASS", viewportWidth: 320, textScalePercent: 200,
      assertions: keyboardAssertions,
    },
    reflow320At200Percent: {
      status: "PASS", viewportWidth: 320, textScalePercent: 200,
      method: mobileEvidence.textResize.method,
      renderedTextNodes: mobileEvidence.textResize.renderedTextNodes,
      scaledTextNodes: mobileEvidence.textResize.scaledTextNodes,
      surfaces: mobileEvidence.textResize.surfaces,
      representativeFontSizes: mobileEvidence.textResize.representativeFontSizes,
      horizontalDocumentOverflow: mobileEvidence.reflow.horizontalDocumentOverflow,
      dialogFitsViewport: mobileEvidence.reflow.dialogFitsViewport,
      targetReachability: {
        status: "PASS", actions: ["Cancel", "Download CSV", "Print / Save as PDF"],
        allReachable: mobileEvidence.targetReachability.reachable.every(Boolean),
      },
      artifact: "mobile-320px-200pct.png",
    },
    screenReader: manualScreenReader.screenReader,
    accessibilityTree: {
      status: "PASS", browser: `Chromium ${browserVersion}`,
      assertions: [
        "Named export dialog is exposed.",
        "Semantic preview table is exposed.",
        "Column headers are exposed.",
        "Named Download CSV action is exposed.",
      ],
      artifact: "accessibility-tree.json",
    },
    focusRestoration: { status: "PASS", restoredToTrigger: true },
    liveProgress: observedAccessibility.liveProgress,
    errorLinkage: observedAccessibility.errorLinkage,
    printReadingOrder: {
      status: "PASS",
      method: "Chromium PDF output followed by pdftotext token-order assertion",
      artifact: "desktop-print.pdf",
      extractedSha256: printTextSha256,
    },
    adaptations: {
      status: "PASS",
      assertions: [
        "Every rendered dialog text node, including fixed-pixel descendants, measures at 200%.",
        "Forced-colors media query is active.",
        "Reduced-motion media query is active.",
      ],
    },
  },
  verdict: automatedPass
    ? manualScreenReader.screenReader.status === "PASS" ? "PASS" : "BLOCKED"
    : "FAIL",
});
await writeReleaseEvidenceDirectory(dirname(outDir), report, benchmarkEvidence);
if (report.verdict === "FAIL") throw new Error("local export browser evidence failed");
if (report.verdict === "BLOCKED") {
  console.log("LOCAL EXPORT BROWSER EVIDENCE BLOCKED: manual screen-reader evidence unavailable");
  throw new Error("manual NVDA or VoiceOver evidence is required before Release F can PASS");
}
console.log("LOCAL EXPORT BROWSER EVIDENCE PASS");
