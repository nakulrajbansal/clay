import { z } from "./validation-runtime";
import { AuthorityIncarnationId, RequestId } from "./index";
import { ProductionRequestReceiptV1, TargetEvidenceV1 } from "./catalog";
import { LocalIntakeFormV2 } from "./intake";

export const LegacyOwnerRouteV1 = /*#__PURE__*/ (() => (z.enum(["intake.saveForm", "intake.markPublished", "intake.revokeForm", "intake.markExpired", "intake.command"])))();
export const LegacyOwnerCandidateV1 = /*#__PURE__*/ (() => (z.object({ schema: z.literal(1), authorityIncarnationId: AuthorityIncarnationId,
  route: LegacyOwnerRouteV1, source: TargetEvidenceV1, receipt: ProductionRequestReceiptV1 }).strict().superRefine((value, context) => {
  const s = value.source, r = value.receipt;
  if (r.state !== "committed" || r.appInstanceId !== s.appInstanceId || r.activeGenerationId !== s.activeGenerationId || r.lineageEpoch !== s.lineageEpoch
      || r.expectedProtectionRevision !== s.protectionRevision || r.expectedStateSha256 !== s.stateSha256)
    context.addIssue({ code: "custom", message: "Original committed owner evidence required" });
})))();
export type LegacyOwnerCandidateV1 = z.infer<typeof LegacyOwnerCandidateV1>;
export const LegacyOwnerProofV1 = /*#__PURE__*/ (() => (LegacyOwnerCandidateV1.innerType().extend({ kind: z.enum(["intake_private", "intake_public"]),
  form: LocalIntakeFormV2, activation: z.enum(["original_metadata", "custody_only"]) }).strict().superRefine((value, context) => {
  if (!LegacyOwnerCandidateV1.safeParse({ schema: value.schema, authorityIncarnationId: value.authorityIncarnationId, route: value.route, source: value.source, receipt: value.receipt }).success
      || value.form.ownerSource.appInstanceId !== value.source.appInstanceId || value.form.ownerSource.activeGenerationId !== value.source.activeGenerationId
      || value.form.ownerSource.lineageEpoch !== value.source.lineageEpoch) context.addIssue({ code: "custom", message: "Original owner proof differs" });
})))();
export type LegacyOwnerProofV1 = z.infer<typeof LegacyOwnerProofV1>;
export const LegacyOwnerInventoryV1 = /*#__PURE__*/ (() => (z.object({ schema: z.literal(1), target: TargetEvidenceV1,
  legacyState: z.boolean(), candidates: z.array(LegacyOwnerCandidateV1).max(16), next: RequestId.nullable(),
  unproven: z.number().int().min(0).max(64) }).strict()))();
export type LegacyOwnerInventoryV1 = z.infer<typeof LegacyOwnerInventoryV1>;
