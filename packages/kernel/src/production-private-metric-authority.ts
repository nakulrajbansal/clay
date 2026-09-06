import type { DbDriver, SqlValue } from "./db";
import { ClayError } from "./errors";
import { sha256HexSync } from "./state-digest";
import { ClayStore } from "./store";

export type PrivateMetricAuthorityRoute =
  | "recordPrivateMetric"
  | "setPrivateMetricsEnabled"
  | "clearPrivateMetrics";

const STORE_RECORD_PRIVATE_METRIC: ClayStore["recordPrivateMetric"] =
  ClayStore.prototype.recordPrivateMetric;
const STORE_SET_PRIVATE_METRICS_ENABLED: ClayStore["setPrivateMetricsEnabled"] =
  ClayStore.prototype.setPrivateMetricsEnabled;
const STORE_PRIVATE_METRICS_SUMMARY: ClayStore["privateMetricsSummary"] =
  ClayStore.prototype.privateMetricsSummary;
const STORE_CLEAR_PRIVATE_METRICS: ClayStore["clearPrivateMetrics"] =
  ClayStore.prototype.clearPrivateMetrics;

function invalid(): never {
  throw new ClayError("E_TARGET_AUTHORITY_INVALID", "private metric operational state is invalid");
}

export function privateMetricOperationalFingerprint(driver: DbDriver): string {
  const stateRows = driver.select(`SELECT
    id, schema_version, collection_enabled, first_ready_day, first_keep_day,
    first_keep_elapsed_bucket, ever_activated, ever_proof_loop,
    proof_loop_elapsed_bucket, d14_strict, d14_window
    FROM sys.private_metric_state ORDER BY id`);
  const dailyRows = driver.select(`SELECT day_utc, metric_code, variant_code, n
    FROM sys.private_metric_daily ORDER BY day_utc, metric_code, variant_code`);
  if (stateRows.length !== 1 || dailyRows.length > 10_000) invalid();
  const integer = (value: unknown, nullable = false): number | null => {
    if (nullable && value === null) return null;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid();
    return value;
  };
  const bit = (value: unknown, nullable = false): number | null => {
    const parsed = integer(value, nullable);
    if (parsed !== null && parsed !== 0 && parsed !== 1) invalid();
    return parsed;
  };
  const state = stateRows[0]!;
  if (integer(state.id) !== 1 || integer(state.schema_version) !== 1) invalid();
  const encodedState = [
    1, 1, bit(state.collection_enabled), integer(state.first_ready_day, true),
    integer(state.first_keep_day, true), integer(state.first_keep_elapsed_bucket, true),
    bit(state.ever_activated), bit(state.ever_proof_loop),
    integer(state.proof_loop_elapsed_bucket, true), bit(state.d14_strict, true),
    bit(state.d14_window, true),
  ];
  const encodedDaily = dailyRows.map(row => {
    const day = integer(row.day_utc);
    const metric = integer(row.metric_code);
    const variant = integer(row.variant_code);
    const count = integer(row.n);
    if (metric === 0 || variant === 0 || count === 0) invalid();
    return [day, metric, variant, count];
  });
  return `sha256:${sha256HexSync(new TextEncoder().encode(JSON.stringify({
    schema: 1,
    privateMetricState: encodedState,
    privateMetricDaily: encodedDaily,
  })))}`;
}

export function copyPrivateMetricOperationalState(source: DbDriver, target: DbDriver): void {
  privateMetricOperationalFingerprint(source);
  const state = source.select(`SELECT
    id, schema_version, collection_enabled, first_ready_day, first_keep_day,
    first_keep_elapsed_bucket, ever_activated, ever_proof_loop,
    proof_loop_elapsed_bucket, d14_strict, d14_window
    FROM sys.private_metric_state ORDER BY id`)[0]!;
  const daily = source.select(`SELECT day_utc, metric_code, variant_code, n
    FROM sys.private_metric_daily ORDER BY day_utc, metric_code, variant_code`);
  target.tx(() => {
    target.exec("DELETE FROM sys.private_metric_daily");
    target.exec("DELETE FROM sys.private_metric_state");
    target.exec(`INSERT INTO sys.private_metric_state(
      id, schema_version, collection_enabled, first_ready_day, first_keep_day,
      first_keep_elapsed_bucket, ever_activated, ever_proof_loop,
      proof_loop_elapsed_bucket, d14_strict, d14_window)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      state.id, state.schema_version, state.collection_enabled, state.first_ready_day,
      state.first_keep_day, state.first_keep_elapsed_bucket, state.ever_activated,
      state.ever_proof_loop, state.proof_loop_elapsed_bucket, state.d14_strict,
      state.d14_window,
    ] as SqlValue[]);
    for (const row of daily) target.exec(
      `INSERT INTO sys.private_metric_daily(day_utc, metric_code, variant_code, n)
       VALUES (?, ?, ?, ?)`, [
        row.day_utc, row.metric_code, row.variant_code, row.n,
      ] as SqlValue[],
    );
  });
}

/** Executes only an already-captured, fixed private-metric route. */
export function executePrivateMetricAuthorityRoute(
  store: ClayStore,
  route: PrivateMetricAuthorityRoute,
  payload: Readonly<Record<string, unknown>>,
): unknown {
  switch (route) {
    case "recordPrivateMetric":
      STORE_RECORD_PRIVATE_METRIC.call(
        store, payload.event as Parameters<ClayStore["recordPrivateMetric"]>[0],
      );
      return null;
    case "setPrivateMetricsEnabled":
      STORE_SET_PRIVATE_METRICS_ENABLED.call(store, payload.enabled as boolean);
      return STORE_PRIVATE_METRICS_SUMMARY.call(store);
    case "clearPrivateMetrics":
      STORE_CLEAR_PRIVATE_METRICS.call(store);
      return STORE_PRIVATE_METRICS_SUMMARY.call(store);
  }
}
