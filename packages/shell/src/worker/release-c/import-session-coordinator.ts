import {
  inferImportColumns,
  prepareExistingTableImport,
  recommendHeaderCandidate,
  uuidv7,
  type CommitImportResult,
  type ExistingTableImportPreview,
  type ImportReceipt,
  type PreparedExistingTableImport,
  type RegColumn,
} from "@clay/kernel";
import { ClayError } from "@clay/kernel/errors";
import {
  ImportParserChunkSchema,
  ImportSourceDescriptorSchema,
  type ConfigureExistingTableImport,
  type ExistingTableImportMapping,
  type ExistingTableImportMode,
  type ImportHeaderChoice,
  type ImportParserChunk,
  type ImportSourceDescriptor,
} from "@clay/kernel/import-staging-contracts";
import type { ProductionStoreAuthority } from "@clay/kernel/worker-authority";

export type BeginImportInput = {
  descriptor: ImportSourceDescriptor;
  targetTable: string;
  sheetId?: string;
};

export type StageImportChunkInput = {
  appInstanceId: string;
  chunk: ImportParserChunk;
};

export type ConfigureImportInput = ConfigureExistingTableImport;

export type ImportStructure = {
  complete: boolean;
  receivedRows: number;
  totalRows: number;
  sample: string[][];
  headerCandidate: ReturnType<typeof recommendHeaderCandidate>;
  inferredColumns: ReturnType<typeof inferImportColumns>;
  targetColumns: Array<Pick<RegColumn, "name" | "label" | "type" | "required">>;
};

export type ImportCoordinatorPreview = ExistingTableImportPreview & {
  idempotencyKey: string;
};

type CoordinatorSession = {
  descriptor: ImportSourceDescriptor;
  sheetId: string;
  targetTable: string;
  rows: string[][];
  complete: boolean;
  configuration: ConfigureImportInput | null;
  prepared: PreparedExistingTableImport | null;
  idempotencyKey: string | null;
  receiptId: string | null;
};

const WRITABLE = new Set([
  "text", "rich_text", "integer", "number", "date", "boolean", "enum",
]);

type UnknownRecord = Record<string, unknown>;
const record = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: UnknownRecord, keys: readonly string[]): boolean =>
  Object.keys(value).every(key => keys.includes(key));

function parseHeader(value: unknown): ImportHeaderChoice | null {
  if (!record(value)) return null;
  if (value.mode === "no_header" && exact(value, ["mode"])) return { mode: "no_header" };
  return value.mode === "header" && exact(value, ["mode", "sourceRow"])
    && Number.isInteger(value.sourceRow) && Number(value.sourceRow) >= 1
    && Number(value.sourceRow) <= 5_001
    ? { mode: "header", sourceRow: Number(value.sourceRow) } : null;
}

function parseMapping(value: unknown): ExistingTableImportMapping | null {
  if (!record(value) || !exact(value,
    ["sourceColumn", "targetField", "blankMode", "numberRule", "dateRule"])
      || !Number.isInteger(value.sourceColumn) || Number(value.sourceColumn) < 1
      || Number(value.sourceColumn) > 20 || typeof value.targetField !== "string"
      || value.targetField.length < 1 || value.targetField.length > 64
      || (value.blankMode !== undefined
        && !["leave", "clear", "empty_text"].includes(String(value.blankMode)))) return null;
  const date = value.dateRule;
  if (date !== undefined && (!record(date) || !exact(date, ["kind", "order", "separator"])
      || (date.kind !== "iso" && !(date.kind === "ordered"
        && (date.order === "mdy" || date.order === "dmy")
        && (date.separator === "/" || date.separator === "-"))))) return null;
  const number = value.numberRule;
  if (number !== undefined) {
    if (!record(number) || !exact(number, ["grammar", "affix", "percentScale"])
        || !["ungrouped_dot_decimal", "comma_grouped_dot_decimal",
          "dot_grouped_comma_decimal"].includes(String(number.grammar))
        || !["none", "zero_to_one", "zero_to_hundred"].includes(String(number.percentScale)))
      return null;
    const affix = number.affix;
    if (affix !== null && (!record(affix) || !exact(affix, ["symbol", "position"])
        || !["$", "€", "£", "¥"].includes(String(affix.symbol))
        || (affix.position !== "prefix" && affix.position !== "suffix"))) return null;
  }
  return value as ExistingTableImportMapping;
}

