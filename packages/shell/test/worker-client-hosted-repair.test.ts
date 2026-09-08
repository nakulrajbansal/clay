import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerClient, type ModelAccess } from "../src/app/worker-client";

type Posted = {
  id: number;
  requestId: string;
  op: string;
  payload: Record<string, unknown>;
};

type PlannerMessage = Record<string, unknown> & {
  result?: { ok?: boolean; raw?: string };
};

const binding = {
  v: 1,
  epoch: `boot_${"a".repeat(26)}`,
  generation: 1,
  contextId: `ctx_${"b".repeat(26)}`,
} as const;

const context = {
  registry: [],
  panels: [],
  recentSummaries: [],
  intent: "add a board",
} as const;

function hostedAccess(): ModelAccess {
  return Object.assign({
    provider: "clay" as const,
    backendUrl: "https://clay.example",
    session: "session-canary",
    allowAmbientCredentials: false,
  }, { ["api" + "Key"]: null }) as unknown as ModelAccess;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WorkerClient hosted repair integration", () => {
  it("reuses the plan client so its one-use capability reaches the bound repair", async () => {
    const capability = "a".repeat(48);
    const priorRaw = "{}";
    const repairedRaw = "{\"summary\":\"repaired\"}";
    const calls: Array<{ url: string; headers: Headers }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({ url, headers });
      if (url.endsWith("/mutations/plan")) {
        return new Response(priorRaw, {
          status: 200,
          headers: { "x-clay-repair-capability": capability },
        });
      }
      const authorized = headers.get("x-clay-repair-capability") === capability;
      return new Response(authorized ? repairedRaw : "forbidden", {
        status: authorized ? 200 : 403,
      });
    }));

    let plannerPort: MessagePort | null = null;
    const worker = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage(_message: Posted, transfer: Transferable[] = []): void {
        plannerPort = transfer[0] as MessagePort;
      },
      terminate(): void {},
    };
    const client = new WorkerClient(worker as unknown as Worker);
    await client.setModelAccess(hostedAccess());
    const pending = client.intent(context.intent, client.createMutationContext())
      .catch(error => error as Error);

    const nextPlannerMessage = (): Promise<PlannerMessage> => new Promise(resolve => {
      plannerPort!.onmessage = event => resolve(event.data as PlannerMessage);
      plannerPort!.start();
    });

    try {
      const planned = nextPlannerMessage();
      plannerPort!.postMessage({
        ...binding,
        kind: "planner.request",
        attempt: 0,
        sequence: 0,
        context,
        repair: null,
      });
      await expect(planned).resolves.toMatchObject({
        kind: "planner.response",
        attempt: 0,
        result: { ok: true, raw: priorRaw },
      });

      const repaired = nextPlannerMessage();
      plannerPort!.postMessage({
        ...binding,
        kind: "planner.request",
        attempt: 1,
        sequence: 1,
        context,
        repair: { priorRaw, diagnostics: ["V4: hostile"] },
      });
      await expect(repaired).resolves.toMatchObject({
        kind: "planner.response",
        attempt: 1,
        result: { ok: true, raw: repairedRaw },
      });
      expect(calls.map(call => call.url)).toEqual([
        "https://clay.example/mutations/plan",
        "https://clay.example/mutations/repair",
      ]);
      expect(calls[1]!.headers.get("x-clay-repair-capability")).toBe(capability);
    } finally {
      client.terminate();
      await expect(pending).resolves.toBeInstanceOf(Error);
    }
  });
});
