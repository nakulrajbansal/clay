// Device-global model access (B1, doc 13): provider choice, credentials, and
// backend URL live ONCE on the device (localStorage) and are shared
// by every app — you enter them once, not per app. They are deliberately
// NOT stored in any app's database, so they never travel in a .clay export
// and switching apps never re-prompts.
const KEY = "clay_api_key";
const BACKEND = "clay_backend_url";
const SESSION = "clay_session";
const PROVIDER = "clay_model_provider";

export type ModelProviderId = "clay" | "openai" | "anthropic" | "codex";
type SessionRecord = { v: 1; backendOrigin: string; token: string };
export const CODEX_BACKEND_URL = "http://127.0.0.1:8788";
const isLoopbackHostname = (hostname: string): boolean =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";

function read(k: string): string | null {
  try { return localStorage.getItem(k); } catch { return null; }
}
function write(k: string, v: string | null): void {
  try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); }
  catch { /* storage unavailable */ }
}

export function getApiKey(): string | null { return read(KEY); }
export function setApiKey(v: string | null): void { write(KEY, v && v.trim() ? v.trim() : null); }
export function getBackendUrl(): string | null {
  const stored = read(BACKEND);
  if (stored) {
    try {
      const normalized = normalizeBackendUrl(stored);
      if (normalized !== stored) write(BACKEND, normalized);
      return normalized;
    } catch {
      write(BACKEND, null);
      write(SESSION, null);
    }
  }
  // Hosted deploys serve the shell and API from ONE origin: default to
  // the page's own origin so a fresh visitor can sign in with zero setup.
  // An explicit BYO key keeps direct mode; localhost/http keeps dev flows.
  try {
    if (!read(KEY) && typeof location !== "undefined"
      && location.protocol === "https:"
      && !isLoopbackHostname(location.hostname)) return location.origin;
  } catch { /* non-browser context */ }
  return null;
}
function backendOrigin(value: string | null): string | null {
  if (!value) return null;
  try { return new URL(value).origin; } catch { return null; }
}

export function setBackendUrl(v: string | null): void {
  const next = v && v.trim() ? normalizeBackendUrl(v) : null;
  const previousOrigin = backendOrigin(read(BACKEND));
  const nextOrigin = backendOrigin(next);
  if (previousOrigin !== nextOrigin) write(SESSION, null);
  write(BACKEND, next);
}
export function normalizeBackendUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new Error("Enter a valid backend URL."); }
  if (url.username || url.password) throw new Error("Remove credentials from the backend URL.");
  if (url.search || url.hash) throw new Error("Remove query strings and fragments from the backend URL.");
  if (url.hostname === "api.openai.com" || url.hostname === "api.anthropic.com")
    throw new Error("Use a compatible Clay model backend, not a provider API endpoint.");
  const loopback = isLoopbackHostname(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new Error("Use HTTPS for a remote backend; HTTP is allowed only on this computer.");
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path}`;
}
export function getSessionToken(backendUrl: string | null = getBackendUrl()): string | null {
  const raw = read(SESSION);
  if (!raw) return null;
  let record: SessionRecord;
  try { record = JSON.parse(raw) as SessionRecord; }
  catch { write(SESSION, null); return null; }
  const origin = backendOrigin(backendUrl);
  if (record.v !== 1 || !origin || record.backendOrigin !== origin
      || typeof record.token !== "string" || !record.token.trim()) return null;
  return record.token;
}
export function setSessionToken(
  value: string | null,
  backendUrl: string | null = getBackendUrl(),
): void {
  const token = value?.trim();
  if (!token) { write(SESSION, null); return; }
  const origin = backendOrigin(backendUrl);
  if (!origin) { write(SESSION, null); return; }
  write(SESSION, JSON.stringify({ v: 1, backendOrigin: origin, token } satisfies SessionRecord));
}
export function getModelProvider(): ModelProviderId {
  const stored = read(PROVIDER);
  if (stored === "clay" || stored === "openai" || stored === "anthropic" || stored === "codex")
    return stored;
  const legacyBackend = read(BACKEND);
  if (legacyBackend === CODEX_BACKEND_URL) return "codex";
  if (legacyBackend) return "clay";
  if (getApiKey()) return "anthropic";
  return "clay";
}
export function setModelProvider(provider: ModelProviderId): void { write(PROVIDER, provider); }
export function getActiveModelAccess(): {
  provider: ModelProviderId; apiKey: string | null; backendUrl: string | null;
} {
  const provider = getModelProvider();
  if (provider === "anthropic") return { provider, apiKey: getApiKey(), backendUrl: null };
  if (provider === "codex") return { provider, apiKey: null, backendUrl: CODEX_BACKEND_URL };
  return { provider, apiKey: null, backendUrl: getBackendUrl() };
}
export function hasModelAccess(): boolean {
  const access = getActiveModelAccess();
  return Boolean(access.apiKey || access.backendUrl);
}
