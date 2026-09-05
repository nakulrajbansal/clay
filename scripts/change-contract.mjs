// Change Contract gate with a deterministic intercepted model response.
// It exercises the real prompt client, validator, shadow store, preview UI,
// discard + keep paths, trust receipt, provenance, situational lenses,
// accessibility, and visual output without spending a model call.
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { mkdir } from "node:fs/promises";
import { productGateUrl } from "./product-gate-url.mjs";

const url = productGateUrl();
const outDir = process.argv[2] || "evidence";
await mkdir(outDir, { recursive: true });

const apiPlan = JSON.stringify({
  api: 1,
  summary: "Add a calm, verified lens on the current pipeline.",
  user_facing_diff: [
    { kind: "add_panel", detail: "Add Pipeline pulse as a compact live view" },
  ],
  clarifying_question: null,
  assumptions: [],
  migration: null,
  panels: [{
    panel_id: "pipeline_pulse",
    title: "Pipeline pulse",
    placement: { region: "side", order: 8 },
    code: "export default function(clay){clay.db.watch({from:\"deals\"},rows=>{clay.ui.render(h(MetricCard,{label:\"Deals inspected\",value:rows.length}));});}",
    declared_queries: [JSON.stringify({ from: "deals" })],
    declared_writes: [],
  }],
  remove_panels: [],
  confidence: 0.96,
});
const anthropicResponse = JSON.stringify({
  content: [{ type: "text", text: apiPlan }],
  usage: { input_tokens: 100, output_tokens: 100 },
  stop_reason: "end_turn",
});

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1050 },
  permissions: ["clipboard-read", "clipboard-write"],
});
await context.addInitScript(() => {
  try { localStorage.setItem("clay_api_key", "sk-test-intercepted"); }
  catch { /* sandboxed panel frames cannot access localStorage */ }
});
let modelRequests = 0;
await context.route("https://api.anthropic.com/**", async route => {
  if (route.request().method() === "OPTIONS") {
    await route.fulfill({
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "*",
      },
    });
    return;
  }
  modelRequests++;
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: anthropicResponse,
  });
});

const page = await context.newPage();
const errors = [];
page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
const check = (condition, label) => {
  if (!condition) throw new Error(`FAIL ${label}`);
  console.log(`PASS ${label}`);
};

await page.goto(url, { waitUntil: "domcontentloaded" });
await page.getByText("Sales CRM", { exact: true }).click({ timeout: 15_000 });
await page.locator(".panel-frame").first().waitFor({ timeout: 20_000 });
await page.getByRole("button", { name: "Customize", exact: true }).click();
await page.locator(".appbar-mode-button.active", { hasText: "Customize" }).waitFor();
await page.getByPlaceholder("Describe a change", { exact: false })
  .fill("Add a calm pipeline pulse view");
await page.getByRole("button", { name: "Reshape", exact: true }).click();

const contract = page.getByRole("region", { name: "Change contract" });
await contract.waitFor({ timeout: 30_000 });
check(modelRequests === 1, "the intercepted model path ran exactly once");
check(await contract.locator(".contract-guarantee").filter({ hasText: "Shadow-checked" }).count() === 1,
  "the preview exposes shadow validation");
check(await contract.locator(".contract-guarantee").filter({ hasText: "Reversible" }).count() === 1,
  "the preview exposes reversibility");
check(await contract.locator(".contract-guarantee").filter({ hasText: "Rows retained" }).count() === 1,
  "the preview exposes row preservation");
check(await contract.locator(".contract-guarantee").filter({ hasText: "Preview read-only" }).count() === 1,
  "the preview makes staged data-entry semantics explicit");
check(await contract.locator(".contract-chip").filter({ hasText: "deals" }).count() === 1,
  "the contract exposes real panel data access");
check(await contract.locator(".contract-view").filter({ hasText: "Pipeline pulse" }).count() === 1,
  "the contract names the affected view");

await page.waitForTimeout(350);
const axe = await new AxeBuilder({ page }).include(".change-contract").analyze();
const blocking = axe.violations.filter(violation =>
  violation.impact === "serious" || violation.impact === "critical");
if (blocking.length) console.log(JSON.stringify(blocking, null, 2));
check(blocking.length === 0, "the change contract has no serious or critical axe violations");
await page.screenshot({ path: `${outDir}/nextgen-change-contract.png`, fullPage: true });

await contract.getByRole("button", { name: "Discard" }).click();
await contract.waitFor({ state: "detached" });
check(await page.getByText(/Discarded: Add a calm, verified lens/i).count() === 1,
  "discard leaves the live app untouched and records the decision");

await page.getByPlaceholder("Describe a change", { exact: false })
  .fill("Add the verified pipeline pulse view");
