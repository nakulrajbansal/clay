/**
 * Closed, machine-readable classification of every production DB-worker,
 * Store RPC, Bridge, and public ClayStore route which can reach durable state.
 *
 * `authority` routes must enter the worker-owned ProductionStoreAuthority.
 * `unavailable` routes are deliberately disabled until their complete state
 * transition can be represented by that authority.  They must never fall back
 * to a raw Store or driver write.
 */
export type MutationRouteEnforcement =
  | "read"
  | "ephemeral"
  | "shadow"
  | "boot"
  | "authority"
  | "planner-authority"
  | "authority-store-port"
  | "unavailable";

export type MutationRouteClassification = {
  enforcement: MutationRouteEnforcement;
  mutates: "none" | "shadow" | "live" | "lifecycle";
};

const route = (
  enforcement: MutationRouteEnforcement,
  mutates: MutationRouteClassification["mutates"],
): MutationRouteClassification => ({ enforcement, mutates });

export const DB_WORKER_ROUTE_CENSUS = Object.freeze({
  boot: route("boot", "lifecycle"),
  setModelAccess: route("ephemeral", "none"),
  forkApp: route("unavailable", "lifecycle"),
  deleteApp: route("unavailable", "lifecycle"),
  seed: route("authority", "live"),
  importTable: route("authority", "live"),
  panels: route("read", "none"),
  panelProvenance: route("read", "none"),
  semanticTrace: route("read", "none"),
  fieldProvenance: route("read", "none"),
  recordPrivateMetric: route("authority", "live"),
  privateMetricsSummary: route("read", "none"),
  setPrivateMetricsEnabled: route("authority", "live"),
  clearPrivateMetrics: route("authority", "live"),
  commitLayout: route("authority", "live"),
  history: route("read", "none"),
  setCheckpoint: route("authority", "live"),
  panelsAt: route("read", "none"),
  makeLatest: route("authority", "live"),
  registryTables: route("read", "none"),
  storePort: route("authority-store-port", "live"),
  intent: route("planner-authority", "live"),
  repairPanel: route("planner-authority", "live"),
  revertPanel: route("authority", "live"),
  renamePanel: route("authority", "live"),
  addAttachment: route("authority", "live"),
  attachmentsForRecord: route("read", "none"),
  readAttachment: route("read", "none"),
  removeAttachment: route("authority", "live"),
  attachmentStorage: route("read", "none"),
  purgeDeletedAttachments: route("authority", "live"),
  listAutomations: route("read", "none"),
  upsertAutomation: route("authority", "live"),
  deleteAutomation: route("authority", "live"),
  simulateAutomation: route("read", "none"),
  runAutomations: route("authority", "live"),
  runAutomationNow: route("authority", "live"),
  automationRuns: route("read", "none"),
  undoAutomationRun: route("authority", "live"),
  notifications: route("read", "none"),
  markNotificationRead: route("authority", "live"),
  globalSearch: route("read", "none"),
  applyBatch: route("authority", "live"),
  operationBatches: route("read", "none"),
  undoBatch: route("authority", "live"),
  rowHistory: route("read", "none"),
  previewRelationConversion: route("read", "none"),
  convertTextToRelation: route("unavailable", "live"),
  addColumn: route("authority", "live"),
  addRelationColumn: route("authority", "live"),
  renameColumn: route("authority", "live"),
  removeColumn: route("authority", "live"),
  removePanel: route("authority", "live"),
  keep: route("planner-authority", "live"),
  discard: route("planner-authority", "live"),
  removeSamples: route("authority", "live"),
  fillSamples: route("authority", "live"),
  sampleCount: route("read", "none"),
  restoreRow: route("authority", "live"),
  restorableRows: route("read", "none"),
  suggestions: route("read", "none"),
  recordFilter: route("authority", "live"),
  dismissSuggestion: route("authority", "live"),
  acceptSuggestion: route("authority", "live"),
  reset: route("unavailable", "lifecycle"),
  exportArchive: route("unavailable", "live"),
  importArchive: route("unavailable", "lifecycle"),
  status: route("read", "none"),
  requestPersist: route("ephemeral", "none"),
  debugLog: route("read", "none"),
  getSetting: route("read", "none"),
  setSetting: route("authority", "live"),
  deleteSetting: route("authority", "live"),
  compareAndSetSetting: route("authority", "live"),
} as const satisfies Record<string, MutationRouteClassification>);

export const STORE_RPC_ROUTE_CENSUS = Object.freeze({
  query: route("read", "none"),
  insert: route("authority", "live"),
  update: route("authority", "live"),
  softDelete: route("authority", "live"),
  registryTables: route("read", "none"),
} as const satisfies Record<string, MutationRouteClassification>);

export const BRIDGE_WRITE_ROUTE_CENSUS = Object.freeze({
  "db.query": route("read", "none"),
  "db.watch": route("read", "none"),
  "db.unwatch": route("ephemeral", "none"),
  "db.insert": route("authority", "live"),
  "db.update": route("authority", "live"),
  "db.softDelete": route("authority", "live"),
} as const satisfies Record<string, MutationRouteClassification>);

/** Public Store methods with durable write reachability. */
export const CLAY_STORE_WRITER_CENSUS = Object.freeze({
  openMemory: "boot",
  fromDriver: "boot",
  recordPrivateMetric: "authority",
  setPrivateMetricsEnabled: "authority",
  clearPrivateMetrics: "authority",
  setSetting: "authority",
  recordSampleRowProvenance: "authority",
  deleteSetting: "authority",
  scrubLegacyCredentialSettings: "unavailable",
  commit: "unavailable",
  commitPreparedMutation: "unavailable",
  commitLayout: "authority",
  renamePanel: "authority",
  removePanel: "authority",
  setCheckpoint: "authority",
  beginAttempt: "unavailable",
  finishAttempt: "unavailable",
  rollbackTo: "unavailable",
  rollForwardTo: "unavailable",
  convertTextToRelation: "unavailable",
  insert: "authority",
  recordUsage: "authority",
  markSuggestionShown: "unavailable",
  dismissSuggestion: "authority",
  acceptSuggestion: "authority",
  addAttachment: "authority",
  removeAttachment: "authority",
  purgeDeletedAttachments: "authority",
  upsertAutomation: "authority",
  deleteAutomation: "authority",
  runAutomationNow: "authority",
  runDueAutomations: "authority",
  undoAutomationRun: "authority",
  markNotificationRead: "authority",
  applyBatch: "authority",
  undoBatch: "authority",
  restoreRow: "authority",
  update: "authority",
  softDelete: "authority",
  revertPanel: "authority",
  exportArchive: "unavailable",
  replaceFromArchive: "unavailable",
  importArchive: "unavailable",
} as const satisfies Record<string, "boot" | "authority" | "unavailable">);