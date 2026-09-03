import { describe, expect, it } from "vitest";
import {
  MemoryPrivateMetricDriver,
  PRIVATE_METRIC_CODES,
  PRIVATE_METRIC_SCHEMA_VERSION,
  PRIVATE_METRIC_VARIANT_CODES,
  PrivateMetricEventSchema,
  PrivateMetricsReducer,
  deriveSafeDiffKind,
} from "../src/private-metrics";

const VALID_EVENTS = [
  { type: "app_ready", entry: "new_blank" },
  { type: "app_ready", entry: "new_starter" },
  { type: "app_ready", entry: "data_import" },
  { type: "app_ready", entry: "archive_import" },
  { type: "app_ready", entry: "existing" },
  { type: "activation_completed", elapsed: "under_3m" },
  { type: "reshape_started", origin: "composer" },
  {
    type: "reshape_finished", outcome: "preview", repaired: false,
    stage: "none", diff: "add_field",
  },
  {
    type: "preview_decided", decision: "kept", repaired: true,
    diff: "mixed",
  },
  { type: "trust_surface_opened", surface: "shape_map" },
  { type: "lens_changed", mode: "situational" },
  {
    type: "rewind_finished", source: "history", result: "success",
    depth: "two_to_five",
  },
  { type: "fault_seen", fault: "render_timeout" },
  {
    type: "recovery_finished", method: "row_restore", result: "discarded",
  },
  { type: "backup_finished", action: "export", result: "failed" },
  { type: "proof_loop_completed", elapsed: "over_30m" },
] as const;

describe("PrivateMetricEventSchema", () => {
  it("accepts every exact event shape and fails closed on strings or extra data", () => {
    for (const event of VALID_EVENTS) {
      expect(PrivateMetricEventSchema.parse(event)).toEqual(event);
    }

    const rejected: unknown[] = [
      { type: "unknown_event" },
      { type: "app_ready", entry: "private starter name" },
      { type: "app_ready", entry: "existing", at: "2026-09-01T12:00:00Z" },
      { type: "app_ready", entry: "existing", id: "app-secret" },
      { type: "app_ready", entry: "existing", subject: "customer table" },
      { type: "app_ready", entry: "existing", detail: { prompt: "secret" } },
      { type: "app_ready", entry: "existing", props: {} },
      { type: "reshape_started", origin: "composer", intent: "private intent" },
      {
        type: "reshape_finished", outcome: "preview", repaired: "false",
        stage: "none", diff: "add_field",
      },
      {
        type: "preview_decided", decision: "kept", repaired: false,
        diff: "free_form_diff",
      },
    ];
    for (const event of rejected) {
      expect(PrivateMetricEventSchema.safeParse(event).success).toBe(false);
    }
  });
});

describe("safe diff derivation", () => {
  it("uses only validated shared diff kinds and never classifies detail text", () => {
    expect(deriveSafeDiffKind(undefined)).toBe("unknown");
    expect(deriveSafeDiffKind([])).toBe("unknown");
    expect(deriveSafeDiffKind([
      { kind: "add_field", detail: "PRIVATE_INTENT_SENTINEL chart remove panel" },
    ])).toBe("add_field");
    expect(deriveSafeDiffKind([
      { kind: "change_panel" }, { kind: "change_panel" },
    ])).toBe("change_panel");
    expect(deriveSafeDiffKind([
      { kind: "add_field" }, { kind: "change_panel" },
    ])).toBe("mixed");
    expect(deriveSafeDiffKind([{ kind: "PRIVATE_INTENT_SENTINEL" }])).toBe("unknown");
  });
});

describe("private metric code registry", () => {
  it("pins a unique versioned integer code for every predeclared cell", () => {
    expect(PRIVATE_METRIC_SCHEMA_VERSION).toBe(1);
    expect(PRIVATE_METRIC_CODES).toEqual({
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
    });
    expect(PRIVATE_METRIC_VARIANT_CODES).toEqual({
      appReadyEntry: {
        new_blank: 1, new_starter: 2, data_import: 3,
        archive_import: 4, existing: 5,
      },
      duration: { under_3m: 1, "3_to_10m": 2, "10_to_30m": 3, over_30m: 4 },
      reshapeOrigin: { composer: 1, observer_suggestion: 2, panel_repair: 3 },
      reshapeOutcome: { preview: 1, clarify: 2, failed: 3 },
      reshapeStage: { none: 1, plan: 2, validate: 3, dry_run: 4 },
      safeDiff: {
        add_field: 1, change_field: 2, add_panel: 3, change_panel: 4,
        remove_panel: 5, add_status: 6, add_computed: 7, add_chart: 8,
        mixed: 9, unknown: 10, add_relation: 11, add_automation: 12,
        add_attachment: 13,
      },
      previewDecision: { kept: 1, discarded: 2 },
      trustSurface: { shape_map: 1, history: 2, trust_receipt: 3, storage_status: 4 },
      lensMode: { all: 1, situational: 2 },
      rewindSource: { trust_receipt: 1, history: 2, time_slider: 3 },
      rewindResult: { success: 1, cancelled: 2, failed: 3 },
      rewindDepth: { one: 1, two_to_five: 2, six_plus: 3 },
      fault: { runtime: 1, strike_limit: 2, render_timeout: 3, unknown: 4 },
      recoveryMethod: {
        panel_repair: 1, panel_revert: 2, row_restore: 3, history_rewind: 4,
      },
      recoveryResult: { success: 1, discarded: 2, failed: 3 },
      backupResult: { success: 1, failed: 2 },
    });

    const metricCodes = Object.values(PRIVATE_METRIC_CODES);
    expect(metricCodes.every(Number.isInteger)).toBe(true);
    expect(new Set(metricCodes).size).toBe(metricCodes.length);
    for (const variants of Object.values(PRIVATE_METRIC_VARIANT_CODES)) {
      expect(Object.values(variants).every(Number.isInteger)).toBe(true);
    }
  });
});

