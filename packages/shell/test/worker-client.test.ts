import { describe, expect, it } from "vitest";
import { WorkerClient } from "../src/app/worker-client";

type Posted = {
  id: number;
  requestId: string;
  op: string;
  payload: Record<string, unknown>;
};

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

describe("WorkerClient lifecycle boundary", () => {
  it("routes every app lifecycle action through the worker and validates canonical projections", async () => {
    const appId = `app_${"a".repeat(26)}`;
    const bootInfo = {
      persistent: true, seeded: false, shellId: null,
      selectedAppInstanceId: appId, catalogGeneration: "9",
      apps: [{ id: appId, name: "Projects", shellId: "tracker" }],
    };
    const { client, posted } = harness(() => bootInfo);

    await client.createApp("Inventory", "inventory");
    await client.forkApp();
    await client.switchApp(appId);
    await client.renameApp(appId, "Renamed");
    await client.deleteApp(appId);
    await client.resetApp();

    expect(posted.map(message => message.op)).toEqual([
      "createApp", "forkApp", "switchApp", "renameApp", "deleteApp", "reset",
    ]);
    expect(posted.map(message => message.payload)).toEqual([
      { displayName: "Inventory", shellId: "inventory" },
      {},
      { appInstanceId: appId },
      { appInstanceId: appId, displayName: "Renamed", shellId: null },
      { appInstanceId: appId },
      {},
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
