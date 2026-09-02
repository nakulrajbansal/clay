import { describe, expect, it } from "vitest";
import { createSystemTables, openMemoryDriver } from "../src/db";
import { PrivateMetricsReducer } from "../src/private-metrics";
import { SqlitePrivateMetricDriver } from "../src/private-metrics-sqlite";

describe("SQLite private metrics", () => {
  it("persists only integer daily counters and summary state", async () => {
    const db = await openMemoryDriver();
    createSystemTables(db);
    const first = new PrivateMetricsReducer(new SqlitePrivateMetricDriver(db), {
      clock: () => Date.parse("2026-09-01T12:00:00Z"),
    });
    first.record({ type: "trust_surface_opened", surface: "shape_map" });
    first.record({ type: "lens_changed", mode: "situational" });

    const reopened = new PrivateMetricsReducer(new SqlitePrivateMetricDriver(db), {
      clock: () => Date.parse("2026-09-01T12:00:00Z"),
    });
    expect(reopened.summary().trust.shapeMapOpened).toBe(1);
    expect(reopened.summary().activation.situationalLensUses).toBe(1);
    const values = db.select("SELECT * FROM sys.private_metric_daily");
    expect(JSON.stringify(values)).not.toContain("shape_map");
    db.close();
  });
});
