import { z } from "@clay/schema/validation-runtime";
import {
  IntakeAutoAcceptDraftV1,
  IntakeAutoAcceptRuleV1,
  IntakeSubmissionPlaintextV1,
  IntakeSubmissionValueV1,
  IntakeUploadedFileV1,
  LocalIntakeFormV2,
  IntakePublicationClosureV1,
  type IntakeUploadedFileV1 as IntakeUploadedFile,
  type PublicFileRequestV1,
  type IntakeFormDefinitionV1,
} from "@clay/schema/intake";
import { ClayError } from "./errors";
import type { RegColumn, RegTable, Registry } from "./registry";
import { sha256HexSync } from "./state-digest";

export type IntakeFileReviewStatus = "quarantined" | "rejected" | "activated";
export type IntakeFileReview = {
  uploadId: string;
  requestId: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  status: IntakeFileReviewStatus;
  reason: string | null;
  attachmentId: string | null;
};

export type IntakeSubmissionStatus = "pending" | "blocked" | "accepted" | "rejected";
export type StoredIntakeUploadedFileV1 = Omit<IntakeUploadedFile, "bytes">;
export type StoredIntakeSubmissionBodyV1 = Omit<IntakeSubmissionPlaintextV1, "files"> & {
  files: StoredIntakeUploadedFileV1[];
};
export type QuarantinedIntakeFileV1 = { uploadId: string; bytes: string };
export type StoredIntakeSubmissionV1 = {
  submission: StoredIntakeSubmissionBodyV1;
  quarantinedFiles: QuarantinedIntakeFileV1[];
  stagedAt: string;
  terminalAt: string | null;
  status: IntakeSubmissionStatus;
  validationErrors: string[];
  files: IntakeFileReview[];
  receiptId: string | null;
};

export type IntakeAcceptanceReceipt = {
  id: string;
  submissionId: string;
  formId: string;
  mode: "manual" | "auto";
  batchId: string;
  table: string;
  rowId: string;
  attachmentIds: string[];
  acceptedAt: string;
  undoneAt: string | null;
  undone: boolean;
};

export type IntakeAutoAcceptSimulation = {
  formId: string;
  fingerprint: string;
  simulatedAt: string;
  pendingCount: number;
  matchedSubmissionIds: string[];
};

export type IntakeInboxItem = {
  formId: string;
  formTitle: string;
  submissionId: string;
  submittedAt: string;
  stagedAt: string;
  status: IntakeSubmissionStatus;
  values: IntakeSubmissionPlaintextV1["values"];
  files: IntakeFileReview[];
  validationErrors: string[];
  receiptId: string | null;
};

export type IntakeDeliveryFailureStatus =
  | "failed" | "discard_authorized" | "discarded" | "staged";
export type IntakeDeliveryFailure = {
  formId: string;
  submissionId: string;
  envelopeSha256: string;
  status: IntakeDeliveryFailureStatus;
  failedAt: string;
  updatedAt: string;
};

export type IntakeLocalStateV2 = {
  schema: 2;
  forms: LocalIntakeFormV2[];
  submissions: StoredIntakeSubmissionV1[];
  deliveryFailures: IntakeDeliveryFailure[];
  rules: IntakeAutoAcceptRuleV1[];
  simulations: IntakeAutoAcceptSimulation[];
  receipts: IntakeAcceptanceReceipt[];
  publicationClosures?: IntakePublicationClosureV1[];
};

const FileReviewSchema = z.object({
  uploadId: z.string().regex(/^upl_[a-z2-7]{26}$/),
  requestId: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/),
  name: z.string().min(1).max(120),
  mime: z.string().min(1).max(100),
  size: z.number().int().min(1).max(5 * 1024 * 1024),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  status: z.enum(["quarantined", "rejected", "activated"]),
  reason: z.string().min(1).max(300).nullable(),
  attachmentId: z.string().regex(/^file_[0-9a-f]{32}$/).nullable(),
}).strict().superRefine((file, context) => {
  if ((file.status === "activated") !== (file.attachmentId !== null))
    context.addIssue({ code: "custom", message: "file activation metadata is inconsistent" });
  if ((file.status === "rejected") !== (file.reason !== null))
    context.addIssue({ code: "custom", message: "file rejection metadata is inconsistent" });
});

