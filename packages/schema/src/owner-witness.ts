import { z } from "./validation-runtime";
import { AuthorityIncarnationId, RequestId, UInt64Decimal } from "./index";
import { AppLifecycleReceiptV1, ProductionRequestReceiptV1, TargetEvidenceV1 } from "./catalog";
import { LocalIntakeFormV2 } from "./intake";

/** A retained public invocation, not possession of a URL, token or semantic ID.
 * Source-free V1 material cannot be supplied to this ordinary worker route. */
export const IntakeOwnerClaimV1 = /*#__PURE__*/ (() => (z.object({ schema: z.literal(1), requestId: RequestId,
  source: TargetEvidenceV1, form: LocalIntakeFormV2 }).strict().superRefine((value, context) => {
  const source = value.form.ownerSource;
  if (source.appInstanceId !== value.source.appInstanceId || source.activeGenerationId !== value.source.activeGenerationId
      || source.lineageEpoch !== value.source.lineageEpoch || value.form.publishedAt !== null || value.form.revokedAt !== null || value.form.terminalReason !== null)
    context.addIssue({ code: "custom", message: "Original owner creation invocation required" });
})))();
export type IntakeOwnerClaimV1 = z.infer<typeof IntakeOwnerClaimV1>;
export const IntakeOwnerWitnessV1 = /*#__PURE__*/ (() => (z.object({ schema: z.literal(1), status: z.enum(["live", "history_only", "deleted"]),
  authorityIncarnationId: AuthorityIncarnationId, catalogGeneration: UInt64Decimal,
  claim: IntakeOwnerClaimV1, receipt: ProductionRequestReceiptV1, retirement: AppLifecycleReceiptV1.optional() }).strict().superRefine((value, context) => {
  const receipt = value.receipt, source = value.claim.source;
  if (receipt.state !== "committed" || receipt.requestId !== value.claim.requestId || receipt.appInstanceId !== source.appInstanceId
      || receipt.activeGenerationId !== source.activeGenerationId || receipt.lineageEpoch !== source.lineageEpoch
      || receipt.expectedProtectionRevision !== source.protectionRevision || receipt.expectedStateSha256 !== source.stateSha256)
    context.addIssue({ code: "custom", message: "Exact original owner creation receipt required" });
  if ((value.status === "deleted") !== !!value.retirement || (value.retirement && (value.retirement.schema !== 2 || value.retirement.kind !== "delete"
      || value.retirement.requestedAppInstanceId !== value.claim.source.appInstanceId || value.retirement.authorityIncarnationId !== value.authorityIncarnationId
      || BigInt(value.retirement.completedCatalogGeneration) > BigInt(value.catalogGeneration))))
    context.addIssue({ code: "custom", message: "Exact original app retirement proof required" });
})))();
export type IntakeOwnerWitnessV1 = z.infer<typeof IntakeOwnerWitnessV1>;
