import { LocalIntakeFormV2 } from "@clay/schema/standalone/intake";
import type { TargetEvidenceV1 } from "@clay/schema/catalog";
import { ClayStore } from "./store";
import { ClayError } from "./errors";

const unavailable = () => new ClayError("E_CONFLICT", "Legacy intake private custody is quarantined; original data and receipts were kept");
export function assertIntakeOwnerSource(form: LocalIntakeFormV2, target: TargetEvidenceV1): void {
  if (form.ownerSource.appInstanceId !== target.appInstanceId || form.ownerSource.activeGenerationId !== target.activeGenerationId
      || form.ownerSource.lineageEpoch !== target.lineageEpoch)
    throw new ClayError("E_CONFLICT", "Intake owner source changed; a copied or rebound form has no delivery authority");
}
export function assertIntakeCommandSource(store: ClayStore, route: string, payload: Readonly<Record<string, unknown>>, target: TargetEvidenceV1): void {
  if (route === "intake.saveForm" || route === "intake.closePublication") { assertIntakeOwnerSource(LocalIntakeFormV2.parse(payload.form), target); return; }
  let formId = payload.formId;
  if (route === "intake.stageSubmission") formId = (payload.submission as { formId: string }).formId;
  if (route === "intake.recordDeliveryFailure") formId = (payload.failure as { formId: string }).formId;
  if (route === "intake.simulateAutoAccept" || route === "intake.enableAutoAccept") formId = (payload.draft as { formId: string }).formId;
  if (route === "intake.acceptSubmission" || route === "intake.rejectSubmission")
    formId = ClayStore.prototype.intakeInbox.call(store).find(item => item.submissionId === payload.submissionId)?.formId;
  if (route === "intake.undoReceipt") formId = ClayStore.prototype.intakeReceipts.call(store).find(item => item.id === payload.receiptId)?.formId;
  const form = ClayStore.prototype.listIntakeForms.call(store).find(item => item.publicForm.formId === formId);
  if (!form) throw new ClayError("E_CONFLICT", "Intake source form is unavailable");
  assertIntakeOwnerSource(form, target);
}
/** Inspect property names only. Never transform an old response into a redacted
 * response with the same request identity, and never include values in errors. */
export function assertIntakeResponsePublic(route: string, input: unknown): void {
  if (!route.startsWith("intake.")) return;
  const visit = (value: unknown, depth: number): void => {
    if (depth > 64) throw unavailable();
    if (!value || typeof value !== "object") return;
    for (const key of Object.keys(value)) {
      if (["ownerPrivateKey", "ownerToken", "submitToken"].includes(key)) throw unavailable();
      visit((value as Record<string, unknown>)[key], depth + 1);
    }
  };
  visit(input, 0);
}
/** No private bytes are selected into an export buffer. Legacy originals and
 * historical receipts stay untouched until their separate custody adoption. */
export { assertNoLegacyIntakeArchive } from "./intake-archive-boundary";
