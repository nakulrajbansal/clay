import { describe, expect, it } from "vitest";
import type { BackupTrustRecordStore } from "@clay/kernel/backup";
import type {
  ProductionAuthenticatedRestoreInspection,
  ProductionBootInfo,
} from "@clay/kernel/worker-authority";
import {
  sealAuthenticatedArchiveV5,
  verifyAuthenticatedArchiveV5,
} from "../../kernel/src/archive-authentication";
import { BackupTrustRuntime } from "../src/worker/backup-trust-runtime";
import { RestoreAsNewWorkerCoordinator } from "../src/worker/restore-as-new";

const id = (prefix: string, character: string): string =>
  `${prefix}_${character.repeat(26)}`;
const target = {
  appInstanceId: id("app", "a"),
  activeGenerationId: id("gen", "b"),
  lineageEpoch: "2",
  protectionRevision: "4",
  digestSchema: 1 as const,
  stateSha256: `sha256:${"a".repeat(64)}`,
};

class MemoryStore implements BackupTrustRecordStore {
  readonly rows = new Map<string, unknown>();
  active: { revision: string; seriesId: string } | null = null;

  async load(seriesId: string): Promise<unknown | null> {
    return this.rows.has(seriesId) ? structuredClone(this.rows.get(seriesId)) : null;
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

async function enrolledTrust(): Promise<{
  trust: BackupTrustRuntime;
  key: Uint8Array;
  keyId: Uint8Array;
  seriesId: Uint8Array;
}> {
  const store = new MemoryStore();
  const trust = new BackupTrustRuntime(store, {
    randomFill: bytes => bytes.forEach((_, index) => { bytes[index] = index + 1; }),
    createEnrollmentId: () => id("enroll", "e"),
  });
  const enrollment = trust.beginEnrollment();
  await trust.confirmEnrollment(enrollment.enrollmentId, enrollment.bytes);
  return {
    trust,
    key: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
    keyId: Uint8Array.from({ length: 16 }, (_, index) => index + 33),
    seriesId: Uint8Array.from({ length: 16 }, (_, index) => index + 49),
  };
}

class FakeRestoreAuthority {
  readonly restored: Array<{ bytes: Uint8Array; sourceProvenanceId: string }> = [];
  readonly boot: ProductionBootInfo = {
    persistent: true,
    seeded: true,
    shellId: "tracker",
    adopted: false,
    selectedAppInstanceId: id("app", "p"),
    catalogGeneration: "10",
    apps: [{ id: id("app", "p"), name: "Preserved", shellId: "tracker" }],
  };

  constructor(private readonly key: Uint8Array) {}

  bootInfo(): ProductionBootInfo {
    return structuredClone(this.boot);
  }

  async inspectAuthenticatedRestoreArchive(
    bytes: Uint8Array,
    key: Uint8Array,
  ): Promise<ProductionAuthenticatedRestoreInspection> {
    expect(key).toEqual(this.key);
    const verified = verifyAuthenticatedArchiveV5(bytes, () => key);
    const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
    return {
      archiveSha256: `sha256:${[...new Uint8Array(digest)]
        .map(value => value.toString(16).padStart(2, "0")).join("")}`,
      target,
      authentication: {
        schema: 1,
        kind: "cose_mac0_hmac_256_256",
        authenticationVersion: 1,
        keyId: [...verified.header.keyId].map(value => value.toString(16).padStart(2, "0")).join(""),
        seriesId: [...verified.header.seriesId].map(value => value.toString(16).padStart(2, "0")).join(""),
        generation: verified.header.generation.toString(),
      },
      displayName: "Restored copy",
      shellId: "tracker",
    };
  }

  async restoreAuthenticatedArchiveAsNew(
    bytes: Uint8Array,
    key: Uint8Array,
    identity: { appInstanceId: string },
    sourceProvenanceId: string,
  ): Promise<{ destinationAppInstanceId: string }> {
    expect(key).toEqual(this.key);
    this.restored.push({ bytes: bytes.slice(), sourceProvenanceId });
    return { destinationAppInstanceId: identity.appInstanceId };
  }
}

describe("trusted worker restore-as-new coordinator", () => {
  it("authenticates before granting, reports unknown freshness, and consumes the exact grant", async () => {
    const { trust, key, keyId, seriesId } = await enrolledTrust();
    const envelope = sealAuthenticatedArchiveV5(
      new Uint8Array([1, 2, 3]),
      key,
      {
        authenticationVersion: 1,
        archiveFormat: 5,
        contentType: "application/vnd.clay.archive+zip",
        keyId,
        seriesId,
        generation: 1n,
      },
    );
    const authority = new FakeRestoreAuthority(key);
    const seriesHex = [...seriesId]
      .map(value => value.toString(16).padStart(2, "0")).join("");
    expect(await trust.keyForSeries(seriesHex)).toEqual(key);
    const prefixes = ["restoreval", "app", "gen", "ns", "op"] as const;
    let next = 0;
    const coordinator = new RestoreAsNewWorkerCoordinator(authority, trust, {
      createId: prefix => {
        expect(prefix).toBe(prefixes[next]);
        next++;
        return id(prefix, String.fromCharCode(102 + next));
      },
      now: () => "2026-09-06T12:00:00.000Z",
    });

    const grant = await coordinator.validate(envelope);
    expect(grant).toMatchObject({
      archiveFormat: 5,
      cryptographicallyAuthenticated: true,
      freshness: "unknown",
      archiveTarget: target,
      preservedAppInstanceId: authority.boot.selectedAppInstanceId,
      installMode: "new_app_only",
    });
    expect(grant.destinationAppInstanceId).not.toBe(grant.preservedAppInstanceId);
    envelope.fill(0);

    const restored = await coordinator.restore(structuredClone(grant));
    expect(restored).toEqual({ destinationAppInstanceId: grant.destinationAppInstanceId });
    expect(authority.restored).toHaveLength(1);
    expect(authority.restored[0]?.sourceProvenanceId).toBe(grant.validationId);
    await expect(coordinator.restore(grant)).rejects.toThrow(/expired|validated/i);
  });
});
