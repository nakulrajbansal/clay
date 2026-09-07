import { z } from "zod";
import { AppInstanceId, Sha256 } from "./index";
import { CanonicalInstant, TargetEvidenceV1 } from "./catalog";
import { BackupAuthenticationV1 } from "./backup";

const RestoreValidationId = z.string().regex(/^restoreval_[a-z2-7]{26}$/);

/**
 * Trusted-worker grant consumed by the UI. Shape validation is not archive
 * authentication: only the format-5 integration boundary may issue this after
 * validating the bytes and reserving a distinct fresh app identity.
 */
export const AuthenticatedFormat5RestoreGrantV1 = z.object({
  schema: z.literal(1),
  kind: z.literal("authenticated_format5_restore_as_new"),
  validationId: RestoreValidationId,
  archiveFormat: z.literal(5),
  cryptographicallyAuthenticated: z.literal(true),
  authentication: BackupAuthenticationV1,
  archiveSha256: Sha256,
  archiveTarget: TargetEvidenceV1,
  preservedAppInstanceId: AppInstanceId,
  destinationAppInstanceId: AppInstanceId,
  installMode: z.literal("new_app_only"),
  validatedAt: CanonicalInstant,
}).strict().superRefine((value, context) => {
  if (value.destinationAppInstanceId === value.preservedAppInstanceId)
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["destinationAppInstanceId"],
      message: "restore-as-new destination must differ from the preserved app",
    });
});
export type AuthenticatedFormat5RestoreGrantV1 = z.infer<
  typeof AuthenticatedFormat5RestoreGrantV1
>;
