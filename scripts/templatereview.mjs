// Template audit harness (no model): for EVERY starter template, in a fresh
// browser profile — open it, inventory the panels, exercise the app like a
// user (submit each form with plausible values, confirm a Flow advance),
// and verify the writes propagate (some panel's numbers/rows change).
// Screenshots before/after + a JSON report line per template.
// Usage: node scripts/templatereview.mjs [outDir]
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const url = process.env.URL || "http://localhost:4173";
const outDir = process.argv[2] || "review";
mkdirSync(outDir, { recursive: true });

const TEMPLATES = [
  "Tracker", "Log", "Dashboard", "Small Business", "Sales CRM",
  "Bookkeeping", "Staff & Scheduling", "Habits", "Inventory", "Approvals",
  "Job Applications", "Content Calendar",
];

const VALUES = {
  text: (name) => /email/i.test(name) ? "probe@example.com"
    : /phone/i.test(name) ? "555-0199"
    : /amount|price|value|qty|stock/i.test(name) ? "42"
    : "E2E probe entry",
  number: () => "42",
  date: () => new Date(Date.now() + 86400000 * 3).toISOString().slice(0, 10),
};

const browser = await chromium.launch();

async function snapshotState(page) {
  // fingerprint of visible data: metric values + row counts + board counts
  const st = { metrics: [], rows: 0, boardCounts: [], flowCounts: [], errors: 0 };
  for (const f of page.frames()) {
    st.metrics.push(...await f.locator(".clay-metric-value").allTextContents().catch(() => []));
    st.rows += await f.locator("tbody tr").count().catch(() => 0);
    st.boardCounts.push(...await f.locator(".clay-board-count").allTextContents().catch(() => []));
    st.flowCounts.push(...await f.locator(".clay-flow-step-count").allTextContents().catch(() => []));
  }
  return st;
}

for (const name of TEMPLATES) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1400 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 120)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 120)); });

  const report = { template: name, panels: 0, forms: 0, formsSubmitted: 0,
    hasChart: false, hasBoardOrFlow: false, emptyStates: 0,
    writesPropagated: false, flowAdvanced: null, errors };
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.getByText(name, { exact: false }).first().click({ timeout: 15000 });
    await page.waitForTimeout(3800);

    report.panels = await page.locator(".panel-frame").count();
    for (const f of page.frames()) {
      report.forms += await f.locator("form.clay-form").count().catch(() => 0);
      if (await f.locator(".clay-chart svg").count().catch(() => 0)) report.hasChart = true;
      if (await f.locator(".clay-board, .clay-flow").count().catch(() => 0)) report.hasBoardOrFlow = true;
      report.emptyStates += await f.locator(".clay-empty").count().catch(() => 0);
    }
    const slug = name.toLowerCase().replace(/[^a-z]+/g, "-");
    await page.screenshot({ path: `${outDir}/${slug}-1.png`, fullPage: true });
    const before = await snapshotState(page);

    // submit every form once with plausible values
    for (const f of page.frames()) {
      const forms = await f.locator("form.clay-form").count().catch(() => 0);
      if (forms === 0) continue;
      const ctrls = f.locator("form.clay-form").first()
        .locator("input, select, textarea");
      const n = await ctrls.count();
      for (let i = 0; i < n; i++) {
        const c = ctrls.nth(i);
        const meta = await c.evaluate((el) => ({
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute("type") || "text",
          name: el.getAttribute("name") || "",
        })).catch(() => null);
        if (!meta) continue;
        try {
          if (meta.tag === "select") await c.selectOption({ index: 1 });
          else if (meta.type === "checkbox") await c.setChecked(true);
          else if (meta.type === "date") await c.fill(VALUES.date());
          else if (meta.type === "number") await c.fill(VALUES.number());
          else await c.fill(VALUES.text(meta.name));
        } catch { /* readonly/hidden */ }
      }
      try {
        await f.locator("form.clay-form").first()
          .locator("button[type=submit], button.clay-button").first().click();
        report.formsSubmitted++;
        await page.waitForTimeout(900);
      } catch { /* no submit button found */ }
    }

    // exercise a Flow advance (two-step) if present
    for (const f of page.frames()) {
      if (await f.locator(".clay-flow-advance").count().catch(() => 0)) {
        const adv = f.locator(".clay-flow-advance").first();
        const pre = (await f.locator(".clay-flow-step-count").allTextContents()).join("/");
        await adv.click(); await adv.click();
        await page.waitForTimeout(900);
        const post = (await f.locator(".clay-flow-step-count").allTextContents()).join("/");
        report.flowAdvanced = pre !== post ? `${pre} -> ${post}` : "NO CHANGE";
        break;
      }
    }

    await page.waitForTimeout(1200);
    const after = await snapshotState(page);
    report.writesPropagated =
      JSON.stringify(before.metrics) !== JSON.stringify(after.metrics)
      || before.rows !== after.rows
      || JSON.stringify(before.boardCounts) !== JSON.stringify(after.boardCounts);
    await page.screenshot({ path: `${outDir}/${slug}-2.png`, fullPage: true });
  } catch (e) {
    report.errors.push("HARNESS: " + String(e).split("\n")[0]);
  }
  console.log(JSON.stringify(report));
  await ctx.close();
}
await browser.close();
