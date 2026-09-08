import {
  IntakeRelayDeliveryItemV1,
  PublicIntakeLinkPayloadV1,
  type IntakeSubmissionPlaintextV1,
  type LocalIntakeFormV1,
  type PublicIntakeFormV1,
} from "@clay/schema/intake";
import type { IntakeDeliveryFailure, IntakeInboxItem } from "@clay/kernel";
import type { WorkerClient } from "../app/worker-client";
import { decodeBase64Url, decryptIntakeSubmission, encodeBase64Url, encryptIntakeSubmission,
  generateIntakeOwnerKeyPair } from "./crypto";

const MAX_RELAY_BYTES = 12 * 1024 * 1024;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type IntakeWorker = Pick<WorkerClient,
  "saveIntakeForm" | "markIntakeFormPublished" | "stageIntakeSubmission">;
type IntakeDeliveryWorker = Pick<WorkerClient,
  "stageIntakeSubmission" | "intakeDeliveryFailures" | "recordIntakeDeliveryFailure"
  | "authorizeIntakeDeliveryDiscard" | "resolveIntakeDeliveryFailure">;
type IntakeLifecycleWorker = IntakeDeliveryWorker & Pick<WorkerClient,
  "markIntakeFormExpired" | "revokeIntakeForm">;

export class IntakeRelayHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "IntakeRelayHttpError";
    this.status = status;
  }
}

function cryptoSource(): Crypto {
  if (!globalThis.crypto?.getRandomValues || !globalThis.crypto.subtle)
    throw new Error("Secure browser cryptography is unavailable.");
  return globalThis.crypto;
}

function base32Id(prefix: "form" | "sub" | "upl"): string {
  const bytes = cryptoSource().getRandomValues(new Uint8Array(17));
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let value = 0;
  let encoded = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && encoded.length < 26) {
      bits -= 5;
      encoded += alphabet[(value >>> bits) & 31];
      value &= (1 << bits) - 1;
    }
  }
  if (encoded.length !== 26) throw new Error("Secure identity generation failed.");
  return `${prefix}_${encoded}`;
}

export function mintIntakeToken(): string {
  return encodeBase64Url(cryptoSource().getRandomValues(new Uint8Array(32)));
}

export function mintIntakeFormId(): string { return base32Id("form"); }
export function mintIntakeSubmissionId(): string { return base32Id("sub"); }
export function mintIntakeUploadId(): string { return base32Id("upl"); }

function canonicalBaseUrl(value: string): string {
  return value.replace(/\/$/u, "");
}

export function buildPublicIntakeLink(
  publicBaseUrl: string,
  relayBaseUrl: string,
  form: PublicIntakeFormV1,
): string {
  const payload = PublicIntakeLinkPayloadV1.parse({
    schema: 1, relayBaseUrl: `${canonicalBaseUrl(relayBaseUrl)}/`, form,
  });
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return `${canonicalBaseUrl(publicBaseUrl)}/intake#intake=${encodeBase64Url(bytes)}`;
}

export function parsePublicIntakeLink(hash: string): PublicIntakeLinkPayloadV1 {
  const params = new URLSearchParams(hash.replace(/^#/u, ""));
  const encoded = params.get("intake");
  if (!encoded) throw new Error("This intake link is incomplete.");
  const bytes = decodeBase64Url(encoded, 128 * 1024);
  let decoded: unknown;
  try { decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("This intake link is invalid."); }
  const parsed = PublicIntakeLinkPayloadV1.safeParse(decoded);
  if (!parsed.success) throw new Error("This intake link is invalid or no longer supported.");
  return parsed.data;
}

export async function createLocalIntakeForm(input: {
  title: string;
  description: string;
  target: PublicIntakeFormV1["target"];
  fields: PublicIntakeFormV1["fields"];
  fileRequests: PublicIntakeFormV1["fileRequests"];
  relayBaseUrl: string;
  expiresAt: string;
}): Promise<LocalIntakeFormV1> {
  const keys = await generateIntakeOwnerKeyPair();
  const publicForm: PublicIntakeFormV1 = {
    schema: 1,
    formId: mintIntakeFormId(),
    revision: 1,
    title: input.title,
    description: input.description,
    target: input.target,
    fields: input.fields,
    fileRequests: input.fileRequests,
    encryption: {
      algorithm: "ECDH-P256-HKDF-SHA256-AES-256-GCM",
      ownerPublicKey: keys.publicKey,
    },
    delivery: { submitToken: mintIntakeToken(), expiresAt: input.expiresAt },
  };
  const ownerToken = mintIntakeToken();
  return {
    schema: 1,
    publicForm,
    ownerPrivateKey: keys.privateKey,
    ownerToken: ownerToken === publicForm.delivery.submitToken ? mintIntakeToken() : ownerToken,
    relayBaseUrl: `${canonicalBaseUrl(input.relayBaseUrl)}/`,
    publishedAt: null,
    revokedAt: null,
  };
}

async function responseError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: unknown };
    if (typeof body.error === "string") return body.error;
  } catch { /* use status below */ }
  return `relay returned ${response.status}`;
}

