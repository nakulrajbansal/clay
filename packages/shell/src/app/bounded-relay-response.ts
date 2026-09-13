/** Trusted-shell relay response reader. Bounds bytes before JSON parsing and
 * never includes a remote error body (which may echo credentials) in diagnostics. */
export async function boundedRelayJson(response: Response, limit: number): Promise<unknown> {
  try {
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/u.test(length) || Number(length) > limit)) throw new Error();
    if (!response.body) throw new Error();
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        total += chunk.value.byteLength;
        if (total > limit) { await reader.cancel(); throw new Error(); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch { throw new Error("Relay response is malformed or exceeds its byte bound; original request was kept"); }
}
