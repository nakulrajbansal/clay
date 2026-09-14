import { createStarterSeedBundle } from "../shells/seed";
import { captureComputeRequest, captureComputeReply } from "./pure-compute-contract";

/** One immutable task, one private port; no state, handles or authority. */
export function servePureCompute(port: MessagePort): void {
  port.onmessage = event => {
    port.onmessage = null;
    try {
      const request = captureComputeRequest(event.data);
      // Preserve historical field insertion order too: record-event envelopes
      // intentionally retain that order even when the request hash is canonical.
      const fragment = JSON.stringify(createStarterSeedBundle(request.starter));
      port.postMessage(captureComputeReply({ ...request, fragment }));
    } catch { port.postMessage(null); }
    finally { port.close(); }
  };
  port.onmessageerror = () => port.close();
  port.start();
}
