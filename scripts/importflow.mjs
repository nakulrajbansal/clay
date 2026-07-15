// Verify the data-ingestion + edit flow the way a user hits it:
//   blank canvas -> upload a CSV -> Clay imports + auto-builds a dashboard ->
//   click a panel's ✎ -> the Data editor opens focused on that table.
// Usage: node scripts/importflow.mjs <csvPath> <outPrefix>
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const url = process.env.URL || "http://localhost:4173";
const csv = process.argv[2];
const outPrefix = process.argv[3] || "importflow";
const key = readFileSync(new URL("../claude key.txt", import.meta.url), "utf8").trim();

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
await ctx.addInitScript((k) => {
  try { localStorage.setItem("clay_api_key", k); } catch { /* sandboxed */ }
}, key);
const page = await ctx.newPage();
const logs = [];
page.on("console", (m) => { const t = m.text(); if (t.includes("[clay") || m.type() === "error") logs.push(`${m.type()}: ${t}`); });
page.on("pageerror", (e) => logs.push("pageerror: " + e.message));

await page.goto(url, { waitUntil: "domcontentloaded" });
await page.getByText("Start from scratch", { exact: false }).first().click({ timeout: 10000 });
await page.waitForTimeout(2000);

// Upload the file through the empty-canvas file input.
const input = page.locator('.empty-upload input[type="file"]');
await input.setInputFiles(csv);
console.log("uploaded:", csv);

// Import commits fast; the auto-dashboard reshape needs the model.
await page.waitForTimeout(3000);
await page.screenshot({ path: `${outPrefix}-1-imported.png`, fullPage: true });

// Wait for the dashboard proposal, then Keep it (the real user path).
try {
  await page.getByRole("button", { name: "Keep", exact: true }).waitFor({ timeout: 150000 });
  await page.getByRole("button", { name: "Keep", exact: true }).click();
  await page.waitForTimeout(4000);
} catch { console.log("no Keep button (clarify/failure?)"); }
await page.screenshot({ path: `${outPrefix}-2-dashboard.png`, fullPage: true });

// Click the first panel's ✎ Edit-data tool.
const pencil = page.locator('.panel-tool', { hasText: "✎" }).first();
if (await pencil.count() > 0) {
  await pencil.click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${outPrefix}-3-editdata.png`, fullPage: true });
  console.log("opened Data editor via ✎");
} else {
  console.log("NO ✎ tool found on any panel");
}

const panelCount = await page.locator(".panel-frame").count();
console.log("panels:", panelCount);
if (logs.length) console.log("LOGS:\n" + logs.slice(0, 30).join("\n"));
await browser.close();
