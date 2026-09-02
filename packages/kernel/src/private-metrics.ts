import { DiffKind as PlanDiffKindSchema } from "@clay/schema";
import { z } from "zod";

const DurationBucketSchema = z.enum([
  "under_3m", "3_to_10m", "10_to_30m", "over_30m",
]);

export const SafeDiffKindSchema = z.enum([
  ...PlanDiffKindSchema.options,
  "mixed",
  "unknown",
]);

export const PrivateMetricEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("app_ready"),
    entry: z.enum([
      "new_blank", "new_starter", "data_import", "archive_import", "existing",
    ]),
  }).strict(),
  z.object({
    type: z.literal("activation_completed"),
    elapsed: DurationBucketSchema,
  }).strict(),
  z.object({
    type: z.literal("reshape_started"),
    origin: z.enum(["composer", "observer_suggestion", "panel_repair"]),
  }).strict(),
  z.object({
    type: z.literal("reshape_finished"),
    outcome: z.enum(["preview", "clarify", "failed"]),
    repaired: z.boolean(),
    stage: z.enum(["none", "plan", "validate", "dry_run"]),
    diff: SafeDiffKindSchema,
  }).strict(),
  z.object({
    type: z.literal("preview_decided"),
    decision: z.enum(["kept", "discarded"]),
    repaired: z.boolean(),
    diff: SafeDiffKindSchema,
  }).strict(),
  z.object({
    type: z.literal("trust_surface_opened"),
    surface: z.enum(["shape_map", "history", "trust_receipt", "storage_status"]),
  }).strict(),
  z.object({
    type: z.literal("lens_changed"),
    mode: z.enum(["all", "situational"]),
  }).strict(),
  z.object({
    type: z.literal("rewind_finished"),
    source: z.enum(["trust_receipt", "history", "time_slider"]),
    result: z.enum(["success", "cancelled", "failed"]),
    depth: z.enum(["one", "two_to_five", "six_plus"]),
  }).strict(),
  z.object({
    type: z.literal("fault_seen"),
    fault: z.enum(["runtime", "strike_limit", "render_timeout", "unknown"]),
  }).strict(),
  z.object({
    type: z.literal("recovery_finished"),
    method: z.enum(["panel_repair", "panel_revert", "row_restore", "history_rewind"]),
    result: z.enum(["success", "discarded", "failed"]),
  }).strict(),
  z.object({
    type: z.literal("backup_finished"),
    action: z.enum(["export", "import"]),
    result: z.enum(["success", "failed"]),
  }).strict(),
  z.object({
    type: z.literal("proof_loop_completed"),
    elapsed: DurationBucketSchema,
  }).strict(),
]);

export type PlanDiffKind = z.infer<typeof PlanDiffKindSchema>;
export type SafeDiffKind = z.infer<typeof SafeDiffKindSchema>;
export type DurationBucket = z.infer<typeof DurationBucketSchema>;
export type PrivateMetricEvent = z.infer<typeof PrivateMetricEventSchema>;

type EventOf<T extends PrivateMetricEvent["type"]> =
  Extract<PrivateMetricEvent, { type: T }>;
type AppReadyEntry = EventOf<"app_ready">["entry"];
type ReshapeOrigin = EventOf<"reshape_started">["origin"];
type ReshapeOutcome = EventOf<"reshape_finished">["outcome"];
type ReshapeStage = EventOf<"reshape_finished">["stage"];
type PreviewDecision = EventOf<"preview_decided">["decision"];
type TrustSurface = EventOf<"trust_surface_opened">["surface"];
type LensMode = EventOf<"lens_changed">["mode"];
type RewindSource = EventOf<"rewind_finished">["source"];
type RewindResult = EventOf<"rewind_finished">["result"];
type RewindDepth = EventOf<"rewind_finished">["depth"];
type Fault = EventOf<"fault_seen">["fault"];
type RecoveryMethod = EventOf<"recovery_finished">["method"];
type RecoveryResult = EventOf<"recovery_finished">["result"];
type BackupResult = EventOf<"backup_finished">["result"];

const fixedCodes = <T extends Record<string, number>>(codes: T): Readonly<T> =>
  Object.freeze(codes);

