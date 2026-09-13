import { expect, it, vi } from "vitest";
import { IntakeSession } from "../src/intake/session";
import type { WorkerClient } from "../src/app/worker-client";
import { readPresentationIntent } from "../src/app/presentation-intent";

it("retains exact intake command source/payload/ID across response loss and rejects another app", async () => {
  const rows = new Map<string, string>(); const storage = { getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => { rows.set(key, value); }, removeItem: (key: string) => { rows.delete(key); } };
  const target = { appInstanceId: `app_${"a".repeat(26)}`, activeGenerationId: `gen_${"b".repeat(26)}`, lineageEpoch: "0", protectionRevision: "2", digestSchema: 1 as const, stateSha256: `sha256:${"c".repeat(64)}` };
  let outcome: any = { status: "not_invoked" }; let wrong = false;
  const mutate = vi.fn(async () => { outcome = { status: "recorded", current: true, target: { ...target, protectionRevision: "3" }, result: null }; throw new Error("Owned lost response"); });
  const worker = { createMutationContext: () => ({ requestId: `req_${"d".repeat(26)}` }), intakeCommand: mutate, mutationOutcome: async () => outcome,
    intakePresentation: async () => ({ authorityTarget: { ...target, appInstanceId: wrong ? `app_${"z".repeat(26)}` : target.appInstanceId },
      legacyCustody: "none", forms: [], inbox: [], receipts: [], deliveryFailures: [], tables: [], trace: { tables: [], fields: [] } }) } as unknown as WorkerClient;
  const first = new IntakeSession(storage, worker, target.appInstanceId); await first.read();
  await expect(first.command("intake.rejectSubmission", { submissionId: `sub_${"s".repeat(26)}` })).rejects.toThrow(/lost/);
  const intent = readPresentationIntent(storage, target.appInstanceId, "intake")!; expect(intent.payload.authorityTarget).toEqual(target);
  const reloaded = new IntakeSession(storage, worker, target.appInstanceId); await reloaded.read();
  await reloaded.retry(); expect(mutate).toHaveBeenCalledTimes(1); expect(readPresentationIntent(storage, target.appInstanceId, "intake")).toBeNull();
  wrong = true; await expect(reloaded.read()).rejects.toThrow(/source/);
});
