import { open, readFile, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_BACKUP_ARCHIVE_BYTES, type BackupStageValidation } from "../src/backup";
import { runExternalBackup, type ExternalBackupDirectory } from "../src/external-backup";
import {
  DeterministicBackupAuthority,
  TARGET,
  backupRun,
} from "./external-backup-fakes";

const enabled = process.env.RELEASE_B_MEMORY_GATE === "1";
const MEBIBYTE = 1024 * 1024;

type MemorySample = Readonly<{
  arrayBuffers: number;
  external: number;
  rss: number;
}>;

function sampleMemory(): MemorySample {
  const usage = process.memoryUsage();
  return {
    arrayBuffers: usage.arrayBuffers,
    external: usage.external,
    rss: usage.rss,
  };
}

describe.skipIf(!enabled)("Release B maximum-size backup memory gate", () => {
  it("releases one 384 MiB source backing store before allocating exact read-back", async () => {
    const path = join(tmpdir(), `clay-release-b-memory-${process.pid}-${Date.now()}.clay`);
    const baseline = sampleMemory();
    const source = new Uint8Array(MAX_BACKUP_ARCHIVE_BYTES);
    source.fill(0x5a);
    const afterSource = sampleMemory();
    const run = backupRun(source);
    const authority = new DeterministicBackupAuthority(run.expected);
    const openedHandles: FileHandle[] = [];
    let handle: FileHandle | null = null;
    let sourceDetachedBeforeRead = false;
    let beforeRead: MemorySample | null = null;
    let afterRead: MemorySample | null = null;

    const directory: ExternalBackupDirectory = {
      targetId: TARGET.targetId,
      createNew: async () => {
        handle = await open(path, "wx");
        openedHandles.push(handle);
        return {
          write: async bytes => {
            let offset = 0;
            while (offset < bytes.byteLength) {
              const result = await handle!.write(
                bytes,
                offset,
                bytes.byteLength - offset,
                offset,
              );
              if (result.bytesWritten <= 0) throw new Error("backup write made no progress");
              offset += result.bytesWritten;
            }
          },
          close: async () => {
            await handle!.sync();
            await handle!.close();
            handle = null;
          },
        };
      },
      readExact: async () => {
        sourceDetachedBeforeRead = source.byteLength === 0;
        beforeRead = sampleMemory();
        const bytes = await readFile(path);
        afterRead = sampleMemory();
        return bytes;
      },
      removeExact: async () => { await rm(path, { force: true }); },
    };
    const validStage: BackupStageValidation = {
      schema: 1,
      status: "valid",
      evidence: structuredClone(run.expected.target),
      authentication: structuredClone(run.archive.authentication),
    };

    try {
      const result = await runExternalBackup(run, source, {
        directory,
        authority,
        validateArchiveStage: async () => validStage,
        now: () => "2026-09-08T12:30:00.000Z",
        archiveBytesOwnership: "transferred",
      });

      expect(result.status).toBe("published");
      expect(sourceDetachedBeforeRead).toBe(true);
      expect(source.byteLength).toBe(0);
      expect(beforeRead).not.toBeNull();
      expect(afterRead).not.toBeNull();

      const sourceBytes = afterSource.arrayBuffers - baseline.arrayBuffers;
      const retainedBeforeRead = beforeRead!.arrayBuffers - baseline.arrayBuffers;
      const readBackBytes = afterRead!.arrayBuffers - beforeRead!.arrayBuffers;
      const measuredPeak = Math.max(
        afterSource.arrayBuffers,
        afterRead!.arrayBuffers,
      ) - baseline.arrayBuffers;

      expect(sourceBytes).toBeGreaterThanOrEqual(MAX_BACKUP_ARCHIVE_BYTES - MEBIBYTE);
      expect(retainedBeforeRead).toBeLessThanOrEqual(MEBIBYTE);
      expect(readBackBytes).toBeGreaterThanOrEqual(MAX_BACKUP_ARCHIVE_BYTES - MEBIBYTE);
      expect(measuredPeak).toBeLessThanOrEqual(MAX_BACKUP_ARCHIVE_BYTES + 8 * MEBIBYTE);

      console.log(`RELEASE_B_MEMORY ${JSON.stringify({
        status: "pass",
        archiveBytes: MAX_BACKUP_ARCHIVE_BYTES,
        baseline,
        afterSource,
        beforeRead,
        afterRead,
        sourceBytes,
        retainedBeforeRead,
        readBackBytes,
        measuredPeak,
      })}`);
    } finally {
      for (const openedHandle of openedHandles)
        await openedHandle.close().catch(() => {});
      await rm(path, { force: true });
    }
  }, 120_000);
});
