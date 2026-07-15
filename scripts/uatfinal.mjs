// Final persona-UAT run: rebuild the user's portfolio dashboard from a blank
// canvas with the exec-summary mega intent (the one that previously died at
// validate), fill dummy data via the trusted-shell shortcut, then apply the
// persona iteration prompts. Screenshots every step; prints metric values so
// the run is judgeable without a human at the wheel.
//
// Usage: node scripts/uatfinal.mjs [outPrefix]
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const url = process.env.URL || "http://localhost:4173";
const outPrefix = process.argv[2] || "uatfinal";
const key = readFileSync(new URL("../claude key.txt", import.meta.url), "utf8").trim();

const BUILD =
  "Create a Portfolio Dashboard for tracking projects. Each project has a name, owner, status (on track / at risk / off track / done), budget, spent, due date, key risk, and a plain-language business outcome. Show a project table, a status board, and an add-project form.";
const EDITS = [
  "Add an executive summary strip at the top: total projects, total budget, total spent, and count of at-risk projects. Think about what an exec wants at a glance.",
  'Add a "Needs attention" panel near the top: projects that are at risk or off track, showing owner, key risk, and due date.',
];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1300 } });
await ctx.addInitScript((k) => { try { localStorage.setItem("clay_api_key", k); } catch { /* iframe */ } }, key);
const page = await ctx.newPage();
const logs = [];
page.on("console", (m) => { const t = m.text(); if (t.includes("[clay") || m.type() === "error") logs.push(`${m.type()}: ${t}`); });
page.on("pageerror", (e) => logs.push("pageerror: " + e.message));

let failures = 0;

async function reshape(prompt, label) {
  await page.getByPlaceholder("Describe a change", { exact: false }).fill(prompt);
  await page.getByRole("button", { name: "Reshape", exact: true }).click();
  console.log(`[${label}] "${prompt.slice(0, 70)}…"`);
  try {
    await page.getByRole("button", { name: "Keep", exact: true }).waitFor({ timeout: 180000 });
    await page.getByRole("button", { name: "Keep", exact: true }).click();
    await page.waitForTimeout(3500);
    console.log("  => KEPT");
    return true;
  } catch { console.log("  => NO PREVIEW (clarify/fail)"); failures++; return false; }
}

async function metricValues() {
  let vals = [];
  for (const f of page.frames()) {
    vals = vals.concat(await f.locator(".clay-metric-value").allTextContents().catch(() => []));
  }
  return vals;
}

await page.goto(url, { waitUntil: "domcontentloaded" });
await page.getByText("Start from scratch", { exact: false }).first().click({ timeout: 10000 });
await page.waitForTimeout(2500);

// step 0: initial build (previously failed@validate pre-ADR-020)
await reshape(BUILD, "build");
await page.screenshot({ path: `${outPrefix}-0-build.png`, fullPage: true });

// step 1: dummy data via the trusted-shell shortcut — no Keep button, just a toast
await page.getByPlaceholder("Describe a change", { exact: false }).fill("populate with some dummy data");
await page.getByRole("button", { name: "Reshape", exact: true }).click();
console.log('[dummy] "populate with some dummy data"');
try {
  await page.getByText(/Filled your tables with \d+ sample rows/i).first().waitFor({ timeout: 20000 });
  console.log("  => SAMPLES ADDED (shortcut, no model call)");
} catch { console.log("  => shortcut feed message not seen"); failures++; }
await page.waitForTimeout(2500);
await page.screenshot({ path: `${outPrefix}-1-dummy.png`, fullPage: true });

// steps 2..N: persona iteration prompts on the living app
for (let i = 0; i < EDITS.length; i++) {
  await reshape(EDITS[i], `edit ${i + 1}`);
  await page.screenshot({ path: `${outPrefix}-${i + 2}-edit${i + 1}.png`, fullPage: true });
}

const vals = await metricValues();
console.log("metric values seen:", vals.slice(0, 12).join(" | ") || "(none)");
const nonZero = vals.filter(v => v && !/^[$0.\s%]*$/.test(v)).length;
console.log(`RESULT: ${failures === 0 && nonZero > 0 ? "ALL STEPS GREEN ✓" : `${failures} step(s) failed, ${nonZero} non-zero metrics`}`);
if (logs.length) console.log("--- console tail ---\n" + logs.slice(-12).join("\n"));
await browser.close();
process.exit(failures === 0 && nonZero > 0 ? 0 : 1);
