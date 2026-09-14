import { servePureCompute } from "../../src/worker/pure-compute";

/** Owned MessageChannel transport fixture. Runs the real pure service; not a
 * browser worker/OPFS certificate. No untrusted result bypass in production. */
export class OwnedComputeWorker {
  static transform: ((message: unknown) => unknown) | null = null;
  static pending: Array<() => void> = [];
  static hold = false;
  static fail = false;
  static starts = 0;
  onerror: ((event: Event) => void) | null = null;
  onmessageerror: ((event: Event) => void) | null = null;
  #port: MessagePort | null = null;
  constructor() { OwnedComputeWorker.starts++; }
  postMessage(message: unknown, ports: Transferable[]) {
    if (message !== "clay-pure-compute-v1" || ports.length !== 1) throw new Error("Unexpected compute setup");
    this.#port = ports[0] as MessagePort;
    if (OwnedComputeWorker.fail) { queueMicrotask(() => this.onerror?.(new Event("error"))); return; }
    const send = this.#port.postMessage.bind(this.#port);
    this.#port.postMessage = message => {
      const result = OwnedComputeWorker.transform?.(structuredClone(message)) ?? message;
      const deliver = () => send(result);
      if (OwnedComputeWorker.hold) OwnedComputeWorker.pending.push(deliver); else deliver();
    };
    // Keep the held response's port open, matching a delayed worker event.
    const close = this.#port.close.bind(this.#port);
    this.#port.close = () => { if (!OwnedComputeWorker.hold) close(); };
    servePureCompute(this.#port);
  }
  terminate() { OwnedComputeWorker.hold = false; this.#port?.close(); this.#port = null; }
  static reset() { this.transform = null; this.pending = []; this.hold = false; this.fail = false; this.starts = 0; }
}
