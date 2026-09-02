import type { DbDriver } from "./db";
import {
  PRIVATE_METRIC_SCHEMA_VERSION,
  type PrivateMetricDailyCell,
  type PrivateMetricDriver,
  type PrivateMetricStateRow,
} from "./private-metrics";

const EMPTY_STATE: PrivateMetricStateRow = {
  schemaVersion: PRIVATE_METRIC_SCHEMA_VERSION,
  collectionEnabled: 1,
  firstReadyDay: null,
  firstKeepDay: null,
  firstKeepElapsedBucket: null,
  everActivated: 0,
  everProofLoop: 0,
  proofLoopElapsedBucket: null,
  d14Strict: null,
  d14Window: null,
};

export class SqlitePrivateMetricDriver implements PrivateMetricDriver {
  constructor(private readonly db: DbDriver) {
    if (this.db.select("SELECT id FROM sys.private_metric_state WHERE id = 1").length === 0)
      this.replaceState(EMPTY_STATE);
  }

  transaction<T>(run: () => T): T { return this.db.tx(run); }

  state(): PrivateMetricStateRow {
    const row = this.db.select("SELECT * FROM sys.private_metric_state WHERE id = 1")[0];
    if (!row) return { ...EMPTY_STATE };
    const bit = (value: unknown): 0 | 1 => Number(value) === 1 ? 1 : 0;
    const tri = (value: unknown): 0 | 1 | null => value == null ? null : bit(value);
    const num = (value: unknown): number | null => value == null ? null : Number(value);
    return {
      schemaVersion: Number(row.schema_version), collectionEnabled: bit(row.collection_enabled),
      firstReadyDay: num(row.first_ready_day), firstKeepDay: num(row.first_keep_day),
      firstKeepElapsedBucket: num(row.first_keep_elapsed_bucket),
      everActivated: bit(row.ever_activated), everProofLoop: bit(row.ever_proof_loop),
      proofLoopElapsedBucket: num(row.proof_loop_elapsed_bucket),
      d14Strict: tri(row.d14_strict), d14Window: tri(row.d14_window),
    };
  }

  replaceState(state: PrivateMetricStateRow): void {
    this.db.exec(`INSERT OR REPLACE INTO sys.private_metric_state(
      id, schema_version, collection_enabled, first_ready_day, first_keep_day,
      first_keep_elapsed_bucket, ever_activated, ever_proof_loop,
      proof_loop_elapsed_bucket, d14_strict, d14_window)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      state.schemaVersion, state.collectionEnabled, state.firstReadyDay,
      state.firstKeepDay, state.firstKeepElapsedBucket, state.everActivated,
      state.everProofLoop, state.proofLoopElapsedBucket, state.d14Strict, state.d14Window,
    ]);
  }

  increment(dayUtc: number, metricCode: number, variantCode: number): void {
    this.db.exec(`INSERT INTO sys.private_metric_daily(day_utc, metric_code, variant_code, n)
      VALUES (?, ?, ?, 1) ON CONFLICT(day_utc, metric_code, variant_code)
      DO UPDATE SET n = n + 1`, [dayUtc, metricCode, variantCode]);
  }

  cells(): PrivateMetricDailyCell[] {
    return this.db.select(`SELECT day_utc, metric_code, variant_code, n
      FROM sys.private_metric_daily ORDER BY day_utc, metric_code, variant_code`).map(row => ({
      dayUtc: Number(row.day_utc), metricCode: Number(row.metric_code),
      variantCode: Number(row.variant_code), n: Number(row.n),
    }));
  }

  deleteBefore(dayUtc: number): void {
    this.db.exec("DELETE FROM sys.private_metric_daily WHERE day_utc < ?", [dayUtc]);
  }

  clearCells(): void { this.db.exec("DELETE FROM sys.private_metric_daily"); }
}
