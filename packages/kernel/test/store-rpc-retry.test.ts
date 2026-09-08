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
  it("closes admission and echoes the Store quiescence challenge", async () => {
    const sent: unknown[] = [];
    let receive!: (message: unknown) => void;
    const port: MessagePortLike = {
      onMessage(callback) { receive = callback; },
      send(message) { sent.push(message); },
    };
    const store = new StoreRpcClient(port);
    const nonce = `stq_${"b".repeat(26)}`;
    receive({ v: 1, kind: "store.quiesce", nonce });
    expect(sent).toEqual([{ v: 1, kind: "store.quiesced", nonce }]);
    await expect(store.query({ from: "projects" })).rejects.toMatchObject({ code: "E_CONFLICT" });
  });

  it("defers Store quiescence acknowledgement until admitted responses settle", async () => {
    const sent: unknown[] = [];
    let receive!: (message: unknown) => void;
    const store = new StoreRpcClient({
      onMessage(callback) { receive = callback; },
      send(message) { sent.push(message); },
    });
    const pending = store.query({ from: "projects" });
    const request = sent[0] as StoreRequest;
    const nonce = `stq_${"c".repeat(26)}`;

    receive({ v: 1, kind: "store.quiesce", nonce });
    expect(sent).toEqual([request]);
    await expect(store.registryTables()).rejects.toMatchObject({ code: "E_CONFLICT" });

    receive({ id: request.id, ok: true, result: [{ id: "row" }] } satisfies StoreResponse);
    await expect(pending).resolves.toEqual([{ id: "row" }]);
    expect(sent).toEqual([request, { v: 1, kind: "store.quiesced", nonce }]);
  });

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