await page.getByRole("button", { name: "Reshape", exact: true }).click();
await contract.waitFor({ timeout: 30_000 });
await contract.getByRole("button", { name: "Keep change" }).click();
await contract.waitFor({ state: "detached" });
check(modelRequests === 2, "discard and keep each use one deterministic model round");

const keptRewind = page.locator(".toast-success").filter({ hasText: /Kept/ }).last();
await keptRewind.waitFor();
await page.getByRole("button", { name: /Make (wide|narrow):/ }).first().click();
await page.getByText(/Rearranged/).waitFor();
const rewindAction = keptRewind.getByRole("button", { name: "Rewind" });
await rewindAction.click();
const rewindConfirm = page.getByRole("alertdialog", { name: "Confirm action" });
await rewindConfirm.waitFor();
check((await rewindConfirm.textContent())?.includes("2 newer changes") === true,
  "a stale rewind action names every currently newer version before truncation");
check(await page.locator(".app").getAttribute("inert") !== null,
  "destructive confirmation makes the application inert");
const confirmAxe = await new AxeBuilder({ page }).include(".confirm-card").analyze();
const confirmBlocking = confirmAxe.violations.filter(item =>
  item.impact === "serious" || item.impact === "critical");
if (confirmBlocking.length) console.log(JSON.stringify(confirmBlocking, null, 2));
check(confirmBlocking.length === 0,
  "destructive confirmation is labelled without serious accessibility violations");
await page.keyboard.press("Shift+Tab");
check(await rewindConfirm.evaluate(element => element.contains(document.activeElement)),
  "destructive confirmation traps keyboard focus");
await page.keyboard.press("Escape");
await rewindConfirm.waitFor({ state: "detached" });
check(await page.locator(".app").getAttribute("inert") === null,
  "Escape cancels confirmation and restores application interaction");

const receipt = page.locator(".trust-receipt").last();
await receipt.waitFor({ timeout: 20_000 });
await receipt.locator("summary").click();
check(await receipt.getByText("Rows retained", { exact: false }).count() === 1,
  "the kept change leaves a trust receipt with data durability proof");
const receiptRewind = receipt.getByRole("button", { name: /Rewind to v/ });
check(await receiptRewind.count() === 1,
  "the trust receipt links to an exact rewind target");
await receiptRewind.click();
const receiptConfirm = page.getByRole("alertdialog", { name: "Confirm action" });
await receiptConfirm.waitFor();
await page.keyboard.press("Escape");
await receiptConfirm.waitFor({ state: "detached" });
check(await receiptRewind.evaluate(element => element === document.activeElement),
  "persistent confirmation invokers regain focus after Escape");

await page.getByPlaceholder("Describe a change", { exact: false })
  .fill("Refresh the pipeline pulse presentation");
await page.getByRole("button", { name: "Reshape", exact: true }).click();
await contract.waitFor({ timeout: 30_000 });
check(await receipt.getByRole("button", { name: /Rewind to v/ }).isDisabled(),
  "receipt rewind is disabled while another preview is open");
await contract.getByRole("button", { name: "Discard" }).click();
await contract.waitFor({ state: "detached" });

const whyButton = page.getByRole("button", { name: "Why Pipeline pulse exists" });
await whyButton.waitFor({ timeout: 20_000 });
await whyButton.click();
const provenance = page.getByLabel("Pipeline pulse provenance");
await provenance.waitFor();
check(await provenance.getByText("Why this view exists").count() === 1,
  "a live panel explains its provenance");
check(await provenance.getByText(/Created at v/).count() === 1,
  "panel provenance names its creating version");

const allPanelCount = await page.locator(".panel-frame").count();
const lensButton = page.getByRole("button", { name: /Choose situational lens/ });
await lensButton.click();
await page.keyboard.press("Escape");
check(await page.getByRole("dialog", { name: "Situational lenses" }).count() === 0,
  "Escape closes the lens menu");
check(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")
  ?.startsWith("Choose situational lens") === true),
  "closing the lens menu returns focus to its trigger");
await lensButton.click();
await page.getByRole("button", { name: /Morning review/ }).click();
check(await lensButton.evaluate(element => element === document.activeElement),
  "selecting a lens returns focus to the trigger");
await page.waitForTimeout(150);
const reviewPanelCount = await page.locator(".panel-frame").count();
check(reviewPanelCount > 0 && reviewPanelCount < allPanelCount,
  "Morning review narrows visible views without copying records");
check(await page.locator('.panel-frame[draggable="true"]').count() === 0,
  "filtered lenses keep full-layout arrangement controls inactive");
check(await page.getByRole("button", { name: /Current: Morning review/ }).count() === 1,
  "the active situational lens remains visible in trusted chrome");
