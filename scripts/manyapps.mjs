// Stress the OPFS sahpool across many apps: each app costs 2 pool slots and
// writes take transient journal slots — without headroom management the Nth
// app dies with SQLITE_CANTOPEN ("This app didn't open"). Create N apps in
// ONE browser profile and assert every single one boots persistent.
// Usage: node scripts/manyapps.mjs [count]
import { chromium } from "playwright";

const url = process.env.URL || "http://localhost:4173";
const count = Number(process.argv[2] || 12);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

await page.goto(url, { waitUntil: "domcontentloaded" });

let failures = 0;
for (let i = 1; i <= count; i++) {
  try {
    if (i === 1) {
      await page.getByText("Start from scratch", { exact: false }).first().click({ timeout: 15000 });
    } else {
      await page.locator(".appbar-current").click({ timeout: 10000 });
      await page.getByText("+ New app", { exact: false }).click({ timeout: 5000 });
      await page.getByText("Start from scratch", { exact: false }).first().click({ timeout: 10000 });
    }
    await page.waitForTimeout(2500);
    const dead = await page.getByText("This app didn’t open", { exact: false }).count();
    const banner = await page.locator(".banner").count();
    if (dead > 0) {
      failures++;
      console.log(`app ${i}: FAILED TO OPEN`);
      await page.screenshot({ path: `manyapps-fail-${i}.png` });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2000);
    } else {
      console.log(`app ${i}: ok${banner > 0 ? " (NOT PERSISTENT!)" : ""}`);
      if (banner > 0) failures++;
    }
  } catch (e) {
    failures++;
    console.log(`app ${i}: harness error: ${e.message.split("\n")[0]}`);
    await page.screenshot({ path: `manyapps-err-${i}.png` });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
  }
}

console.log(failures === 0 ? `ALL ${count} APPS OK` : `${failures} FAILURES out of ${count}`);
if (errors.length) console.log("page errors:\n" + errors.slice(0, 10).join("\n"));
await browser.close();
process.exit(failures === 0 ? 0 : 1);
