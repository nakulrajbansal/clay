import { servePureCompute } from "./pure-compute";

// This entry is spawned only by the DB worker. The ambient channel is used
// once to transfer an owned private MessagePort, never for tasks or responses.
self.onmessage = (event: MessageEvent): void => {
  self.onmessage = null;
  if (event.data !== "clay-pure-compute-v1" || event.ports.length !== 1) {
    self.close(); return;
  }
  servePureCompute(event.ports[0]!);
};
