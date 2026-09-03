// The fixed iframe bootstrap entry (doc 06 §2), built to a single IIFE the
// shell inlines into each panel's srcdoc. The shell transfers a MessagePort
// once; everything else flows over the Bridge protocol.
import { bootPanelRuntime } from "./runtime";

type NativeMessagePortLike = {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  start?(): void;
};

/** Capture native transport methods before any generated panel code executes. */
export function bindNativeMessagePort(port: NativeMessagePortLike): {
  send(message: unknown): void;
  onMessage(callback: (message: unknown) => void): void;
} {
  const postMessage = port.postMessage.bind(port);
  const addEventListener = port.addEventListener.bind(port);
  const start = port.start?.bind(port);
  return {
    send: message => postMessage(message),
    onMessage: callback => {
      addEventListener("message", event => callback(event.data));
      start?.();
    },
  };
}

window.addEventListener("message", (ev: MessageEvent) => {
  const data = ev.data as { type?: string } | null;
  if (data?.type !== "clay_boot_port" || !ev.ports[0]) return;
  const port = ev.ports[0];
  const container = document.getElementById("root");
  if (!container) return;
  bootPanelRuntime({
    port: bindNativeMessagePort(port),
    container,
    onPanelError: (e) => {
      // W3 wires this to the error boundary; until then it must be visible
      console.error("[clay panel]", e);
    },
  });
}, { once: false });
