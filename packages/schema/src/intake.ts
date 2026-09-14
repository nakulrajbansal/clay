import { z } from "./validation-runtime";

const UUID_V7 = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
export const IntakeFormId = /*#__PURE__*/ (() => (z.string().regex(/^form_[a-z2-7]{26}$/)))();
export const IntakeSubmissionId = /*#__PURE__*/ (() => (z.string().regex(/^sub_[a-z2-7]{26}$/)))();
export const IntakeReceiptId = /*#__PURE__*/ (() => (z.string().regex(/^irc_[a-z2-7]{26}$/)))();
export const IntakeTableId = /*#__PURE__*/ (() => (z.string().regex(new RegExp(`^tbl_${UUID_V7}$`))))();
export const IntakeFieldId = /*#__PURE__*/ (() => (z.string().regex(new RegExp(`^fld_${UUID_V7}$`))))();
export const IntakeToken = /*#__PURE__*/ (() => (z.string().regex(/^[A-Za-z0-9_-]{43}$/)))();
export const IntakeSha256 = /*#__PURE__*/ (() => (z.string().regex(/^[0-9a-f]{64}$/)))();
export const IntakeCanonicalInstant = /*#__PURE__*/ (() => (z.string().datetime({ offset: true }).refine(value => {
  try { return new Date(value).toISOString() === value; } catch { return false; }
}, "exact UTC millisecond instant required")))();
export const IntakeRelayFormRegistrationResultV1 = /*#__PURE__*/ (() => (z.object({ formId: IntakeFormId, expiresAt: IntakeCanonicalInstant }).strict()))();
export const IntakeRelayTerminalResultV1 = /*#__PURE__*/ (() => (z.object({ schema: z.literal(1), formId: IntakeFormId,
  expiresAt: IntakeCanonicalInstant, requestSha256: IntakeSha256, terminal: z.literal(true) }).strict()))();

export const IntakeMimeType = /*#__PURE__*/ (() => (z.enum([
  "application/pdf", "image/png", "image/jpeg", "text/plain",
])))();
export type IntakeMimeType = z.infer<typeof IntakeMimeType>;

export const IntakeScalarType = /*#__PURE__*/ (() => (z.enum([
  "text", "rich_text", "number", "integer", "boolean", "date", "enum",
])))();
export type IntakeScalarType = z.infer<typeof IntakeScalarType>;

export const PublicIntakeFieldV1 = /*#__PURE__*/ (() => (z.object({
  fieldId: IntakeFieldId,
  label: z.string().trim().min(1).max(80),
  type: IntakeScalarType,
  required: z.boolean(),
  maxLength: z.number().int().min(1).max(20_000).nullable(),
  options: z.array(z.string().trim().min(1).max(80)).max(24),
}).strict().superRefine((field, context) => {
  const textual = field.type === "text" || field.type === "rich_text";
  if (textual !== (field.maxLength !== null)) context.addIssue({
    code: "custom", path: ["maxLength"], message: "only text fields require maxLength",
  });
  if ((field.type === "enum") !== (field.options.length > 0)) context.addIssue({
    code: "custom", path: ["options"], message: "only enum fields require options",
  });
  if (new Set(field.options).size !== field.options.length) context.addIssue({
    code: "custom", path: ["options"], message: "field options must be unique",
  });
})))();
export type PublicIntakeFieldV1 = z.infer<typeof PublicIntakeFieldV1>;

export const PublicFileRequestV1 = /*#__PURE__*/ (() => (z.object({
  requestId: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/),
  fieldId: IntakeFieldId,
  label: z.string().trim().min(1).max(80),
  required: z.boolean(),
  maxFiles: z.number().int().min(1).max(3),
  maxBytes: z.number().int().min(1).max(5 * 1024 * 1024),
  allowedMimeTypes: z.array(IntakeMimeType).min(1).max(4),
}).strict().superRefine((request, context) => {
  if (new Set(request.allowedMimeTypes).size !== request.allowedMimeTypes.length)
    context.addIssue({ code: "custom", path: ["allowedMimeTypes"], message: "file types must be unique" });
})))();
export type PublicFileRequestV1 = z.infer<typeof PublicFileRequestV1>;

