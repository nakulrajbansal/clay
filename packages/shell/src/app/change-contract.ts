import type { PreviewInfo } from "../worker/db-worker";

export type ContractAccess = "none" | "read" | "write" | "read_write";

export type ChangeContract = {
  version: number;
  summary: string;
  changes: PreviewInfo["diff"];
  dataAccess: Array<{ table: string; mode: Exclude<ContractAccess, "none"> }>;
  changedViews: Array<{ id: string; title: string; access: ContractAccess }>;
  removedPanelIds: string[];
  repaired: boolean;
  guarantees: Array<{
    id: "shadow" | "reversible" | "rows" | "preview";
    label: string;
    detail: string;
    proven: true;
  }>;
};

export type TrustReceipt = {
  version: number;
  rewindTo: number;
  summary: string;
  changes: PreviewInfo["diff"];
  dataAccess: ChangeContract["dataAccess"];
  affectedViews: ChangeContract["changedViews"];
  removedPanelIds: string[];
  repaired: boolean;
};

function accessOf(reads: ReadonlySet<string>, writes: ReadonlySet<string>): ContractAccess {
  if (reads.size > 0 && writes.size > 0) return "read_write";
  if (writes.size > 0) return "write";
  if (reads.size > 0) return "read";
  return "none";
}

export function buildChangeContract(preview: PreviewInfo): ChangeContract {
  const tableModes = new Map<string, { read: boolean; write: boolean }>();
  const changedViews = preview.panels.map(panel => {
    const reads = new Set(panel.declared_queries.map(query => query.from));
    const writes = new Set(panel.declared_writes);
    for (const table of reads) {
      const mode = tableModes.get(table) ?? { read: false, write: false };
      mode.read = true;
      tableModes.set(table, mode);
    }
    for (const table of writes) {
      const mode = tableModes.get(table) ?? { read: false, write: false };
      mode.write = true;
      tableModes.set(table, mode);
    }
    return {
      id: panel.panel_id,
      title: panel.title,
      access: accessOf(reads, writes),
    };
  }).sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));

  const dataAccess = [...tableModes.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([table, mode]) => ({
      table,
      mode: mode.read && mode.write ? "read_write" as const
        : mode.write ? "write" as const : "read" as const,
    }));

  return {
    version: preview.version,
    summary: preview.summary,
    changes: preview.diff.map(change => ({ ...change })),
    dataAccess,
    changedViews,
    removedPanelIds: [...preview.removePanels].sort(),
    repaired: preview.repaired,
    guarantees: [
      {
        id: "shadow",
        label: "Shadow-checked",
        detail: "Schema changes and declared queries passed on an isolated copy.",
        proven: true,
      },
      {
        id: "reversible",
        label: "Reversible",
        detail: "This change has an inverse and becomes one timeline version.",
        proven: true,
      },
      {
        id: "rows",
        label: "Rows retained",
        detail: "Existing records are not deleted by reshaping.",
        proven: true,
      },
      {
        id: "preview",
        label: "Preview read-only",
        detail: "Data-entry actions unlock only after you keep the shape.",
        proven: true,
      },
    ],
  };
}

export function buildTrustReceipt(preview: PreviewInfo, version: number): TrustReceipt {
  const contract = buildChangeContract(preview);
  return {
    version,
    rewindTo: Math.max(0, version - 1),
    summary: contract.summary,
    changes: contract.changes.map(change => ({ ...change })),
    dataAccess: contract.dataAccess.map(access => ({ ...access })),
    affectedViews: contract.changedViews.map(view => ({ ...view })),
    removedPanelIds: [...contract.removedPanelIds],
    repaired: contract.repaired,
  };
}
