import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AutomaticBackupTriggerController,
  type AutomaticBackupTriggerTarget,
} from "../src/app/automatic-backup-trigger.browser";

const appInstanceId = `app_${"a".repeat(26)}`;
const target: AutomaticBackupTriggerTarget = {
  target: {
    schema: 1,
    targetId: `tgt_${"b".repeat(26)}`,
    appInstanceId,
    adapter: "browser_directory",
    adapterCertificationId: `btc_${"c".repeat(26)}`,
    authorizedAt: "2026-09-08T12:00:00.000Z",
  },
  folderName: "Backups",
};

function notice(revision: string) {
  return {
    appInstanceId,
    activeGenerationId: `gen_${"d".repeat(26)}`,
    lineageEpoch: "0",
    protectionRevision: revision,
    digestSchema: 1 as const,
    stateSha256: `sha256:${revision.padStart(64, "0")}`,
  };
}

describe("automatic backup authority-commit trigger", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces successful authority commits and enforces the app-open 15-minute deadline", async () => {
    const reasons: string[] = [];
    let succeeds = true;
    const controller = new AutomaticBackupTriggerController({
      getTarget: () => target,
      run: async (_target, reason) => {
        reasons.push(reason);
        return succeeds;
      },
      idleDelayMs: 30_000,
      deadlineMs: 15 * 60_000,
      minimumStartIntervalMs: 5 * 60_000,
    });

    controller.notifyAuthorityCommit(notice("1"));
    controller.notifyAuthorityCommit(notice("2"));
    controller.notifyAuthorityCommit(notice("2"));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(reasons).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(reasons).toEqual(["meaningful_write"]);

    succeeds = false;
    controller.notifyAuthorityCommit(notice("3"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reasons).toEqual(["meaningful_write"]);
    await vi.advanceTimersByTimeAsync(4 * 60_000 + 30_000);
    expect(reasons).toEqual(["meaningful_write", "meaningful_write"]);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(reasons.at(-1)).toBe("deadline");
    controller.stop();
  });

  it("does not spin expired deadline timers while a backup is still running", async () => {
    let finish!: (value: boolean) => void;
    const run = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
    const controller = new AutomaticBackupTriggerController({
      getTarget: () => target,
      run,
      idleDelayMs: 30_000,
      deadlineMs: 15 * 60_000,
      minimumStartIntervalMs: 5 * 60_000,
    });
    controller.notifyAuthorityCommit(notice("1"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(run).toHaveBeenCalledTimes(1);
    finish(false);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
    controller.stop();
  });

  it("ignores another app and cancels all work when the page closes", async () => {
    const run = vi.fn(async () => true);
    const controller = new AutomaticBackupTriggerController({
      getTarget: () => target,
      run,
      idleDelayMs: 30_000,
      deadlineMs: 15 * 60_000,
      minimumStartIntervalMs: 5 * 60_000,
    });
    controller.notifyAuthorityCommit({
      ...notice("1"),
      appInstanceId: `app_${"z".repeat(26)}`,
    });
    controller.notifyAuthorityCommit(notice("1"));
    controller.stop();
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(run).not.toHaveBeenCalled();
  });
});