const StoredUploadedFileSchema = IntakeUploadedFileV1.omit({ bytes: true });
const StoredSubmissionBodySchema = z.object({
  schema: z.literal(1),
  formId: z.string().regex(/^form_[a-z2-7]{26}$/),
  formRevision: z.number().int().min(1).max(1_000_000),
  submissionId: z.string().regex(/^sub_[a-z2-7]{26}$/),
  submittedAt: z.string().datetime({ offset: true }),
  values: z.array(IntakeSubmissionValueV1).max(30),
  files: z.array(StoredUploadedFileSchema).max(15),
}).strict().superRefine((submission, context) => {
  if (new Set(submission.values.map(value => value.fieldId)).size !== submission.values.length)
    context.addIssue({ code: "custom", path: ["values"], message: "submission field ids must be unique" });
  if (new Set(submission.files.map(file => file.uploadId)).size !== submission.files.length)
    context.addIssue({ code: "custom", path: ["files"], message: "upload ids must be unique" });
});
const QuarantinedFileSchema = z.object({
  uploadId: z.string().regex(/^upl_[a-z2-7]{26}$/),
  bytes: IntakeUploadedFileV1.shape.bytes,
}).strict();

const StoredSubmissionSchema = z.object({
  submission: StoredSubmissionBodySchema,
  quarantinedFiles: z.array(QuarantinedFileSchema).max(15),
  stagedAt: z.string().datetime({ offset: true }),
  terminalAt: z.string().datetime({ offset: true }).nullable(),
  status: z.enum(["pending", "blocked", "accepted", "rejected"]),
  validationErrors: z.array(z.string().min(1).max(300)).max(30),
  files: z.array(FileReviewSchema).max(15),
  receiptId: z.string().regex(/^irc_[a-z2-7]{26}$/).nullable(),
}).strict().superRefine((submission, context) => {
  if ((submission.status === "accepted") !== (submission.receiptId !== null))
    context.addIssue({ code: "custom", message: "submission receipt state is inconsistent" });
  if ((submission.status === "blocked") !== (submission.validationErrors.length > 0))
    context.addIssue({ code: "custom", message: "submission validation state is inconsistent" });
  const terminal = submission.status === "accepted" || submission.status === "rejected";
  if (terminal !== (submission.terminalAt !== null))
    context.addIssue({ code: "custom", message: "submission terminal time is inconsistent" });
  if (terminal && submission.quarantinedFiles.length > 0)
    context.addIssue({ code: "custom", message: "terminal submission retained quarantine bytes" });
  const byteIds = submission.quarantinedFiles.map(file => file.uploadId);
  if (new Set(byteIds).size !== byteIds.length)
    context.addIssue({ code: "custom", message: "quarantine byte identities must be unique" });
  const quarantinedIds = new Set(submission.files
    .filter(file => file.status === "quarantined").map(file => file.uploadId));
  if (byteIds.some(id => !quarantinedIds.has(id))
      || [...quarantinedIds].some(id => !byteIds.includes(id)))
    context.addIssue({ code: "custom", message: "quarantine bytes and review state differ" });
});

const ReceiptSchema = z.object({
  id: z.string().regex(/^irc_[a-z2-7]{26}$/),
  submissionId: z.string().regex(/^sub_[a-z2-7]{26}$/),
  formId: z.string().regex(/^form_[a-z2-7]{26}$/),
  mode: z.enum(["manual", "auto"]),
  batchId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  table: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/),
  rowId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  attachmentIds: z.array(z.string().regex(/^file_[0-9a-f]{32}$/)).max(15),
  acceptedAt: z.string().datetime({ offset: true }),
  undoneAt: z.string().datetime({ offset: true }).nullable(),
  undone: z.boolean(),
}).strict().superRefine((receipt, context) => {
  if (receipt.undone !== (receipt.undoneAt !== null))
    context.addIssue({ code: "custom", message: "receipt undo state is inconsistent" });
});

const SimulationSchema = z.object({
  formId: z.string().regex(/^form_[a-z2-7]{26}$/),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  simulatedAt: z.string().datetime({ offset: true }),
  pendingCount: z.number().int().nonnegative().max(100),
  matchedSubmissionIds: z.array(z.string().regex(/^sub_[a-z2-7]{26}$/)).max(100),
}).strict();

