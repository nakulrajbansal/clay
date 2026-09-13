import { LocalIntakeFormV2 } from "@clay/schema/intake";
import { IntakeRevocationJobV1 } from "@clay/schema/intake-workflow";
import { IntakeCommandPayloadV1 } from "@clay/schema/catalog";
import { hydrateIntakeOwnerForm, type IntakeOwnerVault } from "./owner-custody";
import { buildPublicIntakeLink, discardFailedIntakeDelivery, fetchAndStageIntake, type IntakeOwnerTransport } from "./client";
import { executeIntakeIntent, IntakeSession } from "./session";
import { intakeConfiguration, type IntakeConfiguration } from "./publication";

/** All authenticated HTTP and private hydration live here, outside the worker. */
export class IntakeOwnerClient {
  readonly configuration: ReturnType<typeof intakeConfiguration>;
  private readonly key: string;
  constructor(readonly session: IntakeSession, readonly vault: IntakeOwnerVault, configuration: IntakeConfiguration, readonly fetchImpl: typeof fetch = fetch) {
    this.configuration = intakeConfiguration(configuration); this.key = `clay_intake_revocation_v1:${session.appInstanceId}`;
  }
  async hydrate(form: LocalIntakeFormV2): Promise<IntakeOwnerTransport> {
    const read = await this.session.assertCurrent();
    if (form.relayBaseUrl.replace(/\/$/u, "") !== this.configuration.relayBaseUrl.replace(/\/$/u, ""))
      throw new Error("Original intake relay configuration changed; private custody was not read");
    const current = read.forms.find(row => row.publicForm.formId === form.publicForm.formId);
    if (!current || JSON.stringify(current) !== JSON.stringify(form)) throw new Error("Reviewed intake form changed; refresh before a new action");
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
  private persist(job: IntakeRevocationJobV1): void {
    const raw = JSON.stringify(IntakeRevocationJobV1.parse(job)); this.session.cache.setItem(this.key, raw);
    if (JSON.stringify(this.pendingRevocation()) !== raw) throw new Error("Intake revocation readback failed; original request kept");
  }
  async revoke(form?: LocalIntakeFormV2): Promise<void> {
    let job = this.pendingRevocation();
    if (!job) {
      if (!form || this.session.pending()) throw new Error("Reconcile retained intake work first");
      await this.hydrate(form);
      const intent = this.session.begin("intake.revokeForm", { formId: form.publicForm.formId, revokedAt: new Date().toISOString() });
      job = { schema: 1, form, intent, relayConfirmed: false }; this.persist(job);
    } else if (form && JSON.stringify(form) !== JSON.stringify(job.form)) throw new Error("Retained revocation belongs to the original form");
    const outcome = await executeIntakeIntent<LocalIntakeFormV2>(this.session.worker, job.intent);
    await this.session.read();
    const metadata = this.session.reviewed!.forms.find(row => row.publicForm.formId === job!.form.publicForm.formId);
    if (!metadata || JSON.stringify(LocalIntakeFormV2.parse(metadata)) !== JSON.stringify(LocalIntakeFormV2.parse(outcome.result))) throw new Error("Revoked intake metadata changed; original request kept");
    const hydrated = await this.hydrate(metadata);
    if (!job.relayConfirmed) {
      let response: Response;
      try { response = await this.fetchImpl(`${this.configuration.relayBaseUrl}intake/forms/${job.form.publicForm.formId}`,
        { method: "DELETE", redirect: "error", headers: { authorization: `Bearer ${hydrated.ownerToken}` } }); }
      catch { throw new Error("Intake closed locally; relay revocation is uncertain. Retry the original revocation"); }
      if (!response.ok && response.status !== 404 && response.status !== 410)
        throw new Error(`Intake closed locally; relay revocation needs retry (HTTP ${response.status})`);
      job = { ...job, relayConfirmed: true }; this.persist(job);
    }
    if (this.session.pending()) await this.session.retry(); // Acknowledge the original committed local response, not another revoke.
    this.session.cache.removeItem(this.key);
    if (this.pendingRevocation()) throw new Error("Intake revocation cleanup needs retry");
  }
}
