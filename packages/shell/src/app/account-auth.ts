import { normalizeBackendUrl } from "./settings";

export type HostedAuthAccess = Readonly<{
  provider: string;
  backendUrl: string | null;
}>;

export type HostedAuthAttempt = Readonly<{
  generation: number;
  epoch: string;
  backendUrl: string;
  state: string;
  signal: AbortSignal;
}>;

export type PersistedHostedAuthAttempt = Readonly<{
  v: 1;
  provider: "clay";
  backendUrl: string;
  state: string;
  epoch: string;
  createdAt: number;
}>;

const AUTH_ATTEMPT = "clay_hosted_auth_attempt_v1";
const AUTH_EPOCHS = "clay_hosted_auth_epochs_v1";
const AUTH_LOCK = "clay_hosted_auth_epoch_lock_v1";
const AUTH_STATE = /^[0-9a-f]{64}$/;
const AUTH_EPOCH = /^(?:0|[1-9][0-9]{0,19})$/;
const AUTH_TOKEN = /^[A-Za-z0-9_-]{32,256}$/;
const AUTH_ATTEMPT_MAX_AGE_MS = 15 * 60_000;
export const HOSTED_ACCOUNT_CHANGE_KEY = "clay_hosted_account_change_v1";

export type HostedAccountChange = Readonly<{
  v: 1;
  backendOrigin: string;
  state: "granted" | "revoked";
  generation: string;
}>;

export type HostedAuthEpoch = Readonly<{
  epoch: string;
  state: "pending" | "granted" | "revoked";
}>;

type HostedAuthEpochRecord = {
  v: 1;
  sequence: string;
  origins: Record<string, HostedAuthEpoch>;
};

type LockManagerLike = {
  request<T>(
    name: string,
    options: { mode: "exclusive" },
    callback: () => T | PromiseLike<T>,
  ): Promise<T>;
};

function authStorage(): Storage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; }
  catch { return null; }
}

function hostedOrigin(backendUrl: string): string {
  return new URL(normalizeBackendUrl(backendUrl)).origin;
}

function authLockManager(): LockManagerLike {
  const locks = typeof navigator === "undefined"
    ? undefined
    : (navigator as Navigator & { locks?: LockManagerLike }).locks;
  if (!locks || typeof locks.request !== "function")
    throw new Error("cross-tab authentication locking is unavailable");
  return locks;
}

function withAuthLock<T>(callback: () => T | PromiseLike<T>): Promise<T> {
  return authLockManager().request(AUTH_LOCK, { mode: "exclusive" }, callback);
}

