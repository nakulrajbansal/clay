import { describe, expect, it } from "vitest";
import {
  StoreRpcClient,
  type AsyncStore,
  type MessagePortLike,
  type StoreRequest,
  type StoreResponse,
} from "../src/asyncstore";

function respondingPort(sent: StoreRequest[]): MessagePortLike {
  let receive: ((message: unknown) => void) | null = null;
  return {
    onMessage(callback) { receive = callback; },
    send(message) {
      const request = message as StoreRequest;
      sent.push(request);
      queueMicrotask(() => receive?.({
        id: request.id,
        ok: true,
        result: { id: "row", name: "Changed" },
      } satisfies StoreResponse));
    },
  };
}

describe("StoreRpc retry identity", () => {
  it("preserves one caller-owned request id across transport attempts", async () => {
    const sent: StoreRequest[] = [];
    const store: AsyncStore = new StoreRpcClient(respondingPort(sent));
    const context = { requestId: `req_${"a".repeat(26)}` };

    await store.update("projects", "row", { name: "Changed" }, context);
    await store.update("projects", "row", { name: "Changed" }, context);

    expect(sent).toHaveLength(2);
    expect(sent.map(request => request.requestId)).toEqual([
      context.requestId, context.requestId,
    ]);
  });
});
