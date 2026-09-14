import { z } from "zod";
import { TargetEvidenceV1, PresentationIntentV1, IntakeCommandPayloadV1 } from "./catalog";
import { IntakeFormId, IntakePublicationProposalV1, LocalIntakeFormV2, IntakeRelayTerminalResultV1, IntakePublicationClosureV1 } from "./intake";
import { RequestId } from "./index";
import { IntakeOwnerWitnessV1 } from "./owner-witness";

/** Public-only presentation cache. Not a worker command or a custody record. */
export const IntakePublicationJobV1 = z.object({ schema: z.literal(1), formId: IntakeFormId, source: TargetEvidenceV1,
  configuration: z.object({ shellOrigin: z.string(), publicBaseUrl: z.string(), relayBaseUrl: z.string() }).strict(), proposal: IntakePublicationProposalV1,
  save: PresentationIntentV1.nullable(), publish: PresentationIntentV1.nullable(), complete: LocalIntakeFormV2.nullable(),
  relayInvoked: z.boolean(), relayConfirmed: z.boolean(),
  termination: z.object({ requestedAt: z.string().datetime({ offset: true }), complete: z.boolean(),
    authorityClosure: PresentationIntentV1.optional(),
    renewals: z.array(z.object({ previousRequestId: RequestId, terminalStatus: z.enum(["cancelled", "failed"]),
      relay: IntakeRelayTerminalResultV1, intent: PresentationIntentV1 }).strict()).max(8).optional(),
    closureReceipt: z.object({ requestId: RequestId, result: IntakePublicationClosureV1, target: TargetEvidenceV1 }).strict().optional(),
    deletedOwner: IntakeOwnerWitnessV1.optional(),
    relayTerminal: IntakeRelayTerminalResultV1.optional() }).strict().optional(),
}).strict().superRefine((job, context) => {
    const invalid = () => context.addIssue({ code: "custom", message: "Retained intake publication identity or transition is inconsistent" });
    const identity = (target: { appInstanceId: string; activeGenerationId: string; lineageEpoch: string }) =>
      JSON.stringify([target.appInstanceId, target.activeGenerationId, target.lineageEpoch]);
    if ((job.publish !== null && job.save === null) || (job.relayInvoked && (!job.save || !job.publish))
        || (job.relayConfirmed && !job.relayInvoked) || (job.complete && !job.relayConfirmed)) invalid();
    let draft: LocalIntakeFormV2 | null = null;
    for (const [kind, intent] of [["save", job.save], ["publish", job.publish]] as const) {
      if (!intent) continue;
      const parsed = IntakeCommandPayloadV1.safeParse(intent.payload);
      if (!parsed.success || intent.appInstanceId !== job.source.appInstanceId || intent.slot !== "intake" || intent.route !== "intake.command") { invalid(); continue; }
      const payload = parsed.data;
      if (identity(payload.authorityTarget) !== identity(job.source)) invalid();
      if (kind === "save") {
        const parsedForm = LocalIntakeFormV2.safeParse(payload.command.payload.form);
        if (payload.command.route !== "intake.saveForm" || Object.keys(payload.command.payload).join() !== "form" || !parsedForm.success) { invalid(); continue; }
        draft = parsedForm.data;
        const proposal = IntakePublicationProposalV1.safeParse({ title: draft.publicForm.title, description: draft.publicForm.description,
          target: draft.publicForm.target, fields: draft.publicForm.fields, fileRequests: draft.publicForm.fileRequests, expiresAt: draft.publicForm.delivery.expiresAt });
        if (JSON.stringify(payload.authorityTarget) !== JSON.stringify(job.source)
            || draft.publicForm.formId !== job.formId || identity(draft.ownerSource) !== identity(job.source)
            || draft.relayBaseUrl !== job.configuration.relayBaseUrl || draft.publishedAt !== null || draft.revokedAt !== null || draft.terminalReason !== null
            || !proposal.success || JSON.stringify(proposal.data) !== JSON.stringify(job.proposal)) invalid();
      } else {
        const command = z.object({ formId: IntakeFormId, publishedAt: z.string().datetime({ offset: true }) }).strict().safeParse(payload.command.payload);
        if (payload.command.route !== "intake.markPublished" || !command.success || command.data.formId !== job.formId
            || new Date(command.data.publishedAt).toISOString() !== command.data.publishedAt || intent.requestId === job.save?.requestId) invalid();
      }
    }
    if (job.complete && (!draft || JSON.stringify(job.complete.publicForm) !== JSON.stringify(draft.publicForm)
        || identity(job.complete.ownerSource) !== identity(job.source) || job.complete.relayBaseUrl !== job.configuration.relayBaseUrl
        || job.complete.publishedAt !== (job.publish?.payload.command as { payload?: { publishedAt?: string } } | undefined)?.payload?.publishedAt
        || job.complete.revokedAt !== null || job.complete.terminalReason !== null)) invalid();
    const termination = job.termination;
    if (termination && (termination.renewals || termination.closureReceipt) && !termination.authorityClosure) invalid();
    const closures = [termination?.authorityClosure, ...(termination?.renewals ?? []).map(row => row.intent)].filter((intent): intent is PresentationIntentV1 => !!intent);
    const ids = new Set([job.save?.requestId, job.publish?.requestId].filter((id): id is string => !!id));
    let originalClosureForm: LocalIntakeFormV2 | null = null;
    for (const intent of closures) {
      const command = IntakeCommandPayloadV1.safeParse(intent.payload);
      const form = command.success ? LocalIntakeFormV2.safeParse(command.data.command.payload.form) : null;
      if (intent.slot !== "intake" || intent.route !== "intake.command" || intent.appInstanceId !== job.source.appInstanceId
          || !command.success || command.data.command.route !== "intake.closePublication"
          || !form?.success || identity(form.data.ownerSource) !== identity(job.source)
          || identity(command.data.authorityTarget) !== identity(job.source) || form.data.publicForm.formId !== job.formId
          || form.data.relayBaseUrl !== job.configuration.relayBaseUrl || (draft && JSON.stringify(form.data) !== JSON.stringify(draft))
          || Object.keys(command.data.command.payload).join() !== "form" || ids.has(intent.requestId)
          || (originalClosureForm && JSON.stringify(originalClosureForm) !== JSON.stringify(form.data))) invalid();
      if (form?.success) originalClosureForm ??= form.data;
      ids.add(intent.requestId);
    }
    const relayMatches = (relay: { formId: string; expiresAt: string }) => relay.formId === job.formId && relay.expiresAt === job.proposal.expiresAt;
    for (const [index, renewal] of (termination?.renewals ?? []).entries())
      if (renewal.previousRequestId !== closures[index]?.requestId || !relayMatches(renewal.relay)) invalid();
    if (termination?.closureReceipt && (termination.closureReceipt.requestId !== closures.at(-1)?.requestId
        || identity(termination.closureReceipt.target) !== identity(job.source)
        || JSON.stringify(termination.closureReceipt.result.form) !== JSON.stringify(originalClosureForm))) invalid();
    if (termination?.relayTerminal && !relayMatches(termination.relayTerminal)) invalid();
    if (termination?.deletedOwner) {
      const witness = termination.deletedOwner;
      if (witness.status !== "deleted" || !draft || witness.claim.requestId !== job.save?.requestId
          || JSON.stringify(witness.claim.source) !== JSON.stringify(job.source) || JSON.stringify(witness.claim.form) !== JSON.stringify(draft)
          || (termination.complete && !termination.relayTerminal)) invalid();
    }
  });
