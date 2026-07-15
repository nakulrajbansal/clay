// No-model verification of the sample-data loop: open a TEMPLATE app (panels
// seeded without the planner), remove its template rows, fill generated
// samples from the Data editor, and check the live panels actually update.
// Usage: node scripts/samplefill.mjs [templateName] [outPrefix]
import { chromium } from "playwright";

const url = process.env.URL || "http://localhost:4173";
const template = process.argv[2] || "Sales CRM";
const outPrefix = process.argv[3] || "samplefill";

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));

await page.goto(url, { waitUntil: "domcontentloaded" });
await page.getByText(template, { exact: false }).first().click({ timeout: 15000 });
await page.waitForTimeout(3000);

// open Data, clear the template's sample rows, then fill generated ones
await page.locator(".appbar-data-btn").click();
await page.waitForTimeout(1200);
const clearBtn = page.locator(".dataview-sample-clear");
if (await clearBtn.count() > 0) {
  await clearBtn.click();
  await page.waitForTimeout(800);
  console.log("cleared template sample rows");
}
await page.locator(".dataview-sample").first().click();
await page.waitForTimeout(1200);
await page.screenshot({ path: `${outPrefix}-1-dataview.png`, fullPage: true });

// close the editor (Esc) and let panels re-render from their watches
await page.keyboard.press("Escape");
await page.waitForTimeout(1500);
await page.screenshot({ path: `${outPrefix}-2-panels.png`, fullPage: true });

// pull visible metric numbers from panel iframes to prove watches fired
let metrics = [];
for (const f of page.frames()) {
  const vals = await f.locator(".clay-metric-value").allTextContents().catch(() => []);
  metrics = metrics.concat(vals);
}
console.log("metric values seen:", metrics.slice(0, 10).join(" | ") || "(none)");
const nonZero = metrics.filter(v => v && !/^[$0.\s%]*$/.test(v)).length;
console.log(nonZero > 0 ? "PANELS LIVE-UPDATED ✓" : "PANELS DID NOT UPDATE ✗");
await browser.close();
process.exit(nonZero > 0 ? 0 : 1);
