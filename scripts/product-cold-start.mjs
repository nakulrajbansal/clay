// Owned Chromium finder, not release certification. Stage timings separate
// download/boot, explicit onboarding, seeding and reload; no timeout inflation.
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { assertTestOrigin, markOwnedContext, assertOwnedPage } from "./p0-browser-safety.mjs";
import { chooseProductStarter, waitForProductPanels, waitForPanelText, productChromiumOptions } from "./product-onboarding.mjs";
const url = assertTestOrigin("http://127.0.0.1:4181");
const output = new URL("../test-results/fix-batch/cold-start.json", import.meta.url);
const report = { kind: "owned_cold_start_diagnostic_not_certification", status: "RUNNING", timings: {}, errors: [], assets: [] };
let browser;
let started = performance.now();
const stage = name => { report.timings[name] = Math.round(performance.now() - started); started = performance.now(); };
try {
  browser = await chromium.launch(productChromiumOptions());
  report.browser = browser.version();
  stage("browserLaunchMs");
  const context = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
  await markOwnedContext(context);
  const page = await context.newPage();
  page.on("pageerror", error => report.errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") report.errors.push(message.text()); });
  page.on("response", response => {
    const path = new URL(response.url()).pathname;
    if (/\/(db-worker|sqlite3)-/.test(path)) report.assets.push({ path, status: response.status() });
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await assertOwnedPage(page);
  stage("documentMs");
  await page.getByRole("heading", { name: "Welcome to Clay", exact: true }).waitFor({ timeout: 15_000 });
  stage("authorityBootToOnboardingMs");
  await chooseProductStarter(page);
  await waitForProductPanels(page, 3);
  const form = page.locator(".panel-frame").filter({ hasText: "Add item" }).frameLocator("iframe");
  await form.getByLabel("Name", { exact: true }).waitFor();
  stage("starterToInteractivePanelsMs");
  await form.getByLabel("Name", { exact: true }).fill("Cold start owned fixture");
  await form.getByRole("button", { name: "Add item", exact: true }).click();
  await waitForPanelText(page, "Cold start owned fixture");
  stage("writeToPanelMs");
  await page.reload({ waitUntil: "domcontentloaded" });
  await assertOwnedPage(page);
  await waitForProductPanels(page, 3);
  await waitForPanelText(page, "Cold start owned fixture");
  stage("reloadToDurablePanelMs");
  if (report.errors.length) throw new Error("Owned page emitted errors");
  report.status = "PASS";
} catch (error) {
  report.status = "FAIL";
  report.failure = error.message;
  process.exitCode = 1;
} finally {
  await browser?.close();
  await mkdir(new URL("./", output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