export type IntakePublicationJobV1 = z.infer<typeof IntakePublicationJobV1>;
export const IntakeRevocationJobV1 = z.object({ schema: z.literal(1), form: LocalIntakeFormV2,
  intent: PresentationIntentV1, relayConfirmed: z.boolean(),
  renewals: z.array(z.object({ previousRequestId: RequestId, terminalStatus: z.enum(["cancelled", "failed"]),
    relay: IntakeRelayTerminalResultV1, intent: PresentationIntentV1 }).strict()).max(8).optional(),
  terminalProof: z.object({ form: LocalIntakeFormV2, authorityTarget: TargetEvidenceV1, relay: IntakeRelayTerminalResultV1,
    invocation: z.object({ requestId: RequestId, status: z.enum(["recorded", "cancelled", "failed"]) }).strict() }).strict().optional(),
}).strict().superRefine((job, context) => {
    const command = IntakeCommandPayloadV1.safeParse(job.intent.payload);
    const invalid = () => context.addIssue({ code: "custom", message: "Original intake revocation identity is inconsistent" });
    if (!command.success) { invalid(); return; }
    const payload = z.object({ formId: IntakeFormId, revokedAt: z.string().datetime({ offset: true }) }).strict().safeParse(command.data.command.payload);
    const source = command.data.authorityTarget, owner = job.form.ownerSource;
    if (job.intent.slot !== "intake" || job.intent.route !== "intake.command" || job.intent.appInstanceId !== owner.appInstanceId
        || source.appInstanceId !== owner.appInstanceId || source.activeGenerationId !== owner.activeGenerationId || source.lineageEpoch !== owner.lineageEpoch
        || command.data.command.route !== "intake.revokeForm" || !payload.success || payload.data.formId !== job.form.publicForm.formId) invalid();
    let previousRequestId = job.intent.requestId; const identities = new Set([previousRequestId]);
    for (const renewal of job.renewals ?? []) {
      const next = IntakeCommandPayloadV1.safeParse(renewal.intent.payload);
      if (!next.success) { invalid(); continue; }
      const nextPayload = z.object({ formId: IntakeFormId, revokedAt: z.string().datetime({ offset: true }) }).strict().safeParse(next.data.command.payload);
      if (renewal.previousRequestId !== previousRequestId || identities.has(renewal.intent.requestId)
          || renewal.relay.formId !== job.form.publicForm.formId || renewal.relay.expiresAt !== job.form.publicForm.delivery.expiresAt
          || renewal.intent.appInstanceId !== owner.appInstanceId || renewal.intent.slot !== "intake" || renewal.intent.route !== "intake.command"
          || next.data.command.route !== "intake.revokeForm" || !nextPayload.success || nextPayload.data.formId !== job.form.publicForm.formId
          || next.data.authorityTarget.appInstanceId !== owner.appInstanceId || next.data.authorityTarget.activeGenerationId !== owner.activeGenerationId
          || next.data.authorityTarget.lineageEpoch !== owner.lineageEpoch) invalid();
      previousRequestId = renewal.intent.requestId; identities.add(previousRequestId);
    }
    const proof = job.terminalProof;
    if (proof) {
      const definition = (form: LocalIntakeFormV2) => JSON.stringify([form.ownerSource, form.publicForm, form.relayBaseUrl]);
      if (!job.relayConfirmed || proof.invocation.requestId !== previousRequestId || definition(proof.form) !== definition(job.form)
          || proof.form.publishedAt === null || proof.form.revokedAt === null
          || proof.authorityTarget.appInstanceId !== owner.appInstanceId || proof.authorityTarget.activeGenerationId !== owner.activeGenerationId
          || proof.authorityTarget.lineageEpoch !== owner.lineageEpoch || proof.relay.formId !== job.form.publicForm.formId
          || proof.relay.expiresAt !== job.form.publicForm.delivery.expiresAt) invalid();
    }
  });
export type IntakeRevocationJobV1 = z.infer<typeof IntakeRevocationJobV1>;