const DeliveryFailureSchema = z.object({
  formId: z.string().regex(/^form_[a-z2-7]{26}$/),
  submissionId: z.string().regex(/^sub_[a-z2-7]{26}$/),
  envelopeSha256: z.string().regex(/^[0-9a-f]{64}$/),
  status: z.enum(["failed", "discard_authorized", "discarded", "staged"]),
  failedAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();

const LocalStateSchema = z.object({
  schema: z.literal(2),
  forms: z.array(LocalIntakeFormV2).max(100),
  submissions: z.array(StoredSubmissionSchema).max(500),
  deliveryFailures: z.array(DeliveryFailureSchema).max(500).default([]),
  rules: z.array(IntakeAutoAcceptRuleV1).max(100),
  simulations: z.array(SimulationSchema).max(100),
  receipts: z.array(ReceiptSchema).max(1_000),
  // Optional until the first explicit authority closure; old canonical bytes
  // are not normalized on read. Older closed parsers fail closed on this field.
  publicationClosures: z.array(IntakePublicationClosureV1).max(100).optional(),
}).strict().superRefine((state, context) => {
  for (const [path, values] of [
    ["forms", state.forms.map(form => form.publicForm.formId)],
    ["submissions", state.submissions.map(item => item.submission.submissionId)],
    ["deliveryFailures", state.deliveryFailures.map(item => `${item.formId}/${item.submissionId}`)],
    ["rules", state.rules.map(rule => rule.formId)],
    ["simulations", state.simulations.map(item => item.formId)],
    ["receipts", state.receipts.map(receipt => receipt.id)],
    ["publicationClosures", (state.publicationClosures ?? []).map(row => row.form.publicForm.formId)],
  ] as const) {
    if (new Set(values).size !== values.length)
      context.addIssue({ code: "custom", path: [path], message: `${path} identities must be unique` });
  }
});

export function emptyIntakeState(): IntakeLocalStateV2 {
  return {
    schema: 2, forms: [], submissions: [], deliveryFailures: [],
    rules: [], simulations: [], receipts: [],
  };
}

export function parseIntakeState(input: unknown): IntakeLocalStateV2 {
  if (input === undefined) return emptyIntakeState();
  // V2 is a closed physical contract, not an implicit legacy migration. Original
  // V1 state remains quarantined separately; malformed V2 is never normalized.
  const parsed = LocalStateSchema.safeParse(input);
  if (!parsed.success)
    throw new ClayError("E_VALIDATION", "local intake state is invalid", parsed.error.issues.map(issue => issue.message));
  return parsed.data;
}

export function parseLocalIntakeForm(input: unknown): LocalIntakeFormV2 {
  const parsed = LocalIntakeFormV2.safeParse(input);
  if (!parsed.success)
    throw new ClayError("E_VALIDATION", "local intake form is invalid", parsed.error.issues.map(issue => issue.message));
  return parsed.data;
}

export function parseIntakeSubmission(input: unknown): IntakeSubmissionPlaintextV1 {
  const parsed = IntakeSubmissionPlaintextV1.safeParse(input);
  if (!parsed.success)
    throw new ClayError("E_VALIDATION", "intake submission is invalid", parsed.error.issues.map(issue => issue.message));
  return parsed.data;
}

export function splitIntakeSubmissionForStorage(
  submission: IntakeSubmissionPlaintextV1,
  reviews: IntakeFileReview[],
): Pick<StoredIntakeSubmissionV1, "submission" | "quarantinedFiles"> {
  const quarantinedIds = new Set(reviews
    .filter(review => review.status === "quarantined").map(review => review.uploadId));
  const quarantinedFiles = submission.files
    .filter(file => quarantinedIds.has(file.uploadId))
    .map(file => ({ uploadId: file.uploadId, bytes: file.bytes }));
  const files = submission.files.map(file => {
    const { bytes: _released, ...metadata } = file;
    return metadata;
  });
  return { submission: { ...submission, files }, quarantinedFiles };
}

export function hydrateStoredIntakeSubmission(
  stored: StoredIntakeSubmissionV1,
): IntakeSubmissionPlaintextV1 {
  const bytes = new Map(stored.quarantinedFiles.map(file => [file.uploadId, file.bytes]));
  const files = stored.submission.files.flatMap(file => {
    const encoded = bytes.get(file.uploadId);
    return encoded === undefined ? [] : [{ ...file, bytes: encoded }];
  });
  return parseIntakeSubmission({ ...stored.submission, files });
}

export function parseAutoAcceptDraft(input: unknown): IntakeAutoAcceptDraftV1 {
  const parsed = IntakeAutoAcceptDraftV1.safeParse(input);
  if (!parsed.success)
    throw new ClayError("E_VALIDATION", "auto-accept rule is invalid", parsed.error.issues.map(issue => issue.message));
  return parsed.data;
}

export type ResolvedIntakeForm = {
  table: RegTable;
  valueFields: Map<string, RegColumn>;
  fileFields: Map<string, RegColumn>;
};

export function resolveIntakeForm(
  form: IntakeFormDefinitionV1,
  registry: Registry,
  currentVersion: number,
): ResolvedIntakeForm {
  if (form.target.expectedSchemaVersion !== currentVersion)
    throw new ClayError("E_CONFLICT", "the intake form targets an older schema version");
  const table = [...registry.values()].find(candidate =>
    !candidate.inactive && candidate.semantic?.tableId === form.target.tableId);
  if (!table) throw new ClayError("E_CONFLICT", "the intake target table is no longer active");
  const valueFields = new Map<string, RegColumn>();
  for (const field of form.fields) {
    const column = table.columns.find(candidate =>
      !candidate.inactive && !candidate.hidden && candidate.semantic?.fieldId === field.fieldId);
    if (!column || column.type !== field.type)
      throw new ClayError("E_CONFLICT", `the '${field.label}' intake field no longer matches the schema`);
    if (column.required && !field.required)
      throw new ClayError("E_VALIDATION", `required target field '${field.label}' must be required on the form`);
    if (field.type === "enum"
        && JSON.stringify(column.values ?? []) !== JSON.stringify(field.options))
      throw new ClayError("E_CONFLICT", `the '${field.label}' choices changed`);
    valueFields.set(field.fieldId, column);
  }
  const fileFields = new Map<string, RegColumn>();
  for (const request of form.fileRequests) {
    const column = table.columns.find(candidate =>
      !candidate.inactive && !candidate.hidden && candidate.type === "attachment"
      && candidate.semantic?.fieldId === request.fieldId);
    if (!column)
      throw new ClayError("E_CONFLICT", `the '${request.label}' file field is no longer active`);
    if (column.required && !request.required)
      throw new ClayError("E_VALIDATION", `required target file '${request.label}' must be required on the form`);
    fileFields.set(request.requestId, column);
  }
  const selectedValueIds = new Set(form.fields.map(field => field.fieldId));
  const selectedFileIds = new Set(form.fileRequests.map(request => request.fieldId));
  for (const column of table.columns) {
    if (!column.required || column.hidden || column.inactive
        || column.type === "computed" || column.type === "lookup" || column.type === "rollup") continue;
    const fieldId = column.semantic?.fieldId;
    const selected = fieldId !== undefined && (column.type === "attachment"
      ? selectedFileIds.has(fieldId) : selectedValueIds.has(fieldId));
    if (!selected) throw new ClayError(
      "E_VALIDATION", `required target field '${column.label ?? column.name}' must be included in the form`,
    );
  }
  return { table, valueFields, fileFields };
}

export function encodeIntakeFileBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)));
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function decodeIntakeFileBytes(value: string, maxBytes: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || !Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new ClayError("E_VALIDATION", "file bytes are not canonical base64url");
  const estimated = Math.floor(value.length * 6 / 8);
  if (estimated > maxBytes) throw new ClayError("E_LIMIT", "file exceeds its allowed size");
  const source = value.replaceAll("-", "+").replaceAll("_", "/");
  let binary: string;
  try { binary = atob(source + "=".repeat((4 - source.length % 4) % 4)); }
  catch { throw new ClayError("E_VALIDATION", "file bytes are not canonical base64url"); }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  let encoded = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    encoded += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)));
  const canonical = btoa(encoded).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  if (canonical !== value) throw new ClayError("E_VALIDATION", "file bytes are not canonical base64url");
  return bytes;
}

