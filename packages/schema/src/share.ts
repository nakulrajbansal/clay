// Closed F1 schemas. Relay wire types intentionally cannot represent plaintext,
// canonical writes, or a recipient decryption capability.
import { z } from "zod";
import { ProjectionPlaintextV1, ProjectionRequestV1 } from "./projection";

export const SHARE_MAX_CIPHERTEXT_BYTES_V1 = 8 * 1024 * 1024 + 16;
export const SHARE_MAX_ATTACHMENTS_V1 = 20;
export const SHARE_MAX_LIFETIME_MS_V1 = 30 * 24 * 60 * 60 * 1000;
export const SHARE_CREATE_BODY_BYTES_V1 = 12 * 1024 * 1024;

export const ShareIdV1 = z.string().regex(/^shr_[a-z2-7]{26}$/);
export const ShareRevokeTokenV1 = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const ShareRevokeTokenHashV1 = ShareRevokeTokenV1;
export const ShareKeyV1 = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const ShareFileIdV1 = z.string().regex(/^file_[0-9a-f]{32}$/);
const ShareTableIdV1 = z.string().regex(/^tbl_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const ShareFieldIdV1 = z.string().regex(/^fld_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const ShareRecordIdV1 = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const DigestBase64UrlV1 = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const Base64UrlV1 = z.string().regex(/^[A-Za-z0-9_-]+$/);
const IsoInstantV1 = z.string().datetime({ offset: true });

export const ShareCiphertextEnvelopeV1 = z.object({
  schema: z.literal(1),
  algorithm: z.literal("A256GCM"),
  iv: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
  ciphertext: Base64UrlV1.min(22).max(11_184_832),
}).strict();
export type ShareCiphertextEnvelopeV1 = z.infer<typeof ShareCiphertextEnvelopeV1>;

export const ShareCreateRequestV1 = z.object({
  schema: z.literal(1),
  shareId: ShareIdV1,
  expiresAt: IsoInstantV1,
  revokeTokenHash: ShareRevokeTokenHashV1,
  envelope: ShareCiphertextEnvelopeV1,
}).strict();
export type ShareCreateRequestV1 = z.infer<typeof ShareCreateRequestV1>;

export const ShareCreateResponseV1 = z.object({
  schema: z.literal(1),
  shareId: ShareIdV1,
  expiresAt: IsoInstantV1,
}).strict();
export type ShareCreateResponseV1 = z.infer<typeof ShareCreateResponseV1>;

export const ShareRelaySnapshotV1 = z.object({
  schema: z.literal(1),
  shareId: ShareIdV1,
  expiresAt: IsoInstantV1,
  envelope: ShareCiphertextEnvelopeV1,
}).strict();
export type ShareRelaySnapshotV1 = z.infer<typeof ShareRelaySnapshotV1>;

export const ShareRevokeRequestV1 = z.object({
  schema: z.literal(1),
  revokeToken: ShareRevokeTokenV1,
}).strict();
export type ShareRevokeRequestV1 = z.infer<typeof ShareRevokeRequestV1>;

export const ShareRevokeResponseV1 = z.object({
  schema: z.literal(1),
  shareId: ShareIdV1,
  revoked: z.literal(true),
}).strict();
export type ShareRevokeResponseV1 = z.infer<typeof ShareRevokeResponseV1>;

export const ShareRelayErrorV1 = z.object({
  schema: z.literal(1),
  error: z.enum([
    "bad_request", "unauthorized", "not_found", "expired", "revoked",
    "conflict", "capacity", "forbidden",
  ]),
}).strict();
export type ShareRelayErrorV1 = z.infer<typeof ShareRelayErrorV1>;

export const ShareFieldBindingV1 = z.object({
  fieldId: ShareFieldIdV1,
  outputName: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/),
}).strict();
export type ShareFieldBindingV1 = z.infer<typeof ShareFieldBindingV1>;

export const ShareAttachmentSourceV1 = z.object({
  tableId: ShareTableIdV1,
  fieldId: ShareFieldIdV1,
  recordId: ShareRecordIdV1,
}).strict();
export type ShareAttachmentSourceV1 = z.infer<typeof ShareAttachmentSourceV1>;

export const ShareAttachmentBindingV1 = z.object({
  id: ShareFileIdV1,
  size: z.number().int().positive().max(10 * 1024 * 1024),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  source: ShareAttachmentSourceV1,
}).strict();
export type ShareAttachmentBindingV1 = z.infer<typeof ShareAttachmentBindingV1>;

export const ShareApprovedScopeV1 = z.object({
  schema: z.literal("ShareApprovedScopeV1"),
  projectionRequest: ProjectionRequestV1,
  fieldBindings: z.array(ShareFieldBindingV1).min(1).max(30),
  attachmentIds: z.array(ShareFileIdV1).max(SHARE_MAX_ATTACHMENTS_V1),
  attachmentBindings: z.array(ShareAttachmentBindingV1).max(SHARE_MAX_ATTACHMENTS_V1),
  approvedAt: IsoInstantV1,
  projectionDigest: DigestBase64UrlV1,
  fingerprint: DigestBase64UrlV1,
}).strict().superRefine((scope, ctx) => {
  if (scope.fieldBindings.length !== scope.projectionRequest.fieldIds.length
      || scope.fieldBindings.some((binding, index) =>
        binding.fieldId !== scope.projectionRequest.fieldIds[index]))
    ctx.addIssue({ code: "custom", path: ["fieldBindings"],
      message: "field bindings must match the ordered stable field allowlist" });
  if (new Set(scope.attachmentIds).size !== scope.attachmentIds.length)
    ctx.addIssue({ code: "custom", path: ["attachmentIds"], message: "attachment ids must be unique" });
  if (scope.attachmentBindings.length !== scope.attachmentIds.length
      || scope.attachmentBindings.some((binding, index) =>
        binding.id !== scope.attachmentIds[index]))
    ctx.addIssue({ code: "custom", path: ["attachmentBindings"],
      message: "attachment bindings must match the ordered attachment allowlist" });
  if (scope.attachmentIds.some((id, index) => index > 0 && id < scope.attachmentIds[index - 1]!))
    ctx.addIssue({ code: "custom", path: ["attachmentIds"], message: "attachment ids must be sorted" });
  const approvedRecordId = scope.projectionRequest.kind === "record"
    ? scope.projectionRequest.recordId : null;
  if (approvedRecordId === null && scope.attachmentBindings.length > 0)
    ctx.addIssue({ code: "custom", path: ["attachmentBindings"],
      message: "attachments require an exact single-record projection" });
  if (scope.attachmentBindings.some(binding =>
    binding.source.tableId !== scope.projectionRequest.tableId
      || (approvedRecordId !== null && binding.source.recordId !== approvedRecordId)))
    ctx.addIssue({ code: "custom", path: ["attachmentBindings"],
      message: "attachment sources must match the approved projection authority" });
});
export type ShareApprovedScopeV1 = z.infer<typeof ShareApprovedScopeV1>;

const ShareSafeMimeV1 = z.enum([
  "image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf",
  "text/plain", "text/csv", "application/json",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

export const ShareAttachmentV1 = z.object({
  id: ShareFileIdV1,
  name: z.string().min(1).max(255).refine(name => !/[\\/\u0000-\u001f]/.test(name),
    "safe file name required"),
  mime: ShareSafeMimeV1,
  size: z.number().int().positive().max(10 * 1024 * 1024),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  source: ShareAttachmentSourceV1,
  bytes: Base64UrlV1.max(13_981_016),
}).strict();
export type ShareAttachmentV1 = z.infer<typeof ShareAttachmentV1>;

export const SharePayloadV1 = z.object({
  schema: z.literal("SharePayloadV1"),
  scope: ShareApprovedScopeV1,
  projection: ProjectionPlaintextV1,
  attachments: z.array(ShareAttachmentV1).max(SHARE_MAX_ATTACHMENTS_V1),
}).strict().superRefine((payload, ctx) => {
  const request = payload.scope.projectionRequest;
  const manifest = payload.projection.manifest;
  if (request.kind !== manifest.kind)
    ctx.addIssue({ code: "custom", path: ["projection"], message: "projection kind is outside approved scope" });
  if (request.expectedSchemaVersion !== manifest.schemaVersion)
    ctx.addIssue({ code: "custom", path: ["projection"], message: "projection schema version is outside approved scope" });
  const projectedFields = manifest.fields.filter(field => field.source === "field");
  if (projectedFields.length !== request.fieldIds.length)
    ctx.addIssue({ code: "custom", path: ["projection", "manifest", "fields"],
      message: "projection fields do not match stable-id allowlist" });
  if (projectedFields.length !== payload.scope.fieldBindings.length
      || projectedFields.some((field, index) =>
        field.name !== payload.scope.fieldBindings[index]?.outputName))
    ctx.addIssue({ code: "custom", path: ["projection", "manifest", "fields"],
      message: "projection output identities do not match approved stable field bindings" });
  const actualIds = payload.attachments.map(file => file.id);
  if (actualIds.length !== payload.scope.attachmentIds.length
      || actualIds.some((id, index) => id !== payload.scope.attachmentIds[index]))
    ctx.addIssue({ code: "custom", path: ["attachments"],
      message: "attachments do not match approved stable-id allowlist" });
  if (payload.attachments.length !== payload.scope.attachmentBindings.length
      || payload.attachments.some((file, index) => {
        const binding = payload.scope.attachmentBindings[index];
        return !binding || file.id !== binding.id || file.size !== binding.size
          || file.sha256 !== binding.sha256
          || file.source.tableId !== binding.source.tableId
          || file.source.fieldId !== binding.source.fieldId
          || file.source.recordId !== binding.source.recordId;
      }))
    ctx.addIssue({ code: "custom", path: ["attachments"],
      message: "attachments do not match approved digest and source bindings" });
});
export type SharePayloadV1 = z.infer<typeof SharePayloadV1>;
