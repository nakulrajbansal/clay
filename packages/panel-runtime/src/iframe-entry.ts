// The fixed iframe bootstrap entry (doc 06 §2), built to a single IIFE the
// shell inlines into each panel's srcdoc. The shell transfers a MessagePort
// once; everything else flows over the Bridge protocol.
import { bootPanelRuntime } from "./runtime";

window.addEventListener("message", (ev: MessageEvent) => {
  const data = ev.data as { type?: string } | null;
  if (data?.type !== "clay_boot_port" || !ev.ports[0]) return;
  const port = ev.ports[0];
  const container = document.getElementById("root");
  if (!container) return;
  bootPanelRuntime({
    port: {
      send: (msg) => port.postMessage(msg),
      onMessage: (cb) => { port.onmessage = (e): void => cb(e.data); },
    },
    container,
    onPanelError: (e) => {
      // W3 wires this to the error boundary; until then it must be visible
      console.error("[clay panel]", e);
    },
  });
}, { once: false });
