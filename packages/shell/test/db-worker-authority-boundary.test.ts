import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ClayStore,
  deriveInverse,
  openMemoryDriver,
  type DbDriver,
  type ForwardOpT,
} from "@clay/kernel";
import { ClayError } from "@clay/kernel/errors";
import { ProductionStoreAuthority } from "../../kernel/src/production-authority";

const workerBoot = vi.hoisted(() => ({ target: null as unknown }));

vi.mock("@clay/kernel/worker-authority", () => ({
  ProductionStoreAuthority: {
    bootBrowser: async (): Promise<unknown> => {
      if (!workerBoot.target) throw new Error("worker authority test target is missing");
      return workerBoot.target;
    },
  },
}));

const opaque = (prefix: string, char: string): string => `${prefix}_${char.repeat(26)}`;
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

type WorkerScope = {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: ReturnType<typeof vi.fn>;
};

async function productionAuthority(withPanel = false): Promise<{
  authority: ProductionStoreAuthority;
  driver: DbDriver;
}> {
  const driver = await openMemoryDriver();
  driver.exec("ATTACH DATABASE ':memory:' AS catalog");
  const rawStore = ClayStore.fromDriver(driver);
  const operations: ForwardOpT[] = [{
    op: "create_table",
    table: "projects",
    columns: [{ name: "name", type: "text", required: true }],
  }];
  rawStore.commit({
    intent: "create projects",
    summary: "Created projects.",
    migration: {
      operations,
      inverse: deriveInverse(operations, rawStore.registrySnapshot()),
    },
  });
  if (withPanel) rawStore.commit({
    intent: "seed panel",
    summary: "Added project table.",
    migration: null,
    panels: [{
      panel_id: "project_table",
      title: "Projects",
      placement: { region: "main", order: 0 },
      code: "export default function(clay){}",
      declared_queries: [{ from: "projects" }],
      declared_writes: [],
    }],
  });
  return {
    driver,
    authority: ProductionStoreAuthority.adoptLegacy(driver, {
      inventory: legacyInventory,
      storageKey: "default",
      displayName: "My app",
      appInstanceId: opaque("app", "a"),
      generationId: opaque("gen", "b"),
      namespaceId: opaque("ns", "c"),
      adoptionOperationId: opaque("op", "d"),
      releaseId: opaque("rel", "e"),
      nowMs: Date.now(),
      leaseTtlMs: 60_000,
    }),
  };
}

async function loadWorker(target: unknown): Promise<WorkerScope> {
  workerBoot.target = target;
  const scope: WorkerScope = { onmessage: null, postMessage: vi.fn() };
  vi.stubGlobal("self", scope);
  vi.resetModules();
  await import("../src/worker/db-worker");
  await dispatch(scope, { id: 1, op: "boot", payload: {} });
  return scope;
}

async function dispatch(
  scope: WorkerScope,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const call = scope.postMessage.mock.calls.length;
  if (!scope.onmessage) throw new Error("worker message handler is missing");
  scope.onmessage({ data, ports: [] } as unknown as MessageEvent);
  await vi.waitFor(() => expect(scope.postMessage.mock.calls.length).toBe(call + 1));
  return scope.postMessage.mock.calls[call]![0] as Record<string, unknown>;
}

afterEach(() => {
  workerBoot.target = null;
  vi.unstubAllGlobals();
});

