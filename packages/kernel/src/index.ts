// @clay/kernel public API. Shell code may import ONLY from here (doc 02 §7).
export type { Query } from "@clay/schema";
export { BLUEPRINT_KINDS, expandBlueprint, parseBlueprintDirective,
  type BlueprintResult } from "./blueprints";
export { ClayError, type ClayErrorCode } from "./errors";
export {
  compileExpr, evalExpr, parseExpr, typecheckExpr, exprFields,
  type ExprAst, type ExprScope, type ExprType, type ExprValue,
} from "./expr";
export {
  KERNEL_COLUMNS, KERNEL_COLUMN_NAMES,
  cloneRegistry, columnTypeToExprType, exprScope, findColumn, getTable,
  physicalColumns, registryToJson, resolveField,
  type ColumnKind, type RegColumn, type RegTable, type Registry,
} from "./registry";
export {
  copyDatabase, createSystemTables, deleteAppStorage, openBrowserDriver,
  openDriverFromBytes, openMemoryDriver, wipeBrowserStorage,
  type DbDriver, type SqlRow, type SqlValue,
} from "./db";
export { crc32, zipRead, zipWrite, type ZipEntry } from "./zip";
export { compileQuery, runQuery, type CompiledQuery, type QueryRow } from "./query";
export { coerceValue, nowIso, uuidv7, validateInsert, validatePatch } from "./rows";
export {
  applyForwardOps, applyInverseOps, deriveInverse, validateMigrationPlan,
  type ForwardOpT, type InverseOpT, type MigrationPlanT,
} from "./migrate";
export {
  ClayStore,
  type ClayManifest, type CommitInput, type HistoryEntry, type LivePanel,
  type PanelBlobInput, type VersionEntry,
} from "./store";
export {
  MutationPipeline, defaultSmokeTest,
  type AttemptResult, type DebugEvent, type Planner, type PlannerContext,
  type PlannerResult, type PreviewHandle, type SmokeTest,
} from "./pipeline";
export { Observer, type Suggestion, type UsageEvent } from "./observe";
export {
  InProcessAsyncStore, StoreRpcClient, portFromMessagePort, serveStore,
  type AsyncStore, type MessagePortLike, type StoreRequest, type StoreResponse,
} from "./asyncstore";
export {
  Bridge, queryMatchesDeclared,
  type BridgeHooks, type BridgeLimits, type PanelManifest,
} from "./bridge";
export {
  FORBIDDEN_IDENTIFIERS, validateMutationPlan,
  type ValidationIssue, type ValidatorContext,
} from "./validate";
