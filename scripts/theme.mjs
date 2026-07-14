// Screenshot a chosen color scheme. Usage: node scripts/theme.mjs <ThemeName> <out>
import { chromium } from "playwright";
const url = process.env.URL || "http://localhost:4173";
const themeName = process.argv[2] || "Midnight";
const out = process.argv[3] || "theme.png";
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1024 } })).newPage();
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.getByText("Sales CRM", { exact: false }).first().click({ timeout: 8000 });
await page.waitForTimeout(4500);
// settings starts open when no key is set — pick the theme, then close it
await page.getByRole("button", { name: themeName, exact: false }).first().click();
await page.waitForTimeout(400);
await page.getByRole("button", { name: "settings", exact: true }).click();   // close settings
await page.waitForTimeout(2500);   // panels reload with theme
await page.screenshot({ path: out, fullPage: true });
console.log("wrote", out, "theme:", themeName);
await browser.close();