export const PRIVATE_METRIC_SCHEMA_VERSION = 1 as const;

export const PRIVATE_METRIC_CODES = fixedCodes({
  appReadyByEntry: 100,
  activationCompletedByElapsed: 110,
  reshapeStartedByOrigin: 200,
  reshapeFinishedByOutcome: 210,
  reshapeFirstPassByOutcome: 211,
  reshapeRepairedByOutcome: 212,
  reshapeFinishedByStage: 213,
  reshapeFinishedByDiff: 214,
  previewDecided: 220,
  previewKeptByDiff: 221,
  previewDiscardedByDiff: 222,
  previewRepairedDecision: 223,
  trustSurfaceOpened: 300,
  lensChanged: 310,
  rewindFinishedByResult: 320,
  rewindFinishedBySource: 321,
  rewindFinishedByDepth: 322,
  faultSeen: 400,
  recoveryFinishedByResult: 410,
  recoveryCompletedByMethod: 411,
  recoverySucceededByMethod: 412,
  backupExportByResult: 500,
  backupImportByResult: 501,
  proofLoopCompletedByElapsed: 600,
} as const);

const appReadyEntry = fixedCodes({
  new_blank: 1, new_starter: 2, data_import: 3, archive_import: 4, existing: 5,
} as const satisfies Record<AppReadyEntry, number>);
const duration = fixedCodes({
  under_3m: 1, "3_to_10m": 2, "10_to_30m": 3, over_30m: 4,
} as const satisfies Record<DurationBucket, number>);
const reshapeOrigin = fixedCodes({
  composer: 1, observer_suggestion: 2, panel_repair: 3,
} as const satisfies Record<ReshapeOrigin, number>);
const reshapeOutcome = fixedCodes({
  preview: 1, clarify: 2, failed: 3,
} as const satisfies Record<ReshapeOutcome, number>);
const reshapeStage = fixedCodes({
  none: 1, plan: 2, validate: 3, dry_run: 4,
} as const satisfies Record<ReshapeStage, number>);
const safeDiff = fixedCodes({
  add_field: 1, change_field: 2, add_panel: 3, change_panel: 4,
  remove_panel: 5, add_status: 6, add_computed: 7, add_chart: 8,
  mixed: 9, unknown: 10,
} as const satisfies Record<SafeDiffKind, number>);
const previewDecision = fixedCodes({
  kept: 1, discarded: 2,
} as const satisfies Record<PreviewDecision, number>);
const trustSurface = fixedCodes({
  shape_map: 1, history: 2, trust_receipt: 3, storage_status: 4,
} as const satisfies Record<TrustSurface, number>);
const lensMode = fixedCodes({
  all: 1, situational: 2,
} as const satisfies Record<LensMode, number>);
const rewindSource = fixedCodes({
  trust_receipt: 1, history: 2, time_slider: 3,
} as const satisfies Record<RewindSource, number>);
const rewindResult = fixedCodes({
  success: 1, cancelled: 2, failed: 3,
} as const satisfies Record<RewindResult, number>);
const rewindDepth = fixedCodes({
  one: 1, two_to_five: 2, six_plus: 3,
} as const satisfies Record<RewindDepth, number>);
const fault = fixedCodes({
  runtime: 1, strike_limit: 2, render_timeout: 3, unknown: 4,
} as const satisfies Record<Fault, number>);
const recoveryMethod = fixedCodes({
  panel_repair: 1, panel_revert: 2, row_restore: 3, history_rewind: 4,
} as const satisfies Record<RecoveryMethod, number>);
const recoveryResult = fixedCodes({
  success: 1, discarded: 2, failed: 3,
} as const satisfies Record<RecoveryResult, number>);
const backupResult = fixedCodes({
  success: 1, failed: 2,
} as const satisfies Record<BackupResult, number>);

export const PRIVATE_METRIC_VARIANT_CODES = Object.freeze({
  appReadyEntry,
  duration,
  reshapeOrigin,
  reshapeOutcome,
  reshapeStage,
  safeDiff,
  previewDecision,
  trustSurface,
  lensMode,
  rewindSource,
  rewindResult,
  rewindDepth,
  fault,
  recoveryMethod,
  recoveryResult,
  backupResult,
});

