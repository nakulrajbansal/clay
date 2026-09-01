import { describe, expect, it } from "vitest";
import type { LivePanel } from "@clay/kernel";
import {
  applyLens, buildSituationalLenses, loadLensId, saveLensId,
} from "../src/app/lenses";

const panel = (
  id: string,
  region: "top" | "main" | "side",
  writes: string[] = [],
): LivePanel => ({
  panel_id: id,
  title: id,
  version: 1,
  placement: { region, order: 0 },
  code: "export default function () {}",
  declared_queries: [{ from: "items" }],
  declared_writes: writes,
});

describe("situational lenses", () => {
  const panels = [
    panel("pulse", "top"),
    panel("work", "main"),
    panel("capture", "side", ["items"]),
  ];

  it("derives coherent lenses over one shared panel set", () => {
    const lenses = buildSituationalLenses(panels);
    expect(lenses.map(lens => [lens.id, lens.panelIds])).toEqual([
      ["all", ["pulse", "work", "capture"]],
      ["review", ["pulse", "work"]],
      ["focus", ["work"]],
      ["update", ["capture"]],
    ]);
  });

  it("filters panels without copying or reordering them", () => {
    expect(applyLens(panels, "review").map(item => item.panel_id))
      .toEqual(["pulse", "work"]);
    expect(applyLens(panels, "missing").map(item => item.panel_id))
      .toEqual(["pulse", "work", "capture"]);
  });

  it("persists the active lens per app and rejects stale ids", () => {
    const values = new Map<string, string>();
    const storage: Pick<Storage, "getItem" | "setItem"> = {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
    };
    saveLensId(storage, "crm", "focus");
    expect(loadLensId(storage, "crm")).toBe("focus");
    values.set("clay_lens_crm", "retired");
    expect(loadLensId(storage, "crm")).toBe("all");
  });
});
