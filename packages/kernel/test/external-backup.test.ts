import { describe, expect, it, vi } from "vitest";
import type { BackupSelectedTarget } from "../src/backup";
import {
  buildAutomaticBackupFileName,
  runExternalBackup,
} from "../src/external-backup";
import {
  DeterministicBackupAuthority,
  DeterministicDirectory,
  DeterministicStageValidator,
  TARGET,
  backupRun,
  historicalRecord,
  id,
} from "./external-backup-fakes";

describe("Release B2 automatic external-backup execution", () => {
  it("reconciles an interrupted close on retry without overwriting the existing file", async () => {
    const events: string[] = []; const bytes = new TextEncoder().encode("complete but unacknowledged archive");
    const run = { ...backupRun(bytes), attempt: "write_reconcile" };
    const directory = new DeterministicDirectory(TARGET.targetId, events);
    const name = buildAutomaticBackupFileName(run.fileLabel, run.generationId, run.createdAt);
    directory.files.set(name, bytes.slice());
    const authority = new DeterministicBackupAuthority(run.expected, events); const stage = new DeterministicStageValidator(events);
    const result = await runExternalBackup(run, bytes, { directory, authority, validateArchiveStage: stage.validate,
      now: () => "2026-09-05T20:01:03.000Z" });
    expect(result.status).toBe("published"); expect(directory.files.get(name)).toEqual(bytes);
    expect(events.some(event => event.startsWith("directory:write:") || event.startsWith("directory:remove:"))).toBe(false);
  });
  it("sanitizes presentation text into one unique bounded owned filename", () => {
    const name = buildAutomaticBackupFileName(
      " ../客户\\Quarterly Payroll 🚨 <script> ",
      id("backupgen", "k"),
      "2026-09-05T20:01:02.003Z",
    );
    expect(name).toBe(
      "clay-quarterly-payroll-script-20260905T200102003Z-backupgen_kkkkkkkkkkkkkkkkkkkkkkkkkk.clay",
    );
    expect(name).not.toMatch(/[\\/]/);
    expect(name).not.toContain("..");
    expect(name.length).toBeLessThanOrEqual(160);
  });

  it("writes, closes, reacquires, stages, rechecks selection, and publishes in order", async () => {
    const events: string[] = [];
    const bytes = new TextEncoder().encode("format-5 authority snapshot");
    const run = backupRun(bytes);
    const directory = new DeterministicDirectory(TARGET.targetId, events);
    const authority = new DeterministicBackupAuthority(run.expected, events);
    const stage = new DeterministicStageValidator(events);

    const result = await runExternalBackup(run, bytes, {
      directory,
      authority,
      validateArchiveStage: stage.validate,
      now: () => "2026-09-05T20:01:03.000Z",
    });

    expect(result).toMatchObject({
      schema: 1,
      status: "published",
      publication: "published",
      record: {
        backupId: run.backupId,
        generationId: run.generationId,
        evidence: run.expected.target,
        archiveFormat: 5,
        byteLength: bytes.byteLength,
        archiveSha256: run.archive.archiveSha256,
        state: "valid",
        validationCode: "archive_valid",
      },
      rotation: { requested: 0, deleted: 0, failed: 0 },
    });
    expect(events).toEqual([
      "authority:read-selection",
      expect.stringMatching(/^directory:create:clay-field-ops-/),
      `directory:write:${bytes.byteLength}`,
      "directory:close",
      expect.stringMatching(/^directory:read:clay-field-ops-/),
      "stage:validate",
      "authority:read-selection",
      "authority:publish",
    ]);
    expect(stage.observedBytes).toEqual(bytes);
    expect(authority.requests).toHaveLength(1);
    expect("bytes" in authority.requests[0]!).toBe(false);
  });

  it("rejects a short final readback before stage/publication and preserves the prior valid copy", async () => {
    const events: string[] = [];
    const bytes = new TextEncoder().encode("archive snapshot with complete bytes");
    const run = backupRun(bytes);
    const directory = new DeterministicDirectory(TARGET.targetId, events);
    const priorName = buildAutomaticBackupFileName(
      "Field Ops", id("backupgen", "m"), "2026-09-04T20:01:02.003Z",
    );
    directory.files.set(priorName, new Uint8Array([1, 2, 3]));
    directory.shortWrite = true;
    const authority = new DeterministicBackupAuthority(run.expected, events);
    const stage = new DeterministicStageValidator(events);

    const result = await runExternalBackup(run, bytes, {
      directory,
      authority,
      validateArchiveStage: stage.validate,
      now: () => "2026-09-05T20:01:03.000Z",
    });

    expect(result).toEqual({
      schema: 1, status: "failed", reasonCode: "short_write", historical: null,
    });
    expect(directory.files.get(priorName)).toEqual(new Uint8Array([1, 2, 3]));
    expect(authority.requests).toHaveLength(0);
    expect(events).not.toContain("stage:validate");
    expect(events.some(event => event.startsWith("directory:remove:"))).toBe(false);
  });

  it("rejects digest-corrupt final bytes and preserves the prior valid copy", async () => {
    const events: string[] = [];
    const bytes = new TextEncoder().encode("archive snapshot to corrupt on read");
    const run = backupRun(bytes);
    const directory = new DeterministicDirectory(TARGET.targetId, events);
    const priorName = buildAutomaticBackupFileName(
      "Field Ops", id("backupgen", "n"), "2026-09-03T20:01:02.003Z",
    );
    directory.files.set(priorName, new Uint8Array([4, 5, 6]));
    directory.corruptRead = true;
    const authority = new DeterministicBackupAuthority(run.expected, events);
    const stage = new DeterministicStageValidator(events);

    const result = await runExternalBackup(run, bytes, {
      directory,
      authority,
      validateArchiveStage: stage.validate,
      now: () => "2026-09-05T20:01:03.000Z",
    });

    expect(result).toEqual({
      schema: 1, status: "failed", reasonCode: "digest_mismatch", historical: null,
    });
    expect(directory.files.get(priorName)).toEqual(new Uint8Array([4, 5, 6]));
    expect(authority.requests).toHaveLength(0);
    expect(events).not.toContain("stage:validate");
    expect(events.some(event => event.startsWith("directory:remove:"))).toBe(false);
  });

  it("fails a same-name collision without overwriting or validating the existing file", async () => {
    const events: string[] = [];
    const bytes = new TextEncoder().encode("new archive bytes");
    const run = backupRun(bytes);
    const directory = new DeterministicDirectory(TARGET.targetId, events);
    const collidingName = buildAutomaticBackupFileName(
      run.fileLabel, run.generationId, run.createdAt,
    );
    const existing = new TextEncoder().encode("unrelated existing bytes");
    directory.files.set(collidingName, existing.slice());
    const authority = new DeterministicBackupAuthority(run.expected, events);
    const stage = new DeterministicStageValidator(events);

    const result = await runExternalBackup(run, bytes, {
      directory,
      authority,
      validateArchiveStage: stage.validate,
      now: () => "2026-09-05T20:01:03.000Z",
    });

    expect(result).toEqual({
      schema: 1, status: "failed", reasonCode: "destination_collision", historical: null,
    });
    expect(directory.files.get(collidingName)).toEqual(existing);
    expect(events).toEqual([
      "authority:read-selection",
      `directory:create:${collidingName}`,
    ]);
    expect(authority.requests).toHaveLength(0);
  });

  const driftCases: Array<{
    name: string;
    mutate(selection: BackupSelectedTarget): void;
    reasonCode: "backup_stale" | "generation_not_selected" | "stale_write_epoch";
  }> = [
    {
      name: "authority incarnation",
      mutate: selection => { selection.authorityIncarnationId = id("auth", "k"); },
      reasonCode: "backup_stale",
    },
    {
      name: "catalog generation",
      mutate: selection => { selection.catalogGeneration = "31"; },
      reasonCode: "backup_stale",
    },
    {
      name: "write epoch",
      mutate: selection => { selection.writeEpoch = "8"; },
      reasonCode: "stale_write_epoch",
    },
    {
      name: "selected app and target app",
      mutate: selection => {
        selection.selectedAppInstanceId = id("app", "k");
        selection.target.appInstanceId = selection.selectedAppInstanceId;
      },
      reasonCode: "generation_not_selected",
    },
    {
      name: "selected and target active generation",
      mutate: selection => {
        selection.selectedActiveGenerationId = id("gen", "k");
        selection.target.activeGenerationId = selection.selectedActiveGenerationId;
      },
      reasonCode: "generation_not_selected",
    },
    {
      name: "target lineage",
      mutate: selection => { selection.target.lineageEpoch = "5"; },
      reasonCode: "backup_stale",
    },
    {
      name: "target revision",
      mutate: selection => { selection.target.protectionRevision = "12"; },
      reasonCode: "backup_stale",
    },
    {
      name: "target digest",
      mutate: selection => { selection.target.stateSha256 = `sha256:${"d".repeat(64)}`; },
      reasonCode: "backup_stale",
    },
  ];

  it.each(driftCases)(
    "keeps a validated file historical when $name drifts before publication",
    async ({ mutate, reasonCode }) => {
      const events: string[] = [];
      const bytes = new TextEncoder().encode("valid captured archive");
      const run = backupRun(bytes);
      const directory = new DeterministicDirectory(TARGET.targetId, events);
      const priorName = buildAutomaticBackupFileName(
        "Field Ops", id("backupgen", "p"), "2026-09-02T20:01:02.003Z",
      );
      directory.files.set(priorName, new Uint8Array([9, 8, 7]));
      const authority = new DeterministicBackupAuthority(run.expected, events);
      const stage = new DeterministicStageValidator(events);
      const validateWithDrift = async (...args: Parameters<typeof stage.validate>) => {
        const result = await stage.validate(...args);
        const changed = structuredClone(authority.selected);
        mutate(changed);
        authority.selected = changed;
        return result;
      };

      const result = await runExternalBackup(run, bytes, {
        directory,
        authority,
        validateArchiveStage: validateWithDrift,
        now: () => "2026-09-05T20:01:03.000Z",
      });

      expect(result).toMatchObject({
        schema: 1,
        status: "failed",
        reasonCode,
        historical: {
          backupId: run.backupId,
          generationId: run.generationId,
          evidence: run.expected.target,
          archiveSha256: run.archive.archiveSha256,
        },
      });
      expect(directory.files.get(priorName)).toEqual(new Uint8Array([9, 8, 7]));
      expect(authority.requests).toHaveLength(0);
      expect(events.at(-1)).toBe("authority:read-selection");
      expect(events.some(event => event.startsWith("directory:remove:"))).toBe(false);
    },
  );

  it("reconciles a publication response loss idempotently without rewriting or early rotation", async () => {
    const events: string[] = [];
    const bytes = new TextEncoder().encode("one immutable response-loss snapshot");
    const run = backupRun(bytes);
    const directory = new DeterministicDirectory(TARGET.targetId, events);
    const authority = new DeterministicBackupAuthority(run.expected, events);
    const stage = new DeterministicStageValidator(events);
    const oldName = buildAutomaticBackupFileName(
      "Field Ops", id("backupgen", "q"), "2026-09-01T20:01:02.003Z",
    );
    const old = historicalRecord("q", oldName, "2026-09-01T20:01:02.003Z");
    directory.files.set(oldName, new Uint8Array([1, 2, 3]));
    authority.rotate = [old];
    authority.loseNextPublicationResponse = true;

    const first = await runExternalBackup(run, bytes, {
      directory,
      authority,
      validateArchiveStage: stage.validate,
      now: () => "2026-09-05T20:01:03.000Z",
    });

    expect(first).toMatchObject({
      status: "failed",
      reasonCode: "publication_failed",
      historical: { backupId: run.backupId },
    });
    expect(directory.files.get(oldName)).toEqual(new Uint8Array([1, 2, 3]));
    expect(events.some(event => event.startsWith("directory:remove:"))).toBe(false);

    const retry = {
      ...run,
      reason: "retry" as const,
      attempt: "publication_reconcile" as const,
      expected: { ...run.expected, catalogGeneration: authority.selected.catalogGeneration },
    };
    const second = await runExternalBackup(retry, bytes, {
      directory,
      authority,
      validateArchiveStage: stage.validate,
      now: () => "2026-09-05T20:01:10.000Z",
    });

    expect(second).toMatchObject({
      status: "published",
      publication: "already_published",
      record: { backupId: run.backupId, publicationCatalogGeneration: "31" },
      rotation: { requested: 1, deleted: 1, failed: 0 },
    });
    expect(events.filter(event => event.startsWith("directory:create:"))).toHaveLength(1);
    expect(events.filter(event => event.startsWith("directory:write:"))).toHaveLength(1);
    expect(directory.files.has(oldName)).toBe(false);
    expect(authority.records).toHaveLength(1);
    expect(authority.requests).toHaveLength(2);
  });

  it("rotates exact owned records in authority order only after publication", async () => {
    const events: string[] = [];
    const bytes = new TextEncoder().encode("rotation source archive");
    const run = backupRun(bytes);
    const directory = new DeterministicDirectory(TARGET.targetId, events);
    const authority = new DeterministicBackupAuthority(run.expected, events);
    const stage = new DeterministicStageValidator(events);
    const firstName = buildAutomaticBackupFileName(
      "Field Ops", id("backupgen", "r"), "2026-08-30T20:01:02.003Z",
    );
    const secondName = buildAutomaticBackupFileName(
      "Field Ops", id("backupgen", "s"), "2026-08-31T20:01:02.003Z",
    );
    const first = historicalRecord("r", firstName, "2026-08-30T20:01:02.003Z");
    const second = historicalRecord("s", secondName, "2026-08-31T20:01:02.003Z");
    directory.files.set(firstName, new Uint8Array([1, 2, 3]));
    directory.files.set(secondName, new Uint8Array([1, 2, 3]));
    directory.files.set("manual-family-photos.clay", new Uint8Array([6, 6, 6]));
    directory.removeFailures.add(firstName);
    authority.rotate = [first, second];

    const result = await runExternalBackup(run, bytes, {
      directory,
      authority,
      validateArchiveStage: stage.validate,
      now: () => "2026-09-05T20:01:03.000Z",
    });

    expect(result).toMatchObject({
      status: "published",
      rotation: { requested: 2, deleted: 1, failed: 1 },
    });
    const publishIndex = events.indexOf("authority:publish");
    const removalEvents = events.filter(event => event.startsWith("directory:remove:"));
    expect(removalEvents).toEqual([
      `directory:remove:${firstName}`,
      `directory:remove:${secondName}`,
    ]);
    expect(events.indexOf(removalEvents[0]!)).toBeGreaterThan(publishIndex);
    expect(directory.files.has(firstName)).toBe(true);
    expect(directory.files.has(secondName)).toBe(false);
    expect(directory.files.get("manual-family-photos.clay")).toEqual(new Uint8Array([6, 6, 6]));
  });

  it("refuses authority rotation entries owned by another copy target", async () => {
    const events: string[] = [];
    const bytes = new TextEncoder().encode("owned-only rotation source");
    const run = backupRun(bytes);
    const directory = new DeterministicDirectory(TARGET.targetId, events);
    const authority = new DeterministicBackupAuthority(run.expected, events);
    const stage = new DeterministicStageValidator(events);
    const otherName = buildAutomaticBackupFileName(
      "Field Ops", id("backupgen", "t"), "2026-08-29T20:01:02.003Z",
    );
    const otherTargetRecord = {
      ...historicalRecord("t", otherName, "2026-08-29T20:01:02.003Z"),
      targetId: id("tgt", "z"),
    };
    directory.files.set(otherName, new Uint8Array([1, 2, 3]));
    authority.rotate = [otherTargetRecord];

    const result = await runExternalBackup(run, bytes, {
      directory,
      authority,
      validateArchiveStage: stage.validate,
      now: () => "2026-09-05T20:01:03.000Z",
    });

    expect(result).toMatchObject({
      status: "failed",
      reasonCode: "publication_failed",
      historical: { backupId: run.backupId },
    });
    expect(directory.files.get(otherName)).toEqual(new Uint8Array([1, 2, 3]));
    expect(events.some(event => event.startsWith("directory:remove:"))).toBe(false);
  });

  it("does not retry a close that already failed after a completed write", async () => {
    const events: string[] = [];
    const bytes = new TextEncoder().encode("close failure archive");
    const run = backupRun(bytes);
    const directory = new DeterministicDirectory(TARGET.targetId, events);
    directory.closeFailure = "target_unreachable";
    const authority = new DeterministicBackupAuthority(run.expected, events);
    const stage = new DeterministicStageValidator(events);

    const result = await runExternalBackup(run, bytes, {
      directory,
      authority,
      validateArchiveStage: stage.validate,
      now: () => "2026-09-05T20:01:03.000Z",
    });

    expect(result).toMatchObject({ status: "failed", reasonCode: "target_unreachable" });
    expect(events.filter(event => event === "directory:close")).toHaveLength(1);
    expect(authority.requests).toHaveLength(0);
  });

  const closedFailureCases: Array<{
    name: string;
    reasonCode: "permission_required" | "quota_exceeded" | "target_unreachable"
      | "operation_interrupted" | "backup_invalid" | "publication_failed";
    historical: boolean;
    configure(
      directory: DeterministicDirectory,
      authority: DeterministicBackupAuthority,
      stage: DeterministicStageValidator,
    ): void;
  }> = [
    {
      name: "permission loss before create",
      reasonCode: "permission_required",
      historical: false,
      configure: directory => { directory.createFailure = "permission_required"; },
    },
    {
      name: "quota loss during write",
      reasonCode: "quota_exceeded",
      historical: false,
      configure: directory => { directory.writeFailure = "quota_exceeded"; },
    },
    {
      name: "interruption during write",
      reasonCode: "operation_interrupted",
      historical: false,
      configure: directory => { directory.writeFailure = "operation_interrupted"; },
    },
    {
      name: "unreachable target during close",
      reasonCode: "target_unreachable",
      historical: false,
      configure: directory => { directory.closeFailure = "target_unreachable"; },
    },
    {
      name: "unreachable target during final reacquisition",
      reasonCode: "target_unreachable",
      historical: false,
      configure: directory => { directory.readFailure = "target_unreachable"; },
    },
    {
      name: "isolated stage rejection",
      reasonCode: "backup_invalid",
      historical: false,
      configure: (_directory, _authority, stage) => { stage.invalid = true; },
    },
    {
      name: "isolated stage exception",
      reasonCode: "backup_invalid",
      historical: false,
      configure: (_directory, _authority, stage) => { stage.throws = true; },
    },
    {
      name: "authority publication failure",
      reasonCode: "publication_failed",
      historical: true,
      configure: (_directory, authority) => { authority.failBeforePublication = true; },
    },
  ];

  it.each(closedFailureCases)(
    "preserves the prior valid copy after $name",
    async ({ configure, historical, reasonCode }) => {
      const events: string[] = [];
      const bytes = new TextEncoder().encode("failure matrix archive bytes");
      const run = backupRun(bytes);
      const directory = new DeterministicDirectory(TARGET.targetId, events);
      const authority = new DeterministicBackupAuthority(run.expected, events);
      const stage = new DeterministicStageValidator(events);
      const priorName = buildAutomaticBackupFileName(
        "Field Ops", id("backupgen", "u"), "2026-08-28T20:01:02.003Z",
      );
      const priorBytes = new Uint8Array([3, 2, 1]);
      directory.files.set(priorName, priorBytes.slice());
      configure(directory, authority, stage);

      const result = await runExternalBackup(run, bytes, {
        directory,
        authority,
        validateArchiveStage: stage.validate,
        now: () => "2026-09-05T20:01:03.000Z",
      });

      expect(result).toMatchObject({ status: "failed", reasonCode });
      if (result.status === "failed")
        expect(result.historical === null).toBe(!historical);
      expect(directory.files.get(priorName)).toEqual(priorBytes);
      expect(events.some(event => event.startsWith("directory:remove:"))).toBe(false);
      expect(authority.records.size).toBe(0);
    },
  );

  it("copies the worker snapshot at entry and emits no plaintext, log, or network effect", async () => {
    const events: string[] = [];
    const secretText = "PRIVATE_ROW_VALUE_7f4b9e";
    const bytes = new TextEncoder().encode(secretText);
    const original = bytes.slice();
    const run = backupRun(bytes);
    const directory = new DeterministicDirectory(TARGET.targetId, events);
    const authority = new DeterministicBackupAuthority(run.expected, events);
    const stage = new DeterministicStageValidator(events);
    const fetchSpy = vi.fn(async () => { throw new Error("network is forbidden"); });
    vi.stubGlobal("fetch", fetchSpy);
    const consoleSpies = [
      vi.spyOn(console, "log").mockImplementation(() => undefined),
      vi.spyOn(console, "info").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
    ];

    try {
      const pending = runExternalBackup(run, bytes, {
        directory,
        authority,
        validateArchiveStage: stage.validate,
        now: () => "2026-09-05T20:01:03.000Z",
      });
      bytes.fill(0);
      const result = await pending;

      expect(result.status).toBe("published");
      const createdName = buildAutomaticBackupFileName(
        run.fileLabel, run.generationId, run.createdAt,
      );
      expect(directory.files.get(createdName)).toEqual(original);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(consoleSpies.every(spy => spy.mock.calls.length === 0)).toBe(true);
      expect(JSON.stringify({ result, requests: authority.requests, events })).not.toContain(secretText);
      expect(Object.hasOwn(authority.requests[0]!.artifact, "bytes")).toBe(false);
    } finally {
      for (const spy of consoleSpies) spy.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
