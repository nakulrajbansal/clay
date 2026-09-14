import { TargetEvidenceV1, PresentationIntentV1, IntakeCommandPayloadV1 } from "@clay/schema/standalone/catalog";
import { IntakePublicationProposalV1 as Proposal, IntakeRelayFormRegistrationResultV1, LocalIntakeFormV2, IntakePublicationClosureV1 } from "@clay/schema/standalone/intake";
import { IntakePublicationJobV1 as Job } from "@clay/schema/standalone/intake-workflow";
import { hydrateIntakeOwnerForm, prepareIntakeOwnerForm, recoverIntakeOwnerForm, type IntakeOwnerVault } from "./owner-custody";
import { buildPublicIntakeLink, mintIntakeFormId } from "./client";
import { executeIntakeIntent, IntakeSession } from "./session";
import { boundedRelayJson } from "../app/bounded-relay-response";
import { IndexedDbIntakeWorkflows, IntakeWorkflowSlot, UnfencedIntakeWorkflowError, type IntakeWorkflows } from "./workflows";
import { intakeRegistration, terminalizeIntakeRelay } from "./relay-terminal";
import { IntakeOwnerClaimV1, IntakeOwnerWitnessV1 } from "@clay/schema/standalone/owner-witness";

type FetchLike = typeof fetch;
const activeClosure = (job: Job) => job.termination?.renewals?.at(-1)?.intent ?? job.termination?.authorityClosure;
export type IntakeConfiguration = { shellOrigin: string; relayBaseUrl: string | null; publicBaseUrl: string };
export function intakeConfiguration(input: IntakeConfiguration): { shellOrigin: string; relayBaseUrl: string; publicBaseUrl: string } {
  const allowed = (value: string): string => {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/"
        || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error();
    return url.origin;
  };
  try {
    if (!input.relayBaseUrl) throw new Error();
    const shellOrigin = allowed(input.shellOrigin), publicBaseUrl = allowed(input.publicBaseUrl);
    if (shellOrigin !== input.shellOrigin || publicBaseUrl !== shellOrigin) throw new Error();
    return { shellOrigin, publicBaseUrl, relayBaseUrl: `${allowed(input.relayBaseUrl)}/` };
  } catch { throw new Error("Intake configuration is unavailable or not bound to this shell origin"); }
}
/** A public-only retained workflow. The vault owns capabilities; the worker owns
 * metadata. Checkpoint each transition before the next asynchronous effect. */
