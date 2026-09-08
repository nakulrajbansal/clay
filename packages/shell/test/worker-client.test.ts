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

  it("routes Recovery Kit enrollment and import bytes only to the trusted worker", async () => {
    const kit = new ArrayBuffer(32);
    const { client, posted, transfers } = harness(message => {
      if (message.op === "beginBackupTrustEnrollment") return {
        enrollmentId: `enroll_${"c".repeat(26)}`,
        fileName: "clay-recovery-kit-010203040506.txt",
        bytes: kit,
      };
      return { status: "ready" };
    });

    await client.backupTrustStatus();
    await client.beginBackupTrustEnrollment();
    const readBack = new ArrayBuffer(32);
    await client.confirmBackupTrustEnrollment(`enroll_${"c".repeat(26)}`, readBack);
    const imported = new ArrayBuffer(32);
    await client.importRecoveryKit(imported);
    const importedSeriesId = "20".repeat(16);
    const activeSeriesId = "10".repeat(16);
    await client.activateImportedBackupSeries(importedSeriesId, activeSeriesId);

    expect(posted.map(message => message.op)).toEqual([
      "backupTrustStatus",
      "beginBackupTrustEnrollment",
      "confirmBackupTrustEnrollment",
      "importRecoveryKit",
      "activateImportedBackupSeries",
    ]);
    expect(transfers[2]).toEqual([readBack]);
    expect(transfers[3]).toEqual([imported]);
    expect(posted[4]?.payload).toEqual({
      seriesId: importedSeriesId,
      expectedActiveSeriesId: activeSeriesId,
      confirmation: "use_imported_recovery_kit_for_future_backups",
    });
  });

  it("routes automatic backup staging and catalog publication through the worker", async () => {
    const { client, posted, transfers } = harness();
    const appInstanceId = `app_${"a".repeat(26)}`;
    const target = {
      schema: 1 as const,
      targetId: `tgt_${"b".repeat(26)}`,
      appInstanceId,
      adapter: "browser_directory" as const,
      adapterCertificationId: `btc_${"c".repeat(26)}`,
      authorizedAt: "2026-09-06T12:00:00.000Z",
    };
    await client.backupSelection();
    await client.prepareAutomaticBackup(target, "meaningful_write");
    const bytes = new ArrayBuffer(8);
    await client.validateBackupStage(bytes, {
      appInstanceId,
      activeGenerationId: `gen_${"d".repeat(26)}`,
      lineageEpoch: "0",
      protectionRevision: "1",
      digestSchema: 1,
      stateSha256: `sha256:${"e".repeat(64)}`,
    });
    await client.publishBackup({} as never);
    await client.backupRecords();

    expect(posted.map(message => message.op)).toEqual([
      "backupSelection",
      "prepareAutomaticBackup",
      "validateBackupStage",
      "publishBackup",
      "backupRecords",
    ]);
    expect(posted[1]?.payload).toEqual({ target, reason: "meaningful_write" });
    expect(transfers[2]).toEqual([bytes]);
  });

  it("routes authenticated restore validation and restore-as-new grants through the worker", async () => {
    const bytes = new ArrayBuffer(16);
    const restoredBoot = {
      persistent: true,
      seeded: true,
      shellId: "tracker",
      selectedAppInstanceId: `app_${"r".repeat(26)}`,
      catalogGeneration: "12",
      apps: [{ id: `app_${"r".repeat(26)}`, name: "Restored", shellId: "tracker" }],
    } as const;
    const { client, posted, transfers } = harness(message =>
      message.op === "restoreAsNew" ? restoredBoot : null);
    await client.validateRestoreArchive(bytes);
    await expect(client.restoreAsNew({ schema: 1 } as never)).resolves.toEqual(restoredBoot);
    expect(posted.map(message => message.op)).toEqual([
      "validateRestoreArchive",
      "restoreAsNew",
    ]);
    expect(transfers[0]).toEqual([bytes]);
    expect(transfers[1]).toEqual([]);
  });

  it("requests one authority archive and preserves its target metadata", async () => {
    const bytes = new ArrayBuffer(16);
    const target = {
      appInstanceId: `app_${"a".repeat(26)}`,
      activeGenerationId: `gen_${"b".repeat(26)}`,
      lineageEpoch: "0",
      protectionRevision: "7",
      digestSchema: 1 as const,
      stateSha256: `sha256:${"c".repeat(64)}`,
    };
    const response = {
      format: 5 as const,
      bytes,
      filename: "field-service.clay",
      target,
      catalogGeneration: "12",
      authentication: {
        schema: 1 as const,
        kind: "cose_mac0_hmac_256_256" as const,
        authenticationVersion: 1 as const,
        keyId: "10".repeat(16),
        seriesId: "20".repeat(16),
        generation: "3",
      },
    };
    const { client, posted, transfers } = harness(message =>
      message.op === "exportArchive" ? response : null);

    await expect(client.exportArchive()).resolves.toEqual(response);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ op: "exportArchive" });
    expect(posted[0]!.payload).toBeUndefined();
    expect(transfers[0]).toEqual([]);
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
