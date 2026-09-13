import { expect, it, vi } from "vitest";
import { boundedRelayJson } from "../src/app/bounded-relay-response";

it("bounds streamed and declared bytes before relay JSON parsing", async () => {
  const cancel = vi.fn(); const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(101)); }, cancel }));
  await expect(boundedRelayJson(response, 100)).rejects.toThrow(/byte bound/); expect(cancel).toHaveBeenCalledTimes(1);
  await expect(boundedRelayJson(new Response("{}", { headers: { "content-length": "101" } }), 100)).rejects.toThrow(/byte bound/);
  await expect(boundedRelayJson(new Response('{"ok":true}'), 100)).resolves.toEqual({ ok: true });
});
it("does not reflect malformed relay error bodies in diagnostics", async () => {
  const marker = "owned-response-marker";
  const message = await boundedRelayJson(new Response(marker), 100).then(() => "unexpected", error => String(error));
  expect(message.includes(marker)).toBe(false); expect(message).toMatch(/malformed/);
});