function parseConfiguration(value: unknown): ConfigureExistingTableImport | null {
  if (!record(value) || !exact(value, ["sessionId", "header", "mode", "mappings"])
      || typeof value.sessionId !== "string" || !/^import_[a-z2-7]{26}$/.test(value.sessionId)
      || !Array.isArray(value.mappings) || value.mappings.length < 1
      || value.mappings.length > 20 || !record(value.mode)) return null;
  const header = parseHeader(value.header);
  const mappings = value.mappings.map(parseMapping);
  const mode = value.mode;
  const parsedMode: ExistingTableImportMode | null = mode.kind === "append"
    && exact(mode, ["kind"]) ? { kind: "append" }
    : mode.kind === "upsert" && exact(mode, ["kind", "matchField"])
      && typeof mode.matchField === "string" && mode.matchField.length >= 1
      && mode.matchField.length <= 64 ? { kind: "upsert", matchField: mode.matchField } : null;
  if (!header || !parsedMode || mappings.some(mapping => mapping === null)) return null;
  const complete = mappings as ExistingTableImportMapping[];
  if (new Set(complete.map(mapping => mapping.sourceColumn)).size !== complete.length
      || new Set(complete.map(mapping => mapping.targetField)).size !== complete.length
      || (parsedMode.kind === "upsert"
        && !complete.some(mapping => mapping.targetField === parsedMode.matchField))) return null;
  return { sessionId: value.sessionId, header, mode: parsedMode, mappings: complete };
}

/** DB-worker-owned staged analysis. Cells never enter a panel or model boundary. */
export class ImportSessionCoordinator {
  private session: CoordinatorSession | null = null;

  constructor(private readonly authority: ProductionStoreAuthority) {}

  hasOpenSession(): boolean {
    return this.session !== null;
  }

  private selectedAppId(): string {
    return this.authority.bootInfo().selectedAppInstanceId;
  }

  private mustSession(sessionId: string): CoordinatorSession {
    const session = this.session;
    if (!session || session.descriptor.sessionId !== sessionId)
      throw new ClayError("E_VALIDATION", "unknown import session");
    if (session.descriptor.appInstanceId !== this.selectedAppId()) {
      this.dispose();
      throw new ClayError("E_CONFLICT", "the import source belongs to another app");
    }
    return session;
  }

  private dispose(): void {
    if (!this.session) return;
    for (const row of this.session.rows) row.fill("");
    this.session.rows.length = 0;
    this.session.configuration = null;
    this.session.prepared = null;
    this.session.idempotencyKey = null;
    this.session.receiptId = null;
    this.session = null;
  }

  beginImport(input: BeginImportInput): ImportStructure {
    const descriptor = ImportSourceDescriptorSchema.parse(input.descriptor);
    if (descriptor.kind !== "csv" && descriptor.kind !== "paste" && descriptor.kind !== "xlsx")
      throw new ClayError("E_VALIDATION", "this import source kind is unavailable");
    if (descriptor.appInstanceId !== this.selectedAppId())
      throw new ClayError("E_CONFLICT", "the import source belongs to another app");
    const sheetId = descriptor.kind === "xlsx" ? input.sheetId : descriptor.sheets[0]?.sheetId;
    if (!sheetId || (descriptor.kind === "xlsx" && input.sheetId === undefined)
        || !descriptor.sheets.some(sheet => sheet.sheetId === sheetId))
      throw new ClayError("E_VALIDATION", "select one workbook sheet before staging rows");
    const target = this.authority.readStore().registrySnapshot().get(input.targetTable);
    if (!target || target.inactive)
      throw new ClayError("E_TABLE_UNKNOWN", "the selected import target is unavailable");
    this.dispose();
    this.session = {
      descriptor,
      sheetId,
      targetTable: input.targetTable,
      rows: [],
      complete: false,
      configuration: null,
      prepared: null,
      idempotencyKey: null,
      receiptId: null,
    };
    return this.importStructure(descriptor.sessionId);
  }

  stageImportChunk(input: StageImportChunkInput): ImportStructure {
    const chunk = ImportParserChunkSchema.parse(input.chunk);
    const session = this.mustSession(chunk.sessionId);
    if (session.descriptor.appInstanceId !== input.appInstanceId) {
      this.dispose();
      throw new ClayError("E_CONFLICT", "the import source belongs to another app");
    }
    if (session.complete || chunk.cursor !== session.rows.length
        || chunk.startRow !== session.rows.length + 1)
      throw new ClayError("E_VALIDATION", "import chunks must be staged once in source order");
    const expected = session.descriptor.sheets.find(sheet => sheet.sheetId === session.sheetId)!.range;
    if (session.rows.length + chunk.rows.length > expected.rows
        || chunk.rows.some(row => row.length !== expected.columns))
      throw new ClayError("E_VALIDATION", "an import chunk does not match its source descriptor");
    for (const row of chunk.rows) session.rows.push([...row]);
    if (chunk.nextCursor === null) {
      if (session.rows.length !== expected.rows)
        throw new ClayError("E_VALIDATION", "the staged import source is incomplete");
      session.complete = true;
    } else if (chunk.nextCursor !== session.rows.length) {
      throw new ClayError("E_VALIDATION", "an import chunk cursor is inconsistent");
    }
    session.configuration = null;
    session.prepared = null;
    session.idempotencyKey = null;
    session.receiptId = null;
    return this.importStructure(chunk.sessionId);
  }

