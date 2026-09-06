import { describe, expect, it } from "vitest";
import { WorkerClient } from "../src/app/worker-client";

type Posted = { id: number; op: string; payload: Record<string, unknown> };

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
    const bootInfo = { persistent: true, seeded: true, shellId: "tracker" } as const;
    const { client, posted } = harness(message => message.op === "boot" ? bootInfo : null);
    const result = await client.boot("default");
    expect(result).toEqual(bootInfo);
    expect(posted[0]).toEqual({ id: 1, op: "boot", payload: { appId: "default" } });
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
      { id: 1, op: "firstRunEvidence", payload: undefined },
    ]);
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
      { id: 1, op: "activateStarter", payload: {
        operationId: "starter-operation-0001", appId: "default", shellId: "tracker",
      } },
      { id: 2, op: "activateImportedApp", payload: {
        operationId: "import-operation-00001", appId: "default", table: "jobs",
        columns: [{ name: "name", type: "text" }], rows: [{ name: "One" }, { name: "Two" }],
        review: importReview,
      } },
      { id: 3, op: "firstRunPublication", payload: { appId: "default" } },
      { id: 4, op: "undoFirstRunImport", payload: {
        operationId: "import-operation-00001", appId: "default", expectedRevision: 1,
      } },
    ]);
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
      expect(posted[0]!.payload).not.toHaveProperty("session");
    },
  );

  it("serializes a session only for Clay hosted", async () => {
    const { client, posted } = harness();
    await client.setModelAccess({
      provider: "clay", apiKey: null, backendUrl: "https://clay.example",
      session: "clay-session-secret",
    });
    expect(posted[0]!.payload.session).toBe("clay-session-secret");
  });

  it("serializes a Codex connector token in a provider-specific field", async () => {
    const { client, posted } = harness();
    await client.setModelAccess({
      provider: "codex", apiKey: null, backendUrl: "http://127.0.0.1:8788",
      session: "clay-session-secret", providerToken: "connector-token",
    });
    expect(posted[0]!.payload).toMatchObject({
      provider: "codex", providerToken: "connector-token",
    });
    expect(posted[0]!.payload).not.toHaveProperty("session");
  });
});
