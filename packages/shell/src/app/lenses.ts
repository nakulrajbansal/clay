import type { LivePanel } from "@clay/kernel";

export type LensId = "all" | "review" | "focus" | "update";

export type SituationalLens = {
  id: LensId;
  name: string;
  description: string;
  panelIds: string[];
};

const LENS_IDS = new Set<LensId>(["all", "review", "focus", "update"]);

export function buildSituationalLenses(panels: LivePanel[]): SituationalLens[] {
  const ids = (predicate: (panel: LivePanel) => boolean): string[] =>
    panels.filter(predicate).map(panel => panel.panel_id);
  return [
    {
      id: "all",
      name: "All views",
      description: "The complete app shape",
      panelIds: ids(() => true),
    },
    {
      id: "review",
      name: "Morning review",
      description: "Read-only signals and summaries",
      panelIds: ids(panel => panel.declared_writes.length === 0),
    },
    {
      id: "focus",
      name: "Focus",
      description: "The primary work canvas",
      panelIds: ids(panel => panel.placement.region === "main"),
    },
    {
      id: "update",
      name: "Update data",
      description: "Forms and views that can change records",
      panelIds: ids(panel => panel.declared_writes.length > 0),
    },
  ];
}

export function applyLens(panels: LivePanel[], id: string): LivePanel[] {
  const lens = buildSituationalLenses(panels).find(item => item.id === id);
  if (!lens) return panels;
  const visible = new Set(lens.panelIds);
  return panels.filter(panel => visible.has(panel.panel_id));
}

const lensKey = (appId: string): string => `clay_lens_${appId}`;

export function loadLensId(
  storage: Pick<Storage, "getItem">,
  appId: string,
): LensId {
  try {
    const value = storage.getItem(lensKey(appId));
    return value && LENS_IDS.has(value as LensId) ? value as LensId : "all";
  } catch { return "all"; }
}

export function saveLensId(
  storage: Pick<Storage, "setItem">,
  appId: string,
  id: LensId,
): void {
  try { storage.setItem(lensKey(appId), id); } catch { /* private mode */ }
}
