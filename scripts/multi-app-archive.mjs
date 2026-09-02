// Ordinary multi-app durability gate: replacing one app from a validated
// backup must target that app only and leave every sibling app untouched.
import { chromium } from "playwright";

const url = process.env.URL || "http://127.0.0.1:4173";
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on("pageerror", error => errors.push(error.message));
page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });

const EXPECTED_CRM_TITLES = [
  "Pipeline at a glance", "Follow-ups", "Pipeline · drag a deal between stages",
  "All deals", "Pipeline by stage", "Recent activity", "Contacts", "New deal",
  "New follow-up",
];
const EXPECTED_BOOKKEEPING_TITLES = [
  "This month", "Spending by category", "Transactions",
  "Invoices by status · drag to update", "Unpaid bills", "Record transaction",
];

const check = (condition, label) => {
  if (!condition) throw new Error(`FAIL ${label}`);
  console.log(`PASS ${label}`);
};
const titles = async () => page.locator(".panel-title-text").allTextContents();
const canonicalTitles = values => [...values].sort();
const waitForTitleSet = async expected => {
  const canonicalExpected = canonicalTitles(expected);
  try {
    await page.waitForFunction(expectedTitles => {
      const actual = [...document.querySelectorAll(".panel-title-text")]
        .map(node => node.textContent ?? "").sort();
      return JSON.stringify(actual) === JSON.stringify(expectedTitles);
    }, canonicalExpected, { timeout: 25_000 });
  } catch (error) {
    throw new Error(`Timed out waiting for panel titles. expected=${JSON.stringify(expected)} `
      + `actual=${JSON.stringify(await titles())} pageErrors=${JSON.stringify(errors)}`,
    { cause: error });
  }
};
const openSettings = async () => {
  const exportButton = page.getByRole("button", { name: "Export .clay backup" });
  if (!(await exportButton.isVisible().catch(() => false)))
    await page.getByRole("button", { name: /settings/i }).click();
  await exportButton.waitFor();
};

await page.goto(url, { waitUntil: "domcontentloaded" });
await page.getByText("Sales CRM", { exact: true }).click({ timeout: 15_000 });
await waitForTitleSet(EXPECTED_CRM_TITLES);
const sourceTitles = canonicalTitles(await titles());

await openSettings();
const downloadPromise = page.waitForEvent("download");
await page.getByRole("button", { name: "Export .clay backup" }).click();
const download = await downloadPromise;
const backupPath = await download.path();
check(backupPath !== null, "the source app exports a local backup");

await page.getByRole("button", { name: /Sales CRM/ }).first().click();
await page.getByRole("button", { name: "+ New app" }).click();
const targetCreated = page.waitForEvent("framenavigated", frame => frame === page.mainFrame());
await page.getByText("Bookkeeping", { exact: true }).click();
await targetCreated;
await waitForTitleSet(EXPECTED_BOOKKEEPING_TITLES);
const targetTitlesBefore = canonicalTitles(await titles());
check(JSON.stringify(targetTitlesBefore) === JSON.stringify(canonicalTitles(EXPECTED_BOOKKEEPING_TITLES)),
  "the second app starts with its own independent shape");

await openSettings();
const importInput = page.locator('input[type="file"][accept*=".clay"]');
await importInput.setInputFiles(backupPath);
const replaceDialog = page.getByRole("alertdialog");
await replaceDialog.waitFor();
const reloaded = page.waitForEvent("framenavigated", frame => frame === page.mainFrame());
await replaceDialog.getByRole("button", { name: "Confirm" }).click();
await reloaded;
await waitForTitleSet(sourceTitles);
check(JSON.stringify(canonicalTitles(await titles())) === JSON.stringify(sourceTitles),
  "import replaces the currently open app with the validated archive");
check(await page.getByRole("button", { name: /Bookkeeping/ }).first().count() === 1,
  "archive replacement keeps the current app identity");

await page.getByRole("button", { name: /Bookkeeping/ }).first().click();
const sourceReloaded = page.waitForEvent("framenavigated", frame => frame === page.mainFrame());
await page.getByRole("button", { name: "Sales CRM", exact: true }).click();
await sourceReloaded;
await waitForTitleSet(sourceTitles);
check(JSON.stringify(canonicalTitles(await titles())) === JSON.stringify(sourceTitles),
  "the source app remains intact after replacing its sibling");
check(errors.length === 0, `zero page errors${errors.length ? `: ${errors.join(" | ")}` : ""}`);

await browser.close();
console.log("MULTI-APP ARCHIVE GATE GREEN");
