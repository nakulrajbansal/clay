// Device-global model access (B1, doc 13): provider choice, credentials, and
// backend URL live ONCE on the device (localStorage) and are shared
// by every app — you enter them once, not per app. They are deliberately
// NOT stored in any app's database, so they never travel in a .clay export
// and switching apps never re-prompts.
const KEY = "clay_api_key";
const BACKEND = "clay_backend_url";
const SESSION = "clay_session";
const AMBIENT_SESSION = "clay_ambient_session_v1";
const PROVIDER = "clay_model_provider";

export type ModelProviderId = "clay" | "openai" | "anthropic" | "codex";
type SessionRecord = { v: 1; backendOrigin: string; token: string };
type AmbientSessionRecordV1 = { v: 1; backendOrigin: string; allowed: boolean };
type AmbientSessionRecord = { v: 2; origins: Record<string, true> };
export const CODEX_BACKEND_URL = "http://127.0.0.1:8788";
const isLoopbackHostname = (hostname: string): boolean =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";

type ManagedLocation = Pick<Location, "protocol" | "hostname" | "origin">;

/** The managed product path is same-origin HTTPS. This is deliberately a pure
 * decision so entry can be tested without writing provider/backend settings. */
export function managedDefaultBackendUrl(
  browserLocation?: ManagedLocation | null,
): string | null {
  let current = browserLocation;
  if (current === undefined) {
    try { current = typeof location === "undefined" ? null : location; }
    catch { current = null; }
  }
  return current?.protocol === "https:" && !isLoopbackHostname(current.hostname)
    ? current.origin : null;
}

function read(k: string): string | null {
  try { return localStorage.getItem(k); } catch { return null; }
}
function write(k: string, v: string | null): void {
  try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); }
  catch { /* storage unavailable */ }
}

export function getApiKey(): string | null { return read(KEY); }
export function setApiKey(v: string | null): void { write(KEY, v && v.trim() ? v.trim() : null); }
export function getBackendUrl(browserLocation?: ManagedLocation | null): string | null {
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
  // A fresh managed profile uses the canonical same-origin connection without
  // persisting a synthetic preference. Explicit BYO/OpenAI/Codex choices are
  // never silently routed back through the managed provider.
  const explicitProvider = read(PROVIDER);
  if ((explicitProvider !== null && explicitProvider !== "clay")
      || (explicitProvider === null && Boolean(read(KEY)))) return null;
  return managedDefaultBackendUrl(browserLocation);
}
function backendOrigin(value: string | null): string | null {
  if (!value) return null;
  try { return new URL(value).origin; } catch { return null; }
}

export function setBackendUrl(v: string | null): void {
  const next = v && v.trim() ? normalizeBackendUrl(v) : null;
  const previousOrigin = backendOrigin(read(BACKEND));
  const nextOrigin = backendOrigin(next);
  if (previousOrigin !== nextOrigin) {
    write(SESSION, null);
  }
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

function ambientSessionOrigins(): Record<string, true> | null {
  const raw = read(AMBIENT_SESSION);
  if (!raw) return Object.create(null) as Record<string, true>;
  try {
    const record = JSON.parse(raw) as AmbientSessionRecord | AmbientSessionRecordV1;
    if (!record || typeof record !== "object" || Array.isArray(record)) return null;
    if (record.v === 1) {
      const origin = backendOrigin(record.backendOrigin);
      if (origin !== record.backendOrigin || typeof record.allowed !== "boolean") return null;
      return record.allowed ? { [origin]: true } : Object.create(null) as Record<string, true>;
    }
    if (record.v !== 2 || !record.origins || typeof record.origins !== "object"
        || Array.isArray(record.origins)) return null;
    const entries = Object.entries(record.origins);
    if (entries.length > 64 || entries.some(([origin, allowed]) =>
      backendOrigin(origin) !== origin || allowed !== true)) return null;
    return Object.fromEntries(entries) as Record<string, true>;
  } catch { return null; }
}

export function isAmbientSessionAllowed(
  backendUrl: string | null = getBackendUrl(),
): boolean {
  const origin = backendOrigin(backendUrl);
  if (!origin) return false;
  const origins = ambientSessionOrigins();
  return origins !== null && origins[origin] === true;
}

export function setAmbientSessionAllowed(
  allowed: boolean,
  backendUrl: string | null = getBackendUrl(),
): void {
  const origin = backendOrigin(backendUrl);
  if (!origin) return;
  const origins = ambientSessionOrigins() ?? Object.create(null) as Record<string, true>;
  delete origins[origin];
  if (allowed) origins[origin] = true;
  const bounded = Object.fromEntries(Object.entries(origins).slice(-64)) as Record<string, true>;
  write(AMBIENT_SESSION, JSON.stringify({ v: 2, origins: bounded } satisfies AmbientSessionRecord));
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
export function getActiveModelAccess(browserLocation?: ManagedLocation | null): {
  provider: ModelProviderId; apiKey: string | null; backendUrl: string | null;
} {
  const provider = getModelProvider();
  if (provider === "anthropic") return { provider, apiKey: getApiKey(), backendUrl: null };
  if (provider === "codex") return { provider, apiKey: null, backendUrl: CODEX_BACKEND_URL };
  return { provider, apiKey: null, backendUrl: getBackendUrl(browserLocation) };
}
export function hasModelAccess(): boolean {
  const access = getActiveModelAccess();
  return Boolean(access.apiKey || access.backendUrl);
}
