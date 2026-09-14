import { LocalIntakeFormV1 } from "@clay/schema/intake";
import { LegacyOwnerCandidateV1, LegacyOwnerProofV1 } from "@clay/schema/legacy-owner";
import { decodeProductionResponse } from "@clay/kernel/production-response-envelope";
import type { IntakeOwnerVault } from "../intake/owner-custody";
import { hydrateIntakeOwnerForm, validateIntakeOwnerCustody } from "../intake/owner-custody";
import { closed, legacyOwnerFailure, ownerDigest, ownerOrigin, portMessage } from "./owner-protocol";
import type { WorkerClient } from "../app/worker-client";
import { IndexedDbIntakeOwnerVault } from "../intake/owner-custody.browser";
import type { PresentationIntent } from "../app/presentation-intent";
import { PresentationIntentV1, IntakeCommandPayloadV1 } from "@clay/schema/catalog";

export type LegacyOwnerRecord = { schema: 1; key: string; shellOrigin: string; proof: LegacyOwnerProofV1;
  bytes: Uint8Array<ArrayBuffer>; custodyCommitted: boolean; actions: Array<{ intent: PresentationIntent; outcome: "pending" | "applied" | "cancelled" }> };
export interface LegacyOwnerVault {
  read(key: string): Promise<LegacyOwnerRecord | null>;
  list(): Promise<LegacyOwnerRecord[]>;
  insert(record: LegacyOwnerRecord): Promise<void>;
  compareAndSet(before: LegacyOwnerRecord, after: LegacyOwnerRecord): Promise<void>;
}
export function legacyOwnerKey(origin: string, proof: LegacyOwnerProofV1): string {
  return JSON.stringify([1, ownerOrigin(origin), proof.authorityIncarnationId, proof.source.appInstanceId, proof.source.activeGenerationId,
    proof.source.lineageEpoch, proof.receipt.requestId, proof.receipt.responseSha256]);
}
function identity(record: LegacyOwnerRecord) { return JSON.stringify({ schema: 1, key: record.key, shellOrigin: record.shellOrigin, proof: { ...record.proof, activation: null } }); }
export async function validateLegacyOwnerRecord(input: unknown): Promise<LegacyOwnerRecord> {
  try {
    if (!closed(input, ["schema", "key", "shellOrigin", "proof", "bytes", "actions", "custodyCommitted"]) || input.schema !== 1 || typeof input.shellOrigin !== "string" || typeof input.custodyCommitted !== "boolean"
        || !(input.bytes instanceof Uint8Array) || input.bytes.byteLength < 1 || input.bytes.byteLength > 2_000_000
        || !Array.isArray(input.actions) || input.actions.length > 8) throw legacyOwnerFailure();
    const proof = LegacyOwnerProofV1.parse(input.proof);
    if (input.key !== legacyOwnerKey(input.shellOrigin, proof) || await ownerDigest(input.bytes as Uint8Array<ArrayBuffer>) !== proof.receipt.responseSha256) throw legacyOwnerFailure();
    if (new TextEncoder().encode(JSON.stringify(input.actions)).byteLength > 2_000_000) throw legacyOwnerFailure();
    const ids = new Set<string>();
    for (const [index, action] of input.actions.entries()) {
      if (!closed(action, ["intent", "outcome"]) || !["pending", "applied", "cancelled"].includes(String(action.outcome))) throw legacyOwnerFailure();
      // The existing closed intent parser is also used at execution; no private
      // response is ever embedded in the retained public mutation invocation.
      const intent = PresentationIntentV1.parse(action.intent), payload = IntakeCommandPayloadV1.parse(intent.payload);
      if (intent.route !== "intake.command" || intent.slot !== "intake" || intent.appInstanceId !== proof.source.appInstanceId
          || payload.authorityTarget.appInstanceId !== proof.source.appInstanceId || payload.authorityTarget.activeGenerationId !== proof.source.activeGenerationId
          || payload.authorityTarget.lineageEpoch !== proof.source.lineageEpoch || payload.command.route !== "intake.saveForm"
          || JSON.stringify(payload.command.payload.form) !== JSON.stringify(proof.form) || ids.has(intent.requestId)
          || (index < input.actions.length - 1 && action.outcome !== "cancelled")) throw legacyOwnerFailure();
      ids.add(intent.requestId);
    }
    if (!input.custodyCommitted && input.actions.length) throw legacyOwnerFailure();
    return structuredClone({ schema: 1, key: input.key, shellOrigin: input.shellOrigin, proof, bytes: input.bytes, actions: input.actions, custodyCommitted: input.custodyCommitted }) as LegacyOwnerRecord;
  } catch { throw legacyOwnerFailure(); }
}

