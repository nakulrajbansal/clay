import { describe, expect, it, vi } from "vitest";
import {
  MODEL_HEALTH_RESPONSE_MAX_BYTES,
  fetchModelHealth,
} from "../src/app/model-health";

describe("model health transport", () => {
  it("cancels a streamed health response that exceeds the byte cap", async () => {
    let cancelled = false;
    let sent = false;
    const fetchFn = async (): Promise<Response> => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) return;
        sent = true;
        controller.enqueue(new Uint8Array(MODEL_HEALTH_RESPONSE_MAX_BYTES + 1));
      },
      cancel() { cancelled = true; },
    }), { status: 200 });
    await expect(fetchModelHealth("http://127.0.0.1:8788/healthz", { fetchFn }))
      .rejects.toThrow(/exceed|limit/i);
    expect(cancelled).toBe(true);
  });

  it("aborts a stalled health request at its hard deadline", async () => {
    vi.useFakeTimers();
    try {
      let observedSignal: AbortSignal | undefined;
      const fetchFn = async (_url: string, init: { signal: AbortSignal }): Promise<Response> =>
        new Promise((_resolve, reject) => {
          observedSignal = init.signal;
          init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
        });
      const pending = fetchModelHealth("http://127.0.0.1:8788/healthz", {
        fetchFn: fetchFn as never, timeoutMs: 50,
      });
      await Promise.resolve();
      expect(observedSignal).toBeInstanceOf(AbortSignal);
      const rejected = expect(pending).rejects.toThrow(/deadline/i);
      await vi.advanceTimersByTimeAsync(51);
      await rejected;
      expect(observedSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
