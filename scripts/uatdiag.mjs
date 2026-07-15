// Diagnostic: rebuild the portfolio dashboard (1 model call), fill samples via
// the shortcut, and dump the FULL build plan JSON (panel declared_queries +
// code) so we can see why some panels render empty while others show rows.
// Usage: node scripts/uatdiag.mjs
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";

const url = process.env.URL || "http://localhost:4173";
const key = readFileSync(new URL("../claude key.txt", import.meta.url), "utf8").trim();

const BUILD =
  "Create a Portfolio Dashboard for tracking projects. Each project has a name, owner, status (on track / at risk / off track / done), budget, spent, due date, key risk, and a plain-language business outcome. Show a project table, a status board, and an add-project form.";

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1300 } });
await ctx.addInitScript((k) => { try { localStorage.setItem("clay_api_key", k); } catch { /* iframe */ } }, key);
const page = await ctx.newPage();

const plans = [];
page.on("console", async (m) => {
  if (!m.text().startsWith("[clay pipeline] plan")) return;
  try {
    const arg = m.args()[1];
    if (arg) {
      const v = await arg.jsonValue();
      if (v && v.raw) plans.push(String(v.raw));
    }
  } catch { /* page gone */ }
});

await page.goto(url, { waitUntil: "domcontentloaded" });
await page.getByText("Start from scratch", { exact: false }).first().click({ timeout: 10000 });
await page.waitForTimeout(2500);

await page.getByPlaceholder("Describe a change", { exact: false }).fill(BUILD);
await page.getByRole("button", { name: "Reshape", exact: true }).click();
await page.getByRole("button", { name: "Keep", exact: true }).waitFor({ timeout: 180000 });
await page.getByRole("button", { name: "Keep", exact: true }).click();
await page.waitForTimeout(3500);

await page.getByPlaceholder("Describe a change", { exact: false }).fill("populate with some dummy data");
await page.getByRole("button", { name: "Reshape", exact: true }).click();
await page.getByText(/sample rows/i).first().waitFor({ timeout: 20000 }).catch(() => {});
await page.waitForTimeout(3000);
await page.screenshot({ path: "uatdiag-after-fill.png", fullPage: true });

// what does each panel iframe actually show?
for (const f of page.frames()) {
  const rows = await f.locator("tbody tr").count().catch(() => 0);
  const empty = await f.locator("text=/No projects yet/i").count().catch(() => 0);
  const title = await f.title().catch(() => "");
  if (rows || empty) console.log(`frame "${title}": ${rows} table rows, emptyState=${empty > 0}`);
}

if (plans.length) {
  writeFileSync("uatdiag-plan.json", plans[0]);
  console.log("wrote uatdiag-plan.json,", plans[0].length, "chars");
} else console.log("NO PLAN CAPTURED");
await browser.close();
