import { z } from "./validation-runtime";
import { IntakeSubmissionValueV1, IntakeUploadedFileV1, LocalIntakeFormV2, IntakeAutoAcceptRuleV1, IntakePublicationClosureV1 } from "./intake";
export const FileReviewSchema = z.object({
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
export const StoredUploadedFileSchema = IntakeUploadedFileV1.omit({ bytes: true });
export const StoredSubmissionBodySchema = z.object({
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
export const QuarantinedFileSchema = z.object({
  uploadId: z.string().regex(/^upl_[a-z2-7]{26}$/),
  bytes: IntakeUploadedFileV1.shape.bytes,
}).strict();
export const StoredSubmissionSchema = z.object({
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
export const ReceiptSchema = z.object({
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
export const SimulationSchema = z.object({
  formId: z.string().regex(/^form_[a-z2-7]{26}$/),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  simulatedAt: z.string().datetime({ offset: true }),
  pendingCount: z.number().int().nonnegative().max(100),
  matchedSubmissionIds: z.array(z.string().regex(/^sub_[a-z2-7]{26}$/)).max(100),
}).strict();
export const DeliveryFailureSchema = z.object({
  formId: z.string().regex(/^form_[a-z2-7]{26}$/),
  submissionId: z.string().regex(/^sub_[a-z2-7]{26}$/),
  envelopeSha256: z.string().regex(/^[0-9a-f]{64}$/),
  status: z.enum(["failed", "discard_authorized", "discarded", "staged"]),
  failedAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
export const LocalStateSchema = z.object({
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
