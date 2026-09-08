import { describe, expect, it } from "vitest";
import type { ProjectionRequestV1 } from "@clay/kernel/projection";
import { WorkerClient } from "../src/app/worker-client";

type Posted = {
  id: number;
  op: string;
  payload?: Record<string, unknown>;
};

type Response = {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
};

const request: ProjectionRequestV1 = {
  schema: 1,
  kind: "record",
  expectedSchemaVersion: 2,
  tableId: "tbl_018f0000-0000-7000-8000-000000000001",
  fieldIds: ["fld_018f0000-0000-7000-8000-000000000002"],
  recordId: "018f0000-0000-7000-8000-000000000003",
  options: { includeRecordIds: false, redactedFieldIds: [] },
};

function controlledHarness(): {
  client: WorkerClient;
  posted: Posted[];
  reply: (message: Response) => void;
} {
  const posted: Posted[] = [];
  const worker = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage(message: Posted): void { posted.push(message); },
    terminate(): void {},
  };
  const client = new WorkerClient(worker as unknown as Worker);
  return {
    client,
    posted,
    reply: message => worker.onmessage?.({ data: message }),
  };
}

async function rejectionOf(promise: Promise<unknown>): Promise<Error & { code?: unknown }> {
  try { await promise; }
  catch (reason) { return reason as Error & { code?: unknown }; }
  throw new Error("expected worker projection to reject");
}

describe("WorkerClient projection cancellation quiescence", () => {
  it("settles only after a correlated worker terminal and quiescence acknowledgement", async () => {
    const { client, posted, reply } = controlledHarness();
    const controller = new AbortController();
    const pending = client.projectExport(request, controller.signal);
    controller.abort();

    expect(posted).toHaveLength(2);
    const projectionId = posted[0]!.id;
    const cancellationId = posted[1]!.id;
    expect(posted[1]).toMatchObject({
      op: "cancelProjectionV1", payload: { targetId: projectionId },
    });

    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    reply({
      id: cancellationId,
      ok: true,
      result: { targetId: projectionId, quiescent: true, outcome: "cancelled" },
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    reply({
      id: projectionId,
      ok: false,
      error: { code: "E_CANCELLED", message: "projection stopped" },
    });
    await expect(pending).rejects.toMatchObject({
      code: "E_CANCELLED",
      detail: { targetId: projectionId, quiescent: true, outcome: "cancelled" },
    });
    expect(settled).toBe(true);
  });

  it("does not report cancellation when a no-op worker emits a late artifact", async () => {
    const { client, posted, reply } = controlledHarness();
    const controller = new AbortController();
    const pending = client.projectExport(request, controller.signal);
    controller.abort();

    reply({ id: posted[1]!.id, ok: true, result: null });
    reply({ id: posted[0]!.id, ok: true, result: { late: "artifact" } });
    await expect(pending).rejects.toThrow(/cancellation.*quiescence|late artifact/i);
  });

  it("rejects a cancellation terminal that disagrees with its quiescence outcome", async () => {
    const { client, posted, reply } = controlledHarness();
    const controller = new AbortController();
    const pending = client.projectExport(request, controller.signal);
    controller.abort();

    reply({
      id: posted[1]!.id,
      ok: true,
      result: { targetId: posted[0]!.id, quiescent: true, outcome: "completed" },
    });
    reply({
      id: posted[0]!.id,
      ok: false,
      error: { code: "E_CANCELLED", message: "untrusted cancellation terminal" },
    });
    const error = await rejectionOf(pending);
    expect(error.code).not.toBe("E_CANCELLED");
    expect(error.message).toMatch(/cancellation.*disagree|invalid.*outcome/i);
  });
});
