import { TargetEvidenceV1 } from "@clay/schema/catalog";
import { ShareApprovedScopeV1, ShareCreateRequestV1, ShareCreateResponseV1, ShareTerminalResponseV1 } from "@clay/schema/share";
import { relayRequestSha256 } from "../app/relay-request-identity";
import { buildRecipientShareUrlV1, decryptShareSnapshotV1, hashShareRevokeTokenV1, parseRecipientShareLocationV1, type encryptApprovedShareV1 } from "./crypto";
import { parseOwnerShareReceiptV1, type OwnerShareReceiptV1 } from "./owner-receipts";
import type { ShareRelayClient } from "./relay-client";

/** Shell-only custody. Never send this record or its capabilities to the worker,
 * panels, app settings, archives, telemetry, or diagnostic error messages. */
export type ShareOwnerRecord = Readonly<{ schema: 2; shellOrigin: string; source: TargetEvidenceV1; approval: ShareApprovedScopeV1;
  request: ShareCreateRequestV1; receipt: OwnerShareReceiptV1; state: "prepared" | "invoked" | "published" | "revoke_pending" | "revoked"; revocationAt: string | null }>;
export interface ShareOwnerVault {
  list(): Promise<ShareOwnerRecord[]>;
  compareAndSet(before: ShareOwnerRecord | null, after: ShareOwnerRecord): Promise<void>;
}
const custodyError = () => new Error("Share owner custody is unavailable or conflicted; original records were kept");
export function shareConfiguration(shellOrigin: string, relayBaseUrl: string, viewerOrigin: string): void {
  try {
    for (const value of [shellOrigin, relayBaseUrl, viewerOrigin]) {
      const url = new URL(value);
      if (url.username || url.password || url.hash || url.search || (url.protocol !== "https:" && !(url.protocol === "http:"
          && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error();
    }
    if (new URL(shellOrigin).origin !== shellOrigin || new URL(viewerOrigin).origin !== shellOrigin) throw new Error();
  } catch { throw new Error("Sharing configuration is unavailable or not bound to this shell origin"); }
}
export function validateShareOwnerRecord(input: unknown): ShareOwnerRecord {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error();
    const value = input as Record<string, unknown>;
    const fields = ["schema", "shellOrigin", "source", "approval", "request", "receipt", "state", "revocationAt"];
    if (value.schema !== 2 || Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key)) || typeof value.shellOrigin !== "string"
        || !["prepared", "invoked", "published", "revoke_pending", "revoked"].includes(String(value.state))) throw new Error();
    const receipt = parseOwnerShareReceiptV1(value.receipt); if (!receipt) throw new Error();
    shareConfiguration(value.shellOrigin, receipt.relayBaseUrl, new URL(receipt.url).origin);
    const request = ShareCreateRequestV1.parse(value.request);
    const source = TargetEvidenceV1.parse(value.source); const approval = ShareApprovedScopeV1.parse(value.approval);
    if (request.shareId !== receipt.shareId || request.expiresAt !== receipt.expiresAt) throw new Error();
    if (value.revocationAt !== null && (typeof value.revocationAt !== "string" || new Date(value.revocationAt).toISOString() !== value.revocationAt)) throw new Error();
    if ((value.state === "revoked" || value.state === "revoke_pending") !== (value.revocationAt !== null)
        || (value.state === "revoked" ? receipt.revokedAt !== value.revocationAt : receipt.revokedAt !== null)) throw new Error();
    return { schema: 2, shellOrigin: value.shellOrigin, source, approval, request, receipt: structuredClone(receipt), state: value.state as ShareOwnerRecord["state"], revocationAt: value.revocationAt as string | null };
  } catch { throw custodyError(); }
}
export function assertShareOwnerTransition(before: ShareOwnerRecord | null, after: ShareOwnerRecord): void {
  if (!before) { if (after.state !== "prepared") throw custodyError(); return; }
  const identity = (row: ShareOwnerRecord) => JSON.stringify({ ...row, state: null, revocationAt: null, receipt: { ...row.receipt, revokedAt: null } });
  const next: Record<ShareOwnerRecord["state"], readonly ShareOwnerRecord["state"][]> = { prepared: ["invoked", "revoke_pending"], invoked: ["published", "revoke_pending"], published: ["revoke_pending"], revoke_pending: ["revoked"], revoked: [] };
  if (identity(before) !== identity(after) || !next[before.state].includes(after.state)
      || (before.revocationAt !== null && before.revocationAt !== after.revocationAt)) throw custodyError();
}
export class ShareOwnerSession {
  constructor(readonly vault: ShareOwnerVault, readonly relay: ShareRelayClient, readonly shellOrigin: string, readonly viewerOrigin: string,
    readonly readSource: () => Promise<TargetEvidenceV1>, readonly now: () => Date = () => new Date()) { shareConfiguration(shellOrigin, relay.baseUrl, viewerOrigin); }
  private async all(): Promise<ShareOwnerRecord[]> {
    try {
      const rows = (await this.vault.list()).map(validateShareOwnerRecord);
      if (rows.length > 100 || new Set(rows.map(row => row.request.shareId)).size !== rows.length) throw custodyError();
      return rows;
    } catch { throw custodyError(); }
  }
  async list(): Promise<ShareOwnerRecord[]> {
    const source = TargetEvidenceV1.parse(await this.readSource());
    return (await this.all()).filter(row => row.shellOrigin === this.shellOrigin && row.source.appInstanceId === source.appInstanceId
      && row.source.activeGenerationId === source.activeGenerationId && row.source.lineageEpoch === source.lineageEpoch);
  }
  private async read(id: string): Promise<ShareOwnerRecord> {
    const record = (await this.list()).find(row => row.request.shareId === id);
    if (!record || record.receipt.relayBaseUrl !== this.relay.baseUrl) throw new Error("Original sharing source or relay changed; owner records were kept");
    return record;
  }
  private async write(before: ShareOwnerRecord | null, after: ShareOwnerRecord): Promise<ShareOwnerRecord> {
    const fixed = validateShareOwnerRecord(after); assertShareOwnerTransition(before, fixed);
    try {
      await this.vault.compareAndSet(before, fixed);
      const current = (await this.all()).find(row => row.request.shareId === fixed.request.shareId);
      if (JSON.stringify(current) !== JSON.stringify(fixed)) throw custodyError(); return current!;
    } catch { throw custodyError(); }
  }
  async prepare(input: { encrypted: Awaited<ReturnType<typeof encryptApprovedShareV1>>; source: TargetEvidenceV1; title: string; approval: ShareApprovedScopeV1 }): Promise<ShareOwnerRecord> {
    const fixed = structuredClone(input); const source = TargetEvidenceV1.parse(fixed.source);
    if (JSON.stringify(TargetEvidenceV1.parse(await this.readSource())) !== JSON.stringify(source)) throw new Error("Reviewed sharing source changed before custody; reapprove the snapshot");
    const request = ShareCreateRequestV1.parse(fixed.encrypted.request);
    const decoded = await decryptShareSnapshotV1({ schema: 1, shareId: request.shareId, expiresAt: request.expiresAt, envelope: request.envelope }, fixed.encrypted.key);
    if (JSON.stringify(decoded.scope) !== JSON.stringify(ShareApprovedScopeV1.parse(fixed.approval)) || request.revokeTokenHash !== await hashShareRevokeTokenV1(fixed.encrypted.revokeToken)) throw custodyError();
    if (JSON.stringify(TargetEvidenceV1.parse(await this.readSource())) !== JSON.stringify(source)) throw new Error("Reviewed sharing source changed while validating custody");
    const receipt: OwnerShareReceiptV1 = { schema: 1, shareId: request.shareId, title: fixed.title,
      url: buildRecipientShareUrlV1({ viewerOrigin: this.viewerOrigin, relayBaseUrl: this.relay.baseUrl, shareId: request.shareId, key: fixed.encrypted.key }),
      relayBaseUrl: this.relay.baseUrl, expiresAt: request.expiresAt, createdAt: this.now().toISOString(), revokeToken: fixed.encrypted.revokeToken, revokedAt: null };
    return this.write(null, { schema: 2, shellOrigin: this.shellOrigin, source, approval: fixed.approval, request, receipt, state: "prepared", revocationAt: null });
  }
  async publish(id: string): Promise<ShareOwnerRecord> {
    let row = await this.read(id);
    if (row.state === "published") return row;
    if (row.state !== "prepared" && row.state !== "invoked") throw new Error("This snapshot is being revoked; publication cannot resume");
    if (Date.parse(row.request.expiresAt) <= this.now().getTime()) throw new Error("Retained snapshot expired; revoke or keep its owner receipt before a new share");
    if (row.state === "prepared") {
      if (JSON.stringify(TargetEvidenceV1.parse(await this.readSource())) !== JSON.stringify(row.source)) throw new Error("Reviewed snapshot source changed before delivery; original custody was kept");
      row = await this.write(row, { ...row, state: "invoked" });
    }
    // Once invoked, retries are exactly the same ciphertext and capability hash.
    // Do not reproject newer source data or regenerate encryption material.
    let response: unknown;
    try { response = await this.relay.create(structuredClone(row.request)); }
    catch { throw new Error("Share delivery is uncertain; retry the original encrypted snapshot"); }
    const accepted = ShareCreateResponseV1.safeParse(response);
    if (!accepted.success || accepted.data.shareId !== row.request.shareId || accepted.data.expiresAt !== row.request.expiresAt) throw new Error("Share relay acknowledgement differs; original owner custody was kept");
    return this.write(row, { ...row, state: "published" });
  }
  async revoke(id: string): Promise<ShareOwnerRecord> {
    let row = await this.read(id); if (row.state === "revoked") return row;
    if (row.state !== "revoke_pending") row = await this.write(row, { ...row, state: "revoke_pending", revocationAt: this.now().toISOString() });
    const capability = parseRecipientShareLocationV1(row.receipt.url);
    if (capability.shareId !== id) throw custodyError();
    try {
      const response = ShareTerminalResponseV1.parse(await this.relay.terminalize(structuredClone(row.request), row.receipt.revokeToken));
      if (response.shareId !== id || response.expiresAt !== row.request.expiresAt || response.requestSha256 !== await relayRequestSha256(row.request)) throw new Error();
    }
    catch { throw new Error("Share revocation is uncertain; retry the retained revocation"); }
    return this.write(row, { ...row, state: "revoked", receipt: { ...row.receipt, revokedAt: row.revocationAt } });
  }
}
