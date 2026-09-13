/** Hash only a closed-schema, canonically ordered request. Caller keeps the
 * original private request in trusted shell; only this digest is acknowledged. */
export async function relayRequestSha256(request: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(request));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
