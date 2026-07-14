// Iterative reshape harness: build one app, seed data through its forms, then
// apply a SEQUENCE of reshapes to the SAME living app — the real "keep editing
// it" loop. Data must persist across every reshape (data outlives interface),
// and each step must stay reversible via the version slider. Screenshots each
// step so the accumulation can be judged.
//
// Usage: node scripts/iterate.mjs <shell> '<buildPrompt>' '<seedJSON>' '<promptsJSON>' <outPrefix>
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const url = process.env.URL || "http://localhost:4173";
const shell = process.argv[2] || "blank";
const buildPrompt = process.argv[3] || "Build a simple task list with a table and an add form";
const seed = process.argv[4] ? JSON.parse(process.argv[4]) : [];
const prompts = process.argv[5] ? JSON.parse(process.argv[5]) : [];
const outPrefix = process.argv[6] || "iterate";
const key = readFileSync(new URL("../claude key.txt", import.meta.url), "utf8").trim();

const NAMES = {
  crm: "Sales CRM", small_business: "Small Business", financials: "Bookkeeping",
  staff: "Staff & Scheduling", tracker: "Tracker", log: "Log", dashboard: "Dashboard",
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
await ctx.addInitScript((k) => { try { localStorage.setItem("clay_api_key", k); } catch { /* iframe */ } }, key);
const page = await ctx.newPage();
const logs = [];
page.on("console", (m) => { const t = m.text(); if (t.includes("[clay") || m.type() === "error") logs.push(`${m.type()}: ${t}`); });
page.on("pageerror", (e) => logs.push("pageerror: " + e.message));

async function reshape(prompt, label) {
  await page.getByPlaceholder("Describe a change", { exact: false }).fill(prompt);
  await page.getByRole("button", { name: "Reshape", exact: true }).click();
  console.log(`[${label}] "${prompt.slice(0, 64)}"`);
  try {
    await page.getByRole("button", { name: "Keep", exact: true }).waitFor({ timeout: 150000 });
    await page.getByRole("button", { name: "Keep", exact: true }).click();
    await page.waitForTimeout(3500);
    return true;
  } catch { console.log(`  => NO PREVIEW (clarify/fail)`); return false; }
}

async function fillOnce(spec, values) {
  for (const f of page.frames()) {
    let ok = true;
    for (const n of Object.keys(values)) if (await f.locator(`[name="${n}"]`).count() === 0) { ok = false; break; }
    if (!ok) continue;
    for (const [n, v] of Object.entries(values)) {
      const ctrl = f.locator(`[name="${n}"]`).first();
      const meta = await ctrl.evaluate(el => ({ tag: el.tagName.toLowerCase(), type: el.getAttribute("type") || "" })).catch(() => ({ tag: "", type: "" }));
      if (meta.tag === "select") await ctrl.selectOption({ label: String(v) }).catch(() => ctrl.selectOption(String(v)));
      else if (meta.type === "checkbox") await ctrl.setChecked(v === true || v === "true");
      else await ctrl.fill(String(v));
    }
    const named = f.getByRole("button", { name: spec.form, exact: false });
    if (await named.count() > 0) await named.first().click();
    else await f.locator("button.clay-form-submit, form button").first().click();
    await page.waitForTimeout(400);
    return true;
  }
  return false;
}

await page.goto(url, { waitUntil: "domcontentloaded" });
const pick = shell === "blank" ? "Start from scratch" : (NAMES[shell] || shell);
await page.getByText(pick, { exact: false }).first().click({ timeout: 10000 });
await page.waitForTimeout(2500);

// step 0: initial build
await reshape(buildPrompt, "build");
// seed data so later views (board/metric/chart) have something to show
for (const spec of seed) {
  let n = 0;
  for (const r of (spec.times || [spec.fields])) { try { if (await fillOnce(spec, r)) n++; } catch (e) { console.log("  seed fail:", String(e).split("\n")[0]); } }
  console.log(`  seeded ${n} via "${spec.form}"`);
}
await page.waitForTimeout(1500);
await page.screenshot({ path: `${outPrefix}-0.png`, fullPage: true });

// steps 1..N: reshape the living app
for (let i = 0; i < prompts.length; i++) {
  await reshape(prompts[i], `edit ${i + 1}`);
  await page.screenshot({ path: `${outPrefix}-${i + 1}.png`, fullPage: true });
}

console.log("done. steps:", prompts.length + 1);
if (logs.length) console.log("--- console tail ---\n" + logs.slice(-12).join("\n"));
await browser.close();
