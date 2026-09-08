import {
  IMPORT_ACQUISITION_LIMITS,
  ImportSourceDescriptorSchema,
  type ImportSourceDescriptor,
  type ImportSourceKind,
} from "@clay/kernel/import-contracts";
import {
  ImportParserError,
  parseDelimitedSource,
} from "./csv-parser";

export type OpenImportSourceInput = {
  appInstanceId: string;
  kind: Extract<ImportSourceKind, "csv" | "paste" | "xlsx">;
  bytes: ArrayBuffer;
};

export type ReadImportChunkInput = {
  appInstanceId: string;
  sessionId: string;
  sheetId?: string;
  cursor: number;
};

export type CloseImportSourceInput = {
  appInstanceId: string;
  sessionId: string;
  reason: "cancel" | "commit" | "restart" | "app_switch" | "timeout";
};

export type ImportParserChunk = {
  sessionId: string;
  cursor: number;
  startRow: number;
  rows: string[][];
  nextCursor: number | null;
  serializedBytes: number;
};

type ParserSession = {
  appInstanceId: string;
  descriptor: ImportSourceDescriptor;
  sourceBytes: Uint8Array;
  rows: string[][] | null;
  activeSheetId: string | null;
  xlsx: {
    readSheet(sheetId: string): Promise<string[][]>;
  } | null;
  lastAccessAt: number;
};

type SessionStoreOptions = {
  sessionId?: () => string;
  now?: () => number;
};

export const IMPORT_SESSION_IDLE_TIMEOUT_MS = 5 * 60 * 1_000;
export const IMPORT_CHUNK_ENVELOPE_RESERVE_BYTES = 128;

const textEncoder = new TextEncoder();

function randomSessionId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const bytes = crypto.getRandomValues(new Uint8Array(17));
  let bits = 0;
  let value = 0;
  let encoded = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && encoded.length < 26) {
      bits -= 5;
      encoded += alphabet[(value >>> bits) & 31];
      value &= (1 << bits) - 1;
    }
  }
  return `import_${encoded}`;
}

function measureChunk(chunk: ImportParserChunk): number {
  let measured = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    chunk.serializedBytes = measured;
    const next = textEncoder.encode(JSON.stringify(chunk)).byteLength;
    if (next === measured) return measured;
    measured = next;
  }
  chunk.serializedBytes = measured;
  return textEncoder.encode(JSON.stringify(chunk)).byteLength;
}

/**
 * Worker-owned, in-memory source sessions. No instance is reachable from the
 * shell's DB worker or canonical store.
 */
export class ImportParserSessionStore {
  private readonly sessions = new Map<string, ParserSession>();
  private readonly nextSessionId: () => string;
  private readonly now: () => number;
  private activeAppInstanceId: string | null = null;
  private openEpoch = 0;
  private pendingOpens = 0;

  constructor(options: SessionStoreOptions = {}) {
    this.nextSessionId = options.sessionId ?? randomSessionId;
    this.now = options.now ?? (() => performance.now());
  }

  private disposeSession(sessionId: string, session: ParserSession): void {
    session.sourceBytes.fill(0);
    if (session.rows !== null) {
      for (const row of session.rows) row.fill("");
      session.rows.length = 0;
      session.rows = null;
    }
    this.sessions.delete(sessionId);
  }

  private disposeAllSessions(): void {
    for (const [sessionId, session] of this.sessions) this.disposeSession(sessionId, session);
  }

  async openImportSource(input: OpenImportSourceInput): Promise<ImportSourceDescriptor> {
    const epoch = ++this.openEpoch;
    this.disposeAllSessions();
    this.activeAppInstanceId = input.appInstanceId;
    this.pendingOpens++;
    const sourceBytes = new Uint8Array(input.bytes);
    let parsedRows: string[][] | null = null;
    let retained = false;
    try {
      if (input.kind === "xlsx") {
        const { openXlsxWorkbook } = await import("./xlsx-adapter");
        const workbook = await openXlsxWorkbook(sourceBytes);
        if (epoch !== this.openEpoch || this.activeAppInstanceId !== input.appInstanceId)
          throw new ImportParserError("E_IMPORT_SESSION_UNKNOWN", "session");
        const sessionId = this.nextSessionId();
        const descriptor = ImportSourceDescriptorSchema.parse({
          version: 1,
          sessionId,
          appInstanceId: input.appInstanceId,
          kind: input.kind,
          sourceDigest: workbook.sourceDigest,
          sheets: workbook.sheets,
          limits: IMPORT_ACQUISITION_LIMITS,
        });
        this.sessions.set(sessionId, {
          appInstanceId: input.appInstanceId,
          descriptor,
          sourceBytes,
          rows: null,
          activeSheetId: null,
          xlsx: workbook,
          lastAccessAt: this.now(),
        });
        retained = true;
        return descriptor;
      }
      const parsed = await parseDelimitedSource({
        kind: input.kind,
        bytes: sourceBytes,
      });
      parsedRows = parsed.rows;
      if (epoch !== this.openEpoch || this.activeAppInstanceId !== input.appInstanceId)
        throw new ImportParserError("E_IMPORT_SESSION_UNKNOWN", "session");
      const sessionId = this.nextSessionId();
      const descriptor = ImportSourceDescriptorSchema.parse({
        version: 1,
        sessionId,
        appInstanceId: input.appInstanceId,
        kind: input.kind,
        sourceDigest: parsed.sourceDigest,
        sheets: [{
          sheetId: "source",
          label: input.kind === "paste" ? "Pasted text" : "Delimited text",
          visibility: "visible",
          range: { rows: parsed.rows.length, columns: parsed.columns },
        }],
        limits: IMPORT_ACQUISITION_LIMITS,
      });
      this.sessions.set(sessionId, {
        appInstanceId: input.appInstanceId,
        descriptor,
        sourceBytes,
        rows: parsed.rows,
        activeSheetId: "source",
        xlsx: null,
        lastAccessAt: this.now(),
      });
      retained = true;
      return descriptor;
    } finally {
      this.pendingOpens--;
      if (!retained) {
        sourceBytes.fill(0);
        if (parsedRows !== null) {
          for (const row of parsedRows) row.fill("");
          parsedRows.length = 0;
        }
      }
    }
  }