describe("db-worker authority payload boundary", () => {
  it("passes accessor payloads untouched to descriptor-only route validation", async () => {
    const { authority } = await productionAuthority(true);
    try {
      const scope = await loadWorker(authority);
      let reads = 0;
      const payload: Record<string, unknown> = { panelId: "project_table" };
      Object.defineProperty(payload, "title", {
        enumerable: true,
        get: () => { reads += 1; return "Getter title"; },
      });

      const response = await dispatch(scope, {
        id: 2,
        requestId: opaque("req", "a"),
        op: "renamePanel",
        payload,
      });

      expect(reads).toBe(0);
      expect(response).toMatchObject({
        ok: false,
        error: { message: expect.stringMatching(/invalid/i) },
      });
      expect(authority.inspectAuthority().targetReservations).toEqual([]);
    } finally {
      authority.close();
    }
  });

  it("rejects missing and wrongly typed route fields before reservation", async () => {
    const { authority } = await productionAuthority(true);
    try {
      const scope = await loadWorker(authority);
      const missing = await dispatch(scope, {
        id: 2,
        requestId: opaque("req", "b"),
        op: "renamePanel",
        payload: { panelId: "project_table" },
      });
      const wrongType = await dispatch(scope, {
        id: 3,
        requestId: opaque("req", "c"),
        op: "setCheckpoint",
        payload: { version: "1", label: "Checkpoint" },
      });

      expect(missing).toMatchObject({
        ok: false, error: { message: expect.stringMatching(/invalid/i) },
      });
      expect(wrongType).toMatchObject({
        ok: false, error: { message: expect.stringMatching(/invalid/i) },
      });
      expect(authority.inspectAuthority().targetReservations).toEqual([]);
    } finally {
      authority.close();
    }
  });

  it("does not collapse differently typed reuse into an exact replay", async () => {
    const { authority } = await productionAuthority();
    try {
      const scope = await loadWorker(authority);
      const requestId = opaque("req", "d");
      const first = await dispatch(scope, {
        id: 2,
        requestId,
        op: "setCheckpoint",
        payload: { version: 1, label: "Checkpoint" },
      });
      const reused = await dispatch(scope, {
        id: 3,
        requestId,
        op: "setCheckpoint",
        payload: { version: "1", label: "Checkpoint" },
      });

      expect(first).toMatchObject({ ok: true });
      expect(reused).toMatchObject({
        ok: false,
        error: { message: expect.stringMatching(/invalid/i) },
      });
    } finally {
      authority.close();
    }
  });

  it("lets a stale authority reject before worker coercion can invoke caller code", async () => {
    const stale = {
      readStore: () => ({}),
      bootInfo: () => ({
        seeded: false,
        shellId: null,
        selectedAppInstanceId: opaque("app", "a"),
        catalogGeneration: "0",
        apps: [],
      }),
      executeMutation: (): never => {
        throw new ClayError("E_STALE_WRITE_EPOCH", "stale worker authority");
      },
    };
    const scope = await loadWorker(stale);
    let reads = 0;
    const payload: Record<string, unknown> = { panelId: "project_table" };
    Object.defineProperty(payload, "title", {
      enumerable: true,
      get: () => { reads += 1; return "Unsafe"; },
    });

    const response = await dispatch(scope, {
      id: 2,
      requestId: opaque("req", "e"),
      op: "renamePanel",
      payload,
    });

    expect(reads).toBe(0);
    expect(response).toMatchObject({
      ok: false,
      error: { message: "stale worker authority" },
    });
  });

  it("does not synthesize a default for an omitted direct-route payload", async () => {
    let received: unknown = Symbol("not called");
    const stale = {
      readStore: () => ({}),
      bootInfo: () => ({
        seeded: false,
        shellId: null,
        selectedAppInstanceId: opaque("app", "a"),
        catalogGeneration: "0",
        apps: [],
      }),
      executeMutation: (input: unknown): never => {
        if (typeof input === "object" && input !== null) {
          const descriptor = Reflect.getOwnPropertyDescriptor(input, "payload");
          received = descriptor && "value" in descriptor ? descriptor.value : Symbol("missing");
        }
        throw new ClayError("E_STALE_WRITE_EPOCH", "stale worker authority");
      },
    };
    const scope = await loadWorker(stale);

    await dispatch(scope, {
      id: 2,
      requestId: opaque("req", "f"),
      op: "renamePanel",
    });

    expect(received).toBeUndefined();
  });
});
