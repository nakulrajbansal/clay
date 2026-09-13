import { expect, it } from "vitest";
import config from "../vite.config";
import { CSS_BROWSER_TARGETS } from "../config/css-optimizer.mjs";

it("uses the existing browser baseline for JavaScript as well as CSS, retaining native private-field authority", () => {
  expect(config).toMatchObject({ build: { target: CSS_BROWSER_TARGETS.vite, cssTarget: CSS_BROWSER_TARGETS.vite } });
});
