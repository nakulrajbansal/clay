import { describe, expect, it } from "vitest";
import { WorkerClient } from "../src/app/worker-client";

type Posted = {
  id: number;
  requestId: string;
  op: string;
  payload: Record<string, unknown> | undefined;
};

const requestId = expect.stringMatching(/^req_[a-z2-7]{26}$/);

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

describe("WorkerClient boot boundary", () => {
  it("returns validated neutral boot information and sends only an app hint", async () => {
    const selectedAppInstanceId = `app_${"a".repeat(26)}`;
    const bootInfo = {
      persistent: true,
      seeded: true,
      shellId: "tracker",
      selectedAppInstanceId,
      catalogGeneration: "1",
      apps: [{ id: selectedAppInstanceId, name: "My app", shellId: "tracker" }],
    } as const;
    const { client, posted } = harness(message => message.op === "boot" ? bootInfo : null);
    const result = await client.boot("default");
    expect(result).toEqual(bootInfo);
    expect(posted[0]).toEqual({
      id: 1,
      requestId,
      op: "boot",
      payload: {
        requestedAppId: "default",
        appCache: [{ id: "default", name: "My app", shellId: "blank" }],
      },
    });
  });

  it("rejects malformed neutral boot information", async () => {
    const { client } = harness(message => message.op === "boot" ? {
      persistent: "yes", seeded: true, shellId: "tracker", detail: "secret",
    } : null);
    await expect(client.boot("default")).rejects.toThrow("invalid boot response");
  });
});

describe("WorkerClient first-run evidence boundary", () => {
  it("requests only content-free sample and real-record evidence", async () => {
    const evidence = {
      sampleCount: 3, sampleTables: ["items"], realRecordCount: 1, provenanceValid: true,
    };
    const { client, posted } = harness(message =>
      message.op === "firstRunEvidence" ? evidence : null);
    await expect(client.firstRunEvidence()).resolves.toEqual(evidence);
    expect(posted).toEqual([
      { id: 1, requestId, op: "firstRunEvidence", payload: undefined },
    ]);
  });

  it("routes live edits through the worker-owned sample-to-real operation", async () => {
    const row = { id: "sample-1", name: "Mine" };
    const { client, posted } = harness(message =>
      message.op === "updateRecordWithSampleHandoff" ? row : null);
    await expect(client.updateRecordWithSampleHandoff(
      "items", "sample-1", { name: "Mine" },
    )).resolves.toEqual(row);
    expect(posted).toEqual([{
      id: 1,
      requestId,
      op: "updateRecordWithSampleHandoff",
      payload: { table: "items", rowId: "sample-1", patch: { name: "Mine" } },
    }]);
  });

  it("binds publication, receipt lookup, and Undo to explicit operation, app, and revision", async () => {
    const { client, posted } = harness();
    const importReview = {
      sourceRows: 2, acceptedRows: 2, skippedRows: 0, truncatedRows: 0,
      sourceColumns: 1, acceptedColumns: 1, truncatedColumns: 0,
    };
    await client.activateStarter({
      operationId: "starter-operation-0001", appId: "default", shellId: "tracker",
    });
    await client.activateImportedApp({
      operationId: "import-operation-00001", appId: "default", table: "jobs",
      columns: [{ name: "name", type: "text" }], rows: [{ name: "One" }, { name: "Two" }],
      review: importReview,
    });
    await client.firstRunPublication("default");
    await client.undoFirstRunImport({
      operationId: "import-operation-00001", appId: "default", expectedRevision: 1,
    });

    expect(posted).toEqual([
      { id: 1, requestId, op: "activateStarter", payload: {
        operationId: "starter-operation-0001", appId: "default", shellId: "tracker",
      } },
      { id: 2, requestId, op: "activateImportedApp", payload: {
        operationId: "import-operation-00001", appId: "default", table: "jobs",
        columns: [{ name: "name", type: "text" }], rows: [{ name: "One" }, { name: "Two" }],
        review: importReview,
      } },
      { id: 3, requestId, op: "firstRunPublication", payload: { appId: "default" } },
      { id: 4, requestId, op: "undoFirstRunImport", payload: {
        operationId: "import-operation-00001", appId: "default", expectedRevision: 1,
      } },
    ]);
  });
});

