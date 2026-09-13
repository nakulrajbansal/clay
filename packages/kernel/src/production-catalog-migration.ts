import { browserDurableFileNames, openBrowserCatalogProbe } from "./db";
import { DeviceCatalog } from "./device-catalog";
import { createLiveWriteGuard } from "./live-write-guard";
import { withBrowserLifecycleLock } from "./lifecycle-recovery-inventory";

/** No namespace is opened or unlinked. The hint is read-only so normal nested
 * lifecycle boot never reacquires its own non-reentrant physical lock. */
export async function migrateBrowserCatalogRetention(): Promise<void> {
  if (!(await browserDurableFileNames()).includes("/clay-device-catalog-v1.db")) return;
  const probe = await openBrowserCatalogProbe();
  try { if (DeviceCatalog.isAbsent(probe) || !DeviceCatalog.needsBackupRetentionMigration(probe)) return; }
  finally { probe.close(); }
  await withBrowserLifecycleLock(async () => {
    const session = createLiveWriteGuard(await openBrowserCatalogProbe());
    try { session.authority.run(() => DeviceCatalog.migrateBackupRetention(session.driver)); }
    finally { session.driver.close(); }
  });
}
