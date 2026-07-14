// Verify the view switcher end-to-end (moat pillar 4): seed the CRM, open the
// "All deals" table panel's view menu, pick "Board", and confirm the panel
// reshapes into a board via the normal preview→keep flow.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
const url = process.env.URL || "http://localhost:4173";
const out = process.argv[2] || "viewas.png";
const key = readFileSync(new URL("../claude key.txt", import.meta.url), "utf8").trim();

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
await ctx.addInitScript(k => { try { localStorage.setItem("clay_api_key", k); } catch {} }, key);
const page = await ctx.newPage();
const logs = [];
page.on("console", m => { const t = m.text(); if (t.includes("[clay")) logs.push(t.slice(0, 90)); });

await page.goto(url, { waitUntil: "domcontentloaded" });
await page.getByText("Sales CRM", { exact: false }).first().click({ timeout: 8000 });
await page.waitForTimeout(4500);

// open the "All deals" panel's view menu, choose Board
const dealsPanel = page.locator(".panel-frame", { hasText: "All deals" }).first();
await dealsPanel.getByText("⇄", { exact: false }).click();
await page.waitForTimeout(400);
await page.getByRole("button", { name: "Board", exact: false }).first().click();
console.log("picked Board — waiting for reshape…");

let kept = false;
try {
  await page.getByRole("button", { name: "Keep", exact: true }).waitFor({ timeout: 150000 });
  await page.getByRole("button", { name: "Keep", exact: true }).click();
  kept = true;
  await page.waitForTimeout(4000);
} catch { console.log("=> NO PREVIEW (clarify/fail)"); }

await page.screenshot({ path: out, fullPage: true });
console.log("wrote", out, kept ? "(kept)" : "(no-keep)");
if (logs.length) console.log(logs.slice(-6).join("\n"));
await browser.close();
