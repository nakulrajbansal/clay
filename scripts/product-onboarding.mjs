// Shared public onboarding journey for owned, empty browser contexts. This
// helper cannot assign app identity, inject state, or clear browser storage.
export function productChromiumOptions(env = process.env) {
  if (env.PLAYWRIGHT_CDP_URL) throw new Error("Product gates never attach to an existing browser");
  const channel = env.CLAY_TEST_CHROMIUM_CHANNEL;
  if (channel && !["chrome", "msedge"].includes(channel))
    throw new Error("Choose an explicitly installed chrome or msedge channel; no custom launch arguments");
  return { chromiumSandbox: true, ...(channel ? { channel } : {}) };
}

export async function chooseProductStarter(page, name) {
  await page.getByRole("heading", { name: /^(Welcome to Clay|Create another app)$/ })
    .waitFor({ timeout: 15_000 });
  if (name === undefined) {
    await page.getByRole("button", { name: /^Use a recommended starter\b/ }).click();
  } else {
    await page.getByRole("button", { name: /^See all templates\b/ }).click();
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    await page.locator("#starter-gallery").getByRole("button", {
      name: new RegExp(`^${escaped}(?:\\s|$)`),
    }).click();
  }
}

export async function waitForProductPanels(page, minimum = 1) {
  await page.waitForFunction(count => document.querySelectorAll(".panel-frame").length >= count
    && document.querySelectorAll(".panel-loading").length === 0, minimum, { timeout: 20_000 });
}

export async function createProductApp(page, starter) {
  await page.locator(".appbar-current").click();
  await page.getByRole("button", { name: "+ New app", exact: true }).click();
  await chooseProductStarter(page, starter);
  await waitForProductPanels(page);
}

export async function switchProductApp(page, name) {
  await page.locator(".appbar-current").click();
  await page.locator(".appbar-menu").getByRole("button", { name, exact: true }).click();
  await page.waitForFunction(expected => document.querySelector(".appbar-current")?.firstChild?.textContent === expected, name);
  await waitForProductPanels(page);
}

export async function waitForPanelText(page, text) {
  const deadline = Date.now() + 20_000;
  do {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      if ((await frame.locator("body").textContent().catch(() => ""))?.includes(text)) return;
    }
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);
  throw new Error("Expected durable record did not appear in a panel within 20 seconds");
}
