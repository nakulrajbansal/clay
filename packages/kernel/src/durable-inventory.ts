export type DurableNamespaceInventoryEntry = {
  storageKey: string;
  userFile: string;
  systemFile: string;
  kind: "legacy" | "generation";
};

export type DurableFileInventory =
  | { state: "complete"; catalogPresent: boolean; namespaces: DurableNamespaceInventoryEntry[] }
  | {
    state: "ambiguous";
    reason: "duplicate_file" | "pending_sqlite_file" | "unknown_file"
      | "orphan_namespace" | "duplicate_namespace";
  };

const CATALOG_FILE = "/clay-device-catalog-v1.db";
const LEGACY_APP_FILE = /^\/app-([a-zA-Z0-9_][a-zA-Z0-9_-]{0,79})-(user|system)\.db$/;
const GENERATION_FILE = /^\/(ns_[a-z2-7]{26})-(user|system)\.db$/;

export function classifyDurableFileInventory(files: string[]): DurableFileInventory {
  if (new Set(files).size !== files.length) return { state: "ambiguous", reason: "duplicate_file" };
  if (files.some(file => /-(?:journal|wal|shm)$/.test(file)))
    return { state: "ambiguous", reason: "pending_sqlite_file" };

  const grouped = new Map<string, {
    kind: "legacy" | "generation";
    userFile?: string;
    systemFile?: string;
  }>();
  let catalogPresent = false;
  for (const file of files) {
    if (file === CATALOG_FILE) {
      catalogPresent = true;
      continue;
    }
    let storageKey: string;
    let role: "user" | "system";
    let kind: "legacy" | "generation";
    if (file === "/user.db" || file === "/system.db") {
      storageKey = "default";
      role = file === "/user.db" ? "user" : "system";
      kind = "legacy";
    } else {
      const generation = GENERATION_FILE.exec(file);
      const legacy = LEGACY_APP_FILE.exec(file);
      const match = generation ?? legacy;
      if (!match) return { state: "ambiguous", reason: "unknown_file" };
      storageKey = match[1]!;
      role = match[2] as "user" | "system";
      kind = generation ? "generation" : "legacy";
    }
    const entry = grouped.get(storageKey);
    if (entry && entry.kind !== kind)
      return { state: "ambiguous", reason: "duplicate_namespace" };
    const target = entry ?? { kind };
    if ((role === "user" && target.userFile) || (role === "system" && target.systemFile))
      return { state: "ambiguous", reason: "duplicate_file" };
    if (role === "user") target.userFile = file;
    else target.systemFile = file;
    grouped.set(storageKey, target);
  }

  const namespaces: DurableNamespaceInventoryEntry[] = [];
  for (const [storageKey, entry] of grouped) {
    if (!entry.userFile || !entry.systemFile)
      return { state: "ambiguous", reason: "orphan_namespace" };
    namespaces.push({
      storageKey,
      userFile: entry.userFile,
      systemFile: entry.systemFile,
      kind: entry.kind,
    });
  }
  namespaces.sort((left, right) => left.storageKey.localeCompare(right.storageKey));
  return { state: "complete", catalogPresent, namespaces };
}
