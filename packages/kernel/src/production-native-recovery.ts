import type { DbDriver } from "./db";
import { DeviceCatalog } from "./device-catalog";
import { ClayStore } from "./store";
import { TargetAuthorityStore } from "./target-authority";
import { enumerateCanonicalStateV1 } from "./canonical-state";
import { StateMerkleIndex } from "./state-merkle-index";
import { physicalNamespaceEntry } from "./durable-inventory";
import { snapshotPreservedSahpool, assertPreservedSahpoolHandles, preservedSahpoolQuarantine } from "./sahpool-initialization";
import { nativeRecoveryShadow } from "./native-recovery-shadow";
import { installSahpoolJournalRecovery } from "./sahpool-journal-recovery";
import { ClayError } from "./errors";
import { stableJson } from "./stable-json";

const CATALOG = "/clay-device-catalog-v1.db";
const failed = () => new ClayError("E_CATALOG_UNAVAILABLE", "Native journal owner preflight or canonical recovery is unproven; original files were kept for recovery");
type Target = ReturnType<DeviceCatalog["activeTargetStorageInventory"]>[number];
const rollbackInspection = Object.freeze({ inspection: true });

function auditTarget(driver: DbDriver, expected: Target): void {
  try {
    driver.tx(() => {
      const target = TargetAuthorityStore.open(driver).evidence();
      const store = ClayStore.fromDriver(driver);
      const state = enumerateCanonicalStateV1(driver, store.validationRegistrySnapshot()), merkle = StateMerkleIndex.open(driver).audit();
      if (stableJson(target) !== stableJson(expected.target) || state.stateSha256 !== target.stateSha256
          || merkle.stateSha256 !== state.stateSha256 || merkle.leafCount !== state.leaves.length) throw failed();
      // Store's compatibility inspections may issue idempotent DDL. Nothing from
      // this canonical validation may persist as a repair or migration.
      throw rollbackInspection;
    });
  } catch (error) { if (error !== rollbackInspection) throw error; }
}

/** Install immediately after preserving initialization, before any main opens.
 * The returned coordinator is source-private; route payloads cannot supply a
 * tuple/grant. A hot catalog is resolved only on a disposable private shadow,
 * then its closed ownership/history and every live canonical target are proved.
 * Only that proof authorizes real SQLite rollback over unchanged held files. */
