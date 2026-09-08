// The dummy-data contract: fill inserts plausible typed rows tracked in the
// reserved row-level provenance ledger; clear removes EXACTLY those rows (soft-delete),
// never rows the user added themselves — that asymmetry is the whole point.
import { describe, expect, it, vi } from "vitest";
import {
  ClayStore, deriveInverse, openMemoryDriver, type DbDriver, type MigrationPlanT,
} from "@clay/kernel";
import { SampleHandoffStore } from "../src/app/sample-handoff-store";
import { removeSampleRows, seedStarterShell } from "../src/shells/seed";
import {
  SAMPLE_PROVENANCE_SETTING, parseSampleCreatedResult, parseSampleProvenanceLedger,
} from "../src/shells/sample-provenance";
import {
  applyUserBatchWithSampleHandoff, fillSampleRows, recordProvenanceSummary, updateSampleToReal,
} from "../src/worker/samples";

async function storeWithProjects(driver?: DbDriver): Promise<ClayStore> {
  const store = driver ? ClayStore.fromDriver(driver) : await ClayStore.openMemory();
  const operations: MigrationPlanT["operations"] = [{
    op: "create_table", table: "projects",
    columns: [
      { name: "name", type: "text", required: true },
      { name: "owner", type: "text", required: false },
      { name: "status", type: "enum", required: false, values: ["on_track", "at_risk", "off_track"] },
      { name: "budget", type: "number", required: false },
      { name: "due_date", type: "date", required: false },
    ],
  }];
  store.commit({
    intent: "build", summary: "Creates projects.",
    migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) },
    panels: [],
  });
  return store;
}

