// Visual feedback loop: render the built app in real Chromium, pick a
// template (no model needed — seeding is local), and screenshot the result.
// Usage: node scripts/shoot.mjs <shell> <outPath> [reshapePrompt]
import { chromium } from "playwright";

const url = process.env.URL || "http://localhost:4173";
const shell = process.argv[2] || "crm";
const out = process.argv[3] || "shot.png";

const NAMES = {
  crm: "Sales CRM", small_business: "Small Business", financials: "Bookkeeping",
  staff: "Staff & Scheduling", habits: "Habits", inventory: "Inventory", tracker: "Tracker", log: "Log", dashboard: "Dashboard",
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1024 } });
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

await page.goto(url, { waitUntil: "domcontentloaded" });

if (shell === "onboarding") {
  await page.waitForTimeout(800);
  await page.screenshot({ path: out, fullPage: true });
  console.log("wrote", out);
  await browser.close();
  process.exit(0);
}

// onboarding -> pick the blank hero or a template card
try {
  const label = shell === "blank" ? "Start from scratch" : (NAMES[shell] || shell);
  await page.getByText(label, { exact: false }).first().click({ timeout: 8000 });
} catch {
  console.log("(no onboarding card — already seeded)");
}

// let the worker seed + the panel iframes boot and render
await page.waitForTimeout(4500);
// optional: click a control (e.g. "History ↗") before the shot
const clickText = process.argv[4];
if (clickText) {
  try { await page.getByText(clickText, { exact: false }).first().click({ timeout: 5000 }); await page.waitForTimeout(800); }
  catch { console.log(`(could not click "${clickText}")`); }
}
await page.screenshot({ path: out, fullPage: true });
console.log("wrote", out);
if (errors.length) console.log("PAGE ERRORS:\n" + errors.slice(0, 15).join("\n"));
await browser.close();
