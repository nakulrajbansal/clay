// Owned local durability journey: authenticated format 5 restores a FRESH app;
// neither the archive source nor the selected sibling may be replaced.
import { chromium } from "playwright";
import { productGateUrl } from "./product-gate-url.mjs";
import { chooseProductStarter, createProductApp, switchProductApp,
  waitForProductPanels, waitForPanelText, productChromiumOptions } from "./product-onboarding.mjs";

const url = productGateUrl();
const browser = await chromium.launch(productChromiumOptions());
const context = await browser.newContext({ viewport: { width: 1360, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on("pageerror", error => errors.push(error.message));
page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
const check = (condition, label) => {
  if (!condition) throw new Error(`FAIL ${label}`);
  console.log(`PASS ${label}`);
};
const titles = async () => (await page.locator(".panel-title-text").allTextContents()).sort();
const currentName = () => page.locator(".appbar-current").evaluate(element => element.firstChild.textContent);
const appNames = async () => {
  await page.locator(".appbar-current").click();
  const names = await page.locator(".appbar-menu > .appbar-item").evaluateAll(buttons => {
    const end = buttons.findIndex(button => button.textContent?.startsWith("Rename"));
    return buttons.slice(0, end).map(button => button.firstChild.textContent);
  });
  await page.locator(".appbar-current").click();
  return names;
};
const openSettings = async () => {
  const customize = page.getByRole("button", { name: "Customize", exact: true });
  if (await customize.getAttribute("aria-pressed") !== "true") await customize.click();
  const exportButton = page.getByRole("button", { name: "Export .clay backup" });
  if (!await exportButton.isVisible()) await page.getByRole("button", { name: /settings/i }).click();
  await exportButton.waitFor();
};
const writeDeal = async text => {
  await waitForProductPanels(page, 9);
  const form = page.locator(".panel-frame").filter({ hasText: "New deal" }).frameLocator("iframe");
  await form.getByLabel("Deal", { exact: true }).fill(text);
  await form.getByRole("button", { name: "Add deal", exact: true }).click();
  await waitForPanelText(page, text);
};
const hasPanelText = async text => {
  for (const frame of page.frames()) if (frame !== page.mainFrame()
      && (await frame.locator("body").textContent().catch(() => ""))?.includes(text)) return true;
  return false;
};

try {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await chooseProductStarter(page, "Sales CRM");
  await writeDeal("Archive source fixture");
  const sourceTitles = await titles();
  check(sourceTitles.length === 9, "source CRM has its complete shape");

  await page.getByRole("button", { name: "Open Recovery Center" }).click();
  const recovery = page.getByRole("dialog", { name: "Recovery Center", exact: true });
  const kitDownloaded = page.waitForEvent("download");
  await recovery.getByRole("button", { name: "Download Recovery Kit", exact: true }).click();
  // These files are generated only in this owned disposable context. Never read
  // or print Kit bytes, and never copy the Kit into evidence. Playwright owns and
  // removes the temporary downloads when this context closes.
  const kit = await kitDownloaded;
  await recovery.getByLabel("Check downloaded Recovery Kit", { exact: true }).setInputFiles(await kit.path());
  await recovery.getByText("Recovery Kit checked on this device.", { exact: true }).waitFor();
  await recovery.getByRole("button", { name: "Close Recovery Center" }).click();
  await openSettings();
  const archiveDownloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export .clay backup" }).click();
  const archive = await archiveDownloaded;
  const archivePath = await archive.path();
  check(archivePath !== null, "source exports an authenticated local archive");
  await page.getByText("Download record checked. Check the saved file; external storage is not verified.", { exact: true }).waitFor();

  await createProductApp(page, "Bookkeeping");
  const siblingTitles = await titles();
  check(siblingTitles.length === 6 && JSON.stringify(siblingTitles) !== JSON.stringify(sourceTitles),
    "sibling has its own independent shape");
  check((await appNames()).length === 2, "two catalog-selected apps exist before restore");
  await page.getByRole("button", { name: "Open Recovery Center" }).click();
  await recovery.getByLabel("Choose a .clay backup", { exact: true }).setInputFiles(archivePath);
  await recovery.getByRole("button", { name: "Restore as new app", exact: true }).click();
  await recovery.waitFor({ state: "detached" });
  await waitForProductPanels(page, 9);
  await waitForPanelText(page, "Archive source fixture");
  const restoredName = await currentName();
  check(restoredName !== "Sales CRM" && restoredName !== "Bookkeeping", "restore selects a fresh named destination");
  check((await appNames()).length === 3, "restore publishes exactly one new catalog entry");
  check(JSON.stringify(await titles()) === JSON.stringify(sourceTitles), "restored app preserves source panels and records");
  await writeDeal("Restored-only fixture");
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForProductPanels(page, 9);
  await waitForPanelText(page, "Restored-only fixture");
  check(await currentName() === restoredName, "fresh restored identity and new writes survive reload");

  await switchProductApp(page, "Sales CRM");
  await waitForPanelText(page, "Archive source fixture");
  check(!await hasPanelText("Restored-only fixture"), "restored writes do not cross into original source");
  await switchProductApp(page, "Bookkeeping");
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForProductPanels(page, 6);
  check(JSON.stringify(await titles()) === JSON.stringify(siblingTitles), "selected sibling is unchanged after restore and reload");
  check(!await hasPanelText("Archive source fixture"), "archive records do not cross into sibling data");
  check((await appNames()).length === 3, "reload does not duplicate the restore catalog entry");
  check(errors.length === 0, `zero page errors${errors.length ? `: ${errors.join(" | ")}` : ""}`);
  console.log("MULTI-APP ARCHIVE GATE GREEN");
} finally {
  await context.close();
  await browser.close();
}
