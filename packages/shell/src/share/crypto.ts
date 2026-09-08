import {
  SHARE_MAX_CIPHERTEXT_BYTES_V1,
  ShareApprovedScopeV1 as ShareApprovedScopeSchema,
  ShareCreateRequestV1 as ShareCreateRequestSchema,
  ShareKeyV1,
  SharePayloadV1 as SharePayloadSchema,
  ShareRelaySnapshotV1 as ShareRelaySnapshotSchema,
  ShareRevokeTokenV1,
  type ShareApprovedScopeV1,
  type ShareAttachmentBindingV1,
  type ShareAttachmentSourceV1 as ShareAttachmentSourceContextV1,
  type ShareAttachmentV1,
  type ShareCreateRequestV1,
  type ShareFieldBindingV1,
  type SharePayloadV1,
  type ShareRelaySnapshotV1,
} from "@clay/schema/share";
import {
  canonicalProjectionJsonV1, decodeProjectionArtifactV1,
  type ProjectionArtifactV1, type ProjectionPlaintextV1, type ProjectionRequestV1,
} from "@clay/kernel/projection";
import type { AttachmentFile } from "@clay/kernel";

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function ownArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const result = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(result).set(bytes);
  return result;
}

function uint8View(value: unknown): Uint8Array | null {
  if (Object.prototype.toString.call(value) !== "[object Uint8Array]") return null;
  const view = value as { buffer?: unknown; byteOffset?: unknown; byteLength?: unknown };
  if (Object.prototype.toString.call(view.buffer) !== "[object ArrayBuffer]"
      || typeof view.byteOffset !== "number" || typeof view.byteLength !== "number") return null;
  return new Uint8Array(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength);
}

export function base64UrlEncodeV1(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index]!;
    const hasB = index + 1 < bytes.length;
    const hasC = index + 2 < bytes.length;
    const b = hasB ? bytes[index + 1]! : 0;
    const c = hasC ? bytes[index + 2]! : 0;
    output += BASE64URL[a >>> 2];
    output += BASE64URL[((a & 3) << 4) | (b >>> 4)];
    if (hasB) output += BASE64URL[((b & 15) << 2) | (c >>> 6)];
    if (hasC) output += BASE64URL[c & 63];
  }
  return output;
}

export function base64UrlDecodeV1(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1)
    throw new Error("invalid base64url value");
  const output = new Uint8Array(Math.floor(value.length * 6 / 8));
  let accumulator = 0;
  let bits = 0;
  let offset = 0;
  for (const character of value) {
    const digit = BASE64URL.indexOf(character);
    if (digit < 0) throw new Error("invalid base64url value");
    accumulator = (accumulator << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output[offset++] = (accumulator >>> bits) & 0xff;
      accumulator &= (1 << bits) - 1;
    }
  }
  if (bits > 0 && accumulator !== 0) throw new Error("non-canonical base64url value");
  if (base64UrlEncodeV1(output) !== value) throw new Error("non-canonical base64url value");
  return output;
}

function randomBase32Id(bytes: Uint8Array): string {
  let output = "";
  let accumulator = 0;
  let bits = 0;
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5 && output.length < 26) {
      bits -= 5;
      output += BASE32[(accumulator >>> bits) & 31];
      accumulator &= (1 << bits) - 1;
    }
  }
  if (output.length !== 26) throw new Error("not enough entropy for share id");
  return `shr_${output}`;
}

async function sha256Bytes(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", ownArrayBuffer(bytes)));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return [...await sha256Bytes(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalScopeMaterial(
  request: ProjectionRequestV1,
  attachmentBindings: readonly ShareAttachmentBindingV1[],
  projectionDigest: string,
  fieldBindings: readonly ShareFieldBindingV1[],
): Uint8Array {
  return textEncoder.encode(canonicalProjectionJsonV1({
    schema: 1,
    projectionRequest: request,
    fieldBindings,
    attachmentIds: attachmentBindings.map(binding => binding.id),
    attachmentBindings,
    projectionDigest,
  }));
}

async function scopeFingerprintV1(
  request: ProjectionRequestV1,
  attachmentBindings: readonly ShareAttachmentBindingV1[],
  projectionDigest: string,
  fieldBindings: readonly ShareFieldBindingV1[],
): Promise<string> {
  return base64UrlEncodeV1(await sha256Bytes(canonicalScopeMaterial(
    request, attachmentBindings, projectionDigest, fieldBindings,
  )));
}

