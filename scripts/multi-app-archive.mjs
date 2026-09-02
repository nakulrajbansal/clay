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

const check = (condition, label) => {
  if (!condition) throw new Error(`FAIL ${label}`);
  console.log(`PASS ${label}`);
};
const waitForPanels = async () => {
  await page.locator(".panel-frame").first().waitFor({ timeout: 25_000 });
};
const titles = async () => page.locator(".panel-title-text").allTextContents();
const waitForTitleSet = async (expected, equal = true) => {
  await page.waitForFunction(({ expectedTitles, requireEqual }) => {
    const actual = [...document.querySelectorAll(".panel-title-text")]
      .map(node => node.textContent ?? "");
    const same = JSON.stringify(actual) === JSON.stringify(expectedTitles);
    return actual.length > 0 && (requireEqual ? same : !same);
  }, { expectedTitles: expected, requireEqual: equal }, { timeout: 25_000 });
};
const openSettings = async () => {
  const exportButton = page.getByRole("button", { name: "Export .clay backup" });
  if (!(await exportButton.isVisible().catch(() => false)))
    await page.getByRole("button", { name: /settings/i }).click();
  await exportButton.waitFor();
};

await page.goto(url, { waitUntil: "domcontentloaded" });
await page.getByText("Sales CRM", { exact: true }).click({ timeout: 15_000 });
await waitForPanels();
const sourceTitles = await titles();

await openSettings();
const downloadPromise = page.waitForEvent("download");
await page.getByRole("button", { name: "Export .clay backup" }).click();
const download = await downloadPromise;
const backupPath = await download.path();
check(backupPath !== null, "the source app exports a local backup");

await page.getByRole("button", { name: /Sales CRM/ }).first().click();
await page.getByRole("button", { name: "+ New app" }).click();
await page.getByText("Bookkeeping", { exact: true }).click();
await waitForTitleSet(sourceTitles, false);
const targetTitlesBefore = await titles();
check(JSON.stringify(targetTitlesBefore) !== JSON.stringify(sourceTitles),
  "the second app starts with its own independent shape");

await openSettings();
const importInput = page.locator('input[type="file"][accept*=".clay"]');
await importInput.setInputFiles(backupPath);
const replaceDialog = page.getByRole("alertdialog");
await replaceDialog.waitFor();
const reloaded = page.waitForEvent("framenavigated");
await replaceDialog.getByRole("button", { name: "Confirm" }).click();
await reloaded;
await waitForTitleSet(sourceTitles);
check(JSON.stringify(await titles()) === JSON.stringify(sourceTitles),
  "import replaces the currently open app with the validated archive");
check(await page.getByRole("button", { name: /Bookkeeping/ }).first().count() === 1,
  "archive replacement keeps the current app identity");

await page.getByRole("button", { name: /Bookkeeping/ }).first().click();
const sourceReloaded = page.waitForEvent("framenavigated");
await page.getByRole("button", { name: "Sales CRM", exact: true }).click();
await sourceReloaded;
await waitForTitleSet(sourceTitles);
check(JSON.stringify(await titles()) === JSON.stringify(sourceTitles),
  "the source app remains intact after replacing its sibling");
check(errors.length === 0, `zero page errors${errors.length ? `: ${errors.join(" | ")}` : ""}`);

await browser.close();
console.log("MULTI-APP ARCHIVE GATE GREEN");
