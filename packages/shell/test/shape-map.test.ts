import { describe, expect, it } from "vitest";
import type { LivePanel, RegTable } from "@clay/kernel";
import { buildShapeMap } from "../src/app/shape-map";

const panel = (
  id: string,
  title: string,
  reads: string[],
  writes: string[] = [],
  region: "top" | "main" | "side" = "main",
): LivePanel => ({
  panel_id: id,
  title,
  placement: { region, order: 0 },
  declared_queries: reads.map(from => ({ from })),
  declared_writes: writes,
  code: "export default function () {}",
  version: 3,
});

describe("buildShapeMap", () => {
  const tables: RegTable[] = [
    {
      name: "items",
      columns: [
        { name: "name", type: "text", required: true },
        { name: "status", type: "enum", required: false, values: ["open", "done"] },
        { name: "score", type: "computed", required: false, expr: "1" },
        { name: "legacy", type: "text", required: false, hidden: true },
      ],
    },
    {
      name: "people",
      columns: [{ name: "name", type: "text", required: true }],
    },
    {
      name: "notes",
      columns: [{ name: "body", type: "text", required: false }],
    },
  ];

  it("maps the permanent data substrate to every live projection", () => {
    const map = buildShapeMap(tables, [
      panel("board", "Work board", ["items", "items"], ["items"]),
      panel("directory", "People", ["people"], [], "side"),
      panel("scratch", "Scratchpad", []),
    ], 7);

    expect(map.stats).toEqual({
      tables: 3,
      fields: 5,
      computedFields: 1,
      panels: 3,
      connections: 2,
      versions: 7,
    });
    expect(map.links).toEqual([
      { table: "items", panelId: "board", mode: "read_write" },
      { table: "people", panelId: "directory", mode: "read" },
    ]);
    expect(map.orphanPanelIds).toEqual(["scratch"]);
  });

  it("keeps hidden fields out of the visible shape and marks unused tables", () => {
    const map = buildShapeMap(tables, [panel("board", "Work board", ["items"]),], 1);

    expect(map.tables.find(table => table.name === "items")?.fields.map(field => field.name))
      .toEqual(["name", "score", "status"]);
    expect(map.tables.find(table => table.name === "items")?.fields.find(field => field.name === "score")?.computed)
      .toBe(true);
    expect(map.tables.find(table => table.name === "notes")?.connectedPanelIds).toEqual([]);
  });

  it("sorts its public model deterministically", () => {
    const map = buildShapeMap(
      [...tables].reverse(),
      [panel("z", "Zulu", ["people"]), panel("a", "Alpha", ["items"])],
      2,
    );

    expect(map.tables.map(table => table.name)).toEqual(["items", "notes", "people"]);
    expect(map.panels.map(view => view.id)).toEqual(["a", "z"]);
  });
});
