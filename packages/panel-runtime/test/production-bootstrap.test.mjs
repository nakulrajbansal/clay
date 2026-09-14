import vm from "node:vm";
import { JSDOM } from "jsdom";
import { build } from "vite";
import { describe, expect, it } from "vitest";

describe("production fixed panel bootstrap", () => {
  it("minifies the IIFE while preserving components, expression evaluation and captured transport", async () => {
    const result = await build({ logLevel: "silent", build: { write: false } });
    const chunk = (Array.isArray(result) ? result[0] : result).output.find(file => file.type === "chunk");
    expect(chunk.imports).toEqual([]);
    // The fixed bootstrap is inlined by the shell. Do not ship a second copy of
    // its development identifiers/whitespace in every panel frame payload.
    expect(chunk.code.split(/\r?\n/).length).toBeLessThan(10);
    const dom = new JSDOM('<div id="root"></div>', { runScripts: "outside-only" });
    try {
      vm.runInContext(chunk.code, dom.getInternalVMContext());
      const sent = [];
      let receive;
      const port = {
        postMessage(message) { sent.push(message); },
        addEventListener(_type, listener) { receive = listener; },
        start() {},
      };
      dom.window.dispatchEvent(new dom.window.MessageEvent("message", {
        data: { type: "clay_boot_port" }, ports: [port],
      }));
      // Test-owned static code, not generated model output or a new capability.
      const code = `export default function (clay) {
        clay.ui.render(h(Stack, {},
          h(MetricCard, {label: "Total", value: clay.compute.eval("2 + 3", {})}),
          h(Button, {onClick: () => clay.ui.toast("Still connected", "success")}, "Notify")));
      }`;
      port.postMessage = () => { throw new Error("mutable transport was used"); };
      receive({ data: { v: 1, kind: "boot", code, panelId: "owned_test", apiVersion: 1,
        meta: { schema: [], appVersion: 0, placement: { region: "main", order: 0 } }, tokens: {} } });
      await viWait(() => dom.window.document.querySelector("button"));
      expect(dom.window.document.body.textContent).toContain("Total");
      expect(dom.window.document.body.textContent).toContain("5");
      dom.window.document.querySelector("button").click();
      expect(sent.some(message => message.call === "ui.toast" && message.args[0] === "Still connected")).toBe(true);
      expect(sent.some(message => message.kind === "panel_error")).toBe(false);
    } finally { dom.window.close(); }
  });
});

async function viWait(read) {
  // DOM work follows a microtask after module loading, not a browser timing gate.
  for (let attempt = 0; attempt < 20; attempt++) {
    if (read()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error("compiled bootstrap did not render");
}
