import {
  IntakeRelayDeliveryItemV1,
  PublicIntakeLinkPayloadV1,
  type IntakeSubmissionPlaintextV1,
  type LocalIntakeFormV2,
  type PublicIntakeFormV1,
} from "@clay/schema/standalone/intake";
import type { IntakeDeliveryFailure, IntakeInboxItem } from "@clay/kernel";
import type { IntakeSession } from "./session";
import type { hydrateIntakeOwnerForm } from "./owner-custody";
/** Hydrated only inside trusted shell, never a DB/worker contract. */
export type IntakeOwnerTransport = Pick<LocalIntakeFormV2, "relayBaseUrl" | "publishedAt" | "revokedAt"> & Awaited<ReturnType<typeof hydrateIntakeOwnerForm>>;
import { decodeBase64Url, decryptIntakeSubmission, encodeBase64Url, encryptIntakeSubmission } from "./crypto";
import { boundedRelayJson } from "../app/bounded-relay-response";

const MAX_RELAY_BYTES = 12 * 1024 * 1024;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type IntakeDeliveryWorker = Pick<IntakeSession,
  "stageIntakeSubmission" | "intakeDeliveryFailures" | "recordIntakeDeliveryFailure"
  | "authorizeIntakeDeliveryDiscard" | "resolveIntakeDeliveryFailure">;
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

async function responseError(response: Response): Promise<string> {
  // A relay may echo credentials in an error body. Never present its body.
  return `relay returned ${response.status}`;
}

const MAX_DELIVERY_RESPONSE_BYTES = Math.ceil(MAX_RELAY_BYTES * 4 / 3) + 128 * 1024;

async function acknowledgeDelivery(
  fetchImpl: FetchLike,
  localForm: IntakeOwnerTransport,
  submissionId: string,
): Promise<boolean> {
  const response = await fetchImpl(
    `${canonicalBaseUrl(localForm.relayBaseUrl)}/intake/forms/${
      localForm.publicForm.formId}/submissions/${submissionId}`,
    { method: "DELETE", redirect: "error", credentials: "omit", headers: { authorization: `Bearer ${localForm.ownerToken}` } },
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
  localForm: IntakeOwnerTransport,
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
      { redirect: "error", credentials: "omit", headers: { authorization: `Bearer ${localForm.ownerToken}` } },
    );
    if (!response.ok)
      throw new IntakeRelayHttpError(response.status,
        `Could not refresh intake: ${await responseError(response)}`);
    const body = await boundedRelayJson(response, MAX_DELIVERY_RESPONSE_BYTES) as { items?: unknown; hasMore?: unknown };
    if (!body || typeof body !== "object" || Object.keys(body).some(key => !["items", "hasMore"].includes(key))
        || !Array.isArray(body.items) || body.items.length > 50 || typeof body.hasMore !== "boolean")
      throw new Error("Relay returned an invalid bounded delivery page.");
    const pageItems = body.items.map(item => {
      const parsed = IntakeRelayDeliveryItemV1.safeParse(item);
      if (!parsed.success) throw new Error("Relay returned an invalid bounded delivery item.");
      if (parsed.data.formId !== localForm.publicForm.formId)
        throw new Error("Relay delivery does not belong to the original form.");
      return parsed.data;
    });
    delivered.push(...pageItems);
    if (!body.hasMore) break;
    if (pageItems.length === 0) throw new Error("Relay pagination did not make progress.");
    after = pageItems.at(-1)!.submissionId;
  }
  if (delivered.length > 100) throw new Error("Relay exceeded the local delivery limit.");
  if (new Set(delivered.map(item => item.submissionId)).size !== delivered.length)
    throw new Error("Relay repeated a delivery identity; no acknowledgement was sent.");
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
    if (!await acknowledgeDelivery(fetchImpl, localForm, item.submissionId))
      throw new Error("Submission is staged locally; relay acknowledgement needs retry.");
  }
  return staged;
}

export async function discardFailedIntakeDelivery(
  worker: IntakeDeliveryWorker,
  localForm: IntakeOwnerTransport,
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
      redirect: "error",
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
