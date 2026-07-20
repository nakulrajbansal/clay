// Device-global model access (B1, doc 13): the Anthropic key and/or a
// hosted backend URL live ONCE on the device (localStorage) and are shared
// by every app — you enter them once, not per app. They are deliberately
// NOT stored in any app's database, so they never travel in a .clay export
// and switching apps never re-prompts.
const KEY = "clay_api_key";
const BACKEND = "clay_backend_url";
const SESSION = "clay_session";

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
  if (stored) return stored;
  // Hosted deploys serve the shell and API from ONE origin: default to
  // the page's own origin so a fresh visitor can sign in with zero setup.
  // An explicit BYO key keeps direct mode; localhost/http keeps dev flows.
  try {
    if (!read(KEY) && typeof location !== "undefined"
      && location.protocol === "https:"
      && !/^(localhost|127\.)/.test(location.hostname)) return location.origin;
  } catch { /* non-browser context */ }
  return null;
}
export function setBackendUrl(v: string | null): void { write(BACKEND, v && v.trim() ? v.trim() : null); }
export function getSessionToken(): string | null { return read(SESSION); }
export function setSessionToken(v: string | null): void { write(SESSION, v && v.trim() ? v.trim() : null); }
export function hasModelAccess(): boolean { return Boolean(getApiKey() || getBackendUrl()); }