describe("sample data fill/clear", () => {
  it("fills typed rows with strict table/row/operation provenance and no legacy marker", async () => {
    const store = await storeWithProjects();
    const res = fillSampleRows(store);
    expect(res.route).toBe("samples.fill");
    expect(res.added).toBeGreaterThanOrEqual(8);
    expect(recordProvenanceSummary(store).sampleCount).toBe(res.added);
    expect(store.getSetting("sample_rows")).toBeUndefined();
    const ledger = parseSampleProvenanceLedger(store.getSetting(SAMPLE_PROVENANCE_SETTING));
    expect(ledger.entries).toHaveLength(res.added);
    expect(res.created).toEqual(ledger.entries);
    expect(Object.isFrozen(res)).toBe(true);
    expect(Object.isFrozen(res.created)).toBe(true);
    expect(res.created.every(entry => Object.isFrozen(entry))).toBe(true);
    expect(ledger.entries.every(entry => /^tbl_/.test(entry.tableId)
      && /^op_[a-z2-7]{26}$/.test(entry.operationId))).toBe(true);
    const rows = store.query({ from: "projects" });
    expect(rows.length).toBe(res.added);
    for (const r of rows) {
      expect(typeof r.name).toBe("string");
      expect(["on_track", "at_risk", "off_track"]).toContain(r.status);
      expect(typeof r.budget).toBe("number");
      expect(String(r.due_date)).toMatch(/^\d{4}-\d{2}-\d{2}/);
    }
    store.close();
  });

  it("routes every live-store edit through the worker sample handoff", async () => {
    const delegate = {
      query: vi.fn(async () => []),
      insert: vi.fn(async () => ({ id: "inserted" })),
      update: vi.fn(async () => { throw new Error("raw update must not run"); }),
      softDelete: vi.fn(async () => undefined),
      registryTables: vi.fn(async () => []),
    };
    const handoff = vi.fn(async () => ({ id: "sample-1", name: "Mine" }));
    const store = new SampleHandoffStore(delegate, handoff);

    await expect(store.update("projects", "sample-1", { name: "Mine" })).resolves
      .toMatchObject({ id: "sample-1", name: "Mine" });
    expect(handoff).toHaveBeenCalledWith("projects", "sample-1", { name: "Mine" });
    expect(delegate.update).not.toHaveBeenCalled();
    await store.query({ from: "projects" });
    expect(delegate.query).toHaveBeenCalledTimes(1);
  });

  it("turns the first edited example into a real record and Clear keeps that exact row", async () => {
    const driver = await openMemoryDriver();
    const store = await storeWithProjects(driver);
    const filled = fillSampleRows(store);
    const sample = filled.created[0]!;
    const before = store.query({
      from: "projects", where: [{ field: "id", op: "eq", value: sample.rowId }], limit: 1,
    })[0]!;

    const noChange = updateSampleToReal(driver, store, "projects", sample.rowId, {
      name: before.name,
    });
    expect(noChange.promoted).toBe(false);
    expect(recordProvenanceSummary(store).sampleCount).toBe(filled.added);

    const changed = updateSampleToReal(driver, store, "projects", sample.rowId, {
      name: "My edited project",
    });
    expect(changed.promoted).toBe(true);
    expect(recordProvenanceSummary(store)).toEqual({
      sampleCount: filled.added - 1,
      sampleTables: ["projects"],
      realRecordCount: 1,
      provenanceValid: true,
    });

    removeSampleRows(store);
    expect(store.query({ from: "projects" })).toMatchObject([
      { id: sample.rowId, name: "My edited project" },
    ]);
    expect(recordProvenanceSummary(store)).toEqual({
      sampleCount: 0, sampleTables: [], realRecordCount: 1, provenanceValid: true,
    });
    store.close();
  });

  it("promotes every changed example in a user batch before Clear runs", async () => {
    const driver = await openMemoryDriver();
    const store = await storeWithProjects(driver);
    const filled = fillSampleRows(store);
    const [first, second] = filled.created;
    if (!first || !second) throw new Error("missing sample fixtures");

    const receipt = applyUserBatchWithSampleHandoff(driver, store, "Keep two examples", [
      { kind: "update", table: "projects", id: first.rowId, patch: { name: "Mine one" } },
      { kind: "update", table: "projects", id: second.rowId, patch: { name: "Mine two" } },
    ]);
    expect(receipt.changed).toBe(2);
    expect(recordProvenanceSummary(store).realRecordCount).toBe(2);
    removeSampleRows(store);
    expect(store.query({ from: "projects" }).map(row => row.name).sort())
      .toEqual(["Mine one", "Mine two"]);
    store.close();
  });

  it("rolls the row edit back if sample-to-real provenance publication fails", async () => {
    const driver = await openMemoryDriver();
    const store = await storeWithProjects(driver);
    const filled = fillSampleRows(store);
    const sample = filled.created[0]!;
    const before = store.query({
      from: "projects", where: [{ field: "id", op: "eq", value: sample.rowId }], limit: 1,
    })[0]!;
    const setSetting = store.setSetting.bind(store);
    vi.spyOn(store, "setSetting").mockImplementation((key, value) => {
      if (key === SAMPLE_PROVENANCE_SETTING) throw new Error("injected provenance failure");
      return setSetting(key, value);
    });

    expect(() => updateSampleToReal(driver, store, "projects", sample.rowId, {
      name: "Must roll back",
    })).toThrow("injected provenance failure");
    expect(store.query({
      from: "projects", where: [{ field: "id", op: "eq", value: sample.rowId }], limit: 1,
    })[0]).toEqual(before);
    expect(recordProvenanceSummary(store).sampleCount).toBe(filled.added);
    store.close();
  });

  it("keeps durable sample creation results closed, canonical, and route-discriminated", () => {
    const first = Object.freeze({
      tableId: "tbl_018f0000-0000-7000-8000-000000000001",
      rowId: "018f0000-0000-7000-8000-000000000001",
      operationId: `op_${"a".repeat(26)}`,
    });
    const second = Object.freeze({
      ...first,
      rowId: "018f0000-0000-7000-8000-000000000002",
      operationId: `op_${"b".repeat(26)}`,
    });
    const parsed = parseSampleCreatedResult({
      route: "samples.fill",
      added: 1,
      tables: 1,
      created: [first],
    });
    expect(parsed).toEqual({ route: "samples.fill", added: 1, tables: 1, created: [first] });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.created)).toBe(true);

    for (const invalid of [
      null,
      { added: 1, tables: 1, created: [first] },
      { route: "store.insert", created: [first] },
      { route: "starter.seed", created: [first], legacy: true },
      { route: "samples.fill", added: 2, tables: 1, created: [first] },
      { route: "samples.fill", added: 2, tables: 1, created: [first, second] },
    ]) expect(() => parseSampleCreatedResult(invalid)).toThrow(/sample creation result/i);
  });

  it("clear removes only generated rows — user rows survive, samples restorable", async () => {
    const store = await storeWithProjects();
    // the user's own row, inserted BEFORE and AFTER the samples
    const mine1 = store.insert("projects", { name: "My real project" });
    fillSampleRows(store);
    const mine2 = store.insert("projects", { name: "Another real one" });

    removeSampleRows(store);
    const left = store.query({ from: "projects" });
    expect(left.map(r => r.id).sort()).toEqual([mine1.id, mine2.id].sort());
    expect(recordProvenanceSummary(store).sampleCount).toBe(0);

    // soft-deleted, not gone: the cleared rows are still there for restore
    const deleted = store.query({
      from: "projects", includeDeleted: true,
      where: [{ field: "deleted_at", op: "not_null" }],
    });
    expect(deleted.length).toBeGreaterThanOrEqual(8);
    const restoredId = String(deleted[0]!.id);
    store.restoreRow("projects", restoredId);
    expect(recordProvenanceSummary(store)).toEqual({
      sampleCount: 1, sampleTables: ["projects"], realRecordCount: 2,
      provenanceValid: true,
    });
    removeSampleRows(store);
    expect(recordProvenanceSummary(store)).toEqual({
      sampleCount: 0, sampleTables: [], realRecordCount: 2, provenanceValid: true,
    });
    store.close();
  });

  it("filling twice accumulates and both fills clear together", async () => {
    const store = await storeWithProjects();
    const a = fillSampleRows(store);
    const b = fillSampleRows(store);
    expect(recordProvenanceSummary(store).sampleCount).toBe(a.added + b.added);
    removeSampleRows(store);
    expect(store.query({ from: "projects" })).toHaveLength(0);
    store.close();
  });
});