await lensButton.click();
await page.getByRole("button", { name: /Save current view/ }).click();
await page.getByRole("textbox", { name: "Saved lens name" }).fill("Review ritual");
await page.getByRole("button", { name: "Save", exact: true }).click();
const savedLensTrigger = page.getByRole("button", { name: /Current: Review ritual/ });
await savedLensTrigger.waitFor({ timeout: 10_000 });
check(await savedLensTrigger.count() === 1,
  "the current situational view can be saved as a named lens");
check(await savedLensTrigger.evaluate(element => element === document.activeElement),
  "saving a lens closes the dialog and returns focus to its trigger");
check(await page.locator(".panel-frame").count() === reviewPanelCount,
  "saving a lens does not copy or change records");

const moatAxe = await new AxeBuilder({ page }).exclude("iframe").analyze();
const moatBlocking = moatAxe.violations.filter(violation =>
  violation.impact === "serious" || violation.impact === "critical");
if (moatBlocking.length) console.log(JSON.stringify(moatBlocking, null, 2));
check(moatBlocking.length === 0,
  "trust receipt, provenance, and lenses have no serious or critical axe violations");
await page.screenshot({ path: `${outDir}/nextgen-trust-provenance.png`, fullPage: true });

await page.reload({ waitUntil: "domcontentloaded" });
await page.locator(".panel-frame").first().waitFor({ timeout: 20_000 });
const persistedLensTrigger = page.getByRole("button", { name: /Current: Review ritual/ });
await persistedLensTrigger.waitFor({ timeout: 10_000 });
check(await persistedLensTrigger.count() === 1,
  "a saved lens persists per app across reload");
await page.waitForFunction(expected =>
  document.querySelectorAll(".panel-frame").length === expected, reviewPanelCount);
check(await page.locator(".panel-frame").count() === reviewPanelCount,
  "reloading preserves the saved lens panel set without changing data");
await page.getByRole("button", { name: /Choose situational lens/ }).click();
await page.getByRole("button", { name: "Delete lens Review ritual" }).click();
let deleteLensConfirm = page.getByRole("group", { name: "Confirm delete lens Review ritual" });
check(await deleteLensConfirm.getByRole("button", { name: "Delete", exact: true })
  .evaluate(element => element === document.activeElement),
  "lens deletion moves focus into its inline confirmation");
await deleteLensConfirm.getByRole("button", { name: "Cancel" }).click();
check(await page.getByRole("button", { name: /Review ritual/ }).first()
  .evaluate(element => element === document.activeElement),
  "cancelling lens deletion restores a stable lens control");
await page.getByRole("button", { name: "Delete lens Review ritual" }).click();
deleteLensConfirm = page.getByRole("group", { name: "Confirm delete lens Review ritual" });
await deleteLensConfirm.getByRole("button", { name: "Delete", exact: true }).click();
await page.waitForTimeout(100);
check(await page.locator(".panel-frame").count() === allPanelCount,
  "deleting the active saved lens returns to Workspace");

for (let index = 1; index <= 24; index++) {
  const trigger = page.getByRole("button", { name: /Choose situational lens/ });
  await trigger.click();
  await page.getByRole("button", { name: /Save current view/ }).click();
  await page.getByRole("textbox", { name: "Saved lens name" }).fill(`Bounded ${index}`);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(`Current: Bounded ${index}$`) })
    .waitFor({ timeout: 10_000 });
}
await page.setViewportSize({ width: 390, height: 844 });
const boundedLensTrigger = page.getByRole("button", { name: /Choose situational lens/ });
await boundedLensTrigger.click();
const boundedLensDialog = page.getByRole("dialog", { name: "Situational lenses" });
const boundedLensGeometry = await boundedLensDialog.evaluate(element => ({
  bottom: element.getBoundingClientRect().bottom,
  client: element.clientHeight,
  scroll: element.scrollHeight,
  overflow: getComputedStyle(element).overflowY,
}));
check(boundedLensGeometry.bottom <= 844 && boundedLensGeometry.overflow === "auto"
    && boundedLensGeometry.scroll > boundedLensGeometry.client,
  "the maximum 24-lens library stays reachable in a phone-sized scrolling dialog");
await page.keyboard.press("Shift+Tab");
check(await boundedLensDialog.evaluate(element => element.contains(document.activeElement)),
  "the maximum lens dialog traps keyboard focus");
await page.keyboard.press("Escape");
check(await boundedLensTrigger.evaluate(element => element === document.activeElement),
  "closing the maximum lens dialog restores focus");

