import { LocalIntakeFormV2 } from "@clay/schema/intake";
import { IntakeRevocationJobV1 } from "@clay/schema/intake-workflow";
import { IntakeCommandPayloadV1 } from "@clay/schema/catalog";
import { hydrateIntakeOwnerForm, type IntakeOwnerVault } from "./owner-custody";
import { buildPublicIntakeLink, discardFailedIntakeDelivery, fetchAndStageIntake, type IntakeOwnerTransport } from "./client";
import { executeIntakeIntent, IntakeSession } from "./session";
import { intakeConfiguration, type IntakeConfiguration } from "./publication";
import { terminalizeIntakeRelay } from "./relay-terminal";
import { IndexedDbIntakeWorkflows, IntakeWorkflowSlot, type IntakeWorkflows } from "./workflows";

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
    const pending = this.session.pending();
    if (pending && JSON.stringify(pending) !== JSON.stringify(job.intent)) throw new Error("A different original intake command needs reconciliation first");
    const outcome = await executeIntakeIntent<LocalIntakeFormV2>(this.session.worker, job.intent);
    await this.session.read();
    const metadata = this.session.reviewed!.forms.find(row => row.publicForm.formId === job!.form.publicForm.formId);
    if (!metadata || JSON.stringify(LocalIntakeFormV2.parse(metadata)) !== JSON.stringify(LocalIntakeFormV2.parse(outcome.result))) throw new Error("Revoked intake metadata changed; original request kept");
    const hydrated = await this.hydrate(metadata);
    if (!job.relayConfirmed) {
      await terminalizeIntakeRelay(hydrated, this.configuration.relayBaseUrl, this.fetchImpl);
      job = { ...job, relayConfirmed: true }; await this.persist(job);
    }
    if (this.session.pending()) await this.session.retry(); // Acknowledge the original committed local response, not another revoke.
    await this.workflow.finish();
    if (this.pendingRevocation()) throw new Error("Intake revocation cleanup needs retry");
  }
}
