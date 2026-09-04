import { useCallback, useEffect, useState } from "react";

export type WorkspaceMode = "work" | "customize";

type WorkspaceModeStorage = Pick<Storage, "getItem" | "setItem">;

function availableStorage(storage?: WorkspaceModeStorage): WorkspaceModeStorage | null {
  if (storage) return storage;
  try { return typeof localStorage === "undefined" ? null : localStorage; }
  catch { return null; }
}

export function workspaceModeStorageKey(appId: string): string {
  return `clay_workspace_mode:${encodeURIComponent(appId)}`;
}

export function readWorkspaceMode(
  appId: string | null,
  storage?: WorkspaceModeStorage,
): WorkspaceMode {
  if (!appId) return "work";
  try {
    return availableStorage(storage)?.getItem(workspaceModeStorageKey(appId)) === "customize"
      ? "customize" : "work";
  } catch { return "work"; }
}

export function writeWorkspaceMode(
  appId: string | null,
  mode: WorkspaceMode,
  storage?: WorkspaceModeStorage,
): void {
  if (!appId) return;
  try { availableStorage(storage)?.setItem(workspaceModeStorageKey(appId), mode); }
  catch { /* Presentation cache failure must not affect app data or selection. */ }
}

export function useWorkspaceMode(
  appId: string | null,
): [WorkspaceMode, (mode: WorkspaceMode) => void] {
  const [mode, setMode] = useState<WorkspaceMode>(() => readWorkspaceMode(appId));
  useEffect(() => setMode(readWorkspaceMode(appId)), [appId]);
  const chooseMode = useCallback((next: WorkspaceMode): void => {
    writeWorkspaceMode(appId, next);
    setMode(next);
  }, [appId]);
  return [mode, chooseMode];
}
