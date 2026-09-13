import { IntakeOwnerSourceV1, IntakeToken, LocalIntakeFormV2, PublicIntakeFormV1, type IntakeFormDefinitionV1 } from "@clay/schema/intake";
import { TargetEvidenceV1 } from "@clay/schema/catalog";
import { decodeBase64Url, encodeBase64Url, generateIntakeOwnerKeyPair } from "./crypto";

/** Trusted-shell only. Never serialize this record through WorkerClient, a
 * panel, diagnostics, application settings, or an application archive. */
export type IntakeOwnerCustody = Readonly<{ schema: 1; key: string; shellOrigin: string; form: LocalIntakeFormV2;
  ownerPrivateKey: string; ownerToken: string; submitToken: string }>;
export interface IntakeOwnerVault {
  read(key: string): Promise<IntakeOwnerCustody | null>;
  insert(record: IntakeOwnerCustody): Promise<void>;
}
type OwnerSource = LocalIntakeFormV2["ownerSource"];
const failure = () => new Error("Intake custody is missing, conflicted, or unavailable; existing material was kept");
function origin(value: string): string {
  const url = new URL(value);
  if (url.origin !== value || url.username || url.password || url.search || url.hash
      || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw failure();
  return url.origin;
}
function custodyKey(shellOrigin: string, source: OwnerSource, relay: string, formId: string): string {
  return JSON.stringify([1, origin(shellOrigin), source.appInstanceId, source.activeGenerationId, source.lineageEpoch, new URL(relay).origin, formId]);
}
function definitionIdentity(form: LocalIntakeFormV2): string {
  return JSON.stringify({ publicForm: form.publicForm, ownerSource: form.ownerSource, relayBaseUrl: form.relayBaseUrl });
}
async function verifyOwnerKeyPair(record: IntakeOwnerCustody): Promise<void> {
  // Prove possession without exporting or returning another private key. All
  // challenge material is ephemeral and independent of submissions/user data.
  let encoded: Uint8Array<ArrayBuffer> | undefined;
  let left: Uint8Array<ArrayBuffer> | undefined; let right: Uint8Array<ArrayBuffer> | undefined;
  try {
    encoded = decodeBase64Url(record.ownerPrivateKey, 138);
    const owner = await crypto.subtle.importKey("pkcs8", encoded, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const publicKey = await crypto.subtle.importKey("raw", decodeBase64Url(record.form.publicForm.encryption.ownerPublicKey, 65),
      { name: "ECDH", namedCurve: "P-256" }, false, []);
    const probe = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    left = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: probe.publicKey }, owner, 256));
    right = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, probe.privateKey, 256));
    let differs = left.length ^ right.length;
    for (let index = 0; index < left.length; index++) differs |= left[index]! ^ (right[index] ?? 0);
    if (differs !== 0) throw failure();
  } catch { throw failure(); }
  finally { encoded?.fill(0); left?.fill(0); right?.fill(0); }
}
export function validateIntakeOwnerCustody(input: unknown): IntakeOwnerCustody {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw failure();
    const value = input as Record<string, unknown>;
    const keys = ["schema", "key", "shellOrigin", "form", "ownerPrivateKey", "ownerToken", "submitToken"];
    if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key)) || value.schema !== 1
        || typeof value.shellOrigin !== "string" || typeof value.ownerPrivateKey !== "string" || !/^[A-Za-z0-9_-]{184}$/.test(value.ownerPrivateKey)
        || !IntakeToken.safeParse(value.ownerToken).success || !IntakeToken.safeParse(value.submitToken).success || value.ownerToken === value.submitToken) throw failure();
    if (decodeBase64Url(value.ownerToken as string, 32).length !== 32 || decodeBase64Url(value.submitToken as string, 32).length !== 32) throw failure();
    const form = LocalIntakeFormV2.parse(value.form);
    if (value.key !== custodyKey(value.shellOrigin, form.ownerSource, form.relayBaseUrl, form.publicForm.formId)) throw failure();
    return { schema: 1, key: value.key as string, shellOrigin: value.shellOrigin, form,
      ownerPrivateKey: value.ownerPrivateKey, ownerToken: value.ownerToken as string, submitToken: value.submitToken as string };
  } catch { throw failure(); } // No parser diagnostics may contain custody material.
}
export async function prepareIntakeOwnerForm(input: {
  source: TargetEvidenceV1; formId: string; shellOrigin: string; vault: IntakeOwnerVault; relayBaseUrl: string;
  title: string; description: string; expiresAt: string;
  target: IntakeFormDefinitionV1["target"]; fields: IntakeFormDefinitionV1["fields"]; fileRequests: IntakeFormDefinitionV1["fileRequests"];
}): Promise<LocalIntakeFormV2> {
  const { vault, ...proposal } = input;
  const fixed = structuredClone(proposal); // Before any asynchronous work.
  const current = TargetEvidenceV1.parse(fixed.source);
  const ownerSource = IntakeOwnerSourceV1.parse({ appInstanceId: current.appInstanceId, activeGenerationId: current.activeGenerationId, lineageEpoch: current.lineageEpoch });
  const key = custodyKey(fixed.shellOrigin, ownerSource, fixed.relayBaseUrl, fixed.formId);
  try {
    const existing = await vault.read(key);
    const previous = existing === null ? null : validateIntakeOwnerCustody(existing);
    if (previous) await verifyOwnerKeyPair(previous);
    const keys = previous ? null : await generateIntakeOwnerKeyPair();
    const form = LocalIntakeFormV2.parse({ schema: 2, ownerSource, relayBaseUrl: fixed.relayBaseUrl,
      publishedAt: null, revokedAt: null, terminalReason: null,
      publicForm: { schema: 1, formId: fixed.formId, revision: 1, title: fixed.title, description: fixed.description,
        target: fixed.target, fields: fixed.fields, fileRequests: fixed.fileRequests,
        encryption: { algorithm: "ECDH-P256-HKDF-SHA256-AES-256-GCM", ownerPublicKey: previous?.form.publicForm.encryption.ownerPublicKey ?? keys!.publicKey },
        delivery: { expiresAt: fixed.expiresAt } } });
    if (previous) {
      if (previous.key !== key || definitionIdentity(previous.form) !== definitionIdentity(form)) throw failure();
      return structuredClone(form);
    }
    const token = () => encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const ownerToken = token(); const submitToken = token();
    if (submitToken === ownerToken) throw failure();
    const record = validateIntakeOwnerCustody({ schema: 1, key, shellOrigin: fixed.shellOrigin, form,
      ownerPrivateKey: keys!.privateKey, ownerToken, submitToken });
    await vault.insert(record);
    const readback = validateIntakeOwnerCustody(await vault.read(key));
    if (JSON.stringify(readback) !== JSON.stringify(record)) throw failure();
    return structuredClone(form);
  } catch { throw failure(); }
}
export async function hydrateIntakeOwnerForm(formInput: LocalIntakeFormV2, source: TargetEvidenceV1, shellOrigin: string, vault: IntakeOwnerVault) {
  const form = LocalIntakeFormV2.parse(formInput); const current = TargetEvidenceV1.parse(source);
  if (form.ownerSource.appInstanceId !== current.appInstanceId || form.ownerSource.activeGenerationId !== current.activeGenerationId || form.ownerSource.lineageEpoch !== current.lineageEpoch)
    throw new Error("Intake owner source changed; private custody was not read");
  const key = custodyKey(shellOrigin, form.ownerSource, form.relayBaseUrl, form.publicForm.formId);
  const record = validateIntakeOwnerCustody(await vault.read(key));
  if (record.key !== key || definitionIdentity(record.form) !== definitionIdentity(form)) throw failure();
  await verifyOwnerKeyPair(record);
  const publicForm = PublicIntakeFormV1.parse({ ...form.publicForm, delivery: { ...form.publicForm.delivery, submitToken: record.submitToken } });
  return { publicForm, ownerPrivateKey: record.ownerPrivateKey, ownerToken: record.ownerToken };
}

/** Recovery never mints replacement material, including after a lost insert
 * acknowledgement. Return only the public original to the workflow caller. */
export async function recoverIntakeOwnerForm(source: TargetEvidenceV1, formId: string, shellOrigin: string, relay: string, vault: IntakeOwnerVault): Promise<LocalIntakeFormV2> {
  const fixed = TargetEvidenceV1.parse(source);
  const record = validateIntakeOwnerCustody(await vault.read(custodyKey(shellOrigin, fixed, relay, formId)));
  await hydrateIntakeOwnerForm(record.form, fixed, shellOrigin, vault);
  if (record.form.publicForm.formId !== formId || record.form.relayBaseUrl !== relay) throw failure();
  return structuredClone(record.form);
}
