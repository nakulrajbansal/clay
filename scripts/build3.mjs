// Build 3 brand-new apps live (model), then use each like a person:
// dummy-fill, exercise interactions, apply a follow-up reshape, and report
// everything observable (repairs, boundaries, console errors, live panels).
// Usage: node scripts/build3.mjs [outDir]
import { chromium } from "playwright";
import { mkdirSync, readFileSync } from "node:fs";

const url = process.env.URL || "http://localhost:4173";
const outDir = process.argv[2] || "build3";
mkdirSync(outDir, { recursive: true });
const key = readFileSync(new URL("../claude key.txt", import.meta.url), "utf8").trim();

const APPS = [
  {
    slug: "okr",
    build: "Build an OKR tracker. Objectives have a title, owner, quarter (Q1–Q4), "
      + "and status (draft, active, done). Key results belong to an objective (by its title), "
      + "with a metric name, target number, current number, and a progress view. "
      + "Show objectives with their status, key results with visual progress toward target, "
      + "a summary strip, and forms to add both.",
    edit: "Add a panel highlighting key results under 50% progress, called 'At risk'.",
  },
  {
    slug: "eventplan",
    build: "Build an event planner for a 2-day conference. Sessions have a title, speaker, "
      + "room, day (date), start time, and status (proposed, confirmed, cancelled). "
      + "Show a calendar of sessions by day, a timeline, a sessions table, "
      + "a status workflow, and an add-session form.",
    edit: "Add a per-room count summary at the top.",
  },
  {
    slug: "library",
    build: "Build a personal book library. Books have a title, author, genre "
      + "(fiction, non-fiction, sci-fi, biography), status (to-read, reading, finished), "
      + "rating (1-5), and finished date. Show a searchable, filterable list of books "
      + "(search by title, filter by genre and status), a reading workflow, "
      + "a ratings chart, and an add-book form.",
    edit: "Add a 'currently reading' spotlight panel showing only books I'm reading now.",
  },
];

const browser = await chromium.launch();

async function reshape(page, text, label, report) {
  await page.getByPlaceholder("Describe a change", { exact: false }).fill(text);
  await page.getByRole("button", { name: "Reshape", exact: true }).click();
  try {
    await page.getByRole("button", { name: "Keep", exact: true }).waitFor({ timeout: 200000 });
    await page.getByRole("button", { name: "Keep", exact: true }).click();
    await page.waitForTimeout(3500);
    report.steps.push(`${label}: KEPT`);
    return true;
  } catch {
    const failCard = await page.locator(".rail-failure, [class*=failure]").first()
      .textContent().catch(() => "");
    report.steps.push(`${label}: NO PREVIEW ${failCard ? "— " + failCard.slice(0, 200) : ""}`);
    return false;
  }
}

async function inventory(page) {
  const inv = { panels: 0, boundaries: 0, emptyStates: 0, flows: 0, charts: 0,
    tables: 0, forms: 0, calendars: 0, timelines: 0, bars: 0, filters: 0, metrics: 0 };
  inv.panels = await page.locator(".panel-frame").count();
  inv.boundaries = await page.locator(".panel-boundary").count();
  for (const f of page.frames()) {
    const c = async (sel) => f.locator(sel).count().catch(() => 0);
    inv.emptyStates += await c(".clay-empty");
    inv.flows += await c(".clay-flow-rail");
    inv.charts += await c(".clay-chart svg");
    inv.tables += await c("table.clay-table");
    inv.forms += await c("form.clay-form");
    inv.calendars += await c(".clay-cal-grid");
    inv.timelines += await c(".clay-timeline");
    inv.bars += await c(".clay-bar-track");
    inv.filters += await c(".clay-filterbar");
    inv.metrics += await c(".clay-metric");
  }
  return inv;
}

for (const app of APPS) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1500 } });
  await ctx.addInitScript((k) => { try { localStorage.setItem("clay_api_key", k); } catch { /* iframe */ } }, key);
  const page = await ctx.newPage();
  const report = { app: app.slug, steps: [], errors: [], repairs: 0, outcomes: [] };
  page.on("pageerror", (e) => report.errors.push(String(e.message).slice(0, 140)));
  page.on("console", async (m) => {
    if (m.type() === "error") report.errors.push(m.text().slice(0, 140));
    if (m.text().startsWith("[clay pipeline] outcome")) {
      try {
        const v = await m.args()[1].jsonValue();
        report.outcomes.push(`${v.status}${v.repaired ? " (repaired)" : ""}`);
        if (v.repaired) report.repairs++;
      } catch { /* page gone */ }
    }
  });

  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.getByText("Start from scratch", { exact: false }).first().click({ timeout: 10000 });
    await page.waitForTimeout(2500);
    await reshape(page, app.build, "build", report);

    // dummy data through the trusted shortcut
    await page.getByPlaceholder("Describe a change", { exact: false }).fill("populate with some dummy data");
    await page.getByRole("button", { name: "Reshape", exact: true }).click();
    await page.getByText(/Filled your tables with \d+ sample rows/i).first()
      .waitFor({ timeout: 20000 }).catch(() => report.steps.push("fill: shortcut message not seen"));
    await page.waitForTimeout(2500);
    report.afterFill = await inventory(page);
    await page.screenshot({ path: `${outDir}/${app.slug}-1-filled.png`, fullPage: true });

    // exercise: flow advance if present; search box if present
    for (const f of page.frames()) {
      if (await f.locator(".clay-flow-advance").count().catch(() => 0)) {
        const adv = f.locator(".clay-flow-advance").first();
        await adv.click(); await adv.click();
        await page.waitForTimeout(900);
        report.steps.push("flow: advanced one item");
        break;
      }
    }

    // follow-up reshape on the living app
    await reshape(page, app.edit, "edit", report);
    report.final = await inventory(page);
    await page.screenshot({ path: `${outDir}/${app.slug}-2-final.png`, fullPage: true });
  } catch (e) {
    report.steps.push("HARNESS: " + String(e).split("\n")[0]);
  }
  console.log(JSON.stringify(report));
  await ctx.close();
}
await browser.close();