/**
 * Collapse only validated `user_facing_diff.kind` values. Text in a diff line
 * is intentionally outside the function's input contract and is never read.
 */
export function deriveSafeDiffKind(
  diff: ReadonlyArray<{
    readonly kind: unknown;
    readonly [key: string]: unknown;
  }> | null | undefined,
): SafeDiffKind {
  if (!diff || diff.length === 0) return "unknown";
  const kinds = new Set<PlanDiffKind>();
  for (const line of diff) {
    const parsed = PlanDiffKindSchema.safeParse(line.kind);
    if (!parsed.success) return "unknown";
    kinds.add(parsed.data);
  }
  if (kinds.size !== 1) return "mixed";
  return [...kinds][0] ?? "unknown";
}

export type PrivateMetricDailyCell = Readonly<{
  dayUtc: number;
  metricCode: number;
  variantCode: number;
  n: number;
}>;

export type PrivateMetricStateRow = {
  schemaVersion: number;
  collectionEnabled: 0 | 1;
  firstReadyDay: number | null;
  firstKeepDay: number | null;
  firstKeepElapsedBucket: number | null;
  everActivated: 0 | 1;
  everProofLoop: 0 | 1;
  proofLoopElapsedBucket: number | null;
  d14Strict: 0 | 1 | null;
  d14Window: 0 | 1 | null;
};

export interface PrivateMetricDriver {
  transaction<T>(run: () => T): T;
  state(): PrivateMetricStateRow;
  replaceState(state: PrivateMetricStateRow): void;
  increment(dayUtc: number, metricCode: number, variantCode: number): void;
  cells(): PrivateMetricDailyCell[];
  deleteBefore(dayUtc: number): void;
  clearCells(): void;
}

const initialState = (collectionEnabled: 0 | 1 = 1): PrivateMetricStateRow => ({
  schemaVersion: PRIVATE_METRIC_SCHEMA_VERSION,
  collectionEnabled,
  firstReadyDay: null,
  firstKeepDay: null,
  firstKeepElapsedBucket: null,
  everActivated: 0,
  everProofLoop: 0,
  proofLoopElapsedBucket: null,
  d14Strict: null,
  d14Window: null,
});

const cellKey = (dayUtc: number, metricCode: number, variantCode: number): string =>
  `${dayUtc}:${metricCode}:${variantCode}`;

/** Deterministic test driver; production persistence is supplied separately. */
export class MemoryPrivateMetricDriver implements PrivateMetricDriver {
  private stateRow = initialState();
  private daily = new Map<string, PrivateMetricDailyCell>();

  transaction<T>(run: () => T): T {
    const beforeState = { ...this.stateRow };
    const beforeDaily = new Map(this.daily);
    try {
      return run();
    } catch (error) {
      this.stateRow = beforeState;
      this.daily = beforeDaily;
      throw error;
    }
  }

  state(): PrivateMetricStateRow {
    return { ...this.stateRow };
  }

  replaceState(state: PrivateMetricStateRow): void {
    this.stateRow = { ...state };
  }

  increment(dayUtc: number, metricCode: number, variantCode: number): void {
    if (![dayUtc, metricCode, variantCode].every(Number.isInteger)) {
      throw new TypeError("private metric cells accept integers only");
    }
    const key = cellKey(dayUtc, metricCode, variantCode);
    const prior = this.daily.get(key);
    this.daily.set(key, {
      dayUtc,
      metricCode,
      variantCode,
      n: (prior?.n ?? 0) + 1,
    });
  }

  cells(): PrivateMetricDailyCell[] {
    return [...this.daily.values()]
      .map((cell) => ({ ...cell }))
      .sort((a, b) => a.dayUtc - b.dayUtc
        || a.metricCode - b.metricCode
        || a.variantCode - b.variantCode);
  }

  deleteBefore(dayUtc: number): void {
    for (const [key, cell] of this.daily) {
      if (cell.dayUtc < dayUtc) this.daily.delete(key);
    }
  }

  clearCells(): void {
    this.daily.clear();
  }
}

export type Rate = {
  numerator: number;
  denominator: number;
  value: number | null;
};

