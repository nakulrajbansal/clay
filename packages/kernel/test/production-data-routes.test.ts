import { describe, expect, it } from "vitest";
import {
  ClayStore, deriveInverse, openMemoryDriver,
  type DbDriver, type ForwardOpT,
} from "../src/index";
import { ProductionStoreAuthority } from "../src/production-authority";
import { sha256HexSync } from "../src/state-digest";

const opaque = (prefix: string, char: string): string => `${prefix}_${char.repeat(26)}`;
const requestId = (char: string): string => opaque("req", char);

const legacyInventory = {
  state: "complete" as const,
  catalogPresent: false,
  namespaces: [{
    storageKey: "default",
    userFile: "/user.db",
    systemFile: "/system.db",
    kind: "legacy" as const,
  }],
};

async function dataAuthority(
  prepare?: (store: ClayStore, driver: DbDriver, firstId: string) => void | Promise<void>,
): Promise<{
  authority: ProductionStoreAuthority;
  driver: DbDriver;
  firstId: string;
  secondId: string;
}> {
  const driver = await openMemoryDriver();
  driver.exec("ATTACH DATABASE ':memory:' AS catalog");
  const store = ClayStore.fromDriver(driver);
  const operations: ForwardOpT[] = [{
    op: "create_table",
    table: "documents",
    columns: [
      { name: "name", type: "text", required: true },
      { name: "status", type: "enum", required: false, values: ["todo", "done"] },
      { name: "files", type: "attachment", required: false },
      { name: "obsolete", type: "text", required: false },
    ],
  }];
  store.commit({
    intent: "create documents",
    summary: "Created documents.",
    migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) },
  });
  const first = store.insert("documents", {
    name: "First", status: "todo", obsolete: "retained",
  });
  const second = store.insert("documents", {
    name: "Second", status: "done", obsolete: "preserved",
  });
  await prepare?.(store, driver, String(first.id));
  const authority = ProductionStoreAuthority.adoptLegacy(driver, {
    inventory: legacyInventory,
    storageKey: "default",
    displayName: "Documents",
    appInstanceId: opaque("app", "a"),
    generationId: opaque("gen", "b"),
    namespaceId: opaque("ns", "c"),
    adoptionOperationId: opaque("op", "d"),
    releaseId: opaque("rel", "e"),
    nowMs: Date.now(),
    leaseTtlMs: 60_000,
  });
  return {
    authority,
    driver,
    firstId: String(first.id),
    secondId: String(second.id),
  };
}

