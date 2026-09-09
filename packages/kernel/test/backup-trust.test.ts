import { describe, expect, it } from "vitest";
import { encodeRecoveryKitV1, type BackupTrustMaterialV1 } from "../src/recovery-kit";
import {
  BackupTrustCoordinator,
  type BackupTrustRecordStore,
} from "../src/backup-trust";

const id = (prefix: string, char: string): string => `${prefix}_${char.repeat(26)}`;
const material = (): BackupTrustMaterialV1 => ({
  backupTrustKey: new Uint8Array(32).map((_, index) => index + 1),
  keyId: new Uint8Array(16).map((_, index) => index + 33),
  seriesId: new Uint8Array(16).map((_, index) => index + 49),
});
const seriesHex = "3132333435363738393a3b3c3d3e3f40";

class MemoryTrustStore implements BackupTrustRecordStore {
  readonly rows = new Map<string, unknown>();
  failCas = 0;

  async load(seriesId: string): Promise<unknown | null> {
    const value = this.rows.get(seriesId);
    return value === undefined ? null : structuredClone(value);
  }

  async compareAndSet(
    seriesId: string,
    expectedRevision: string | null,
    next: unknown,
  ): Promise<boolean> {
    if (this.failCas > 0) {
      this.failCas--;
      return false;
    }
    const current = this.rows.get(seriesId) as { revision?: string } | undefined;
    if ((current?.revision ?? null) !== expectedRevision) return false;
    this.rows.set(seriesId, structuredClone(next));
    return true;
  }
}

