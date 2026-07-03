// @clay/kernel public API. Shell code may import ONLY from here (doc 02 §7).
export type { Query } from "@clay/schema";
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
  createSystemTables, openBrowserDriver, openMemoryDriver,
  type DbDriver, type SqlRow, type SqlValue,
} from "./db";
export { compileQuery, runQuery, type CompiledQuery, type QueryRow } from "./query";
export { coerceValue, nowIso, uuidv7, validateInsert, validatePatch } from "./rows";
export {
  applyForwardOps, applyInverseOps, deriveInverse, validateMigrationPlan,
  type ForwardOpT, type InverseOpT, type MigrationPlanT,
} from "./migrate";
export {
  ClayStore,
  type CommitInput, type LivePanel, type PanelBlobInput, type VersionEntry,
} from "./store";
export {
  MutationPipeline, defaultSmokeTest,
  type AttemptResult, type Planner, type PlannerContext, type PlannerResult,
  type PreviewHandle, type SmokeTest,
} from "./pipeline";
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
