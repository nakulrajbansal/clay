// Verify 2D column placement (ADR-019): drag a main panel to the far-right
// column and confirm it pins there (grid-column starts at col 3), and the
// drop indicator lands in the target column.
import { chromium } from "playwright";
const url = process.env.URL || "http://localhost:4173";
const out = process.argv[2] || "verify2d.png";
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1024 } })).newPage();
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.getByText("Sales CRM", { exact: false }).first().click({ timeout: 8000 });
await page.waitForTimeout(4500);

// start dragging the "Pipeline by stage" panel (a half-width main panel)
const startFar = await page.evaluate(() => {
  const frames = [...document.querySelectorAll(".region-main .panel-frame")];
  const panel = frames.find(f => f.textContent.includes("Pipeline by stage"));
  const grip = panel?.querySelector(".panel-grip");
  if (!grip) return null;
  grip.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: new DataTransfer() }));
  const region = document.querySelector(".region-main");
  const r = region.getBoundingClientRect();
  return { x: r.right - 60, y: r.top + 30 };
});
if (!startFar) { console.log("panel not found"); await browser.close(); process.exit(1); }
await page.waitForTimeout(120);
await page.evaluate(({ x, y }) => {
  const region = document.querySelector(".region-main");
  region.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer: new DataTransfer(), clientX: x, clientY: y }));
}, startFar);
await page.waitForTimeout(250);
const slotCol = await page.locator(".drop-slot").first().evaluate(el => el.style.gridColumn).catch(() => "?");
console.log("drop-slot grid-column:", slotCol);
await page.evaluate(({ x, y }) => {
  const region = document.querySelector(".region-main");
  region.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: new DataTransfer(), clientX: x, clientY: y }));
}, startFar);
await page.waitForTimeout(1600);
const pinned = await page.evaluate(() => {
  const panel = [...document.querySelectorAll(".region-main .panel-frame")]
    .find(f => f.textContent.includes("Pipeline by stage"));
  return panel?.style.gridColumn ?? "?";
});
console.log("Pipeline-by-stage grid-column after drop:", pinned);
await page.screenshot({ path: out, fullPage: true });
console.log("wrote", out);
await browser.close();
