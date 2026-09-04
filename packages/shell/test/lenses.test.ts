import { describe, expect, it } from "vitest";
import type { LivePanel, PanelProvenance } from "@clay/kernel";
import {
  addSavedLens, applyLens, applySavedLensLayout, buildSituationalLenses,
  captureSavedLens, createSavedLensId,
  deleteSavedLens, isBuiltInLensId, isSavedLensId, loadLensId,
  loadSavedLensLibrary, renameSavedLens, saveLensId, type SavedLens,
  updateSavedLens, validateSavedLensLibrary, validateSavedLensName,
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

const SAVED_ID = "saved:550e8400-e29b-41d4-a716-446655440000" as const;
const SECOND_SAVED_ID = "saved:650e8400-e29b-41d4-a716-446655440001" as const;
const CREATED_AT = "2026-09-01T12:00:00.000Z";
const UPDATED_AT = "2026-09-01T13:00:00.000Z";

const savedLens = (overrides: Partial<SavedLens> = {}): SavedLens => ({
  id: SAVED_ID,
  name: "Client call",
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  capturedAtVersion: 7,
  panels: [{
    panelId: "work",
    createdVersion: 2,
    createdAt: CREATED_AT,
    placement: { region: "main", order: 0, w: 2 },
    filters: {},
  }],
  ...overrides,
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

  it("names the stable all lens Workspace in ordinary language", () => {
    expect(buildSituationalLenses(panels).find(lens => lens.id === "all")).toMatchObject({
      name: "Workspace", description: "Your complete workspace",
    });
  });

  it("filters panels without copying or reordering them", () => {
    expect(applyLens(panels, "review").map(item => item.panel_id))
      .toEqual(["pulse", "work"]);
    expect(applyLens(panels, "missing").map(item => item.panel_id))
      .toEqual(["pulse", "work", "capture"]);
  });

  it("captures saved layout and rejects a re-created panel incarnation", () => {
    const provenance: PanelProvenance[] = panels.map((item, index) => ({
      panel_id: item.panel_id, createdVersion: index + 1, lastChangedVersion: index + 1,
      createdAt: CREATED_AT, lastChangedAt: CREATED_AT, createdIntent: "seed",
      lastChangedIntent: "seed", createdSummary: "seed", lastChangedSummary: "seed",
    }));
    const saved = captureSavedLens({ name: "Review set", panels: panels.slice(0, 2),
      provenance, version: 7, now: CREATED_AT,
      randomUUID: () => "550e8400-e29b-41d4-a716-446655440000" });
    expect(saved.panels.map(item => item.panelId)).toEqual(["pulse", "work"]);
    const recreated = provenance.map(item => item.panel_id === "work"
      ? { ...item, createdAt: UPDATED_AT } : item);
    expect(applySavedLensLayout(panels, saved, recreated).map(item => item.panel_id))
      .toEqual(["pulse"]);
  });

  it("restores saved panel order and regions instead of current placement order", () => {
    const live = [
      { ...panel("work", "main"), placement: { region: "main" as const, order: 0 } },
      { ...panel("pulse", "top"), placement: { region: "top" as const, order: 0 } },
    ];
    const provenance: PanelProvenance[] = live.map(item => ({
      panel_id: item.panel_id, createdVersion: 2, lastChangedVersion: 2,
      createdAt: CREATED_AT, lastChangedAt: CREATED_AT, createdIntent: "seed",
      lastChangedIntent: "seed", createdSummary: "seed", lastChangedSummary: "seed",
    }));
    const saved = savedLens({ panels: [
      { panelId: "pulse", createdVersion: 2, createdAt: CREATED_AT,
        placement: { region: "main", order: 0 }, filters: {} },
      { panelId: "work", createdVersion: 2, createdAt: CREATED_AT,
        placement: { region: "main", order: 1 }, filters: {} },
    ] });
    const restored = applySavedLensLayout(live, saved, provenance);
    expect(restored.map(item => [item.panel_id, item.placement.region, item.placement.order]))
      .toEqual([["pulse", "main", 0], ["work", "main", 1]]);
  });

  it("distinguishes built-in ids from generated saved ids", () => {
    expect(isBuiltInLensId("focus")).toBe(true);
    expect(isBuiltInLensId("saved:550e8400-e29b-41d4-a716-446655440000")).toBe(false);
    expect(isSavedLensId("saved:550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(isSavedLensId("saved:focus")).toBe(false);
    expect(isSavedLensId("focus")).toBe(false);
  });

  it("loads a valid saved-lens library envelope", () => {
    const library = { format: 1 as const, revision: 3, lenses: [savedLens()] };
    expect(loadSavedLensLibrary(library)).toEqual(library);
  });

  it("falls back safely from corrupt and future library envelopes", () => {
    const corrupt = validateSavedLensLibrary("{not-json");
    const future = validateSavedLensLibrary({ format: 2, revision: 9, lenses: [] });
    expect(corrupt).toMatchObject({ status: "invalid", library: { format: 1, revision: 0, lenses: [] } });
    expect(future).toMatchObject({ status: "invalid", library: { format: 1, revision: 0, lenses: [] } });
  });

  it("quarantines an invalid lens while preserving valid siblings", () => {
    const valid = savedLens({ id: SECOND_SAVED_ID, name: "Weekly plan" });
    const result = validateSavedLensLibrary({
      format: 1,
      revision: 4,
      lenses: [savedLens({ name: " \t " }), valid],
    });
    expect(result).toMatchObject({ status: "partial", droppedLensCount: 1 });
    expect(result.library).toEqual({ format: 1, revision: 4, lenses: [valid] });
  });

  it.each<[string, () => SavedLens]>([
    ["saved id", () => savedLens({ id: "saved:not-a-uuid" as SavedLens["id"] })],
    ["overlong name", () => savedLens({ name: "😀".repeat(41) })],
    ["control character in name", () => savedLens({ name: "Client\u0000call" })],
    ["panel count", () => savedLens({ panels: Array.from({ length: 41 }, (_, index) => ({
      panelId: `panel_${index}`,
      createdVersion: 1,
      createdAt: CREATED_AT,
      placement: { region: "main", order: index % 51 },
      filters: {},
    })) })],
    ["duplicate panel id", () => savedLens({ panels: [
      savedLens().panels[0]!,
      { ...savedLens().panels[0]!, placement: { region: "side", order: 1 } },
    ] })],
    ["placement", () => savedLens({ panels: [{
      ...savedLens().panels[0]!,
      placement: { region: "main", order: 0, w: 5 },
    }] as unknown as SavedLens["panels"] })],
    ["filter control count", () => savedLens({ panels: [{
      ...savedLens().panels[0]!,
      filters: Object.fromEntries(Array.from({ length: 9 }, (_, index) => [
        `control-${index}`, { signature: `search:field_${index}`, state: {} },
      ])),
    }] })],
    ["filter field count", () => savedLens({ panels: [{
      ...savedLens().panels[0]!,
      filters: { search: {
        signature: "search:many",
        state: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`field_${index}`, "x"])),
      } },
    }] })],
    ["filter scalar length", () => savedLens({ panels: [{
      ...savedLens().panels[0]!,
      filters: { search: { signature: "search:q", state: { q: "x".repeat(513) } } },
    }] })],
    ["serialized filter size", () => savedLens({ panels: [{
      ...savedLens().panels[0]!,
      filters: { search: {
        signature: "search:large",
        state: Object.fromEntries(Array.from({ length: 32 }, (_, index) => [
          `field_${index}`, "é".repeat(512),
        ])),
      } },
    }] })],
  ])("drops a lens outside the %s bound", (_label, makeLens) => {
    const result = validateSavedLensLibrary({ format: 1, revision: 1, lenses: [makeLens()] });
    expect(result).toMatchObject({ status: "partial", droppedLensCount: 1 });
    expect(result.library.lenses).toEqual([]);
  });

  it("rejects a library envelope above the lens-count bound", () => {
    const lenses = Array.from({ length: 25 }, (_, index) => savedLens({
      id: `saved:${index.toString(16).padStart(8, "0")}-e29b-41d4-a716-446655440000`,
      name: `Lens ${index}`,
    }));
    expect(validateSavedLensLibrary({ format: 1, revision: 1, lenses }))
      .toMatchObject({ status: "invalid", library: { lenses: [] } });
  });

  it("keeps the first lens when later ids or names collide", () => {
    const first = savedLens();
    const duplicateId = savedLens({ name: "Another name" });
    const duplicateName = savedLens({ id: SECOND_SAVED_ID, name: " client CALL " });
    const result = validateSavedLensLibrary({
      format: 1, revision: 6, lenses: [first, duplicateId, duplicateName],
    });
    expect(result).toMatchObject({ status: "partial", droppedLensCount: 2 });
    expect(result.library.lenses).toEqual([first]);
  });

  it("trims an accepted display name without changing its spelling", () => {
    const result = loadSavedLensLibrary({
      format: 1, revision: 1, lenses: [savedLens({ name: "  Client Call  " })],
    });
    expect(result.lenses[0]?.name).toBe("Client Call");
  });

  it("creates saved ids from UUIDs rather than lens names", () => {
    expect(createSavedLensId(() => "750e8400-e29b-41d4-a716-446655440002"))
      .toBe("saved:750e8400-e29b-41d4-a716-446655440002");
  });

  it("validates names case-insensitively while allowing the current lens", () => {
    const library = { format: 1 as const, revision: 2, lenses: [savedLens()] };
    expect(validateSavedLensName(" client CALL ", library))
      .toMatchObject({ ok: false, code: "duplicate" });
    expect(validateSavedLensName(" client CALL ", library, SAVED_ID))
      .toEqual({ ok: true, name: "client CALL" });
  });

  it("adds a validated lens immutably and increments the revision", () => {
    const library = { format: 1 as const, revision: 0, lenses: [] };
    const lens = savedLens({ name: "  Client call  " });
    const next = addSavedLens(library, lens);
    expect(next).toEqual({
      format: 1,
      revision: 1,
      lenses: [savedLens()],
    });
    expect(library).toEqual({ format: 1, revision: 0, lenses: [] });
    expect(lens.name).toBe("  Client call  ");
  });

  it("rejects duplicate names instead of overwriting a lens", () => {
    const library = { format: 1 as const, revision: 3, lenses: [savedLens()] };
    expect(() => addSavedLens(
      library,
      savedLens({ id: SECOND_SAVED_ID, name: "CLIENT CALL" }),
    )).toThrow(/unique/i);
    expect(library).toHaveProperty("revision", 3);
  });

  it("renames a saved lens without changing its stable id or snapshot", () => {
    const original = savedLens();
    const library = { format: 1 as const, revision: 3, lenses: [original] };
    const renamed = renameSavedLens(library, SAVED_ID, "  Board review ", UPDATED_AT);
    expect(renamed.revision).toBe(4);
    expect(renamed.lenses[0]).toEqual({
      ...original,
      id: SAVED_ID,
      name: "Board review",
      updatedAt: UPDATED_AT,
    });
    expect(original).toEqual(savedLens());
  });

  it("updates a saved snapshot while preserving identity and creation time", () => {
    const original = savedLens();
    const library = { format: 1 as const, revision: 8, lenses: [original] };
    const panels = [{
      panelId: "pulse",
      createdVersion: 1,
      createdAt: CREATED_AT,
      placement: { region: "top" as const, order: 0, w: 4 as const },
      filters: {},
    }];
    const updated = updateSavedLens(library, SAVED_ID, {
      name: "Client call",
      updatedAt: UPDATED_AT,
      capturedAtVersion: 9,
      panels,
    });
    expect(updated).toEqual({
      format: 1,
      revision: 9,
      lenses: [{
        ...original,
        id: SAVED_ID,
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
        capturedAtVersion: 9,
        panels,
      }],
    });
  });

  it("deletes only saved lenses and returns the definition for undo", () => {
    const original = savedLens();
    const library = { format: 1 as const, revision: 4, lenses: [original] };
    const result = deleteSavedLens(library, SAVED_ID);
    expect(result).toEqual({
      library: { format: 1, revision: 5, lenses: [] },
      deleted: original,
    });
    expect(() => deleteSavedLens(library, "all")).toThrow(/built-in/i);
    expect(library.lenses).toEqual([original]);
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
