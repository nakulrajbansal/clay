import { expect, it, vi } from "vitest";
import { WorkerClient } from "../src/app/worker-client";

it("releases lost-response waiters without cancelling writes or reusing transport IDs", async () => {
  const posted: Array<{ id: number; op: string; requestId: string; payload: unknown }> = [];
  const worker = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage: (message: typeof posted[number]) => { posted.push(message); },
    terminate: vi.fn(),
  };
  const first = new WorkerClient(worker as unknown as Worker);
  const context = first.createMutationContext();
  const appId = `app_${"a".repeat(26)}`;
  const bootInfo = { persistent: true, seeded: false, shellId: "blank", selectedAppInstanceId: appId,
    catalogGeneration: "3", apps: [{ id: appId, name: "Renamed", shellId: "blank" }] };
  const pending = first.renameApp(appId, "Renamed", context).catch(error => error as Error);
  const replacement = new WorkerClient(worker as unknown as Worker);
  const result = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve("still pending"), 5))]);
  expect(result).toMatchObject({ code: "E_INTERNAL", message: expect.stringMatching(/outcome is unknown/i) });
  expect(worker.terminate).not.toHaveBeenCalled();
  const replay = replacement.renameApp(appId, "Renamed", context);
  expect(posted).toHaveLength(2);
  expect(posted[1]).toMatchObject({ ...posted[0], id: expect.any(Number) });
  expect(posted[1]!.id).toBeGreaterThan(posted[0]!.id);
  let settled = false;
  void replay.then(() => { settled = true; });
  worker.onmessage!({ data: { id: posted[0]!.id, ok: true, result: "late old reply" } } as MessageEvent);
  await Promise.resolve();
  expect(settled).toBe(false);
  worker.onmessage!({ data: { id: posted[1]!.id, ok: true, result: bootInfo } } as MessageEvent);
  expect(await replay).toEqual(bootInfo);
  first.terminate();
  expect(worker.terminate).not.toHaveBeenCalled();
  replacement.terminate();
  expect(worker.terminate).toHaveBeenCalledOnce();
});
