// Drift gate: prompt assets are generated from specs/ and committed; this
// test regenerates them in-memory and compares. Prompt changes ship like
// code (doc 07 §4) — if specs move, run `pnpm --filter @clay/mutation gen`
// and let the regression gate judge the diff.
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain mjs module, typed loosely on purpose
import { buildAssets } from "../scripts/gen-assets.mjs";
import { validateMutationPlan, type Registry } from "@clay/kernel";
import {
  API_REFERENCE, COMPONENT_CONTRACTS, EXEMPLARS, HARD_RULES,
  MIGRATION_VOCAB, OUTPUT_CONTRACT, ROLE,
} from "../src/assets.gen";

describe("committed assets match a fresh generation from specs/", () => {
  const fresh = buildAssets() as {
    ROLE: string; API_REFERENCE: string; MIGRATION_VOCAB: string;
    OUTPUT_CONTRACT: string; COMPONENT_CONTRACTS: string; HARD_RULES: string;
    EXEMPLARS: { intent: string; plan: string }[];
  };
  it("sections", () => {
    expect(ROLE).toBe(fresh.ROLE);
    expect(API_REFERENCE).toBe(fresh.API_REFERENCE);
    expect(MIGRATION_VOCAB).toBe(fresh.MIGRATION_VOCAB);
    expect(OUTPUT_CONTRACT).toBe(fresh.OUTPUT_CONTRACT);
    expect(COMPONENT_CONTRACTS).toBe(fresh.COMPONENT_CONTRACTS);
    expect(HARD_RULES).toBe(fresh.HARD_RULES);
  });
  it("exemplars", () => {
    expect(EXEMPLARS).toEqual(fresh.EXEMPLARS);
    expect(EXEMPLARS).toHaveLength(10);
  });
});

// Context A (specs/exemplars/00-contexts.md) for the exemplar-10 check.
function contextA(): Registry {
  return new Map([
    ["clients", { name: "clients", columns: [
      { name: "name", type: "text" as const, required: true },
      { name: "phone", type: "text" as const, required: false },
      { name: "dog_name", type: "text" as const, required: false },
      { name: "breed", type: "text" as const, required: false },
      { name: "last_visit", type: "date" as const, required: false },
      { name: "notes", type: "text" as const, required: false },
    ] }],
    ["appointments", { name: "appointments", columns: [
      { name: "client_id", type: "text" as const, required: true },
      { name: "at", type: "date" as const, required: true },
      { name: "service", type: "enum" as const, required: false,
        values: ["bath", "full_groom", "nails"] },
      { name: "price", type: "number" as const, required: false },
      { name: "status", type: "enum" as const, required: false,
        values: ["booked", "done", "no_show"] },
    ] }],
  ]);
}

describe("the prompt's exemplar 10 is the FIXED version (its NOTE)", () => {
  it("declares the clients query and validates clean", () => {
    const plan = JSON.parse(EXEMPLARS[9]!.plan) as {
      panels: { declared_queries: { from: string }[] }[];
    };
    expect(plan.panels[0]!.declared_queries.map(q => q.from))
      .toEqual(["appointments", "clients"]);
    const issues = validateMutationPlan(plan, {
      registry: contextA(), livePanelIds: ["client_list", "upcoming"],
    });
    expect(issues).toEqual([]);
  });
});
