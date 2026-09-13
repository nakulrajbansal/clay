import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { ClayStore, deriveInverse, openMemoryDriver, type ForwardOpT } from "../../kernel/src/index";
import { ProductionStoreAuthority } from "../../kernel/src/production-authority";
import { StateMerkleIndex } from "../../kernel/src/state-merkle-index";
import { TargetAuthorityStore } from "../../kernel/src/target-authority";
import { WorkerClient } from "../src/app/worker-client";
import { IntakeSession } from "../src/intake/session";
import { IntakePublication } from "../src/intake/publication";
import { IntakeOwnerClient } from "../src/intake/owner-client";
import { encryptIntakeSubmission } from "../src/intake/crypto";
import type { IntakeOwnerCustody, IntakeOwnerVault } from "../src/intake/owner-custody";
import type { IntakeSubmissionPlaintextV1 } from "@clay/schema/intake";
import { approveShareScopeV1, encryptApprovedShareV1 } from "../src/share/crypto";
import { ShareOwnerSession } from "../src/share/owner-custody";
import { IndexedDbShareOwnerVault } from "../src/share/owner-custody.browser";
import { OwnedFactory } from "./helpers/owned-idb";
import { BrowserShareRelayClient } from "../src/share/relay-client";
import { ownedRelayApp } from "../../backend/test/helpers/owned-relay-app";
import { IndexedDbIntakeWorkflows } from "../src/intake/workflows";

