import { normalizeBackendUrl } from "./settings";

export type HostedAuthAccess = Readonly<{
  provider: string;
  backendUrl: string | null;
}>;

export type HostedAuthAttempt = Readonly<{
  generation: number;
  backendUrl: string;
  state: string;
  signal: AbortSignal;
}>;

export type PersistedHostedAuthAttempt = Readonly<{
  v: 1;
  provider: "clay";
  backendUrl: string;
  state: string;
  createdAt: number;
}>;

const AUTH_ATTEMPT = "clay_hosted_auth_attempt_v1";
const AUTH_STATE = /^[0-9a-f]{64}$/;
const AUTH_TOKEN = /^[A-Za-z0-9_-]{32,256}$/;
const AUTH_ATTEMPT_MAX_AGE_MS = 15 * 60_000;
export const HOSTED_ACCOUNT_CHANGE_KEY = "clay_hosted_account_change_v1";

export type HostedAccountChange = Readonly<{
  v: 1;
  backendOrigin: string;
  state: "granted" | "revoked";
  generation: string;
}>;

function authStorage(): Storage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; }
  catch { return null; }
}

function clearPersistedHostedAuthAttempt(): void {
  try { authStorage()?.removeItem(AUTH_ATTEMPT); } catch { /* storage unavailable */ }
}

function persistHostedAuthAttempt(record: PersistedHostedAuthAttempt): void {
  try { authStorage()?.setItem(AUTH_ATTEMPT, JSON.stringify(record)); }
  catch { /* storage unavailable; navigation completion will fail closed */ }
}