export async function receiveLegacyOwner(port: MessagePort, originInput: string, archive: LegacyOwnerVault, owners: IntakeOwnerVault): Promise<LegacyOwnerProofV1> {
  let bytes: Uint8Array<ArrayBuffer> | undefined;
  try {
    const origin = ownerOrigin(originInput), nonce = crypto.randomUUID();
    const pair = await crypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, false, ["encrypt", "decrypt", "wrapKey", "unwrapKey"]);
    const waiting = portMessage(port); port.postMessage({ schema: 1, origin, nonce, publicKey: pair.publicKey });
    const message = await waiting;
    if (!closed(message, ["schema", "nonce", "proof", "iv", "ciphertext", "wrapped"]) || message.schema !== 1 || message.nonce !== nonce
        || !(message.iv instanceof ArrayBuffer) || message.iv.byteLength !== 12 || !(message.wrapped instanceof ArrayBuffer) || message.wrapped.byteLength !== 256
        || !(message.ciphertext instanceof ArrayBuffer) || message.ciphertext.byteLength > 2_000_016 || message.ciphertext.byteLength < 17) throw legacyOwnerFailure();
    const proof = LegacyOwnerProofV1.parse(message.proof);
    const aes = await crypto.subtle.unwrapKey("raw", message.wrapped, pair.privateKey, { name: "RSA-OAEP" }, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    const aad = new TextEncoder().encode(JSON.stringify({ schema: 1, nonce, origin, proof }));
    bytes = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: message.iv, additionalData: aad }, aes, message.ciphertext));
    if (await ownerDigest(bytes) !== proof.receipt.responseSha256) throw legacyOwnerFailure();
    const key = legacyOwnerKey(origin, proof), record: LegacyOwnerRecord = { schema: 1, key, shellOrigin: origin, proof, bytes, actions: [], custodyCommitted: false };
    const existing = await archive.read(key);
    if (existing && identity(await validateLegacyOwnerRecord(existing)) !== identity(record)) throw legacyOwnerFailure();
    if (!existing) await archive.insert(record);
    const saved = await archive.read(key);
    if (!saved || identity(await validateLegacyOwnerRecord(saved)) !== identity(record)) throw legacyOwnerFailure();
    if (proof.kind === "intake_private") {
      const response = decodeProductionResponse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      const old = LocalIntakeFormV1.parse(response.result);
      const custody = validateIntakeOwnerCustody({ schema: 1, key: JSON.stringify([1, origin, proof.source.appInstanceId, proof.source.activeGenerationId,
        proof.source.lineageEpoch, new URL(proof.form.relayBaseUrl).origin, proof.form.publicForm.formId]), shellOrigin: origin, form: proof.form,
        ownerPrivateKey: old.ownerPrivateKey, ownerToken: old.ownerToken, submitToken: old.publicForm.delivery.submitToken });
      // Verify historical key possession even when that definition can no longer
      // activate. Exact sealed history, not a replacement active owner record,
      // is the custody destination for superseded private responses.
      await hydrateIntakeOwnerForm(proof.form, proof.source, origin, { read: async () => custody, insert: async () => { throw legacyOwnerFailure(); } });
      if (proof.activation === "original_metadata") {
        const prior = await owners.read(custody.key);
        if (!prior) await owners.insert(custody);
        const readback = validateIntakeOwnerCustody(await owners.read(custody.key));
        if (readback.ownerPrivateKey !== custody.ownerPrivateKey || readback.ownerToken !== custody.ownerToken || readback.submitToken !== custody.submitToken) throw legacyOwnerFailure();
        await hydrateIntakeOwnerForm(proof.form, proof.source, origin, owners);
      }
    }
    // Public history is preserved as public history, never used to mint keys.
    if (!saved.custodyCommitted) await archive.compareAndSet(saved, { ...saved, custodyCommitted: true });
    const completed = await archive.read(key); if (!completed?.custodyCommitted || identity(completed) !== identity(saved)) throw legacyOwnerFailure();
    port.postMessage({ schema: 1, nonce, responseSha256: proof.receipt.responseSha256, committed: true });
    return proof;
  } catch { try { port.postMessage({ failed: true }); } catch { /* static error only */ } throw legacyOwnerFailure(); }
  finally { bytes?.fill(0); }
}

/** Public projection only; callers never receive the private archive record. */
export async function legacyOwnerSummaries(archive: LegacyOwnerVault, origin: string) {
  return (await archive.list()).filter(row => row.shellOrigin === ownerOrigin(origin)).map(row => ({ key: row.key, proof: row.proof,
    custodyCommitted: row.custodyCommitted, outcome: row.actions.at(-1)?.outcome ?? null }));
}

