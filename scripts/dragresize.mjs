// Verify (1) the drop-placeholder appears during a panel drag and (2) the
// edge-drag resize snaps a panel's width. Screenshots each state.
import { chromium } from "playwright";
const url = process.env.URL || "http://localhost:4173";
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1024 } })).newPage();
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.getByText("Sales CRM", { exact: false }).first().click({ timeout: 8000 });
await page.waitForTimeout(4500);

// (1) drop indicator: start dragging a panel, THEN (next tick) hover the region
await page.evaluate(() => {
  const grip = document.querySelectorAll(".panel-grip")[3];
  grip.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: new DataTransfer() }));
});
await page.waitForTimeout(120);   // let React commit dragId
await page.evaluate(() => {
  const region = document.querySelector(".region-main");
  const r = region.getBoundingClientRect();
  region.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer: new DataTransfer(),
    clientX: r.left + 20, clientY: r.top + 20 }));
});
await page.waitForTimeout(300);
const slots = await page.locator(".drop-slot").count();
console.log("drop-slot count during drag:", slots);
await page.screenshot({ path: process.env.TMP + "/dr-slot.png", fullPage: true });
// end the synthetic drag
await page.evaluate(() => {
  document.querySelectorAll(".panel-grip")[3].dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: new DataTransfer() }));
});
await page.waitForTimeout(300);

// (2) edge resize: drag the "All deals" right edge to full width (span 4)
const panel = page.locator(".region-main .panel-frame").filter({ hasText: "All deals" }).first();
const spanOf = () => panel.evaluate(el => el.style.gridColumn || getComputedStyle(el).gridColumn).catch(() => "?");
const spanBefore = await spanOf();
const eHandle = panel.locator(".panel-edge-resize.e");
const hb = await eHandle.boundingBox();
const rb = await page.locator(".region-main").boundingBox();
if (hb && rb) {
  await page.mouse.move(hb.x + 5, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(rb.x + rb.width - 20, hb.y + hb.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(1600);
}
console.log("All deals span:", spanBefore, "->", await spanOf());

// (3) height resize: drag the bottom edge of "Contacts" down ~140px
const cpanel = page.locator(".panel-frame").filter({ hasText: "Contacts" }).first();
const ifr = cpanel.locator("iframe");
const hBefore = (await ifr.boundingBox())?.height;
const sHandle = cpanel.locator(".panel-edge-resize.s");
const sb = await sHandle.boundingBox();
if (sb) {
  await page.mouse.move(sb.x + sb.width / 2, sb.y + 5);
  await page.mouse.down();
  await page.mouse.move(sb.x + sb.width / 2, sb.y + 160, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(1600);
}
const hAfter = (await ifr.boundingBox())?.height;
console.log("Contacts iframe height:", Math.round(hBefore), "->", Math.round(hAfter));
await page.screenshot({ path: process.env.TMP + "/dr-resize.png", fullPage: true });
await browser.close();