export async function publishIntakeForm(input: {
  worker: IntakeWorker;
  localForm: LocalIntakeFormV1;
  publicBaseUrl: string;
  fetchImpl?: FetchLike;
  now?: () => Date;
}): Promise<{ localForm: LocalIntakeFormV1; link: string }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const saved = await input.worker.saveIntakeForm({ ...input.localForm, publishedAt: null });
  const response = await fetchImpl(`${canonicalBaseUrl(saved.relayBaseUrl)}/intake/forms`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schema: 1,
      formId: saved.publicForm.formId,
      ownerToken: saved.ownerToken,
      submitToken: saved.publicForm.delivery.submitToken,
      expiresAt: saved.publicForm.delivery.expiresAt,
      maxCiphertextBytes: MAX_RELAY_BYTES,
    }),
  });
  if (!response.ok) throw new Error(`Form was saved as a draft, but publication failed: ${await responseError(response)}`);
  const publishedAt = (input.now?.() ?? new Date()).toISOString();
  const published = await input.worker.markIntakeFormPublished(saved.publicForm.formId, publishedAt);
  return {
    localForm: published,
    link: buildPublicIntakeLink(input.publicBaseUrl, published.relayBaseUrl, published.publicForm),
  };
}

const MAX_DELIVERY_RESPONSE_BYTES = Math.ceil(MAX_RELAY_BYTES * 4 / 3) + 128 * 1024;

async function boundedResponseJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared)
      || Number(declared) > MAX_DELIVERY_RESPONSE_BYTES))
    throw new Error("Relay delivery page exceeded the local byte limit.");
  if (!response.body) return JSON.parse(await response.text()) as unknown;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_DELIVERY_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Relay delivery page exceeded the local byte limit.");
      }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

async function acknowledgeDelivery(
  fetchImpl: FetchLike,
  localForm: LocalIntakeFormV1,
  submissionId: string,
): Promise<boolean> {
  const response = await fetchImpl(
    `${canonicalBaseUrl(localForm.relayBaseUrl)}/intake/forms/${
      localForm.publicForm.formId}/submissions/${submissionId}`,
    { method: "DELETE", headers: { authorization: `Bearer ${localForm.ownerToken}` } },
  );
  return response.ok || response.status === 404 || response.status === 410;
}

function activeFailureMap(failures: IntakeDeliveryFailure[]): Map<string, IntakeDeliveryFailure> {
  return new Map(failures
    .filter(item => item.status === "failed" || item.status === "discard_authorized")
    .map(item => [`${item.formId}/${item.submissionId}`, item]));
}

export async function fetchAndStageIntake(
  worker: IntakeDeliveryWorker,
  localForm: LocalIntakeFormV1,
  fetchImpl: FetchLike = fetch,
  options: Readonly<{ retrySubmissionIds?: readonly string[]; now?: () => Date }> = {},
): Promise<IntakeInboxItem[]> {
  const base = canonicalBaseUrl(localForm.relayBaseUrl);
  const delivered: Array<ReturnType<typeof IntakeRelayDeliveryItemV1.parse>> = [];
  let after: string | null = null;
  for (let page = 0; page < 3; page++) {
    const query = new URLSearchParams({ limit: "50" });
    if (after) query.set("after", after);
    const response = await fetchImpl(
      `${base}/intake/forms/${localForm.publicForm.formId}/submissions?${query}`,
      { headers: { authorization: `Bearer ${localForm.ownerToken}` } },
    );
    if (!response.ok)
      throw new IntakeRelayHttpError(response.status,
        `Could not refresh intake: ${await responseError(response)}`);
    const body = await boundedResponseJson(response) as { items?: unknown; hasMore?: unknown };
    if (!Array.isArray(body.items) || typeof body.hasMore !== "boolean")
      throw new Error("Relay returned an invalid bounded delivery page.");
    const pageItems = body.items.map(item => IntakeRelayDeliveryItemV1.parse(item));
    delivered.push(...pageItems);
    if (!body.hasMore) break;
    if (pageItems.length === 0) throw new Error("Relay pagination did not make progress.");
    after = pageItems.at(-1)!.submissionId;
  }
  if (delivered.length > 100) throw new Error("Relay exceeded the local delivery limit.");
  const staged: IntakeInboxItem[] = [];
  const failures = activeFailureMap(await worker.intakeDeliveryFailures());
  const retries = new Set(options.retrySubmissionIds ?? []);
  const now = (): string => (options.now?.() ?? new Date()).toISOString();
  for (const item of delivered) {
    const key = `${item.formId}/${item.submissionId}`;
    const priorFailure = failures.get(key);
    if (priorFailure?.status === "discard_authorized") {
      if (await acknowledgeDelivery(fetchImpl, localForm, item.submissionId)) {
        await worker.resolveIntakeDeliveryFailure(
          item.formId, item.submissionId, "discarded", now(),
        );
        failures.delete(key);
      }
      continue;
    }
    if (priorFailure?.status === "failed" && !retries.has(item.submissionId)) continue;
    let plaintext: IntakeSubmissionPlaintextV1;
    try {
      plaintext = await decryptIntakeSubmission(localForm.publicForm, localForm.ownerPrivateKey, {
        schema: 1, submissionId: item.submissionId, envelope: item.envelope,
      });
    } catch {
      const envelopeSha256 = await sha256HexBrowser(new TextEncoder().encode(JSON.stringify({
        schema: 1, formId: item.formId, submissionId: item.submissionId, envelope: item.envelope,
      })));
      const failure = await worker.recordIntakeDeliveryFailure({
        formId: item.formId, submissionId: item.submissionId, envelopeSha256, failedAt: now(),
      });
      failures.set(key, failure);
      continue;
    }
    const local = await worker.stageIntakeSubmission(plaintext);
    staged.push(local);
    await worker.resolveIntakeDeliveryFailure(
      item.formId, item.submissionId, "staged", now(),
    );
    // Plaintext is durable before acknowledgement. A failed acknowledgement is safe:
    // the idempotent stage will be retried on the next refresh.
    await acknowledgeDelivery(fetchImpl, localForm, item.submissionId);
  }
  return staged;
}

