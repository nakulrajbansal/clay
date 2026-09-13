import { expect, it, vi } from "vitest";
import { ManualDownloadRecovery } from "../src/app/manual-download-recovery";

const id = (p: string, c: string) => `${p}_${c.repeat(26)}`;
const app = id("app", "a");
const record = { schema: 2 as const, kind: "manual_download" as const, archiveFormat: 5 as const,
  fileName: "test.clay", byteLength: 3, startedAt: "2026-09-12T00:00:00.000Z", verification: "unverified_external_save" as const,
  authentication: { schema: 1 as const, kind: "cose_mac0_hmac_256_256" as const, authenticationVersion: 1 as const,
    keyId: "a".repeat(32), seriesId: "b".repeat(32), generation: "1" }, archiveSha256: `sha256:${"c".repeat(64)}`,
  evidence: { appInstanceId: app, activeGenerationId: id("gen", "b"), lineageEpoch: "0", protectionRevision: "1",
    digestSchema: 1 as const, stateSha256: `sha256:${"d".repeat(64)}` } };
function fixture() {
  const items = new Map<string, string>();
  const storage = { getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value); }, removeItem: (key: string) => { items.delete(key); } };
  let outcome: "not_recorded" | "recorded" | "uncertain" = "not_recorded";
  const worker = { createMutationContext: () => ({ requestId: id("req", "e") }),
    manualBackupDownloadOutcome: vi.fn(async () => ({ status: outcome })),
    recordManualBackupDownload: vi.fn(async () => { outcome = "recorded"; return record; }),
    validateManualBackupDownload: vi.fn(async () => {}) };
  const recovery = () => new ManualDownloadRecovery(storage, worker);
  return { storage, worker, recovery, setOutcome: (value: typeof outcome) => { outcome = value; } };
}

it("retains immutable record/request before handoff and reconciles a lost response after full presentation reload", async () => {
  const f = fixture(); const first = f.recovery(); const input = structuredClone(record);
  const pending = first.prepare(app, input); input.fileName = "changed.clay";
  first.handedOff(app, pending.requestId);
  f.worker.recordManualBackupDownload.mockImplementationOnce(async () => { f.setOutcome("recorded"); throw new Error("lost response"); });
  await expect(first.resume(app)).rejects.toThrow(/lost response/);
  const resumed = f.recovery(); expect(resumed.pending(app)?.record).toEqual(record);
  expect(await resumed.resume(app)).toBe(true);
  expect(f.worker.recordManualBackupDownload).toHaveBeenCalledTimes(1);
  expect(resumed.pending(app)).toBeNull();
});

it("fails closed on persistence, identity changes, unknown outcomes and another selected app", async () => {
  const f = fixture(); const recovery = f.recovery();
  vi.spyOn(f.storage, "setItem").mockImplementationOnce(() => { throw new Error("storage failed"); });
  expect(() => recovery.prepare(app, record)).toThrow(/storage failed/);
  const pending = recovery.prepare(app, record);
  expect(() => recovery.prepare(app, { ...record, fileName: "changed.clay" })).toThrow(/immutable/);
  expect(() => recovery.prepare(id("app", "z"), record)).toThrow(/app/);
  expect(recovery.pending(id("app", "z"))).toBeNull();
  f.setOutcome("uncertain"); await expect(recovery.resume(app)).rejects.toThrow(/uncertain/);
  expect(recovery.pending(app)?.requestId).toBe(pending.requestId);
  expect(f.worker.recordManualBackupDownload).not.toHaveBeenCalled();
});

it("requires file verification when browser handoff was interrupted; retains the same request on recovery", async () => {
  const f = fixture(); const pending = f.recovery().prepare(app, record);
  await expect(f.recovery().resume(app)).rejects.toThrow(/file/);
  const file = new ArrayBuffer(3);
  expect(await f.recovery().resume(app, file)).toBe(true);
  expect(f.worker.validateManualBackupDownload).toHaveBeenCalledWith(file, record);
  expect(f.worker.recordManualBackupDownload).toHaveBeenCalledWith(record, { requestId: pending.requestId });
});