describe("sample fill round-2 (build-3 iteration)", () => {
  it("never invents history: activity/log tables are skipped", async () => {
    const store = await ClayStore.openMemory();
    seedStarterShell(store, "approvals");            // has request_activity
    removeSampleRows(store);                          // clear template rows
    fillSampleRows(store);
    const ledger = parseSampleProvenanceLedger(store.getSetting(SAMPLE_PROVENANCE_SETTING));
    expect(ledger.entries.length).toBeGreaterThan(0);
    expect(store.query({ from: "request_activity" })).toHaveLength(0);
    expect(recordProvenanceSummary(store).sampleTables).not.toContain("request_activity");
    store.close();
  });

  it("reports exact sample provenance separately from real activation records", async () => {
    const store = await ClayStore.openMemory();
    seedStarterShell(store, "tracker");
    expect(recordProvenanceSummary(store)).toEqual({
      sampleCount: 3, sampleTables: ["items"], realRecordCount: 0,
      provenanceValid: true,
    });

    store.insert("items", { name: "My real task", status: "todo" });
    expect(recordProvenanceSummary(store)).toEqual({
      sampleCount: 3, sampleTables: ["items"], realRecordCount: 1,
      provenanceValid: true,
    });

    removeSampleRows(store);
    expect(recordProvenanceSummary(store)).toEqual({
      sampleCount: 0, sampleTables: [], realRecordCount: 1,
      provenanceValid: true,
    });
    store.close();
  });

  it("fails closed when provenance is malformed and never deletes a real row", async () => {
    const store = await storeWithProjects();
    const mine = store.insert("projects", { name: "Keep me" });
    store.setSetting("sample_rows", { projects: [String(mine.id), "not-a-row-id"] });
    expect(recordProvenanceSummary(store)).toEqual({
      sampleCount: 0, sampleTables: [], realRecordCount: 0, provenanceValid: false,
    });
    expect(() => removeSampleRows(store)).toThrow(/legacy sample provenance.*unauthenticated/i);
    expect(store.query({ from: "projects" }).map(row => row.id)).toEqual([mine.id]);
    store.close();
  });

  it("domain-aware titles: a books table gets book titles, not task titles", async () => {
    const store = await ClayStore.openMemory();
    const ops = [{ op: "create_table" as const, table: "books", columns: [
      { name: "title", type: "text" as const, required: true }] }];
    store.commit({ intent: "seed", summary: "v1",
      migration: { operations: ops, inverse: deriveInverse(ops, store.registrySnapshot()) },
      panels: [] });
    fillSampleRows(store);
    const titles = store.query({ from: "books" }).map(r => String(r.title));
    expect(titles).toContain("The Silent Harbor");
    expect(titles).not.toContain("Fix billing edge case");
    store.close();
  });

  it("clears the exact active sample set atomically on an injected failure", async () => {
    const store = await storeWithProjects();
    const filled = fillSampleRows(store);
    const original = store.softDelete.bind(store);
    let calls = 0;
    vi.spyOn(store, "softDelete").mockImplementation((table, id) => {
      calls++;
      if (calls === 2) throw new Error("injected cleanup failure");
      return original(table, id);
    });

    expect(() => removeSampleRows(store)).toThrow("injected cleanup failure");
    expect(store.query({ from: "projects" })).toHaveLength(filled.added);
    expect(recordProvenanceSummary(store).sampleCount).toBe(filled.added);
    store.close();
  });
});
