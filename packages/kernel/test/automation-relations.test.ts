import { expect, it } from "vitest";
import {
  ClayStore,
  deriveInverse,
  type AutomationTargetIdentityV1,
  type ForwardOpT,
} from "../src/index";

const TARGET: AutomationTargetIdentityV1 = {
  v: 1,
  appInstanceId: "app_aaaaaaaaaaaaaaaaaaaaaaaaaa",
  activeGenerationId: "gen_bbbbbbbbbbbbbbbbbbbbbbbbbb",
  lineageEpoch: "1",
  stateRevision: "1",
  stateDigest: `sha256:${"c".repeat(64)}`,
};

it("matches event relation conditions by stable id", async () => {
  const store = await ClayStore.openMemory();
  try {
    const operations: ForwardOpT[] = [
      {
        op: "create_table",
        table: "customers",
        columns: [{ name: "name", type: "text", required: true }],
      },
      {
        op: "create_table",
        table: "jobs",
        columns: [
          { name: "name", type: "text", required: true },
          {
            name: "customer",
            type: "relation",
            required: false,
            relation: {
              target_table: "customers",
              cardinality: "one",
              unique_targets: false,
              display_field: "name",
            },
          },
        ],
      },
    ];
    store.commit({
      intent: "schema",
      summary: "schema",
      migration: {
        operations,
        inverse: deriveInverse(operations, store.registrySnapshot()),
      },
    });

    const customer = store.insert("customers", { name: "Acme" });
    const job = store.insert("jobs", { name: "Install" });
    const trace = store.semanticSchemaTrace();
    const jobs = trace.tables.find(table => table.name === "jobs")!;
    const customerField = trace.fields.find(field =>
      field.tableId === jobs.tableId && field.fieldName === "customer")!;
    const draft = store.saveAutomationDraft({
      v: 2,
      name: "linked",
      trigger: {
        kind: "record_updated",
        table: { tableId: jobs.tableId, lastKnownName: "jobs" },
        conditions: [{
          field: {
            tableId: jobs.tableId,
            fieldId: customerField.fieldId,
            lastKnownName: "customer",
          },
          op: "eq",
          value: String(customer.id),
        }],
      },
      actions: [{ kind: "notify", title: "Linked", body: "ok" }],
      runtime: { mode: "local" },
    }, undefined, new Date("2026-09-06T11:59:00.000Z"));
    const simulation = store.simulateAutomation({
      id: draft.id,
      target: TARGET,
      expectedRevision: draft.definitionRevision,
      purpose: "enable",
    }, new Date("2026-09-06T12:00:00.000Z"));
    const rule = store.enableAutomation({
      id: draft.id,
      target: TARGET,
      expectedRevision: draft.definitionRevision,
      simulation,
    }, new Date("2026-09-06T12:01:00.000Z"));

    store.update("jobs", String(job.id), { customer: customer.id });

    expect(store.runDueAutomations(TARGET, new Date("2026-09-06T12:02:00.000Z"))
      .filter(run => run.automationId === rule.id)).toHaveLength(1);
  } finally {
    store.close();
  }
});