export class IntakePublication {
  readonly configuration: ReturnType<typeof intakeConfiguration>;
  private readonly key: string;
  private readonly workflow: IntakeWorkflowSlot<"publication">;
  private recovered = false;
  constructor(readonly session: IntakeSession, readonly vault: IntakeOwnerVault, input: IntakeConfiguration, readonly fetchImpl: FetchLike = fetch,
    workflows: IntakeWorkflows = new IndexedDbIntakeWorkflows()) {
    this.configuration = intakeConfiguration(input); this.key = `clay_intake_publication_v1:${session.appInstanceId}`;
    this.workflow = new IntakeWorkflowSlot(workflows, session.cache, this.configuration.shellOrigin, session.appInstanceId, "publication");
  }
  async recover(): Promise<Job | null> {
    await this.workflow.recover(); this.recovered = true; return this.pending();
  }
  pending(): Job | null {
    const raw = this.session.cache.getItem(this.key); if (raw === null) return null;
    try {
      if (new TextEncoder().encode(raw).byteLength > 2_000_000) throw new Error();
      const job = Job.parse(JSON.parse(raw));
      if (job.source.appInstanceId !== this.session.appInstanceId || JSON.stringify(job.configuration) !== JSON.stringify(this.configuration)) throw new Error();
      for (const intent of [job.save, job.publish]) if (intent && (intent.appInstanceId !== job.source.appInstanceId || intent.slot !== "intake" || intent.route !== "intake.command")) throw new Error();
      return job;
    } catch { throw new Error("Original intake publication needs recovery; retained work was kept"); }
  }
  private cache(job: Job): Job {
    const fixed = Job.parse(job); const raw = JSON.stringify(fixed);
    if (new TextEncoder().encode(raw).byteLength > 2_000_000) throw new Error("Intake publication exceeds the local payload bound");
    this.session.cache.setItem(this.key, raw);
    if (JSON.stringify(this.pending()) !== raw) throw new Error("Intake publication readback failed; original identity was kept");
    return fixed;
  }
  async begin(proposal: Proposal): Promise<void> {
    if (!this.recovered) throw new Error("Recover original intake workflows before another publication");
    if (this.pending() || this.session.pending()) throw new Error("Reconcile retained intake work before another publication");
    const source = this.session.reviewed?.authorityTarget; if (!source) throw new Error("Review the intake source first");
    await this.persist({ schema: 1, formId: mintIntakeFormId(), source, configuration: this.configuration, proposal: Proposal.parse(proposal),
      save: null, publish: null, complete: null, relayInvoked: false, relayConfirmed: false });
  }
  private async persist(job: Job): Promise<Job> { return this.cache(await this.workflow.persist(job)); }
  private intent(source: TargetEvidenceV1, route: "intake.saveForm" | "intake.markPublished" | "intake.closePublication", payload: unknown): PresentationIntentV1 {
    return PresentationIntentV1.parse({ schema: 1, appInstanceId: source.appInstanceId, slot: "intake", route: "intake.command",
      requestId: this.session.worker.createMutationContext().requestId, payload: { authorityTarget: source, command: { route, payload } } });
  }
  async resume(): Promise<{ localForm: LocalIntakeFormV2; link: string }> {
    await this.recover();
    let job = this.pending(); if (!job) throw new Error("No retained intake publication");
    if (job.termination) throw new Error("Original publication is closing; resume its terminalization before a fresh preview");
    const current = await this.session.read();
    if (current.authorityTarget.activeGenerationId !== job.source.activeGenerationId || current.authorityTarget.lineageEpoch !== job.source.lineageEpoch)
      throw new Error("Original intake owner source changed; publication was kept");
    // prepare is idempotent even if the vault committed but its acknowledgement was lost.
    const draft = await prepareIntakeOwnerForm({ ...job.proposal, source: job.source, formId: job.formId, shellOrigin: this.configuration.shellOrigin,
      relayBaseUrl: this.configuration.relayBaseUrl, vault: this.vault });
    const privateForm = await hydrateIntakeOwnerForm(draft, job.source, this.configuration.shellOrigin, this.vault);
    if (!job.save) job = await this.persist({ ...job, save: this.intent(job.source, "intake.saveForm", { form: draft }) });
    if (JSON.stringify(LocalIntakeFormV2.parse(IntakeCommandPayloadV1.parse(job.save!.payload).command.payload.form)) !== JSON.stringify(draft))
      throw new Error("Original intake save request differs from custody; retained work was kept");
    const saved = await executeIntakeIntent<LocalIntakeFormV2>(this.session.worker, job.save!);
    if (JSON.stringify(LocalIntakeFormV2.parse(saved.result)) !== JSON.stringify(draft)) throw new Error("Original intake draft receipt does not match custody");
    if (!job.publish) job = await this.persist({ ...job, publish: this.intent(saved.target, "intake.markPublished", { formId: job.formId, publishedAt: new Date().toISOString() }) });
    if (JSON.stringify(IntakeCommandPayloadV1.parse(job.publish!.payload).authorityTarget) !== JSON.stringify(saved.target))
      throw new Error("Original intake publication target differs from its save receipt; retained work was kept");
    if (!job.relayConfirmed) {
      const read = await this.session.read();
      if (JSON.stringify(read.authorityTarget) !== JSON.stringify(saved.target)) throw new Error("Intake publication source changed; original draft and custody were kept");
      job = await this.persist({ ...job, relayInvoked: true }); // Fence before any HTTP, including retries.
      let response: Response;
      try { response = await this.fetchImpl(`${this.configuration.relayBaseUrl}intake/forms`, { method: "POST", credentials: "include", redirect: "error", headers: { "content-type": "application/json" },
        body: JSON.stringify(intakeRegistration(privateForm)) }); }
      catch { throw new Error("Intake publication delivery is uncertain; retry the retained form"); }
      if (!response.ok) throw new Error(`Intake publication was not acknowledged (HTTP ${response.status}); retained form kept`);
      const acknowledgement = IntakeRelayFormRegistrationResultV1.safeParse(await boundedRelayJson(response, 8 * 1024));
      if (!acknowledgement.success || acknowledgement.data.formId !== job.formId || acknowledgement.data.expiresAt !== draft.publicForm.delivery.expiresAt)
        throw new Error("Intake publication acknowledgement differs; original form and request were kept");
      job = await this.persist({ ...job, relayConfirmed: true });
    }
    const published = await executeIntakeIntent<LocalIntakeFormV2>(this.session.worker, job.publish!);
    const localForm = LocalIntakeFormV2.parse(published.result);
    if (localForm.publicForm.formId !== job.formId || !localForm.publishedAt) throw new Error("Intake publication receipt is inconsistent");
    const readback = await this.session.read();
    const live = readback.forms.find(form => form.publicForm.formId === job.formId);
    if (!live || JSON.stringify(live) !== JSON.stringify(localForm)) throw new Error("Intake publication changed after commit; original receipt was kept");
    await this.persist({ ...job, complete: localForm });
    return { localForm, link: buildPublicIntakeLink(this.configuration.publicBaseUrl, localForm.relayBaseUrl, privateForm.publicForm) };
  }
  async finish(): Promise<void> {
    const job = this.pending(); if (!job?.complete) throw new Error("Intake publication is not reconciled");
    await this.workflow.finish(); if (this.pending()) throw new Error("Intake publication cleanup needs retry");
  }
  /** A completed original catalog deletion permanently excludes every delayed
   * source-bound invocation, including unknown old IDs. It does not assert that
   * a missing invocation never ran, modify local terminal metadata, or authorize
   * another app. Exact relay tombstone and existing original custody are also
   * mandatory. Only public proof enters this retained ledger. */
  async closeDeletedOriginal(reviewedInput: IntakeOwnerWitnessV1): Promise<void> {
    const reviewed = IntakeOwnerWitnessV1.parse(reviewedInput);
    if (reviewed.status !== "deleted") throw new Error("Exact deleted original owner retirement proof is required");
    await this.recover();
    let job = this.pending(); const closed = job ? null : this.workflow.closedJob();
    job ??= closed;
    if (!job?.save || (closed && !closed.termination?.deletedOwner)) throw new Error("Original deletion recovery invocation is unavailable; work was kept");
    const claim = IntakeOwnerClaimV1.parse({ schema: 1, source: job.source, requestId: job.save.requestId,
      form: IntakeCommandPayloadV1.parse(job.save.payload).command.payload.form });
    // Catalog generation may advance for another app or a lease. Every owner,
    // request, response and permanent deletion identity must remain identical.
    const immutable = (proof: IntakeOwnerWitnessV1) => JSON.stringify({ ...proof, catalogGeneration: "0" });
    const prove = async () => {
      const proof = IntakeOwnerWitnessV1.parse(await this.session.worker.intakeOwnerWitness(claim));
      if (proof.status !== "deleted" || JSON.stringify(reviewed.claim) !== JSON.stringify(claim)
          || immutable(proof) !== immutable(reviewed)
          || (job!.termination?.deletedOwner && immutable(job!.termination.deletedOwner) !== immutable(proof)))
        throw new Error("Reviewed original deletion identity changed; custody and requests were kept");
      return proof;
    };
    await prove();
    if (closed) return; // Exact durable close readback, never mere absence.
    if (!job.termination?.deletedOwner) job = await this.persist({ ...job,
      termination: { ...(job.termination ?? { requestedAt: new Date().toISOString(), complete: false }), deletedOwner: reviewed } });
    const draft = await recoverIntakeOwnerForm(job.source, job.formId, this.configuration.shellOrigin, this.configuration.relayBaseUrl, this.vault);
    if (JSON.stringify(draft) !== JSON.stringify(claim.form)) throw new Error("Original custody differs from its creation witness; work was kept");
    const hydrated = await hydrateIntakeOwnerForm(draft, job.source, this.configuration.shellOrigin, this.vault);
    const relay = await terminalizeIntakeRelay(hydrated, this.configuration.relayBaseUrl, this.fetchImpl);
    await prove();
    if (job.termination!.relayTerminal && JSON.stringify(job.termination!.relayTerminal) !== JSON.stringify(relay))
      throw new Error("Original relay terminal identity changed; all identities were kept");
    job = await this.persist({ ...job, termination: { ...job.termination!, relayTerminal: relay, complete: true } });
    await this.workflow.finish();
  }
  /** Explicit owner recovery for public cache-only V2 work. It is never adopted
   * as resumable publication. Private V1 rows/receipts remain a separate boundary. */
  async terminalizeLegacy(): Promise<void> {
    try { await this.recover(); }
    catch (error) {
      if (!(error instanceof UnfencedIntakeWorkflowError)) throw error;
      const original = this.pending(); if (!original) throw error;
      const read = await this.session.read();
      if (read.authorityTarget.activeGenerationId !== original.source.activeGenerationId || read.authorityTarget.lineageEpoch !== original.source.lineageEpoch)
        throw new Error("Original intake owner source is unavailable; legacy work and custody were kept");
      const form = await recoverIntakeOwnerForm(original.source, original.formId, this.configuration.shellOrigin, this.configuration.relayBaseUrl, this.vault);
      if (JSON.stringify(Proposal.parse({ title: form.publicForm.title, description: form.publicForm.description,
        target: form.publicForm.target, fields: form.publicForm.fields, fileRequests: form.publicForm.fileRequests, expiresAt: form.publicForm.delivery.expiresAt })) !== JSON.stringify(original.proposal))
        throw new Error("Legacy proposal differs from original owner custody; work was kept");
      if (original.save && JSON.stringify(LocalIntakeFormV2.parse(IntakeCommandPayloadV1.parse(original.save.payload).command.payload.form)) !== JSON.stringify(form))
        throw new Error("Legacy save differs from original custody; work was kept");
      await this.workflow.claimLegacyClosure(original);
    }
    await this.terminalize();
  }
  /** Explicit new source review. The previous invocation and remote identity
   * must be terminal before a new immutable closure ID may enter the ledger. */
  async renewClosure(reviewedInput: TargetEvidenceV1, reviewedRequestId?: string): Promise<void> {
    const reviewed = TargetEvidenceV1.parse(reviewedInput);
    const cached = this.pending(), expectedRequestId = reviewedRequestId ?? (cached && activeClosure(cached)?.requestId);
    await this.recover(); const job = this.pending(), original = job && activeClosure(job);
    if (!job?.termination || !original || job.termination.complete || job.termination.closureReceipt || (job.termination.renewals?.length ?? 0) >= 8)
      throw new Error("Original closure cannot be renewed or its bounded renewal limit was reached; work was kept");
    if (!expectedRequestId || expectedRequestId !== original.requestId) throw new Error("Reviewed closure invocation changed; review its retained identity again");
    const current = await this.session.read();
    if (JSON.stringify(current.authorityTarget) !== JSON.stringify(reviewed) || reviewed.appInstanceId !== job.source.appInstanceId
        || reviewed.activeGenerationId !== job.source.activeGenerationId || reviewed.lineageEpoch !== job.source.lineageEpoch)
      throw new Error("Reviewed original source changed; no closure renewal was invoked");
    const draft = await recoverIntakeOwnerForm(job.source, job.formId, this.configuration.shellOrigin, this.configuration.relayBaseUrl, this.vault);
    if (JSON.stringify(LocalIntakeFormV2.parse(IntakeCommandPayloadV1.parse(original.payload).command.payload.form)) !== JSON.stringify(draft))
      throw new Error("Original closure differs from custody; work was kept");
    const privateForm = await hydrateIntakeOwnerForm(draft, reviewed, this.configuration.shellOrigin, this.vault);
    const outcome = await this.session.worker.cancelPresentation(original.route, original.payload, { requestId: original.requestId });
    const readback = await this.session.worker.mutationOutcome(original.route, original.payload, { requestId: original.requestId });
    if ((outcome.status !== "cancelled" && outcome.status !== "failed") || readback.status !== outcome.status)
      throw new Error("Original closure is not terminal without effects; reconcile its existing receipt before renewal");
    const relay = await terminalizeIntakeRelay(privateForm, this.configuration.relayBaseUrl, this.fetchImpl);
    if (JSON.stringify((await this.session.read()).authorityTarget) !== JSON.stringify(reviewed))
      throw new Error("Reviewed source changed during closure terminalization; original identities were kept");
    const intent = this.intent(reviewed, "intake.closePublication", { form: draft });
    await this.persist({ ...job, termination: { ...job.termination, renewals: [...(job.termination.renewals ?? []),
      { previousRequestId: original.requestId, terminalStatus: outcome.status, relay, intent }] } });
  }
  /** Explicit abandonment, never source renewal. Each original worker request
   * is terminally cancelled/reconciled; remote absence alone grants nothing. */
  async terminalize(): Promise<void> {
    await this.recover(); let job = this.pending(); if (!job) throw new Error("No retained intake publication");
    const read = await this.session.read();
    if (read.authorityTarget.activeGenerationId !== job.source.activeGenerationId || read.authorityTarget.lineageEpoch !== job.source.lineageEpoch)
      throw new Error("Original intake source is required for terminal recovery; custody was kept");
    if (!job.termination) job = await this.persist({ ...job, termination: { requestedAt: new Date().toISOString(), complete: false } });
    for (const intent of [job.save, job.publish]) {
      if (!intent) continue; // The ledger fence prevents a late resume minting it.
      const outcome = await this.session.worker.cancelPresentation(intent.route, intent.payload, { requestId: intent.requestId });
      const confirmed = await this.session.worker.mutationOutcome(intent.route, intent.payload, { requestId: intent.requestId });
      if (!["recorded", "cancelled", "failed"].includes(outcome.status) || confirmed.status !== outcome.status)
        throw new Error("Original intake invocation is not terminal; requests and custody were kept");
      if (confirmed.status === "recorded" && LocalIntakeFormV2.parse(confirmed.result).publicForm.formId !== job.formId)
        throw new Error("Original intake outcome identity differs; requests and custody were kept");
    }
    if (this.workflow.requiresAuthorityClosure()) {
      const draft = await recoverIntakeOwnerForm(job.source, job.formId, this.configuration.shellOrigin, this.configuration.relayBaseUrl, this.vault);
      if (!job.termination!.authorityClosure) {
        const reviewed = await this.session.read();
        job = await this.persist({ ...job, termination: { ...job.termination!,
          authorityClosure: this.intent(reviewed.authorityTarget, "intake.closePublication", { form: draft }) } });
      }
      const intent = activeClosure(job)!, closure = await executeIntakeIntent(this.session.worker, intent);
      const result = IntakePublicationClosureV1.parse(closure.result);
      if (JSON.stringify(result.form) !== JSON.stringify(draft))
        throw new Error("Original authority closure differs; work was kept");
      const receipt = { requestId: intent.requestId, result, target: closure.target };
      if (job.termination!.closureReceipt && JSON.stringify(job.termination!.closureReceipt) !== JSON.stringify(receipt))
        throw new Error("Original closure receipt changed; all identities were kept");
      if (!job.termination!.closureReceipt) job = await this.persist({ ...job, termination: { ...job.termination!, closureReceipt: receipt } });
      // The authority tombstone, not the ledger claim or cancel snapshots, now
      // excludes every late save/publish ID, including those unknown to this tab.
    }
    if (job.publish || this.workflow.requiresAuthorityClosure()) {
      const draft = await recoverIntakeOwnerForm(job.source, job.formId, this.configuration.shellOrigin, this.configuration.relayBaseUrl, this.vault);
      const hydrated = await hydrateIntakeOwnerForm(draft, job.source, this.configuration.shellOrigin, this.vault);
      const relay = await terminalizeIntakeRelay(hydrated, this.configuration.relayBaseUrl, this.fetchImpl);
      if (job.termination!.relayTerminal && JSON.stringify(job.termination!.relayTerminal) !== JSON.stringify(relay))
        throw new Error("Original relay terminal proof changed; work was kept");
      if (!job.termination!.relayTerminal) job = await this.persist({ ...job, termination: { ...job.termination!, relayTerminal: relay } });
    }
    const current = await this.session.read(); const form = current.forms.find(row => row.publicForm.formId === job!.formId);
    if (form?.publishedAt !== null && form?.publishedAt !== undefined && form.revokedAt === null)
      throw new Error("Relay publication is closed. Review and revoke the committed local form, then finish closing this original publication.");
    job = await this.persist({ ...job, termination: { ...job.termination!, complete: true } });
    await this.workflow.finish();
  }
}
