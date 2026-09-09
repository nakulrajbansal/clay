import { describe, expect, it, vi } from "vitest";
import {
  LatestRequestGate,
  beginLazySession,
  createRetryingLoader,
  runLatestRequest,
} from "../src/app/async-lifecycle";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe("async UI lifecycle gates", () => {
  it("coalesces an in-flight module load and retries after rejection", async () => {
    const first = deferred<{ value: number }>();
    const load = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ value: 2 });
    const runtime = createRetryingLoader(load);

    const one = runtime();
    const concurrent = runtime();
    expect(concurrent).toBe(one);
    first.reject(new Error("chunk unavailable"));
    await expect(one).rejects.toThrow("chunk unavailable");
    await expect(runtime()).resolves.toEqual({ value: 2 });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("applies only the newest overlapping result", async () => {
    const gate = new LatestRequestGate();
    const first = deferred<string>();
    const second = deferred<string>();
    const applied: string[] = [];
    const oldRun = runLatestRequest(gate, () => first.promise, value => applied.push(value));
    const newRun = runLatestRequest(gate, () => second.promise, value => applied.push(value));

    second.resolve("new");
    await expect(newRun).resolves.toBe("applied");
    first.resolve("old");
    await expect(oldRun).resolves.toBe("stale");
    expect(applied).toEqual(["new"]);
  });

  it("suppresses stale errors and invalidates work during teardown", async () => {
    const gate = new LatestRequestGate();
    const stale = deferred<string>();
    const applied = vi.fn();
    const staleRun = runLatestRequest(gate, () => stale.promise, applied);
    gate.invalidate();
    stale.reject(new Error("old failure"));
    await expect(staleRun).resolves.toBe("stale");
    expect(applied).not.toHaveBeenCalled();

    await expect(runLatestRequest(gate, async () => {
      throw new Error("current failure");
    }, applied)).rejects.toThrow("current failure");
  });

  it("uses unique request tokens that never wrap back to an old request", () => {
    const gate = new LatestRequestGate();
    const first = gate.begin();
    gate.invalidate();
    const next = gate.begin();
    expect(typeof first).toBe("object");
    expect(next).not.toBe(first);
    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(next)).toBe(true);
  });

  it("does not start or report a lazy session after teardown", async () => {
    const loading = deferred<{ id: string }>();
    const start = vi.fn(() => vi.fn());
    const onError = vi.fn();
    const stop = beginLazySession(() => loading.promise, start, onError);
    stop();
    loading.resolve({ id: "late" });
    await loading.promise;
    await Promise.resolve();
    expect(start).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("exposes a session guard that turns false before in-flight work resumes", async () => {
    const loading = deferred<{ id: string }>();
    const work = deferred<string>();
    const applied = vi.fn();
    const stop = beginLazySession(() => loading.promise, (_value, isActive) => {
      void work.promise.then(value => { if (isActive()) applied(value); });
      return () => undefined;
    }, vi.fn());
    loading.resolve({ id: "ready" });
    await loading.promise;
    await Promise.resolve();
    stop();
    work.resolve("stale");
    await work.promise;
    await Promise.resolve();
    expect(applied).not.toHaveBeenCalled();
  });

  it("reports an active lazy-session rejection and stops a started session once", async () => {
    const rejected = deferred<{ id: string }>();
    const onError = vi.fn();
    beginLazySession(() => rejected.promise, vi.fn(), onError);
    const error = new Error("chunk rejected");
    rejected.reject(error);
    await expect(rejected.promise).rejects.toBe(error);
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith(error);

    const cleanup = vi.fn();
    const stop = beginLazySession(async () => ({ id: "ready" }), () => cleanup, onError);
    await Promise.resolve();
    await Promise.resolve();
    stop();
    stop();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
