// Run-wild harness: build a real app from a blank canvas via ONE compound
// reshape, then (optionally) seed rows through the app's OWN sandboxed forms
// — exactly what a user does — and screenshot. This exercises the true path
// end-to-end (model -> migration -> panels -> live forms -> watches -> charts)
// so breakage shows up the way a user would hit it.
//
// Usage: node scripts/buildapp.mjs "<prompt>" <outPath> ['<seedJSON>']
//   seedJSON: [{ "form": "<text on submit button>", "fields": {name:value},
//               "times": [ {name:value}, ... ] }]  (times overrides one-shot)
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const url = process.env.URL || "http://localhost:4173";
const prompt = process.argv[2] || "Build a simple task list with a table and an add form";
const out = process.argv[3] || "buildapp.png";
const seed = process.argv[4] ? JSON.parse(process.argv[4]) : [];
const key = readFileSync(new URL("../claude key.txt", import.meta.url), "utf8").trim();

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
await ctx.addInitScript((k) => {
  try { localStorage.setItem("clay_api_key", k); } catch { /* sandboxed iframe */ }
}, key);
const page = await ctx.newPage();
const logs = [];
page.on("console", (m) => {
  const t = m.text();
  if (t.includes("[clay") || m.type() === "error") logs.push(`${m.type()}: ${t}`);
});
page.on("pageerror", (e) => logs.push("pageerror: " + e.message));

await page.goto(url, { waitUntil: "domcontentloaded" });
await page.getByText("Start from scratch", { exact: false }).first().click({ timeout: 10000 });
await page.waitForTimeout(2500);

await page.getByPlaceholder("Describe a change", { exact: false }).fill(prompt);
await page.getByRole("button", { name: "Reshape", exact: true }).click();
console.log(`building: "${prompt.slice(0, 70)}…"`);

let kept = false;
try {
  await page.getByRole("button", { name: "Keep", exact: true }).waitFor({ timeout: 150000 });
  await page.getByRole("button", { name: "Keep", exact: true }).click();
  kept = true;
  await page.waitForTimeout(4000);
} catch {
  console.log("=> NO PREVIEW (clarify or failure)");
}

// Seed rows through the live forms. Each panel is its own iframe; find the
// frame that actually has the target inputs, fill by `name`, click submit.
async function fillOnce(spec, values) {
  const frames = page.frames();
  const names = Object.keys(values);
  for (const f of frames) {
    let ok = true;
    for (const n of names) {
      if (await f.locator(`[name="${n}"]`).count() === 0) { ok = false; break; }
    }
    if (!ok) continue;
    for (const [n, v] of Object.entries(values)) {
      const ctrl = f.locator(`[name="${n}"]`).first();
      const meta = await ctrl.evaluate(el => ({
        tag: el.tagName.toLowerCase(), type: el.getAttribute("type") || "",
      })).catch(() => ({ tag: "", type: "" }));
      if (meta.tag === "select") await ctrl.selectOption({ label: String(v) }).catch(() => ctrl.selectOption(String(v)));
      else if (meta.type === "checkbox") await ctrl.setChecked(v === true || v === "true" || v === 1);
      else await ctrl.fill(String(v));
    }
    const named = f.getByRole("button", { name: spec.form, exact: false });
    if (await named.count() > 0) await named.first().click();
    else await f.locator("button.clay-form-submit, form button").first().click();
    await page.waitForTimeout(500);
    return true;
  }
  console.log(`  (no frame had fields ${names.join(",")})`);
  return false;
}

if (kept && seed.length) {
  for (const spec of seed) {
    const rows = spec.times || [spec.fields];
    let n = 0;
    for (const r of rows) {
      try { if (await fillOnce(spec, r)) n++; }
      catch (e) { console.log(`  seed row failed: ${String(e).split("\n")[0]}`); }
    }
    console.log(`  seeded ${n} row(s) via "${spec.form}"`);
  }
  await page.waitForTimeout(Number(process.env.WAIT || 2500)); // watches refresh (+ ambient nudges)
}

await page.screenshot({ path: out, fullPage: true });
console.log("wrote", out, kept ? "(kept)" : "(no-keep)");
if (logs.length) console.log("--- console ---\n" + logs.slice(0, 20).join("\n"));
await browser.close();
