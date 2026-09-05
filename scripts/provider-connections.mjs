import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { mkdir } from "node:fs/promises";
import { productGateUrl } from "./product-gate-url.mjs";

const url = productGateUrl();
const outDir = process.argv[2] || "evidence";
await mkdir(outDir, { recursive: true });
const apiPlan = JSON.stringify({
  api: 1, summary: "Add a provider-neutral pulse view.",
  user_facing_diff: [{ kind: "add_panel", detail: "Add provider pulse" }],
  clarifying_question: null, assumptions: [], migration: null,
  panels: [{ panel_id: "provider_pulse", title: "Provider pulse",
    placement: { region: "side", order: 9 },
    code: "export default function(clay){clay.ui.render(h(MetricCard,{label:\"Provider\",value:\"ready\"}));}",
    declared_queries: [], declared_writes: [] }],
  remove_panels: [], confidence: 0.97,
});
let planRequests = 0;
let codexAuthorization = null;
const connectorToken = "local-codex-connector-token-1234567890";
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await context.addInitScript(() => {
  try { localStorage.setItem("clay_session", "clay-session-must-not-cross-provider"); }
  catch { /* opaque-origin panel frames intentionally cannot use localStorage */ }
});
await context.route("http://127.0.0.1:8788/healthz", route => route.fulfill({
  status: 200, contentType: "application/json",
  headers: { "access-control-allow-origin": "*" },
  body: JSON.stringify({ ok: true, model: true, provider: "codex",
    model_id: "Codex subscription default (exec)", connector_token: connectorToken }),
}));
await context.route("http://127.0.0.1:8788/mutations/plan", async route => {
  if (route.request().method() === "OPTIONS") {
    await route.fulfill({ status: 204, headers: {
      "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type, authorization",
    } });
    return;
  }
  planRequests++;
  codexAuthorization = route.request().headers().authorization ?? null;
  await route.fulfill({ status: 200, contentType: "text/plain",
    headers: { "access-control-allow-origin": "*" }, body: apiPlan });
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const check = (condition, label) => {
  if (!condition) throw new Error(`FAIL ${label}`);
  console.log(`PASS ${label}`);
};

await page.goto(url, { waitUntil: "domcontentloaded" });
await page.getByText("Sales CRM", { exact: true }).click({ timeout: 15_000 });
await page.locator(".panel-frame").first().waitFor({ timeout: 20_000 });
await page.getByRole("button", { name: "Customize", exact: true }).click();
await page.locator(".appbar-mode-button.active", { hasText: "Customize" }).waitFor();
const settings = page.locator(".rail-settings");
await settings.waitFor();
check(await settings.locator(".model-provider-option").count() === 4,
  "Settings exposes four explicit model connections");

await settings.getByRole("button", { name: /Local Codex/ }).click();
await page.waitForTimeout(100);
check(await settings.getByText(/Codex subscription default/).count() === 1,
  "Local Codex reports provider and model status");
check(await page.evaluate(() => localStorage.getItem("clay_model_provider")) === "codex",
  "provider choice persists device-wide");
check(await settings.locator('input[type="password"]').count() === 0,
  "Codex never asks for a browser credential");

await page.getByRole("button", { name: /settings/i }).click();
await page.getByPlaceholder("Describe a change", { exact: false }).fill("Add a provider pulse");
await page.getByRole("button", { name: "Reshape", exact: true }).click();
const contract = page.getByRole("region", { name: "Change contract" });
await contract.waitFor({ timeout: 30_000 });
check(planRequests === 1, "Local Codex uses the normal hosted mutation protocol");
check(codexAuthorization === `Bearer ${connectorToken}`,
  "Local Codex receives only its per-launch connector bearer");
check(!codexAuthorization?.includes("clay-session-must-not-cross-provider"),
  "Local Codex never receives a Clay session bearer");
check(await contract.getByText(/provider-neutral pulse/i).count() === 1,
  "Local Codex output reaches the normal Change Contract preview");
await contract.getByRole("button", { name: "Discard" }).click();
await contract.waitFor({ state: "detached" });
await page.getByRole("button", { name: /settings/i }).click();
await settings.waitFor();

await settings.getByRole("button", { name: /^Anthropic/ }).click();
check(await settings.locator('input[type="password"]').count() === 1,
  "Anthropic exposes its BYO key field only when selected");
await settings.getByRole("button", { name: /^OpenAI/ }).click();
check(await settings.getByText(/OpenAI backend URL/).count() === 1,
  "OpenAI is configured through a server-held credential");
check(await settings.locator('input[type="password"]').count() === 0,
  "OpenAI API keys are never requested in the browser");

const axe = await new AxeBuilder({ page }).include(".rail-settings").analyze();
const blocking = axe.violations.filter(v => v.impact === "serious" || v.impact === "critical");
if (blocking.length) console.log(JSON.stringify(blocking, null, 2));
check(blocking.length === 0, "model connection Settings has no serious or critical axe violations");
await page.screenshot({ path: `${outDir}/nextgen-model-connections.png`, fullPage: true });
if (errors.length) console.log("provider gate page errors", errors);
check(errors.length === 0, "zero page errors");
await browser.close();
console.log("MODEL CONNECTION GATE GREEN");
