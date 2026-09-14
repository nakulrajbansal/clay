import type { ProductionStoreAuthority } from "@clay/kernel/worker-authority";
import { LegacyOwnerCandidateV1 } from "@clay/schema/legacy-owner";
import { closed, legacyOwnerFailure, ownerOrigin, portMessage } from "../legacy/owner-protocol";

/** Only ciphertext travels on this private port. Ordinary response contains a
 * closed public proof after the receiver's custody commit/readback. */
export async function sendLegacyOwner(authority: ProductionStoreAuthority, candidateInput: unknown, port: MessagePort | undefined, expectedOrigin: string) {
  if (!port) throw legacyOwnerFailure();
  try {
    ownerOrigin(expectedOrigin); const candidate = LegacyOwnerCandidateV1.parse(candidateInput);
    const hello = await portMessage(port);
    if (!closed(hello, ["schema", "origin", "nonce", "publicKey"]) || hello.schema !== 1 || hello.origin !== expectedOrigin
        || typeof hello.nonce !== "string" || !/^[0-9a-f-]{36}$/.test(hello.nonce) || !(hello.publicKey instanceof CryptoKey)
        || hello.publicKey.type !== "public" || hello.publicKey.algorithm.name !== "RSA-OAEP"
        || (hello.publicKey.algorithm as RsaHashedKeyAlgorithm).hash.name !== "SHA-256"
        || (hello.publicKey.algorithm as RsaHashedKeyAlgorithm).modulusLength !== 2048) throw legacyOwnerFailure();
    return await authority.withLegacyOwner(candidate, async (proof, bytes) => {
      const aes = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const aad = new TextEncoder().encode(JSON.stringify({ schema: 1, nonce: hello.nonce, origin: expectedOrigin, proof }));
      const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, aes, bytes);
      const wrapped = await crypto.subtle.wrapKey("raw", aes, hello.publicKey as CryptoKey, { name: "RSA-OAEP" });
      const waiting = portMessage(port);
      port.postMessage({ schema: 1, nonce: hello.nonce, proof, iv: iv.buffer, ciphertext, wrapped }, [iv.buffer, ciphertext, wrapped]);
      const ack = await waiting;
      if (!closed(ack, ["schema", "nonce", "responseSha256", "committed"]) || ack.schema !== 1 || ack.nonce !== hello.nonce
          || ack.responseSha256 !== candidate.receipt.responseSha256 || ack.committed !== true) throw legacyOwnerFailure();
      return { status: "custody_committed" as const, proof };
    });
  } catch { try { port.postMessage({ failed: true }); } catch { /* no diagnostics or private error causes */ } throw legacyOwnerFailure(); }
  finally { port.close(); }
}
