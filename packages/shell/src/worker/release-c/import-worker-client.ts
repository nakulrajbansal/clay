import {
  CloseImportSourceResultSchema,
  ImportParserChunkSchema,
  ImportParserRequestSchema,
  ImportParserResponseSchema,
  ImportSourceDescriptorSchema,
  type ImportParserChunk,
  type ImportParserRequest,
  type ImportParserSafeError,
  type ImportSourceDescriptor,
} from "@clay/kernel/import-contracts";

export const IMPORT_PARSER_RPC_TIMEOUT_MS = 9_000;

export interface ImportParserWorkerLike {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
}

type ParserOperation = ImportParserRequest["op"];
type PendingCall = {
  op: ParserOperation;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export class ImportParserBoundaryError extends Error {
  readonly name = "ImportParserBoundaryError";

  constructor(readonly safeError: ImportParserSafeError) {
    super(safeError.message);
  }

  get code(): ImportParserSafeError["code"] { return this.safeError.code; }
  get stage(): ImportParserSafeError["stage"] { return this.safeError.stage; }
}

const protocolFailure = (): ImportParserBoundaryError => new ImportParserBoundaryError({
  code: "E_IMPORT_PROTOCOL",
  stage: "protocol",
  message: "The import source could not be read safely.",
});

/**
 * Unwired Release C client. Constructed only by the explicit experimental
 * harness; production App/Data/palette modules do not import this file.
 */
export class ReleaseCParserWorkerClient {
  private readonly worker: ImportParserWorkerLike;
  private readonly pending = new Map<number, PendingCall>();
  private nextId = 1;
  private disposed = false;

  constructor(
    workerFactory: () => ImportParserWorkerLike,
    private readonly rpcTimeoutMs = IMPORT_PARSER_RPC_TIMEOUT_MS,
  ) {
    this.worker = workerFactory();
    this.worker.onmessage = event => this.receive(event.data);
    this.worker.onerror = () => this.abort(protocolFailure());
  }

  private receive(raw: unknown): void {
    const parsed = ImportParserResponseSchema.safeParse(raw);
    if (!parsed.success) {
      this.abort(protocolFailure());
      return;
    }
    const response = parsed.data;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timeout);
    if (!response.ok) {
      pending.reject(new ImportParserBoundaryError(response.error));
      return;
    }
    const resultSchema = pending.op === "openImportSource"
      ? ImportSourceDescriptorSchema
      : pending.op === "readImportChunk"
        ? ImportParserChunkSchema
        : CloseImportSourceResultSchema;
    const result = resultSchema.safeParse(response.result);
    if (!result.success) {
      pending.reject(protocolFailure());
      return;
    }
    pending.resolve(result.data);
  }

  private abort(error: ImportParserBoundaryError): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.terminate();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private call(request: ImportParserRequest, transfer: Transferable[] = []): Promise<unknown> {
    if (this.disposed) return Promise.reject(protocolFailure());
    const validated = ImportParserRequestSchema.safeParse(request);
    if (!validated.success) return Promise.reject(protocolFailure());
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(request.id);
        reject(new ImportParserBoundaryError({
          code: "E_IMPORT_TIME_LIMIT",
          stage: "protocol",
          message: "The import source could not be read safely.",
          limit: this.rpcTimeoutMs,
          actual: this.rpcTimeoutMs,
        }));
        this.abort(protocolFailure());
      }, this.rpcTimeoutMs);
      this.pending.set(request.id, { op: request.op, resolve, reject, timeout });
      this.worker.postMessage(validated.data, transfer);
    });
  }

  openImportSource(input: {
    appInstanceId: string;
    kind: "csv" | "paste" | "xlsx";
    bytes: ArrayBuffer;
  }): Promise<ImportSourceDescriptor> {
    const id = this.nextId++;
    return this.call(
      { version: 1, id, op: "openImportSource", payload: input },
      [input.bytes],
    ) as Promise<ImportSourceDescriptor>;
  }

  readImportChunk(input: {
    appInstanceId: string;
    sessionId: string;
    cursor: number;
  }): Promise<ImportParserChunk> {
    const id = this.nextId++;
    return this.call(
      { version: 1, id, op: "readImportChunk", payload: input },
    ) as Promise<ImportParserChunk>;
  }

  closeImportSource(input: {
    appInstanceId: string;
    sessionId: string;
    reason: "cancel" | "commit" | "restart" | "app_switch" | "timeout";
  }): Promise<{ disposed: true }> {
    const id = this.nextId++;
    return this.call(
      { version: 1, id, op: "closeImportSource", payload: input },
    ) as Promise<{ disposed: true }>;
  }

  dispose(): void {
    this.abort(protocolFailure());
  }
}
