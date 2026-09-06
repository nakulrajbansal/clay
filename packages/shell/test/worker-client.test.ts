import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decodeProjectionPlaintextV1,
  type ProjectionArtifactV1,
  type ProjectionRequestV1,
} from "@clay/kernel/projection";
import { WorkerClient } from "../src/app/worker-client";

type Posted = { id: number; op: string; payload: Record<string, unknown> };

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
    expect((posted[0] as unknown as { requestId: string }).requestId)
      .toMatch(/^req_[a-z2-7]{26}$/);
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
  it("decodes a structured-cloned artifact into a recursively frozen canonical projection", async () => {
    const artifact = transportedArtifact();
    expect(Object.isFrozen(artifact.projection)).toBe(false);
    const { client, posted } = harness(message =>
      message.op === "projectPlaintextV1" ? artifact : null);
    const request = {
      schema: 1,
      kind: "record",
      expectedSchemaVersion: 2,
      tableId: "tbl_018f0000-0000-7000-8000-000000000001",
      fieldIds: ["fld_018f0000-0000-7000-8000-000000000002"],
      recordId: "018f0000-0000-7000-8000-000000000003",
      options: { includeRecordIds: false, redactedFieldIds: [] },
    } satisfies ProjectionRequestV1;
    const result = await client.projectExport(request);
    expect(result).not.toBe(artifact);
    expect(result.projection).toEqual(decodeProjectionPlaintextV1(projectionPlaintext));
    expect(Object.isFrozen(result)).toBe(true);
    expectJsonDeepFrozen(result.projection);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ op: "projectPlaintextV1", payload: request });
  });

  it("rejects a transported preview tampered after the worker encoded its bytes", async () => {
    const artifact = transportedArtifact();
    (artifact.projection.manifest as { title: string }).title += " tampered";
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
    })).rejects.toThrow(/preview does not match/i);
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
    const { client, posted } = harness();
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
    await expect(pending).rejects.toMatchObject({ code: "E_CANCELLED" });
    expect(posted).toHaveLength(2);
    expect(posted[1]).toMatchObject({
      op: "cancelProjectionV1", payload: { targetId: posted[0]!.id },
    });
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