async function projectionApprovalMaterialV1(
  request: ProjectionRequestV1,
  artifact: ProjectionArtifactV1,
): Promise<Readonly<{
  projection: ProjectionPlaintextV1;
  projectionDigest: string;
  fieldBindings: readonly ShareFieldBindingV1[];
}>> {
  const projection = decodeProjectionArtifactV1(artifact);
  const fields = projection.manifest.fields.filter(field => field.source === "field");
  if (projection.manifest.kind !== request.kind
      || projection.manifest.schemaVersion !== request.expectedSchemaVersion
      || fields.length !== request.fieldIds.length)
    throw new Error("The projection does not match the stable field allowlist.");
  const fieldBindings = request.fieldIds.map((fieldId, index) => ({
    fieldId,
    outputName: fields[index]!.name,
  }));
  const canonical = textEncoder.encode(canonicalProjectionJsonV1(projection));
  return {
    projection,
    projectionDigest: base64UrlEncodeV1(await sha256Bytes(canonical)),
    fieldBindings,
  };
}

export type ShareAttachmentApprovalV1 = Readonly<Pick<AttachmentFile,
  "id" | "name" | "mime" | "size" | "sha256"> & {
    source: ShareAttachmentSourceContextV1;
  }>;

function attachmentBindingsV1(
  attachments: readonly ShareAttachmentApprovalV1[],
): ShareAttachmentBindingV1[] {
  return [...attachments].sort((left, right) => left.id.localeCompare(right.id)).map(file => ({
    id: file.id,
    size: file.size,
    sha256: file.sha256,
    source: { ...file.source },
  }));
}

export async function approveShareScopeV1(
  request: ProjectionRequestV1,
  attachmentApprovals: readonly ShareAttachmentApprovalV1[],
  artifact: ProjectionArtifactV1,
  approvedAt = new Date(),
): Promise<ShareApprovedScopeV1> {
  const attachmentBindings = attachmentBindingsV1(attachmentApprovals);
  const binding = await projectionApprovalMaterialV1(request, artifact);
  return ShareApprovedScopeSchema.parse({
    schema: "ShareApprovedScopeV1",
    projectionRequest: request,
    fieldBindings: binding.fieldBindings,
    attachmentIds: attachmentBindings.map(attachment => attachment.id),
    attachmentBindings,
    approvedAt: approvedAt.toISOString(),
    projectionDigest: binding.projectionDigest,
    fingerprint: await scopeFingerprintV1(
      request, attachmentBindings, binding.projectionDigest, binding.fieldBindings,
    ),
  });
}

export async function shareScopeRequiresReapprovalV1(
  approval: ShareApprovedScopeV1,
  request: ProjectionRequestV1,
  attachmentApprovals: readonly ShareAttachmentApprovalV1[],
  artifact: ProjectionArtifactV1,
): Promise<boolean> {
  const parsed = ShareApprovedScopeSchema.safeParse(approval);
  if (!parsed.success) return true;
  try {
    const binding = await projectionApprovalMaterialV1(request, artifact);
    const attachmentBindings = attachmentBindingsV1(attachmentApprovals);
    return parsed.data.projectionDigest !== binding.projectionDigest
      || parsed.data.fingerprint !== await scopeFingerprintV1(
        request, attachmentBindings, binding.projectionDigest, binding.fieldBindings,
      );
  } catch { return true; }
}

export type ShareAttachmentSourceV1 = ShareAttachmentApprovalV1
  & Readonly<Pick<AttachmentFile, "bytes">>;

export type ShareEncryptionEntropyV1 = Readonly<{
  shareId: string;
  key: string;
  revokeToken: string;
  iv: Uint8Array;
}>;

export type EncryptedShareCreationV1 = Readonly<{
  request: ShareCreateRequestV1;
  key: string;
  revokeToken: string;
}>;

async function verifiedAttachment(
  attachment: ShareAttachmentSourceV1,
): Promise<ShareAttachmentV1> {
  const bytes = uint8View(attachment.bytes);
  if (!bytes || bytes.byteLength !== attachment.size
      || await sha256Hex(bytes) !== attachment.sha256)
    throw new Error(`Approved attachment ${attachment.id} failed its integrity check.`);
  return {
    id: attachment.id,
    name: attachment.name,
    mime: attachment.mime as ShareAttachmentV1["mime"],
    size: attachment.size,
    sha256: attachment.sha256,
    source: { ...attachment.source },
    bytes: base64UrlEncodeV1(bytes),
  };
}