const PublicIntakeFormShapeV1 = /*#__PURE__*/ (() => (z.object({
  schema: z.literal(1),
  formId: IntakeFormId,
  revision: z.number().int().min(1).max(1_000_000),
  title: z.string().trim().min(1).max(100),
  description: z.string().trim().max(1_000),
  target: z.object({
    tableId: IntakeTableId,
    expectedSchemaVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }).strict(),
  fields: z.array(PublicIntakeFieldV1).min(1).max(30),
  fileRequests: z.array(PublicFileRequestV1).max(5),
  encryption: z.object({
    algorithm: z.literal("ECDH-P256-HKDF-SHA256-AES-256-GCM"),
    ownerPublicKey: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
  }).strict(),
  delivery: z.object({
    submitToken: IntakeToken,
    expiresAt: IntakeCanonicalInstant,
  }).strict(),
}).strict()))();
function validateIntakeFields(form: Pick<z.infer<typeof PublicIntakeFormShapeV1>, "fields" | "fileRequests">, context: z.RefinementCtx): void {
  const fieldIds = form.fields.map(field => field.fieldId);
  const fileFieldIds = form.fileRequests.map(request => request.fieldId);
  const requestIds = form.fileRequests.map(request => request.requestId);
  if (new Set(fieldIds).size !== fieldIds.length)
    context.addIssue({ code: "custom", path: ["fields"], message: "form field ids must be unique" });
  if (new Set(fileFieldIds).size !== fileFieldIds.length)
    context.addIssue({ code: "custom", path: ["fileRequests"], message: "file field ids must be unique" });
  if (new Set(requestIds).size !== requestIds.length)
    context.addIssue({ code: "custom", path: ["fileRequests"], message: "file request ids must be unique" });
  if (fileFieldIds.some(id => fieldIds.includes(id)))
    context.addIssue({ code: "custom", path: ["fileRequests"], message: "file and value fields cannot overlap" });
}
export const PublicIntakeFormV1 = /*#__PURE__*/ (() => (PublicIntakeFormShapeV1.superRefine(validateIntakeFields)))();
export type PublicIntakeFormV1 = z.infer<typeof PublicIntakeFormV1>;
/** App-owned form definition, without a submit capability. Public transport V1
 * stays unchanged; only the trusted shell joins its token at delivery time. */
export const IntakeFormDefinitionV1 = /*#__PURE__*/ (() => (PublicIntakeFormShapeV1.extend({
  delivery: z.object({ expiresAt: IntakeCanonicalInstant }).strict(),
}).strict().superRefine(validateIntakeFields)))();
export type IntakeFormDefinitionV1 = z.infer<typeof IntakeFormDefinitionV1>;
export const IntakePublicationProposalV1 = /*#__PURE__*/ (() => (PublicIntakeFormShapeV1.pick({ title: true, description: true, target: true, fields: true, fileRequests: true })
  .extend({ expiresAt: IntakeCanonicalInstant }).strict().superRefine(validateIntakeFields)))();
export type IntakePublicationProposalV1 = z.infer<typeof IntakePublicationProposalV1>;

export const MAX_INTAKE_CIPHERTEXT_BYTES = 12 * 1024 * 1024;
const MAX_INTAKE_CIPHERTEXT_BASE64URL = Math.ceil(MAX_INTAKE_CIPHERTEXT_BYTES * 4 / 3);
const Base64Url = /*#__PURE__*/ (() => (z.string().regex(/^[A-Za-z0-9_-]+$/)))();
const IntakeScalarValue = /*#__PURE__*/ (() => (z.union([
  z.string().max(20_000), z.number().finite(), z.boolean(),
])))();

