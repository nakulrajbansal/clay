import {
  ImportParserRequestSchema,
  ImportParserResponseSchema,
  type ImportParserRequest,
  type ImportParserResponse,
  type ImportParserSafeError,
} from "@clay/kernel/import-contracts";
import { ImportParserError } from "./csv-parser";
import { ImportParserSessionStore } from "./parser-session";

const SAFE_MESSAGE = "The import source could not be read safely." as const;

function responseId(value: unknown): number {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return 1;
  const id = (value as Record<string, unknown>).id;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : 1;
}

function safeError(error: unknown): ImportParserSafeError {
  if (!(error instanceof ImportParserError)) {
    return {
      code: "E_IMPORT_PROTOCOL",
      stage: "protocol",
      message: SAFE_MESSAGE,
    };
  }
  return {
    code: error.code,
    stage: error.stage,
    message: SAFE_MESSAGE,
    ...(error.row === undefined ? {} : { row: error.row }),
    ...(error.column === undefined ? {} : { column: error.column }),
    ...(error.limit === undefined ? {} : { limit: error.limit }),
    ...(error.actual === undefined ? {} : { actual: error.actual }),
  };
}

async function dispatch(
  request: ImportParserRequest,
  store: ImportParserSessionStore,
): Promise<unknown> {
  switch (request.op) {
    case "openImportSource":
      return store.openImportSource(request.payload);
    case "readImportChunk":
      return store.readImportChunk(request.payload);
    case "closeImportSource":
      return store.closeImportSource(request.payload);
  }
}

/** Validated worker boundary shared by the real Worker and test harness. */
export async function handleImportParserWorkerRequest(
  value: unknown,
  store: ImportParserSessionStore,
): Promise<ImportParserResponse> {
  const id = responseId(value);
  const parsed = ImportParserRequestSchema.safeParse(value);
  if (!parsed.success) {
    return ImportParserResponseSchema.parse({
      version: 1,
      id,
      ok: false,
      error: safeError(new ImportParserError("E_IMPORT_PROTOCOL", "protocol")),
    });
  }
  try {
    return ImportParserResponseSchema.parse({
      version: 1,
      id: parsed.data.id,
      ok: true,
      result: await dispatch(parsed.data, store),
    });
  } catch (error) {
    return ImportParserResponseSchema.parse({
      version: 1,
      id: parsed.data.id,
      ok: false,
      error: safeError(error),
    });
  }
}