const DAY_MS = 86_400_000;

function harness(iso = "2026-09-01T12:00:00Z") {
  const base = Date.parse(iso);
  let now = base;
  const driver = new MemoryPrivateMetricDriver();
  const reducer = new PrivateMetricsReducer(driver, { clock: () => now });
  return {
    driver,
    reducer,
    day: Math.floor(base / DAY_MS),
    setOffset(offset: number): void { now = base + offset * DAY_MS; },
  };
}

describe("PrivateMetricsReducer", () => {
  it("builds the fixed summary with honest formula denominators", () => {
    const { driver, reducer, day } = harness();
    for (const origin of ["composer", "composer", "observer_suggestion", "panel_repair"] as const) {
      reducer.record({ type: "reshape_started", origin });
    }
    reducer.record({
      type: "reshape_finished", outcome: "preview", repaired: false,
      stage: "none", diff: "add_field",
    });
    reducer.record({
      type: "reshape_finished", outcome: "preview", repaired: true,
      stage: "none", diff: "change_panel",
    });
    reducer.record({
      type: "reshape_finished", outcome: "failed", repaired: true,
      stage: "validate", diff: "unknown",
    });
    reducer.record({
      type: "reshape_finished", outcome: "clarify", repaired: false,
      stage: "plan", diff: "unknown",
    });
    reducer.record({
      type: "preview_decided", decision: "kept", repaired: false, diff: "add_field",
    });
    reducer.record({
      type: "preview_decided", decision: "discarded", repaired: false, diff: "add_field",
    });
    reducer.record({
      type: "preview_decided", decision: "discarded", repaired: true, diff: "mixed",
    });
    reducer.record({ type: "trust_surface_opened", surface: "trust_receipt" });
    reducer.record({ type: "trust_surface_opened", surface: "shape_map" });
    reducer.record({ type: "trust_surface_opened", surface: "history" });
    reducer.record({ type: "lens_changed", mode: "situational" });
    reducer.record({ type: "lens_changed", mode: "situational" });
    reducer.record({ type: "lens_changed", mode: "all" });
    for (const result of ["success", "failed", "cancelled"] as const) {
      reducer.record({
        type: "rewind_finished", source: "history", result, depth: "one",
      });
    }
    reducer.record({ type: "backup_finished", action: "export", result: "success" });
    reducer.record({ type: "fault_seen", fault: "runtime" });
    reducer.record({ type: "fault_seen", fault: "render_timeout" });
    reducer.record({
      type: "recovery_finished", method: "panel_repair", result: "success",
    });
    reducer.record({
      type: "recovery_finished", method: "panel_repair", result: "discarded",
    });
    reducer.record({
      type: "recovery_finished", method: "row_restore", result: "failed",
    });

    expect(reducer.summary()).toMatchObject({
      schemaVersion: 1,
      scope: "current_app",
      windowDays: 30,
      collectionEnabled: true,
      activation: { situationalLensUses: 2 },
      reshape: {
        started: 4,
        previewRate: { numerator: 2, denominator: 4, value: 0.5 },
        firstPassPreviewRate: { numerator: 1, denominator: 4, value: 0.25 },
        keepRate: { numerator: 1, denominator: 3, value: 1 / 3 },
        repairSaveRate: { numerator: 1, denominator: 2, value: 0.5 },
        discardByDiff: [
          { diff: "add_field", decisions: 2, discarded: 1, rate: 0.5 },
          { diff: "mixed", decisions: 1, discarded: 1, rate: 1 },
        ],
      },
      trust: {
        previewsShown: 2,
        receiptsOpened: 1,
        shapeMapOpened: 1,
        historyOpened: 1,
        rewindAttempted: 3,
        rewindSucceeded: 1,
        rewindSuccessRate: { numerator: 1, denominator: 2, value: 0.5 },
        exportsSucceeded: 1,
      },
      recovery: {
        faultsSeen: 2,
        completed: 3,
        succeeded: 1,
        successRate: { numerator: 1, denominator: 3, value: 1 / 3 },
        byMethod: [
          { method: "panel_repair", completed: 2, succeeded: 1 },
          { method: "panel_revert", completed: 0, succeeded: 0 },
          { method: "row_restore", completed: 1, succeeded: 0 },
          { method: "history_rewind", completed: 0, succeeded: 0 },
        ],
      },
    });

    expect(driver.cells().every((cell) =>
      cell.dayUtc === day
      && [cell.dayUtc, cell.metricCode, cell.variantCode, cell.n].every(Number.isInteger)
    )).toBe(true);
    expect(Object.values(driver.state()).every((value) =>
      value === null || Number.isInteger(value)
    )).toBe(true);
  });

  it("returns null for every zero-denominator rate", () => {
    const { reducer } = harness();
    const summary = reducer.summary();
    expect(summary.reshape.previewRate).toEqual({ numerator: 0, denominator: 0, value: null });
    expect(summary.reshape.firstPassPreviewRate.value).toBeNull();
    expect(summary.reshape.keepRate.value).toBeNull();
    expect(summary.reshape.repairSaveRate.value).toBeNull();
    expect(summary.reshape.discardByDiff).toEqual([]);
    expect(summary.trust.rewindSuccessRate.value).toBeNull();
    expect(summary.recovery.successRate.value).toBeNull();
  });

  it("keeps activation and proof milestones idempotent", () => {
    const { driver, reducer, day } = harness();
    reducer.record({ type: "app_ready", entry: "new_blank" });
    reducer.record({ type: "activation_completed", elapsed: "under_3m" });
    reducer.record({ type: "activation_completed", elapsed: "over_30m" });
    reducer.record({ type: "proof_loop_completed", elapsed: "3_to_10m" });
    reducer.record({ type: "proof_loop_completed", elapsed: "over_30m" });

    expect(driver.state()).toMatchObject({
      firstReadyDay: day,
      firstKeepDay: day,
      firstKeepElapsedBucket: 1,
      everActivated: 1,
      everProofLoop: 1,
      proofLoopElapsedBucket: 2,
    });
    expect(driver.cells().filter((cell) =>
      cell.metricCode === PRIVATE_METRIC_CODES.activationCompletedByElapsed
      || cell.metricCode === PRIVATE_METRIC_CODES.proofLoopCompletedByElapsed
    )).toHaveLength(2);
    expect(reducer.summary().activation).toMatchObject({
      activated: true,
      firstKeepElapsed: "under_3m",
      proofLoopComplete: true,
      proofLoopElapsed: "3_to_10m",
    });
  });

  it("closes D14 windows on UTC-day boundaries and compacts cohort state", () => {
    const { driver, reducer, setOffset } = harness();
    reducer.record({ type: "activation_completed", elapsed: "under_3m" });

    setOffset(14);
    expect(reducer.summary().activation.d14Strict).toBe("not_eligible");
    setOffset(15);
    expect(reducer.summary().activation.d14Strict).toBe("not_retained");

    setOffset(20);
    reducer.record({
      type: "preview_decided", decision: "kept", repaired: false, diff: "add_field",
    });
    expect(reducer.summary().activation.d14Window).toBe("not_eligible");
    setOffset(21);
    expect(reducer.summary().activation.d14Window).toBe("retained");
    expect(driver.state().firstKeepDay).toBeNull();
  });

  it("retains exactly 35 days, survives rollback, and honors disable and clear", () => {
    const { driver, reducer, day, setOffset } = harness();
    reducer.setCollectionEnabled(false);
    reducer.record({ type: "reshape_started", origin: "composer" });
    expect(driver.cells()).toEqual([]);

    reducer.setCollectionEnabled(true);
    for (let offset = 0; offset < 40; offset++) {
      setOffset(offset);
      reducer.record({ type: "reshape_started", origin: "composer" });
    }
    const retainedDays = new Set(driver.cells().map((cell) => cell.dayUtc));
    expect(retainedDays.size).toBe(35);
    expect(Math.min(...retainedDays)).toBe(day + 5);
    expect(Math.max(...retainedDays)).toBe(day + 39);
    expect(reducer.summary().reshape.started).toBe(30);

    setOffset(10);
    reducer.summary();
    expect(Math.max(...driver.cells().map((cell) => cell.dayUtc))).toBe(day + 39);

    reducer.setCollectionEnabled(false);
    reducer.clear();
    expect(driver.cells()).toEqual([]);
    expect(reducer.summary()).toMatchObject({
      collectionEnabled: false,
      activation: { activated: false, proofLoopComplete: false },
      reshape: { started: 0 },
    });
  });
});
