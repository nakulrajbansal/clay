import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ClayStore,
  deriveInverse,
  openMemoryDriver,
  type ForwardOpT,
} from "@clay/kernel";
import { ProductionStoreAuthority } from "../../kernel/src/production-authority";

const workerBoot = vi.hoisted(() => ({ target: null as unknown }));
vi.mock("@clay/kernel/worker-authority", () => ({
  ProductionStoreAuthority: {
    bootBrowser: async (): Promise<unknown> => workerBoot.target,
  },
}));

const opaque = (prefix: string, char: string): string => `${prefix}_${char.repeat(26)}`;
const ROW_CANARY = "row-value-must-never-reach-model";
type WorkerScope = {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: ReturnType<typeof vi.fn>;
};
type PlannerRequest = {
  v: 1;
  kind: "planner.request";
  epoch: string;
  generation: number;
  contextId: string;
  attempt: 0 | 1;
  sequence: number;
  context: Record<string, unknown>;
  repair: null | { priorRaw: string; diagnostics: string[] };
};

async function authorityWithProject(withPanel = false): Promise<ProductionStoreAuthority> {
  const driver = await openMemoryDriver();
  driver.exec("ATTACH DATABASE ':memory:' AS catalog");
  const store = ClayStore.fromDriver(driver);
  const operations: ForwardOpT[] = [{
    op: "create_table", table: "projects",
    columns: [{ name: "name", type: "text", required: true }],
  }];
  store.commit({
    intent: "create projects", summary: "Created projects.",
    migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) },
    ...(withPanel ? { panels: [{
      panel_id: "project_table", title: "Projects",
      placement: { region: "main" as const, order: 0 },
      code: "export default function(clay){clay.ui.render(h(EmptyState,{label:\"Projects\"}));}",
      declared_queries: [{ from: "projects" }], declared_writes: [],
    }] } : {}),
  });
  store.insert("projects", { name: ROW_CANARY });
  return ProductionStoreAuthority.adoptLegacy(driver, {
    inventory: {
      state: "complete", catalogPresent: false,
      namespaces: [{ storageKey: "default", userFile: "/user.db", systemFile: "/system.db", kind: "legacy" }],
    },
    storageKey: "default", displayName: "My app",
    appInstanceId: opaque("app", "a"), generationId: opaque("gen", "b"),
    namespaceId: opaque("ns", "c"), adoptionOperationId: opaque("op", "d"),
    releaseId: opaque("rel", "e"), nowMs: Date.now(), leaseTtlMs: 60_000,
  });
}

async function dispatch(
  scope: WorkerScope,
  data: Record<string, unknown>,
  ports: MessagePort[] = [],
): Promise<Record<string, unknown>> {
  const call = scope.postMessage.mock.calls.length;
  if (!scope.onmessage) throw new Error("worker message handler is missing");
  scope.onmessage({ data, ports } as unknown as MessageEvent);
  await vi.waitFor(() => expect(scope.postMessage.mock.calls.length).toBe(call + 1),
    { timeout: 5_000 });
  return scope.postMessage.mock.calls[call]![0] as Record<string, unknown>;
}

async function loadUnbootedWorker(authority: ProductionStoreAuthority): Promise<WorkerScope> {
  workerBoot.target = authority;
  const scope: WorkerScope = { onmessage: null, postMessage: vi.fn() };
  vi.stubGlobal("self", scope);
  vi.resetModules();
  await import("../src/worker/db-worker");
  return scope;
}

async function loadWorker(authority: ProductionStoreAuthority): Promise<WorkerScope> {
  const scope = await loadUnbootedWorker(authority);
  expect(await dispatch(scope, { id: 1, op: "boot", payload: {} })).toMatchObject({ ok: true });
  return scope;
}

