import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { WorkerClient, type ModelAccess } from "../src/app/worker-client";
import {
  HOSTED_ACCOUNT_CHANGE_KEY, observeHostedAccountChanges, publishHostedAccountChange,
} from "../src/app/account-auth";
import {
  decodeProjectionPlaintextV1,
  type ProjectionArtifactV1,
  type ProjectionRequestV1,
} from "@clay/kernel/projection";

function withCredential(
  base: Omit<ModelAccess, "apiKey">,
  value: string | null,
): ModelAccess {
  return Object.assign(base, { ["api" + "Key"]: value }) as unknown as ModelAccess;
}

const modelBridge = vi.hoisted(() => ({
  rawPlan: vi.fn<(context: unknown) => Promise<string>>(),
  rawRepair: vi.fn<(...args: unknown[]) => Promise<string>>(),
  transports: [] as unknown[],
}));
vi.mock("@clay/mutation/client", () => ({
  MutationClient: class {
    constructor(transport: unknown) { modelBridge.transports.push(transport); }
    rawPlan(context: unknown): Promise<string> { return modelBridge.rawPlan(context); }
    rawRepair(...args: unknown[]): Promise<string> { return modelBridge.rawRepair(...args); }
  },
}));

type Posted = {
  id: number;
  requestId: string;
  op: string;
  payload: Record<string, unknown>;
};

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(resolve(
  process.cwd(), "../kernel/test/fixtures", name,
)));
const projectionPlaintext = fixture("projection-current-view-v1.plaintext.json");
const projectionCsv = fixture("projection-current-view-v1.csv");

function transportedArtifact(): ProjectionArtifactV1 {
  return {
    projection: JSON.parse(JSON.stringify(decodeProjectionPlaintextV1(projectionPlaintext))),
    plaintext: projectionPlaintext.slice(),
    csv: projectionCsv.slice(),
  };
}

function expectJsonDeepFrozen(value: unknown): void {
  if (!value || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectJsonDeepFrozen(child);
}

function harness(reply?: (message: Posted) => unknown): {
  client: WorkerClient; posted: Posted[]; transfers: Transferable[][];
} {
  const posted: Posted[] = [];
  const transfers: Transferable[][] = [];
  const worker = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage(message: Posted, transfer?: Transferable[]): void {
      posted.push(message);
      transfers.push(transfer ?? []);
      queueMicrotask(() => this.onmessage?.({
        data: { id: message.id, ok: true, result: reply?.(message) ?? null },
      }));
    },
    terminate(): void {},
  };
  return { client: new WorkerClient(worker as unknown as Worker), posted, transfers };
}

async function plannerResultForProvider(
  outcome: { raw: string } | { failure: unknown },
  access: ModelAccess,
): Promise<Record<string, unknown>> {
  if ("raw" in outcome) modelBridge.rawPlan.mockResolvedValueOnce(outcome.raw);
  else modelBridge.rawPlan.mockRejectedValueOnce(outcome.failure);
  let plannerPort: MessagePort | null = null;
  const worker = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage(_message: Posted, transfer: Transferable[] = []): void {
      plannerPort = transfer[0] as MessagePort;
    },
    terminate(): void {},
  };
  const client = new WorkerClient(worker as unknown as Worker);
  await client.setModelAccess(access);
  const pending = client.intent("add a board");
  const response = new Promise<Record<string, unknown>>(resolve => {
    plannerPort!.onmessage = event => resolve(event.data as Record<string, unknown>);
    plannerPort!.start();
  });
  plannerPort!.postMessage({
    v: 1, kind: "planner.request", epoch: `boot_${"a".repeat(26)}`,
    generation: 1, contextId: `ctx_${"b".repeat(26)}`, attempt: 0, sequence: 0,
    context: { registry: [], panels: [], recentSummaries: [], intent: "add a board" },
    repair: null,
  });
  const result = await response;
  client.terminate();
  await expect(pending).rejects.toThrow(/terminated/i);
  return result;
}

const plannerResultForRaw = (raw: string, access: ModelAccess) =>
  plannerResultForProvider({ raw }, access);

describe("WorkerClient boot boundary", () => {
  it("returns a canonical catalog projection and sends bounded cache hints", async () => {
    const bootInfo = {
      persistent: true,
      seeded: true,
      shellId: "tracker",
      selectedAppInstanceId: `app_${"a".repeat(26)}`,
      catalogGeneration: "7",
      apps: [{ id: `app_${"a".repeat(26)}`, name: "Tracker", shellId: "tracker" }],
    } as const;
    const { client, posted } = harness(message => message.op === "boot" ? bootInfo : null);
    const hints = [{ id: "default", name: "Tracker", shellId: "tracker" }];
    const result = await client.boot({ requestedAppId: "default", appCache: hints });
    expect(result).toEqual(bootInfo);
    expect(posted[0]).toMatchObject({
      id: 1,
      op: "boot",
      payload: { requestedAppId: "default", appCache: hints },
    });
    expect(posted[0]!.requestId).toMatch(/^req_[a-z2-7]{26}$/);
  });

  it("rejects malformed neutral boot information", async () => {
    const { client } = harness(message => message.op === "boot" ? {
      persistent: "yes", seeded: true, shellId: "tracker", detail: "secret",
    } : null);
    await expect(client.boot({ requestedAppId: "default", appCache: [] }))
      .rejects.toThrow("invalid boot response");
  });
});

