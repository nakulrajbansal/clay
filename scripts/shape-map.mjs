// Next-generation shell gate: the semantic Shape Map must make Clay's moat
// legible and the reshape workspace must reclaim canvas space on demand.
// Usage: node scripts/shape-map.mjs [outDir]
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { mkdir } from "node:fs/promises";

const url = process.env.URL || "http://127.0.0.1:4173";
const outDir = process.argv[2] || "evidence";
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
const page = await context.newPage();
const errors = [];
page.on("console", message => {
  if (message.type() === "error") errors.push(message.text());
});
page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));

const check = (condition, label) => {
  if (!condition) throw new Error(`FAIL ${label}`);
  console.log(`PASS ${label}`);
};

await page.goto(url, { waitUntil: "domcontentloaded" });
await page.getByText("Sales CRM", { exact: true }).click({ timeout: 15_000 });
await page.locator(".panel-frame").first().waitFor({ timeout: 20_000 });

const shellAxe = await new AxeBuilder({ page }).exclude("iframe").analyze();
const shellBlocking = shellAxe.violations.filter(violation =>
  violation.impact === "serious" || violation.impact === "critical");
if (shellBlocking.length > 0) {
  console.log(JSON.stringify(shellBlocking.map(violation => ({
    id: violation.id,
    nodes: violation.nodes.map(node => ({ target: node.target, html: node.html,
      summary: node.failureSummary })),
  })), null, 2));
}
check(shellBlocking.length === 0,
  `trusted shell has no serious or critical axe violations${shellBlocking.length ? `: ${shellBlocking.map(v => v.id).join(", ")}` : ""}`);

for (const themeName of ["Indigo", "Violet", "Emerald", "Sky", "Rose", "Amber",
  "Graphite", "Midnight", "Ocean", "Plum", "Kiln"]) {
  await page.getByRole("button", { name: "Choose color scheme" }).click();
  await page.locator(".appbar-theme-menu").getByRole("button", { name: themeName, exact: true }).click();
  await page.waitForFunction(name => document.documentElement.dataset.theme === name.toLowerCase(),
    themeName);
  await page.getByRole("button", { name: "Open shape map" }).click();
  const themeAxe = await new AxeBuilder({ page }).exclude("iframe").analyze();
  const themeBlocking = themeAxe.violations.filter(violation =>
    violation.impact === "serious" || violation.impact === "critical");
  if (themeBlocking.length > 0) {
    console.log(JSON.stringify(themeBlocking.map(violation => ({
      id: violation.id,
      nodes: violation.nodes.map(node => ({ target: node.target, html: node.html,
        summary: node.failureSummary })),
    })), null, 2));
  }
  check(themeBlocking.length === 0,
    `${themeName} theme has no serious or critical shell violations${themeBlocking.length ? `: ${themeBlocking.map(v => v.id).join(", ")}` : ""}`);
  await page.getByRole("button", { name: "Close shape map" }).click();
}

const canvasBefore = await page.locator(".regions").evaluate(el => el.getBoundingClientRect().width);
await page.getByRole("button", { name: "Hide reshape" }).click();
const canvasAfter = await page.locator(".regions").evaluate(el => el.getBoundingClientRect().width);
check(canvasAfter > canvasBefore + 250, "collapsing reshape returns meaningful width to the canvas");
await page.getByRole("button", { name: "Show reshape" }).click();

await page.getByRole("button", { name: "Open shape map" }).click();
const dialog = page.getByRole("dialog", { name: "Shape map" });
await dialog.waitFor({ timeout: 5_000 });
await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Close shape map");
check(await page.locator(".app").getAttribute("inert") !== null,
  "shape map makes the background inert");
await page.keyboard.press("Shift+Tab");
check(await dialog.evaluate(element => element.contains(document.activeElement)),
  "shape map traps reverse-tab focus inside the modal");
await page.keyboard.press("Escape");
await dialog.waitFor({ state: "detached" });
check(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")) === "Open shape map",
  "Escape closes the modal and returns focus to its trigger");
await page.getByRole("button", { name: "Open shape map" }).click();
await dialog.waitFor();
check(await dialog.getByText("Permanent data", { exact: true }).count() === 1,
  "shape map exposes the permanent substrate");
check(await dialog.getByText("Live views", { exact: true }).count() === 1,
  "shape map exposes live projections");
check(await dialog.getByText("Evolution", { exact: true }).count() === 1,
  "shape map exposes reversible evolution");
check(await dialog.getByText("deals", { exact: true }).count() >= 1,
  "shape map contains real registry tables");
check(await dialog.getByText("Pipeline · drag a deal between stages", { exact: true }).count() >= 1,
  "shape map contains real live panels");
await page.waitForTimeout(350); // audit the settled state, after the entry transition
const axe = await new AxeBuilder({ page }).include(".shape-map").analyze();
const blockingA11y = axe.violations.filter(violation =>
  violation.impact === "serious" || violation.impact === "critical");
if (blockingA11y.length > 0) {
  console.log(JSON.stringify(blockingA11y.map(violation => ({
    id: violation.id,
    nodes: violation.nodes.map(node => ({ target: node.target, html: node.html, summary: node.failureSummary })),
  })), null, 2));
}
check(blockingA11y.length === 0,
  `shape map has no serious/critical axe violations${blockingA11y.length ? `: ${blockingA11y.map(v => v.id).join(", ")}` : ""}`);
await page.screenshot({ path: `${outDir}/nextgen-shape-map-desktop.png`, fullPage: true });

await dialog.getByRole("button", { name: "Open deals data" }).click();
await page.locator(".dataview").waitFor();
check(await page.locator(".dataview-tab.selected").textContent() === "deals",
  "a substrate node opens the exact real data table");
await page.locator(".dataview-close").click();

await page.getByRole("button", { name: "Open shape map" }).click();
await dialog.waitFor();
await dialog.locator(".shape-view-node")
  .filter({ hasText: "Pipeline · drag a deal between stages" })
  .getByRole("button", { name: "Shape this view" }).click();
const composer = page.getByPlaceholder("Describe a change", { exact: false });
const panelPrefix = "In the “Pipeline · drag a deal between stages” panel:";
await page.waitForFunction(prefix =>
  [...document.querySelectorAll("textarea")].some(textarea => textarea.value.startsWith(prefix)),
  panelPrefix,
);
check((await composer.inputValue()).startsWith(panelPrefix),
  "a live-view node points the reshape composer at that exact panel");

await page.setViewportSize({ width: 820, height: 980 });
await page.getByRole("button", { name: "Open shape map" }).click();
await dialog.waitFor();
check(await dialog.evaluate(el => el.getBoundingClientRect().width <= 820),
  "shape map fits the compact viewport");
check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  "shape map causes no compact horizontal page overflow");
await page.screenshot({ path: `${outDir}/nextgen-shape-map-compact.png`, fullPage: true });

await page.setViewportSize({ width: 390, height: 844 });
check(await dialog.evaluate(el => el.getBoundingClientRect().width <= 390),
  "shape map fits a phone viewport");
check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  "trusted shell and modal cause no phone horizontal overflow");
await page.screenshot({ path: `${outDir}/nextgen-shape-map-phone.png`, fullPage: true });

check(errors.length === 0, `zero page errors${errors.length ? `: ${errors.join(" | ")}` : ""}`);
await browser.close();
console.log("SHAPE MAP GATE GREEN");
