import {
  inspectAuthenticatedArchiveV5Header, verifyAuthenticatedArchiveV5,
  type AuthenticatedArchiveHeaderV1,
} from "@clay/kernel/archive-authentication";
import { ARCHIVE_ENVELOPE_LIMIT, archiveDigest } from "../worker/archive-verification-channel";

type TrustVerifier = {
  keyForSeries(seriesId: string): Promise<Uint8Array | null>;
  assess(header: AuthenticatedArchiveHeaderV1, bytes: Uint8Array): Promise<string>;
};
const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");

/** Trusted-shell-only key access. Failures deliberately contain no key hints,
 * payload, exception details, or Recovery Kit material. One port, one request. */
export function serveArchiveVerification(port: MessagePort, trust: TrustVerifier): () => void {
  let closed = false;
  let used = false;
  const stop = () => { closed = true; port.close(); };
  port.onmessage = event => {
    if (used || closed) { stop(); return; }
    used = true;
    const value = event.data as { id?: unknown; bytes?: unknown };
    void (async () => {
      let key: Uint8Array | null = null;
      let bytes: Uint8Array | null = null;
      try {
        if (!value || Object.keys(value).sort().join(",") !== "bytes,id" || typeof value.id !== "string"
            || !/^[a-f0-9-]{36}$/.test(value.id) || !(value.bytes instanceof Uint8Array)
            || !(value.bytes.buffer instanceof ArrayBuffer) || value.bytes.byteLength > ARCHIVE_ENVELOPE_LIMIT)
          throw new Error("invalid archive request");
        bytes = value.bytes;
        const header = inspectAuthenticatedArchiveV5Header(bytes);
        key = await trust.keyForSeries(hex(header.seriesId));
        if (!key) throw new Error("missing verifier");
        const verified = verifyAuthenticatedArchiveV5(bytes, () => key);
        const freshness = await trust.assess(verified.header, bytes);
        if (!["current", "unknown", "future", "replay", "fork"].includes(freshness)) throw new Error("invalid freshness");
        if (closed) { verified.payload.fill(0); return; }
        port.postMessage({ id: value.id, ok: true, payload: verified.payload,
          archiveSha256: await archiveDigest(bytes), freshness,
          authentication: { schema: 1, kind: "cose_mac0_hmac_256_256", authenticationVersion: 1,
            keyId: hex(verified.header.keyId), seriesId: hex(verified.header.seriesId), generation: verified.header.generation.toString() },
        }, [verified.payload.buffer]);
      } catch {
        if (!closed) port.postMessage({ id: typeof value?.id === "string" ? value.id : "", ok: false });
      } finally { key?.fill(0); bytes?.fill(0); stop(); }
    })();
  };
  port.onmessageerror = stop;
  port.start();
  return stop;
}
