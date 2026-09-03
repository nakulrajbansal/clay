// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { bindNativeMessagePort } from "../src/iframe-entry";

describe("fixed iframe port adapter", () => {
  it("keeps captured port methods after generated code mutates the object", () => {
    const sent: string[] = [];
    let listener: ((event: MessageEvent) => void) | undefined;
    const port = {
      postMessage: (message: unknown) => { sent.push(`native:${String(message)}`); },
      addEventListener: (_name: string, cb: (event: MessageEvent) => void) => { listener = cb; },
      start: () => { sent.push("started"); },
    };
    const bound = bindNativeMessagePort(port);
    port.postMessage = message => { sent.push(`patched:${String(message)}`); };
    bound.send("grant");
    const received: unknown[] = [];
    bound.onMessage(message => received.push(message));
    listener?.(new MessageEvent("message", { data: "boot" }));
    expect(sent).toEqual(["native:grant", "started"]);
    expect(received).toEqual(["boot"]);
  });
});