describe("WorkerClient files and automation boundaries", () => {
  it("transfers file bytes and exposes only bounded workflow commands", async () => {
    const { client, posted, transfers } = harness();
    const bytes = new ArrayBuffer(8);
    await client.addAttachment({ table: "projects", rowId: "row", field: "files",
      name: "receipt.pdf", mime: "application/pdf", bytes });
    await client.listAutomations();
    await client.runAutomations();
    await client.undoAutomationRun("run");
    expect(posted.map(message => message.op)).toEqual([
      "addAttachment", "listAutomations", "runAutomations", "undoAutomationRun",
    ]);
    expect(transfers[0]).toEqual([bytes]);
    expect(posted[0]?.payload).toMatchObject({
      table: "projects", field: "files", name: "receipt.pdf",
    });
  });

  it("posts every automation, notification, observer, and metric command with an identity", async () => {
    const { client, posted } = harness();
    const automation = {
      name: "Notify",
      enabled: false,
      trigger: { kind: "manual" as const, table: "deals", conditions: [] },
      actions: [{ kind: "notify" as const, title: "Review", body: "Review this deal." }],
    };
    await client.upsertAutomation(automation);
    await client.deleteAutomation("auto_00000000000000000000000000000000");
    await client.simulateAutomation("auto_00000000000000000000000000000000");
    await client.runAutomations();
    await client.runAutomationNow("auto_00000000000000000000000000000000");
    await client.undoAutomationRun("00000000-0000-7000-8000-000000000000");
    await client.markNotificationRead("00000000-0000-7000-8000-000000000001");
    await client.recordPrivateMetric({ type: "trust_surface_opened", surface: "history" });
    await client.setPrivateMetricsEnabled(false);
    await client.clearPrivateMetrics();
    await client.recordFilter("deals", { status: "won" });
    await client.acceptSuggestion("deals", "add_view");
    await client.dismissSuggestion("deals", "add_view");

    expect(posted.map(message => message.op)).toEqual([
      "upsertAutomation", "deleteAutomation", "simulateAutomation", "runAutomations",
      "runAutomationNow", "undoAutomationRun", "markNotificationRead",
      "recordPrivateMetric", "setPrivateMetricsEnabled", "clearPrivateMetrics",
      "recordFilter", "acceptSuggestion", "dismissSuggestion",
    ]);
    expect(posted.every(message => /^req_[a-z2-7]{26}$/.test(message.requestId))).toBe(true);
    expect(new Set(posted.map(message => message.requestId)).size).toBe(posted.length);
    expect(posted[0]!.payload).toEqual({ input: automation });
    expect(posted[7]!.payload).toEqual({
      event: { type: "trust_surface_opened", surface: "history" },
    });
    expect(posted[10]!.payload).toEqual({ name: "deals", payload: { status: "won" } });
    expect(posted[11]!.payload).toEqual({ subject: "deals", kind: "add_view" });
    expect(posted[12]!.payload).toEqual({ subject: "deals", kind: "add_view" });
  });
});

describe("WorkerClient sample boundary", () => {
  it("posts an explicit empty removal payload", async () => {
    const { client, posted } = harness();
    await client.removeSamples();
    expect(posted).toHaveLength(1);
    expect(posted[0]?.op).toBe("removeSamples");
    expect(posted[0]?.payload).toEqual({});
    expect(Object.hasOwn(posted[0]!, "payload")).toBe(true);
  });
});

describe("WorkerClient daily-work boundary", () => {
  it("pins global search, atomic batches, and undo to explicit operations", async () => {
    const { client, posted } = harness();
    await client.globalSearch("acme", 12);
    await client.applyBatch("Complete selected", [{
      kind: "update", table: "tasks", id: "018f0000-0000-7000-8000-000000000001",
      patch: { status: "done" },
    }]);
    await client.undoBatch("018f0000-0000-7000-8000-000000000002");
    expect(posted.map(message => message.op)).toEqual([
      "globalSearch", "applyBatch", "undoBatch",
    ]);
    expect(posted[0]?.payload).toEqual({ term: "acme", limit: 12 });
    expect(posted[1]?.payload).toMatchObject({ source: "user", summary: "Complete selected" });
  });
});

describe("WorkerClient local export boundary", () => {
  it("accepts canonical bytes-only transport without copying transferred buffers", async () => {
    const transport = {
      plaintext: projectionPlaintext.slice(),
      csv: projectionCsv.slice(),
    };
    const { client } = harness(message =>
      message.op === "projectPlaintextV1" ? transport : null);
    const result = await client.projectExport({
      schema: 1,
      kind: "record",
      expectedSchemaVersion: 2,
      tableId: "tbl_018f0000-0000-7000-8000-000000000001",
      fieldIds: ["fld_018f0000-0000-7000-8000-000000000002"],
      recordId: "018f0000-0000-7000-8000-000000000003",
      options: { includeRecordIds: false, redactedFieldIds: [] },
    });
    expect(result.projection).toEqual(decodeProjectionPlaintextV1(projectionPlaintext));
    expect(result.plaintext).toBe(transport.plaintext);
    expect(result.csv).toBe(transport.csv);
    expect(Object.isFrozen(result)).toBe(true);
    expectJsonDeepFrozen(result.projection);
  });

  it("rejects a redundant projection graph outside the closed worker transport", async () => {
    const artifact = transportedArtifact();
    const { client } = harness(message =>
      message.op === "projectPlaintextV1" ? artifact : null);
    await expect(client.projectExport({
      schema: 1,
      kind: "record",
      expectedSchemaVersion: 2,
      tableId: "tbl_018f0000-0000-7000-8000-000000000001",
      fieldIds: ["fld_018f0000-0000-7000-8000-000000000002"],
      recordId: "018f0000-0000-7000-8000-000000000003",
      options: { includeRecordIds: false, redactedFieldIds: [] },
    })).rejects.toThrow(/transport/i);
  });

  it("rejects export bytes that arrive without the worker-validated preview", async () => {
    const { client } = harness(() => ({
      plaintext: new Uint8Array([123, 125]),
      csv: new Uint8Array([0xef, 0xbb, 0xbf]),
    }));
    await expect(client.projectExport({
      schema: 1,
      kind: "record",
      expectedSchemaVersion: 2,
      tableId: "tbl_018f0000-0000-7000-8000-000000000001",
      fieldIds: ["fld_018f0000-0000-7000-8000-000000000002"],
      recordId: "018f0000-0000-7000-8000-000000000003",
      options: { includeRecordIds: false, redactedFieldIds: [] },
    })).rejects.toThrow(/invalid projection/i);
  });

  it("forwards AbortSignal cancellation to the in-flight worker projection", async () => {
    const posted: Posted[] = [];
    const worker = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage(message: Posted): void { posted.push(message); },
      terminate(): void {},
    };
    const client = new WorkerClient(worker as unknown as Worker);
    const controller = new AbortController();
    const pending = client.projectExport({
      schema: 1,
      kind: "record",
      expectedSchemaVersion: 2,
      tableId: "tbl_018f0000-0000-7000-8000-000000000001",
      fieldIds: ["fld_018f0000-0000-7000-8000-000000000002"],
      recordId: "018f0000-0000-7000-8000-000000000003",
      options: { includeRecordIds: false, redactedFieldIds: [] },
    }, controller.signal);
    controller.abort();
    expect(posted).toHaveLength(2);
    expect(posted[1]).toMatchObject({
      op: "cancelProjectionV1", payload: { targetId: posted[0]!.id },
    });
    worker.onmessage?.({ data: {
      id: posted[1]!.id, ok: true,
      result: { targetId: posted[0]!.id, quiescent: true, outcome: "cancelled" },
    } });
    worker.onmessage?.({ data: {
      id: posted[0]!.id, ok: false,
      error: { code: "E_CANCELLED", message: "projection stopped" },
    } });
    await expect(pending).rejects.toMatchObject({ code: "E_CANCELLED" });
  });
});

