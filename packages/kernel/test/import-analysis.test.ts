import { describe, expect, it, vi } from "vitest";
import { HeaderCandidateSchema } from "../src/import-contracts";
import { recommendHeaderCandidate } from "../src/import-analysis";

describe("Release C header recommendation", () => {
  it("C-FR-007 returns a deterministic high-confidence row and ordered reason codes", () => {
    const candidate = recommendHeaderCandidate([
      ["Name", "Amount", "Due Date"],
      ["Alice", "12.50", "2026-01-03"],
      ["Bob", "9", "2026-02-28"],
    ]);

    expect(candidate).toEqual({
      recommendedRow: 1,
      confidence: "high",
      reasons: [
        "first_non_blank_row",
        "all_labels_present",
        "labels_unique",
        "labels_textual",
        "data_shape_contrast",
      ],
    });
    expect(HeaderCandidateSchema.parse(candidate)).toEqual(candidate);
  });

  it("returns stable low-confidence reasons for blank prelude and duplicate labels", () => {
    const candidate = recommendHeaderCandidate([
      ["", ""],
      ["Name", "Name"],
      ["Alice", "Seattle"],
      ["Bob", "Boston"],
    ]);
    expect(candidate).toEqual({
      recommendedRow: 2,
      confidence: "low",
      reasons: [
        "first_non_blank_row",
        "all_labels_present",
        "duplicate_labels",
        "labels_textual",
        "no_data_shape_contrast",
      ],
    });
    expect(HeaderCandidateSchema.safeParse({ ...candidate, rawHeader: "Name" }).success)
      .toBe(false);
  });

  it("does not consult host locale services when normalizing duplicate labels", () => {
    const localeLower = vi.spyOn(String.prototype, "toLocaleLowerCase")
      .mockImplementation(() => { throw new Error("host locale must remain unreachable"); });
    try {
      expect(recommendHeaderCandidate([
        ["NAME", "name"],
        ["Alice", "Seattle"],
      ]).reasons).toContain("duplicate_labels");
    } finally {
      localeLower.mockRestore();
    }
  });

  it("returns one value-free reason when the ten-row sample is blank", () => {
    expect(recommendHeaderCandidate(Array.from({ length: 10 }, () => ["", ""])))
      .toEqual({
        recommendedRow: null,
        confidence: "none",
        reasons: ["no_non_blank_row"],
      });
  });
});
