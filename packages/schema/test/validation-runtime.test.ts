import { describe, expect, it } from "vitest";
import { z as library } from "zod";
import { z } from "../src/validation-runtime";

describe("shared validation factories", () => {
  it("keeps the exact installed validators and error behavior", () => {
    expect(Object.isFrozen(z)).toBe(true);
    for (const name of Object.keys(z) as (keyof typeof z)[]) expect(z[name]).toBe(library[name]);
    const make = (api: typeof z) => api.object({ kind: api.literal("owned"),
      entries: api.array(api.string().trim().min(1).max(8)).min(1).max(3),
      count: api.number().int().nonnegative().safe(),
    }).strict().superRefine((value, ctx) => {
      if (value.entries.length !== value.count) ctx.addIssue({ code: "custom", message: "unbalanced" });
    });
    for (const value of [undefined, null, {}, { kind: "copied", entries: ["a"], count: 1 },
      { kind: "owned", entries: [" a "], count: 1 }, { kind: "owned", entries: ["a"], count: 0 },
      { kind: "owned", entries: ["a"], count: 1, extra: true },
      { kind: "owned", entries: ["a"], count: NaN }]) {
      const left = make(z).safeParse(value), right = make(library).safeParse(value);
      expect(left.success).toBe(right.success);
      expect(left.success ? left.data : left.error.issues).toEqual(right.success ? right.data : right.error.issues);
    }
  });
});
