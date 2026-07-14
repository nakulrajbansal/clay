// Verify named checkpoints: open a template with history, open the History
// overlay, name a version, and screenshot the result (label pill visible).
import { chromium } from "playwright";
const url = process.env.URL || "http://localhost:4173";
const out = process.argv[2] || "checkpoint.png";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1024 } });
const page = await ctx.newPage();
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.getByText("Sales CRM", { exact: false }).first().click({ timeout: 8000 });
await page.waitForTimeout(4500);
await page.getByText("History", { exact: false }).first().click({ timeout: 5000 });
await page.waitForTimeout(600);
// name the oldest version (v1): click its "Name this"
const nameButtons = page.getByRole("button", { name: "Name this", exact: true });
await nameButtons.last().click();                       // last = oldest (bottom)
await page.getByPlaceholder("Name this moment", { exact: false }).fill("Before I customised it");
await page.getByRole("button", { name: "Save", exact: true }).click();
await page.waitForTimeout(700);
await page.screenshot({ path: out, fullPage: true });
console.log("wrote", out);
await browser.close();