export type PrivateMetricsSummary = {
  schemaVersion: 1;
  scope: "current_app";
  windowDays: 30;
  collectionEnabled: boolean;
  activation: {
    activated: boolean;
    firstKeepElapsed: DurationBucket | null;
    proofLoopComplete: boolean;
    proofLoopElapsed: DurationBucket | null;
    d14Strict: "not_eligible" | "retained" | "not_retained";
    d14Window: "not_eligible" | "retained" | "not_retained";
    situationalLensUses: number;
  };
  reshape: {
    started: number;
    previewRate: Rate;
    firstPassPreviewRate: Rate;
    keepRate: Rate;
    repairSaveRate: Rate;
    discardByDiff: Array<{
      diff: SafeDiffKind;
      decisions: number;
      discarded: number;
      rate: number;
    }>;
  };
  trust: {
    previewsShown: number;
    receiptsOpened: number;
    shapeMapOpened: number;
    historyOpened: number;
    rewindAttempted: number;
    rewindSucceeded: number;
    rewindSuccessRate: Rate;
    exportsSucceeded: number;
  };
  recovery: {
    faultsSeen: number;
    completed: number;
    succeeded: number;
    successRate: Rate;
    byMethod: Array<{
      method: RecoveryMethod;
      completed: number;
      succeeded: number;
    }>;
  };
};

const DAY_MS = 86_400_000;
const RETAINED_DAYS = 35;
const SUMMARY_DAYS = 30;

const safeDiffKinds = Object.freeze([
  ...PlanDiffKindSchema.options,
  "mixed",
  "unknown",
] as const satisfies readonly SafeDiffKind[]);
const recoveryMethods = Object.freeze([
  "panel_repair", "panel_revert", "row_restore", "history_rewind",
] as const satisfies readonly RecoveryMethod[]);

const rate = (numerator: number, denominator: number): Rate => ({
  numerator,
  denominator,
  value: denominator === 0 ? null : numerator / denominator,
});

const retentionStatus = (
  value: 0 | 1 | null,
): "not_eligible" | "retained" | "not_retained" =>
  value === null ? "not_eligible" : value === 1 ? "retained" : "not_retained";

const durationFromCode = (code: number | null): DurationBucket | null => {
  if (code === null) return null;
  for (const [bucket, bucketCode] of Object.entries(
    PRIVATE_METRIC_VARIANT_CODES.duration,
  )) {
    if (bucketCode === code) return bucket as DurationBucket;
  }
  return null;
};

export class PrivateMetricsReducer {
  private readonly clock: () => number;

  constructor(
    private readonly driver: PrivateMetricDriver,
    options: { clock?: () => number } = {},
  ) {
    this.clock = options.clock ?? Date.now;
    this.driver.transaction(() => this.maintain(this.today()));
  }

  record(input: unknown): void {
    const event = PrivateMetricEventSchema.parse(input);
    const day = this.today();
    this.driver.transaction(() => {
      this.maintain(day);
      if (this.driver.state().collectionEnabled === 0) return;
      this.reduce(day, event);
    });
  }

