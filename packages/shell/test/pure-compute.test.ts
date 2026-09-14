import { afterEach, describe, expect, it, vi } from "vitest";
import { SeedComputeClient } from "../src/worker/pure-compute-client";
import { servePureCompute } from "../src/worker/pure-compute";
import { createStarterSeedBundle, STARTER_SHELLS } from "../src/shells/seed";
import { captureComputeRequest } from "../src/worker/pure-compute-contract";

const source = { catalogGeneration: "1", target: {
  appInstanceId: `app_${"a".repeat(26)}`, activeGenerationId: `gen_${"b".repeat(26)}`,
  lineageEpoch: "1", protectionRevision: "0", digestSchema: 1 as const, stateSha256: `sha256:${"c".repeat(64)}`,
} };
type Fault = "drop" | "error" | "duplicate" | "stale" | "forged" | "oversize" | "wrong-seed" | "tampered";
function fixture(fault?: Fault) {
  const opened: MessagePort[] = [];
  const workers: Array<{ terminate: ReturnType<typeof vi.fn>; onerror: ((event: Event) => void) | null }> = [];
  const client = new SeedComputeClient(() => {
    const worker = { onerror: null as ((event: Event) => void) | null, onmessageerror: null,
      terminate: vi.fn(() => opened.forEach(port => port.close())),
      postMessage: (_data: unknown, ports: Transferable[]) => {
        const port = ports[0] as MessagePort; opened.push(port);
        const send = port.postMessage.bind(port);
        vi.spyOn(port, "postMessage").mockImplementation(message => {
          const reply = structuredClone(message);
          if (fault === "drop") return;
          if (fault === "error") { worker.onerror?.(new Event("error")); return; }
          if (fault === "stale") reply.source.target.activeGenerationId = `gen_${"d".repeat(26)}`;
          if (fault === "forged") reply.nonce = "d".repeat(64);
          if (fault === "oversize") reply.fragment = "x".repeat(900_001);
          if (fault === "wrong-seed") reply.fragment = JSON.stringify(createStarterSeedBundle("log"));
          if (fault === "tampered") reply.fragment = reply.fragment.replace("Ship the deck", "Flip the deck");
          send(reply);
          if (fault === "duplicate") send(reply);
        });
        servePureCompute(port);
      },
    };
    workers.push(worker); return worker as unknown as Worker;
  });
  return { client, workers, close: () => { client.close(); opened.forEach(port => port.close()); } };
}
afterEach(() => vi.restoreAllMocks());

describe("owned non-authoritative starter computation", () => {
  it.each(STARTER_SHELLS.map(s => s.id))("preserves the exact %s fragment, without executing it", async id => {
    const f = fixture();
    try {
      expect(JSON.stringify(await f.client.seed(id, source))).toBe(JSON.stringify(createStarterSeedBundle(id)));
      expect(f.workers[0]!.terminate).toHaveBeenCalledOnce();
    } finally { f.close(); }
  });
  it.each(["error", "duplicate", "stale", "forged", "oversize", "wrong-seed", "tampered"] as const)("rejects %s and releases the owned channel", async fault => {
    const f = fixture(fault);
    try {
      await expect(f.client.seed("tracker", source)).rejects.toThrow(/computation/);
      expect(f.workers[0]!.terminate).toHaveBeenCalledOnce();
    } finally { f.close(); }
  });
  it("teardown rejects unknown work; a fresh owned worker may retry the same immutable seed", async () => {
    const f = fixture("drop");
    const result = f.client.seed("tracker", source).catch(error => error);
    f.close(); expect(await result).toMatchObject({ code: "E_CONFLICT" });
    const next = fixture();
    try { expect(await next.client.seed("tracker", source)).toEqual(createStarterSeedBundle("tracker")); }
    finally { next.close(); }
  });
  it("times out a silent CPU worker without retaining any invocation or open port", async () => {
    vi.useFakeTimers();
    const f = fixture("drop");
    try {
      const pending = f.client.seed("tracker", source).catch(error => error);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await pending).toMatchObject({ code: "E_CONFLICT" });
      expect(f.workers[0]!.terminate).toHaveBeenCalledOnce();
    } finally { f.close(); vi.useRealTimers(); }
  });
  it("rejects unknown work, prototype/accessor/symbol escapes without invoking accessors", () => {
    const input = { v: 1, kind: "starter", nonce: "a".repeat(64), starter: "tracker", source };
    expect(captureComputeRequest(input)).toEqual(input);
    const getter = vi.fn(() => "tracker");
    for (const value of [{ ...input, kind: "sql", sql: "DELETE" }, { ...input, starter: "unknown" },
      Object.create(input), { ...input, [Symbol()]: true },
      Object.defineProperty({ ...input }, "starter", { get: getter })])
      expect(() => captureComputeRequest(value)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
});
