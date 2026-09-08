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
export type ShareRelayCreateResultV1 = "created" | "conflict" | "capacity";
export type ShareRelayRevokeResultV1 = "revoked" | "forbidden" | "not_found" | "expired";

export interface ShareRelayStore {
  create(record: ShareRelayRecordV1, now: number): Promise<ShareRelayCreateResultV1>;
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

export class MemoryShareRelayStore implements ShareRelayStore {
  private readonly records = new Map<string, ShareRelayRecordV1>();
  private readonly revoked = new Map<string, string>();
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

  get size(): number { return this.records.size + this.revoked.size; }

  inspectForTests(shareId: string): ShareRelayRecordV1 | undefined {
    const record = this.records.get(shareId);
    return record ? structuredClone(record) : undefined;
  }

  private reclaimInactive(now: number): void {
    for (const [id, record] of this.records) {
      if (Date.parse(record.expiresAt) <= now) this.records.delete(id);
    }
    for (const [id, expiresAt] of this.revoked) {
      if (Date.parse(expiresAt) <= now) this.revoked.delete(id);
    }
  }

  async create(record: ShareRelayRecordV1, now: number): Promise<ShareRelayCreateResultV1> {
    this.reclaimInactive(now);
    if (this.records.has(record.shareId) || this.revoked.has(record.shareId)) return "conflict";
    const used = [...this.records.values()]
      .reduce((total, entry) => total + entry.ciphertextBytes, 0);
    if (this.size >= this.maxEntries
        || used + record.ciphertextBytes > this.maxTotalCiphertextBytes)
      return "capacity";
    this.records.set(record.shareId, structuredClone(record));
    return "created";
  }

  async lookup(shareId: string, now: number): Promise<ShareRelayLookupV1> {
    const revokedExpiry = this.revoked.get(shareId);
    if (revokedExpiry !== undefined) {
      if (Date.parse(revokedExpiry) <= now) {
        this.revoked.delete(shareId);
        return { state: "expired" };
      }
      return { state: "revoked" };
    }
    const record = this.records.get(shareId);
    if (!record) return { state: "not_found" };
    if (Date.parse(record.expiresAt) <= now) {
      this.records.delete(shareId);
      return { state: "expired" };
    }
    return { state: "active", record: structuredClone(record) };
  }

  async revoke(
    shareId: string, candidateTokenHash: string, now: number,
  ): Promise<ShareRelayRevokeResultV1> {
    if (this.revoked.has(shareId)) return "revoked";
    const record = this.records.get(shareId);
    if (!record) return "not_found";
    if (Date.parse(record.expiresAt) <= now) return "expired";
    if (!constantTimeEqual(record.revokeTokenHash, candidateTokenHash)) return "forbidden";
    this.records.delete(shareId);
    this.revoked.set(shareId, record.expiresAt);
    return "revoked";
  }
}
