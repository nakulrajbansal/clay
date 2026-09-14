import { z } from "./validation-runtime";
import { RequestId, ForwardOp } from "./index";
import { ManualBackupDownloadV2 } from "./backup";
import { InboxDispositionV1 } from "./daily-home";
import {DailyCapturePayloadV1,DailyCaptureUndoPayloadV1,DailySourceCasPayloadV1,DailyNavigationCasPayloadV1,DailyInboxActionPayloadV1,DailyInboxUndoPayloadV1} from "./catalog";
export const name = z.string().regex(/^[a-z][a-z0-9_]{0,40}$/);
export const tableId = z.string().regex(/^tbl_[0-9a-f-]{36}$/);
export const rowId = z.string().uuid();
export const captureLedger = z.object({ schema: z.literal(1), entries: z.array(z.object({
  id: rowId, tableId, table: name,
}).strict()).max(200) }).strict();
export const dailyRequest = z.discriminatedUnion("route", [
  z.object({ route: z.literal("daily.source"), payload: DailySourceCasPayloadV1 }),
  z.object({ route: z.literal("daily.navigation"), payload: DailyNavigationCasPayloadV1 }),
  z.object({ route: z.literal("daily.timeZone"), payload: z.object({ timeZone: z.string().min(1).max(128) }).strict() }),
  z.object({ route: z.literal("daily.capture"), payload: DailyCapturePayloadV1 }),
  z.object({ route: z.literal("daily.undoCapture"), payload: DailyCaptureUndoPayloadV1 }),
  z.object({ route: z.literal("daily.inbox"), payload: DailyInboxActionPayloadV1 }),
  z.object({ route: z.literal("daily.undoInbox"), payload: DailyInboxUndoPayloadV1 }),
]);
export const count = z.number().int().nonnegative().max(5_000);
export const ledger = z.object({ schema: z.literal(1), entries: z.array(z.object({
  requestId: RequestId, record: ManualBackupDownloadV2,
}).strict()).max(100) }).strict().refine(value => new Set(value.entries.map(entry => entry.requestId)).size === value.entries.length,
  "duplicate manual-download identities");
export const InboxDispositionWriteV1 = z.object({ expectedRevision: z.number().int().nonnegative().safe(), value: InboxDispositionV1 }).strict();
export const ConversionResultV1 = z.object({ version: z.number().int().positive(), convertedRows: count, sourceField: name, relationField: name }).strict();
export type DailyCommand = z.infer<typeof dailyRequest>;
export const ForwardOpListV1 = z.array(ForwardOp);
export const CaptureResultV1 = z.object({ id: rowId, created: z.array(z.object({ table: name, id: rowId }).strict()).length(1) }).passthrough();
