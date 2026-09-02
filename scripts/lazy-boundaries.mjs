import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const url = process.env.URL || "http://127.0.0.1:4173";
const outDir = process.argv[2] || "evidence";
await mkdir(outDir, { recursive: true });
const browser = await chromium.launch();
const check = (condition, label) => {
  if (!condition) throw new Error(`FAIL ${label}`);
  console.log(`PASS ${label}`);
};

async function bootWithFailure(asset, action, expectedLabel, screenshot) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route(`**/assets/${asset}-*.js`, route => route.abort("failed"));
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.getByText("Sales CRM", { exact: true }).click({ timeout: 15_000 });
  await action(page);
  const alert = page.getByRole("alert", { name: `${expectedLabel} failed to load` });
  await alert.waitFor({ timeout: 20_000 });
  check(await page.locator(".appbar").count() === 1,
    `${expectedLabel} chunk failure keeps trusted app chrome mounted`);
  const reload = alert.getByRole("button", { name: "Reload Clay" });
  check(await reload.count() === 1,
    `${expectedLabel} chunk failure exposes a concrete reload recovery`);
  check(await reload.evaluate(element => element === document.activeElement),
    `${expectedLabel} chunk failure focuses its recovery action`);
  if (expectedLabel === "shape map") {
    check(await page.locator(".app").getAttribute("inert") !== null,
      "modal chunk failure makes the background inert");
    await page.keyboard.press("Tab");
    check(await reload.evaluate(element => element === document.activeElement),
      "modal chunk failure traps focus on its recovery action");
  }
  check((await page.locator("#root").textContent())?.trim().length > 0,
    `${expectedLabel} chunk failure never empties the root`);
  await page.screenshot({ path: `${outDir}/${screenshot}`, fullPage: true });
  await context.close();
}

await bootWithFailure(
  "PanelFrame",
  async page => { await page.getByRole("button", { name: /Current:/ }).waitFor(); },
  "views",
  "nextgen-lazy-panel-recovery.png",
);
await bootWithFailure(
  "ShapeMapView",
  async page => {
    await page.locator(".panel-frame").first().waitFor({ timeout: 20_000 });
    await page.getByRole("button", { name: "Open shape map" }).click();
  },
  "shape map",
  "nextgen-lazy-shape-map-recovery.png",
);

{
  const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
  await context.route(/\/assets\/db-worker-[^/]+\.js(?:\?.*)?$/, route => route.abort("failed"));
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "This app didn’t open" }).waitFor({ timeout: 30_000 });
  const startOver = page.getByRole("button", { name: "Start over…" });
  await startOver.click();
  const confirmation = page.getByRole("alertdialog", { name: "Confirm action" });
  await confirmation.waitFor();
  check(await confirmation.getByRole("button", { name: "Confirm" })
    .evaluate(element => element === document.activeElement),
    "boot-error Start over renders a focused recovery confirmation");
  check(await page.locator(".boot-error").getAttribute("inert") !== null,
    "boot-error confirmation makes the failed surface inert");
  await page.keyboard.press("Escape");
  await confirmation.waitFor({ state: "detached" });
  check(await startOver.evaluate(element => element === document.activeElement),
    "boot-error confirmation cancels with Escape and restores focus");
  await context.close();
}

await browser.close();
console.log("LAZY SURFACE RECOVERY GATE GREEN");
