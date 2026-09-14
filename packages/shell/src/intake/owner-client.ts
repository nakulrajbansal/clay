import { LocalIntakeFormV2 } from "@clay/schema/standalone/intake";
import { IntakeRevocationJobV1 } from "@clay/schema/standalone/intake-workflow";
import { IntakeCommandPayloadV1, PresentationIntentV1, TargetEvidenceV1 } from "@clay/schema/standalone/catalog";
import { hydrateIntakeOwnerForm, type IntakeOwnerVault } from "./owner-custody";
import { buildPublicIntakeLink, discardFailedIntakeDelivery, fetchAndStageIntake, type IntakeOwnerTransport } from "./client";
import { executeIntakeIntent, IntakeSession } from "./session";
import { intakeConfiguration, type IntakeConfiguration } from "./publication";
import { terminalizeIntakeRelay } from "./relay-terminal";
import { IndexedDbIntakeWorkflows, IntakeWorkflowSlot, UnfencedIntakeWorkflowError, type IntakeWorkflows } from "./workflows";
import { finishPresentationIntent } from "../app/presentation-intent";

const activeIntent = (job: IntakeRevocationJobV1) => job.renewals?.at(-1)?.intent ?? job.intent;
const definition = (form: LocalIntakeFormV2) => JSON.stringify([form.ownerSource, form.publicForm, form.relayBaseUrl]);

