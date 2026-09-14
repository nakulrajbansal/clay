import { expect, it } from "vitest";
import { compareStyleWitnesses } from "./helpers/style-witnesses.mjs";
const rule = (value, selector = ".app", context = []) => ({ selector, context, declarations: [["color", value, false]] });
it("detects an interactive-state regression and refuses an unexplained selector", () => {
  const differences = compareStyleWitnesses([rule("red", ".app:hover")], [rule("blue", ".app:hover")]).differences;
  expect(differences.some(d => d.state === "engaged")).toBe(true);
  expect(differences.some(d => d.state === "rest")).toBe(false);
  expect(() => compareStyleWitnesses([rule("red", ".app:unexplained-probe")], [])).toThrow("Unsupported style witness selector");
});
it("checks overlapping breakpoints together at 320px and a 200%-text reflow witness", () => {
  const wide = rule("red", ".app", [["media", "(max-width:700px)"]]);
  const narrow = rule("blue", ".app", [["media", "(max-width:400px)"]]);
  const differences = compareStyleWitnesses([wide, narrow], [narrow, wide]).differences;
  for (const width of [320, 160]) expect(differences.some(d => d.context.startsWith(`screen:${width}:`))).toBe(true);
});