describe("WorkerClient first-record loss boundary", () => {
  it("requests a best-effort persistence result without opening a mutation ticket", async () => {
    const { client, posted } = harness(message =>
      message.op === "requestPersist" ? { persisted: false } : null);
    await expect(client.requestPersist()).resolves.toEqual({ persisted: false });
    expect(posted).toEqual([{ id: 1, requestId, op: "requestPersist", payload: undefined }]);
  });
});

describe("WorkerClient first-success everyday boundary", () => {
  it("binds exact target lookup and canonical completion to separate worker reads", async () => {
    const target = { table: "tasks", rowId: "018f0000-0000-7000-8000-000000000001" };
    const { client, posted } = harness(message =>
      message.op === "firstEverydayActionTarget" ? target : { steps: { everyday: {
        state: "complete", action: "open",
      } } });
    await expect(client.firstEverydayActionTarget()).resolves.toEqual(target);
    await client.completeEverydayAction({ action: "open", ...target });
    expect(posted).toEqual([
      { id: 1, requestId, op: "firstEverydayActionTarget", payload: undefined },
      { id: 2, requestId, op: "completeEverydayAction", payload: { action: "open", ...target } },
    ]);
  });
});

describe("WorkerClient device protection boundary", () => {
  const target = {
    appInstanceId: `app_${"a".repeat(26)}`,
    activeGenerationId: `gen_${"b".repeat(26)}`,
    lineageEpoch: "1",
    stateRevision: "2",
    stateDigest: `sha256:${"c".repeat(64)}`,
  };

  it("accepts only an exact-current protected projection", async () => {
    const projection = {
      result: { state: "protected_on_device", reasonCode: null },
      target,
      checkpoint: { state: "valid", target },
    };
    const { client, posted } = harness(message =>
      message.op === "deviceProtection" ? projection : null);
    await expect(client.deviceProtection()).resolves.toEqual(projection);
    expect(posted).toEqual([{ id: 1, requestId, op: "deviceProtection", payload: undefined }]);
  });

  it("rejects a protected claim bound to a stale target", async () => {
    const { client } = harness(() => ({
      result: { state: "protected_on_device", reasonCode: null },
      target,
      checkpoint: { state: "valid", target: { ...target, stateRevision: "1" } },
    }));
    await expect(client.deviceProtection()).rejects.toThrow("invalid device protection checkpoint");
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
  it("reuses one stable logical request identity across a lost-response retry", async () => {
    const { client, posted } = harness();
    const context = client.createMutationContext();
    const mutations = [{
      kind: "update" as const,
      table: "tasks",
      id: "018f0000-0000-7000-8000-000000000001",
      patch: { status: "done" },
    }];
    await client.applyBatch("Complete selected", mutations, context);
    await client.applyBatch("Complete selected", mutations, context);
    expect(posted).toHaveLength(2);
    expect(posted[0]!.requestId).toBe(context.requestId);
    expect(posted[1]!.requestId).toBe(context.requestId);
    expect(posted[1]!.payload).toEqual(posted[0]!.payload);
  });
});

describe("WorkerClient connected-record boundary", () => {
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

describe("WorkerClient model credential boundary", () => {
  it.each(["codex", "openai", "anthropic"] as const)(
    "never serializes a Clay session for %s",
    async provider => {
      const { client, posted } = harness();
      await client.setModelAccess({
        provider,
        apiKey: provider === "anthropic" ? "anthropic-key" : null,
        backendUrl: provider === "anthropic" ? null : "http://127.0.0.1:8788",
        session: "clay-session-secret",
      });
      expect(posted).toEqual([]);
    },
  );

  it("keeps a Clay hosted session on the main-thread planner boundary", async () => {
    const { client, posted } = harness();
    await client.setModelAccess({
      provider: "clay", apiKey: null, backendUrl: "https://clay.example",
      session: "clay-session-secret",
    });
    expect(posted).toEqual([]);
  });

  it("keeps a Codex connector token on the main-thread planner boundary", async () => {
    const { client, posted } = harness();
    await client.setModelAccess({
      provider: "codex", apiKey: null, backendUrl: "http://127.0.0.1:8788",
      session: "clay-session-secret", providerToken: "connector-token",
    });
    expect(posted).toEqual([]);
  });
});
