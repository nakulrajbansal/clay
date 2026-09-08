import { describe, expect, it } from "vitest";
import type { BackupTrustRecordStore } from "@clay/kernel/backup";
import { BackupTrustRuntime } from "../src/worker/backup-trust-runtime";

const backupId = `bkp_${"b".repeat(26)}`;

class MemoryRuntimeStore implements BackupTrustRecordStore {
  readonly rows = new Map<string, unknown>();
  active: { revision: string; seriesId: string } | null = null;

  async load(seriesId: string): Promise<unknown | null> {
    const value = this.rows.get(seriesId);
    return value === undefined ? null : structuredClone(value);
  }

  async compareAndSet(
    seriesId: string,
    expectedRevision: string | null,
    next: unknown,
  ): Promise<boolean> {
    const current = this.rows.get(seriesId) as { revision?: string } | undefined;
    if ((current?.revision ?? null) !== expectedRevision) return false;
    this.rows.set(seriesId, structuredClone(next));
    return true;
  }

  async loadActiveSeries(): Promise<{ revision: string; seriesId: string } | null> {
    return this.active ? { ...this.active } : null;
  }

  async compareAndSetActiveSeries(
    expectedRevision: string | null,
    seriesId: string,
  ): Promise<boolean> {
    if ((this.active?.revision ?? null) !== expectedRevision) return false;
    this.active = {
      revision: expectedRevision === null ? "0" : String(BigInt(expectedRevision) + 1n),
      seriesId,
    };
    return true;
  }
}

describe("worker Backup Trust runtime", () => {
  it("withholds trust until downloaded Recovery Kit bytes are test-imported, then survives restart", async () => {
    const store = new MemoryRuntimeStore();
    const runtime = new BackupTrustRuntime(store, {
      randomFill: target => target.forEach((_, index) => { target[index] = index + 1; }),
      createEnrollmentId: () => `enroll_${"c".repeat(26)}`,
    });

    await expect(runtime.status()).resolves.toEqual({ status: "not_enrolled" });
    const enrollment = runtime.beginEnrollment();
    expect(enrollment).toMatchObject({
      enrollmentId: `enroll_${"c".repeat(26)}`,
      fileName: expect.stringMatching(/^clay-recovery-kit-[0-9a-f]{12}\.txt$/),
    });
    expect(enrollment.bytes).toBeInstanceOf(Uint8Array);
    await expect(runtime.status()).resolves.toEqual({
      status: "needs_test_import",
      enrollmentId: enrollment.enrollmentId,
    });

    const wrong = enrollment.bytes.slice();
    wrong[wrong.byteLength - 1] = wrong[wrong.byteLength - 1]! ^ 1;
    await expect(runtime.confirmEnrollment(enrollment.enrollmentId, wrong))
      .rejects.toThrow(/Recovery Kit|read-back/i);
    expect(await store.loadActiveSeries()).toBeNull();

    const ready = await runtime.confirmEnrollment(
      enrollment.enrollmentId, enrollment.bytes.slice(),
    );
    expect(ready.status).toBe("ready");
    expect(ready).not.toHaveProperty("backupTrustKey");
    expect(await store.loadActiveSeries()).toMatchObject({ seriesId: ready.seriesId });
    await expect(runtime.status()).resolves.toEqual(ready);

    const reservation = await runtime.reserve(backupId);
    expect(reservation.generation).toBe(1n);
    reservation.backupTrustKey.fill(0xff);

    const restarted = new BackupTrustRuntime(store);
    await expect(restarted.status()).resolves.toMatchObject({
      status: "ready",
      seriesId: ready.seriesId,
      pending: { backupId, generation: "1" },
    });
    const retried = await restarted.reserve(backupId);
    expect(retried.generation).toBe(1n);
    expect(retried.backupTrustKey[0]).toBe(1);
  });

  it("imports an existing Recovery Kit as verifier-only until an explicit confirmed activation", async () => {
    const sourceStore = new MemoryRuntimeStore();
    const source = new BackupTrustRuntime(sourceStore, {
      randomFill: target => target.forEach((_, index) => { target[index] = 64 - index; }),
      createEnrollmentId: () => `enroll_${"d".repeat(26)}`,
    });
    const enrollment = source.beginEnrollment();

    const destinationStore = new MemoryRuntimeStore();
    const destination = new BackupTrustRuntime(destinationStore);
    const imported = await destination.importRecoveryKit(enrollment.bytes.slice());
    expect(imported).toMatchObject({
      status: "imported_verifier",
      freshness: "unknown",
      activeForBackup: false,
    });
    expect(await destinationStore.loadActiveSeries()).toBeNull();
    await expect(destination.status()).resolves.toEqual({ status: "not_enrolled" });
    await expect(destination.keyForSeries(imported.seriesId)).resolves.toEqual(
      Uint8Array.from({ length: 32 }, (_, index) => 64 - index),
    );

    await expect(destination.activateImportedSeries({
      seriesId: imported.seriesId,
      expectedActiveSeriesId: null,
      confirmation: "use_imported_recovery_kit_for_future_backups",
    })).resolves.toMatchObject({
      status: "ready",
      seriesId: imported.seriesId,
      freshness: "unknown",
    });
  });

  it("does not retire an unfinished generated kit merely because a verifier kit is imported", async () => {
    const source = new BackupTrustRuntime(new MemoryRuntimeStore(), {
      randomFill: target => target.forEach((_, index) => { target[index] = index + 7; }),
      createEnrollmentId: () => `enroll_${"e".repeat(26)}`,
    });
    const imported = source.beginEnrollment();
    const destinationStore = new MemoryRuntimeStore();
    const destination = new BackupTrustRuntime(destinationStore, {
      randomFill: target => target.forEach((_, index) => { target[index] = 64 - index; }),
      createEnrollmentId: () => `enroll_${"f".repeat(26)}`,
    });
    const pending = destination.beginEnrollment();

    const verifier = await destination.importRecoveryKit(imported.bytes.slice());
    await expect(destination.status()).resolves.toMatchObject({
      status: "needs_test_import",
      enrollmentId: pending.enrollmentId,
    });
    expect(await destinationStore.loadActiveSeries()).toBeNull();

    await expect(destination.activateImportedSeries({
      seriesId: verifier.seriesId,
      expectedActiveSeriesId: null,
      confirmation: "use_imported_recovery_kit_for_future_backups",
    })).resolves.toMatchObject({ status: "ready", seriesId: verifier.seriesId });
    await expect(destination.confirmEnrollment(
      pending.enrollmentId,
      pending.bytes.slice(),
    )).rejects.toThrow(/unavailable|expired/i);
  });
});
