// Change Contract gate with a deterministic intercepted model response.
// It exercises the real prompt client, validator, shadow store, preview UI,
// discard + keep paths, trust receipt, provenance, situational lenses,
// accessibility, and visual output without spending a model call.
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { mkdir } from "node:fs/promises";

const url = process.env.URL || "http://127.0.0.1:4173";
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
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
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
await keptRewind.getByRole("button", { name: "Rewind" }).click();
const rewindConfirm = page.getByRole("alertdialog");
await rewindConfirm.waitFor();
check((await rewindConfirm.textContent())?.includes("2 newer changes") === true,
  "a stale rewind action names every currently newer version before truncation");
await rewindConfirm.getByRole("button", { name: "Cancel" }).click();

const receipt = page.locator(".trust-receipt").last();
await receipt.waitFor({ timeout: 20_000 });
await receipt.locator("summary").click();
check(await receipt.getByText("Rows retained", { exact: false }).count() === 1,
  "the kept change leaves a trust receipt with data durability proof");
check(await receipt.getByRole("button", { name: /Rewind to v/ }).count() === 1,
  "the trust receipt links to an exact rewind target");

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
check(await page.getByRole("menu", { name: "Situational lenses" }).count() === 0,
  "Escape closes the lens menu");
check(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")
  ?.startsWith("Choose situational lens") === true),
  "closing the lens menu returns focus to its trigger");
await lensButton.click();
await page.getByRole("menuitemradio", { name: /Morning review/ }).click();
await page.waitForTimeout(150);
const reviewPanelCount = await page.locator(".panel-frame").count();
check(reviewPanelCount > 0 && reviewPanelCount < allPanelCount,
  "Morning review narrows visible views without copying records");
check(await page.locator('.panel-frame[draggable="true"]').count() === 0,
  "filtered lenses keep full-layout arrangement controls inactive");
check(await page.getByRole("button", { name: /Current: Morning review/ }).count() === 1,
  "the active situational lens remains visible in trusted chrome");
await lensButton.click();
await page.getByRole("menuitemradio", { name: /All views/ }).click();
check(await page.locator(".panel-frame").count() === allPanelCount,
  "All views restores the complete panel set in one action");

const moatAxe = await new AxeBuilder({ page }).exclude("iframe").analyze();
const moatBlocking = moatAxe.violations.filter(violation =>
  violation.impact === "serious" || violation.impact === "critical");
if (moatBlocking.length) console.log(JSON.stringify(moatBlocking, null, 2));
check(moatBlocking.length === 0,
  "trust receipt, provenance, and lenses have no serious or critical axe violations");
await page.screenshot({ path: `${outDir}/nextgen-trust-provenance.png`, fullPage: true });

await lensButton.click();
await page.getByRole("menuitemradio", { name: /^Focus/ }).click();
const focusPanelCount = await page.locator(".panel-frame").count();
await page.reload({ waitUntil: "domcontentloaded" });
await page.locator(".panel-frame").first().waitFor({ timeout: 20_000 });
check(await page.getByRole("button", { name: /Current: Focus/ }).count() === 1,
  "the selected lens persists per app across reload");
check(await page.locator(".panel-frame").count() === focusPanelCount,
  "reloading preserves the lens panel set without changing data");
await page.getByRole("button", { name: /Choose situational lens/ }).click();
await page.getByRole("menuitemradio", { name: /All views/ }).click();

await page.setViewportSize({ width: 390, height: 844 });
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
check(errors.length === 0, `zero page errors${errors.length ? `: ${errors.join(" | ")}` : ""}`);
await browser.close();
console.log("CHANGE CONTRACT + MOAT SLICE GATE GREEN");