export async function activateLegacyOwner(worker: WorkerClient, key: string, reviewed: import("@clay/schema/catalog").TargetEvidenceV1,
  origin: string, archive: LegacyOwnerVault, owners: IntakeOwnerVault = new IndexedDbIntakeOwnerVault()) {
  let row = await archive.read(key); if (!row || row.shellOrigin !== ownerOrigin(origin) || !row.custodyCommitted) throw legacyOwnerFailure();
  const { schema, authorityIncarnationId, route, source, receipt } = row.proof;
  await hydrateIntakeOwnerForm(row.proof.form, row.proof.source, origin, owners);
  let action = row.actions.at(-1);
  if (!action || action.outcome === "cancelled") {
    // New/renewed requests need fresh original-definition proof. A retained
    // invocation instead reconciles its exact durable result even if later
    // presentation state changed; it is never rebased to this reviewed target.
    const proof = await adoptLegacyOwner(worker, { schema, authorityIncarnationId, route, source, receipt }, origin, archive, owners);
    if (proof.activation !== "original_metadata" || row.actions.length >= 8 || JSON.stringify(await worker.presentationSource()) !== JSON.stringify(reviewed)
        || reviewed.appInstanceId !== source.appInstanceId || reviewed.activeGenerationId !== source.activeGenerationId || reviewed.lineageEpoch !== source.lineageEpoch) throw legacyOwnerFailure();
    const intent = PresentationIntentV1.parse({ schema: 1, appInstanceId: source.appInstanceId, slot: "intake", route: "intake.command", requestId: worker.createMutationContext().requestId,
      payload: { authorityTarget: reviewed, command: { route: "intake.saveForm", payload: { form: row.proof.form } } } });
    action = { intent, outcome: "pending" }; const after = { ...row, actions: [...row.actions, action] };
    await archive.compareAndSet(row, after); row = await archive.read(key);
    if (!row || JSON.stringify(row.actions) !== JSON.stringify(after.actions)) throw legacyOwnerFailure();
  }
  const { executeIntakeIntent } = await import("../intake/session");
  const result = await executeIntakeIntent(worker, action.intent);
  if (action.outcome !== "applied") {
    await archive.compareAndSet(row, { ...row, actions: [...row.actions.slice(0, -1), { ...action, outcome: "applied" }] });
    if ((await archive.read(key))?.actions.at(-1)?.outcome !== "applied") throw legacyOwnerFailure();
  }
  return result;
}

export async function cancelLegacyActivation(worker: WorkerClient, key: string, origin: string, archive: LegacyOwnerVault) {
  const row = await archive.read(key), action = row?.actions.at(-1);
  if (!row || row.shellOrigin !== ownerOrigin(origin) || !action || action.outcome !== "pending") throw legacyOwnerFailure();
  const intent = action.intent, context = { requestId: intent.requestId };
  const terminal = await worker.cancelPresentation(intent.route, intent.payload, context);
  const readback = await worker.mutationOutcome(intent.route, intent.payload, context);
  if (terminal.status === "recorded" || readback.status === "recorded") throw new Error("Original activation committed; resume its exact receipt instead of replacing it");
  if (!["cancelled", "failed"].includes(terminal.status) || !["cancelled", "failed"].includes(readback.status)) throw legacyOwnerFailure();
  await archive.compareAndSet(row, { ...row, actions: [...row.actions.slice(0, -1), { ...action, outcome: "cancelled" }] });
  if ((await archive.read(key))?.actions.at(-1)?.outcome !== "cancelled") throw legacyOwnerFailure();
}

export async function adoptLegacyOwner(worker: Pick<WorkerClient, "transferLegacyOwner">, candidateInput: LegacyOwnerCandidateV1,
  origin: string, archive: LegacyOwnerVault, owners: IntakeOwnerVault = new IndexedDbIntakeOwnerVault()) {
  const candidate = LegacyOwnerCandidateV1.parse(candidateInput), channel = new MessageChannel();
  const receiver = receiveLegacyOwner(channel.port1, origin, archive, owners);
  const sender = worker.transferLegacyOwner(candidate, channel.port2);
  try {
    const results = await Promise.allSettled([receiver, sender]);
    if (results[0].status !== "fulfilled" || results[1].status !== "fulfilled"
        || JSON.stringify(results[0].value) !== JSON.stringify(results[1].value.proof)) throw legacyOwnerFailure();
    return results[0].value;
  } finally { channel.port1.close(); channel.port2.close(); }
}