export const IntakeSubmissionValueV1 = /*#__PURE__*/ (() => (z.object({
  fieldId: IntakeFieldId,
  value: IntakeScalarValue,
}).strict()))();
export type IntakeSubmissionValueV1 = z.infer<typeof IntakeSubmissionValueV1>;

export const IntakeUploadedFileV1 = /*#__PURE__*/ (() => (z.object({
  requestId: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/),
  uploadId: z.string().regex(/^upl_[a-z2-7]{26}$/),
  name: z.string().min(1).max(120)
    .refine(value => value === value.trim() && !/[\\/\u0000-\u001f\u007f]/.test(value),
      "canonical leaf filename required"),
  mime: IntakeMimeType,
  size: z.number().int().min(1).max(5 * 1024 * 1024),
  sha256: IntakeSha256,
  bytes: Base64Url.max(Math.ceil(5 * 1024 * 1024 * 4 / 3)),
}).strict()))();
export type IntakeUploadedFileV1 = z.infer<typeof IntakeUploadedFileV1>;

export const IntakeSubmissionPlaintextV1 = /*#__PURE__*/ (() => (z.object({
  schema: z.literal(1),
  formId: IntakeFormId,
  formRevision: z.number().int().min(1).max(1_000_000),
  submissionId: IntakeSubmissionId,
  submittedAt: IntakeCanonicalInstant,
  values: z.array(IntakeSubmissionValueV1).max(30),
  files: z.array(IntakeUploadedFileV1).max(15),
}).strict().superRefine((submission, context) => {
  const fields = submission.values.map(value => value.fieldId);
  const uploads = submission.files.map(file => file.uploadId);
  if (new Set(fields).size !== fields.length)
    context.addIssue({ code: "custom", path: ["values"], message: "submission field ids must be unique" });
  if (new Set(uploads).size !== uploads.length)
    context.addIssue({ code: "custom", path: ["files"], message: "upload ids must be unique" });
  const totalBytes = submission.files.reduce((sum, file) => sum + file.size, 0);
  if (!Number.isSafeInteger(totalBytes) || totalBytes > 8 * 1024 * 1024)
    context.addIssue({ code: "custom", path: ["files"], message: "submission files exceed the 8 MB limit" });
})))();
export type IntakeSubmissionPlaintextV1 = z.infer<typeof IntakeSubmissionPlaintextV1>;

export const IntakeCiphertextEnvelopeV1 = /*#__PURE__*/ (() => (z.object({
  schema: z.literal(1),
  algorithm: z.literal("ECDH-P256-HKDF-SHA256-AES-256-GCM"),
  ephemeralPublicKey: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
  salt: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  iv: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
  ciphertext: Base64Url.max(MAX_INTAKE_CIPHERTEXT_BASE64URL),
}).strict()))();
export type IntakeCiphertextEnvelopeV1 = z.infer<typeof IntakeCiphertextEnvelopeV1>;

export const IntakeRelaySubmissionV1 = /*#__PURE__*/ (() => (z.object({
  schema: z.literal(1),
  submissionId: IntakeSubmissionId,
  envelope: IntakeCiphertextEnvelopeV1,
}).strict()))();
export type IntakeRelaySubmissionV1 = z.infer<typeof IntakeRelaySubmissionV1>;

export const IntakeAutoAcceptConditionV1 = /*#__PURE__*/ (() => (z.object({
  fieldId: IntakeFieldId,
  op: z.enum(["equals", "is_present"]),
  value: IntakeScalarValue.nullable(),
}).strict().superRefine((condition, context) => {
  if ((condition.op === "equals") !== (condition.value !== null)) context.addIssue({
    code: "custom", path: ["value"],
    message: condition.op === "equals" ? "equals needs a value" : "is_present takes no value",
  });
})))();
export type IntakeAutoAcceptConditionV1 = z.infer<typeof IntakeAutoAcceptConditionV1>;

