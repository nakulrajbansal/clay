/** @vitest-environment jsdom */
import { afterEach, expect, it } from "vitest";

import { applyThemeToRoot, panelThemeCss, THEMES } from "../src/app/themes";

afterEach(() => {
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("data-theme");
});

it("keeps panel theme variables public while applying private shell variables", () => {
  const theme = THEMES.find(candidate => candidate.id === "ocean")!;

  applyThemeToRoot(theme);
  const panelCss = panelThemeCss(theme);

  expect(document.documentElement.style.getPropertyValue("--shell-accent")).toBe(theme.vars.accent);
  expect(document.documentElement.style.getPropertyValue("--accent")).toBe(theme.vars.accent);
  expect(panelCss).toContain(`--accent:${theme.vars.accent}`);
  expect(panelCss).not.toContain("--shell-accent");
});
