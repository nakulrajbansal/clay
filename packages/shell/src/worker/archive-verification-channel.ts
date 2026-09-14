import { BackupAuthenticationV1, MAX_BACKUP_ARCHIVE_BYTES } from "@clay/schema/standalone/backup";

export const ARCHIVE_ENVELOPE_LIMIT = MAX_BACKUP_ARCHIVE_BYTES + 512;
export type VerifiedArchivePayload = {
  archiveSha256: string;
  authentication: ReturnType<typeof BackupAuthenticationV1.parse>;
  freshness: "current" | "unknown" | "future" | "replay" | "fork";
  payload: Uint8Array;
};

export async function archiveDigest(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Only the trusted shell owns the other endpoint. This channel is never
 * attached to a panel, Store RPC, provider, or the general window message bus.
 * No ZIP parser or target creation may run before this resolves successfully. */
export async function verifyArchiveThroughPort(
  port: MessagePort | undefined, bytes: Uint8Array,
): Promise<VerifiedArchivePayload> {
  if (!port || typeof port.postMessage !== "function") throw new Error("Archive verification channel is required");
  if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer)
      || bytes.byteLength > ARCHIVE_ENVELOPE_LIMIT) { port.close(); throw new Error("Archive input exceeds its limit"); }
  const owned = bytes.slice();
  const expected = await archiveDigest(owned);
  const id = crypto.randomUUID();
  try {
    return await new Promise<VerifiedArchivePayload>((resolve, reject) => {
      const fail = () => { clearTimeout(timer); reject(new Error("Archive authentication failed")); };
      const timer = setTimeout(fail, 30_000);
      port.onmessageerror = fail;
      port.onmessage = event => {
        const value = event.data;
        if (!value || Object.keys(value).sort().join(",") !== "archiveSha256,authentication,freshness,id,ok,payload"
            || value.id !== id || value.ok !== true || value.archiveSha256 !== expected
            || !["current", "unknown", "future", "replay", "fork"].includes(value.freshness)
            || !(value.payload instanceof Uint8Array) || !(value.payload.buffer instanceof ArrayBuffer)
            || value.payload.byteLength > MAX_BACKUP_ARCHIVE_BYTES) { fail(); return; }
        const authentication = BackupAuthenticationV1.safeParse(value.authentication);
        if (!authentication.success) { fail(); return; }
        clearTimeout(timer);
        resolve({ archiveSha256: expected, authentication: authentication.data,
          freshness: value.freshness, payload: value.payload });
      };
      port.start();
      try { port.postMessage({ id, bytes: owned }, [owned.buffer]); } catch { fail(); }
    });
  } finally { port.close(); }
}