await page.getByRole("button", { name: /settings/i }).click();
const settingsPanel = page.locator(".rail-settings");
await settingsPanel.waitFor();
const settingsScroll = await settingsPanel.evaluate(element => ({
  bottom: element.getBoundingClientRect().bottom,
  client: element.clientHeight,
  scroll: element.scrollHeight,
  overflow: getComputedStyle(element).overflowY,
}));
check(settingsScroll.bottom <= 844 && settingsScroll.overflow === "auto",
  "mobile Settings stays within the viewport and scrolls internally");
check(settingsScroll.scroll >= settingsScroll.client,
  "every mobile Settings control remains reachable");
const privateMetricsTrigger = settingsPanel.getByRole("button", { name: "Private activity & trust" });
await privateMetricsTrigger.click();
const metricsDialog = page.getByRole("dialog", { name: "Private activity & trust" });
await metricsDialog.waitFor();
check(await page.locator(".app").getAttribute("inert") !== null,
  "private metrics makes the background inert");
const metricsGeometry = await metricsDialog.evaluate(element => ({
  bottom: element.getBoundingClientRect().bottom,
  width: element.getBoundingClientRect().width,
  scroll: element.scrollHeight,
  client: element.clientHeight,
  overflow: getComputedStyle(element).overflowY,
}));
check(metricsGeometry.bottom <= 844 && metricsGeometry.width <= 390
    && metricsGeometry.overflow === "auto",
  "private metrics fits and scrolls inside the phone viewport");
check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  "private metrics causes no phone horizontal overflow");
await page.keyboard.press("Shift+Tab");
check(await metricsDialog.evaluate(element => element.contains(document.activeElement)),
  "private metrics traps reverse-tab focus inside the modal");
check(await metricsDialog.getByText(/Daily counts only/).count() === 1,
  "private metrics state its content-free local boundary");
check(await metricsDialog.getByText(/reshapes started/).count() === 1,
  "private metrics summarize activation and trust activity");
for (const heading of ["Activation", "Reshape decisions", "Trust actions", "Recovery"])
  check(await metricsDialog.getByRole("heading", { name: heading }).count() === 1,
    `private metrics exposes the ${heading.toLowerCase()} section`);
const metricsAxe = await new AxeBuilder({ page }).include(".private-metrics").analyze();
const metricsBlocking = metricsAxe.violations.filter(violation =>
  violation.impact === "serious" || violation.impact === "critical");
if (metricsBlocking.length) console.log(JSON.stringify(metricsBlocking, null, 2));
check(metricsBlocking.length === 0,
  "private metrics has no serious or critical axe violations");
const metricRequests = [];
const captureMetricRequest = request => metricRequests.push(request.url());
page.on("request", captureMetricRequest);
await metricsDialog.getByRole("button", { name: "Copy content-free summary" }).click();
await metricsDialog.getByText("Content-free summary copied.").waitFor();
const copiedSummary = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
check(copiedSummary.scope === "current_app" && copiedSummary.windowDays === 30,
  "copied private summary has the fixed content-free schema");
check(copiedSummary.recovery.completed >= 1,
  "real rewind recovery actions feed the private summary");
await page.screenshot({ path: `${outDir}/nextgen-private-metrics-mobile.png`, fullPage: true });
const clearMetricsButton = metricsDialog.getByRole("button", { name: "Clear private metrics…" });
await clearMetricsButton.click();
const clearConfirmation = metricsDialog.getByRole("group", { name: "Confirm clear private metrics" });
check(await clearConfirmation.getByRole("button", { name: "Clear counts" })
  .evaluate(element => element === document.activeElement),
  "private metrics focuses the inline clear confirmation");
await clearConfirmation.getByRole("button", { name: "Cancel" }).click();
check(await clearMetricsButton.evaluate(element => element === document.activeElement),
  "cancelling clear returns focus to its trigger");
await clearMetricsButton.click();
await metricsDialog.getByRole("button", { name: "Clear counts" }).click();
await metricsDialog.getByText("Private activity metrics cleared.").waitFor();
check(await clearMetricsButton.evaluate(element => element === document.activeElement),
  "clearing metrics returns focus to its trigger");
const attemptsCard = metricsDialog.locator("article").filter({ hasText: /^Attempts/ });
check((await attemptsCard.locator("b").textContent())?.trim() === "0",
  "clear private metrics verifies the empty summary by read-back");
page.off("request", captureMetricRequest);
check(metricRequests.length === 0,
  "copying and clearing private metrics creates no network request");
await page.keyboard.press("Escape");
await metricsDialog.waitFor({ state: "detached" });
check(await privateMetricsTrigger.evaluate(element => element === document.activeElement),
  "private metrics returns focus to its trigger");
check(errors.length === 0, `zero page errors${errors.length ? `: ${errors.join(" | ")}` : ""}`);
await browser.close();
console.log("CHANGE CONTRACT + MOAT SLICE GATE GREEN");
