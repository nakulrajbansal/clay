import { describe, expect, it } from "vitest";
import { WorkerClient } from "../src/app/worker-client";

type Posted = { id: number; op: string; payload: Record<string, unknown> };

function harness(): { client: WorkerClient; posted: Posted[] } {
  const posted: Posted[] = [];
  const worker = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage(message: Posted): void {
      posted.push(message);
      queueMicrotask(() => this.onmessage?.({
        data: { id: message.id, ok: true, result: null },
      }));
    },
    terminate(): void {},
  };
  return { client: new WorkerClient(worker as unknown as Worker), posted };
}

describe("WorkerClient model credential boundary", () => {
  it.each(["codex", "openai", "anthropic"] as const)(
    "never serializes a Clay session for %s",
    async provider => {
      const { client, posted } = harness();
      await client.setModelAccess({
        provider,
        apiKey: provider === "anthropic" ? "anthropic-key" : null,
        backendUrl: provider === "anthropic" ? null : "http://127.0.0.1:8788",
        session: "clay-session-secret",
      });
      expect(posted[0]!.payload).not.toHaveProperty("session");
    },
  );

  it("serializes a session only for Clay hosted", async () => {
    const { client, posted } = harness();
    await client.setModelAccess({
      provider: "clay", apiKey: null, backendUrl: "https://clay.example",
      session: "clay-session-secret",
    });
    expect(posted[0]!.payload.session).toBe("clay-session-secret");
  });

  it("serializes a Codex connector token in a provider-specific field", async () => {
    const { client, posted } = harness();
    await client.setModelAccess({
      provider: "codex", apiKey: null, backendUrl: "http://127.0.0.1:8788",
      session: "clay-session-secret", providerToken: "connector-token",
    });
    expect(posted[0]!.payload).toMatchObject({
      provider: "codex", providerToken: "connector-token",
    });
    expect(posted[0]!.payload).not.toHaveProperty("session");
  });
});