const MIME_EXTENSIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "application/pdf": ["pdf"],
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg"],
  "text/plain": ["txt"],
});
const ACTIVE_MARKERS = [
  "/javascript", "/js", "/launch", "/openaction", "/embeddedfile", "/richmedia",
  "/xfa", "<script", "javascript:", "<iframe", "<!doctype html", "<?xml", "[autorun]",
];

function containsAscii(bytes: Uint8Array, marker: string): boolean {
  const needle = [...marker].map(character => character.charCodeAt(0));
  outer: for (let start = 0; start + needle.length <= bytes.length; start++) {
    for (let index = 0; index < needle.length; index++) {
      const raw = bytes[start + index]!;
      const lower = raw >= 65 && raw <= 90 ? raw + 32 : raw;
      if (lower !== needle[index]) continue outer;
    }
    return true;
  }
  return false;
}

function passiveSignature(bytes: Uint8Array, mime: string): boolean {
  const ascii = (text: string): boolean =>
    [...text].every((character, index) => bytes[index] === character.charCodeAt(0));
  if (mime === "application/pdf") return ascii("%PDF-");
  if (mime === "image/png")
    return [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
  if (mime === "image/jpeg")
    return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mime === "text/plain") {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return !text.includes("\u0000");
    } catch { return false; }
  }
  return false;
}

