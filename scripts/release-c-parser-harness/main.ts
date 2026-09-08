import { ReleaseCParserWorkerClient } from "../../packages/shell/src/worker/release-c/import-worker-client";

const APP_INSTANCE_ID = `app_${"a".repeat(26)}`;
const workerUrl = new URL(
  "../../packages/shell/src/worker/release-c/import-worker.ts",
  import.meta.url,
);

type HarnessInput = Readonly<{
  kind: "csv" | "paste";
  text: string;
}>;

type HarnessResult = Readonly<{
  descriptor: Readonly<{
    appInstanceId: string;
    kind: string;
    sourceDigest: string;
    totalRows: number;
  }>;
  rows: readonly (readonly string[])[];
  disposed: boolean;
}>;

declare global {
  interface Window {
    releaseCParserRun(input: HarnessInput): Promise<HarnessResult>;
  }
}

window.releaseCParserRun = async input => {
  const client = new ReleaseCParserWorkerClient(() =>
    new Worker(workerUrl, { type: "module", name: "clay-release-c-parser" }));
  let sessionId: string | null = null;
  let closed = false;
  try {
    const bytes = new TextEncoder().encode(input.text).buffer;
    const descriptor = await client.openImportSource({
      appInstanceId: APP_INSTANCE_ID,
      kind: input.kind,
      bytes,
    });
    sessionId = descriptor.sessionId;
    const rows: string[][] = [];
    let cursor = 0;
    for (let page = 0; page <= 5_000; page++) {
      const chunk = await client.readImportChunk({
        appInstanceId: APP_INSTANCE_ID,
        sessionId,
        cursor,
      });
      rows.push(...chunk.rows.map(row => [...row]));
      if (chunk.nextCursor === null) break;
      if (chunk.nextCursor <= cursor || page === 5_000)
        throw new Error("parser cursor did not advance within its closed bound");
      cursor = chunk.nextCursor;
    }
    const close = await client.closeImportSource({
      appInstanceId: APP_INSTANCE_ID,
      sessionId,
      reason: "cancel",
    });
    closed = close.disposed;
    return Object.freeze({
      descriptor: Object.freeze({
        appInstanceId: descriptor.appInstanceId,
        kind: descriptor.kind,
        sourceDigest: descriptor.sourceDigest,
        totalRows: descriptor.sheets[0]?.range.rows ?? 0,
      }),
      rows: Object.freeze(rows.map(row => Object.freeze(row))),
      disposed: closed,
    });
  } finally {
    if (sessionId !== null && !closed) {
      try {
        await client.closeImportSource({
          appInstanceId: APP_INSTANCE_ID,
          sessionId,
          reason: "cancel",
        });
      } catch {
        // The boundary already failed closed; dispose terminates the worker.
      }
    }
    client.dispose();
  }
};

export {};