export async function discardFailedIntakeDelivery(
  worker: IntakeDeliveryWorker,
  localForm: LocalIntakeFormV1,
  submissionId: string,
  fetchImpl: FetchLike = fetch,
  now: () => Date = () => new Date(),
): Promise<void> {
  const existing = (await worker.intakeDeliveryFailures()).find(failure =>
    failure.formId === localForm.publicForm.formId && failure.submissionId === submissionId);
  if (!existing) throw new Error("Failed intake delivery is no longer awaiting recovery.");
  if (existing.status === "failed") {
    // This durable local write must precede any destructive relay request.
    await worker.authorizeIntakeDeliveryDiscard(
      localForm.publicForm.formId, submissionId, now().toISOString(),
    );
  } else if (existing.status !== "discard_authorized") {
    throw new Error("Failed intake delivery is no longer awaiting recovery.");
  }
  if (!await acknowledgeDelivery(fetchImpl, localForm, submissionId))
    throw new Error("Discard was authorized locally, but relay acknowledgement failed.");
  await worker.resolveIntakeDeliveryFailure(
    localForm.publicForm.formId, submissionId, "discarded", now().toISOString(),
  );
}

export async function refreshPublishedIntakeForms(
  worker: IntakeLifecycleWorker,
  forms: readonly LocalIntakeFormV1[],
  fetchImpl: FetchLike = fetch,
  now: () => Date = () => new Date(),
): Promise<{
  staged: IntakeInboxItem[];
  errors: Array<{ formId: string; message: string }>;
}> {
  const staged: IntakeInboxItem[] = [];
  const errors: Array<{ formId: string; message: string }> = [];
  for (const form of forms) {
    if (form.publishedAt === null || form.revokedAt !== null) continue;
    const instant = now();
    if (Date.parse(form.publicForm.delivery.expiresAt) <= instant.getTime()) {
      await worker.markIntakeFormExpired(form.publicForm.formId, instant.toISOString());
      continue;
    }
    try { staged.push(...await fetchAndStageIntake(worker, form, fetchImpl, { now })); }
    catch (error) {
      if (error instanceof IntakeRelayHttpError && (error.status === 404 || error.status === 410)) {
        const expiredAt = new Date(Math.max(
          instant.getTime(), Date.parse(form.publicForm.delivery.expiresAt),
        )).toISOString();
        await worker.markIntakeFormExpired(form.publicForm.formId, expiredAt);
        continue;
      }
      errors.push({
        formId: form.publicForm.formId,
        message: error instanceof Error ? error.message : "Intake refresh failed.",
      });
    }
  }
  return { staged, errors };
}

export async function revokePublishedIntakeForm(
  worker: Pick<WorkerClient, "revokeIntakeForm">,
  localForm: LocalIntakeFormV1,
  fetchImpl: FetchLike = fetch,
  now: () => Date = () => new Date(),
): Promise<LocalIntakeFormV1> {
  const response = await fetchImpl(
    `${canonicalBaseUrl(localForm.relayBaseUrl)}/intake/forms/${localForm.publicForm.formId}`,
    { method: "DELETE", headers: { authorization: `Bearer ${localForm.ownerToken}` } },
  );
  if (!response.ok && response.status !== 404 && response.status !== 410)
    throw new IntakeRelayHttpError(response.status,
      `Could not revoke intake form: ${await responseError(response)}`);
  return worker.revokeIntakeForm(localForm.publicForm.formId, now().toISOString());
}

export async function submitEncryptedIntake(
  payload: PublicIntakeLinkPayloadV1,
  submission: IntakeSubmissionPlaintextV1,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const relay = await encryptIntakeSubmission(payload.form, submission);
  const response = await fetchImpl(
    `${canonicalBaseUrl(payload.relayBaseUrl)}/intake/forms/${payload.form.formId}/submissions`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${payload.form.delivery.submitToken}`,
      },
      body: JSON.stringify(relay),
    },
  );
  if (!response.ok) throw new Error(`Secure submission failed: ${await responseError(response)}`);
}

export async function sha256HexBrowser(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await cryptoSource().subtle.digest("SHA-256", bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
