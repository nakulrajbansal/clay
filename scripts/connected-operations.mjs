// Direct-value release gate: connected records, Daily Workbench,
// local automations, rich notes, and local file lifecycle through the real UI.
// Usage: node scripts/connected-operations.mjs [outDir]
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { mkdir } from "node:fs/promises";

const url = process.env.URL || "http://127.0.0.1:4173";
const outDir = process.argv[2] || "evidence";
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1100 },
  reducedMotion: "reduce",
});
const page = await context.newPage();
const errors = [];
const leaked = [];
const privateSentinel = "Private attachment proof 7f3c";
page.on("console", message => {
  if (message.type() === "error") errors.push(message.text());
});
page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
page.on("request", request => {
  const body = request.postData() ?? "";
  if (request.url().includes(privateSentinel)
      || request.url().includes(encodeURIComponent(privateSentinel))
      || body.includes(privateSentinel)) leaked.push(request.url());
});

const check = (condition, label) => {
  if (!condition) throw new Error(`FAIL ${label}`);
  console.log(`PASS ${label}`);
};
const settledAxe = async (selector, label) => {
  await page.waitForTimeout(100);
  const result = await new AxeBuilder({ page }).include(selector).analyze();
  const blocking = result.violations.filter(item =>
    item.impact === "serious" || item.impact === "critical");
  if (blocking.length) console.log(JSON.stringify(blocking.map(item => ({
    id: item.id, nodes: item.nodes.map(node => ({ target: node.target,
      summary: node.failureSummary })),
  })), null, 2));
  check(blocking.length === 0, `${label} has no serious or critical axe violations`);
};
const dataRows = () => page.locator(".dataview-grid tbody > tr")
  .filter({ hasNot: page.locator(".dataview-new, .dataview-hist") });
const columnIndex = async name => {
  const headings = await page.locator(".dataview-grid thead th").allTextContents();
  const index = headings.findIndex(text => text.trim().toLowerCase().startsWith(name.toLowerCase()));
  if (index < 0) throw new Error(`missing ${name} column: ${headings.join(" | ")}`);
  return index;
};
const addColumn = async (name, type) => {
  await page.locator(".dataview-addcol-btn").click();
  await page.getByLabel("new column name").fill(name);
  await page.getByLabel("new column type").selectOption(type);
  await page.locator(".dataview-addcol .link").click();
  await page.waitForFunction(label => [...document.querySelectorAll(".dataview-grid thead th")]
    .some(cell => cell.textContent?.trim().toLowerCase().startsWith(label)), name.toLowerCase());
};