describe("WorkerClient connected-record boundary", () => {
  it("serializes reversible column removal as an explicit command", async () => {
    const { client, posted } = harness();
    await client.removeColumn("projects", "obsolete");
    expect(posted[0]).toMatchObject({
      op: "removeColumn", payload: { table: "projects", column: "obsolete" },
    });
  });

  it("serializes relation previews and commits as explicit bounded operations", async () => {
    const { client, posted } = harness();
    const request = {
      sourceTable: "jobs", sourceField: "customer",
      targetTable: "customers", displayField: "name",
    };
    await client.previewRelationConversion(request);
    expect(posted[0]).toMatchObject({ op: "previewRelationConversion", payload: request });

    const preview = {
      ...request, atVersion: 2, fingerprint: "deadbeef",
      matchedRows: 3, unmatchedRows: 1, ambiguousRows: 0, duplicateSourceRows: 1,
      unmatchedSamples: ["Unknown"], ambiguousSamples: [],
    };
    await client.convertTextToRelation({ ...preview, cardinality: "one" });
    expect(posted[1]).toMatchObject({
      op: "convertTextToRelation",
      payload: { ...preview, cardinality: "one" },
    });
  });
});

describe("WorkerClient structural workflow boundary", () => {
  it("pins relation-column creation to its own explicit worker operation", async () => {
    const { client, posted } = harness();
    const column = {
      name: "Owner",
      type: "relation" as const,
      relation: {
        target_table: "people",
        cardinality: "one" as const,
        unique_targets: false,
        display_field: "name",
      },
    };
    await client.addRelationColumn("projects", column);
    expect(posted[0]).toEqual(expect.objectContaining({
      op: "addRelationColumn",
      payload: { table: "projects", column },
    }));
  });
});

