// No-model verification of the sample-data loop: open a TEMPLATE app (panels
// seeded without the planner), remove its template rows, fill generated
// samples, and check the live panels actually update.
// Two fill paths, both must live-update panels:
//   default        — the Data editor's "Sample data" button
//   SHORTCUT=1     — typing "populate with some dummy data" in the reshape box
//                    (the trusted-shell intent shortcut; regression for the
//                    refreshPanels detach bug that froze mounted panels)
// Usage: [SHORTCUT=1] node scripts/samplefill.mjs [templateName] [outPrefix]
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
if (process.env.SHORTCUT) {
  // fill via the reshape-box shortcut instead — close the editor first
  await page.keyboard.press("Escape");
  await page.getByPlaceholder("Describe a change", { exact: false })
    .fill("populate with some dummy data");
  await page.getByRole("button", { name: "Reshape", exact: true }).click();
  await page.getByText(/Filled your tables with \d+ sample rows/i)
    .first().waitFor({ timeout: 20000 });
  console.log("filled via reshape-box shortcut");
  await page.waitForTimeout(1500);
} else {
  await page.locator(".dataview-sample").first().click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${outPrefix}-1-dataview.png`, fullPage: true });

  // close the editor (Esc) and let panels re-render from their watches
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1500);
}
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