export const IntakeAutoAcceptDraftV1 = /*#__PURE__*/ (() => (z.object({
  schema: z.literal(1),
  formId: IntakeFormId,
  formRevision: z.number().int().min(1).max(1_000_000),
  expectedSchemaVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  conditions: z.array(IntakeAutoAcceptConditionV1).min(1).max(5),
}).strict().superRefine((rule, context) => {
  const fields = rule.conditions.map(condition => condition.fieldId);
  if (new Set(fields).size !== fields.length)
    context.addIssue({ code: "custom", path: ["conditions"], message: "rule fields must be unique" });
})))();
export type IntakeAutoAcceptDraftV1 = z.infer<typeof IntakeAutoAcceptDraftV1>;

export const IntakeRelayFormRegistrationV1 = /*#__PURE__*/ (() => (z.object({
  schema: z.literal(1),
  formId: IntakeFormId,
  ownerToken: IntakeToken,
  submitToken: IntakeToken,
  expiresAt: IntakeCanonicalInstant,
  maxCiphertextBytes: z.number().int().min(1_024).max(MAX_INTAKE_CIPHERTEXT_BYTES),
}).strict().superRefine((registration, context) => {
  if (registration.ownerToken === registration.submitToken)
    context.addIssue({ code: "custom", path: ["submitToken"], message: "submit and owner tokens must differ" });
})))();
export type IntakeRelayFormRegistrationV1 = z.infer<typeof IntakeRelayFormRegistrationV1>;

export const IntakeRelayDeliveryItemV1 = /*#__PURE__*/ (() => (z.object({
  schema: z.literal(1),
  formId: IntakeFormId,
  submissionId: IntakeSubmissionId,
  receivedAt: IntakeCanonicalInstant,
  expiresAt: IntakeCanonicalInstant,
  ciphertextBytes: z.number().int().min(1).max(MAX_INTAKE_CIPHERTEXT_BYTES),
  envelope: IntakeCiphertextEnvelopeV1,
}).strict().superRefine((item, context) => {
  if (Date.parse(item.expiresAt) <= Date.parse(item.receivedAt)) context.addIssue({
    code: "custom", path: ["expiresAt"], message: "delivery expiry must follow receipt",
  });
})))();
export type IntakeRelayDeliveryItemV1 = z.infer<typeof IntakeRelayDeliveryItemV1>;

const RelayBaseUrl = /*#__PURE__*/ (() => (z.string().max(2_048).refine(value => {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return false;
    return url.protocol === "https:" || (url.protocol === "http:"
      && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]"));
  } catch { return false; }
}, "relay URL must be HTTPS (or loopback HTTP) without credentials, query, fragment, or path")))();

export const PublicIntakeLinkPayloadV1 = /*#__PURE__*/ (() => (z.object({
  schema: z.literal(1),
  relayBaseUrl: RelayBaseUrl,
  form: PublicIntakeFormV1,
}).strict()))();
export type PublicIntakeLinkPayloadV1 = z.infer<typeof PublicIntakeLinkPayloadV1>;

export const LocalIntakeFormV1 = /*#__PURE__*/ (() => (z.object({
  schema: z.literal(1),
  publicForm: PublicIntakeFormV1,
  ownerPrivateKey: z.string().regex(/^[A-Za-z0-9_-]{184}$/),
  ownerToken: IntakeToken,
  relayBaseUrl: RelayBaseUrl,
  publishedAt: IntakeCanonicalInstant.nullable(),
  revokedAt: IntakeCanonicalInstant.nullable(),
  terminalReason: z.enum(["revoked", "expired"]).nullable().optional(),
}).strict().superRefine((form, context) => {
  if (form.ownerToken === form.publicForm.delivery.submitToken)
    context.addIssue({ code: "custom", path: ["ownerToken"], message: "owner and submit tokens must differ" });
  if (form.publishedAt !== null && Date.parse(form.publishedAt) >= Date.parse(form.publicForm.delivery.expiresAt))
    context.addIssue({ code: "custom", path: ["publishedAt"], message: "publication must precede form expiry" });
  if (form.revokedAt !== null && form.publishedAt === null)
    context.addIssue({ code: "custom", path: ["revokedAt"], message: "an unpublished form cannot be revoked" });
  if (form.terminalReason !== undefined && form.terminalReason !== null && form.revokedAt === null)
    context.addIssue({ code: "custom", path: ["terminalReason"], message: "terminal reason requires a terminal time" });
})))();
export type LocalIntakeFormV1 = z.infer<typeof LocalIntakeFormV1>;

