import { IntakeCommandPayloadV1, TargetEvidenceV1 } from "@clay/schema/catalog";
import type { WorkerClient } from "../app/worker-client";
import { beginPresentationIntent, cancelPresentationIntent, finishPresentationIntent, readPresentationIntent,
  reconcilePresentation, type PresentationIntent } from "../app/presentation-intent";
import type { IntakeAutoAcceptDraftV1, IntakeAutoAcceptRuleV1, IntakeSubmissionPlaintextV1, LocalIntakeFormV2 } from "@clay/schema/intake";
import type { IntakeAcceptanceReceipt, IntakeAutoAcceptSimulation, IntakeDeliveryFailure, IntakeInboxItem } from "@clay/kernel";

export type IntakeCache = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type IntakeRead = Awaited<ReturnType<WorkerClient["intakePresentation"]>>;
export type IntakeRoute = IntakeCommandPayloadV1["command"]["route"];
export async function executeIntakeIntent<T>(worker: WorkerClient, intent: PresentationIntent): Promise<{ result: T; target: TargetEvidenceV1 }> {
  if (intent.route !== "intake.command" || intent.slot !== "intake") throw new Error("Original intake request required");
  await reconcilePresentation(worker, intent, () => worker.intakeCommand(IntakeCommandPayloadV1.parse(intent.payload), { requestId: intent.requestId }));
  const outcome = await worker.mutationOutcome(intent.route, intent.payload, { requestId: intent.requestId });
  if (outcome.status !== "recorded") throw new Error("Intake outcome needs reconciliation; original request was kept");
  return { result: outcome.result as T, target: TargetEvidenceV1.parse(outcome.target) };
}
/** Presentation cache, not durable authority. Every writer sends a captured
 * context and full original target through the one closed production command. */
export class IntakeSession {
  reviewed: IntakeRead | null = null;
  constructor(readonly cache: IntakeCache, readonly worker: WorkerClient, readonly appInstanceId: string) {}
  pending(): PresentationIntent | null { return readPresentationIntent(this.cache, this.appInstanceId, "intake"); }
  async read(): Promise<IntakeRead> {
    const read = await this.worker.intakePresentation();
    if (read.authorityTarget.appInstanceId !== this.appInstanceId
        || (this.reviewed && (read.authorityTarget.activeGenerationId !== this.reviewed.authorityTarget.activeGenerationId
          || read.authorityTarget.lineageEpoch !== this.reviewed.authorityTarget.lineageEpoch)))
      throw new Error("Intake source changed; original work was kept");
    this.reviewed = read; return read;
  }
  async assertCurrent(): Promise<IntakeRead> {
    const read = await this.worker.intakePresentation();
    if (!this.reviewed || JSON.stringify(read.authorityTarget) !== JSON.stringify(this.reviewed.authorityTarget))
      throw new Error("Reviewed intake source changed; original action was kept");
    return read;
  }
  begin(route: IntakeRoute, payload: unknown, source = this.reviewed?.authorityTarget): PresentationIntent {
    if (!source || source.appInstanceId !== this.appInstanceId) throw new Error("Review the original intake source first");
    return beginPresentationIntent(this.cache, this.appInstanceId, "intake", "intake.command", { authorityTarget: source, command: { route, payload } },
      () => this.worker.createMutationContext());
  }
  async command<T>(route: IntakeRoute, payload: unknown, source = this.reviewed?.authorityTarget): Promise<T> {
    return (await this.commandOutcome<T>(route, payload, source)).result;
  }
  async commandOutcome<T>(route: IntakeRoute, payload: unknown, source = this.reviewed?.authorityTarget): Promise<{ result: T; target: TargetEvidenceV1 }> {
    const intent = this.begin(route, payload, source);
    const outcome = await executeIntakeIntent<T>(this.worker, intent);
    await this.read();
    finishPresentationIntent(this.cache, this.appInstanceId, "intake", intent.requestId); return outcome;
  }
  async retry(): Promise<unknown> {
    const intent = this.pending(); if (!intent) throw new Error("No retained intake request");
    const { result } = await executeIntakeIntent(this.worker, intent); await this.read();
    finishPresentationIntent(this.cache, this.appInstanceId, "intake", intent.requestId); return result;
  }
  async cancel(): Promise<boolean> {
    const intent = this.pending(); if (!intent) return true;
    return cancelPresentationIntent(this.cache, this.worker, intent);
  }
  saveIntakeForm(form: LocalIntakeFormV2): Promise<LocalIntakeFormV2> { return this.command("intake.saveForm", { form }); }
  markIntakeFormPublished(formId: string, publishedAt: string): Promise<LocalIntakeFormV2> { return this.command("intake.markPublished", { formId, publishedAt }); }
  revokeIntakeForm(formId: string, revokedAt: string): Promise<LocalIntakeFormV2> { return this.command("intake.revokeForm", { formId, revokedAt }); }
  markIntakeFormExpired(formId: string, expiredAt: string): Promise<LocalIntakeFormV2> { return this.command("intake.markExpired", { formId, expiredAt }); }
  async intakeDeliveryFailures(): Promise<IntakeDeliveryFailure[]> { return (await this.assertCurrent()).deliveryFailures; }
  recordIntakeDeliveryFailure(failure: { formId: string; submissionId: string; envelopeSha256: string; failedAt: string }): Promise<IntakeDeliveryFailure> {
    return this.command("intake.recordDeliveryFailure", { failure });
  }
  authorizeIntakeDeliveryDiscard(formId: string, submissionId: string, authorizedAt: string): Promise<IntakeDeliveryFailure> {
    return this.command("intake.authorizeDeliveryDiscard", { formId, submissionId, authorizedAt });
  }
  resolveIntakeDeliveryFailure(formId: string, submissionId: string, resolution: "staged" | "discarded", resolvedAt: string): Promise<IntakeDeliveryFailure | null> {
    return this.command("intake.resolveDeliveryFailure", { formId, submissionId, resolution, resolvedAt });
  }
  stageIntakeSubmission(submission: IntakeSubmissionPlaintextV1): Promise<IntakeInboxItem> { return this.command("intake.stageSubmission", { submission }); }
  rejectIntakeSubmission(submissionId: string): Promise<IntakeInboxItem> { return this.command("intake.rejectSubmission", { submissionId }); }
  simulateIntakeAutoAccept(draft: IntakeAutoAcceptDraftV1): Promise<IntakeAutoAcceptSimulation> { return this.command("intake.simulateAutoAccept", { draft }); }
  enableIntakeAutoAccept(draft: IntakeAutoAcceptDraftV1, simulationFingerprint: string): Promise<IntakeAutoAcceptRuleV1> { return this.command("intake.enableAutoAccept", { draft, simulationFingerprint }); }
  disableIntakeAutoAccept(formId: string): Promise<null> { return this.command("intake.disableAutoAccept", { formId }); }
  processIntakeAutoAccept(formId: string): Promise<IntakeAcceptanceReceipt[]> { return this.command("intake.processAutoAccept", { formId }); }
  acceptIntakeSubmission(submissionId: string, approvedFileIds: string[]): Promise<IntakeAcceptanceReceipt> {
    return this.command("intake.acceptSubmission", { submissionId, approvedFileIds, mode: "manual" });
  }
  undoIntakeReceipt(receiptId: string): Promise<IntakeAcceptanceReceipt> { return this.command("intake.undoReceipt", { receiptId }); }
}
