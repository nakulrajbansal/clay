import { describe, expect, it } from "vitest";
import { openMemoryDriver } from "../src/db";
import { DeviceCatalog } from "../src/device-catalog";

const id = (prefix: string, char: string): string => `${prefix}_${char.repeat(26)}`;
const sha = (char: string): string => `sha256:${char.repeat(64)}`;

describe("catalog app metadata authority", () => {
  it("updates selected app metadata under one exact fence", async () => {
    const driver = await openMemoryDriver();
    driver.exec("ATTACH DATABASE ':memory:' AS catalog");
    const catalog = DeviceCatalog.initializeFresh(driver);
    catalog.seedSelectedTarget({
      target: {
        appInstanceId: id("app", "a"),
        activeGenerationId: id("gen", "b"),
        lineageEpoch: "0",
        protectionRevision: "0",
        digestSchema: 1,
        stateSha256: sha("c"),
      },
      namespaceId: id("ns", "d"),
      storageKey: "default",
      displayName: "My app",
      shellId: "blank",
      operationId: id("op", "e"),
      at: "2026-09-05T00:00:00.000Z",
    });
    const fence = catalog.acquireWriteLease({
      expectedAuthorityIncarnationId: catalog.snapshot().authorityIncarnationId,
      expectedCatalogGeneration: "1",
      expectedWriteEpoch: "0",
      releaseId: id("rel", "f"),
      nowMs: 1_000,
      ttlMs: 5_000,
    });

    const updated = catalog.updateSelectedAppMetadata({
      expectedCatalogGeneration: "2",
      displayName: "Projects",
      shellId: "tracker",
      operationId: id("op", "g"),
      fence,
      nowMs: 1_001,
    });

    expect(updated.catalogGeneration).toBe("3");
    expect(updated.entries).toEqual([expect.objectContaining({
      appInstanceId: id("app", "a"),
      displayName: "Projects",
      shellId: "tracker",
    })]);
    expect(DeviceCatalog.openExisting(driver).snapshot()).toEqual(updated);
    driver.close();
  });
});