  summary(): PrivateMetricsSummary {
    const day = this.today();
    return this.driver.transaction(() => {
      this.maintain(day);
      const state = this.driver.state();
      const cells = this.driver.cells().filter((cell) =>
        cell.dayUtc >= day - (SUMMARY_DAYS - 1) && cell.dayUtc <= day
      );
      const count = (metricCode: number, variantCode: number): number =>
        cells.reduce((total, cell) => total + (
          cell.metricCode === metricCode && cell.variantCode === variantCode
            ? cell.n : 0
        ), 0);
      const sum = (metricCode: number, variants: readonly number[]): number =>
        variants.reduce((total, variant) => total + count(metricCode, variant), 0);

      const outcomes = Object.values(PRIVATE_METRIC_VARIANT_CODES.reshapeOutcome);
      const decisions = Object.values(PRIVATE_METRIC_VARIANT_CODES.previewDecision);
      const origins = Object.values(PRIVATE_METRIC_VARIANT_CODES.reshapeOrigin);
      const rewindResults = Object.values(PRIVATE_METRIC_VARIANT_CODES.rewindResult);
      const recoveryResults = Object.values(PRIVATE_METRIC_VARIANT_CODES.recoveryResult);
      const preview = PRIVATE_METRIC_VARIANT_CODES.reshapeOutcome.preview;
      const kept = PRIVATE_METRIC_VARIANT_CODES.previewDecision.kept;
      const successRewind = PRIVATE_METRIC_VARIANT_CODES.rewindResult.success;
      const failedRewind = PRIVATE_METRIC_VARIANT_CODES.rewindResult.failed;
      const successRecovery = PRIVATE_METRIC_VARIANT_CODES.recoveryResult.success;

      const finished = sum(PRIVATE_METRIC_CODES.reshapeFinishedByOutcome, outcomes);
      const repairedFinished = sum(PRIVATE_METRIC_CODES.reshapeRepairedByOutcome, outcomes);
      const decisionCount = sum(PRIVATE_METRIC_CODES.previewDecided, decisions);
      const rewindAttempted = sum(PRIVATE_METRIC_CODES.rewindFinishedByResult, rewindResults);
      const recoveryCompleted = sum(
        PRIVATE_METRIC_CODES.recoveryFinishedByResult,
        recoveryResults,
      );

      return {
        schemaVersion: PRIVATE_METRIC_SCHEMA_VERSION,
        scope: "current_app",
        windowDays: SUMMARY_DAYS,
        collectionEnabled: state.collectionEnabled === 1,
        activation: {
          activated: state.everActivated === 1,
          firstKeepElapsed: durationFromCode(state.firstKeepElapsedBucket),
          proofLoopComplete: state.everProofLoop === 1,
          proofLoopElapsed: durationFromCode(state.proofLoopElapsedBucket),
          d14Strict: retentionStatus(state.d14Strict),
          d14Window: retentionStatus(state.d14Window),
          situationalLensUses: count(
            PRIVATE_METRIC_CODES.lensChanged,
            PRIVATE_METRIC_VARIANT_CODES.lensMode.situational,
          ),
        },
        reshape: {
          started: sum(PRIVATE_METRIC_CODES.reshapeStartedByOrigin, origins),
          previewRate: rate(
            count(PRIVATE_METRIC_CODES.reshapeFinishedByOutcome, preview),
            finished,
          ),
          firstPassPreviewRate: rate(
            count(PRIVATE_METRIC_CODES.reshapeFirstPassByOutcome, preview),
            finished,
          ),
          keepRate: rate(
            count(PRIVATE_METRIC_CODES.previewDecided, kept),
            decisionCount,
          ),
          repairSaveRate: rate(
            count(PRIVATE_METRIC_CODES.reshapeRepairedByOutcome, preview),
            repairedFinished,
          ),
          discardByDiff: safeDiffKinds.flatMap((diff) => {
            const variant = PRIVATE_METRIC_VARIANT_CODES.safeDiff[diff];
            const keptByDiff = count(PRIVATE_METRIC_CODES.previewKeptByDiff, variant);
            const discarded = count(
              PRIVATE_METRIC_CODES.previewDiscardedByDiff,
              variant,
            );
            const all = keptByDiff + discarded;
            return all === 0 ? [] : [{
              diff,
              decisions: all,
              discarded,
              rate: discarded / all,
            }];
          }),
        },
        trust: {
          previewsShown: count(PRIVATE_METRIC_CODES.reshapeFinishedByOutcome, preview),
          receiptsOpened: count(
            PRIVATE_METRIC_CODES.trustSurfaceOpened,
            PRIVATE_METRIC_VARIANT_CODES.trustSurface.trust_receipt,
          ),
          shapeMapOpened: count(
            PRIVATE_METRIC_CODES.trustSurfaceOpened,
            PRIVATE_METRIC_VARIANT_CODES.trustSurface.shape_map,
          ),
          historyOpened: count(
            PRIVATE_METRIC_CODES.trustSurfaceOpened,
            PRIVATE_METRIC_VARIANT_CODES.trustSurface.history,
          ),
          rewindAttempted,
          rewindSucceeded: count(
            PRIVATE_METRIC_CODES.rewindFinishedByResult,
            successRewind,
          ),
          rewindSuccessRate: rate(
            count(PRIVATE_METRIC_CODES.rewindFinishedByResult, successRewind),
            count(PRIVATE_METRIC_CODES.rewindFinishedByResult, successRewind)
              + count(PRIVATE_METRIC_CODES.rewindFinishedByResult, failedRewind),
          ),
          exportsSucceeded: count(
            PRIVATE_METRIC_CODES.backupExportByResult,
            PRIVATE_METRIC_VARIANT_CODES.backupResult.success,
          ),
        },
        recovery: {
          faultsSeen: sum(
            PRIVATE_METRIC_CODES.faultSeen,
            Object.values(PRIVATE_METRIC_VARIANT_CODES.fault),
          ),
          completed: recoveryCompleted,
          succeeded: count(
            PRIVATE_METRIC_CODES.recoveryFinishedByResult,
            successRecovery,
          ),
          successRate: rate(
            count(PRIVATE_METRIC_CODES.recoveryFinishedByResult, successRecovery),
            recoveryCompleted,
          ),
          byMethod: recoveryMethods.map((method) => ({
            method,
            completed: count(
              PRIVATE_METRIC_CODES.recoveryCompletedByMethod,
              PRIVATE_METRIC_VARIANT_CODES.recoveryMethod[method],
            ),
            succeeded: count(
              PRIVATE_METRIC_CODES.recoverySucceededByMethod,
              PRIVATE_METRIC_VARIANT_CODES.recoveryMethod[method],
            ),
          })),
        },
      };
    });
  }