function mintAuthState(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function parseHostedAccountChange(raw: string | null): HostedAccountChange | null {
  if (!raw) return null;
  try {
    const change = JSON.parse(raw) as HostedAccountChange;
    if (!change || typeof change !== "object" || Array.isArray(change)
        || Reflect.ownKeys(change).length !== 4 || change.v !== 1
        || (change.state !== "granted" && change.state !== "revoked")
        || !AUTH_STATE.test(change.generation)
        || new URL(change.backendOrigin).origin !== change.backendOrigin) return null;
    return Object.freeze({ ...change });
  } catch { return null; }
}

export function publishHostedAccountChange(
  backendUrl: string,
  state: HostedAccountChange["state"],
): HostedAccountChange {
  const change = Object.freeze({
    v: 1 as const,
    backendOrigin: new URL(normalizeBackendUrl(backendUrl)).origin,
    state,
    generation: mintAuthState(),
  });
  try { authStorage()?.setItem(HOSTED_ACCOUNT_CHANGE_KEY, JSON.stringify(change)); }
  catch { /* current-tab revocation already completed */ }
  return change;
}

export function observeHostedAccountChanges(
  callback: (change: HostedAccountChange) => void,
  target: EventTarget = window,
): () => void {
  const listener = (event: Event): void => {
    const storageEvent = event as StorageEvent;
    if (storageEvent.key !== HOSTED_ACCOUNT_CHANGE_KEY) return;
    const change = parseHostedAccountChange(storageEvent.newValue);
    if (change) callback(change);
  };
  target.addEventListener("storage", listener);
  return () => target.removeEventListener("storage", listener);
}

export function consumePersistedHostedAuthAttempt(
  state: string,
  access: HostedAuthAccess,
  nowMs: number = Date.now(),
): PersistedHostedAuthAttempt | null {
  const storage = authStorage();
  let raw: string | null = null;
  try { raw = storage?.getItem(AUTH_ATTEMPT) ?? null; storage?.removeItem(AUTH_ATTEMPT); }
  catch { return null; }
  if (!raw || !AUTH_STATE.test(state)) return null;
  try {
    const record = JSON.parse(raw) as PersistedHostedAuthAttempt;
    if (!record || record.v !== 1 || record.provider !== "clay"
        || !AUTH_STATE.test(record.state) || record.state !== state
        || !Number.isSafeInteger(record.createdAt) || record.createdAt > nowMs
        || nowMs - record.createdAt > AUTH_ATTEMPT_MAX_AGE_MS
        || access.provider !== "clay" || !access.backendUrl) return null;
    const backendUrl = normalizeBackendUrl(record.backendUrl);
    if (backendUrl !== record.backendUrl
        || normalizeBackendUrl(access.backendUrl) !== backendUrl) return null;
    return Object.freeze({ ...record });
  } catch { return null; }
}

export function captureHostedAuthLanding(href: string): Readonly<{
  token: string; state: string;
}> | null {
  try {
    const url = new URL(href);
    const params = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
    if ([...params.keys()].length !== 3 || params.get("auth") !== "complete") return null;
    const token = params.get("token") ?? "";
    const state = params.get("state") ?? "";
    return AUTH_TOKEN.test(token) && AUTH_STATE.test(state) ? Object.freeze({ token, state }) : null;
  } catch { return null; }
}

export class HostedAuthFence {
  #generation = 0;
  #controller: AbortController | null = null;

  begin(backendUrl: string): HostedAuthAttempt {
    this.#controller?.abort(new Error("hosted authentication was superseded"));
    const controller = new AbortController();
    this.#controller = controller;
    const attempt = Object.freeze({
      generation: ++this.#generation,
      backendUrl: normalizeBackendUrl(backendUrl),
      state: mintAuthState(),
      signal: controller.signal,
    });
    persistHostedAuthAttempt({
      v: 1, provider: "clay", backendUrl: attempt.backendUrl,
      state: attempt.state, createdAt: Date.now(),
    });
    return attempt;
  }

  resume(record: PersistedHostedAuthAttempt): HostedAuthAttempt {
    this.#controller?.abort(new Error("hosted authentication was superseded"));
    const controller = new AbortController();
    this.#controller = controller;
    return Object.freeze({
      generation: ++this.#generation, backendUrl: record.backendUrl,
      state: record.state, signal: controller.signal,
    });
  }

  invalidate(): void {
    this.#generation++;
    this.#controller?.abort(new Error("hosted authentication was revoked"));
    this.#controller = null;
    clearPersistedHostedAuthAttempt();
  }

  isCurrent(attempt: HostedAuthAttempt, access: HostedAuthAccess): boolean {
    if (attempt.signal.aborted || attempt.generation !== this.#generation
        || access.provider !== "clay" || !access.backendUrl) return false;
    try { return normalizeBackendUrl(access.backendUrl) === attempt.backendUrl; }
    catch { return false; }
  }
}

export async function redeemHostedAuthAttempt(
  fence: HostedAuthFence,
  attempt: HostedAuthAttempt,
  token: string,
  access: () => HostedAuthAccess,
  fetchFn: typeof fetch = fetch,
  revoke: (backendUrl: string, session: string) => Promise<void> = logoutHostedBearerSession,
): Promise<string | null> {
  if (!AUTH_TOKEN.test(token)) throw new Error("invalid sign-in token");
  const callback = new URL(`${attempt.backendUrl.replace(/\/$/, "")}/auth/callback`);
  callback.searchParams.set("token", token);
  callback.searchParams.set("state", attempt.state);
  const response = await fetchFn(callback, { credentials: "omit", signal: attempt.signal });
  const body = await response.json() as { session?: string; error?: string };
  const session = typeof body.session === "string" && AUTH_TOKEN.test(body.session)
    ? body.session : null;
  if (!fence.isCurrent(attempt, access())) {
    if (session) await revoke(attempt.backendUrl, session);
    return null;
  }
  if (!response.ok || !session)
    throw new Error(body.error ?? "Sign-in callback did not return a session");
  return session;
}

async function postHostedLogout(
  backendUrl: string,
  session: string | null,
  credentials: "include" | "omit",
  fetchFn: typeof fetch,
): Promise<void> {
  const endpoint = normalizeBackendUrl(backendUrl).replace(/\/$/, "");
  const response = await fetchFn(`${endpoint}/auth/logout`, {
    method: "POST", credentials,
    headers: session ? { authorization: ["Bearer", session].join(" ") } : {},
    signal: AbortSignal.timeout(2_500),
  });
  if (!response.ok) throw new Error(`Remote logout failed with status ${response.status}`);
}

export function logoutHostedSession(
  backendUrl: string,
  session: string | null,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  return postHostedLogout(backendUrl, session, "include", fetchFn);
}

export function logoutHostedBearerSession(
  backendUrl: string,
  session: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  return postHostedLogout(backendUrl, session, "omit", fetchFn);
}
