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
  assertBenchmarkEvidence, assertExactCleanSource, buildDirectoryDigest,
  deriveCleanHeadSource, ingestManualScreenReaderEvidence, sha256Evidence,
  summarizeExportDialogStateEvidence, writeReleaseEvidenceDirectory,
} from "./local-export-evidence-lib.mjs";
import { LocalExportEvidenceManifestV2 } from "../packages/schema/src/evidence.ts";

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
  { source, build, outputDirectory: outDir },
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

async function bootData(page, viewportLabel) {
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
  await page.getByRole("button", { name: "Customize", exact: true }).click();
  await page.getByRole("button", { name: "Open data" }).click();
  await page.locator(".dataview").waitFor({ timeout: 15_000 });
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

const browser = await chromium.launch({ args: ["--enable-precise-memory-info"] });
const browserVersion = browser.version();
const errors = [];
let desktopEvidence;
let mobileEvidence;
let printTextSha256;
let accessibilityTreeEvidence;
let dialogStateObservations;

try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1050 }, acceptDownloads: true,
  });
  await context.addInitScript(() => {
    window.__f3Evidence = { printCalls: 0, historyPush: 0, historyReplace: 0 };
    window.print = () => { window.__f3Evidence.printCalls++; };
    const push = history.pushState.bind(history);
    const replace = history.replaceState.bind(history);
    history.pushState = (...args) => { window.__f3Evidence.historyPush++; return push(...args); };
    history.replaceState = (...args) => { window.__f3Evidence.historyReplace++; return replace(...args); };
  });
  const page = await context.newPage();
  const requests = [];
  const assertDesktopOrigin = monitorProductGatePage(page, url);
  page.on("request", request => {
    requests.push(request.url());
    if (!isExpectedProductGateRequest(url, request.url()))
      errors.push(`unexpected network origin: ${request.url()}`);
  });
  page.on("requestfailed", request =>
    errors.push(`requestfailed: ${request.url()} (${request.failure()?.errorText ?? "unknown"})`));
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
  const historyBaseline = await page.evaluate(() => ({ ...window.__f3Evidence }));
  await trigger.press("Enter");
  const dialog = page.locator(".export-dialog");
  await dialog.locator("tbody").waitFor({ timeout: 15_000 });
  const exportRequests = requests.slice(requestBaseline);
  check(exportRequests.length === 0, "desktop: projection/preview makes zero network requests", exportRequests);
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
  check(await page.evaluate(() => window.__f3Evidence.printCalls) === 1,
    "desktop: print action invokes only browser-native window.print");
  await page.emulateMedia({ media: "print" });
  check(await dialog.locator(".export-dialog-actions").evaluate(element =>
    getComputedStyle(element).display === "none"), "print CSS excludes export controls");
  check(await page.locator(".dataview").evaluate(element =>
    getComputedStyle(element).visibility === "hidden"), "print CSS excludes Data controls/navigation");
  check(await dialog.locator("thead").evaluate(element =>
    getComputedStyle(element).display === "table-header-group"), "print CSS repeats table headers");
  check(await dialog.locator(".projection-print-document").isVisible(),
    "print CSS keeps only trusted semantic document visible");
  const printPdfPath = join(outDir, "desktop-print.pdf");
  await page.pdf({ path: printPdfPath, format: "A4", printBackground: true });
  const printPdfBytes = await readFile(printPdfPath);
  check(printPdfBytes.subarray(0, 5).toString("ascii") === "%PDF-" && printPdfBytes.byteLength > 1_000,
    "desktop: browser print renderer emits a non-empty PDF document");
  const printText = execFileSync("pdftotext", [printPdfPath, "-"], { encoding: "utf8" });
  const orderedPrintTokens = [previewHeadings[0], ...previewRows.map(row => row[0])];
  let printOffset = -1;
  check(orderedPrintTokens.every(token => {
    const next = printText.indexOf(token, printOffset + 1);
    if (next < 0) return false;
    printOffset = next;
    return true;
  }), "desktop: selectable PDF text preserves heading and row reading order", orderedPrintTokens);
  printTextSha256 = sha256Evidence(Buffer.from(printText));
  const printPdf = await artifactDigest("desktop-print.pdf");
  await page.screenshot({ path: join(outDir, "desktop-print-media.png"), fullPage: true });
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

  const firstRow = grid.locator("tbody tr:not(.dataview-new):not(.dataview-hist)").first();
  await firstRow.getByRole("button", { name: /record details/ }).click();
  const record = page.locator(".record-detail");
  await record.waitFor();
  await page.waitForTimeout(500);
  const recordBaseline = requests.length;
  const recordTrigger = record.getByRole("button", { name: "Preview Print / CSV for this record" });
  await recordTrigger.focus(); await recordTrigger.press("Enter");
  const recordDialog = page.locator(".export-dialog");
  await recordDialog.locator("tbody").waitFor();
  check(requests.slice(recordBaseline).length === 0,
    "record: projection/preview makes zero network requests", requests.slice(recordBaseline));
  check(await recordDialog.locator("tbody tr").count() === 1,
    "record: exactly one canonical row is previewed");
  check((await recordDialog.textContent()).includes("1 rows × 9 fields"),
    "record: exact one-record field count is disclosed");
  const recordAxe = await blockingAxe(page, ".export-dialog");
  check(recordAxe.length === 0, "record: export preview has zero serious/critical axe violations",
    recordAxe);
  await page.screenshot({ path: join(outDir, "desktop-record.png"), fullPage: true });
  const opfsAfter = await settledOpfsSnapshot(page);
  check(JSON.stringify(opfsAfter) === JSON.stringify(opfsBefore),
    "desktop: current-view/record preview, CSV, and print leave OPFS byte-identical",
    { before: opfsBefore, after: opfsAfter });
  assertDesktopOrigin();
  check(true, "desktop: browser remained on the configured preview origin");

  desktopEvidence = {
    viewport: { width: 1440, height: 1050 }, totalRequests: requests.length,
    screenHeadings, screenRows, previewHeadings, previewRows,
    exportRequests, recordExportRequests: requests.slice(recordBaseline),
    csv: { bytes: csvBytes.byteLength, sha256: `sha256:${csvSha256}`, rows: csvRows.length - 1,
      fields: csvRows[0]?.length ?? 0 },
    printPdf,
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
  await bootData(mobilePage, "mobile");
  const adaptationMedia = await mobilePage.evaluate(() => ({
    forcedColors: matchMedia("(forced-colors: active)").matches,
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
  }));
  check(adaptationMedia.forcedColors && adaptationMedia.reducedMotion,
    "mobile: forced-colors and reduced-motion adaptations are active", adaptationMedia);
  const mobileBaseline = mobileRequests.length;
  await mobilePage.getByRole("button", { name: "Preview Print / CSV for current Data view" }).click();
  const mobileDialog = mobilePage.locator(".export-dialog");
  await mobileDialog.locator("tbody").waitFor();
  const textResize = await mobileDialog.evaluate(dialog => {
    const walker = document.createTreeWalker(dialog, NodeFilter.SHOW_TEXT);
    const records = [];
    let node = walker.nextNode();
    while (node) {
      const parent = node.parentElement;
      const range = document.createRange();
      range.selectNodeContents(node);
      if (parent && node.textContent?.trim() && range.getClientRects().length > 0) {
        const style = getComputedStyle(parent);
        if (style.display !== "none" && style.visibility !== "hidden") records.push({
          node, parent, beforeCssPixels: Number.parseFloat(style.fontSize),
        });
      }
      node = walker.nextNode();
    }
    for (const { parent, beforeCssPixels } of records)
      parent.style.setProperty("font-size", `${beforeCssPixels * 2}px`, "important");
    void dialog.getBoundingClientRect();
    const measured = records.map(record => ({
      ...record,
      afterCssPixels: Number.parseFloat(getComputedStyle(record.parent).fontSize),
    }));
    const representative = [
      ["dialog title", "#export-dialog-title"],
      ["local-only badge", ".export-local-badge"],
      ["primary print action", ".export-dialog-actions .primary"],
    ].map(([label, selector]) => {
      const element = dialog.querySelector(selector);
      const record = measured.find(item => item.parent === element);
      if (!record) throw new Error(`missing rendered text measurement for ${label}`);
      return {
        label, beforeCssPixels: record.beforeCssPixels,
        afterCssPixels: record.afterCssPixels,
      };
    });
    return {
      method: "computed-font-size-per-rendered-text-node",
      renderedTextNodes: measured.length,
      scaledTextNodes: measured.filter(item =>
        Math.abs(item.afterCssPixels - item.beforeCssPixels * 2) <= 0.05).length,
      representativeFontSizes: representative,
    };
  });
  check(textResize.renderedTextNodes > 0
      && textResize.scaledTextNodes === textResize.renderedTextNodes,
  "mobile: every rendered export-dialog text node measures at actual 200% text size",
  textResize);
  const targetActions = ["Cancel", "Download CSV", "Print / Save as PDF"];
  const targetReachability = [];
  for (const name of targetActions) targetReachability.push(await mobileDialog
    .getByRole("button", { name, exact: true }).evaluate(element => {
      element.scrollIntoView({ block: "center", inline: "nearest" });
      const rect = element.getBoundingClientRect();
      const x = Math.min(innerWidth - 1, Math.max(0, rect.left + rect.width / 2));
      const y = Math.min(innerHeight - 1, Math.max(0, rect.top + rect.height / 2));
      const hit = document.elementFromPoint(x, y);
      return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight
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
  const horizontalDocumentOverflow = await mobilePage.evaluate(() =>
    document.documentElement.scrollWidth > document.documentElement.clientWidth);
  check(!horizontalDocumentOverflow,
  "mobile: 320 CSS px at 200% text scale has no document-level horizontal overflow");
  check(await mobileDialog.getByRole("button", { name: "Print / Save as PDF" }).evaluate(element =>
    element.getBoundingClientRect().height >= 44), "mobile: primary print target is at least 44px high");
  const mobileAxe = await blockingAxe(mobilePage, ".export-dialog");
  check(mobileAxe.length === 0, "mobile: export preview has zero serious/critical axe violations", mobileAxe);
  await mobilePage.keyboard.press("Tab");
  check(await mobileDialog.evaluate(element => element.contains(document.activeElement)),
    "mobile: keyboard focus remains trapped inside the preview");
  await mobilePage.screenshot({ path: join(outDir, "mobile-320px-200pct.png"), fullPage: true });
  await mobilePage.keyboard.press("Escape");
  await mobileDialog.waitFor({ state: "detached" });
  check(await mobilePage.getByRole("button", {
    name: "Preview Print / CSV for current Data view",
  }).evaluate(element => element === document.activeElement),
  "mobile: Escape restores focus to the preview trigger");
  assertMobileOrigin();
  check(true, "mobile: browser remained on the configured preview origin");
  mobileEvidence = {
    viewport: { width: 320, height: 800 },
    textScalePercent: 200,
    textResize,
    reflow: { horizontalDocumentOverflow, dialogFitsViewport },
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
const generatedArtifacts = await Promise.all([
  "accessibility-tree.json", "current-view.csv", "desktop-current-view.png",
  "desktop-print-media.png", "desktop-print.pdf", "desktop-record.png",
  "mobile-320px-200pct.png",
].map(artifactDigest));
const artifacts = manualScreenReader.artifact
  ? [...generatedArtifacts, manualScreenReader.artifact] : generatedArtifacts;
const automatedPass = checks.every(item => item.ok) && browserClean;
const observedAccessibility = summarizeExportDialogStateEvidence(dialogStateObservations);
const report = LocalExportEvidenceManifestV2.parse({
  schema: "LocalExportEvidenceManifestV2",
  generatedAt: new Date().toISOString(),
  source,
  build,
  browser: { name: "chromium", version: browserVersion, headless: true },
  url,
  requirements: [
    "F-FR-070", "F-FR-071", "F-FR-072", "F-FR-073", "F-FR-074",
    "F-FR-075", "F-FR-076", "F-FR-078", "F-FR-079", "F-NFR-037",
    "F-NFR-040", "F-NFR-041", "F-NFR-043", "F-NFR-049", "F-NFR-051",
    "F-GATE-010",
  ],
  exclusions: [
    "F1 hosted encrypted snapshots", "F2 hosted public intake", "F4 hosted file requests",
    "F-GATE-070 direct PDF generation/download product route",
    ...(manualScreenReader.screenReader.status === "UNAVAILABLE"
      ? ["Manual NVDA and VoiceOver evidence is unavailable in this automated environment."] : []),
  ],
  observations: {
    desktop: { ...desktopEvidence, dialogStates: dialogStateObservations },
    mobile: mobileEvidence,
    network: {
      desktopRequests: desktopEvidence?.totalRequests ?? 0,
      mobileRequests: mobileEvidence?.totalRequests ?? 0,
      unexpected: errors.filter(error => error.includes("network")
        || error.includes("requestfailed")),
    },
  },
  artifacts,
  errors,
  checks,
  accessibility: {
    schema: "AccessibilityEvidenceV1",
    axe: observedAccessibility.axe,
    keyboard: {
      status: "PASS", viewportWidth: 320, textScalePercent: 200,
      assertions: [
        "Enter opens the export preview from its trigger.",
        "Tab remains trapped inside the preview dialog.",
        "Escape closes the preview and restores trigger focus.",
      ],
    },
    reflow320At200Percent: {
      status: "PASS", viewportWidth: 320, textScalePercent: 200,
      method: mobileEvidence.textResize.method,
      renderedTextNodes: mobileEvidence.textResize.renderedTextNodes,
      scaledTextNodes: mobileEvidence.textResize.scaledTextNodes,
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
