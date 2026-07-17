// Cross-browser gate (launch): the SAME core journey must pass in
// Chromium, Firefox, and WebKit — boot, open a template, write a row
// through a form, see it live-update, then RELOAD and prove OPFS
// persistence (the layer most likely to differ per engine).
// Usage: node scripts/browsers.mjs
import { chromium, firefox, webkit } from "playwright";

const url = process.env.URL || "http://localhost:4173";
const engines = { chromium, firefox, webkit };
let failures = 0;

for (const [name, engine] of Object.entries(engines)) {
  const report = [];
  const check = (ok, label) => { report.push(`${ok ? "PASS" : "FAIL"} ${label}`); if (!ok) failures++; };
  let browser;
  try {
    browser = await engine.launch();
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 1200 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 120)));

    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.getByText("Tracker", { exact: true }).click({ timeout: 15000 });
    await page.waitForTimeout(4500);
    check(await page.locator(".panel-frame").count() >= 3, "template boots with panels");

    // Persistence expectation is per-engine capability: with OPFS present,
    // silence; without it (Playwright's Windows WebKit port has NO
    // navigator.storage.getDirectory — real Safari 17+ does), the honest
    // behavior is a working in-memory session + a clear warning banner.
    // Real-Safari verification requires macOS hardware (launch checklist).
    const hasOpfs = await page.evaluate(() =>
      typeof navigator.storage?.getDirectory === "function");
    const banner = await page.locator(".banner").count();
    if (hasOpfs) check(banner === 0, "OPFS present -> no warning banner");
    else check(banner === 1, "no OPFS in this engine -> fallback banner shown");

    // write through the real form
    let form = null;
    for (const f of page.frames()) if (await f.locator("form.clay-form").count().catch(() => 0)) { form = f; break; }
    check(!!form, "form frame found");
    if (form) {
      await form.locator("[name=name]").fill(`Probe ${name}`);
      await form.locator("form.clay-form button").first().click();
      await page.waitForTimeout(1500);
      let seen = false;
      for (const f of page.frames())
        if ((await f.locator("body").textContent().catch(() => "")).includes(`Probe ${name}`)) seen = true;
      check(seen, "form write live-updates panels");
    }

    // the acid test: reload — with OPFS the row must come back
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4500);
    let persisted = false;
    for (const f of page.frames())
      if ((await f.locator("body").textContent().catch(() => "")).includes(`Probe ${name}`)) persisted = true;
    if (hasOpfs) check(persisted, "row SURVIVES reload (OPFS persistence)");
    else check(!persisted && await page.locator(".panel-frame").count() >= 3,
      "no OPFS: session-only by design, app still boots after reload");
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