export function inspectIntakeFile(
  upload: IntakeUploadedFile,
  request: PublicFileRequestV1,
): { bytes: Uint8Array | null; error: string | null } {
  try {
    if (upload.requestId !== request.requestId)
      throw new ClayError("E_VALIDATION", "file request identity does not match");
    if (!request.allowedMimeTypes.includes(upload.mime))
      throw new ClayError("E_VALIDATION", "file type is not allowed for this request");
    if (upload.mime === "application/pdf")
      throw new ClayError("E_VALIDATION", "PDF uploads are not accepted without a complete passive-content scanner");
    const extension = upload.name.includes(".")
      ? upload.name.slice(upload.name.lastIndexOf(".") + 1).toLocaleLowerCase() : "";
    if (!(MIME_EXTENSIONS[upload.mime] ?? []).includes(extension))
      throw new ClayError("E_VALIDATION", "file name and type do not match");
    if (upload.size > request.maxBytes)
      throw new ClayError("E_LIMIT", "file exceeds this request's size limit");
    const bytes = decodeIntakeFileBytes(upload.bytes, request.maxBytes);
    if (bytes.byteLength !== upload.size)
      throw new ClayError("E_VALIDATION", "file size does not match its bytes");
    if (!passiveSignature(bytes, upload.mime))
      throw new ClayError("E_VALIDATION", "file content does not match its passive type signature");
    if (ACTIVE_MARKERS.some(marker => containsAscii(bytes, marker)))
      throw new ClayError("E_VALIDATION", "active file content is prohibited");
    if (sha256HexSync(bytes) !== upload.sha256)
      throw new ClayError("E_VALIDATION", "file digest does not match its bytes");
    return { bytes, error: null };
  } catch (error) {
    return { bytes: null, error: error instanceof Error ? error.message : "file validation failed" };
  }
}

function scalarValueIssue(
  field: IntakeFormDefinitionV1["fields"][number],
  value: string | number | boolean,
): string | null {
  switch (field.type) {
    case "text": case "rich_text":
      return typeof value !== "string" || value.length > field.maxLength!
        ? `'${field.label}' must be text within ${field.maxLength} characters` : null;
    case "number":
      return typeof value !== "number" || !Number.isFinite(value)
        ? `'${field.label}' must be a finite number` : null;
    case "integer":
      return typeof value !== "number" || !Number.isSafeInteger(value)
        ? `'${field.label}' must be a safe integer` : null;
    case "boolean": return typeof value === "boolean" ? null : `'${field.label}' must be yes or no`;
    case "date": {
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value))
        return `'${field.label}' must be a calendar date`;
      const parsed = new Date(`${value}T00:00:00.000Z`);
      return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
        ? null : `'${field.label}' must be a calendar date`;
    }
    case "enum":
      return typeof value === "string" && field.options.includes(value)
        ? null : `'${field.label}' must be one of its published choices`;
  }
}

