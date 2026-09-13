import { timingSafeEqual } from "node:crypto";
import type { ShareCiphertextEnvelopeV1 } from "@clay/schema/share";

export type ShareRelayRecordV1 = {
  shareId: string;
  expiresAt: string;
  createdAt: string;
  ownerId: string | null;
  revokeTokenHash: string;
  envelope: ShareCiphertextEnvelopeV1;
  ciphertextBytes: number;
  revokedAt?: string;
};

export type ShareRelayLookupV1 =
  | { state: "active"; record: ShareRelayRecordV1 }
  | { state: "expired" }
  | { state: "revoked" }
  | { state: "not_found" };
export type ShareRelayCreateResultV1 = "created" | "replayed" | "conflict" | "capacity" | "expired";
export type ShareRelayTerminalResultV1 = "terminal" | "conflict" | "capacity";
export type ShareRelayRevokeResultV1 = "revoked" | "forbidden" | "not_found" | "expired";

export interface ShareRelayStore {
  create(record: ShareRelayRecordV1, clock: () => number): Promise<ShareRelayCreateResultV1>;
  terminalize(record: ShareRelayRecordV1, clock: () => number): Promise<ShareRelayTerminalResultV1>;
  lookup(shareId: string, now: number): Promise<ShareRelayLookupV1>;
  revoke(
    shareId: string, candidateTokenHash: string, now: number,
  ): Promise<ShareRelayRevokeResultV1>;
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

export function sameShareIdentity(left: ShareRelayRecordV1, right: ShareRelayRecordV1): boolean {
  return left.shareId === right.shareId && left.ownerId === right.ownerId
    && left.expiresAt === right.expiresAt && constantTimeEqual(left.revokeTokenHash, right.revokeTokenHash)
    && left.ciphertextBytes === right.ciphertextBytes && left.envelope.schema === right.envelope.schema
    && left.envelope.algorithm === right.envelope.algorithm && left.envelope.iv === right.envelope.iv
    && left.envelope.ciphertext === right.envelope.ciphertext;
}

export class MemoryShareRelayStore implements ShareRelayStore {
  private readonly records = new Map<string, ShareRelayRecordV1>();
  private readonly maxEntries: number;
  private readonly maxTotalCiphertextBytes: number;

  constructor(options: Readonly<{
    maxEntries?: number;
    maxTotalCiphertextBytes?: number;
  }> = {}) {
    this.maxEntries = options.maxEntries ?? 1_000;
    this.maxTotalCiphertextBytes = options.maxTotalCiphertextBytes ?? 64 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1
        || !Number.isSafeInteger(this.maxTotalCiphertextBytes)
        || this.maxTotalCiphertextBytes < 1)
      throw new Error("invalid in-memory share relay capacity");
  }

  get size(): number { return this.records.size; }

  inspectForTests(shareId: string): ShareRelayRecordV1 | undefined {
    const record = this.records.get(shareId);
    return record ? structuredClone(record) : undefined;
  }

  private reclaimInactive(now: number): void {
    for (const [id, record] of this.records) {
      if (Date.parse(record.expiresAt) <= now) this.records.delete(id);
    }
  }

  async create(record: ShareRelayRecordV1, clock: () => number): Promise<ShareRelayCreateResultV1> {
    return this.allocate(record, clock(), false);
  }

  async terminalize(record: ShareRelayRecordV1, clock: () => number): Promise<ShareRelayTerminalResultV1> {
    const result = this.allocate(record, clock(), true);
    return result === "conflict" || result === "capacity" ? result : "terminal";
  }

  private allocate(record: ShareRelayRecordV1, now: number, terminal: boolean): ShareRelayCreateResultV1 {
    this.reclaimInactive(now);
    const existing = this.records.get(record.shareId);
    if (existing) {
      if (!sameShareIdentity(existing, record) || (!terminal && existing.revokedAt !== undefined)) return "conflict";
      if (terminal) existing.revokedAt ??= new Date(now).toISOString();
      return "replayed";
    }
    if (Date.parse(record.expiresAt) <= now) return "expired";
    const used = [...this.records.values()]
      .reduce((total, entry) => total + entry.ciphertextBytes, 0);
    if (this.size >= this.maxEntries
        || used + record.ciphertextBytes > this.maxTotalCiphertextBytes)
      return "capacity";
    this.records.set(record.shareId, { ...structuredClone(record), ...(terminal ? { revokedAt: new Date(now).toISOString() } : {}) });
    return "created";
  }

  async lookup(shareId: string, now: number): Promise<ShareRelayLookupV1> {
    const record = this.records.get(shareId);
    if (!record) return { state: "not_found" };
    if (Date.parse(record.expiresAt) <= now) {
      this.records.delete(shareId);
      return { state: "expired" };
    }
    if (record.revokedAt !== undefined) return { state: "revoked" };
    return { state: "active", record: structuredClone(record) };
  }

  async revoke(
    shareId: string, candidateTokenHash: string, now: number,
  ): Promise<ShareRelayRevokeResultV1> {
    const record = this.records.get(shareId);
    if (!record) return "not_found";
    if (Date.parse(record.expiresAt) <= now) return "expired";
    if (!constantTimeEqual(record.revokeTokenHash, candidateTokenHash)) return "forbidden";
    record.revokedAt ??= new Date(now).toISOString();
    return "revoked";
  }
}
