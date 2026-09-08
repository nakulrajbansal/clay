// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  HostedAuthFence, advanceHostedAuthRevocation, captureHostedAuthLanding,
  commitHostedAuthAttempt, consumePersistedHostedAuthAttempt,
  HOSTED_ACCOUNT_CHANGE_KEY, logoutHostedBearerSession, logoutHostedSession,
  observeHostedAccountChanges, publishHostedAccountChange, reconcileHostedAuthEpoch,
  redeemHostedAuthAttempt,
} from "../src/app/account-auth";

beforeEach(() => {
  localStorage.clear();
  let tail = Promise.resolve();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request<T>(
        _name: string,
        _options: { mode: "exclusive" },
        callback: () => T | PromiseLike<T>,
      ): Promise<T> {
        const result = tail.then(() => callback());
        tail = result.then(() => undefined, () => undefined);
        return result;
      },
    },
  });
});

describe("hosted account authorization", () => {
  it("persists and one-use consumes an exact navigation-bound attempt", async () => {
    localStorage.clear();
    const started = Date.now();
    const attempt = await new HostedAuthFence().begin("https://a.example/clay");
    expect(attempt.state).toMatch(/^[0-9a-f]{64}$/);

    expect(await consumePersistedHostedAuthAttempt(attempt.state, {
      provider: "clay", backendUrl: "https://a.example/clay",
    }, started + 1_000)).toMatchObject({
      state: attempt.state, backendUrl: "https://a.example/clay", provider: "clay",
    });
    expect(await consumePersistedHostedAuthAttempt(attempt.state, {
      provider: "clay", backendUrl: "https://a.example/clay",
    }, started + 1_001)).toBeNull();
  });

  it("consumes stale, expired, or backend-mismatched attempts without authorizing", async () => {
    localStorage.clear();
    const started = Date.now();
    const first = await new HostedAuthFence().begin("https://a.example/clay");
    expect(await consumePersistedHostedAuthAttempt(first.state, {
      provider: "clay", backendUrl: "https://b.example/clay",
    }, started + 1_000)).toBeNull();
    const second = await new HostedAuthFence().begin("https://a.example/clay");
    expect(await consumePersistedHostedAuthAttempt(second.state, {
      provider: "clay", backendUrl: "https://a.example/clay",
    }, started + 16 * 60_000)).toBeNull();
  });

  it("captures only a bounded complete auth fragment", () => {
    const state = "a".repeat(64);
    expect(captureHostedAuthLanding(
      `https://clay.example/#auth=complete&token=${"b".repeat(43)}&state=${state}`,
    )).toEqual({ token: "b".repeat(43), state });
    expect(captureHostedAuthLanding("https://clay.example/#auth=complete&token=x&state=y"))
      .toBeNull();
  });

  it("redeems a persisted attempt after navigation with a fresh fence", async () => {
    localStorage.clear();
    const firstFence = new HostedAuthFence();
    const started = await firstFence.begin("https://a.example/clay");
    const persisted = await consumePersistedHostedAuthAttempt(started.state, {
      provider: "clay", backendUrl: "https://a.example/clay",
    });
    expect(persisted).not.toBeNull();
    const nextFence = new HostedAuthFence();
    const resumed = nextFence.resume(persisted!);
    const session = "c".repeat(48);
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ session }), {
      status: 200, headers: { "content-type": "application/json" },
    }));

    await expect(redeemHostedAuthAttempt(
      nextFence, resumed, "b".repeat(48),
      () => ({ provider: "clay", backendUrl: "https://a.example/clay" }),
      fetchFn as typeof fetch,
    )).resolves.toBe(session);
    expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({ credentials: "omit" });
  });

  it("token-only revokes a delayed callback superseded before its body resolves", async () => {
    localStorage.clear();
    const fence = new HostedAuthFence();
    const attempt = await fence.begin("https://a.example/clay");
    let release!: (response: Response) => void;
    const fetchFn = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      new Promise<Response>(resolve => { release = resolve; }));
    const revoke = vi.fn(async () => undefined);
    const completion = redeemHostedAuthAttempt(
      fence, attempt, "b".repeat(48),
      () => ({ provider: "clay", backendUrl: "https://a.example/clay" }),
      fetchFn as typeof fetch, revoke,
    );
    await fence.begin("https://b.example/clay");
    const staleSession = "c".repeat(48);
    release(new Response(JSON.stringify({ session: staleSession }), {
      status: 200, headers: { "content-type": "application/json" },
    }));

    await expect(completion).resolves.toBeNull();
    expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({ credentials: "omit" });
    expect(revoke).toHaveBeenCalledWith("https://a.example/clay", staleSession);
  });

  it("posts remote logout for a cookie-only session", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 204 }));

    await logoutHostedSession("https://clay.example/api/", null, fetchFn as typeof fetch);

    expect(fetchFn).toHaveBeenCalledOnce();
    expect(fetchFn).toHaveBeenCalledWith("https://clay.example/api/auth/logout", {
      method: "POST",
      credentials: "include",
      headers: {},
      signal: expect.any(AbortSignal),
    });
  });

  it("revokes a stale bearer without sending or clearing ambient cookies", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 204 }));
    const staleSession = ["stale", "session"].join("-");
    await logoutHostedBearerSession(
      "https://clay.example/api", staleSession, fetchFn as typeof fetch,
    );
    const authorization = ["Bearer", staleSession].join(" ");
    expect(fetchFn).toHaveBeenCalledWith("https://clay.example/api/auth/logout", {
      method: "POST", credentials: "omit",
      headers: { authorization }, signal: expect.any(AbortSignal),
    });
  });

  it("reports non-successful remote logout", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 500 }));
    await expect(logoutHostedSession(
      "https://clay.example", null, fetchFn as typeof fetch,
    )).rejects.toThrow(/logout.*500/i);
  });

  it("delivers an origin-bound account generation to another tab", () => {
    localStorage.clear();
    const target = new EventTarget();
    const seen: unknown[] = [];
    const stop = observeHostedAccountChanges(change => seen.push(change), target);
    const change = publishHostedAccountChange("https://a.example/clay", "revoked");
    const stored = localStorage.getItem(HOSTED_ACCOUNT_CHANGE_KEY);
    target.dispatchEvent(new StorageEvent("storage", {
      key: HOSTED_ACCOUNT_CHANGE_KEY, newValue: stored,
    }));
    expect(seen).toEqual([change]);
    stop();
    target.dispatchEvent(new StorageEvent("storage", {
      key: HOSTED_ACCOUNT_CHANGE_KEY, newValue: stored,
    }));
    expect(seen).toHaveLength(1);
  });

  it("invalidates delayed sign-in attempts across provider, backend, and sign-out changes", async () => {
    const fence = new HostedAuthFence();
    const first = await fence.begin("https://a.example/clay");
    expect(fence.isCurrent(first, {
      provider: "clay", backendUrl: "https://a.example/clay",
    })).toBe(true);

    const second = await fence.begin("https://b.example/clay");
    expect(first.signal.aborted).toBe(true);
    expect(fence.isCurrent(first, {
      provider: "clay", backendUrl: "https://a.example/clay",
    })).toBe(false);
    expect(fence.isCurrent(second, {
      provider: "clay", backendUrl: "https://a.example/clay",
    })).toBe(false);
    expect(fence.isCurrent(second, {
      provider: "openai", backendUrl: "https://b.example/clay",
    })).toBe(false);
    expect(fence.isCurrent(second, {
      provider: "clay", backendUrl: "https://b.example/clay",
    })).toBe(true);

    fence.invalidate();
    expect(second.signal.aborted).toBe(true);
    expect(fence.isCurrent(second, {
      provider: "clay", backendUrl: "https://b.example/clay",
    })).toBe(false);
  });

  it("a globally ordered revocation tombstone defeats another tab's delayed callback", async () => {
    const tabA = new HostedAuthFence();
    const started = await tabA.begin("https://a.example/clay");
    const persisted = await consumePersistedHostedAuthAttempt(started.state, {
      provider: "clay", backendUrl: "https://a.example/clay",
    });
    const attempt = tabA.resume(persisted!);
    let release!: (response: Response) => void;
    const fetchFn = vi.fn(() => new Promise<Response>(resolve => { release = resolve; }));
    const revoke = vi.fn(async () => undefined);
    const completion = redeemHostedAuthAttempt(
      tabA, attempt, "b".repeat(48),
      () => ({ provider: "clay", backendUrl: "https://a.example/clay" }),
      fetchFn as typeof fetch, revoke,
    );

    await advanceHostedAuthRevocation("https://a.example/clay", () => undefined);
    const returnedSession = "c".repeat(48);
    release(new Response(JSON.stringify({ session: returnedSession }), {
      status: 200, headers: { "content-type": "application/json" },
    }));

    await expect(completion).resolves.toBeNull();
    expect(revoke).toHaveBeenCalledWith("https://a.example/clay", returnedSession);
  });

  it("atomically refuses storage publication when sign-out advanced the captured epoch", async () => {
    const tabA = new HostedAuthFence();
    const started = await tabA.begin("https://a.example/clay");
    const persisted = await consumePersistedHostedAuthAttempt(started.state, {
      provider: "clay", backendUrl: "https://a.example/clay",
    });
    const attempt = tabA.resume(persisted!);
    const prepareWorker = vi.fn(async () => true);
    const publishStorage = vi.fn();
    const revoke = vi.fn(async () => undefined);
    await advanceHostedAuthRevocation("https://a.example/clay", () => undefined);

    await expect(commitHostedAuthAttempt(
      tabA, attempt,
      () => ({ provider: "clay", backendUrl: "https://a.example/clay" }),
      "d".repeat(48), prepareWorker, publishStorage, revoke,
    )).resolves.toBe(false);
    expect(prepareWorker).not.toHaveBeenCalled();
    expect(publishStorage).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith("https://a.example/clay", "d".repeat(48));
  });

  it("treats storage events only as notifications of authoritative epoch state", async () => {
    const started = await new HostedAuthFence().begin("https://a.example/clay");
    await advanceHostedAuthRevocation("https://a.example/clay", () => undefined);
    const staleNotification = publishHostedAccountChange("https://a.example/clay", "granted");
    expect(staleNotification.state).toBe("granted");
    await expect(reconcileHostedAuthEpoch(
      "https://a.example/clay", state => state,
    )).resolves.toMatchObject({ state: "revoked" });
    expect(started.epoch).toBeDefined();
  });
});
