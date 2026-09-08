import { describe, expect, it } from "vitest";
import { readBoundedResponseText } from "../src/bounded-response";

function responseFrom(chunks: readonly Uint8Array[], onCancel?: () => void): Response {
  let index = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index === chunks.length) { controller.close(); return; }
      controller.enqueue(chunks[index++]!);
    },
    cancel() { onCancel?.(); },
  }));
}

describe("bounded response text", () => {
  it("decodes UTF-8 split across stream chunks without buffering an unbounded body", async () => {
    const text = new TextEncoder().encode("A🙂Z");
    const response = responseFrom([text.subarray(0, 3), text.subarray(3)]);
    await expect(readBoundedResponseText(response, 16)).resolves.toBe("A🙂Z");
  });

  it("cancels the reader as soon as aggregate bytes exceed the cap", async () => {
    let cancelled = false;
    const response = responseFrom([
      new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6]), new Uint8Array(1_000_000),
    ], () => { cancelled = true; });
    await expect(readBoundedResponseText(response, 5)).rejects.toThrow(/exceeds.*5 bytes/i);
    expect(cancelled).toBe(true);
  });

  it("rejects malformed UTF-8", async () => {
    const response = responseFrom([new Uint8Array([0xc3, 0x28])]);
    await expect(readBoundedResponseText(response, 16)).rejects.toThrow(/UTF-8/i);
  });
});
