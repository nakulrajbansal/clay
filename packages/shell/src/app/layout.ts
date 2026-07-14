// Pure layout math for direct manipulation (B4). Given the current panels
// and a drag (panel X dropped into region R at index I), compute the new
// placement for every panel. Kept pure so it's testable without the DOM;
// the drag glue in App.tsx just feeds it pointer results.
export type Region = "top" | "main" | "side";
export type Placement = { panel_id: string; region: Region; order: number; w?: number };
type Panel = { panel_id: string; placement: { region: Region; order: number; w?: number } };

const REGIONS: Region[] = ["top", "main", "side"];

export function reorder(
  panels: Panel[],
  draggedId: string,
  targetRegion: Region,
  targetIndex: number,
): Placement[] {
  const width = new Map(panels.map(p => [p.panel_id, p.placement.w]));
  const byRegion: Record<Region, string[]> = { top: [], main: [], side: [] };
  for (const p of [...panels].sort((a, b) => a.placement.order - b.placement.order))
    byRegion[p.placement.region].push(p.panel_id);

  // remove the dragged panel from wherever it currently sits
  for (const r of REGIONS) {
    const i = byRegion[r].indexOf(draggedId);
    if (i >= 0) byRegion[r].splice(i, 1);
  }
  // insert it into the target region at the clamped index
  const idx = Math.max(0, Math.min(targetIndex, byRegion[targetRegion].length));
  byRegion[targetRegion].splice(idx, 0, draggedId);

  const out: Placement[] = [];
  for (const r of REGIONS)
    byRegion[r].forEach((id, i) => {
      const w = width.get(id);
      out.push({ panel_id: id, region: r, order: i, ...(w && w !== 1 ? { w } : {}) });
    });
  return out;
}