// Intake is re-exported by the base schema module; importing the catalog here
// would create an initialization cycle. Keep this protocol's primitive IDs closed.
export const IntakeOwnerSourceV1 = /*#__PURE__*/ (() => (z.object({ appInstanceId: z.string().regex(/^app_[a-z2-7]{26}$/),
  activeGenerationId: z.string().regex(/^gen_[a-z2-7]{26}$/),
  lineageEpoch: z.string().regex(/^(0|[1-9][0-9]*)$/).max(20).refine(value => /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= 18446744073709551615n),
}).strict()))();
export const LocalIntakeFormV2 = /*#__PURE__*/ (() => (z.object({ schema: z.literal(2), publicForm: IntakeFormDefinitionV1,
  ownerSource: IntakeOwnerSourceV1, relayBaseUrl: RelayBaseUrl,
  publishedAt: IntakeCanonicalInstant.nullable(), revokedAt: IntakeCanonicalInstant.nullable(),
  terminalReason: z.enum(["revoked", "expired"]).nullable(),
}).strict().superRefine((form, context) => {
  if (form.publishedAt !== null && Date.parse(form.publishedAt) >= Date.parse(form.publicForm.delivery.expiresAt))
    context.addIssue({ code: "custom", message: "Publication must precede form expiry" });
  if ((form.revokedAt !== null && form.publishedAt === null) || ((form.terminalReason !== null) !== (form.revokedAt !== null)))
    context.addIssue({ code: "custom", message: "Terminal form state is inconsistent" });
})))();
export type LocalIntakeFormV2 = z.infer<typeof LocalIntakeFormV2>;

/** Public, canonical, permanent publication exclusion. This does not revoke an
 * already active local form or confer private owner custody on a copied app. */
export const IntakePublicationClosureV1 = /*#__PURE__*/ (() => (z.object({ schema: z.literal(1), form: LocalIntakeFormV2,
  closedAt: z.string().datetime({ offset: true }), terminal: z.literal(true) }).strict()))();
export type IntakePublicationClosureV1 = z.infer<typeof IntakePublicationClosureV1>;

export const IntakeAutoAcceptRuleV1 = /*#__PURE__*/ (() => (z.object({
  schema: z.literal(1),
  formId: IntakeFormId,
  formRevision: z.number().int().min(1).max(1_000_000),
  expectedSchemaVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  conditions: z.array(IntakeAutoAcceptConditionV1).min(1).max(5),
  enabled: z.literal(true),
  simulationFingerprint: IntakeSha256,
  simulatedAt: IntakeCanonicalInstant,
  enabledAt: IntakeCanonicalInstant,
}).strict().superRefine((rule, context) => {
  const fields = rule.conditions.map(condition => condition.fieldId);
  if (new Set(fields).size !== fields.length)
    context.addIssue({ code: "custom", path: ["conditions"], message: "rule fields must be unique" });
  if (Date.parse(rule.enabledAt) < Date.parse(rule.simulatedAt))
    context.addIssue({ code: "custom", path: ["enabledAt"], message: "enablement cannot predate simulation" });
})))();
export type IntakeAutoAcceptRuleV1 = z.infer<typeof IntakeAutoAcceptRuleV1>;
