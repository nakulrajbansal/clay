// .clay archives (doc 04 §7): zip round-trip, export -> import equality
// (doc 08 §5), integrity aborts that leave nothing half-swapped, and the
// G15 rule — imported panel blobs are re-validated, never trusted.
import { describe, expect, it } from "vitest";
import {
  ClayStore, crc32, registryToJson, zipRead, zipWrite,
} from "../src/index";
import { HEALTH_COMPUTED, seededStore } from "./helpers";

describe("minimal zip", () => {
  it("round-trips entries byte-exact", () => {
    const a = new TextEncoder().encode("hello clay");
    const b = new Uint8Array([0, 1, 2, 255, 254, 253]);
    const zipped = zipWrite([{ name: "a.txt", data: a }, { name: "dir/b.bin", data: b }]);
    const back = zipRead(zipped);
    expect(back.map(e => e.name)).toEqual(["a.txt", "dir/b.bin"]);
    expect([...back[0]!.data]).toEqual([...a]);
    expect([...back[1]!.data]).toEqual([...b]);
  });

  it("detects corruption via crc", () => {
    const zipped = zipWrite([{ name: "x", data: new TextEncoder().encode("payload") }]);
    zipped[35] = zipped[35]! ^ 0xff;   // flip a byte inside the stored data
    expect(() => zipRead(zipped)).toThrowError(/crc|corrupt|zip/i);
    expect(crc32(new Uint8Array([1, 2, 3]))).not.toBe(crc32(new Uint8Array([1, 2, 4])));
  });
});

async function richStore(): Promise<ClayStore> {
  const store = await seededStore();
  store.commit({
    intent: "health", summary: "Adds health score.", migration: HEALTH_COMPUTED,
    panels: [{
      panel_id: "health_strip", title: "Health",
      placement: { region: "top", order: 0 },
      code: "export default function (clay) { clay.ui.render(h(EmptyState, { label: \"ok\" })); }",
      declared_queries: [{ from: "projects" }], declared_writes: [],
    }],
  });
  const id = String(store.query({ from: "projects" })[0]!.id);
  store.update("projects", id, { owner: "Kim" });   // row_history content too
  return store;
}

describe("export -> import round trip", () => {
  it("reproduces registry, data, history, panels, and row_history", async () => {
    const original = await richStore();
    const bytes = await original.exportArchive("test-app");

    const { store: imported, manifest, invalidPanels } =
      await ClayStore.importArchive(bytes);
    expect(manifest).toMatchObject({ format: 1, app: "test-app", versions: 2 });
    expect(invalidPanels).toEqual([]);

    expect(registryToJson(imported.registrySnapshot()))
      .toBe(registryToJson(original.registrySnapshot()));
    expect(JSON.stringify(imported.dumpTable("projects")))
      .toBe(JSON.stringify(original.dumpTable("projects")));
    expect(imported.history()).toEqual(original.history());
    expect(imported.livePanels()).toEqual(original.livePanels());
    expect(imported.rowHistoryCount()).toBe(original.rowHistoryCount());

    // the imported store is fully operational
    imported.insert("projects", { name: "Denali" });
    expect(imported.query({ from: "projects" })).toHaveLength(4);
    original.close();
    imported.close();
  });

  it("rejects non-archives and unknown formats", async () => {
    await expect(ClayStore.importArchive(new Uint8Array([1, 2, 3])))
      .rejects.toThrowError(/zip/i);
    const fake = zipWrite([
      { name: "manifest.json", data: new TextEncoder().encode(`{"format": 99}`) },
      { name: "user.db", data: new Uint8Array(0) },
      { name: "system.db", data: new Uint8Array(0) },
    ]);
    await expect(ClayStore.importArchive(fake))
      .rejects.toThrowError(/unsupported archive format/);
  });

  it("aborts on integrity failure (mixed-up databases)", async () => {
    const a = await richStore();
    const empty = await ClayStore.openMemory();
    const aBytes = await a.exportArchive("a");
    const emptyBytes = await empty.exportArchive("empty");
    const aParts = zipRead(aBytes);
    const emptyParts = zipRead(emptyBytes);
    // registry (system.db) from A, but user.db from the empty store:
    const frankenstein = zipWrite([
      aParts.find(e => e.name === "manifest.json")!,
      { name: "user.db", data: emptyParts.find(e => e.name === "user.db")!.data },
      { name: "system.db", data: aParts.find(e => e.name === "system.db")!.data },
    ]);
    await expect(ClayStore.importArchive(frankenstein))
      .rejects.toThrowError(/integrity/);
    a.close();
    empty.close();
  });

  it("re-validates imported panel blobs (G15)", async () => {
    const store = await seededStore();
    store.commit({
      intent: "hostile", summary: "Adds a hostile panel.", migration: null,
      panels: [{
        panel_id: "sneaky_panel", title: "Sneaky",
        placement: { region: "main", order: 0 },
        // commit() does not validate — exactly the G15 scenario
        code: "export default function (clay) { fetch('https://evil.example'); }",
        declared_queries: [], declared_writes: [],
      }],
    });
    const bytes = await store.exportArchive("hostile");
    const { store: imported, invalidPanels } = await ClayStore.importArchive(bytes);
    expect(invalidPanels).toEqual(["sneaky_panel"]);
    store.close();
    imported.close();
  });
});