describe("WorkerClient model credential boundary", () => {
  it("never reads legacy DB credentials through generic worker RPC", () => {
    const source = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");
    for (const key of [
      "byo_api_key", "anthropic_api_key", "openai_api_key", "api_key",
      "clay_session", "backend_url", "clay_backend_url",
    ]) expect(source).not.toContain(`wc.getSetting<string>("${key}")`);
  });

  it("revokes local account access before remote logout", () => {
    const source = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");
    const signOut = source.slice(source.indexOf("const signOut"), source.indexOf("const head ="));
    const clear = signOut.indexOf("setSessionToken(null)");
    const denyAmbient = signOut.indexOf("setAmbientSessionAllowed(false");
    const revoke = signOut.indexOf("revokeAccountSession()");
    const publish = signOut.indexOf('publishHostedAccountChange(backend, "revoked")');
    const remote = signOut.indexOf("logoutHostedSession(backend, session)");
    expect(clear).toBeGreaterThanOrEqual(0);
    expect(denyAmbient).toBeGreaterThan(clear);
    expect(revoke).toBeGreaterThan(denyAmbient);
    expect(publish).toBeGreaterThan(revoke);
    expect(remote).toBeGreaterThan(publish);
    expect(signOut).toContain("if (backend)");
    expect(signOut).toContain("logoutHostedSession(backend, session)");
    const crossTabStart = source.lastIndexOf("observeHostedAccountChanges(");
    const crossTab = source.slice(crossTabStart,
      source.indexOf("  useEffect(() => {", crossTabStart));
    expect(crossTab.indexOf("revokeAccountSession()"))
      .toBeLessThan(crossTab.indexOf("applyModelAccess()"));
    for (const [start, end] of [
      ["const selectModelProvider", "const saveKey"],
      ["const saveKey", "const saveBackend"],
      ["const saveBackend", "// Hosted-mode account"],
    ] as const) expect(source.slice(source.indexOf(start), source.indexOf(end)))
      .toContain("publishCurrentModelAccess()");
  });

  it("generation-fences hosted sign-in before publishing credentials", () => {
    const source = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");
    const prepare = source.slice(
      source.indexOf("async function prepareWorkerModelAccess"), source.indexOf("function withTimeout"),
    );
    const authFlow = source.slice(source.indexOf("const redeemHostedAuth"),
      source.indexOf("const signOut"));
    const redeem = authFlow.slice(0, authFlow.indexOf("\n  useEffect"));
    const signIn = source.slice(source.indexOf("const signIn"), source.indexOf("const signOut"));
    expect(signIn).toContain("authFence.begin");
    expect(signIn).toContain("authFence.isCurrent");
    expect(signIn).toContain("state: attempt.state");
    expect(signIn).toContain("consumePersistedHostedAuthAttempt");
    expect(signIn).toContain('credentials: "omit"');
    expect(authFlow).toContain("logoutHostedBearerSession");
    expect(authFlow).toContain("commitHostedAuthAttempt");
    expect(redeem.lastIndexOf("stillCurrent()"))
      .toBeLessThan(redeem.indexOf("setSessionToken"));
    expect(source).toContain("captureHostedAuthLanding");
    expect(source).toContain("authFence.resume");
    expect(source).not.toContain('searchParams.get("auth")');
    expect(source.slice(source.indexOf("const selectModelProvider"),
      source.indexOf("const saveKey"))).toContain("authFence.invalidate()");
    expect(source.slice(source.indexOf("const saveBackend"),
      source.indexOf("// Hosted-mode account"))).toContain("authFence.invalidate()");
    expect(source.slice(source.indexOf("const signOut"), source.indexOf("const head =")))
      .toContain("advanceHostedAuthRevocation");
    expect(source.slice(source.lastIndexOf("observeHostedAccountChanges("),
      source.indexOf("  useEffect(() => {", source.lastIndexOf("observeHostedAccountChanges("))))
      .toContain("reconcileHostedAuthEpoch");
    expect(prepare).toContain("protectedSecrets");
    expect(prepare).toContain("getApiKey()");
    expect(prepare).toContain("getSessionToken(getBackendUrl())");
    expect(prepare).toContain("providerToken");
  });

  it("removes explicit ambient-cookie authority on account revocation", async () => {
    modelBridge.rawPlan.mockResolvedValue("{}");
    const observeTransport = async (revoke: boolean): Promise<Record<string, unknown>> => {
      const posted: Posted[] = [];
      let plannerPort: MessagePort | null = null;
      const worker = {
        onmessage: null as ((event: { data: unknown }) => void) | null,
        postMessage(message: Posted, transfer: Transferable[] = []): void {
          posted.push(message);
          plannerPort = transfer[0] as MessagePort;
        },
        terminate(): void {},
      };
      const client = new WorkerClient(worker as unknown as Worker);
      await client.setModelAccess({
        provider: "clay", apiKey: null, backendUrl: "https://clay.example", session: null,
        allowAmbientCredentials: true,
      } as ModelAccess);
      if (revoke) client.revokeAccountSession();
      const pending = client.intent("add a board");
      const response = new Promise<void>(resolve => {
        plannerPort!.onmessage = () => resolve();
        plannerPort!.start();
      });
      plannerPort!.postMessage({
        v: 1, kind: "planner.request", epoch: `boot_${"a".repeat(26)}`,
        generation: 1, contextId: `ctx_${"b".repeat(26)}`, attempt: 0, sequence: 0,
        context: { registry: [], panels: [], recentSummaries: [], intent: "add a board" },
        repair: null,
      });
      await response;
      const transport = modelBridge.transports.at(-1) as Record<string, unknown>;
      client.terminate();
      await expect(pending).rejects.toThrow(/terminated/i);
      return transport;
    };

    await expect(observeTransport(false)).resolves.toMatchObject({ credentials: "include" });
    await expect(observeTransport(true)).resolves.not.toHaveProperty("credentials");
  });
  it("publishes only the latest model access when preparation resolves out of order", async () => {
    const { client } = harness();
    let resolveFirst!: (value: ModelAccess) => void;
    let resolveSecond!: (value: ModelAccess) => void;
    const firstAccess = new Promise<ModelAccess>(resolve => {
      resolveFirst = resolve;
    });
    const secondAccess = new Promise<ModelAccess>(resolve => {
      resolveSecond = resolve;
    });

    const first = client.setModelAccess(firstAccess);
    const second = client.setModelAccess(secondAccess);
    resolveSecond(withCredential(
      { provider: "anthropic" as const, backendUrl: null, session: null },
      "newer-canary",
    ));
    await expect(second).resolves.toBe(true);
    resolveFirst(withCredential(
      { provider: "clay" as const, backendUrl: "http://127.0.0.1:8788", session: "old-session" },
      null,
    ));
    await expect(first).resolves.toBe(false);
    await expect(client.status()).resolves.toMatchObject({
      modelConnection: { provider: "anthropic", configured: true, reachable: true },
    });
  });

  it("rejects accessor-backed model access without invoking caller code", async () => {
    const { client } = harness();
    let getterCalls = 0;
    const hostile = Object.create(Object.prototype);
    Object.defineProperties(hostile, {
      provider: { enumerable: true, get: () => { getterCalls++; return "anthropic"; } },
      apiKey: { enumerable: true, value: "accessor-canary" },
      backendUrl: { enumerable: true, value: null },
      session: { enumerable: true, value: null },
    });
    await expect(client.setModelAccess(hostile as ModelAccess)).rejects.toThrow(/invalid/i);
    expect(getterCalls).toBe(0);
  });

  it("fences planner admission as soon as model access replacement starts", async () => {
    let releaseOld!: (raw: string) => void;
    modelBridge.rawPlan.mockImplementationOnce(() => new Promise(resolve => { releaseOld = resolve; }));
    const posted: Posted[] = [];
    let plannerPort: MessagePort | null = null;
    const worker = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage(message: Posted, transfer: Transferable[] = []): void {
        posted.push(message);
        if (message.op === "intent") plannerPort = transfer[0] as MessagePort;
      },
      terminate(): void {},
    };
    const client = new WorkerClient(worker as unknown as Worker);
    await client.setModelAccess(withCredential(
      { provider: "clay", backendUrl: "http://127.0.0.1:8788", session: "old-session" }, null,
    ));
    const beforeCalls = modelBridge.rawPlan.mock.calls.length;
    const pending = client.intent("add a board");
    const observed: Record<string, unknown>[] = [];
    plannerPort!.onmessage = event => observed.push(event.data as Record<string, unknown>);
    plannerPort!.start();
    plannerPort!.postMessage({
      v: 1, kind: "planner.request", epoch: `boot_${"a".repeat(26)}`,
      generation: 1, contextId: `ctx_${"b".repeat(26)}`, attempt: 0, sequence: 0,
      context: { registry: [], panels: [], recentSummaries: [], intent: "add a board" },
      repair: null,
    });
    await vi.waitFor(() => expect(modelBridge.rawPlan).toHaveBeenCalledTimes(beforeCalls + 1));

    let publishNew!: (access: ModelAccess) => void;
    const publication = client.setModelAccess(new Promise<ModelAccess>(resolve => {
      publishNew = resolve;
    }));
    try {
      await vi.waitFor(() => expect(observed.some(
        message => message.kind === "planner.cancel",
      )).toBe(true));
      const messagesBeforeRejectedIntent = posted.length;
      await expect(client.intent("must wait for new access")).rejects.toThrow(/access.*progress/i);
      expect(posted).toHaveLength(messagesBeforeRejectedIntent);
    } finally {
      publishNew(withCredential(
        { provider: "anthropic", backendUrl: null, session: null }, "new-credential-canary",
      ));
      releaseOld("{\"late\":true}");
      await publication;
      client.terminate();
      await expect(pending).rejects.toThrow(/terminated/i);
    }
    expect(observed.some(message => message.kind === "planner.response")).toBe(false);
  });

  it("a second-tab revocation cancels planning and closes later admission", async () => {
    let releasePlan!: (raw: string) => void;
    modelBridge.rawPlan.mockImplementationOnce(() =>
      new Promise(resolve => { releasePlan = resolve; }));
    const posted: Posted[] = [];
    let plannerPort: MessagePort | null = null;
    const worker = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage(message: Posted, transfer: Transferable[] = []): void {
        posted.push(message);
        if (message.op === "intent") plannerPort = transfer[0] as MessagePort;
      },
      terminate(): void {},
    };
    const client = new WorkerClient(worker as unknown as Worker);
    await client.setModelAccess(withCredential(
      { provider: "clay", backendUrl: "https://a.example", session: "c".repeat(48) }, null,
    ));
    const beforeCalls = modelBridge.rawPlan.mock.calls.length;
    const pending = client.intent("add a board");
    const observed: Record<string, unknown>[] = [];
    plannerPort!.onmessage = event => observed.push(event.data as Record<string, unknown>);
    plannerPort!.start();
    plannerPort!.postMessage({
      v: 1, kind: "planner.request", epoch: `boot_${"a".repeat(26)}`,
      generation: 1, contextId: `ctx_${"b".repeat(26)}`, attempt: 0, sequence: 0,
      context: { registry: [], panels: [], recentSummaries: [], intent: "add a board" },
      repair: null,
    });
    await vi.waitFor(() => expect(modelBridge.rawPlan)
      .toHaveBeenCalledTimes(beforeCalls + 1));
    const target = new EventTarget();
    const stop = observeHostedAccountChanges(() => client.revokeAccountSession(), target);
    const change = publishHostedAccountChange("https://a.example", "revoked");
    const event = Object.assign(new Event("storage"), {
      key: HOSTED_ACCOUNT_CHANGE_KEY, newValue: JSON.stringify(change),
    });
    target.dispatchEvent(event);
    await vi.waitFor(() => expect(observed.some(
      message => message.kind === "planner.cancel",
    )).toBe(true));
    modelBridge.rawPlan.mockResolvedValueOnce("{}");
    const beforeTransports = modelBridge.transports.length;
    const later = client.intent("must remain signed out");
    const laterPort = plannerPort!;
    laterPort.onmessage = () => {};
    laterPort.start();
    laterPort.postMessage({
      v: 1, kind: "planner.request", epoch: `boot_${"d".repeat(26)}`,
      generation: 2, contextId: `ctx_${"e".repeat(26)}`, attempt: 0, sequence: 0,
      context: { registry: [], panels: [], recentSummaries: [], intent: "must remain signed out" },
      repair: null,
    });
    await vi.waitFor(() => expect(modelBridge.transports.length)
      .toBeGreaterThan(beforeTransports));
    expect(modelBridge.transports.at(-1)).toMatchObject({
      mode: "hosted", endpoint: "https://a.example",
    });
    expect(modelBridge.transports.at(-1)).not.toHaveProperty("credentials");
    stop();
    releasePlan("{}");
    client.terminate();
    await expect(pending).rejects.toThrow(/terminated/i);
    await expect(later).rejects.toThrow(/terminated/i);
  });

  it("rejects active credential material before intent crosses the worker boundary", async () => {
    const { client, posted } = harness();
    const canary = "intent-credential-canary";
    await client.setModelAccess(withCredential(
      { provider: "anthropic", backendUrl: null, session: null }, canary,
    ));
    const pending = client.intent(`use ${canary} as data`).catch(error => error as Error);
    const messagesBeforeTermination = posted.length;
    client.terminate();
    const error = await pending;
    expect(messagesBeforeTermination).toBe(0);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("intent unexpectedly succeeded");
    expect(error.message).toMatch(/credential/i);
  });

  it("rejects protected credential material in outbound planner context", async () => {
    const credentialCanary = "context-credential-canary";
    const posted: Posted[] = [];
    let plannerPort: MessagePort | null = null;
    const worker = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage(message: Posted, transfer: Transferable[] = []): void {
        posted.push(message);
        plannerPort = transfer[0] as MessagePort;
      },
      terminate(): void {},
    };
    const client = new WorkerClient(worker as unknown as Worker);
    await client.setModelAccess(withCredential(
      { provider: "anthropic", backendUrl: null, session: null }, credentialCanary,
    ));
    const beforeCalls = modelBridge.rawPlan.mock.calls.length;
    const pending = client.intent("add a board");
    const observed: Record<string, unknown>[] = [];
    plannerPort!.onmessage = event => observed.push(event.data as Record<string, unknown>);
    plannerPort!.start();
    plannerPort!.postMessage({
      v: 1, kind: "planner.request", epoch: `boot_${"a".repeat(26)}`,
      generation: 1, contextId: `ctx_${"b".repeat(26)}`, attempt: 0, sequence: 0,
      context: {
        registry: [], recentSummaries: [], intent: "add a board",
        panels: [{ panel_id: "board", code: `const imported = "${credentialCanary}";` }],
      },
      repair: null,
    });

    await vi.waitFor(() => expect(observed.some(
      message => message.kind === "planner.cancel",
    )).toBe(true));
    expect(modelBridge.rawPlan).toHaveBeenCalledTimes(beforeCalls);
    expect(JSON.stringify(observed)).not.toContain(credentialCanary);
    client.terminate();
    await expect(pending).rejects.toThrow(/terminated/i);
  });

  it.each(["clay", "codex", "openai", "anthropic"] as const)(
    "keeps every %s credential in native-private shell memory",
    async provider => {
      const { client, posted } = harness();
      const credentialCanary = `credential-${provider}-canary`;
      await client.setModelAccess({
        provider,
        apiKey: provider === "anthropic" ? credentialCanary : null,
        backendUrl: provider === "anthropic" ? null : "http://127.0.0.1:8788",
        session: provider === "clay" ? credentialCanary : null,
        providerToken: provider === "codex" ? credentialCanary : null,
      });

      expect(posted).toEqual([]);
      expect(JSON.stringify(client)).not.toContain(credentialCanary);
      expect(Reflect.ownKeys(client).map(String)).not.toContain("modelAccess");
    },
  );

  it.each([
    ["forty nested Unicode backslash layers", (credential: string) => [...credential]
      .map(character => `\\u005c${"u005c".repeat(39)}u${character.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")],
    ["the fixed-point work budget", (_credential: string) =>
      `\\u005c${"u005c".repeat(4_000)}u0078`],
  ] as const)("rejects provider output after %s", async (_case, encode) => {
    const credentialCanary = "deep-credential-canary";
    const raw = JSON.stringify({ migration: encode(credentialCanary) });
    expect(raw).not.toContain(credentialCanary);
    modelBridge.rawPlan.mockResolvedValueOnce(raw);
    const posted: Posted[] = [];
    let plannerPort: MessagePort | null = null;
    const worker = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage(message: Posted, transfer: Transferable[] = []): void {
        posted.push(message);
        plannerPort = transfer[0] as MessagePort;
      },
      terminate(): void {},
    };
    const client = new WorkerClient(worker as unknown as Worker);
    await client.setModelAccess(withCredential(
      { provider: "anthropic", backendUrl: null, session: null }, credentialCanary,
    ));
    const pending = client.intent("add a board");
    const response = new Promise<Record<string, unknown>>(resolve => {
      plannerPort!.onmessage = event => resolve(event.data as Record<string, unknown>);
      plannerPort!.start();
    });
    plannerPort!.postMessage({
      v: 1, kind: "planner.request", epoch: `boot_${"a".repeat(26)}`,
      generation: 1, contextId: `ctx_${"b".repeat(26)}`, attempt: 0, sequence: 0,
      context: { registry: [], panels: [], recentSummaries: [], intent: "add a board" },
      repair: null,
    });

    const reflected = await response;
    expect(reflected).toMatchObject({
      kind: "planner.response", result: { ok: false, error: { code: "E_MODEL" } },
    });
    expect(JSON.stringify(reflected)).not.toContain(credentialCanary);
    client.terminate();
    await expect(pending).rejects.toThrow(/terminated/i);
  });

  it("rejects a successful provider response that reflects active credential material", async () => {
    const credentialCanary = "credential-reflection-canary";
    const escapedCanary = [...credentialCanary]
      .map(character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
    const nestedEscapedOutput = JSON.stringify({
      migration: JSON.stringify({ leak: escapedCanary }),
    });
    expect(nestedEscapedOutput).not.toContain(credentialCanary);
    modelBridge.rawPlan.mockResolvedValueOnce(nestedEscapedOutput);
    const posted: Posted[] = [];
    let plannerPort: MessagePort | null = null;
    const worker = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage(message: Posted, transfer: Transferable[] = []): void {
        posted.push(message);
        plannerPort = transfer[0] as MessagePort;
      },
      terminate(): void {},
    };
    const client = new WorkerClient(worker as unknown as Worker);
    await client.setModelAccess(withCredential(
      { provider: "anthropic" as const, backendUrl: null, session: null },
      credentialCanary,
    ));
    const pending = client.intent("add a board");
    const response = new Promise<Record<string, unknown>>(resolve => {
      plannerPort!.onmessage = event => resolve(event.data as Record<string, unknown>);
      plannerPort!.start();
    });
    plannerPort!.postMessage({
      v: 1, kind: "planner.request", epoch: `boot_${"a".repeat(26)}`,
      generation: 1, contextId: `ctx_${"b".repeat(26)}`, attempt: 0, sequence: 0,
      context: { registry: [], panels: [], recentSummaries: [], intent: "add a board" },
      repair: null,
    });

    const reflected = await response;
    expect(reflected).toMatchObject({
      kind: "planner.response",
      result: { ok: false, error: { code: "E_MODEL" } },
    });
    expect(JSON.stringify(reflected)).not.toContain(credentialCanary);
    client.terminate();
    await expect(pending).rejects.toThrow(/terminated/i);
  });

  it.each([
    ["JavaScript hex escapes", (secret: string) => `"${[...secret]
      .map(character => `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`).join("")}"`],
    ["JavaScript code-point escapes", (secret: string) => `"${[...secret]
      .map(character => `\\u{${character.codePointAt(0)!.toString(16)}}`).join("")}"`],
    ["static literal concatenation", (secret: string) => secret.match(/.{1,5}/g)!
      .map(part => JSON.stringify(part)).join(" + ")],
    ["static template concatenation", (secret: string) => secret.match(/.{1,5}/g)!
      .map(part => `\`${part}\``).join(" + ")],
    ["static template interpolation", (secret: string) => {
      const parts = secret.match(/.{1,5}/g)!;
      return `\`${parts[0]}${parts.slice(1)
        .map(part => `\${${JSON.stringify(part)}}`).join("")}\``;
    }],
    ["static array join", (secret: string) =>
      `[${secret.match(/.{1,5}/g)!.map(part => JSON.stringify(part)).join(",")}].join("")`],
    ["base64", (secret: string) => JSON.stringify(
      Buffer.from(secret, "utf8").toString("base64"))],
    ["hex", (secret: string) => JSON.stringify(
      Buffer.from(secret, "utf8").toString("hex"))],
    ["percent encoding", (secret: string) => JSON.stringify([...secret]
      .map(character => `%${character.charCodeAt(0).toString(16).padStart(2, "0")}`).join(""))],
    ["static character codes", (secret: string) =>
      `String.fromCharCode(${[...secret].map(character => character.charCodeAt(0)).join(",")})`],
  ] as const)("rejects provider output deriving a credential through %s", async (_name, encode) => {
    const credential = "semantic-credential-canary";
    const derived = encode(credential);
    const raw = JSON.stringify({
      panels: [{ code: `const reflected = ${derived};` }],
    });
    expect(raw).not.toContain(credential);
    const result = await plannerResultForRaw(raw, withCredential(
      { provider: "anthropic", backendUrl: null, session: null }, credential,
    ));
    expect(result).toMatchObject({
      kind: "planner.response", result: { ok: false, error: { code: "E_MODEL" } },
    });
    expect(JSON.stringify(result)).not.toContain(credential);
  });

  it("screens inactive credentials still held elsewhere on the device", async () => {
    const active = "active-credential-canary";
    const inactive = "inactive-device-credential-canary";
    const raw = JSON.stringify({
      panels: [{ code: Buffer.from(inactive, "utf8").toString("base64") }],
    });
    const access = Object.assign(withCredential(
      { provider: "anthropic", backendUrl: null, session: null }, active,
    ), { protectedSecrets: [active, inactive] }) as ModelAccess;
    const result = await plannerResultForRaw(raw, access);
    expect(result).toMatchObject({
      kind: "planner.response", result: { ok: false, error: { code: "E_MODEL" } },
    });
  });

  it("never invokes accessors on an attacker-controlled provider error", async () => {
    let invoked = false;
    const hostile = Object.defineProperties({}, {
      code: { enumerable: true, get: () => { invoked = true; return "E_MODEL"; } },
      message: { enumerable: true, get: () => { invoked = true; return "credential"; } },
      toString: { value: () => { invoked = true; return "credential"; } },
    });
    const result = await plannerResultForProvider({ failure: hostile }, withCredential(
      { provider: "anthropic", backendUrl: null, session: null }, "credential",
    ));
    expect(result).toMatchObject({
      result: {
        ok: false,
        error: { code: "E_NET", message: "model request failed without transferable diagnostic" },
      },
    });
    expect(invoked).toBe(false);
  });

  it("discards a preview returned after model access invalidates its planner", async () => {
    modelBridge.rawPlan.mockResolvedValueOnce("{}");
    const posted: Posted[] = [];
    let plannerPort: MessagePort | null = null;
    const worker = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage(message: Posted, transfer: Transferable[] = []): void {
        posted.push(message);
        if (message.op === "intent") plannerPort = transfer[0] as MessagePort;
      },
      terminate(): void {},
    };
    const client = new WorkerClient(worker as unknown as Worker);
    await client.setModelAccess({
      provider: "clay", apiKey: null, backendUrl: "http://127.0.0.1:8788", session: null,
    });
    const pending = client.intent("add a board");
    const nextMessage = (): Promise<Record<string, unknown>> => new Promise(resolve => {
      plannerPort!.onmessage = event => resolve(event.data as Record<string, unknown>);
      plannerPort!.start();
    });
    const response = nextMessage();
    plannerPort!.postMessage({
      v: 1, kind: "planner.request", epoch: `boot_${"a".repeat(26)}`,
      generation: 1, contextId: `ctx_${"b".repeat(26)}`, attempt: 0, sequence: 0,
      context: { registry: [], panels: [], recentSummaries: [], intent: "add a board" },
      repair: null,
    });
    await response;
    const finalized = nextMessage();
    plannerPort!.postMessage({
      v: 1, kind: "planner.finalize", epoch: `boot_${"a".repeat(26)}`,
      generation: 1, contextId: `ctx_${"b".repeat(26)}`, sequence: 1,
      nonce: `fin_${"c".repeat(26)}`,
    });
    await finalized;

    const replacementCanary = ["replacement", "canary"].join("-");
    try {
      await client.setModelAccess({
        provider: "anthropic", apiKey: replacementCanary, backendUrl: null, session: null,
      });
      worker.onmessage?.({ data: {
        id: posted[0]!.id, ok: true,
        result: {
          status: "preview",
          preview: { summary: "stale", diff: [], panels: [], removePanels: [],
            version: 2, repaired: false },
        },
      } });
      await vi.waitFor(() => expect(posted.some(message => message.op === "discard")).toBe(true));
      const discard = posted.find(message => message.op === "discard")!;
      worker.onmessage?.({ data: { id: discard.id, ok: true, result: null } });
      await expect(pending).rejects.toThrow(/access.*changed|stale/i);
    } finally {
      client.terminate();
    }
  });

  it("acknowledges a bound planner finalization before accepting the outer outcome", async () => {
    modelBridge.rawPlan.mockResolvedValueOnce("{}");
    const posted: Posted[] = [];
    let plannerPort: MessagePort | null = null;
    const worker = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage(message: Posted, transfer: Transferable[] = []): void {
        posted.push(message);
        plannerPort = transfer[0] as MessagePort;
      },
      terminate(): void {},
    };
    const client = new WorkerClient(worker as unknown as Worker);
    await client.setModelAccess({
      provider: "clay", apiKey: null, backendUrl: "http://127.0.0.1:8788", session: null,
    });
    const pending = client.intent("add a board");
    expect(plannerPort).not.toBeNull();
    const nextMessage = (): Promise<Record<string, unknown>> => new Promise(resolve => {
      plannerPort!.onmessage = event => resolve(event.data as Record<string, unknown>);
      plannerPort!.start();
    });
    const response = nextMessage();
    plannerPort!.postMessage({
      v: 1, kind: "planner.request", epoch: `boot_${"a".repeat(26)}`,
      generation: 1, contextId: `ctx_${"b".repeat(26)}`, attempt: 0, sequence: 0,
      context: { registry: [], panels: [], recentSummaries: [], intent: "add a board" },
      repair: null,
    });
    await expect(response).resolves.toMatchObject({
      v: 1, kind: "planner.response", attempt: 0, sequence: 0,
      result: { ok: true, raw: "{}" },
    });
    const finalized = nextMessage();
    plannerPort!.postMessage({
      v: 1, kind: "planner.finalize", epoch: `boot_${"a".repeat(26)}`,
      generation: 1, contextId: `ctx_${"b".repeat(26)}`, sequence: 1,
      nonce: `fin_${"c".repeat(26)}`,
    });
    await expect(finalized).resolves.toMatchObject({
      v: 1, kind: "planner.finalized", generation: 1, sequence: 1,
      nonce: `fin_${"c".repeat(26)}`,
    });
    worker.onmessage?.({ data: {
      id: posted[0]!.id, ok: true,
      result: { status: "failed", stage: "plan", reasons: ["done"], repaired: false },
    } });
    await expect(pending).resolves.toMatchObject({ status: "failed" });
    client.terminate();
  });

  it("closes an in-flight planner port and rejects the call on terminate", async () => {
    const posted: Posted[] = [];
    const worker = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage(message: Posted): void { posted.push(message); },
      terminate(): void {},
    };
    const client = new WorkerClient(worker as unknown as Worker);
    const pending = client.intent("add a board");
    await Promise.resolve();
    client.terminate();

    await expect(pending).rejects.toThrow(/terminated/i);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ op: "intent", payload: { text: "add a board" } });
  });

  it("rejects shutdown when worker quiescence is not acknowledged", async () => {
    let terminateCalls = 0;
    const posted: Posted[] = [];
    const worker = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage(message: Posted): void { posted.push(message); },
      terminate(): void { terminateCalls++; },
    };
    const client = new WorkerClient(worker as unknown as Worker);
    vi.useFakeTimers();
    try {
      const pending = client.shutdown();
      const rejected = expect(pending).rejects.toThrow(/acknowledge|settle/i);
      const late = client.intent("late planner").catch(error => error as Error);
      await Promise.resolve();
      expect(posted.some(message => message.op === "intent")).toBe(false);
      await vi.advanceTimersByTimeAsync(2_501);
      await rejected;
      const lateResult = await late;
      expect(lateResult).toBeInstanceOf(Error);
      if (!(lateResult instanceof Error)) throw new Error("late intent unexpectedly succeeded");
      expect(lateResult.message).toMatch(/shutdown/i);
      expect(terminateCalls).toBe(1);
    } finally { vi.useRealTimers(); }
  });

  it("waits for planner cancellation and worker acknowledgement before termination", async () => {
    modelBridge.rawPlan.mockImplementationOnce(() => new Promise(() => undefined));
    const posted: Posted[] = [];
    let transferredPlannerPort: MessagePort | null = null;
    let terminateCalls = 0;
    let acknowledgeShutdown!: () => void;
    const worker = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage(message: Posted, transfer: Transferable[] = []): void {
        posted.push(message);
        if (message.op === "intent") transferredPlannerPort = transfer[0] as MessagePort;
        if (message.op === "shutdown") acknowledgeShutdown = () => this.onmessage?.({
          data: { id: message.id, ok: true, result: null },
        });
      },
      terminate(): void { terminateCalls++; },
    };
    const client = new WorkerClient(worker as unknown as Worker);
    await client.setModelAccess(withCredential(
      { provider: "clay" as const, backendUrl: "http://127.0.0.1:8788", session: null },
      null,
    ));
    const beforeRawPlanCalls = modelBridge.rawPlan.mock.calls.length;
    const pendingIntent = client.intent("add a board");
    const cancelObserved = new Promise<void>(resolve => {
      transferredPlannerPort!.onmessage = event => {
        const message = event.data as { kind?: string };
        if (message.kind !== "planner.cancel") return;
        resolve();
        worker.onmessage?.({ data: {
          id: posted.find(item => item.op === "intent")!.id,
          ok: false,
          error: { code: "E_VALIDATION", message: "planner round was cancelled" },
        } });
      };
      transferredPlannerPort!.start();
    });
    transferredPlannerPort!.postMessage({
      v: 1, kind: "planner.request", epoch: `boot_${"a".repeat(26)}`,
      generation: 1, contextId: `ctx_${"b".repeat(26)}`, attempt: 0, sequence: 0,
      context: { registry: [], panels: [], recentSummaries: [], intent: "add a board" },
      repair: null,
    });
    await vi.waitFor(() => expect(modelBridge.rawPlan).toHaveBeenCalledTimes(
      beforeRawPlanCalls + 1,
    ));

    const intentRejected = expect(pendingIntent).rejects.toThrow(/cancelled/i);
    const shutdown = client.shutdown();
    await cancelObserved;
    await vi.waitFor(() => expect(posted.some(item => item.op === "shutdown")).toBe(true));
    expect(terminateCalls).toBe(0);
    acknowledgeShutdown();
    await expect(shutdown).resolves.toBeUndefined();
    await intentRejected;
    expect(terminateCalls).toBe(1);
  });
});
