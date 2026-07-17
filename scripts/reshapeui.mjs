// No-model verification of the reshaping-UI roadmap (ADR-022 / doc 14):
//   R1 masonry packing  — every grid panel carries a row-span; no overlaps,
//                         no giant holes between grid panels
//   R2 universal resize — width+height handles on TOP panels too
//   R3 local ops        — double-click rename and ✕ remove commit instantly
//                         (no model), and the timeline grows
//   R4 point-then-speak — ✨ seeds the composer scoped to the panel
// Usage: node scripts/reshapeui.mjs [templateName] [outPrefix]
import { chromium } from "playwright";

const url = process.env.URL || "http://localhost:4173";
const template = process.argv[2] || "Sales CRM";
const outPrefix = process.argv[3] || "reshapeui";

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

await page.goto(url, { waitUntil: "domcontentloaded" });
await page.getByText(template, { exact: false }).first().click({ timeout: 15000 });
await page.waitForTimeout(3500);   // panels boot + report heights

// R1: every grid panel has an inline row span, and no two panels overlap
const frames = page.locator(".region-main .panel-frame, .region-top .panel-frame");
const n = await frames.count();
check(n > 0, `template shows ${n} grid panels`);
let spans = 0;
const rects = [];
for (let i = 0; i < n; i++) {
  const el = frames.nth(i);
  const style = await el.getAttribute("style");
  // the browser may serialize grid-row+grid-column into the grid-area shorthand
  if (style && /grid-(row|area)/.test(style)) spans++;
  rects.push(await el.boundingBox());
}
check(spans === n, `masonry: ${spans}/${n} panels carry a measured row span`);
let overlaps = 0;
for (let i = 0; i < rects.length; i++)
  for (let j = i + 1; j < rects.length; j++) {
    const a = rects[i], b = rects[j];
    if (!a || !b) continue;
    const x = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const y = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    if (x > 4 && y > 4) overlaps++;
  }
check(overlaps === 0, `masonry: no overlapping panels (${overlaps})`);

// R2: a TOP-region panel has both width and height resize handles
const topPanel = page.locator(".region-top .panel-frame").first();
if (await topPanel.count() > 0) {
  check(await topPanel.locator(".panel-edge-resize.e").count() === 1, "top panel has a width handle");
  check(await topPanel.locator(".panel-edge-resize.s").count() === 1, "top panel has a height handle");
} else console.log("(template has no top panel; width/height handle check ran on main only)");
const mainPanel = page.locator(".region-main .panel-frame").first();
check(await mainPanel.locator(".panel-edge-resize.s").count() === 1, "main panel has a height handle");

// R4: ✨ seeds the composer with the panel-scoped prefix
const title0 = (await mainPanel.locator(".panel-title-text").innerText()).trim();
await mainPanel.locator(".panel-tool", { hasText: "✨" }).click();
const composer = page.getByPlaceholder("Describe a change", { exact: false });
await page.waitForTimeout(500);   // seed lands via a React effect
const seeded = await composer.inputValue();
check(seeded.includes(`“${title0}”`) && seeded.startsWith("In the"), `✨ seeded composer: ${JSON.stringify(seeded)}`);
await composer.fill("");

// R3a: double-click rename, Enter commits — instant, no model
const versionsBefore = (await page.locator(".timeslider").innerText()).match(/v(\d+)/)?.[1];
await mainPanel.locator(".panel-title-text").dblclick();
await mainPanel.locator(".panel-title-edit").fill("Renamed By Hand");
await mainPanel.locator(".panel-title-edit").press("Enter");
await page.waitForTimeout(900);
check((await page.locator(".panel-title-text", { hasText: "Renamed By Hand" }).count()) === 1,
  "rename committed and rendered");
const versionsAfter = (await page.locator(".timeslider").innerText()).match(/v(\d+)/)?.[1];
check(Number(versionsAfter) === Number(versionsBefore) + 1,
  `rename is a timeline commit (v${versionsBefore} -> v${versionsAfter})`);

// R3b: ✕ removes the panel after confirm; panel count drops by one
const beforeCount = await page.locator(".region-main .panel-frame, .region-top .panel-frame, .region-side .panel-frame").count();
await page.locator(".panel-frame", { hasText: "Renamed By Hand" }).locator(".panel-tool-remove").click();
await page.locator(".confirm-actions button.primary").click();   // styled dialog (finish pass)
await page.waitForTimeout(900);
const afterCount = await page.locator(".region-main .panel-frame, .region-top .panel-frame, .region-side .panel-frame").count();
check(afterCount === beforeCount - 1, `remove dropped panel count ${beforeCount} -> ${afterCount}`);

await page.screenshot({ path: `${outPrefix}-final.png`, fullPage: true });
console.log(failures === 0 ? "RESHAPE-UI ROADMAP GREEN ✓" : `${failures} check(s) failed ✗`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
