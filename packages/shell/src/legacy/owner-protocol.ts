/** Dedicated trusted-shell/DB-worker port, not a panel or ordinary RPC payload.
 * Keys here are ephemeral transport keys, never intake owner or relay secrets. */
export const legacyOwnerFailure = () => new Error("Legacy ownership recovery was interrupted or cannot be proven. Original material was kept.");
export function closed(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}
export function ownerOrigin(value: string): string {
  const url = new URL(value);
  if (url.origin !== value || url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw legacyOwnerFailure();
  return value;
}
export function portMessage(port: MessagePort): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); port.onmessage = null; port.onmessageerror = null; };
    const timer = setTimeout(() => { stop(); reject(legacyOwnerFailure()); }, 20_000);
    port.onmessageerror = () => { stop(); reject(legacyOwnerFailure()); };
    port.onmessage = event => { stop(); resolve(event.data); };
    port.start();
  });
}
export async function ownerDigest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return `sha256:${[...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(n => n.toString(16).padStart(2, "0")).join("")}`;
}
