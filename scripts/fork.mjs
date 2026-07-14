// Verify fork-and-explore (B5): seed the CRM, duplicate it from the app
// switcher, and confirm the fork boots as a NEW app carrying the same data.
import { chromium } from "playwright";
const url = process.env.URL || "http://localhost:4173";
const out = process.argv[2] || "fork.png";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1024 } });
const page = await ctx.newPage();
const errs = [];
page.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
page.on("pageerror", e => errs.push("pageerror: " + e.message));

await page.goto(url, { waitUntil: "domcontentloaded" });
await page.getByText("Sales CRM", { exact: false }).first().click({ timeout: 8000 });
await page.waitForTimeout(4500);                 // seed + boot

await page.locator(".appbar-current").click();   // open the app switcher
await page.getByText("Duplicate", { exact: false }).first().click();
await page.waitForTimeout(11000);                 // fork (export/import) + reload + boot

// show the switcher so both apps are visible in the shot
try { await page.locator(".appbar-current").click({ timeout: 4000 }); await page.waitForTimeout(500); } catch {}
await page.screenshot({ path: out, fullPage: true });
const current = await page.locator(".appbar-current").textContent().catch(() => "?");
console.log("wrote", out, "| current app:", (current || "").trim());
if (errs.length) console.log("ERRORS:\n" + errs.slice(0, 10).join("\n"));
await browser.close();