it("executes custody publication, delivery loss, partial attachments, review/Undo, auto-accept and revoke through WorkerClient/db-worker and reopens exact durable metadata", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-13T12:00:00.000Z"));
  const driver = await openMemoryDriver(); const catalogFile = `/owned-intake-${crypto.randomUUID()}.db`;
  driver.exec(`ATTACH DATABASE '${catalogFile}' AS catalog`);
  const store = ClayStore.fromDriver(driver);
  const operations: ForwardOpT[] = [{ op: "create_table", table: "requests", columns: [
    { name: "name", type: "text", required: true }, { name: "files", type: "attachment", required: false }] }];
  store.commit({ intent: "Owned intake fixture", summary: "Owned table", migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) } });
  const table = store.validationRegistrySnapshot().get("requests")!;
  const id = (prefix: string, char: string) => `${prefix}_${char.repeat(26)}`;
  const inventory = { state: "complete" as const, catalogPresent: false, namespaces: [{ storageKey: "default", userFile: "/user.db", systemFile: "/system.db", kind: "legacy" as const }] };
  let authority = ProductionStoreAuthority.adoptLegacy(driver, { inventory, storageKey: "default", displayName: "Owned intake", shellId: "blank",
    appInstanceId: id("app", "a"), generationId: id("gen", "b"), namespaceId: id("ns", "c"), adoptionOperationId: id("op", "d"), releaseId: id("rel", "e"), nowMs: Date.now(), leaseTtlMs: 60_000 });
  vi.spyOn(ProductionStoreAuthority, "bootBrowser").mockImplementation(async () => authority);
  let drop = false, dropped = false; const sent: Array<{ id: number; op: string; requestId?: string; payload?: unknown }> = [];
  const scope = { onmessage: null as ((event: MessageEvent) => void) | null, postMessage: (data: { id: number; ok: boolean }) => {
    if (drop && data.ok && sent.slice().reverse().find(row => row.id === data.id)?.op === "intakeCommand") { drop = false; dropped = true; return; }
    queueMicrotask(() => transport.onmessage?.({ data: structuredClone(data) } as MessageEvent));
  } };
  let holdRevoke = false; let heldRevoke: unknown = null;
  let holdClosure = false; let heldClosure: unknown = null;
  const transport = { onmessage: null as ((event: MessageEvent) => void) | null, postMessage: (data: { id: number; op: string; payload?: any }) => {
    sent.push(structuredClone(data));
    if (holdRevoke && data.op === "intakeCommand" && data.payload?.command?.route === "intake.revokeForm") {
      holdRevoke = false; heldRevoke = structuredClone(data); return;
    }
    if (holdClosure && data.op === "intakeCommand" && data.payload?.command?.route === "intake.closePublication") {
      holdClosure = false; heldClosure = structuredClone(data); return;
    }
    queueMicrotask(() => scope.onmessage?.({ data: structuredClone(data) } as MessageEvent));
  }, terminate: () => {} };
  vi.stubGlobal("self", scope); let client = new WorkerClient(transport as unknown as Worker);
  const rows = new Map<string, string>(); const cache = { getItem: (key: string) => rows.get(key) ?? null, setItem: (key: string, value: string) => { rows.set(key, value); }, removeItem: (key: string) => { rows.delete(key); } };
  const owners = new Map<string, IntakeOwnerCustody>(); const vault: IntakeOwnerVault = { read: async key => owners.get(key) ?? null, insert: async record => { owners.set(record.key, structuredClone(record)); } };
  const config = { shellOrigin: "https://app.example.test", publicBaseUrl: "https://app.example.test", relayBaseUrl: "https://relay.example.test/" };
  const workflowFactory = new OwnedFactory(), workflows = new IndexedDbIntakeWorkflows(workflowFactory as unknown as IDBFactory);
  let registrationLost = true, deleteLost = false, revocationLost = false;
  const deliveries = new Map<string, any>(); const registered = new Map<string, string>(); let deleted = 0;
  const fetchImpl = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (String(url).endsWith("/terminalize")) {
      if (revocationLost) { revocationLost = false; throw new Error("Owned revocation response loss"); }
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ schema: 1, formId: body.formId, expiresAt: body.expiresAt,
        requestSha256: createHash("sha256").update(JSON.stringify(body)).digest("hex"), terminal: true }));
    }
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)); const previous = registered.get(body.formId);
      if (previous) expect(previous === String(init.body)).toBe(true); registered.set(body.formId, String(init.body));
      if (registrationLost) { registrationLost = false; throw new Error("Owned publication response loss"); } return new Response(JSON.stringify({ formId: body.formId, expiresAt: body.expiresAt }), { status: 201 });
    }
    const path = new URL(String(url)).pathname;
    if (init?.method === "DELETE") {
      if (!path.includes("/submissions/")) {
        if (revocationLost) { revocationLost = false; throw new Error("Owned revocation response loss"); }
        return new Response(null, { status: 410 });
      }
      const submissionId = path.split("/").at(-1)!;
      expect(authority.readStore().intakeInbox().some(item => item.submissionId === submissionId)).toBe(true);
      if (deleteLost) { deleteLost = false; throw new Error("Owned delivery acknowledgement loss"); }
      deliveries.delete(submissionId); deleted++; return new Response(null, { status: 204 });
    }
    const formId = path.split("/")[3];
    return new Response(JSON.stringify({ items: [...deliveries.values()].filter(item => item.formId === formId), hasMore: false }), { status: 200 });
  };
  const openSession = async () => { const session = new IntakeSession(cache, client, id("app", "a")); await session.read(); return session; };
  const fieldId = table.columns.find(row => row.name === "name")!.semantic!.fieldId;
  const fileFieldId = table.columns.find(row => row.name === "files")!.semantic!.fieldId;
  const proposal = { title: "Owned requests", description: "", expiresAt: "2026-10-01T00:00:00.000Z", target: { tableId: table.semantic!.tableId, expectedSchemaVersion: store.currentVersion() },
    fields: [{ fieldId, label: "Name", type: "text" as const, required: true, maxLength: 100, options: [] }],
    fileRequests: [{ requestId: "document", fieldId: fileFieldId, label: "File", required: false, maxFiles: 2, maxBytes: 1000, allowedMimeTypes: ["text/plain" as const] }] };
  try {
    await import("../src/worker/db-worker"); await client.boot({ requestedAppId: null, appCache: [] });
    let session = await openSession(); let publication = new IntakePublication(session, vault, config, fetchImpl, workflows);
    await publication.recover(); await publication.begin(proposal); const formId = publication.pending()!.formId;
    await expect(publication.resume()).rejects.toThrow(/uncertain/);
    expect((await client.intakePresentation()).forms).toHaveLength(1);
    rows.clear(); // Owned presentation cache loss; durable workflow/custody survives.
    publication = new IntakePublication(await openSession(), vault, config, fetchImpl, workflows);
    drop = true;
    const lost = publication.resume().catch(error => error);
    await vi.waitFor(() => expect(dropped).toBe(true)); client = new WorkerClient(transport as unknown as Worker);
    expect(await lost).toMatchObject({ message: expect.stringContaining("outcome is unknown") });
    await client.boot({ requestedAppId: null, appCache: [] }); session = await openSession();
    publication = new IntakePublication(session, vault, config, fetchImpl, workflows);
    const published = await publication.resume(); await publication.finish(); expect(published.localForm.publicForm.formId).toBe(formId);
    let owner = new IntakeOwnerClient(session, vault, config, fetchImpl, workflows);
    const hydrated = await owner.hydrate(published.localForm);
    const bytes = new TextEncoder().encode("Owned passive file");
    const file = { requestId: "document", uploadId: id("upl", "g"), name: "owned.txt", mime: "text/plain" as const, size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"), bytes: Buffer.from(bytes).toString("base64url") };
    const submission: IntakeSubmissionPlaintextV1 = { schema: 1, formId, formRevision: 1, submissionId: id("sub", "h"), submittedAt: new Date().toISOString(), values: [{ fieldId, value: "Owned answer" }],
      files: [file, { ...file, uploadId: id("upl", "i"), sha256: "0".repeat(64) }] };
    const enqueue = async (body: IntakeSubmissionPlaintextV1, form = hydrated.publicForm) => {
      const encrypted = await encryptIntakeSubmission(form, body);
      deliveries.set(body.submissionId, { schema: 1, formId: body.formId, submissionId: body.submissionId, receivedAt: new Date().toISOString(), expiresAt: proposal.expiresAt, ciphertextBytes: 1000, envelope: encrypted.envelope });
    };
    await enqueue(submission); deleteLost = true;
    await expect(owner.fetch(published.localForm)).rejects.toThrow(/acknowledgement/);
    expect((await client.intakePresentation()).inbox).toMatchObject([{ files: [{ status: "quarantined" }, { status: "rejected" }] }]);
    owner = new IntakeOwnerClient(await openSession(), vault, config, fetchImpl, workflows); await owner.fetch(published.localForm);
    expect(deleted).toBe(1); expect((await client.intakePresentation()).inbox).toHaveLength(1);
    session = await openSession();
    expect(session.reviewed!.inbox[0]!.status).toBe("blocked");
    await expect(session.acceptIntakeSubmission(submission.submissionId, [file.uploadId])).rejects.toThrow(/validated/);
    expect(await session.cancel()).toBe(true);
    await session.read(); await session.rejectIntakeSubmission(submission.submissionId);
    const validId = id("sub", "l"); await enqueue({ ...submission, submissionId: validId, files: [file] });
    owner = new IntakeOwnerClient(session, vault, config, fetchImpl, workflows); await owner.fetch(published.localForm);
    const receipt = await session.acceptIntakeSubmission(validId, [file.uploadId]);
    expect(authority.query({ from: "requests" })).toHaveLength(1); expect(receipt.attachmentIds).toHaveLength(1);
    // The real worker's source-bound projection and attachment reads feed only
    // the trusted shell encryption/custody/relay path, never a panel or DB key.
    const shareSource = await client.presentationSource();
    const shareRequest = { schema: 1 as const, kind: "record" as const, expectedSchemaVersion: proposal.target.expectedSchemaVersion, tableId: table.semantic!.tableId,
      fieldIds: [fieldId], recordId: receipt.rowId, options: { includeRecordIds: false, redactedFieldIds: [] } };
    const artifact = await client.projectExport(shareRequest);
    const attached = await client.readAttachment(receipt.attachmentIds[0]!);
    const sharedFile = { ...attached, source: { tableId: table.semantic!.tableId, fieldId: fileFieldId, recordId: receipt.rowId } };
    const approval = await approveShareScopeV1(shareRequest, [sharedFile], artifact, new Date());
    const encryptedShare = await encryptApprovedShareV1({ approval, request: shareRequest, artifact, attachments: [sharedFile], expiresAt: "2026-09-20T12:00:00.000Z" });
    const shareApp = ownedRelayApp({ now: () => Date.now() });
    const shareRelay = new BrowserShareRelayClient("https://relay.example.test", null, async (url, init) => shareApp.request(String(url), init));
    const shareFactory = new OwnedFactory(); const shareVault = new IndexedDbShareOwnerVault(shareFactory as unknown as IDBFactory);
    const shareOwner = new ShareOwnerSession(shareVault, shareRelay, config.shellOrigin, config.publicBaseUrl, () => client.presentationSource());
    const shareRecord = await shareOwner.prepare({ encrypted: encryptedShare, source: shareSource, approval, title: "Owned reviewed request" });
    expect((await shareOwner.publish(shareRecord.request.shareId)).state).toBe("published");
    expect((await shareRelay.read(shareRecord.request.shareId)).shareId).toBe(shareRecord.request.shareId);
    expect((await shareOwner.revoke(shareRecord.request.shareId)).state).toBe("revoked");
    await expect(shareRelay.read(shareRecord.request.shareId)).rejects.toMatchObject({ status: 410 });
    await session.undoIntakeReceipt(receipt.id); expect(authority.query({ from: "requests" })).toHaveLength(0);
    await enqueue({ ...submission, submissionId: id("sub", "j"), files: [] });
    owner = new IntakeOwnerClient(await openSession(), vault, config, fetchImpl, workflows); await owner.fetch(published.localForm);
    session = await openSession(); await session.rejectIntakeSubmission(id("sub", "j"));
    expect(session.reviewed!.inbox.find(row => row.submissionId === id("sub", "j"))?.status).toBe("rejected");
    publication = new IntakePublication(session, vault, config, fetchImpl, workflows); await publication.recover(); await publication.begin({ ...proposal, title: "Owned auto form", fileRequests: [] });
    const automatic = await publication.resume(); await publication.finish();
    owner = new IntakeOwnerClient(session, vault, config, fetchImpl, workflows); const autoHydrated = await owner.hydrate(automatic.localForm);
    await enqueue({ ...submission, formId: automatic.localForm.publicForm.formId, submissionId: id("sub", "k"), files: [] }, autoHydrated.publicForm);
    await owner.fetch(automatic.localForm);
    const draft = { schema: 1 as const, formId: automatic.localForm.publicForm.formId, formRevision: 1, expectedSchemaVersion: proposal.target.expectedSchemaVersion,
      conditions: [{ fieldId, op: "is_present" as const, value: null }] };
    const simulation = await session.simulateIntakeAutoAccept(draft); expect(simulation.matchedSubmissionIds).toEqual([id("sub", "k")]);
    await session.enableIntakeAutoAccept(draft, simulation.fingerprint); expect(session.reviewed!.rules).toHaveLength(1);
    const accepted = await session.processIntakeAutoAccept(draft.formId); expect(accepted).toHaveLength(1);
    expect(await session.processIntakeAutoAccept(draft.formId)).toEqual([]);
    await session.undoIntakeReceipt(accepted[0]!.id); await session.disableIntakeAutoAccept(draft.formId);
    holdRevoke = true;
    const delayedRevokeResult = owner.revoke(automatic.localForm).then(() => "unexpectedly revoked", () => "cancelled original");
    await vi.waitFor(() => expect(heldRevoke !== null).toBe(true));
    const originalRevoke = owner.pendingRevocation()!.intent;
    // A separate source-bound worker request wins while the old message is held.
    await client.intakeCommand({ authorityTarget: (await client.intakePresentation()).authorityTarget, command: { route: "intake.recordDeliveryFailure", payload: {
      failure: { formId: automatic.localForm.publicForm.formId, submissionId: id("sub", "v"), envelopeSha256: "7".repeat(64), failedAt: new Date().toISOString() } } } }, client.createMutationContext());
    workflowFactory.rows.delete(JSON.stringify([1, config.shellOrigin, id("app", "a"), "revocation"])); // Owned cache-only old-client original, not a new fence.
    owner = new IntakeOwnerClient(await openSession(), vault, config, fetchImpl, workflows);
    await expect(owner.recover()).rejects.toThrow(/unfenced/);
    await owner.adoptLegacyRevocation((await client.intakePresentation()).authorityTarget);
    rows.clear(); owner = new IntakeOwnerClient(await openSession(), vault, config, fetchImpl, workflows);
    await owner.renewRevocation((await client.intakePresentation()).authorityTarget);
    expect(owner.pendingRevocation()?.intent).toEqual(originalRevoke);
    scope.onmessage!({ data: heldRevoke } as MessageEvent); expect(await delayedRevokeResult).toBe("cancelled original");
    revocationLost = true; await expect(owner.revoke()).rejects.toThrow(/unconfirmed/);
    rows.clear(); // Reopen from the original durable revoke invocation, not a fresh ID.
    owner = new IntakeOwnerClient(await openSession(), vault, config, fetchImpl, workflows); await owner.revoke(); expect(owner.pendingRevocation()).toBeNull();
    const terminalRecord = workflowFactory.rows.get(JSON.stringify([1, config.shellOrigin, id("app", "a"), "revocation"])) as any;
    expect(terminalRecord.legacyOriginal.intent).toEqual(originalRevoke); expect(terminalRecord.closed).toBe(true);
    expect(terminalRecord.job.terminalProof.relay.terminal).toBe(true);
    // A retained publication becomes stale after an unrelated original form's
    // expiry write. Close its exact worker invocation before a delayed message.
    publication = new IntakePublication(await openSession(), vault, config, fetchImpl, workflows);
    await publication.recover(); await publication.begin({ ...proposal, title: "Owned interrupted publication" });
    registrationLost = true; await expect(publication.resume()).rejects.toThrow(/uncertain/);
    const legacyPublication = publication.pending()!, delayedPublish = legacyPublication.publish!;
    workflowFactory.rows.delete(JSON.stringify([1, config.shellOrigin, id("app", "a"), "publication"])); // Owned synthetic old-client slot absence.
    vi.setSystemTime(new Date("2026-10-02T00:00:00.000Z"));
    owner = new IntakeOwnerClient(await openSession(), vault, config, fetchImpl, workflows); await owner.fetch(published.localForm);
    publication = new IntakePublication(await openSession(), vault, config, fetchImpl, workflows);
    holdClosure = true;
    const delayedClosureResult = publication.terminalizeLegacy().then(() => "unexpectedly closed", () => "cancelled original");
    await vi.waitFor(() => expect(heldClosure !== null).toBe(true));
    const originalClosure = publication.pending()!.termination!.authorityClosure!;
    await client.intakeCommand({ authorityTarget: (await client.intakePresentation()).authorityTarget, command: { route: "intake.recordDeliveryFailure", payload: {
      failure: { formId: legacyPublication.formId, submissionId: id("sub", "w"), envelopeSha256: "8".repeat(64), failedAt: new Date().toISOString() } } } }, client.createMutationContext());
    rows.clear(); publication = new IntakePublication(await openSession(), vault, config, fetchImpl, workflows);
    await publication.renewClosure((await client.intakePresentation()).authorityTarget, originalClosure.requestId);
    const renewedClosure = publication.pending()!.termination!.renewals![0]!.intent;
    expect(renewedClosure.requestId).not.toBe(originalClosure.requestId);
    expect(publication.pending()!.termination!.authorityClosure).toEqual(originalClosure);
    scope.onmessage!({ data: heldClosure } as MessageEvent);
    expect(await delayedClosureResult).toBe("cancelled original");
    rows.clear(); publication = new IntakePublication(await openSession(), vault, config, fetchImpl, workflows);
    await publication.terminalize(); expect(publication.pending()).toBeNull();
    const closureRecord = workflowFactory.rows.get(JSON.stringify([1, config.shellOrigin, id("app", "a"), "publication"])) as any;
    expect(closureRecord.job.termination.authorityClosure).toEqual(originalClosure);
    expect(closureRecord.job.termination.closureReceipt.requestId).toBe(renewedClosure.requestId);
    expect(closureRecord.job.termination.relayTerminal.terminal).toBe(true);
    await expect(client.intakeCommand(delayedPublish.payload as never, { requestId: delayedPublish.requestId })).rejects.toThrow();
    expect((await client.mutationOutcome(delayedPublish.route, delayedPublish.payload, { requestId: delayedPublish.requestId })).status).toBe("cancelled");
    await expect(client.intakeCommand({ authorityTarget: (await client.intakePresentation()).authorityTarget,
      command: { route: "intake.markPublished", payload: { formId: legacyPublication.formId, publishedAt: new Date().toISOString() } } }, client.createMutationContext())).rejects.toThrow(/closed/);
    expect((await client.intakePresentation()).forms.filter(form => form.publishedAt).every(form => form.revokedAt !== null)).toBe(true);
    expect(JSON.stringify(sent).match(/ownerPrivateKey|ownerToken|submitToken/)).toBeNull();
    // Reopen a byte-equivalent owned SQLite target with the same durable catalog.
    const copy = await driver.snapshot(); StateMerkleIndex.createSchema(copy); TargetAuthorityStore.createSchema(copy);
    for (const name of ["state_digest_leaves", "state_digest_buckets", "state_digest_root", "target_authority_header", "target_revision_reservations", "production_request_receipts"]) {
      for (const row of driver.select(`SELECT * FROM sys.${name}`)) {
        const keys = Object.keys(row); copy.exec(`INSERT INTO sys.${name}(${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`, keys.map(key => row[key]!));
      }
    }
    copy.exec(`ATTACH DATABASE '${catalogFile}' AS catalog`);
    await client.shutdown(); authority = ProductionStoreAuthority.openExisting(copy, { inventory: { ...inventory, catalogPresent: true }, storageKey: "default", releaseId: id("rel", "f"), nowMs: Date.now(), leaseTtlMs: 60_000 });
    const module = "../src/worker/db-worker.ts"; await import(`${module}?intake-reload`); client = new WorkerClient(transport as unknown as Worker);
    await client.boot({ requestedAppId: null, appCache: [] }); const reopened = await client.intakePresentation();
    expect(reopened.forms).toHaveLength(3); expect(reopened.receipts).toHaveLength(2); expect(reopened.receipts.every(row => row.undone)).toBe(true);
    expect(authority.query({ from: "requests" })).toHaveLength(0);
    const revoked = reopened.forms.find(form => form.publicForm.formId === terminalRecord.job.form.publicForm.formId)!;
    await client.intakeCommand({ authorityTarget: reopened.authorityTarget, command: { route: "intake.revokeForm",
      payload: { formId: revoked.publicForm.formId, revokedAt: new Date(Date.now() + 1000).toISOString() } } }, client.createMutationContext());
    expect((await client.intakePresentation()).forms.find(form => form.publicForm.formId === revoked.publicForm.formId)).toEqual(revoked);
    await expect(client.intakeCommand({ authorityTarget: (await client.intakePresentation()).authorityTarget,
      command: { route: "intake.saveForm", payload: { form: legacyPublication.save!.payload.command && (legacyPublication.save!.payload.command as any).payload.form } } }, client.createMutationContext())).rejects.toThrow(/closed/);
    expect((await authority.collectArchiveSnapshot()).target).toEqual((await client.intakePresentation()).authorityTarget);
  } finally { await client.shutdown().catch(() => {}); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); }
}, 90_000);