  importStructure(sessionId: string, selectedHeader?: ImportHeaderChoice): ImportStructure {
    const session = this.mustSession(sessionId);
    const candidate = recommendHeaderCandidate(session.rows.slice(0, 10));
    let header: ImportHeaderChoice;
    if (selectedHeader === undefined) header = candidate.recommendedRow === null
      ? { mode: "no_header" }
      : { mode: "header", sourceRow: candidate.recommendedRow };
    else {
      const parsed = parseHeader(selectedHeader);
      if (!parsed) throw new ClayError("E_VALIDATION", "import header choice is invalid");
      header = parsed;
    }
    const table = this.authority.readStore().registrySnapshot().get(session.targetTable)!;
    return {
      complete: session.complete,
      receivedRows: session.rows.length,
      totalRows: session.descriptor.sheets.find(sheet => sheet.sheetId === session.sheetId)!.range.rows,
      sample: session.rows.slice(0, 10).map(row => [...row]),
      headerCandidate: candidate,
      inferredColumns: session.rows.length === 0 ? [] : inferImportColumns(session.rows, header),
      targetColumns: table.columns.filter(column =>
        !column.hidden && !column.inactive && WRITABLE.has(column.type))
        .map(column => ({
          name: column.name,
          ...(column.label === undefined ? {} : { label: column.label }),
          type: column.type,
          required: column.required,
        })),
    };
  }

  configureImport(input: ConfigureImportInput): void {
    const configuration = parseConfiguration(input);
    if (!configuration) throw new ClayError("E_VALIDATION", "import configuration is invalid");
    const session = this.mustSession(configuration.sessionId);
    if (!session.complete) throw new ClayError("E_VALIDATION", "finish reading the source first");
    session.configuration = configuration;
    session.prepared = null;
    session.idempotencyKey = null;
    session.receiptId = null;
  }

  private completeTargetRows(table: string): ReturnType<ProductionStoreAuthority["query"]> {
    const rows: ReturnType<ProductionStoreAuthority["query"]> = [];
    let afterId: string | null = null;
    while (true) {
      const page = this.authority.readStore().query({
        from: table,
        orderBy: [{ field: "id", dir: "asc" }],
        limit: 500,
        ...(afterId === null ? {} : {
          where: [{ field: "id", op: "gt" as const, value: afterId }],
        }),
      });
      rows.push(...page);
      if (page.length < 500) break;
      afterId = String(page.at(-1)!.id);
    }
    return rows;
  }

  previewImport(sessionId: string): ImportCoordinatorPreview {
    const session = this.mustSession(sessionId);
    if (!session.complete || !session.configuration)
      throw new ClayError("E_VALIDATION", "confirm import headers and field mappings first");
    if (!session.prepared) {
      const reader = this.authority.readStore();
      const target = reader.registrySnapshot().get(session.targetTable);
      if (!target) throw new ClayError("E_CONFLICT", "the import target changed");
      session.prepared = prepareExistingTableImport({
        appInstanceId: this.selectedAppId(),
        sessionId: session.descriptor.sessionId,
        sourceKind: session.descriptor.kind as "csv" | "paste",
        sourceDigest: session.descriptor.sourceDigest,
        baseVersion: reader.headVersion(),
        sourceRows: session.rows,
        header: session.configuration.header,
        target,
        existingRows: this.completeTargetRows(target.name),
        mode: session.configuration.mode,
        mappings: session.configuration.mappings,
      });
      session.idempotencyKey = this.authority.createRequestId();
      session.receiptId = uuidv7();
    }
    return {
      ...structuredClone(session.prepared.preview),
      idempotencyKey: session.idempotencyKey!,
    };
  }

  async commitImport(input: {
    sessionId: string;
    previewId: string;
    previewDigest: string;
    idempotencyKey: string;
  }): Promise<CommitImportResult> {
    const session = this.mustSession(input.sessionId);
    const preview = this.previewImport(input.sessionId);
    if (input.previewId !== preview.previewId || input.previewDigest !== preview.previewDigest
        || input.idempotencyKey !== preview.idempotencyKey)
      throw new ClayError("E_CONFLICT", "the reviewed import preview is stale");
    if (!preview.commitAllowed)
      throw new ClayError("E_VALIDATION", "resolve blocking import issues before confirming");
    const committed = await this.authority.executeMutation({
      requestId: preview.idempotencyKey,
      route: "import.commit",
      payload: {
        ...session.prepared!.envelope,
        receiptId: session.receiptId!,
        summary: `Import ${session.prepared!.preview.target.label}`,
      },
    });
    const result = committed.result as CommitImportResult;
    if (!result || typeof result !== "object"
        || (result.kind !== "receipt" && result.kind !== "no_change"))
      throw new ClayError("E_INTERNAL", "authoritative import returned an invalid result");
    this.dispose();
    return structuredClone(result);
  }

  cancelImport(sessionId: string): { disposed: true } {
    this.mustSession(sessionId);
    this.dispose();
    return { disposed: true };
  }

  async undoImport(receiptId: string, requestId = this.authority.createRequestId()): Promise<ImportReceipt> {
    const result = await this.authority.executeMutation({
      requestId,
      route: "import.undo",
      payload: { receiptId },
    });
    const receipt = result.result as ImportReceipt;
    if (!receipt || receipt.kind !== "receipt" || receipt.id !== receiptId || !receipt.undone)
      throw new ClayError("E_INTERNAL", "authoritative import undo returned an invalid receipt");
    return structuredClone(receipt);
  }
}
