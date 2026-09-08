import {
  IntakeRelaySubmissionV1,
  IntakeSubmissionPlaintextV1,
  PublicIntakeFormV1,
} from "@clay/schema/intake";

export type IntakeOwnerKeyPair = Readonly<{ publicKey: string; privateKey: string }>;

function cryptoSource(): Crypto {
  if (!globalThis.crypto?.subtle || !globalThis.crypto.getRandomValues)
    throw new Error("secure browser cryptography is unavailable");
  return globalThis.crypto;
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize)
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkSize)));
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function decodeBase64Url(value: string, maxBytes: number): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || !/^[A-Za-z0-9_-]+$/u.test(value))
    throw new Error("invalid base64url value");
  const estimated = Math.floor(value.length * 6 / 8);
  if (estimated > maxBytes) throw new Error("base64url value exceeds its byte limit");
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padding = "=".repeat((4 - standard.length % 4) % 4);
  let binary: string;
  try { binary = atob(standard + padding); }
  catch { throw new Error("invalid base64url value"); }
  if (binary.length > maxBytes) throw new Error("base64url value exceeds its byte limit");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  if (encodeBase64Url(bytes) !== value) throw new Error("non-canonical base64url value");
  return bytes;
}

function contextBytes(form: PublicIntakeFormV1, submissionId: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    `clay-public-intake-v1\u0000${form.formId}\u0000${form.revision}\u0000${submissionId}`,
  );
}

async function deriveAesKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  salt: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  usage: KeyUsage,
): Promise<CryptoKey> {
  const crypto = cryptoSource();
  const shared = await crypto.subtle.deriveBits(
    { name: "ECDH", public: publicKey }, privateKey, 256,
  );
  const keyMaterial = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({
    name: "HKDF", hash: "SHA-256", salt, info,
  }, keyMaterial, { name: "AES-GCM", length: 256 }, false, [usage]);
}

export async function generateIntakeOwnerKeyPair(): Promise<IntakeOwnerKeyPair> {
  const crypto = cryptoSource();
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"],
  );
  const publicBytes = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const privateBytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const publicKey = encodeBase64Url(publicBytes);
  const privateKey = encodeBase64Url(privateBytes);
  if (publicKey.length !== 87 || privateKey.length !== 184)
    throw new Error("browser produced a non-canonical P-256 key encoding");
  return Object.freeze({ publicKey, privateKey });
}

export async function encryptIntakeSubmission(
  formInput: PublicIntakeFormV1,
  submissionInput: IntakeSubmissionPlaintextV1,
): Promise<IntakeRelaySubmissionV1> {
  const form = PublicIntakeFormV1.parse(formInput);
  const submission = IntakeSubmissionPlaintextV1.parse(submissionInput);
  if (submission.formId !== form.formId || submission.formRevision !== form.revision)
    throw new Error("submission does not match this form revision");

  const crypto = cryptoSource();
  const ownerPublic = await crypto.subtle.importKey(
    "raw", decodeBase64Url(form.encryption.ownerPublicKey, 65),
    { name: "ECDH", namedCurve: "P-256" }, false, [],
  );
  const ephemeral = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"],
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = contextBytes(form, submission.submissionId);
  const key = await deriveAesKey(ephemeral.privateKey, ownerPublic, salt, aad, "encrypt");
  const plaintext = new TextEncoder().encode(JSON.stringify(submission));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({
    name: "AES-GCM", iv, additionalData: aad, tagLength: 128,
  }, key, plaintext));
  const ephemeralPublicKey = encodeBase64Url(new Uint8Array(
    await crypto.subtle.exportKey("raw", ephemeral.publicKey),
  ));
  return IntakeRelaySubmissionV1.parse({
    schema: 1,
    submissionId: submission.submissionId,
    envelope: {
      schema: 1,
      algorithm: "ECDH-P256-HKDF-SHA256-AES-256-GCM",
      ephemeralPublicKey,
      salt: encodeBase64Url(salt),
      iv: encodeBase64Url(iv),
      ciphertext: encodeBase64Url(ciphertext),
    },
  });
}

export async function decryptIntakeSubmission(
  formInput: PublicIntakeFormV1,
  ownerPrivateKey: string,
  relayInput: IntakeRelaySubmissionV1,
): Promise<IntakeSubmissionPlaintextV1> {
  const form = PublicIntakeFormV1.parse(formInput);
  const relay = IntakeRelaySubmissionV1.parse(relayInput);
  const crypto = cryptoSource();
  const privateKey = await crypto.subtle.importKey(
    "pkcs8", decodeBase64Url(ownerPrivateKey, 138),
    { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"],
  );
  const ephemeralPublic = await crypto.subtle.importKey(
    "raw", decodeBase64Url(relay.envelope.ephemeralPublicKey, 65),
    { name: "ECDH", namedCurve: "P-256" }, false, [],
  );
  const salt = decodeBase64Url(relay.envelope.salt, 16);
  const iv = decodeBase64Url(relay.envelope.iv, 12);
  const ciphertext = decodeBase64Url(relay.envelope.ciphertext, 12 * 1024 * 1024);
  const aad = contextBytes(form, relay.submissionId);
  const key = await deriveAesKey(privateKey, ephemeralPublic, salt, aad, "decrypt");
  const clear = await crypto.subtle.decrypt({
    name: "AES-GCM", iv, additionalData: aad, tagLength: 128,
  }, key, ciphertext);
  let decoded: unknown;
  try { decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(clear)); }
  catch { throw new Error("decrypted intake submission is not valid UTF-8 JSON"); }
  const submission = IntakeSubmissionPlaintextV1.parse(decoded);
  if (submission.submissionId !== relay.submissionId
      || submission.formId !== form.formId || submission.formRevision !== form.revision)
    throw new Error("decrypted submission identity does not match its authenticated context");
  return submission;
}