  setCollectionEnabled(enabled: boolean): void {
    const day = this.today();
    this.driver.transaction(() => {
      this.maintain(day);
      const state = this.driver.state();
      const next = enabled ? 1 : 0;
      if (state.collectionEnabled === next) return;
      this.driver.replaceState(enabled ? {
        ...state,
        collectionEnabled: 1,
        firstReadyDay: day,
        firstKeepDay: null,
        d14Strict: null,
        d14Window: null,
      } : { ...state, collectionEnabled: 0 });
    });
  }

  clear(): void {
    this.driver.transaction(() => {
      const enabled = this.driver.state().collectionEnabled;
      this.driver.clearCells();
      this.driver.replaceState(initialState(enabled));
    });
  }

  private today(): number {
    const now = this.clock();
    if (!Number.isFinite(now)) throw new TypeError("private metric clock must be finite");
    return Math.floor(now / DAY_MS);
  }

  private increment(day: number, metricCode: number, variantCode: number): void {
    this.driver.increment(day, metricCode, variantCode);
  }

  private reduce(day: number, event: PrivateMetricEvent): void {
    const variants = PRIVATE_METRIC_VARIANT_CODES;
    const metrics = PRIVATE_METRIC_CODES;
    switch (event.type) {
      case "app_ready": {
        this.increment(day, metrics.appReadyByEntry, variants.appReadyEntry[event.entry]);
        const state = this.driver.state();
        if (state.firstReadyDay === null) {
          this.driver.replaceState({ ...state, firstReadyDay: day });
        }
        return;
      }
      case "activation_completed": {
        const state = this.driver.state();
        let next = state;
        if (state.everActivated === 0) {
          this.increment(
            day,
            metrics.activationCompletedByElapsed,
            variants.duration[event.elapsed],
          );
          next = {
            ...next,
            everActivated: 1,
            firstKeepElapsedBucket: variants.duration[event.elapsed],
          };
        }
        if (state.firstKeepDay === null && state.d14Window === null) {
          next = { ...next, firstKeepDay: day };
        }
        if (next !== state) this.driver.replaceState(next);
        return;
      }
      case "reshape_started":
        this.increment(
          day,
          metrics.reshapeStartedByOrigin,
          variants.reshapeOrigin[event.origin],
        );
        return;
      case "reshape_finished":
        this.increment(
          day,
          metrics.reshapeFinishedByOutcome,
          variants.reshapeOutcome[event.outcome],
        );
        this.increment(
          day,
          event.repaired
            ? metrics.reshapeRepairedByOutcome
            : metrics.reshapeFirstPassByOutcome,
          variants.reshapeOutcome[event.outcome],
        );
        this.increment(
          day,
          metrics.reshapeFinishedByStage,
          variants.reshapeStage[event.stage],
        );
        this.increment(
          day,
          metrics.reshapeFinishedByDiff,
          variants.safeDiff[event.diff],
        );
        return;
      case "preview_decided":
        this.increment(
          day,
          metrics.previewDecided,
          variants.previewDecision[event.decision],
        );
        this.increment(
          day,
          event.decision === "kept"
            ? metrics.previewKeptByDiff
            : metrics.previewDiscardedByDiff,
          variants.safeDiff[event.diff],
        );
        if (event.repaired) {
          this.increment(
            day,
            metrics.previewRepairedDecision,
            variants.previewDecision[event.decision],
          );
        }
        return;
      case "trust_surface_opened":
        this.increment(
          day,
          metrics.trustSurfaceOpened,
          variants.trustSurface[event.surface],
        );
        return;
      case "lens_changed":
        this.increment(day, metrics.lensChanged, variants.lensMode[event.mode]);
        return;
      case "rewind_finished":
        this.increment(
          day,
          metrics.rewindFinishedByResult,
          variants.rewindResult[event.result],
        );
        this.increment(
          day,
          metrics.rewindFinishedBySource,
          variants.rewindSource[event.source],
        );
        this.increment(
          day,
          metrics.rewindFinishedByDepth,
          variants.rewindDepth[event.depth],
        );
        return;
      case "fault_seen":
        this.increment(day, metrics.faultSeen, variants.fault[event.fault]);
        return;
      case "recovery_finished":
        this.increment(
          day,
          metrics.recoveryFinishedByResult,
          variants.recoveryResult[event.result],
        );
        this.increment(
          day,
          metrics.recoveryCompletedByMethod,
          variants.recoveryMethod[event.method],
        );
        if (event.result === "success") {
          this.increment(
            day,
            metrics.recoverySucceededByMethod,
            variants.recoveryMethod[event.method],
          );
        }
        return;
      case "backup_finished":
        this.increment(
          day,
          event.action === "export"
            ? metrics.backupExportByResult
            : metrics.backupImportByResult,
          variants.backupResult[event.result],
        );
        return;
      case "proof_loop_completed": {
        const state = this.driver.state();
        if (state.everProofLoop === 1) return;
        this.increment(
          day,
          metrics.proofLoopCompletedByElapsed,
          variants.duration[event.elapsed],
        );
        this.driver.replaceState({
          ...state,
          everProofLoop: 1,
          proofLoopElapsedBucket: variants.duration[event.elapsed],
        });
        return;
      }
      default:
        return assertNever(event);
    }
  }