describe("production data lifecycle routes", () => {
  it("captures attachment bytes once and atomically returns verified metadata", async () => {
    const { authority, firstId } = await dataAuthority();
    try {
      const original = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]);
      const expected = new Uint8Array(original);
      const pending = authority.executeMutation({
        requestId: requestId("f"),
        route: "attachment.add",
        payload: {
          table: "documents",
          rowId: firstId,
          field: "files",
          name: "../receipt.pdf",
          mime: "application/pdf",
          bytes: original,
        },
      });
      original.fill(0);

      const committed = await pending;
      expect(committed).toMatchObject({
        changed: true,
        replayed: false,
        result: {
          name: "receipt.pdf",
          mime: "application/pdf",
          size: expected.byteLength,
          sha256: sha256HexSync(expected),
        },
      });
      const metadata = committed.result as { id: string };
      expect(authority.readStore().attachmentsForRecord("documents", firstId, "files"))
        .toEqual([committed.result]);
      const read = await authority.readStore().readAttachment(metadata.id);
      expect(read.bytes).toEqual(expected);
      expect(read).toMatchObject(committed.result as object);
      expect(authority.inspectAuthority().targetReservations).toHaveLength(1);
      expect(authority.inspectAuthority().catalogReservations).toHaveLength(1);
    } finally {
      authority.close();
    }
  });

  it("removes one attachment atomically and replays its exact receipt", async () => {
    const { authority, firstId } = await dataAuthority();
    try {
      const added = await authority.executeMutation({
        requestId: requestId("f"),
        route: "attachment.add",
        payload: {
          table: "documents", rowId: firstId, field: "files",
          name: "receipt.pdf", mime: "application/pdf",
          bytes: new Uint8Array([37, 80, 68, 70]),
        },
      });
      const id = (added.result as { id: string }).id;
      const request = {
        requestId: requestId("g"),
        route: "attachment.remove",
        payload: { table: "documents", rowId: firstId, field: "files", id },
      } as const;

      const removed = await authority.executeMutation(request);
      expect(removed).toMatchObject({ changed: true, replayed: false, result: null });
      expect(authority.readStore().attachmentsForRecord("documents", firstId, "files"))
        .toEqual([]);
      expect(authority.readStore().attachmentStorage())
        .toMatchObject({ activeFiles: 0, deletedFiles: 1 });
      await expect(authority.readStore().readAttachment(id)).rejects.toThrow(/not found/i);
      await expect(authority.executeMutation(request))
        .resolves.toEqual({ ...removed, replayed: true });
    } finally {
      authority.close();
    }
  });

  it("rejects accessor-backed nested payloads without invoking caller code", async () => {
    const { authority, firstId } = await dataAuthority();
    try {
      let getterCalls = 0;
      const patch: Record<string, unknown> = {};
      Object.defineProperty(patch, "status", {
        enumerable: true,
        get(): never {
          getterCalls++;
          throw new Error("caller getter must not run");
        },
      });
      expect(() => authority.executeMutation({
        requestId: requestId("j"),
        route: "store.update",
        payload: { table: "documents", id: firstId, patch },
      })).toThrow(/invalid/i);
      expect(getterCalls).toBe(0);
      expect(authority.inspectAuthority().targetReservations).toEqual([]);
      expect(authority.inspectAuthority().catalogReservations).toEqual([]);
    } finally {
      authority.close();
    }
  });

  it("rejects every data-route accessor without invoking caller code", async () => {
    const { authority, firstId } = await dataAuthority();
    try {
      const cases: Array<{
        request: string;
        route: string;
        payload: Record<string, unknown>;
        key: string;
      }> = [
        { request: "u", route: "attachment.add", key: "bytes", payload: {
          table: "documents", rowId: firstId, field: "files",
          name: "x.pdf", mime: "application/pdf", bytes: new Uint8Array([37, 80, 68, 70]),
        } },
        { request: "v", route: "attachment.remove", key: "id", payload: {
          table: "documents", rowId: firstId, field: "files", id: "file_missing",
        } },
        { request: "w", route: "attachment.purge", key: "unexpected", payload: {} },
        { request: "x", route: "batch.apply", key: "mutations", payload: {
          source: "user", summary: "x", mutations: [],
        } },
        { request: "y", route: "batch.undo", key: "id", payload: { id: "batch" } },
        { request: "z", route: "row.restore", key: "id", payload: {
          table: "documents", id: firstId,
        } },
        { request: "2", route: "schema.removeColumn", key: "column", payload: {
          table: "documents", column: "obsolete",
        } },
      ];
      let getterCalls = 0;
      for (const item of cases) {
        Object.defineProperty(item.payload, item.key, {
          enumerable: true,
          get(): never {
            getterCalls++;
            throw new Error("caller getter must not run");
          },
        });
        expect(() => authority.executeMutation({
          requestId: requestId(item.request), route: item.route, payload: item.payload,
        }), item.route).toThrow(/invalid/i);
      }
      const indexedGetter = [{
        kind: "update", table: "documents", id: firstId, patch: { status: "done" },
      }];
      Object.defineProperty(indexedGetter, "0", {
        enumerable: true,
        get(): never {
          getterCalls++;
          throw new Error("array getter must not run");
        },
      });
      expect(() => authority.executeMutation({
        requestId: requestId("5"), route: "batch.apply",
        payload: { source: "user", summary: "x", mutations: indexedGetter },
      })).toThrow(/invalid/i);
      expect(() => authority.executeMutation({
        requestId: requestId("6"), route: "batch.apply",
        payload: { source: "user", summary: "x", mutations: new Array(1) },
      })).toThrow(/invalid/i);
      expect(getterCalls).toBe(0);
      expect(authority.inspectAuthority().targetReservations).toEqual([]);
      expect(authority.inspectAuthority().catalogReservations).toEqual([]);
    } finally {
      authority.close();
    }
  });

  it("shares one two-million-byte budget across attachment fields and binary", async () => {
    const { authority, firstId } = await dataAuthority();
    try {
      const bytes = new Uint8Array(2_000_000);
      bytes.set([37, 80, 68, 70]);
      let pending: Promise<unknown> | undefined;
      let synchronousError: unknown;
      try {
        pending = authority.executeMutation({
          requestId: requestId("7"),
          route: "attachment.add",
          payload: {
            table: "documents", rowId: firstId, field: "files",
            name: "budget.pdf", mime: "application/pdf", bytes,
          },
        });
      } catch (error) {
        synchronousError = error;
      }
      if (pending !== undefined) await pending.catch(() => undefined);
      expect(synchronousError).toMatchObject({ code: "E_CATALOG_UNAVAILABLE" });
      expect((synchronousError as Error).message).toMatch(/payload.*limits/i);
      expect(authority.inspectAuthority().targetReservations).toEqual([]);
      expect(authority.inspectAuthority().catalogReservations).toEqual([]);
    } finally {
      authority.close();
    }
  });

  it("rejects aggregate batch text and attachment bytes before reservation", async () => {
    const { authority, firstId } = await dataAuthority();
    try {
      expect(() => authority.executeMutation({
        requestId: requestId("3"),
        route: "batch.apply",
        payload: {
          source: "user", summary: "oversized aggregate",
          mutations: [{
            kind: "update", table: "documents", id: firstId,
            patch: {
              first: "a".repeat(800_000),
              second: "b".repeat(800_000),
              third: "c".repeat(800_000),
            },
          }],
        },
      })).toThrow(/aggregate limit/i);
      const oversized = new Uint8Array(10 * 1024 * 1024 + 1);
      oversized.set([37, 80, 68, 70]);
      expect(() => authority.executeMutation({
        requestId: requestId("4"),
        route: "attachment.add",
        payload: {
          table: "documents", rowId: firstId, field: "files",
          name: "large.pdf", mime: "application/pdf", bytes: oversized,
        },
      })).toThrow(/binary payload.*aggregate limit/i);
      expect(authority.inspectAuthority().targetReservations).toEqual([]);
      expect(authority.inspectAuthority().catalogReservations).toEqual([]);
    } finally {
      authority.close();
    }
  });

  it("applies immutable mixed batches and counts only finalized changes", async () => {
    const { authority, firstId, secondId } = await dataAuthority();
    try {
      const mutations = [
        { kind: "update", table: "documents", id: firstId, patch: { status: "done" } },
        { kind: "update", table: "documents", id: secondId, patch: { status: "done" } },
      ];
      const request = {
        requestId: requestId("k"),
        route: "batch.apply",
        payload: { source: "user", summary: "Complete selected", mutations },
      };
      const pending = authority.executeMutation(request);
      mutations[0]!.patch.status = "todo";
      mutations.splice(1, 1);
      const committed = await pending;
      expect(committed).toMatchObject({
        changed: true,
        replayed: false,
        result: { source: "user", summary: "Complete selected", changed: 1, undone: false },
      });
      expect((committed.result as { created: unknown[] }).created).toEqual([]);
      expect(authority.query({ from: "documents" })).toMatchObject([
        { id: firstId, status: "done" },
        { id: secondId, status: "done" },
      ]);
      expect(authority.readStore().operationBatches()).toEqual([committed.result]);
      await expect(authority.executeMutation(request))
        .rejects.toThrow(/identity.*reused|invalid/i);
      const noOpRequest = {
        requestId: requestId("l"),
        route: "batch.apply",
        payload: {
          source: "user",
          summary: "Already complete",
          mutations: [
            { kind: "update", table: "documents", id: firstId, patch: { status: "done" } },
            { kind: "update", table: "documents", id: secondId, patch: { status: "done" } },
          ],
        },
      } as const;
      const noOp = await authority.executeMutation(noOpRequest);
      expect(noOp).toMatchObject({
        changed: false,
        result: { changed: 0, created: [], undone: true },
      });
      expect(authority.readStore().operationBatches()).toEqual([committed.result]);
      expect(authority.inspectAuthority().targetReservations).toHaveLength(1);
      await expect(authority.executeMutation(noOpRequest))
        .resolves.toEqual({ ...noOp, replayed: true });
    } finally {
      authority.close();
    }
  });
  it("undoes a finalized batch through an exact replayable receipt", async () => {
    const { authority, firstId } = await dataAuthority();
    try {
      const applied = await authority.executeMutation({
        requestId: requestId("m"),
        route: "batch.apply",
        payload: {
          source: "user", summary: "Complete first",
          mutations: [{
            kind: "update", table: "documents", id: firstId, patch: { status: "done" },
          }],
        },
      });
      const batch = applied.result as { id: string };
      const request = {
        requestId: requestId("n"), route: "batch.undo", payload: { id: batch.id },
      } as const;

      const undone = await authority.executeMutation(request);
      expect(undone).toMatchObject({
        changed: true,
        replayed: false,
        result: { id: batch.id, changed: 1, undone: true },
      });
      expect(authority.query({
        from: "documents", where: [{ field: "id", op: "eq", value: firstId }],
      })[0]).toMatchObject({ status: "todo" });
      expect(authority.readStore().operationBatches()[0])
        .toMatchObject({ id: batch.id, changed: 1, undone: true });
      await expect(authority.executeMutation(request))
        .resolves.toEqual({ ...undone, replayed: true });
    } finally {
      authority.close();
    }
  });

  it("fails closed before reservation when batch undo sees stale row state", async () => {
    const { authority, firstId } = await dataAuthority();
    try {
      const applied = await authority.executeMutation({
        requestId: requestId("o"),
        route: "batch.apply",
        payload: {
          source: "user", summary: "Complete first",
          mutations: [{
            kind: "update", table: "documents", id: firstId, patch: { status: "done" },
          }],
        },
      });
      await authority.executeMutation({
        requestId: requestId("p"),
        route: "store.update",
        payload: { table: "documents", id: firstId, patch: { name: "Changed later" } },
      });
      const before = authority.inspectAuthority();

      await expect(authority.executeMutation({
        requestId: requestId("q"),
        route: "batch.undo",
        payload: { id: (applied.result as { id: string }).id },
      })).rejects.toThrow(/changed after/i);

      expect(authority.query({
        from: "documents", where: [{ field: "id", op: "eq", value: firstId }],
      })[0]).toMatchObject({ name: "Changed later", status: "done" });
      expect(authority.readStore().operationBatches()[0]).toMatchObject({ undone: false });
      expect(authority.inspectAuthority().targetReservations)
        .toEqual(before.targetReservations);
      expect(authority.inspectAuthority().catalogReservations)
        .toEqual(before.catalogReservations);
    } finally {
      authority.close();
    }
  });

  it("restores the latest row snapshot and preserves restore no-ops", async () => {
    const { authority, firstId } = await dataAuthority((store, _driver, id) => {
      store.update("documents", id, { name: "Changed" });
    });
    try {
      const restored = await authority.executeMutation({
        requestId: requestId("r"),
        route: "row.restore",
        payload: { table: "documents", id: firstId },
      });
      expect(restored).toMatchObject({
        changed: true,
        replayed: false,
        result: { id: firstId, name: "First" },
      });
      expect(authority.query({
        from: "documents", where: [{ field: "id", op: "eq", value: firstId }],
      })[0]).toMatchObject({ name: "First" });
      const afterRestore = authority.inspectAuthority();
      const noOp = await authority.executeMutation({
        requestId: requestId("s"),
        route: "row.restore",
        payload: { table: "documents", id: firstId },
      });
      expect(noOp).toMatchObject({
        changed: false,
        replayed: false,
        result: { id: firstId, name: "First" },
      });
      expect(authority.inspectAuthority().targetReservations)
        .toEqual(afterRestore.targetReservations);
      expect(authority.inspectAuthority().catalogReservations)
        .toEqual(afterRestore.catalogReservations);
    } finally {
      authority.close();
    }
  });
  it("removes a column reversibly through an atomic registry read-back", async () => {
    const { authority } = await dataAuthority();
    try {
      const request = {
        requestId: requestId("t"),
        route: "schema.removeColumn",
        payload: { table: "documents", column: "obsolete" },
      } as const;
      const removed = await authority.executeMutation(request);
      expect(removed).toMatchObject({ changed: true, replayed: false });
      const tables = removed.result as Array<{
        name: string;
        columns: Array<{ name: string; hidden?: boolean }>;
      }>;
      expect(tables.find(table => table.name === "documents")?.columns)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ name: "obsolete", hidden: true }),
        ]));
      expect(authority.query({ from: "documents" })[0]).not.toHaveProperty("obsolete");
      expect(removed.result).toEqual([...authority.readStore().registrySnapshot().values()]);
      await expect(authority.executeMutation(request))
        .resolves.toEqual({ ...removed, replayed: true });
    } finally {
      authority.close();
    }
  });

  it("purges only eligible retained bytes atomically and preserves purge no-ops", async () => {
    const { authority } = await dataAuthority((_store, driver) => {
      const bytes = new Uint8Array([37, 80, 68, 70]);
      driver.exec(
        `INSERT INTO "__clay_attachments"(
           id, name, mime, size, sha256, bytes, created_at, deleted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ["file_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "old.pdf", "application/pdf",
          bytes.byteLength, sha256HexSync(bytes), bytes,
          "2019-12-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z"],
      );
    });
    try {
      const purged = await authority.executeMutation({
        requestId: requestId("h"), route: "attachment.purge", payload: {},
      });
      expect(purged).toMatchObject({
        changed: true,
        replayed: false,
        result: { files: 1, bytes: 4 },
      });
      expect(authority.readStore().attachmentStorage()).toEqual({
        activeFiles: 0, activeBytes: 0, deletedFiles: 0, deletedBytes: 0,
      });

      const noOp = await authority.executeMutation({
        requestId: requestId("i"), route: "attachment.purge", payload: {},
      });
      expect(noOp).toMatchObject({
        changed: false,
        replayed: false,
        result: { files: 0, bytes: 0 },
      });
      expect(authority.inspectAuthority().targetReservations).toHaveLength(1);
      expect(authority.inspectAuthority().catalogReservations).toHaveLength(1);
    } finally {
      authority.close();
    }
  });
});