function validPlan(): string {
  return JSON.stringify({
    api: 1,
    summary: "Adds a project summary panel.",
    user_facing_diff: [{ kind: "add_panel", detail: "Adds a project summary panel" }],
    clarifying_question: null,
    assumptions: [], migration: null,
    panels: [{
      panel_id: "project_summary", title: "Project summary",
      placement: { region: "side", order: 0 },
      code: "export default function(clay){clay.ui.render(h(EmptyState,{label:\"Projects\"}));}",
      declared_queries: [{ from: "projects" }], declared_writes: [],
    }],
    remove_panels: [], confidence: 0.9,
  });
}

function response(request: PlannerRequest, result: unknown): Record<string, unknown> {
  return {
    v: 1, kind: "planner.response",
    epoch: request.epoch, generation: request.generation,
    contextId: request.contextId, attempt: request.attempt, sequence: request.sequence,
    result,
  };
}

async function plannerCall(
  scope: WorkerScope,
  op: "intent" | "repairPanel",
  payload: Record<string, unknown>,
  onRequest: (request: PlannerRequest, port: MessagePort) => void,
): Promise<Record<string, unknown>> {
  const channel = new MessageChannel();
  channel.port1.onmessage = event => {
    const message = event.data as PlannerRequest | Record<string, unknown>;
    if (message.kind === "planner.finalize") {
      channel.port1.postMessage({
        v: 1, kind: "planner.finalized", epoch: message.epoch,
        generation: message.generation, contextId: message.contextId,
        sequence: message.sequence,
        nonce: (message as Record<string, unknown>).nonce,
      });
      return;
    }
    onRequest(message as PlannerRequest, channel.port1);
  };
  channel.port1.start();
  try {
    return await dispatch(scope,
      { id: scope.postMessage.mock.calls.length + 1, op, payload }, [channel.port2]);
  } finally {
    channel.port1.close();
  }
}

afterEach(() => {
  workerBoot.target = null;
  vi.unstubAllGlobals();
});

