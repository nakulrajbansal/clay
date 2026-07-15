// Full-loop reshape test: seed a template, run a REAL model reshape with
// the BYO key, keep it, and screenshot the result — so reshape output can
// be judged and iterated visually. The key is read from the file here (it
// never appears on a command line) and injected into localStorage.
// Usage: node scripts/reshape.mjs <shell> "<prompt>" <outPath>
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const url = process.env.URL || "http://localhost:4173";
const shell = process.argv[2] || "crm";
const prompt = process.argv[3] || "add a notes field to deals";
const out = process.argv[4] || "reshape.png";
const key = readFileSync(new URL("../claude key.txt", import.meta.url), "utf8").trim();

const NAMES = {
  crm: "Sales CRM", small_business: "Small Business", financials: "Bookkeeping",
  staff: "Staff & Scheduling", habits: "Habits", inventory: "Inventory", tracker: "Tracker", log: "Log", dashboard: "Dashboard",
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1024 } });
// only the top document has localStorage; sandboxed panel iframes throw
await ctx.addInitScript((k) => {
  try { localStorage.setItem("clay_api_key", k); } catch { /* sandboxed iframe */ }
}, key);
const page = await ctx.newPage();
const logs = [];
page.on("console", (m) => {
  const t = m.text();
  if (t.includes("[clay pipeline]") || t.includes("[clay") || m.type() === "error") logs.push(`${m.type()}: ${t}`);
});
page.on("pageerror", (e) => logs.push("pageerror: " + e.message));

await page.goto(url, { waitUntil: "domcontentloaded" });
const pickLabel = shell === "blank" ? "Start from scratch" : (NAMES[shell] || shell);
await page.getByText(pickLabel, { exact: false }).first().click({ timeout: 10000 });
await page.waitForTimeout(3000);   // seed + boot

await page.getByPlaceholder("Describe a change", { exact: false }).fill(prompt);
await page.getByRole("button", { name: "Reshape", exact: true }).click();
console.log(`reshaping "${prompt}" ...`);

let kept = false;
try {
  await page.getByRole("button", { name: "Keep", exact: true }).waitFor({ timeout: 120000 });
  await page.getByRole("button", { name: "Keep", exact: true }).click();
  kept = true;
  await page.waitForTimeout(4000);   // commit + hot swap + render
} catch {
  console.log("=> NO PREVIEW (clarify or failure) — capturing the rail");
}

await page.screenshot({ path: out, fullPage: true });
console.log("wrote", out, kept ? "(kept)" : "(no-keep)");
if (logs.length) console.log("--- console ---\n" + logs.slice(0, 25).join("\n"));
await browser.close();