export function productionNativeRecovery(sqlite: any, pool: any, driverFor: (db: any) => DbDriver) {
  assertPreservedSahpoolHandles(sqlite, pool);
  const native = installSahpoolJournalRecovery(sqlite, pool);
  let completed = false, poisoned = false;
  return { assertReady() { if (!completed || poisoned) throw failed(); assertPreservedSahpoolHandles(sqlite, pool); }, recover() {
    if (completed) return;
    if (poisoned) throw failed();
    native.assertOriginallyUnopened();
    const names: string[] = pool.getFileNames();
    if (preservedSahpoolQuarantine(pool).slots && !names.includes(CATALOG)) { poisoned = true; throw failed(); }
    if (!names.some(name => /-(?:journal|wal|shm)$|\.db-mj/.test(name))) { completed = true; return; }
    if (!names.includes(CATALOG)) { poisoned = true; throw failed(); }
    const snapshot = snapshotPreservedSahpool(sqlite, pool);
    const shadow = nativeRecoveryShadow(sqlite, snapshot.images);
    const open = (files: readonly string[], copy: boolean) => {
      const namespace = files.find(file => file !== CATALOG);
      const db = namespace ? (copy ? shadow.open(namespace) : new pool.OpfsSAHPoolDb(namespace)) : new sqlite.oo1.DB(":memory:");
      try {
        if (namespace) {
          const system = files.find(file => file !== CATALOG && file !== namespace)!;
          if (copy) shadow.attach(db, system, "sys"); else db.exec(`ATTACH 'file:${system}?vfs=opfs-sahpool' AS sys`);
        }
        if (copy) shadow.attach(db, CATALOG, "catalog"); else db.exec(`ATTACH 'file:${CATALOG}?vfs=opfs-sahpool' AS catalog`);
        for (const name of namespace ? ["main", "sys", "catalog"] : ["catalog"]) db.selectValue(`SELECT count(*) FROM ${name}.sqlite_master`);
        return db;
      } catch (error) { try { db.close(); } catch { /* caller poisons original runtime */ } throw error; }
    };
    try {
      const probe = driverFor(open([CATALOG], true));
      let targets: Target[], owned: Set<string>, catalogIdentity: string;
      const declared: Array<{ userFile: string; systemFile: string }> = [];
      try {
        const catalog = DeviceCatalog.originalNativePreflight(probe);
        targets = catalog.activeTargetStorageInventory();
        catalogIdentity = stableJson(catalog.snapshot());
        const restores = catalog.pendingRestoreJobs(), lifecycle = catalog.pendingLifecycleJobs();
        owned = new Set([CATALOG, ...targets.flatMap(target => {
          const files = physicalNamespaceEntry(target.storageKey, target.namespaceId); return [files.userFile, files.systemFile];
        })]);
        // Job-explained partial pairs/sidecars remain for fenced lifecycle/restore
        // cleanup. They are not inferred to be canonical or silently published.
        for (const job of restores) {
          const files = physicalNamespaceEntry(job.namespaceId, job.namespaceId);
          declared.push(files);
          for (const file of [files.userFile, files.systemFile]) owned.add(file);
        }
        for (const job of lifecycle) { declared.push(job.target); owned.add(job.target.userFile); owned.add(job.target.systemFile); }
      } finally { probe.close(); }
      const cohorts: Array<{ target: Target | null; files: string[] }> = targets.map(target => {
        const physical = physicalNamespaceEntry(target.storageKey, target.namespaceId);
        return { target, files: [physical.userFile, physical.systemFile, CATALOG] };
      });
      for (const files of declared) if (names.includes(files.userFile) && names.includes(files.systemFile))
        cohorts.push({ target: null, files: [files.userFile, files.systemFile, CATALOG] });
      // Filenames only delimit the shadow corpus. They do not establish owner
      // authority: every permitted main must have just been proven by the catalog.
      if (names.some(file => !owned.has(file) && !declared.some(target => [target.userFile, target.systemFile].some(main => file === `${main}-wal` || file === `${main}-shm`)) && ![...owned].some(main => file === `${main}-journal`
          || (file.startsWith(`${main}-mj`) && /^[0-9a-f]{9}$/i.test(file.slice(main.length + 3)))))) throw failed();
      for (const cohort of cohorts) {
        if (cohort.files.some(file => !names.includes(file))) throw failed();
        if (!cohort.target) continue; // Pending target is owned cleanup work, not canonical publication.
        const driver = driverFor(open(cohort.files, true));
        try { auditTarget(driver, cohort.target); } finally { driver.close(); }
      }
      shadow.assertValid();
      // At most one app tuple can participate in an in-flight worker transaction.
      // A mixed multi-target journal corpus is not reconstructed from its names.
      const hot = cohorts.filter(cohort => cohort.files.slice(0, 2).some(main => names.some(file => file === `${main}-journal` || file.startsWith(`${main}-mj`))));
      if (hot.length > 1) throw failed();
      const files = hot[0]?.files ?? [CATALOG];
      snapshot.assertUnchanged();
      native.run(files, () => {
        const db = open(files, false);
        try { native.finish(db); } finally { db.close(); }
      });
      // Native rollback is not enough. Reclassify the real, recovered catalog and
      // every live target against the independently validated shadow result.
      const after = driverFor(open([CATALOG], false));
      try {
        const catalog = DeviceCatalog.originalNativePreflight(after);
        if (stableJson(catalog.snapshot()) !== catalogIdentity || stableJson(catalog.activeTargetStorageInventory()) !== stableJson(targets)) throw failed();
      } finally { after.close(); }
      for (const cohort of cohorts) {
        if (!cohort.target) continue;
        const driver = driverFor(open(cohort.files, false));
        try { auditTarget(driver, cohort.target); } finally { driver.close(); }
      }
      completed = true;
    } catch { poisoned = true; throw failed(); }
    finally { shadow.dispose(); snapshot.dispose(); }
  } };
}