function aadV1(shareId: string, expiresAt: string): Uint8Array {
  return textEncoder.encode(canonicalProjectionJsonV1({ schema: 1, shareId, expiresAt }));
}

function generatedEntropy(): ShareEncryptionEntropyV1 {
  const idBytes = crypto.getRandomValues(new Uint8Array(17));
  return {
    shareId: randomBase32Id(idBytes),
    key: base64UrlEncodeV1(crypto.getRandomValues(new Uint8Array(32))),
    revokeToken: base64UrlEncodeV1(crypto.getRandomValues(new Uint8Array(32))),
    iv: crypto.getRandomValues(new Uint8Array(12)),
  };
}

export async function hashShareRevokeTokenV1(token: string): Promise<string> {
  const parsed = ShareRevokeTokenV1.parse(token);
  return base64UrlEncodeV1(await sha256Bytes(base64UrlDecodeV1(parsed)));
}

export async function encryptApprovedShareV1(input: Readonly<{
  approval: ShareApprovedScopeV1;
  request: ProjectionRequestV1;
  artifact: ProjectionArtifactV1;
  attachments: readonly ShareAttachmentSourceV1[];
  expiresAt: string;
  entropy?: ShareEncryptionEntropyV1;
}>): Promise<EncryptedShareCreationV1> {
  const approval = ShareApprovedScopeSchema.parse(input.approval);
  const suppliedAttachmentIds = input.attachments.map(file => file.id).sort();
  if (suppliedAttachmentIds.length !== approval.attachmentIds.length
      || suppliedAttachmentIds.some((id, index) => id !== approval.attachmentIds[index]))
    throw new Error("Attachments do not match the separately approved stable-ID allowlist.");
  if (await shareScopeRequiresReapprovalV1(
    approval, input.request, input.attachments, input.artifact,
  ))
    throw new Error("The share scope or exact preview changed. Preview and approve again.");

  const projection = decodeProjectionArtifactV1(input.artifact);
  const attachments = await Promise.all([...input.attachments]
    .sort((left, right) => left.id.localeCompare(right.id)).map(verifiedAttachment));
  const payload = SharePayloadSchema.parse({
    schema: "SharePayloadV1",
    scope: approval,
    projection,
    attachments,
  });
  const plaintext = textEncoder.encode(canonicalProjectionJsonV1(payload));
  if (plaintext.byteLength + 16 > SHARE_MAX_CIPHERTEXT_BYTES_V1)
    throw new Error("The encrypted share exceeds the 8 MiB relay limit. Remove rows or files.");

  const entropy = input.entropy ?? generatedEntropy();
  const keyBytes = base64UrlDecodeV1(ShareKeyV1.parse(entropy.key));
  ShareRevokeTokenV1.parse(entropy.revokeToken);
  const iv = uint8View(entropy.iv);
  if (keyBytes.byteLength !== 32 || !iv || iv.byteLength !== 12)
    throw new Error("invalid share encryption entropy");
  const cryptoKey = await crypto.subtle.importKey(
    "raw", ownArrayBuffer(keyBytes), { name: "AES-GCM" }, false, ["encrypt"],
  );
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({
    name: "AES-GCM",
    iv: ownArrayBuffer(iv),
    additionalData: ownArrayBuffer(aadV1(entropy.shareId, input.expiresAt)),
    tagLength: 128,
  }, cryptoKey, ownArrayBuffer(plaintext)));
  const request = ShareCreateRequestSchema.parse({
    schema: 1,
    shareId: entropy.shareId,
    expiresAt: input.expiresAt,
    revokeTokenHash: await hashShareRevokeTokenV1(entropy.revokeToken),
    envelope: {
      schema: 1,
      algorithm: "A256GCM",
      iv: base64UrlEncodeV1(iv),
      ciphertext: base64UrlEncodeV1(ciphertext),
    },
  });
  return Object.freeze({ request, key: entropy.key, revokeToken: entropy.revokeToken });
}

export type DecryptedShareAttachmentV1 = Omit<ShareAttachmentV1, "bytes"> & {
  bytes: Uint8Array;
};
export type DecryptedShareSnapshotV1 = Readonly<{
  scope: ShareApprovedScopeV1;
  projection: ProjectionPlaintextV1;
  attachments: readonly DecryptedShareAttachmentV1[];
}>;