describe("Backup Trust generation coordinator", () => {
  it("enrolls only after exact Recovery Kit export and read-back", async () => {
    const store = new MemoryTrustStore();
    const coordinator = new BackupTrustCoordinator(store);
    const source = material();
    const kit = encodeRecoveryKitV1(source);
    const wrong = kit.slice();
    wrong[wrong.byteLength - 1] = wrong[wrong.byteLength - 1]! ^ 1;

    await expect(coordinator.enrollNew(source, kit, wrong)).rejects.toThrow(/Recovery Kit|read-back/i);
    expect(store.rows.size).toBe(0);
    await expect(coordinator.enrollNew(source, kit, kit.slice())).resolves.toEqual({
      keyId: "2122232425262728292a2b2c2d2e2f30",
      seriesId: seriesHex,
      freshness: "unknown",
    });
    expect(store.rows.size).toBe(1);
    source.backupTrustKey.fill(0xff);
    expect(await coordinator.keyForSeries(seriesHex)).toEqual(
      new Uint8Array(32).map((_, index) => index + 1),
    );
  });

  it("reserves monotonically, retries the same request, and leaves a gap after abandonment", async () => {
    const store = new MemoryTrustStore();
    const coordinator = new BackupTrustCoordinator(store);
    const kit = encodeRecoveryKitV1(material());
    await coordinator.enrollNew(material(), kit, kit.slice());
    store.failCas = 1;

    const first = await coordinator.reserve(seriesHex, id("bkp", "a"));
    expect(first.generation).toBe(1n);
    expect((await coordinator.reserve(seriesHex, id("bkp", "a"))).generation).toBe(1n);
    await expect(coordinator.reserve(seriesHex, id("bkp", "b")))
      .rejects.toThrow(/already reserved/i);
    await coordinator.abandon(seriesHex, id("bkp", "a"), 1n);
    expect((await coordinator.reserve(seriesHex, id("bkp", "b"))).generation).toBe(2n);
  });

  it("never reuses the terminal generation after abandonment", async () => {
    const store = new MemoryTrustStore();
    const coordinator = new BackupTrustCoordinator(store);
    const kit = encodeRecoveryKitV1(material());
    await coordinator.enrollNew(material(), kit, kit.slice());
    const row = store.rows.get(seriesHex) as { nextGeneration: string };
    row.nextGeneration = "18446744073709551615";
    const firstId = id("bkp", "x");
    const reservation = await coordinator.reserve(seriesHex, firstId);
    expect(reservation.generation).toBe(18446744073709551615n);
    await coordinator.abandon(seriesHex, firstId, reservation.generation);
    expect((await coordinator.reserve(seriesHex, firstId)).generation)
      .toBe(18446744073709551615n);
    await expect(coordinator.reserve(seriesHex, id("bkp", "y")))
      .rejects.toThrow(/exhausted|reserved/i);
  });

  it("commits the exact envelope idempotently and rejects replay and fork evidence", async () => {
    const store = new MemoryTrustStore();
    const coordinator = new BackupTrustCoordinator(store);
    const kit = encodeRecoveryKitV1(material());
    await coordinator.enrollNew(material(), kit, kit.slice());
    const backupId = id("bkp", "a");
    const reservation = await coordinator.reserve(seriesHex, backupId);
    const envelope = new TextEncoder().encode("authenticated envelope one");
    await coordinator.commit(seriesHex, backupId, reservation.generation, envelope);
    await expect(coordinator.commit(
      seriesHex, backupId, reservation.generation, envelope.slice(),
    )).resolves.toBe("already_committed");

    const hint = {
      keyId: reservation.keyId,
      seriesId: reservation.seriesId,
      generation: reservation.generation,
    };
    await expect(coordinator.assess(hint, envelope)).resolves.toBe("current");
    await expect(coordinator.assess(hint, new TextEncoder().encode("fork")))
      .resolves.toBe("fork");
    await expect(coordinator.assess({ ...hint, generation: 0n }, envelope))
      .resolves.toBe("replay");
    await expect(coordinator.assess({ ...hint, generation: 2n }, envelope))
      .resolves.toBe("future");
  });

  it("imports an existing Recovery Kit with unknown freshness and returns defensive key copies", async () => {
    const store = new MemoryTrustStore();
    const coordinator = new BackupTrustCoordinator(store);
    const kit = encodeRecoveryKitV1(material());
    await expect(coordinator.importRecoveryKit(kit)).resolves.toMatchObject({
      seriesId: seriesHex,
      freshness: "unknown",
    });
    const first = await coordinator.keyForSeries(seriesHex);
    expect(first).not.toBeNull();
    first!.fill(0xff);
    expect((await coordinator.keyForSeries(seriesHex))?.[0]).toBe(1);
    await expect(coordinator.assess({
      keyId: material().keyId,
      seriesId: material().seriesId,
      generation: 7n,
    }, new Uint8Array([1]))).resolves.toBe("unknown");
  });

  it("reports key-free status for restart reconciliation", async () => {
    const store = new MemoryTrustStore();
    const coordinator = new BackupTrustCoordinator(store);
    expect(await coordinator.status(seriesHex)).toBeNull();
    const kit = encodeRecoveryKitV1(material());
    await coordinator.importRecoveryKit(kit);
    await expect(coordinator.status(seriesHex)).resolves.toEqual({
      keyId: "2122232425262728292a2b2c2d2e2f30",
      seriesId: seriesHex,
      nextGeneration: "1",
      pending: null,
      committed: null,
    });
    const backupId = id("bkp", "r");
    const reserved = await coordinator.reserve(seriesHex, backupId);
    await expect(coordinator.status(seriesHex)).resolves.toMatchObject({
      nextGeneration: "2",
      pending: { backupId, generation: "1" },
      committed: null,
    });
    await coordinator.commit(seriesHex, backupId, reserved.generation, new Uint8Array([7]));
    await expect(coordinator.status(seriesHex)).resolves.toMatchObject({
      pending: null,
      committed: { backupId, generation: "1" },
    });
  });

  it("fails closed on malformed persisted state and repeated CAS contention", async () => {
    const store = new MemoryTrustStore();
    store.rows.set(seriesHex, { schema: 1, revision: "0", backupTrustKey: "plaintext" });
    const coordinator = new BackupTrustCoordinator(store);
    await expect(coordinator.keyForSeries(seriesHex)).rejects.toThrow(/trust state|malformed/i);

    const clean = new MemoryTrustStore();
    const retrying = new BackupTrustCoordinator(clean);
    const kit = encodeRecoveryKitV1(material());
    await retrying.enrollNew(material(), kit, kit.slice());
    clean.failCas = 20;
    await expect(retrying.reserve(seriesHex, id("bkp", "c")))
      .rejects.toThrow(/concurrent|retry/i);
  });
});
