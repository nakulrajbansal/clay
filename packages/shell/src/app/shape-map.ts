import type { LivePanel, RegTable } from "@clay/kernel";

export type ShapeField = {
  name: string;
  type: string;
  computed: boolean;
  required: boolean;
};

export type ShapeTable = {
  name: string;
  fields: ShapeField[];
  connectedPanelIds: string[];
};

export type ShapePanel = {
  id: string;
  title: string;
  region: "top" | "main" | "side";
  reads: string[];
  writes: string[];
};

export type ShapeLink = {
  table: string;
  panelId: string;
  mode: "read" | "write" | "read_write";
};

export type ShapeMap = {
  tables: ShapeTable[];
  panels: ShapePanel[];
  links: ShapeLink[];
  orphanPanelIds: string[];
  stats: {
    tables: number;
    fields: number;
    computedFields: number;
    panels: number;
    connections: number;
    versions: number;
  };
};

const uniqueSorted = (values: Iterable<string>): string[] =>
  [...new Set(values)].sort((a, b) => a.localeCompare(b));

/**
 * Builds the trusted, read-only model behind the Shape Map. The map exposes
 * how the permanent registry feeds each live panel without inspecting or
 * executing generated panel code.
 */
export function buildShapeMap(
  registryTables: RegTable[],
  livePanels: LivePanel[],
  versions: number,
): ShapeMap {
  const panels: ShapePanel[] = livePanels
    .map(panel => ({
      id: panel.panel_id,
      title: panel.title,
      region: panel.placement.region,
      reads: uniqueSorted(panel.declared_queries.map(query => query.from)),
      writes: uniqueSorted(panel.declared_writes),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const links: ShapeLink[] = [];
  for (const panel of panels) {
    const names = uniqueSorted([...panel.reads, ...panel.writes]);
    for (const table of names) {
      const reads = panel.reads.includes(table);
      const writes = panel.writes.includes(table);
      links.push({
        table,
        panelId: panel.id,
        mode: reads && writes ? "read_write" : writes ? "write" : "read",
      });
    }
  }
  links.sort((a, b) =>
    a.table.localeCompare(b.table) || a.panelId.localeCompare(b.panelId));

  const tables: ShapeTable[] = registryTables
    .map(table => ({
      name: table.name,
      fields: table.columns
        .filter(column => !column.hidden)
        .map(column => ({
          name: column.name,
          type: column.type,
          computed: column.type === "computed",
          required: column.required,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      connectedPanelIds: uniqueSorted(
        links.filter(link => link.table === table.name).map(link => link.panelId),
      ),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const connected = new Set(links.map(link => link.panelId));
  const fields = tables.flatMap(table => table.fields);

  return {
    tables,
    panels,
    links,
    orphanPanelIds: panels.filter(panel => !connected.has(panel.id)).map(panel => panel.id),
    stats: {
      tables: tables.length,
      fields: fields.length,
      computedFields: fields.filter(field => field.computed).length,
      panels: panels.length,
      connections: links.length,
      versions: Math.max(0, versions),
    },
  };
}