/** All authenticated HTTP and private hydration live here, outside the worker. */
export class IntakeOwnerClient {
  readonly configuration: ReturnType<typeof intakeConfiguration>;
  private readonly key: string;
  private readonly workflow: IntakeWorkflowSlot<"revocation">;
  constructor(readonly session: IntakeSession, readonly vault: IntakeOwnerVault, configuration: IntakeConfiguration, readonly fetchImpl: typeof fetch = fetch,
    workflows: IntakeWorkflows = new IndexedDbIntakeWorkflows()) {
    this.configuration = intakeConfiguration(configuration); this.key = `clay_intake_revocation_v1:${session.appInstanceId}`;
    this.workflow = new IntakeWorkflowSlot(workflows, session.cache, this.configuration.shellOrigin, session.appInstanceId, "revocation");
  }
  async recover(): Promise<IntakeRevocationJobV1 | null> { await this.workflow.recover(); return this.pendingRevocation(); }
  async hydrate(form: LocalIntakeFormV2): Promise<IntakeOwnerTransport> {
    const read = await this.session.assertCurrent();
    if (form.relayBaseUrl.replace(/\/$/u, "") !== this.configuration.relayBaseUrl.replace(/\/$/u, ""))
      throw new Error("Original intake relay configuration changed; private custody was not read");
    const current = read.forms.find(row => row.publicForm.formId === form.publicForm.formId);
    if (!current || JSON.stringify(LocalIntakeFormV2.parse(current)) !== JSON.stringify(LocalIntakeFormV2.parse(form))) throw new Error("Reviewed intake form changed; refresh before a new action");
    const privateForm = await hydrateIntakeOwnerForm(form, read.authorityTarget, this.configuration.shellOrigin, this.vault);
    await this.session.assertCurrent();
    return { relayBaseUrl: form.relayBaseUrl, publishedAt: form.publishedAt, revokedAt: form.revokedAt, ...privateForm };
  }
  async link(form: LocalIntakeFormV2): Promise<string> {
    const hydrated = await this.hydrate(form);
    return buildPublicIntakeLink(this.configuration.publicBaseUrl, form.relayBaseUrl, hydrated.publicForm);
  }
  async fetch(form: LocalIntakeFormV2, retrySubmissionIds: string[] = []) {
    if (form.publishedAt === null || form.revokedAt !== null) throw new Error("Intake form is not active");
    if (Date.parse(form.publicForm.delivery.expiresAt) <= Date.now()) {
      await this.session.markIntakeFormExpired(form.publicForm.formId, new Date().toISOString()); return [];
    }
    return fetchAndStageIntake(this.session, await this.hydrate(form), this.fetchImpl, { retrySubmissionIds });
  }
  async discard(form: LocalIntakeFormV2, submissionId: string) {
    return discardFailedIntakeDelivery(this.session, await this.hydrate(form), submissionId, this.fetchImpl);
  }
  pendingRevocation(): IntakeRevocationJobV1 | null {
    const raw = this.session.cache.getItem(this.key); if (raw === null) return null;
    try {
      if (new TextEncoder().encode(raw).byteLength > 2_000_000) throw new Error();
      const job = IntakeRevocationJobV1.parse(JSON.parse(raw));
      const payload = IntakeCommandPayloadV1.parse(job.intent.payload);
      if (job.intent.appInstanceId !== this.session.appInstanceId || job.intent.route !== "intake.command" || payload.command.route !== "intake.revokeForm"
          || payload.command.payload.formId !== job.form.publicForm.formId) throw new Error();
      return job;
    } catch { throw new Error("Original intake revocation needs recovery; retained work was kept"); }
  }
  private async persist(job: IntakeRevocationJobV1): Promise<void> {
    await this.workflow.persist(job);
    const raw = JSON.stringify(IntakeRevocationJobV1.parse(job)); this.session.cache.setItem(this.key, raw);
    if (JSON.stringify(this.pendingRevocation()) !== raw) throw new Error("Intake revocation readback failed; original request kept");
  }
  /** Preserve the cache-only original after a fresh owner review. This claim is
   * not an old-client fence and never means an active form has been reconciled.
   * Finish requires permanent local terminal metadata and the exact relay proof. */
  async adoptLegacyRevocation(reviewedInput: TargetEvidenceV1): Promise<void> {
    const reviewed = TargetEvidenceV1.parse(reviewedInput);
    try { await this.recover(); return; }
    catch (error) { if (!(error instanceof UnfencedIntakeWorkflowError)) throw error; }
    const original = this.pendingRevocation(); if (!original) throw new Error("Original legacy revocation is unavailable");
    const read = await this.session.read();
    const form = read.forms.find(row => row.publicForm.formId === original.form.publicForm.formId);
    if (JSON.stringify(read.authorityTarget) !== JSON.stringify(reviewed) || !form || form.publishedAt === null
        || definition(form) !== definition(original.form) || form.relayBaseUrl !== this.configuration.relayBaseUrl)
      throw new Error("Reviewed original intake source or configuration changed; legacy work was kept");
    await hydrateIntakeOwnerForm(form, reviewed, this.configuration.shellOrigin, this.vault);
    if (JSON.stringify((await this.session.read()).authorityTarget) !== JSON.stringify(reviewed))
      throw new Error("Original owner source changed during custody readback; legacy work was kept");
    await this.workflow.claimLegacyRevocation(original);
  }
  /** Explicit new review, not a retry rebase. Cancel/readback and exact remote
   * terminal proof precede minting; the complete original chain is retained. */
  async renewRevocation(reviewedInput: TargetEvidenceV1): Promise<void> {
    const reviewed = TargetEvidenceV1.parse(reviewedInput);
    await this.recover(); const job = this.pendingRevocation();
    if (!job || job.relayConfirmed || (job.renewals?.length ?? 0) >= 8) throw new Error("Original revocation cannot be renewed; retained work was kept");
    const current = await this.session.read(), source = job.form.ownerSource;
    if (JSON.stringify(current.authorityTarget) !== JSON.stringify(reviewed) || source.appInstanceId !== reviewed.appInstanceId
        || source.activeGenerationId !== reviewed.activeGenerationId || source.lineageEpoch !== reviewed.lineageEpoch)
      throw new Error("Reviewed original source changed; no renewal was invoked");
    if (job.form.relayBaseUrl !== this.configuration.relayBaseUrl) throw new Error("Original relay configuration is required for renewal");
    const form = current.forms.find(row => row.publicForm.formId === job.form.publicForm.formId);
    if (!form || definition(LocalIntakeFormV2.parse(form)) !== definition(job.form) || form.revokedAt !== null)
      throw new Error("Original local form changed or already closed; reconcile its outcome before renewal");
    const original = activeIntent(job), pending = this.session.pending();
    if (pending && ![job.intent, ...(job.renewals ?? []).map(row => row.intent)].some(intent => JSON.stringify(intent) === JSON.stringify(pending)))
      throw new Error("A different original request needs recovery first");
    const hydrated = await hydrateIntakeOwnerForm(job.form, reviewed, this.configuration.shellOrigin, this.vault);
    const outcome = await this.session.worker.cancelPresentation(original.route, original.payload, { requestId: original.requestId });
    const readback = await this.session.worker.mutationOutcome(original.route, original.payload, { requestId: original.requestId });
    if ((outcome.status !== "cancelled" && outcome.status !== "failed") || readback.status !== outcome.status)
      throw new Error("Original local revoke is not terminal without effects; reconcile it before renewal");
    const relay = await terminalizeIntakeRelay(hydrated, this.configuration.relayBaseUrl, this.fetchImpl);
    if (JSON.stringify((await this.session.read()).authorityTarget) !== JSON.stringify(reviewed))
      throw new Error("Reviewed source changed during terminalization; original request was kept");
    const intent = PresentationIntentV1.parse({ schema: 1, appInstanceId: reviewed.appInstanceId, slot: "intake", route: "intake.command",
      requestId: this.session.worker.createMutationContext().requestId, payload: { authorityTarget: reviewed,
        command: { route: "intake.revokeForm", payload: { formId: form.publicForm.formId, revokedAt: new Date().toISOString() } } } });
    await this.persist({ ...job, renewals: [...(job.renewals ?? []), { previousRequestId: original.requestId, terminalStatus: outcome.status, relay, intent }] });
    // Presentation may still hold an earlier request after a lost persist ack.
    // Revoke reconciles it against the retained chain before any new effect.
  }
  private async reconcilePriorPresentation(job: IntakeRevocationJobV1): Promise<void> {
    const pending = this.session.pending(), active = activeIntent(job);
    if (!pending || JSON.stringify(pending) === JSON.stringify(active)) return;
    const chain = [job.intent, ...(job.renewals ?? []).map(row => row.intent)];
    const index = chain.findIndex(intent => JSON.stringify(intent) === JSON.stringify(pending));
    if (index < 0 || index >= chain.length - 1) throw new Error("A different original intake command needs reconciliation first");
    const outcome = await this.session.worker.cancelPresentation(pending.route, pending.payload, { requestId: pending.requestId });
    const readback = await this.session.worker.mutationOutcome(pending.route, pending.payload, { requestId: pending.requestId });
    if (outcome.status !== job.renewals![index]!.terminalStatus || readback.status !== outcome.status)
      throw new Error("Prior revocation outcome changed; all identities were kept");
    finishPresentationIntent(this.session.cache, this.session.appInstanceId, "intake", pending.requestId);
  }
  async revoke(form?: LocalIntakeFormV2): Promise<void> {
    const fixedForm = form ? LocalIntakeFormV2.parse(form) : undefined;
    await this.recover();
    let job = this.pendingRevocation();
    if (!job) {
      if (!fixedForm || this.session.pending()) throw new Error("Reconcile retained intake work first");
      await this.hydrate(fixedForm);
      const intent = this.session.begin("intake.revokeForm", { formId: fixedForm.publicForm.formId, revokedAt: new Date().toISOString() });
      job = { schema: 1, form: fixedForm, intent, relayConfirmed: false }; await this.persist(job);
    } else if (fixedForm && JSON.stringify(fixedForm) !== JSON.stringify(job.form)) throw new Error("Retained revocation belongs to the original form");
    await this.reconcilePriorPresentation(job);
    const original = activeIntent(job);
    let metadata = (await this.session.read()).forms.find(row => row.publicForm.formId === job!.form.publicForm.formId);
    if (!metadata || definition(metadata) !== definition(job.form)) throw new Error("Original revocation form changed; work was kept");
    let status: "recorded" | "cancelled" | "failed" = "recorded";
    if (metadata.revokedAt !== null) {
      // An unknown old-client ID may have closed first. The canonical terminal
      // form can no longer be republished or have its disposition rewritten.
      // Still cancel/read back this exact original: a snapshot is not its fence.
      const outcome = await this.session.worker.cancelPresentation(original.route, original.payload, { requestId: original.requestId });
      const readback = await this.session.worker.mutationOutcome(original.route, original.payload, { requestId: original.requestId });
      if ((outcome.status !== "recorded" && outcome.status !== "cancelled" && outcome.status !== "failed") || readback.status !== outcome.status)
        throw new Error("Original revocation invocation is not terminal; work was kept");
      if (readback.status === "recorded") {
        const response = LocalIntakeFormV2.parse(readback.result);
        if (definition(response) !== definition(job.form) || response.revokedAt === null) throw new Error("Original revocation receipt differs");
      }
      status = outcome.status;
    } else {
      const outcome = await executeIntakeIntent<LocalIntakeFormV2>(this.session.worker, original);
      await this.session.read();
      metadata = this.session.reviewed!.forms.find(row => row.publicForm.formId === job!.form.publicForm.formId);
      if (!metadata || JSON.stringify(LocalIntakeFormV2.parse(metadata)) !== JSON.stringify(LocalIntakeFormV2.parse(outcome.result)))
        throw new Error("Revoked intake metadata changed; original request kept");
    }
    const hydrated = await this.hydrate(metadata);
    if (job.terminalProof && (JSON.stringify(job.terminalProof.form) !== JSON.stringify(metadata)
        || job.terminalProof.invocation.status !== status))
      throw new Error("Original terminal proof changed; all owner work was kept");
    if (!job.terminalProof) {
      const relay = await terminalizeIntakeRelay(hydrated, this.configuration.relayBaseUrl, this.fetchImpl);
      const current = await this.session.read();
      if (JSON.stringify(current.forms.find(row => row.publicForm.formId === job!.form.publicForm.formId)) !== JSON.stringify(metadata))
        throw new Error("Original terminal metadata changed; work was kept");
      job = { ...job, relayConfirmed: true, terminalProof: { form: metadata, authorityTarget: current.authorityTarget, relay,
        invocation: { requestId: original.requestId, status } } }; await this.persist(job);
    }
    if (this.session.pending()) finishPresentationIntent(this.session.cache, this.session.appInstanceId, "intake", original.requestId);
    await this.workflow.finish();
    if (this.pendingRevocation()) throw new Error("Intake revocation cleanup needs retry");
  }
}