try {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.getByText("Small Business", { exact: true }).click({ timeout: 15_000 });
  await page.locator(".panel-frame").first().waitFor({ timeout: 20_000 });
  check(await page.locator(".panel-boundary").count() === 0,
    "Small Business opens without a panel boundary");

  await page.getByRole("button", { name: "Open data" }).click();
  await page.locator(".dataview").waitFor();
  const dataBackdrop = page.locator(".dataview-backdrop");
  check(await dataBackdrop.evaluate(element => getComputedStyle(element).position) === "fixed",
    "Data uses a viewport-fixed modal backdrop");
  check(await page.locator('[role="dialog"][aria-modal="true"]').count() === 1,
    "only the top trusted surface is exposed as modal");
  const dataImport = page.getByLabel("Import CSV or JSON");
  await dataImport.focus();
  check(await dataImport.evaluate(element => document.activeElement === element
      && element.getClientRects().length > 0),
    "Data import is keyboard-focusable while visually hidden");
  await page.getByRole("button", { name: "customers", exact: true }).click();
  const customerName = (await page.locator(".dataview-grid tbody > tr").first()
    .locator("td").nth(1).textContent())?.trim() ?? "";
  check(customerName.length > 0, "a real customer label is available for linking");

  await page.getByRole("button", { name: "jobs", exact: true }).click();
  const customerColumnBefore = await columnIndex("customer");
  const firstJob = page.locator(".dataview-grid tbody > tr").first();
  const firstJobTitle = (await firstJob.locator("td").nth(await columnIndex("title")).textContent())?.trim() ?? "";
  const customerCell = firstJob.locator("td").nth(customerColumnBefore);
  await customerCell.click();
  await customerCell.locator("input").fill(customerName);
  await customerCell.locator("input").press("Enter");
  await page.waitForFunction(({ column, label }) => {
    const row = document.querySelector(".dataview-grid tbody > tr");
    return row?.querySelectorAll("td")[column]?.textContent?.trim() === label;
  }, { column: customerColumnBefore, label: customerName });
  check((await customerCell.textContent())?.trim() === customerName,
    "the source text edit is durable before conversion");

  await page.getByRole("button", { name: "Connect records" }).click();
  const relationDialog = page.getByRole("dialog", { name: "Turn text into linked records" });
  await relationDialog.getByLabel("Text field").selectOption("customer");
  await relationDialog.getByLabel("Link to table").selectOption("customers");
  await relationDialog.getByLabel("Match using").selectOption("name");
  await relationDialog.getByRole("button", { name: "Preview matches" }).click();
  const matched = Number(await relationDialog.locator(".relation-stat.good strong").textContent());
  check(matched >= 1, "text-to-link preview reports at least one exact match");
  await settledAxe(".relation-dialog", "linked-record preview");
  await relationDialog.getByRole("button", { name: new RegExp(`Connect ${matched} rows`) }).click();
  await relationDialog.waitFor({ state: "detached" });
  await page.waitForFunction(() => [...document.querySelectorAll(".dataview-grid thead th")]
    .some(cell => cell.textContent?.includes("link")));
  check(await page.locator(".dataview-grid thead").getByText("link", { exact: true }).count() === 1,
    "Customer is now a typed linked-record field");

  await addColumn("worklog", "rich_text");
  await addColumn("files", "attachment");
  const linkedJobRow = page.locator(".dataview-grid tbody > tr").filter({ hasText: customerName }).first();
  await linkedJobRow.waitFor();
  const linkedJobTitle = (await linkedJobRow.locator("td").nth(await columnIndex("title")).textContent())?.trim() ?? "";
  await linkedJobRow
    .getByRole("button", { name: /Open .* record details/ }).click();
  const detail = page.locator(".record-detail");
  await detail.waitFor();
  check(await page.locator('[role="dialog"][aria-modal="true"]').count() === 1
      && await dataBackdrop.evaluate(element => element.inert),
    "record detail isolates the underlying Data modal");
  const customerChip = detail.locator(".record-link-chip").filter({ hasText: customerName });
  await customerChip.waitFor();
  check(await customerChip.count() === 1,
    "record detail renders a navigable linked customer chip");

  const richEditor = detail.locator(".rich-note-editor textarea");
  await richEditor.fill(`**Important**\n- ${privateSentinel}`);
  await detail.locator(".rich-note-editor").getByRole("button", { name: "Preview" }).click();
  check(await detail.locator(".rich-note-preview strong").textContent() === "Important",
    "rich note preview renders formatting without raw HTML injection");
  const fileInput = detail.locator('input[type="file"]');
  await fileInput.focus();
  check(await fileInput.evaluate(element => document.activeElement === element
      && element.getClientRects().length > 0),
    "attachment picker is keyboard-focusable while visually hidden");
  await fileInput.setInputFiles({
    name: "proof-receipt.pdf", mimeType: "application/pdf",
    buffer: Buffer.from(`%PDF-1.7\n${privateSentinel}`),
  });
  await detail.getByText("proof-receipt.pdf", { exact: true }).waitFor();
  check((await detail.textContent()).includes("included in .clay backups"),
    "record detail explains local file custody and backup inclusion");
  await settledAxe(".record-detail", "rich connected record detail");
  await page.screenshot({ path: `${outDir}/connected-record-detail.png`, fullPage: true });

  await detail.locator(".record-link-chip").filter({ hasText: customerName }).click();
  await page.waitForFunction(title => document.querySelector(".record-detail h2")?.textContent === title,
    customerName);
  check((await detail.textContent()).includes("Related records")
      && (await detail.textContent()).includes(linkedJobTitle),
    "customer detail shows the incoming related job");
  await page.screenshot({ path: `${outDir}/connected-related-records.png`, fullPage: true });
  await detail.getByRole("button", { name: "Close record details" }).click();
  await detail.getByRole("button", { name: "Close record details" }).click();

  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Search and act" });
  await palette.waitFor();
  await palette.getByRole("combobox", { name: "Search all records" }).fill(customerName);
  await page.waitForFunction(label => [...document.querySelectorAll(".command-results > button")]
    .filter(button => button.textContent?.includes(label)).length >= 2, customerName);
  const searchResults = palette.locator(".command-results > button").filter({ hasText: customerName });
  check(await searchResults.count() >= 2,
    "global search finds both the customer and a job through its linked label");
  const activeSearchResult = palette.locator('.command-results > button[tabindex="0"]').first();
  await activeSearchResult.waitFor();
  check((await activeSearchResult.textContent())?.includes(customerName),
    "the first matching record is the active keyboard command");
  await settledAxe(".command-palette", "global search palette");
  await page.screenshot({ path: `${outDir}/global-search.png`, fullPage: true });
  await page.keyboard.press("Escape");
  await palette.waitFor({ state: "detached" });

  const titleColumn = await columnIndex("title");
  const statusColumn = await columnIndex("status");
  const beforeStatuses = await page.locator(".dataview-grid tbody > tr").evaluateAll((rows, indexes) =>
    rows.slice(0, 2).map(row => row.querySelectorAll("td")[indexes.status]?.textContent?.trim() ?? ""),
    { status: statusColumn });
  const beforeTitles = await page.locator(
    ".dataview-grid tbody > tr:not(.dataview-new):not(.dataview-hist)",
  ).evaluateAll((rows, index) => rows.slice(0, 2)
    .map(row => row.querySelectorAll("td")[index]?.textContent?.trim() ?? ""), titleColumn);
  const selectionBoxes = page.locator('.dataview-grid tbody > tr:not(.dataview-new):not(.dataview-hist) input[type="checkbox"]');
  check((await selectionBoxes.first().getAttribute("aria-label"))?.includes(firstJobTitle),
    "row selection announces a human record label");
  await selectionBoxes.nth(0).check();
  await selectionBoxes.nth(1).check();
  const bulk = page.getByRole("region", { name: "Bulk actions" });
  await bulk.getByLabel("Field to update").selectOption("status");
  await bulk.locator("select").nth(1).selectOption("done");
  await bulk.getByRole("button", { name: "Apply to 2" }).click();
  await page.getByRole("button", { name: "Undo 2" }).waitFor();
  const afterStatuses = await page.locator(".dataview-grid tbody > tr").evaluateAll((rows, indexes) =>
    rows.slice(0, 2).map(row => row.querySelectorAll("td")[indexes.status]?.textContent?.trim() ?? ""),
    { status: statusColumn });
  check(afterStatuses.every(status => status === "done"),
    "bulk update changes both selected records in one action");

  await page.getByLabel("Filter records").selectOption({ label: "status: done" });
  await page.getByRole("button", { name: "Save view", exact: false }).click();
  await page.getByPlaceholder("View name").fill("Done jobs");
  await page.locator(".save-work-view").getByRole("button", { name: "Save" }).click();
  const savedView = page.getByRole("button", { name: "Done jobs", exact: true });
  await savedView.waitFor();
  check(await savedView.count() === 1,
    "an operational filter is saved as a durable named view");
  await settledAxe(".dataview", "Daily Workbench");
  await page.screenshot({ path: `${outDir}/daily-workbench.png`, fullPage: true });
  const dataBody = page.locator(".dataview-body");
  await dataBody.evaluate(element => { element.scrollLeft = element.scrollWidth; });
  const addColumnButton = page.locator(".dataview-addcol-btn");
  await addColumnButton.waitFor();
  check(await addColumnButton.evaluate(button => {
    const body = button.closest(".dataview-body");
    if (!body) return false;
    const control = button.getBoundingClientRect();
    const viewport = body.getBoundingClientRect();
    return control.left >= viewport.left - 1 && control.right <= viewport.right + 1;
  }), "wide workbench controls remain reachable by horizontal scroll");
  await page.screenshot({ path: `${outDir}/daily-workbench-columns.png`, fullPage: true });
  await dataBody.evaluate(element => { element.scrollLeft = 0; });

  await page.getByRole("button", { name: "Undo 2" }).click();
  await page.getByRole("button", { name: "Undo 2" }).waitFor({ state: "detached" });
  await page.getByRole("button", { name: "All", exact: true }).click();
  const restoredStatuses = await page.locator(".dataview-grid tbody > tr").evaluateAll((rows, indexes) =>
    rows.slice(0, 2).map(row => row.querySelectorAll("td")[indexes.status]?.textContent?.trim() ?? ""),
    { status: statusColumn });
  check(JSON.stringify(restoredStatuses) === JSON.stringify(beforeStatuses),
    "batch undo restores both exact prior status values");
  const restoredTitles = await page.locator(
    ".dataview-grid tbody > tr:not(.dataview-new):not(.dataview-hist)",
  ).evaluateAll((rows, index) => rows.slice(0, 2)
    .map(row => row.querySelectorAll("td")[index]?.textContent?.trim() ?? ""), titleColumn);
  check(JSON.stringify(restoredTitles) === JSON.stringify(beforeTitles),
    "undo leaves unrelated record values unchanged");
  await page.locator(".dataview-close").click();

  await page.getByRole("button", { name: "Open automations" }).click();
  const automation = page.getByRole("dialog", { name: "Automations" });
  await automation.getByRole("button", { name: /New rule/ }).click();
  await automation.getByLabel("Rule name").fill("Review every job");
  await automation.getByLabel("When").selectOption("manual");
  await automation.getByLabel("In table").selectOption("jobs");
  await automation.getByRole("button", { name: "Save and simulate" }).click();
  await automation.getByText("Simulation", { exact: true }).waitFor();
  const matchedText = await automation.locator(".automation-simulation strong").textContent();
  check(Number(matchedText?.split(" ")[0]) >= 5,
    "automation simulation shows the bounded real-record impact before enable");
  await settledAxe(".automation-center", "automation simulation");
  const enableRule = automation.getByRole("button", { name: "Enable rule" });
  await enableRule.scrollIntoViewIfNeeded();
  check(await enableRule.isVisible(), "simulation keeps the explicit enable action reachable");
  await page.screenshot({ path: `${outDir}/automation-simulation.png`, fullPage: true });
  await enableRule.click();
  const rule = automation.locator(".automation-rule").filter({ hasText: "Review every job" });
  await rule.getByRole("button", { name: "Run now" }).click();
  await automation.locator(".automation-history article").first().waitFor();
  await automation.getByRole("button", { name: /Inbox/ }).click();
  await page.waitForFunction(() => document.querySelectorAll(".automation-inbox article").length >= 5);
  check(await automation.locator(".automation-inbox article").count() >= 5,
    "manual automation creates one local reminder per matching job");
  await settledAxe(".automation-center", "automation inbox");
  await page.screenshot({ path: `${outDir}/automation-inbox.png`, fullPage: true });
  await automation.getByRole("button", { name: /Run history/ }).click();
  const run = automation.locator(".automation-history article").first();
  check((await run.textContent()).includes("changed"), "run history exposes matched and changed counts");
  await run.getByRole("button", { name: "Undo run" }).click();
  await run.getByText("Undone", { exact: true }).waitFor();
  await automation.getByRole("button", { name: /Inbox/ }).click();
  check(await automation.getByText("You’re caught up", { exact: true }).count() === 1,
    "undo dismisses notifications produced by that run");

  await automation.getByRole("button", { name: "Close automations" }).click();
  const filesStatus = page.getByText(/Files: 1/);
  if (!await filesStatus.isVisible().catch(() => false))
    await page.getByRole("button", { name: /settings/i }).click();
  await filesStatus.waitFor();
  check((await page.locator(".rail-settings").textContent()).includes("Files: 1"),
    "Settings exposes active local file count and storage size");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open automations" }).click();
  await automation.waitFor();
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    "new trusted surfaces cause no phone-width horizontal page overflow");
  await page.screenshot({ path: `${outDir}/operations-mobile.png`, fullPage: true });

  check(leaked.length === 0, "rich note and attachment content never enters a network request");
  check(errors.length === 0, `zero page errors${errors.length ? `: ${errors.join(" | ")}` : ""}`);
  console.log("CONNECTED OPERATIONS GATE GREEN");
} finally {
  await browser.close();
}
