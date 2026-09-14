// Cross-browser gate (launch): the SAME core journey must pass in
// Chromium, Firefox, and WebKit — boot, open a template, write a row
// through a form, see it live-update, then RELOAD and prove OPFS
// persistence (the layer most likely to differ per engine).
// Usage: node scripts/browsers.mjs
import { chromium, firefox, webkit } from "playwright";
import { productGateUrl } from "./product-gate-url.mjs";
import { chooseProductStarter, waitForProductPanels, waitForPanelText, productChromiumOptions } from "./product-onboarding.mjs";

const url = productGateUrl();
const engines = { chromium, firefox, webkit };
let failures = 0;

for (const [name, engine] of Object.entries(engines)) {
  const report = [];
  const check = (ok, label) => { report.push(`${ok ? "PASS" : "FAIL"} ${label}`); if (!ok) failures++; };
  let browser;
  try {
    browser = await engine.launch(name === "chromium" ? productChromiumOptions() : {});
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 1200 } });
    const page = await ctx.newPage();
    const errors = [];
    const sentinel = `Private probe ${name} 7f3c`;
    const leaked = [];
    page.on("request", request => {
      const url = request.url();
      if (url.includes(sentinel) || url.includes(encodeURIComponent(sentinel))
          || request.postData()?.includes(sentinel)) leaked.push(url);
    });
    page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 120)));
    page.on("console", message => {
      if (message.type() === "error") errors.push(message.text().slice(0, 120));
    });

    const coldStart = Date.now();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    const hasOpfs = await page.evaluate(() => typeof navigator.storage?.getDirectory === "function"
      && typeof navigator.locks?.request === "function");
    if (!hasOpfs) {
      await page.getByRole("heading", { name: "This app didn’t open" }).waitFor();
      throw new Error("Engine lacks durable OPFS/cross-tab exclusion; production correctly fails closed. Persistence journey NOT passed.");
    }
    await chooseProductStarter(page);
    await waitForProductPanels(page, 3);
    report.push(`TIMING cold navigation + onboarding + starter panels: ${Date.now() - coldStart} ms`);
    check(await page.locator(".panel-frame").count() >= 3, "template boots with panels");
    await page.getByRole("button", { name: "Customize", exact: true }).click();
    await page.locator(".appbar-mode-button.active", { hasText: "Customize" }).waitFor();

    await page.getByRole("button", { name: "Open data" }).click();
    const data = page.locator(".dataview");
    await data.waitFor();
    check(await page.locator(".dataview-backdrop").evaluate(element =>
      getComputedStyle(element).position === "fixed"), "Data is a viewport modal");
    const dataImport = data.getByRole("button", { name: /Import data/ });
    await dataImport.focus();
    check(await dataImport.evaluate(element => document.activeElement === element
        && element.getClientRects().length > 0), "Data import is keyboard-focusable");
    const firstDetails = data.getByRole("button", { name: /Open .* record details/ }).first();
    await firstDetails.click();
    const details = page.locator(".record-detail");
    await details.waitFor();
    await page.waitForFunction(() =>
      document.querySelector('.record-detail[role="dialog"][aria-modal="true"]') !== null
      && document.querySelectorAll('[role="dialog"][aria-modal="true"]').length === 1);
    check(await page.locator('[role="dialog"][aria-modal="true"]').count() === 1,
      "nested record detail exposes one active modal");
    await details.getByRole("button", { name: "Close record details" }).click();
    await data.getByRole("button", { name: "Close data view" }).click();
    await page.getByRole("button", { name: "Open automations" }).click();
    const automations = page.getByRole("dialog", { name: "Automations" });
    await automations.waitFor();
    check(await automations.getByRole("button", { name: "Build a custom rule" }).count() === 1,
      "Automation Center opens with rule creation available");
    await automations.getByRole("button", { name: "Close automations" }).click();

    // A memory session is not a production persistence substitute.
    check(await page.locator(".banner").count() === 0, "durable app has no fallback banner");

    // write through the real form
    let form = null;
    for (const f of page.frames()) if (await f.locator("form.clay-form").count().catch(() => 0)) { form = f; break; }
    check(!!form, "form frame found");
    if (form) {
      await form.locator("[name=name]").fill(sentinel);
      await ctx.setOffline(true);
      await form.locator("form.clay-form button").first().click();
      await waitForPanelText(page, sentinel);
      check(true, "offline form write live-updates panels");
      check(leaked.length === 0, "row data never enters a network request body");
      await ctx.setOffline(false);
    }

    // the acid test: reload — with OPFS the row must come back
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForProductPanels(page, 3);
    await waitForPanelText(page, sentinel);
    check(true, "row SURVIVES reload (OPFS persistence)");
    {
      await page.keyboard.press("Control+k");
      const palette = page.getByRole("dialog", { name: "Search and act" });
      await palette.getByRole("combobox", { name: "Search all records" }).fill(sentinel);
      const activeResult = palette.locator('.command-results > button[tabindex="0"]')
        .filter({ hasText: sentinel }).first();
      await activeResult.waitFor();
      check(await activeResult.isVisible(), "persisted record is the active global-search command");
      await palette.getByRole("combobox", { name: "Search all records" }).press("Enter");
      await page.locator(".record-detail").waitFor();
      check((await page.locator(".record-detail").textContent()).includes(sentinel),
        "global search opens the persisted record detail");
    }
    check(errors.length === 0, errors.length === 0 ? "zero page errors" : "page errors: " + errors[0]);
    await ctx.close();
  } catch (e) {
    check(false, "HARNESS: " + String(e).split("\n")[0].slice(0, 140));
  } finally {
    await browser?.close();
  }
  console.log(`\n=== ${name} ===\n` + report.join("\n"));
}
console.log(failures === 0 ? "\nALL ENGINES GREEN" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
