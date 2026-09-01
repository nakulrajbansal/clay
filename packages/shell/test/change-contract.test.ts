import { describe, expect, it } from "vitest";
import type { PreviewInfo } from "../src/worker/db-worker";
import { buildChangeContract, buildTrustReceipt } from "../src/app/change-contract";

const preview: PreviewInfo = {
  summary: "Add an owner rollup and attention view",
  diff: [
    { kind: "add_field", detail: "Add owner to deals" },
    { kind: "add_panel", detail: "Add Needs attention" },
  ],
  panels: [
    {
      panel_id: "attention",
      title: "Needs attention",
      placement: { region: "top", order: 0 },
      code: "export default function () {}",
      declared_queries: [{ from: "deals", select: ["name"] }, { from: "people" }],
      declared_writes: ["deals", "deals"],
      version: 4,
    },
    {
      panel_id: "note",
      title: "Read me",
      placement: { region: "side", order: 1 },
      code: "export default function () {}",
      declared_queries: [],
      declared_writes: [],
      version: 4,
    },
  ],
  removePanels: ["old-summary"],
  version: 4,
  repaired: true,
};

describe("buildChangeContract", () => {
  it("summarizes the validated preview without overstating its data access", () => {
    const contract = buildChangeContract(preview);

    expect(contract.version).toBe(4);
    expect(contract.changes).toEqual(preview.diff);
    expect(contract.dataAccess).toEqual([
      { table: "deals", mode: "read_write" },
      { table: "people", mode: "read" },
    ]);
    expect(contract.changedViews).toEqual([
      { id: "attention", title: "Needs attention", access: "read_write" },
      { id: "note", title: "Read me", access: "none" },
    ]);
    expect(contract.removedPanelIds).toEqual(["old-summary"]);
  });

  it("surfaces the guarantees proven before a PreviewInfo exists", () => {
    const contract = buildChangeContract(preview);
    expect(contract.guarantees.map(item => item.id)).toEqual([
      "shadow", "reversible", "rows", "preview",
    ]);
    expect(contract.guarantees.every(guarantee => guarantee.proven)).toBe(true);
    expect(contract.repaired).toBe(true);
  });

  it("is deterministic regardless of query and panel order", () => {
    const reversed: PreviewInfo = {
      ...preview,
      panels: [...preview.panels].reverse().map(panel => ({
        ...panel,
        declared_queries: [...panel.declared_queries].reverse(),
      })),
    };
    expect(buildChangeContract(reversed)).toEqual(buildChangeContract(preview));
  });

  it("turns a kept preview into an exact, rewindable trust receipt", () => {
    const receipt = buildTrustReceipt(preview, 4);
    expect(receipt).toMatchObject({
      version: 4,
      rewindTo: 3,
      summary: preview.summary,
      repaired: true,
    });
    expect(receipt.changes).toEqual(preview.diff);
    expect(receipt.dataAccess).toEqual([
      { table: "deals", mode: "read_write" },
      { table: "people", mode: "read" },
    ]);
    expect(receipt.affectedViews.map(view => view.title))
      .toEqual(["Needs attention", "Read me"]);
  });
});
