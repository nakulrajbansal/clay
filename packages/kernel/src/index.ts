// @clay/kernel public API. Shell code may import ONLY from here (doc 02 §7).
export type { Query } from "@clay/schema";
export { BLUEPRINT_KINDS, expandBlueprint, parseBlueprintDirective,
  type BlueprintResult } from "./blueprints";
export { ClayError, type ClayErrorCode } from "./errors";
export {
  deriveDeviceState, DeviceProtectionInputV1, DeviceStateResultV1, targetIdentityEquals,
  type CheckpointObservation, type DeviceProtectionInput, type DeviceState,
  type DeviceStateResult, type DurableStoreCapability, type ExpectedStoreFailure,
  type ProtectionReasonCode, type TemporaryUserChoice,
} from "./protection";
export {
  compileExpr, evalExpr, parseExpr, typecheckExpr, exprFields,
  type ExprAst, type ExprScope, type ExprType, type ExprValue,
} from "./expr";
export {
  KERNEL_COLUMNS, KERNEL_COLUMN_NAMES,
  cloneRegistry, columnTypeToExprType, exprScope, findColumn, getTable,
  physicalColumns, registryToJson, resolveField,
  type ColumnKind, type LookupFieldSpec, type RegColumn, type RegTable,
  type Registry, type RelationFieldSpec, type RollupFieldSpec,
} from "./registry";
export {
  copyDatabase, createSystemTables, deleteAppStorage, openBrowserDriver,
  openDriverFromBytes, openMemoryDriver, wipeBrowserStorage,
  type DatabaseCopyShape, type DbDriver, type SqlRow, type SqlValue,
} from "./db";
export { crc32, zipRead, zipWrite, type ZipEntry } from "./zip";
export { compileQuery, runQuery, type CompiledQuery, type QueryRow,
  type QueryValue, type RecordLink } from "./query";
export { coerceValue, nowIso, uuidv7, validateInsert, validatePatch } from "./rows";
export {
  DAILY_HOME_SECTION_IDS_V1, DAILY_HOME_SOURCE_IDS_V1,
  type DailyHomeItemV1 as DailyHomeItem,
  type DailyHomeSnapshotV1 as DailyHomeSnapshot,
  type DailySourceLibraryV1 as DailySourceLibrary,
} from "@clay/schema/daily-home";
export {
  buildDailyHomeSnapshot, decodeDailyHomeCursor, deriveDailyHomeSections,
  encodeDailyHomeCursor,
  verifyDailyHomeCursor, verifyDailyHomeSnapshot,
} from "./daily-home-basis";
export {
  OPERATIONAL_VIEWS_SETTING, projectDailyHome,
  type DailyHomeProjectionContext, type DailyHomeProjectionReader,
} from "./daily-home-projection";
export {
  DAILY_NAVIGATION_SETTING, loadDailyNavigationState,
  rememberDailyRecordOpened, toggleDailyFavorite,
  type DailyNavigationState, type DailyNavigationStorage, type DailyRecordReference,
} from "./daily-navigation";
export {
  DAILY_TIME_ZONE_SETTING, localCalendarContext, parseDailyTemporal,
  resolveDailyRelativeDate, resolveLocalDateTime,
} from "./daily-calendar";
export {
  DAILY_SOURCE_LIBRARY_SETTING, loadDailySourceLibrary, removeReviewedDailySource,
  resetDailySourceLibrary, resolveDailySourceProfiles, upsertReviewedDailySource,
  type DailySourceIssueReason, type DailySourceProfileStorage, type DailySourceResolution,
  type ReviewedDailySourceProfile,
} from "./daily-source-profile";
export {
  applyForwardOps, applyInverseOps, deriveInverse, validateMigrationPlan,
  type ForwardOpT, type InverseOpT, type MigrationPlanT,
} from "./migrate";
export {
  validateAutomationDefinition,
  type AutomationAction, type AutomationCondition, type AutomationDefinition,
  type AutomationDefinitionInput, type AutomationRun, type AutomationSimulation,
  type AutomationTrigger, type AutomationValue, type ClayNotification,
} from "./automation";
export {
  ClayStore,
  type AttachmentFile, type AttachmentInput, type AttachmentMetadata,
  type AttachmentStorageSummary, type BatchMutation, type BatchReceipt, type BatchSource,
  type ClayManifest,
  type CommitInput, type FieldProvenance, type GlobalSearchResult, type HistoryEntry, type LivePanel,
  type PanelProvenance, type RelationConversionPreview, type RelationConversionRequest,
  type RelationConversionResult,
  type PanelBlobInput, type VersionEntry,
} from "./store";
export {
  bindingForSemanticOp, createConceptId, createFieldId, createRelationshipId,
  createTableId, isConceptId, isFieldId, isRelationshipId, isTableId,
  type ConceptId, type FieldId, type RelationshipId,
  type SemanticOpBinding, type SemanticSchemaTraceV1, type TableId,
} from "./semantic";
export {
  deriveSafeDiffKind, PrivateMetricEventSchema, PrivateMetricsReducer,
  type PrivateMetricEvent, type PrivateMetricsSummary, type Rate,
} from "./private-metrics";
export {
  MutationPipeline, defaultSmokeTest,
  type AttemptResult, type DebugEvent, type Planner, type PlannerContext,
  type PlannerResult, type PreviewHandle, type SmokeTest,
} from "./pipeline";
export { Observer, type Suggestion, type UsageEvent } from "./observe";
export {
  MetricsCollector, classifyDiffKind,
  type AttemptRecord, type MetricsSummary, type DiffKind, type Outcome,
} from "./metrics";
export {
  InProcessAsyncStore, StoreRpcClient, portFromMessagePort, serveStore,
  type AsyncStore, type MessagePortLike, type StoreMutationContext,
  type StoreRequest, type StoreResponse,
} from "./asyncstore";
export {
  Bridge, queryMatchesDeclared,
  type BridgeHooks, type BridgeLimits, type PanelManifest,
} from "./bridge";
export {
  FORBIDDEN_IDENTIFIERS, validateMutationPlan,
  type ValidationIssue, type ValidatorContext,
} from "./validate";