describe("per-intent DB-worker planner bridge", () => {
  it("keeps authority and Store ports unavailable until boot reconciliation completes", async () => {
    const authority = await authorityWithProject();
    const reconcile = authority.reconcileInterruptedPlannerAttempts.bind(authority);
    let releaseReconciliation!: () => void;
    let reconciliationStarted!: () => void;
    const release = new Promise<void>(resolve => { releaseReconciliation = resolve; });
    const started = new Promise<void>(resolve => { reconciliationStarted = resolve; });
    vi.spyOn(authority, "reconcileInterruptedPlannerAttempts").mockImplementation(async () => {
      reconciliationStarted();
      await release;
      return reconcile();
    });
    const channel = new MessageChannel();
    const scope = await loadUnbootedWorker(authority);
    try {
      const bootEvent = { data: { id: 1, op: "boot", payload: {} }, ports: [] } as unknown as MessageEvent;
      scope.onmessage?.(bootEvent);
      await started;

      expect(await dispatch(scope, {
        id: 2, op: "setSetting", payload: { key: "theme", value: "dark" },
      })).toMatchObject({ ok: false, error: { code: "E_CATALOG_UNAVAILABLE" } });
      expect(await dispatch(scope, {
        id: 3, op: "storePort", payload: { target: "live" },
      }, [channel.port2])).toMatchObject({
        ok: false, error: { code: "E_CATALOG_UNAVAILABLE" },
      });

      releaseReconciliation();
      await vi.waitFor(() => expect(scope.postMessage.mock.calls.some(
        call => call[0]?.id === 1 && call[0]?.ok === true,
      )).toBe(true));
    } finally {
      releaseReconciliation();
      await vi.waitFor(() => expect(scope.postMessage.mock.calls.some(
        call => call[0]?.id === 1,
      )).toBe(true));
      channel.port1.close();
      authority.close();
    }
  });

  it("closes a boot candidate when reconciliation fails", async () => {
    const authority = await authorityWithProject();
    const close = vi.spyOn(authority, "close");
    vi.spyOn(authority, "reconcileInterruptedPlannerAttempts")
      .mockRejectedValue(new Error("reconciliation failed"));
    const scope = await loadUnbootedWorker(authority);

    expect(await dispatch(scope, { id: 1, op: "boot", payload: {} })).toMatchObject({
      ok: false, error: { message: "reconciliation failed" },
    });
    expect(close).toHaveBeenCalledOnce();
    expect(await dispatch(scope, {
      id: 2, op: "setSetting", payload: { key: "theme", value: "dark" },
    })).toMatchObject({ ok: false, error: { code: "E_CATALOG_UNAVAILABLE" } });

    if (close.mock.calls.length === 0) authority.close();
  });

  it("reconciles interrupted attempts before publishing current boot authority", async () => {
    const authority = await authorityWithProject();
    try {
      await authority.plannerMutations().beginAttempt("interrupted before restart");
      expect(authority.readStore().attemptStats().failed).toBe(0);
      const scope = await loadWorker(authority);
      expect(authority.readStore().attemptStats().failed).toBe(1);
      const status = await dispatch(scope, { id: 2, op: "status" });
      expect(status).toMatchObject({ ok: true });
      expect(authority.bootInfo().catalogGeneration)
        .toBe(authority.inspectAuthority().catalog.catalogGeneration);
    } finally { authority.close(); }
  });

  it("does not reconcile a live attempt on a duplicate boot command", async () => {
    const authority = await authorityWithProject();
    const channel = new MessageChannel();
    try {
      const scope = await loadWorker(authority);
      let request!: PlannerRequest;
      const observed = new Promise<void>(resolve => {
        channel.port1.onmessage = event => {
          const message = event.data as PlannerRequest;
          if (message.kind === "planner.request") { request = message; resolve(); }
        };
      });
      channel.port1.start();
      scope.onmessage?.({
        data: { id: 63, op: "intent", payload: { text: "add a panel" } },
        ports: [channel.port2],
      } as unknown as MessageEvent);
      await observed;
      expect(authority.readStore().attemptStats().failed).toBe(0);
      expect(await dispatch(scope, { id: 64, op: "boot", payload: {} }))
        .toMatchObject({ ok: true });
      expect(authority.readStore().attemptStats().failed).toBe(0);
      channel.port1.postMessage({
        v: 1, kind: "planner.cancel", epoch: request.epoch,
        generation: request.generation, contextId: request.contextId,
        attempt: request.attempt, sequence: request.sequence,
      });
      await vi.waitFor(() => expect(authority.readStore().attemptStats().failed).toBe(1));
    } finally {
      channel.port1.close();
      authority.close();
    }
  });

  it("accepts one valid first pass, exposes no rows, and leaves live state unmodified", async () => {
    const authority = await authorityWithProject();
    try {
      const scope = await loadWorker(authority);
      const before = authority.readStore().headVersion();
      const requests: PlannerRequest[] = [];
      const outcome = await plannerCall(scope, "intent", { text: "add a project summary" }, (request, port) => {
        requests.push(request);
        expect(Object.keys(request).sort()).toEqual([
          "attempt", "context", "contextId", "epoch", "generation", "kind", "repair", "sequence", "v",
        ]);
        expect(JSON.stringify(request)).not.toContain(ROW_CANARY);
        port.postMessage(response(request, { ok: true, raw: validPlan() }));
      });

      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        v: 1, kind: "planner.request", attempt: 0, sequence: 0, generation: 1, repair: null,
      });
      expect(requests[0]!.epoch).toMatch(/^boot_[a-z2-7]{26}$/);
      expect(requests[0]!.contextId).toMatch(/^ctx_[a-z2-7]{26}$/);
      expect(outcome).toMatchObject({ ok: true, result: { status: "preview" } });
      expect(authority.readStore().headVersion()).toBe(before);
    } finally { authority.close(); }
  });

  it("authorizes exactly one repair with the original immutable context", async () => {
    const authority = await authorityWithProject();
    try {
      const scope = await loadWorker(authority);
      const requests: PlannerRequest[] = [];
      const outcome = await plannerCall(scope, "intent", { text: "add a project summary" }, (request, port) => {
        requests.push(request);
        if (request.attempt === 0) {
          request.context.intent = "hostile shell mutation";
          port.postMessage(response(request, { ok: true, raw: "{" }));
        } else {
          port.postMessage(response(request, { ok: true, raw: validPlan() }));
        }
      });

      expect(requests).toHaveLength(2);
      expect(requests.map(request => [request.attempt, request.sequence])).toEqual([[0, 0], [1, 1]]);
      expect(requests[1]).toMatchObject({
        epoch: requests[0]!.epoch,
        generation: requests[0]!.generation,
        contextId: requests[0]!.contextId,
        context: { intent: "add a project summary" },
        repair: { priorRaw: "{", diagnostics: expect.any(Array) },
      });
      expect(outcome).toMatchObject({
        ok: true, result: { status: "preview", preview: { repaired: true } },
      });
    } finally { authority.close(); }
  });

  it.each([
    ["wrong generation", (request: PlannerRequest) => ({ ...response(request, { ok: true, raw: validPlan() }), generation: request.generation + 1 })],
    ["wrong attempt", (request: PlannerRequest) => ({ ...response(request, { ok: true, raw: validPlan() }), attempt: 1 })],
    ["unknown field", (request: PlannerRequest) => ({ ...response(request, { ok: true, raw: validPlan() }), keep: true })],
    ["oversized raw", (request: PlannerRequest) => response(request, { ok: true, raw: "x".repeat(70_000) })],
  ])("fails closed on %s", async (_label, makeResponse) => {
    const authority = await authorityWithProject();
    try {
      const scope = await loadWorker(authority);
      const before = authority.readStore().headVersion();
      const outcome = await plannerCall(scope, "intent", { text: "add a panel" }, (request, port) => {
        port.postMessage(makeResponse(request));
      });
      expect(outcome).toMatchObject({ ok: false });
      expect(authority.readStore().headVersion()).toBe(before);
    } finally { authority.close(); }
  });

  it("rejects a prequeued finalization acknowledgement without its one-use challenge", async () => {
    const authority = await authorityWithProject();
    try {
      const scope = await loadWorker(authority);
      const outcome = await plannerCall(scope, "intent", { text: "add a panel" },
        (request, port) => {
          port.postMessage(response(request, { ok: true, raw: validPlan() }));
          port.postMessage({
            v: 1, kind: "planner.finalized", epoch: request.epoch,
            generation: request.generation, contextId: request.contextId,
            sequence: request.sequence + 1,
          });
        });
      expect(outcome).toMatchObject({ ok: false });
      expect(authority.readStore().attemptStats().failed).toBe(1);
      expect(await dispatch(scope, { id: 67, op: "keep" })).toMatchObject({ ok: false });
    } finally { authority.close(); }
  });

  it("fails closed on a duplicate/out-of-order terminal response", async () => {
    const authority = await authorityWithProject();
    try {
      const scope = await loadWorker(authority);
      const outcome = await plannerCall(scope, "intent", { text: "add a panel" }, (request, port) => {
        const first = response(request, { ok: true, raw: "{" });
        port.postMessage(first);
        port.postMessage(first);
      });
      expect(outcome).toMatchObject({ ok: false });
    } finally { authority.close(); }
  });

  it("fails closed when a duplicate follows an otherwise valid terminal response", async () => {
    const authority = await authorityWithProject();
    try {
      const scope = await loadWorker(authority);
      const before = authority.readStore().headVersion();
      const outcome = await plannerCall(scope, "intent", { text: "add a panel" }, (request, port) => {
        const first = response(request, { ok: true, raw: validPlan() });
        port.postMessage(first);
        port.postMessage(first);
      });
      expect(outcome).toMatchObject({ ok: false });
      expect(authority.readStore().headVersion()).toBe(before);
      expect(authority.readStore().attemptStats().failed).toBe(1);
      expect(await dispatch(scope, { id: 9, op: "keep" })).toMatchObject({ ok: false });
    } finally { authority.close(); }
  });

  it("consumes cancellation once and ignores a late model result", async () => {
    const authority = await authorityWithProject();
    try {
      const scope = await loadWorker(authority);
      const before = authority.readStore().headVersion();
      const outcome = await plannerCall(scope, "intent", { text: "add a panel" }, (request, port) => {
        port.postMessage({
          v: 1, kind: "planner.cancel", epoch: request.epoch,
          generation: request.generation, contextId: request.contextId,
          attempt: request.attempt, sequence: request.sequence,
        });
        port.postMessage(response(request, { ok: true, raw: validPlan() }));
      });
      expect(outcome).toMatchObject({ ok: false });
      expect(authority.readStore().headVersion()).toBe(before);
      expect(authority.readStore().attemptStats().failed).toBe(1);
      expect(await dispatch(scope, { id: 9, op: "keep" })).toMatchObject({ ok: false });
    } finally { authority.close(); }
  });

  it("fails and finalizes a silent planner round at the worker watchdog", async () => {
    const authority = await authorityWithProject();
    const channel = new MessageChannel();
    try {
      const scope = await loadWorker(authority);
      const requestObserved = new Promise<void>(resolve => {
        channel.port1.onmessage = event => {
          const message = event.data as { kind?: string };
          if (message.kind === "planner.request") resolve();
        };
      });
      channel.port1.start();
      const beforeResponses = scope.postMessage.mock.calls.length;
      vi.useFakeTimers();
      scope.onmessage?.({
        data: { id: 69, op: "intent", payload: { text: "add a panel" } },
        ports: [channel.port2],
      } as unknown as MessageEvent);
      await requestObserved;
      await vi.advanceTimersByTimeAsync(180_001);
      await Promise.resolve();
      expect(scope.postMessage.mock.calls.length).toBe(beforeResponses + 1);
      expect(scope.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({ ok: false });
      expect(authority.readStore().attemptStats().failed).toBe(1);
    } finally {
      vi.useRealTimers();
      channel.port1.close();
      authority.close();
    }
  });

  it("closes the shadow when planner finalization acknowledgement times out", async () => {
    const authority = await authorityWithProject();
    const channel = new MessageChannel();
    try {
      const scope = await loadWorker(authority);
      const beforeVersion = authority.readStore().headVersion();
      const finalizeObserved = new Promise<void>(resolve => {
        channel.port1.onmessage = event => {
          const message = event.data as PlannerRequest | Record<string, unknown>;
          if (message.kind === "planner.request") {
            channel.port1.postMessage(response(message as PlannerRequest, {
              ok: true, raw: validPlan(),
            }));
          } else if (message.kind === "planner.finalize") resolve();
        };
      });
      channel.port1.start();
      const beforeResponses = scope.postMessage.mock.calls.length;
      vi.useFakeTimers();
      scope.onmessage?.({
        data: { id: 68, op: "intent", payload: { text: "add a panel" } },
        ports: [channel.port2],
      } as unknown as MessageEvent);
      await finalizeObserved;
      await vi.advanceTimersByTimeAsync(180_001);
      await Promise.resolve();
      expect(scope.postMessage.mock.calls.length).toBe(beforeResponses + 1);
      expect(scope.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({ ok: false });
      expect(authority.readStore().headVersion()).toBe(beforeVersion);
      expect(authority.readStore().attemptStats().failed).toBe(1);
    } finally {
      vi.useRealTimers();
      channel.port1.close();
      authority.close();
    }
  });

  it("records clarification only after finalization acknowledgement", async () => {
    const authority = await authorityWithProject();
    const channel = new MessageChannel();
    try {
      const scope = await loadWorker(authority);
      const clarify = JSON.stringify({
        api: 1, summary: "", user_facing_diff: [],
        clarifying_question: "Which view should change?", assumptions: [],
        migration: null, panels: [], remove_panels: [], confidence: 0.3,
      });
      const finalizeObserved = new Promise<void>(resolve => {
        channel.port1.onmessage = event => {
          const message = event.data as PlannerRequest | Record<string, unknown>;
          if (message.kind === "planner.request") channel.port1.postMessage(
            response(message as PlannerRequest, { ok: true, raw: clarify }),
          );
          else if (message.kind === "planner.finalize") resolve();
        };
      });
      channel.port1.start();
      const beforeResponses = scope.postMessage.mock.calls.length;
      vi.useFakeTimers();
      scope.onmessage?.({
        data: { id: 66, op: "intent", payload: { text: "change a view" } },
        ports: [channel.port2],
      } as unknown as MessageEvent);
      await finalizeObserved;
      await vi.advanceTimersByTimeAsync(180_001);
      await Promise.resolve();
      expect(scope.postMessage.mock.calls.length).toBe(beforeResponses + 1);
      expect(scope.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({ ok: false });
      expect(authority.readStore().attemptStats()).toMatchObject({ clarify: 0, failed: 1 });
    } finally {
      vi.useRealTimers();
      channel.port1.close();
      authority.close();
    }
  });

  it("does not turn a committed Keep into failure when shadow cleanup throws", async () => {
    const authority = await authorityWithProject();
    const planner = authority.plannerMutations();
    const wrappedPlanner = {
      ...planner,
      preparePreview: async (input: Parameters<typeof planner.preparePreview>[0]) => {
        const preview = await planner.preparePreview(input);
        return {
          ...preview,
          shadow: {
            query: preview.shadow.query,
            semanticSchemaTrace: preview.shadow.semanticSchemaTrace,
            asyncStore: preview.shadow.asyncStore,
            close: () => { preview.shadow.close(); throw new Error("cleanup failed"); },
          },
        };
      },
    };
    const wrapped = new Proxy(authority, {
      get(target, property) {
        if (property === "plannerMutations") return () => wrappedPlanner;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    try {
      const scope = await loadWorker(wrapped);
      const before = authority.readStore().headVersion();
      const outcome = await plannerCall(scope, "intent", { text: "add a panel" },
        (request, port) => port.postMessage(response(request, { ok: true, raw: validPlan() })));
      expect(outcome).toMatchObject({ ok: true, result: { status: "preview" } });
      const requestId = `req_${"k".repeat(26)}`;
      const kept = await dispatch(scope, { id: 72, requestId, op: "keep" });
      expect(kept).toMatchObject({ ok: true, result: { version: before + 1 } });
      expect(authority.readStore().attemptStats().kept).toBe(1);
      expect(await dispatch(scope, { id: 73, requestId, op: "keep" })).toEqual({
        id: 73, ok: true, result: { version: before + 1 },
      });
    } finally { authority.close(); }
  });

  it("waits for Store RPC before shutdown acknowledgement", async () => {
    const authority = await authorityWithProject();
    const endpoint = authority.asyncStore();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const begun = new Promise<void>(resolve => { started = resolve; });
    const delayed = {
      query: async (q: Parameters<typeof endpoint.query>[0]) => {
        started(); await gate; return endpoint.query(q);
      },
      insert: endpoint.insert, update: endpoint.update,
      softDelete: endpoint.softDelete, registryTables: endpoint.registryTables,
    };
    Object.defineProperty(authority, "asyncStore", { value: () => delayed, configurable: true });
    const channel = new MessageChannel();
    try {
      const scope = await loadWorker(authority);
      await dispatch(scope, { id: 74, op: "storePort", payload: { target: "live" } }, [channel.port2]);
      const response = new Promise<Record<string, unknown>>(resolve => {
        channel.port1.onmessage = event => {
          const value = event.data as Record<string, unknown>;
          if (value.kind === "store.quiesce") {
            channel.port1.postMessage({ v: 1, kind: "store.quiesced", nonce: value.nonce });
            return;
          }
          resolve(value);
        };
      });
      channel.port1.start();
      channel.port1.postMessage({
        id: 1, requestId: `req_${"q".repeat(26)}`, op: "query",
        payload: { q: { from: "projects", select: ["id"] } },
      });
      const beforeShutdown = scope.postMessage.mock.calls.length;
      scope.onmessage?.({ data: { id: 75, op: "shutdown" }, ports: [] } as unknown as MessageEvent);
      await Promise.race([
        begun,
        new Promise((_, reject) => setTimeout(() => reject(new Error("queued Store RPC was not admitted")), 1_000)),
      ]);
      await Promise.resolve();
      await Promise.resolve();
      expect(scope.postMessage.mock.calls.length).toBe(beforeShutdown);
      release();
      expect(await response).toMatchObject({ id: 1, ok: true });
      await vi.waitFor(() => expect(scope.postMessage.mock.calls.length).toBe(beforeShutdown + 1));
      expect(scope.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({ id: 75, ok: true });
    } finally {
      release();
      channel.port1.close();
      authority.close();
    }
  });

  it("durably discards an open preview before acknowledging worker shutdown", async () => {
    const authority = await authorityWithProject();
    let closeObserved = false;
    const wrapped = new Proxy(authority, {
      get(target, property) {
        if (property === "close") return () => { closeObserved = true; };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    try {
      const scope = await loadWorker(wrapped);
      const before = authority.readStore().headVersion();
      const outcome = await plannerCall(scope, "intent", { text: "add a panel" },
        (request, port) => port.postMessage(response(request, { ok: true, raw: validPlan() })));
      expect(outcome).toMatchObject({ ok: true, result: { status: "preview" } });

      const shutdown = await dispatch(scope, { id: 70, op: "shutdown" });
      expect(shutdown).toMatchObject({ ok: true, result: null });
      expect(closeObserved).toBe(true);
      expect(authority.readStore().headVersion()).toBe(before);
      expect(authority.readStore().attemptStats().discarded).toBe(1);
      expect(await dispatch(scope, { id: 71, op: "keep" })).toMatchObject({ ok: false });
    } finally { authority.close(); }
  });

  it("returns a bounded provider failure without repair", async () => {
    const authority = await authorityWithProject();
    try {
      const scope = await loadWorker(authority);
      let calls = 0;
      const outcome = await plannerCall(scope, "intent", { text: "add a panel" }, (request, port) => {
        calls++;
        port.postMessage(response(request, {
          ok: false, error: { code: "E_MODEL", message: "provider unavailable" },
        }));
      });
      expect(calls).toBe(1);
      expect(outcome).toMatchObject({
        ok: true,
        result: { status: "failed", stage: "plan", reasons: ["provider unavailable"], repaired: false },
      });
    } finally { authority.close(); }
  });

  it("gives repairPanel the same bridge without forwarding hostile runtime text", async () => {
    const authority = await authorityWithProject(true);
    try {
      const scope = await loadWorker(authority);
      const outcome = await plannerCall(scope, "repairPanel", {
        panelId: "project_table", error: `render failed: ${ROW_CANARY}`,
      }, (request, port) => {
        expect(JSON.stringify(request)).not.toContain(ROW_CANARY);
        expect(request.context.intent).toMatch(/^Repair panel/);
        port.postMessage(response(request, { ok: true, raw: validPlan() }));
      });
      expect(outcome).toMatchObject({ ok: true, result: { status: "preview" } });
    } finally { authority.close(); }
  });

  it("rejects a response bound to a prior worker epoch", async () => {
    const firstAuthority = await authorityWithProject();
    const secondAuthority = await authorityWithProject();
    try {
      const firstScope = await loadWorker(firstAuthority);
      let staleEpoch = "";
      await plannerCall(firstScope, "intent", { text: "first" }, (request, port) => {
        staleEpoch = request.epoch;
        port.postMessage(response(request, {
          ok: false, error: { code: "E_MODEL", message: "stop" },
        }));
      });
      const secondScope = await loadWorker(secondAuthority);
      const outcome = await plannerCall(secondScope, "intent", { text: "second" }, (request, port) => {
        port.postMessage({ ...response(request, { ok: true, raw: validPlan() }), epoch: staleEpoch });
      });
      expect(outcome).toMatchObject({ ok: false });
    } finally {
      firstAuthority.close();
      secondAuthority.close();
    }
  });
});
