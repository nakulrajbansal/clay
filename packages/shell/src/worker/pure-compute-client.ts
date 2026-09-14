import { ClayError } from "@clay/kernel/errors";
import type { ComputeSourceV1, ComputeRequestV1 } from "@clay/schema/standalone/pure-compute";
import { canonicalSeedJson, captureComputeReply, captureComputeRequest } from "./pure-compute-contract";
import manifest from "./seed-manifest.json";

const encoder = new TextEncoder();
const failure = () => new ClayError("E_CONFLICT", "Starter computation was interrupted or invalid. Retry the same starter.");
const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");

/** Owns a CPU worker, never a Store. No invocation is durable at this stage. */
export class SeedComputeClient {
  #cancel: (() => void) | null = null;
  constructor(private readonly createWorker: () => Worker = () =>
    new Worker(new URL("./pure-compute-worker.ts", import.meta.url), { type: "module" })) {}

  seed(starter: unknown, source: ComputeSourceV1): Promise<unknown> {
    if (this.#cancel) return Promise.reject(failure());
    const request = captureComputeRequest({ v: 1, kind: "starter", starter, source,
      nonce: hex(crypto.getRandomValues(new Uint8Array(32))) });
    const expected = manifest.fragments[request.starter];
    if (manifest.version !== 1 || !expected) return Promise.reject(failure());
    return new Promise((resolve, reject) => {
      let worker: Worker | null = null;
      const channel = new MessageChannel();
      let finished = false, received = false;
      const finish = (error?: unknown, result?: unknown) => {
        if (finished) return;
        finished = true; clearTimeout(timer); this.#cancel = null;
        channel.port1.close(); channel.port2.close(); worker?.terminate();
        if (error) reject(failure()); else resolve(result);
      };
      const timer = setTimeout(() => finish(failure()), 15_000);
      this.#cancel = () => finish(failure());
      channel.port1.onmessage = event => {
        if (finished) return;
        if (received) { finish(failure()); return; }
        received = true;
        void (async () => {
          try {
            const reply = captureComputeReply(event.data);
            const { fragment, ...echo } = reply;
            if (JSON.stringify(echo) !== JSON.stringify(request)) throw failure();
            const bytes = encoder.encode(fragment);
            if (bytes.byteLength !== expected.bytes || bytes.byteLength > 900_000) throw failure();
            const digest = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
            if (digest !== expected.wireSha256) throw failure();
            const parsed: unknown = JSON.parse(fragment);
            const canonicalDigest = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(canonicalSeedJson(parsed)))));
            if (canonicalDigest !== expected.sha256) throw failure();
            // Both exact historical wire order and canonical output are pinned.
            // The authority still recaptures and validates every plan/panel before writes.
            finish(undefined, parsed);
          } catch (error) { finish(error); }
        })();
      };
      channel.port1.onmessageerror = () => finish(failure());
      channel.port1.start();
      try {
        worker = this.createWorker();
        worker.onerror = worker.onmessageerror = () => finish(failure());
        worker.postMessage("clay-pure-compute-v1", [channel.port2]);
        channel.port1.postMessage(request satisfies ComputeRequestV1);
      } catch (error) { finish(error); }
    });
  }
  close(): void { this.#cancel?.(); }
}
