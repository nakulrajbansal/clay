import { expect, it } from "vitest";
import { CLAY_ARCHIVE_CONTENT_TYPE, sealAuthenticatedArchiveV5 } from "../../kernel/src/archive-authentication";
import { verifyArchiveThroughPort } from "../src/worker/archive-verification-channel";
import { serveArchiveVerification } from "../src/app/archive-verification";

const key = new Uint8Array(32).fill(7); // Synthetic test material only.
const header = { authenticationVersion: 1 as const, archiveFormat: 5 as const,
  contentType: CLAY_ARCHIVE_CONTENT_TYPE, keyId: new Uint8Array(16).fill(2),
  seriesId: new Uint8Array(16).fill(3), generation: 1n } as const;
it("authenticates a source-bound payload through a dedicated port without returning key material", async () => {
  const payload = new TextEncoder().encode("payload is deliberately not a ZIP");
  const envelope = sealAuthenticatedArchiveV5(payload, key, header);
  const channel = new MessageChannel();
  const stop = serveArchiveVerification(channel.port1, {
    keyForSeries: async () => key.slice(), assess: async () => "current",
  });
  try {
    const verified = await verifyArchiveThroughPort(channel.port2, envelope);
    expect(verified.payload).toEqual(payload);
    expect(verified.authentication.generation).toBe("1");
    expect(Object.keys(verified).sort()).toEqual(["archiveSha256", "authentication", "freshness", "payload"]);
  } finally { stop(); channel.port2.close(); }
});

it.each(["tampered", "wrong-key", "missing-key"])("rejects %s bytes before a caller can parse a ZIP", async failure => {
  const envelope = sealAuthenticatedArchiveV5(new Uint8Array([80, 75, 3, 4]), key, header);
  if (failure === "tampered") envelope[envelope.length - 1] = envelope[envelope.length - 1]! ^ 1;
  const channel = new MessageChannel();
  const stop = serveArchiveVerification(channel.port1, {
    keyForSeries: async () => failure === "missing-key" ? null : failure === "wrong-key" ? new Uint8Array(32).fill(9) : key.slice(),
    assess: async () => "current",
  });
  let parsed = false;
  try {
    await expect(verifyArchiveThroughPort(channel.port2, envelope).then(() => { parsed = true; }))
      .rejects.toThrow("Archive authentication failed");
    expect(parsed).toBe(false);
  } finally { stop(); channel.port2.close(); }
});

it("fails closed without an owned verification channel", async () => {
  await expect(verifyArchiveThroughPort(undefined, new Uint8Array([80, 75]))).rejects.toThrow(/channel/);
});