function readEpochRecord(storage: Storage): HostedAuthEpochRecord {
  const raw = storage.getItem(AUTH_EPOCHS);
  if (raw === null) return { v: 1, sequence: "0", origins: Object.create(null) };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error("hosted authentication epoch state is invalid"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("hosted authentication epoch state is invalid");
  const record = parsed as Record<string, unknown>;
  if (Reflect.ownKeys(record).length !== 3 || record.v !== 1
      || typeof record.sequence !== "string" || !AUTH_EPOCH.test(record.sequence)
      || !record.origins || typeof record.origins !== "object" || Array.isArray(record.origins))
    throw new Error("hosted authentication epoch state is invalid");
  const entries = Object.entries(record.origins as Record<string, unknown>);
  if (entries.length > 64) throw new Error("hosted authentication epoch state is invalid");
  const origins: Record<string, HostedAuthEpoch> = Object.create(null);
  for (const [origin, value] of entries) {
    if (!value || typeof value !== "object" || Array.isArray(value)
        || Reflect.ownKeys(value).length !== 2
        || new URL(origin).origin !== origin) {
      throw new Error("hosted authentication epoch state is invalid");
    }
    const epoch = value as Record<string, unknown>;
    if (typeof epoch.epoch !== "string" || !AUTH_EPOCH.test(epoch.epoch)
        || BigInt(epoch.epoch) > BigInt(record.sequence)
        || (epoch.state !== "pending" && epoch.state !== "granted"
          && epoch.state !== "revoked"))
      throw new Error("hosted authentication epoch state is invalid");
    origins[origin] = { epoch: epoch.epoch, state: epoch.state };
  }
  return { v: 1, sequence: record.sequence, origins };
}

function writeEpochRecord(storage: Storage, record: HostedAuthEpochRecord): void {
  storage.setItem(AUTH_EPOCHS, JSON.stringify(record));
}

function advanceEpoch(
  record: HostedAuthEpochRecord,
  origin: string,
  state: HostedAuthEpoch["state"],
): HostedAuthEpoch {
  if (!Object.hasOwn(record.origins, origin) && Object.keys(record.origins).length >= 64)
    throw new Error("hosted authentication epoch state is full");
  const next = BigInt(record.sequence) + 1n;
  if (next > 18_446_744_073_709_551_615n)
    throw new Error("hosted authentication epoch is exhausted");
  record.sequence = next.toString();
  const epoch = Object.freeze({ epoch: record.sequence, state });
  record.origins[origin] = epoch;
  return epoch;
}

function currentEpoch(record: HostedAuthEpochRecord, origin: string): HostedAuthEpoch {
  return record.origins[origin] ?? Object.freeze({ epoch: "0", state: "revoked" });
}

export function reconcileHostedAuthEpoch<T>(
  backendUrl: string,
  callback: (epoch: HostedAuthEpoch) => T | PromiseLike<T>,
): Promise<T> {
  const origin = hostedOrigin(backendUrl);
  return withAuthLock(() => {
    const storage = authStorage();
    if (!storage) throw new Error("durable authentication storage is unavailable");
    return callback(currentEpoch(readEpochRecord(storage), origin));
  });
}

export function advanceHostedAuthRevocation<T>(
  backendUrl: string,
  revokeLocal: (epoch: HostedAuthEpoch) => T | PromiseLike<T>,
): Promise<T> {
  const origin = hostedOrigin(backendUrl);
  return withAuthLock(() => {
    const storage = authStorage();
    if (!storage) throw new Error("durable authentication storage is unavailable");
    const record = readEpochRecord(storage);
    const epoch = advanceEpoch(record, origin, "revoked");
    writeEpochRecord(storage, record);
    storage.removeItem(AUTH_ATTEMPT);
    return revokeLocal(epoch);
  });
}

function clearPersistedHostedAuthAttempt(): void {
  try { authStorage()?.removeItem(AUTH_ATTEMPT); } catch { /* storage unavailable */ }
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

export async function consumePersistedHostedAuthAttempt(
  state: string,
  access: HostedAuthAccess,
  nowMs: number = Date.now(),
): Promise<PersistedHostedAuthAttempt | null> {
  return withAuthLock(() => {
    const storage = authStorage();
    if (!storage) return null;
    let raw: string | null = null;
    try { raw = storage.getItem(AUTH_ATTEMPT); storage.removeItem(AUTH_ATTEMPT); }
    catch { return null; }
    if (!raw || !AUTH_STATE.test(state)) return null;
    try {
      const record = JSON.parse(raw) as PersistedHostedAuthAttempt;
      if (!record || typeof record !== "object" || Array.isArray(record)
          || Reflect.ownKeys(record).length !== 6
          || record.v !== 1 || record.provider !== "clay"
          || !AUTH_STATE.test(record.state) || record.state !== state
          || !AUTH_EPOCH.test(record.epoch)
          || !Number.isSafeInteger(record.createdAt) || record.createdAt > nowMs
          || nowMs - record.createdAt > AUTH_ATTEMPT_MAX_AGE_MS
          || access.provider !== "clay" || !access.backendUrl) return null;
      const backendUrl = normalizeBackendUrl(record.backendUrl);
      if (backendUrl !== record.backendUrl
          || normalizeBackendUrl(access.backendUrl) !== backendUrl) return null;
      const epoch = currentEpoch(readEpochRecord(storage), hostedOrigin(backendUrl));
      if (epoch.epoch !== record.epoch || epoch.state !== "pending") return null;
      return Object.freeze({ ...record });
    } catch { return null; }
  });
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

  begin(backendUrl: string): Promise<HostedAuthAttempt> {
    this.#controller?.abort(new Error("hosted authentication was superseded"));
    const controller = new AbortController();
    this.#controller = controller;
    const generation = ++this.#generation;
    const normalized = normalizeBackendUrl(backendUrl);
    const state = mintAuthState();
    return withAuthLock(() => {
      if (controller.signal.aborted || generation !== this.#generation)
        throw new Error("hosted authentication was superseded");
      const storage = authStorage();
      if (!storage) throw new Error("durable authentication storage is unavailable");
      const record = readEpochRecord(storage);
      const epoch = advanceEpoch(record, hostedOrigin(normalized), "pending");
      writeEpochRecord(storage, record);
      const attempt = Object.freeze({
        generation, epoch: epoch.epoch, backendUrl: normalized, state,
        signal: controller.signal,
      });
      storage.setItem(AUTH_ATTEMPT, JSON.stringify({
        v: 1, provider: "clay", backendUrl: attempt.backendUrl,
        state: attempt.state, epoch: attempt.epoch, createdAt: Date.now(),
      } satisfies PersistedHostedAuthAttempt));
      return attempt;
    });
  }

  resume(record: PersistedHostedAuthAttempt): HostedAuthAttempt {
    this.#controller?.abort(new Error("hosted authentication was superseded"));
    const controller = new AbortController();
    this.#controller = controller;
    return Object.freeze({
      generation: ++this.#generation, epoch: record.epoch, backendUrl: record.backendUrl,
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

function epochMatchesAttempt(epoch: HostedAuthEpoch, attempt: HostedAuthAttempt): boolean {
  return epoch.epoch === attempt.epoch && epoch.state === "pending";
}

async function revokeReturnedSession(
  attempt: HostedAuthAttempt,
  session: string,
  revoke: (backendUrl: string, session: string) => Promise<void>,
): Promise<void> {
  try { await revoke(attempt.backendUrl, session); }
  catch { /* local authorization remains denied even if the network is unavailable */ }
}

export async function commitHostedAuthAttempt(
  fence: HostedAuthFence,
  attempt: HostedAuthAttempt,
  access: () => HostedAuthAccess,
  session: string,
  prepareWorker: () => Promise<boolean>,
  publishStorage: () => void,
  revoke: (backendUrl: string, session: string) => Promise<void> = logoutHostedBearerSession,
): Promise<boolean> {
  let committed = false;
  try {
    await withAuthLock(async () => {
      const storage = authStorage();
      if (!storage || !fence.isCurrent(attempt, access())) return;
      const origin = hostedOrigin(attempt.backendUrl);
      let record = readEpochRecord(storage);
      if (!epochMatchesAttempt(currentEpoch(record, origin), attempt)) return;
      let applied = false;
      try { applied = await prepareWorker(); } catch { return; }
      if (!applied || !fence.isCurrent(attempt, access())) return;

      // Re-read immediately before publication. The Web Lock excludes other
      // cooperating tabs; the re-read also rejects out-of-band storage writes.
      record = readEpochRecord(storage);
      if (!epochMatchesAttempt(currentEpoch(record, origin), attempt)) return;
      record.origins[origin] = Object.freeze({ epoch: attempt.epoch, state: "granted" });
      writeEpochRecord(storage, record);
      try {
        publishStorage();
        committed = true;
      } catch {
        advanceEpoch(record, origin, "revoked");
        writeEpochRecord(storage, record);
      }
    });
  } catch { /* malformed/unavailable authority fails closed */ }
  if (!committed) await revokeReturnedSession(attempt, session, revoke);
  return committed;
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
  let current = fence.isCurrent(attempt, access());
  if (current) {
    try {
      current = await reconcileHostedAuthEpoch(
        attempt.backendUrl, epoch => epochMatchesAttempt(epoch, attempt),
      );
    } catch { current = false; }
  }
  if (!current) {
    if (session) await revokeReturnedSession(attempt, session, revoke);
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