export function validateSubmissionForForm(
  form: IntakeFormDefinitionV1,
  submission: IntakeSubmissionPlaintextV1,
  resolved: ResolvedIntakeForm,
): {
  row: Record<string, unknown>;
  files: IntakeFileReview[];
  fileBytes: Map<string, Uint8Array>;
  validationErrors: string[];
} {
  if (submission.formId !== form.formId || submission.formRevision !== form.revision)
    throw new ClayError("E_CONFLICT", "submission targets another form revision");
  const values = new Map(submission.values.map(value => [value.fieldId, value.value]));
  const allowed = new Set(form.fields.map(field => field.fieldId));
  if ([...values.keys()].some(fieldId => !allowed.has(fieldId)))
    throw new ClayError("E_VALIDATION", "submission contains a field that was not published");
  const row: Record<string, unknown> = {};
  const scalarIssues: string[] = [];
  for (const field of form.fields) {
    const value = values.get(field.fieldId);
    if (value === undefined) {
      if (field.required) scalarIssues.push(`'${field.label}' is required`);
      continue;
    }
    const issue = scalarValueIssue(field, value);
    if (issue) scalarIssues.push(issue);
    else row[resolved.valueFields.get(field.fieldId)!.name] = value;
  }
  if (scalarIssues.length > 0)
    throw new ClayError("E_VALIDATION", "submission values do not match the published form", scalarIssues);

  const requests = new Map(form.fileRequests.map(request => [request.requestId, request]));
  const byRequest = new Map<string, number>();
  const files: IntakeFileReview[] = [];
  const fileBytes = new Map<string, Uint8Array>();
  const validationErrors: string[] = [];
  for (const upload of submission.files) {
    const request = requests.get(upload.requestId);
    if (!request) throw new ClayError("E_VALIDATION", "submission contains an unpublished file request");
    const count = (byRequest.get(request.requestId) ?? 0) + 1;
    byRequest.set(request.requestId, count);
    const inspected = count > request.maxFiles
      ? { bytes: null, error: `too many files for '${request.label}'` }
      : inspectIntakeFile(upload, request);
    if (inspected.error) validationErrors.push(`${request.label}: ${inspected.error}`);
    else fileBytes.set(upload.uploadId, inspected.bytes!);
    files.push({
      uploadId: upload.uploadId, requestId: upload.requestId, name: upload.name,
      mime: upload.mime, size: upload.size, sha256: upload.sha256,
      status: inspected.error ? "rejected" : "quarantined",
      reason: inspected.error, attachmentId: null,
    });
  }
  for (const request of form.fileRequests) {
    if (request.required && (byRequest.get(request.requestId) ?? 0) === 0)
      validationErrors.push(`${request.label}: a file is required`);
  }
  return { row, files, fileBytes, validationErrors };
}

function stableJson(input: unknown): string {
  if (input === null || typeof input !== "object") return JSON.stringify(input);
  if (Array.isArray(input)) return `[${input.map(stableJson).join(",")}]`;
  const record = input as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

export function autoAcceptFingerprint(
  form: IntakeFormDefinitionV1,
  draft: IntakeAutoAcceptDraftV1,
): string {
  return sha256HexSync(new TextEncoder().encode(stableJson({ schema: 1, form, draft })));
}

export function submissionMatchesAutoRule(
  submission: Pick<IntakeSubmissionPlaintextV1, "values">,
  rule: Pick<IntakeAutoAcceptDraftV1, "conditions">,
): boolean {
  const values = new Map(submission.values.map(value => [value.fieldId, value.value]));
  return rule.conditions.every(condition => condition.op === "is_present"
    ? values.has(condition.fieldId)
    : values.get(condition.fieldId) === condition.value);
}

export function mintIntakeReceiptId(): string {
  if (!globalThis.crypto?.getRandomValues)
    throw new ClayError("E_INTERNAL", "secure receipt identity source is unavailable");
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(17));
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let value = 0;
  let encoded = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && encoded.length < 26) {
      bits -= 5;
      encoded += alphabet[(value >>> bits) & 31];
      value &= (1 << bits) - 1;
    }
  }
  if (encoded.length !== 26) throw new ClayError("E_INTERNAL", "receipt identity source failed");
  return `irc_${encoded}`;
}

export function intakeInboxItem(
  stored: StoredIntakeSubmissionV1,
  form: LocalIntakeFormV2,
): IntakeInboxItem {
  return {
    formId: stored.submission.formId,
    formTitle: form.publicForm.title,
    submissionId: stored.submission.submissionId,
    submittedAt: stored.submission.submittedAt,
    stagedAt: stored.stagedAt,
    status: stored.status,
    values: stored.submission.values.map(value => ({ ...value })),
    files: stored.files.map(file => ({ ...file })),
    validationErrors: [...stored.validationErrors],
    receiptId: stored.receiptId,
  };
}
