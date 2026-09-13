import { ClayError } from "./errors";

export function lifecyclePhysicalFiles(target: { userFile: string; systemFile: string }): string[] {
  return [target.userFile, target.systemFile].flatMap(file =>
    [file, `${file}-journal`, `${file}-wal`, `${file}-shm`]);
}
export function assertLifecycleRecoveryInventory(
  names: string[], liveFiles: string[], target: { userFile: string; systemFile: string },
): void {
  const pending = new Set(lifecyclePhysicalFiles(target));
  const live = new Set(liveFiles);
  if (new Set(names).size !== names.length || live.size !== liveFiles.length
      || liveFiles.some(file => pending.has(file) || !names.includes(file))
      || names.some(file => !live.has(file) && !pending.has(file)))
    throw new ClayError("E_CATALOG_UNAVAILABLE", "lifecycle recovery inventory is not exactly job-explained");
}

/** A fence guards catalog CAS; this crash-released lock also spans asynchronous file I/O. */
export async function withBrowserLifecycleLock<T>(work: () => Promise<T>): Promise<T> {
  if (typeof navigator === "undefined" || !navigator.locks)
    throw new ClayError("E_CATALOG_UNAVAILABLE", "cross-tab lifecycle exclusion is unavailable");
  return navigator.locks.request("clay:catalog-lifecycle-physical:v1", { mode: "exclusive" }, work);
}
