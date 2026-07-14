// Device-global model access (B1, doc 13): the Anthropic key and/or a
// hosted backend URL live ONCE on the device (localStorage) and are shared
// by every app — you enter them once, not per app. They are deliberately
// NOT stored in any app's database, so they never travel in a .clay export
// and switching apps never re-prompts.
const KEY = "clay_api_key";
const BACKEND = "clay_backend_url";

function read(k: string): string | null {
  try { return localStorage.getItem(k); } catch { return null; }
}
function write(k: string, v: string | null): void {
  try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); }
  catch { /* storage unavailable */ }
}

export function getApiKey(): string | null { return read(KEY); }
export function setApiKey(v: string | null): void { write(KEY, v && v.trim() ? v.trim() : null); }
export function getBackendUrl(): string | null { return read(BACKEND); }
export function setBackendUrl(v: string | null): void { write(BACKEND, v && v.trim() ? v.trim() : null); }
export function hasModelAccess(): boolean { return Boolean(getApiKey() || getBackendUrl()); }