  private maintain(day: number): void {
    let state = this.driver.state();
    if (state.schemaVersion !== PRIVATE_METRIC_SCHEMA_VERSION) {
      throw new Error(`unsupported private metric schema ${state.schemaVersion}`);
    }
    const firstKeepDay = state.firstKeepDay;
    if (firstKeepDay !== null) {
      if (state.d14Strict === null && day > firstKeepDay + 14) {
        state = {
          ...state,
          d14Strict: this.keptBetween(firstKeepDay + 14, firstKeepDay + 14) ? 1 : 0,
        };
      }
      if (state.d14Window === null && day > firstKeepDay + 20) {
        state = {
          ...state,
          d14Window: this.keptBetween(firstKeepDay + 14, firstKeepDay + 20) ? 1 : 0,
        };
      }
      if (day > firstKeepDay + 20 && state.d14Window !== null) {
        state = { ...state, firstKeepDay: null };
      }
      this.driver.replaceState(state);
    }
    this.driver.deleteBefore(day - (RETAINED_DAYS - 1));
  }

  private keptBetween(firstDay: number, lastDay: number): boolean {
    const metricCode = PRIVATE_METRIC_CODES.previewDecided;
    const variantCode = PRIVATE_METRIC_VARIANT_CODES.previewDecision.kept;
    return this.driver.cells().some((cell) =>
      cell.dayUtc >= firstDay
      && cell.dayUtc <= lastDay
      && cell.metricCode === metricCode
      && cell.variantCode === variantCode
      && cell.n > 0
    );
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled private metric event: ${String(value)}`);
}
