import { describe, expect, it } from "vitest";
import {
  ClayStore, deriveInverse, openDriverFromBytes, openMemoryDriver, zipRead,
  type ForwardOpT,
} from "../src/index";

async function hasItemsIndex(store: ClayStore): Promise<boolean> {
  const parts = zipRead(await store.exportArchive("index-check"));
  const driver = await openDriverFromBytes(
    parts.find(entry => entry.name === "user.db")!.data,
    parts.find(entry => entry.name === "system.db")!.data,
  );
  try {
    return driver.select(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_items_name'",
    ).length === 1;
  } finally { driver.close(); }
}

function indexedItemsOperations(): ForwardOpT[] {
  return [
    { op: "create_table", table: "items", columns: [
      { name: "name", type: "text", required: true },
    ] },
    { op: "add_index", table: "items", column: "name" },
  ];
}

describe("archive indexes", () => {
  it("round-trips validated user indexes", async () => {
    const source = await ClayStore.openMemory();
    const operations = indexedItemsOperations();
    source.commit({ intent: "Indexed items", summary: "Adds indexed items.",
      migration: { operations, inverse: deriveInverse(operations, source.registrySnapshot()) } });
    const imported = await ClayStore.importArchive(
      await source.exportArchive("indexed"), async () => openMemoryDriver());
    source.close();
    try { expect(await hasItemsIndex(imported.store)).toBe(true); }
    finally { imported.store.close(); }
  });

  it("retains a future index across rewind, import, and roll-forward", async () => {
    const source = await ClayStore.openMemory();
    const operations = indexedItemsOperations();
    source.commit({ intent: "Indexed items", summary: "Adds indexed items.",
      migration: { operations, inverse: deriveInverse(operations, source.registrySnapshot()) } });
    source.rollbackTo(0);
    const imported = await ClayStore.importArchive(await source.exportArchive("rewound-index"));
    source.close();
    try {
      expect(imported.store.currentVersion()).toBe(0);
      imported.store.rollForwardTo(1);
      expect(await hasItemsIndex(imported.store)).toBe(true);
    } finally { imported.store.close(); }
  });
});
