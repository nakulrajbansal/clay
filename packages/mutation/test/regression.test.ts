// The regression suite's structure and scoring, tested offline. The live
// model run (runRegressionSuite) is exercised by `pnpm regression` with a
// key; here we prove the archetype stores build, the case list matches the
// spec, and the gate scores correctly.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateMutationPlan } from "@clay/kernel";
import {
  ARCHETYPE_STORES, REGRESSION_CASES, scoreGate, type CaseOutcome,
} from "../src/index";

describe("suite definition", () => {
  it("has 20 core + 5 clarify + 5 adversarial", () => {
    expect(REGRESSION_CASES).toHaveLength(30);
    expect(REGRESSION_CASES.filter(c => c.expect === "commit")).toHaveLength(20);
    expect(REGRESSION_CASES.filter(c => c.expect === "clarify")).toHaveLength(5);
    expect(REGRESSION_CASES.filter(c => c.expect === "safe")).toHaveLength(5);
  });

  it("covers the same ids as specs/tests/regression-intents.md", () => {
    const md = readFileSync(fileURLToPath(
      new URL("../../../specs/tests/regression-intents.md", import.meta.url)), "utf8");
    for (const c of REGRESSION_CASES) {
      // core "1 " / clarify "C1 " / adversarial "21 " appear as list markers
      const marker = new RegExp(`(^|\\n)${c.id}\\s`, "m");
      expect(marker.test(md), `intent ${c.id} missing from spec`).toBe(true);
    }
  });
});

describe("archetype stores are real, seeded, and panel-valid", () => {
  it.each(["A", "B", "C"] as const)("context %s", async (key) => {
    const store = await ARCHETYPE_STORES[key]();
    expect(store.headVersion()).toBe(1);
    const panels = store.livePanels();
    expect(panels.length).toBeGreaterThan(0);
    // the seed panels validate against their own registry
    for (const p of panels) {
      const issues = validateMutationPlan({
        api: 1, summary: "seed", user_facing_diff: [{ kind: "add_panel", detail: p.panel_id }],
        clarifying_question: null, assumptions: [], migration: null,
        panels: [{
          panel_id: p.panel_id, title: p.title, placement: p.placement,
          code: p.code, declared_queries: p.declared_queries,
          declared_writes: p.declared_writes,
        }], remove_panels: [], confidence: 1,
      }, { registry: store.registrySnapshot(), livePanelIds: [] });
      expect(issues).toEqual([]);
    }
    store.close();
  });
});

describe("gate scoring (doc 08 §4)", () => {
  const mk = (firstPass: number, clarify: number, safe: number): boolean =>
    scoreGate({ outcomes: [] as CaseOutcome[],
      firstPassCommitRate: firstPass, clarifyHits: clarify, adversarialSafe: safe });

  it("passes at exactly the thresholds", () => {
    expect(mk(0.9, 4, 5)).toBe(true);
    expect(mk(1.0, 5, 5)).toBe(true);
  });
  it("fails below any threshold", () => {
    expect(mk(0.85, 5, 5)).toBe(false);   // commit rate too low
    expect(mk(0.95, 3, 5)).toBe(false);   // clarify too low
    expect(mk(0.95, 5, 4)).toBe(false);   // an adversarial intent slipped
  });
});
