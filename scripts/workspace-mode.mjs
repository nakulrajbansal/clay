import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import {
  isExpectedProductGateRequest, monitorProductGatePage,
  productGateBuildDigest, productGateBuildEntry, productGateUrl,
} from "./product-gate-url.mjs";

const url = productGateUrl();
const outDir = process.argv[2] || "evidence/workspace-mode";
const distRoot = new URL("../packages/shell/dist/", import.meta.url);
async function listLocalBuildFiles(root, prefix = "") {
  const entries = await readdir(new URL(prefix || "./", root), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) files.push(...await listLocalBuildFiles(root, `${relative}/`));
    else if (entry.isFile()) files.push(relative);
  }
  return files.sort();
}
const localManifest = JSON.parse(await readFile(
  new URL(".vite/manifest.json", distRoot), "utf8",
));
const expectedBuildEntry = productGateBuildEntry(localManifest);
const localBuildPaths = await listLocalBuildFiles(distRoot);
const localAssets = await Promise.all(localBuildPaths.map(async path => {
  const bytes = await readFile(new URL(path, distRoot));
  return { path, size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
}));
const expectedBuildDigest = productGateBuildDigest(localManifest, localAssets);
await mkdir(outDir, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
await context.addInitScript(() => {
  try {
    const app = { id: "workspace-mode-proof", name: "Sales CRM", shellId: "crm" };
    if (!sessionStorage.getItem("clay_workspace_mode_proof_initialized")) {
      localStorage.setItem("clay_apps", JSON.stringify([app]));
      localStorage.setItem("clay_current_app", app.id);
      localStorage.removeItem(`clay_workspace_mode:${encodeURIComponent(app.id)}`);
      sessionStorage.setItem("clay_workspace_mode_proof_initialized", "true");
    }
  } catch { /* sandboxed panel frames have intentionally opaque origins */ }
});
const page = await context.newPage();
const assertCurrentOrigin = monitorProductGatePage(page, url);
const failures = [];
const consoleErrors = [];
const externalRequests = [];
const layouts = {};
page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("pageerror", error => consoleErrors.push(error.message));
page.on("request", request => {
  const requestUrl = new URL(request.url());
  if (["http:", "https:"].includes(requestUrl.protocol)
      && !isExpectedProductGateRequest(url, request.url())) externalRequests.push(request.url());
});
const check = (condition, label) => { if (!condition) failures.push(label); };
const absent = async label => (await page.getByRole("button", { name: label, exact: true }).count()) === 0;
const present = async label => (await page.getByRole("button", { name: label, exact: true }).count()) === 1;
const waitSelected = async label => {
  await page.locator(".appbar-mode-button.active", { hasText: label }).waitFor();
};
const measureLayout = async () => page.evaluate(() => {
  const header = document.querySelector(".appbar")?.getBoundingClientRect();
  const mode = document.querySelector(".appbar-mode")?.getBoundingClientRect();
  return {
    viewportWidth: document.documentElement.clientWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    headerScrollWidth: document.querySelector(".appbar")?.scrollWidth ?? 0,
    headerClientWidth: document.querySelector(".appbar")?.clientWidth ?? 0,
    modeInsideHeader: Boolean(header && mode && mode.left >= header.left && mode.right <= header.right
      && mode.top >= header.top && mode.bottom <= header.bottom),
  };
});

await page.goto(url, { waitUntil: "domcontentloaded" });
assertCurrentOrigin();
try {
  await page.getByRole("button", { name: "Work", exact: true }).waitFor();
} catch (error) {
  console.error(JSON.stringify({ currentUrl: page.url(), body: (await page.locator("body").innerText()).slice(0, 2000), consoleErrors }));
  await browser.close();
  throw error;
}
await page.locator(".panel-frame").first().waitFor();
await page.waitForFunction(() => document.querySelectorAll(".panel-frame").length > 0
  && document.querySelectorAll(".panel-loading").length === 0);
check(await page.getByRole("button", { name: "Work", exact: true }).getAttribute("aria-pressed") === "true", "Work is not selected by default");
for (const label of ["Open automations", "Open data", "Open shape map", "Choose color scheme"])
  check(await absent(label), `${label} is exposed in Work`);
check(await page.locator('button[aria-label$="reshape"]').count() === 0, "reshape toggle is exposed in Work");
check(await page.locator('button[aria-label^="Reshape "]').count() === 0, "panel reshape is exposed in Work");
check(await page.locator('button[aria-label^="Why "]').count() === 0, "panel provenance is exposed in Work");
check(await page.locator(".rail").count() === 0, "reshape rail is exposed in Work");
layouts.work = await measureLayout();
check(layouts.work.modeInsideHeader, "Work mode control is clipped by the header");
check(layouts.work.documentScrollWidth <= layouts.work.viewportWidth, "Work has horizontal page overflow");
await page.screenshot({ path: `${outDir}/work.png`, fullPage: true });

await page.getByRole("button", { name: "Customize", exact: true }).click();
check(await page.getByRole("button", { name: "Customize", exact: true }).getAttribute("aria-pressed") === "true", "Customize did not activate");
for (const label of ["Open automations", "Open data", "Open shape map", "Choose color scheme"])
  check(await present(label), `${label} is missing in Customize`);
check(await page.locator('button[aria-label$="reshape"]').count() === 1, "reshape toggle is missing in Customize");
check(await page.locator('button[aria-label^="Reshape "]').count() > 0, "panel reshape is missing in Customize");
check(await page.locator('button[aria-label^="Why "]').count() > 0, "panel provenance is missing in Customize");
check(await page.locator(".rail").count() === 1, "reshape rail is missing in Customize");
layouts.customize = await measureLayout();
check(layouts.customize.modeInsideHeader, "Customize mode control is clipped by the header");
check(layouts.customize.headerScrollWidth <= layouts.customize.headerClientWidth, "Customize header overflows");
await page.screenshot({ path: `${outDir}/customize.png`, fullPage: true });

await page.setViewportSize({ width: 390, height: 844 });
layouts.customizePhone = await measureLayout();
for (const label of ["Open automations", "Open data", "Open shape map", "Choose color scheme"]) {
  const control = page.getByRole("button", { name: label, exact: true });
  check(await control.isVisible(), `${label} is unreachable in phone Customize`);
  await control.focus();
  check(await control.evaluate(element => element === document.activeElement),
    `${label} is not keyboard-focusable in phone Customize`);
}
const phoneReshape = page.locator('button[aria-label$="reshape"]');
check(await phoneReshape.isVisible(), "reshape toggle is unreachable in phone Customize");
await phoneReshape.focus();
check(await phoneReshape.evaluate(element => element === document.activeElement),
  "reshape toggle is not keyboard-focusable in phone Customize");
check(layouts.customizePhone.headerScrollWidth <= layouts.customizePhone.headerClientWidth,
  "phone Customize header overflows");
check(layouts.customizePhone.documentScrollWidth <= layouts.customizePhone.viewportWidth,
  "phone Customize has horizontal page overflow");
await page.screenshot({ path: `${outDir}/customize-phone.png`, fullPage: true });
await page.setViewportSize({ width: 1440, height: 1000 });

await page.reload({ waitUntil: "domcontentloaded" });
assertCurrentOrigin();
await waitSelected("Customize");
check(await present("Open automations"), "Customize preference did not survive reload");

await page.evaluate(() => {
  const apps = JSON.parse(localStorage.getItem("clay_apps") ?? "[]");
  apps.push({ id: "workspace-mode-proof-b", name: "Second CRM", shellId: "crm" });
  localStorage.setItem("clay_apps", JSON.stringify(apps));
  localStorage.setItem("clay_current_app", "workspace-mode-proof-b");
});
await page.reload({ waitUntil: "domcontentloaded" });
assertCurrentOrigin();
await waitSelected("Work");
check(await absent("Open automations"), "Customize leaked into a second app");

await page.evaluate(() => localStorage.setItem("clay_current_app", "workspace-mode-proof"));
await page.reload({ waitUntil: "domcontentloaded" });
assertCurrentOrigin();
await waitSelected("Customize");
check(await present("Open automations"), "first app lost its Customize preference");
await page.getByRole("button", { name: "Work", exact: true }).click();
await waitSelected("Work");
const axe = await new AxeBuilder({ page }).include(".appbar-mode").analyze();
await page.setViewportSize({ width: 720, height: 900 });
layouts.workCompact = await measureLayout();
check(layouts.workCompact.modeInsideHeader, "compact Work mode control is clipped");
check(layouts.workCompact.documentScrollWidth <= layouts.workCompact.viewportWidth, "compact Work has horizontal overflow");
await page.screenshot({ path: `${outDir}/work-compact.png`, fullPage: true });
check(axe.violations.length === 0, `accessibility violations: ${axe.violations.map(item => item.id).join(",")}`);
check(consoleErrors.length === 0, `console errors: ${consoleErrors.join(" | ")}`);
check(externalRequests.length === 0, `external requests: ${externalRequests.join(" | ")}`);
assertCurrentOrigin();
const servedManifest = await page.evaluate(async () =>
  (await (await fetch("/.vite/manifest.json", { cache: "no-store" })).json()));
const buildEntry = productGateBuildEntry(servedManifest);
if (buildEntry !== expectedBuildEntry)
  throw new Error(`served build entry ${buildEntry} does not match local build ${expectedBuildEntry}`);
const servedAssets = await page.evaluate(async paths => Promise.all(paths.map(async path => {
  const response = await fetch(`/${path}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`served asset ${path} returned ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return {
    path,
    size: bytes.byteLength,
    sha256: [...digest].map(value => value.toString(16).padStart(2, "0")).join(""),
  };
})), localBuildPaths);
assertCurrentOrigin();
const buildDigest = productGateBuildDigest(servedManifest, servedAssets);
if (buildDigest !== expectedBuildDigest)
  throw new Error(`served build digest ${buildDigest} does not match local build ${expectedBuildDigest}`);
check(externalRequests.length === 0,
  `unexpected requests during build verification: ${externalRequests.join(" | ")}`);
const screenshots = [`${outDir}/work.png`, `${outDir}/customize.png`, `${outDir}/customize-phone.png`,
  `${outDir}/work-compact.png`];
const screenshotSha256 = Object.fromEntries(await Promise.all(screenshots.map(async file => [
  file, createHash("sha256").update(await readFile(file)).digest("hex"),
])));
assertCurrentOrigin();
const report = { url, finalUrl: page.url(), buildEntry, expectedBuildEntry,
  buildDigest, expectedBuildDigest, assetCount: servedAssets.length,
  failures, consoleErrors, externalRequests,
  axeViolations: axe.violations.length, layouts, screenshots, screenshotSha256 };
await writeFile(`${outDir}/report.json`, JSON.stringify(report, null, 2));
await browser.close();
console.log(JSON.stringify(report));
if (failures.length) process.exit(1);