  private chunk(session: ParserSession, input: ReadImportChunkInput): ImportParserChunk {
    if (session.rows === null) throw new ImportParserError("E_IMPORT_SESSION_UNKNOWN", "session");
    const rows = session.rows;
    if (!Number.isSafeInteger(input.cursor) || input.cursor < 0 || input.cursor >= rows.length)
      throw new ImportParserError("E_IMPORT_SESSION_UNKNOWN", "session");

    const selected: string[][] = [];
    let end = input.cursor;
    while (end < rows.length && selected.length < IMPORT_ACQUISITION_LIMITS.maxChunkRows) {
      const candidateRows = [...selected, rows[end]!];
      const candidate: ImportParserChunk = {
        sessionId: input.sessionId,
        cursor: input.cursor,
        startRow: input.cursor + 1,
        rows: candidateRows,
        nextCursor: end + 1 < rows.length ? end + 1 : null,
        serializedBytes: 0,
      };
      if (measureChunk(candidate) + IMPORT_CHUNK_ENVELOPE_RESERVE_BYTES
          > IMPORT_ACQUISITION_LIMITS.maxChunkBytes) break;
      selected.push(rows[end]!);
      end++;
    }
    if (selected.length === 0)
      throw new ImportParserError("E_IMPORT_CHUNK_LIMIT", "chunk");
    const chunk: ImportParserChunk = {
      sessionId: input.sessionId,
      cursor: input.cursor,
      startRow: input.cursor + 1,
      rows: selected,
      nextCursor: end < rows.length ? end : null,
      serializedBytes: 0,
    };
    chunk.serializedBytes = measureChunk(chunk);
    return chunk;
  }

  private async loadXlsxSheet(
    session: ParserSession,
    input: ReadImportChunkInput,
    sheetId: string,
  ): Promise<ImportParserChunk> {
    if (!session.xlsx) throw new ImportParserError("E_IMPORT_SESSION_UNKNOWN", "session");
    const rows = await session.xlsx.readSheet(sheetId);
    if (this.sessions.get(input.sessionId) !== session
        || this.activeAppInstanceId !== input.appInstanceId) {
      for (const row of rows) row.fill("");
      rows.length = 0;
      throw new ImportParserError("E_IMPORT_SESSION_UNKNOWN", "session");
    }
    session.rows = rows;
    session.activeSheetId = sheetId;
    session.lastAccessAt = this.now();
    return this.chunk(session, input);
  }

  async readImportChunk(input: ReadImportChunkInput): Promise<ImportParserChunk> {
    const session = this.sessions.get(input.sessionId);
    if (!session || session.appInstanceId !== input.appInstanceId)
      throw new ImportParserError("E_IMPORT_SESSION_UNKNOWN", "session");
    if (this.now() - session.lastAccessAt > IMPORT_SESSION_IDLE_TIMEOUT_MS) {
      this.disposeSession(input.sessionId, session);
      throw new ImportParserError("E_IMPORT_SESSION_UNKNOWN", "session");
    }
    session.lastAccessAt = this.now();
    if (session.xlsx === null) {
      if (input.sheetId !== undefined && input.sheetId !== "source")
        throw new ImportParserError("E_IMPORT_SESSION_UNKNOWN", "session");
      return this.chunk(session, input);
    }
    const sheetId = input.sheetId
      ?? session.descriptor.sheets.find(sheet => sheet.visibility === "visible")?.sheetId;
    if (!sheetId || !session.descriptor.sheets.some(sheet => sheet.sheetId === sheetId))
      throw new ImportParserError("E_IMPORT_SESSION_UNKNOWN", "session");
    if (session.activeSheetId !== sheetId) {
      if (input.cursor !== 0) throw new ImportParserError("E_IMPORT_SESSION_UNKNOWN", "session");
      if (session.rows !== null) {
        for (const row of session.rows) row.fill("");
        session.rows.length = 0;
        session.rows = null;
      }
      return this.loadXlsxSheet(session, input, sheetId);
    }
    return this.chunk(session, input);
  }

  closeImportSource(input: CloseImportSourceInput): { disposed: true } {
    const session = this.sessions.get(input.sessionId);
    if (!session || session.appInstanceId !== input.appInstanceId)
      throw new ImportParserError("E_IMPORT_SESSION_UNKNOWN", "session");
    this.disposeSession(input.sessionId, session);
    return { disposed: true };
  }

  restart(): void {
    this.openEpoch++;
    this.disposeAllSessions();
    this.activeAppInstanceId = null;
  }

  expireIdleSessions(): number {
    const now = this.now();
    let disposed = 0;
    for (const [sessionId, session] of this.sessions) {
      if (now - session.lastAccessAt <= IMPORT_SESSION_IDLE_TIMEOUT_MS) continue;
      this.disposeSession(sessionId, session);
      disposed++;
    }
    if (this.sessions.size === 0 && this.pendingOpens === 0) this.activeAppInstanceId = null;
    return disposed;
  }
}