export async function decryptShareSnapshotV1(
  snapshotInput: ShareRelaySnapshotV1,
  keyInput: string,
): Promise<DecryptedShareSnapshotV1> {
  const snapshot = ShareRelaySnapshotSchema.parse(snapshotInput);
  const keyBytes = base64UrlDecodeV1(ShareKeyV1.parse(keyInput));
  const iv = base64UrlDecodeV1(snapshot.envelope.iv);
  const ciphertext = base64UrlDecodeV1(snapshot.envelope.ciphertext);
  if (keyBytes.byteLength !== 32 || iv.byteLength !== 12
      || ciphertext.byteLength > SHARE_MAX_CIPHERTEXT_BYTES_V1)
    throw new Error("Share encryption material is invalid.");
  let plaintext: Uint8Array;
  try {
    const key = await crypto.subtle.importKey(
      "raw", ownArrayBuffer(keyBytes), { name: "AES-GCM" }, false, ["decrypt"],
    );
    plaintext = new Uint8Array(await crypto.subtle.decrypt({
      name: "AES-GCM",
      iv: ownArrayBuffer(iv),
      additionalData: ownArrayBuffer(aadV1(snapshot.shareId, snapshot.expiresAt)),
      tagLength: 128,
    }, key, ownArrayBuffer(ciphertext)));
  } catch {
    throw new Error("This share could not be decrypted or authenticated.");
  }
  let unknown: unknown;
  try { unknown = JSON.parse(textDecoder.decode(plaintext)); }
  catch { throw new Error("This share's decrypted snapshot is invalid."); }
  const payload: SharePayloadV1 = SharePayloadSchema.parse(unknown);
  const projectionDigest = base64UrlEncodeV1(await sha256Bytes(
    textEncoder.encode(canonicalProjectionJsonV1(payload.projection)),
  ));
  if (projectionDigest !== payload.scope.projectionDigest
      || payload.scope.fingerprint !== await scopeFingerprintV1(
        payload.scope.projectionRequest,
        payload.scope.attachmentBindings,
        projectionDigest,
        payload.scope.fieldBindings,
      )) throw new Error("This share's exact-preview approval fingerprint is invalid.");

  const decoded: DecryptedShareAttachmentV1[] = [];
  for (const encoded of payload.attachments) {
    const bytes = base64UrlDecodeV1(encoded.bytes);
    if (bytes.byteLength !== encoded.size || await sha256Hex(bytes) !== encoded.sha256)
      throw new Error(`Shared attachment ${encoded.id} failed its integrity check.`);
    const { bytes: _encodedBytes, ...metadata } = encoded;
    void _encodedBytes;
    decoded.push({ ...metadata, bytes });
  }
  return Object.freeze({
    scope: payload.scope,
    projection: payload.projection,
    attachments: Object.freeze(decoded),
  });
}

function normalizeRelayBaseUrlV1(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("The share relay URL is invalid."); }
  if ((url.protocol !== "https:" && url.protocol !== "http:")
      || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "")
    throw new Error("The share relay URL must be an HTTP(S) origin or path without credentials.");
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path}`;
}

export function buildRecipientShareUrlV1(input: Readonly<{
  viewerOrigin: string;
  relayBaseUrl: string;
  shareId: string;
  key: string;
}>): string {
  const viewer = new URL(input.viewerOrigin);
  const relay = normalizeRelayBaseUrlV1(input.relayBaseUrl);
  ShareKeyV1.parse(input.key);
  const shareId = ShareCreateRequestSchema.shape.shareId.parse(input.shareId);
  const result = new URL(`/share/${shareId}`, viewer.origin);
  if (relay !== viewer.origin) result.searchParams.set("relay", relay);
  result.hash = `k=${input.key}`;
  return result.toString();
}

export function parseRecipientShareLocationV1(href: string): {
  shareId: string; key: string; relayBaseUrl: string;
} {
  const url = new URL(href);
  const match = url.pathname.match(/^\/share\/(shr_[a-z2-7]{26})$/);
  if (!match) throw new Error("This is not a valid Clay share URL.");
  const shareId = ShareCreateRequestSchema.shape.shareId.parse(match[1]);
  const params = new URLSearchParams(url.hash.slice(1));
  if ([...params.keys()].some(name => name !== "k") || !params.get("k"))
    throw new Error("The share URL is missing its decryption key fragment.");
  const key = ShareKeyV1.parse(params.get("k"));
  const relayBaseUrl = normalizeRelayBaseUrlV1(url.searchParams.get("relay") ?? url.origin);
  return { shareId, key, relayBaseUrl };
}
