import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { openMemoryDriver } from "../../kernel/src/db";
import { ProductionStoreAuthority } from "../../kernel/src/production-authority";
import { createStarterSeedBundle } from "../src/shells/seed";
import { createStarterSeedBundle as originalSeed, STARTER_SHELLS } from "./oracles/seed";
import { SeedComputeClient } from "../src/worker/pure-compute-client";
import { OwnedComputeWorker } from "./helpers/owned-compute-worker";

const id = (prefix: string, letter = "q") => `${prefix}_${letter.repeat(26)}`;
async function fresh() {
  const driver = await openMemoryDriver(); driver.exec("ATTACH DATABASE ':memory:' AS catalog");
  const authority = ProductionStoreAuthority.initializeFresh(driver, {
    inventory: { state: "complete", catalogPresent: false, namespaces: [] },
    storageKey: id("ns"), displayName: "Blank", shellId: "blank", appInstanceId: id("app"),
    generationId: id("gen"), namespaceId: id("ns"), adoptionOperationId: id("op"), releaseId: id("rel"),
    nowMs: Date.now(), leaseTtlMs: 60_000,
  });
  return { authority, driver };
}
it.each(["generation", "revision", "catalog", "app", "lineage", "digest", "queued-write"] as const)("recaptures computed seed source at serialized execution: %s", async fault => {
  const { authority, driver } = await fresh();
  try {
    const before = authority.inspectAuthority();
    const source = { catalogGeneration: before.catalog.catalogGeneration, target: { ...before.target } };
    if (fault === "generation") source.target.activeGenerationId = id("gen", "r");
    if (fault === "revision") source.target.protectionRevision = "99";
    if (fault === "catalog") source.catalogGeneration = "99";
    if (fault === "app") source.target.appInstanceId = id("app", "r");
    if (fault === "lineage") source.target.lineageEpoch = "99";
    if (fault === "digest") source.target.stateSha256 = `sha256:${"f".repeat(64)}`;
    if (fault === "queued-write") await authority.executeMutation({ requestId: id("req", "s"),
      route: "setting.set", payload: { key: "test_compute_change", value: "changed" } });
    const expected = authority.inspectAuthority();
    const physical = await driver.exportDatabases();
    await expect(authority.executeMutation({ requestId: id("req"), route: "starter.seed",
      payload: createStarterSeedBundle("tracker") }, source)).rejects.toThrow(/computed source|computation/);
    expect(authority.inspectAuthority()).toEqual(expected);
    expect(await driver.exportDatabases()).toEqual(physical);
  } finally { authority.close(); }
});

it.each(STARTER_SHELLS.map(s => s.id))("computed %s retains independent physical/canonical/history/receipt bytes", async starter => {
  const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
  const results = [];
  const compute = new SeedComputeClient(() => new OwnedComputeWorker() as unknown as Worker);
  OwnedComputeWorker.reset();
  const computed = await compute.seed(starter, { catalogGeneration: "1", target: {
    appInstanceId: id("app"), activeGenerationId: id("gen"), lineageEpoch: "0",
    protectionRevision: "0", digestSchema: 1, stateSha256: `sha256:${"0".repeat(64)}`,
  } });
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-14T12:00:00Z"));
  try {
    for (const payload of [originalSeed(starter), computed]) {
      let sequence = 0;
      const random = vi.spyOn(crypto, "getRandomValues").mockImplementation(array => {
        const view = new Uint8Array(array!.buffer, array!.byteOffset, array!.byteLength);
        for (let i = 0; i < view.length; i += 32) {
          const bytes = createHash("sha256").update(`owned-seed-fixture:${++sequence}`).digest();
          view.set(bytes.subarray(0, Math.min(32, view.length - i)), i);
        }
        return array;
      });
      const uuid = vi.spyOn(crypto, "randomUUID").mockImplementation(() =>
        `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`);
      const { authority, driver } = await fresh();
      try {
        const request = { requestId: id("req"), route: "starter.seed", payload };
        const committed = await authority.executeMutation(request);
        const replayed = await authority.executeMutation(request);
        const bytes = await driver.exportDatabases();
        const catalog = driver.select("SELECT name,sql FROM catalog.sqlite_master WHERE type='table' ORDER BY name").map(row => ({
          ...row, rows: driver.select(`SELECT * FROM catalog."${String(row.name).replaceAll('"', '""')}"`),
        }));
        results.push({ committed, replayed, user: hash(bytes.user), system: hash(bytes.system), catalog: hash(JSON.stringify(catalog)),
          inspection: authority.inspectAuthority(), history: authority.readStore().history(), panels: authority.readStore().livePanels() });
      } finally { authority.close(); random.mockRestore(); uuid.mockRestore(); }
    }
    expect(results[1]).toEqual(results[0]);
  } finally { vi.restoreAllMocks(); vi.useRealTimers(); }
}, 30_000);
