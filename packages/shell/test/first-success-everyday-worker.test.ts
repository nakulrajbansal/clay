import { ClayStore, deriveInverse, openMemoryDriver, type ForwardOpT } from "@clay/kernel";
import { describe, expect, it } from "vitest";
import {
  completeEverydayActionFromCanonicalReadback,
  findEverydayActionTarget,
} from "../src/worker/first-success-journey";
import { openEverydayActionTarget } from "../src/app/everyday-action-navigation";
import { recordSampleRows } from "../src/shells/sample-provenance";
import {
  FIRST_SUCCESS_SETTING_KEY,
  applyFirstSuccessEvent,
  emptyFirstSuccessState,
  type FirstSuccessState,
} from "../src/app/first-success-state";

function startedWithRealRecord(): FirstSuccessState {
  const started = applyFirstSuccessEvent(emptyFirstSuccessState(), {
    type: "app_created", path: "recommended", shellId: "tracker",
  });
  const withRecord = applyFirstSuccessEvent(started, {
    type: "real_record", source: "create", changed: 1, sample: false,
  });
  return { ...withRecord, revision: 2 };
}

describe("worker-owned first-success everyday evidence", () => {
  it("deep-links to a real record and completes only after canonical worker read-back", async () => {
    const driver = await openMemoryDriver();
    const store = ClayStore.fromDriver(driver);
    const operations: ForwardOpT[] = [{
      op: "create_table", table: "tasks", columns: [
        { name: "title", type: "text", required: true },
      ],
    }];
    store.commit({
      intent: "Create tasks", summary: "Created tasks.",
      migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) },
    });
    const sample = store.insert("tasks", { title: "Example task" });
    recordSampleRows(store, { tasks: [String(sample.id)] }, `op_${"a".repeat(26)}`);
    const row = store.insert("tasks", { title: "Call the real customer" });
    store.setSetting(FIRST_SUCCESS_SETTING_KEY, startedWithRealRecord());

    const target = findEverydayActionTarget(store);
    expect(target).toEqual({ table: "tasks", rowId: row.id });
    const opened: Array<{ table: string; rowId: string }> = [];
    await expect(openEverydayActionTarget({
      firstEverydayActionTarget: async () => findEverydayActionTarget(store),
    }, (table, rowId) => opened.push({ table, rowId }))).resolves.toEqual(target);
    expect(opened).toEqual([target]);

    await expect(completeEverydayActionFromCanonicalReadback(driver, store, {
      action: "open", table: "tasks", rowId: String(sample.id),
    })).rejects.toThrow(/canonical real record/i);
    expect(store.getSetting<FirstSuccessState>(FIRST_SUCCESS_SETTING_KEY)?.steps.everyday)
      .toEqual({ state: "pending" });

    const completed = await completeEverydayActionFromCanonicalReadback(driver, store, {
      action: "open", table: target!.table, rowId: target!.rowId,
    });
    expect(completed).toMatchObject({
      revision: 3,
      steps: { everyday: { state: "complete", action: "open" } },
    });
    expect(store.getSetting(FIRST_SUCCESS_SETTING_KEY)).toEqual(completed);
    store.close();
  });
});
