import { describe, expect, it } from "vitest";
import {
  ClayStore, deriveInverse, type ForwardOpT,
} from "../src/index";

function commitOps(store: ClayStore, operations: ForwardOpT[]): void {
  store.commit({
    intent: "connected records test",
    summary: "Connects records.",
    migration: {
      operations,
      inverse: deriveInverse(operations, store.registrySnapshot()),
    },
  });
}

describe("connected records", () => {
  it("validates links and resolves lookup and rollup values live", async () => {
    const store = await ClayStore.openMemory();
    try {
      commitOps(store, [
        { op: "create_table", table: "customers", columns: [
          { name: "name", type: "text", required: true },
        ] },
        { op: "create_table", table: "tasks", columns: [
          { name: "title", type: "text", required: true },
          { name: "amount", type: "number", required: false },
        ] },
      ]);
      commitOps(store, [
        { op: "create_table", table: "jobs", columns: [
          { name: "title", type: "text", required: true },
          { name: "customer", type: "relation", required: false,
            relation: { target_table: "customers", cardinality: "one", unique_targets: false, display_field: "name" } },
          { name: "customer_name", type: "lookup", required: false,
            lookup: { relation_field: "customer", target_field: "name" } },
        ] },
        { op: "create_table", table: "projects", columns: [
          { name: "name", type: "text", required: true },
          { name: "tasks", type: "relation", required: false,
            relation: { target_table: "tasks", cardinality: "many", unique_targets: false, display_field: "title" } },
          { name: "task_titles", type: "lookup", required: false,
            lookup: { relation_field: "tasks", target_field: "title" } },
          { name: "task_total", type: "rollup", required: false,
            rollup: { relation_field: "tasks", target_field: "amount", operation: "sum" } },
          { name: "task_count", type: "rollup", required: false,
            rollup: { relation_field: "tasks", operation: "count" } },
        ] },
      ]);

      const customer = store.insert("customers", { name: "Acme" });
      const job = store.insert("jobs", { title: "Install", customer: customer.id });
      expect(job.customer).toEqual({ id: customer.id, label: "Acme", table: "customers" });
      expect(store.query({ from: "jobs", select: ["id", "customer_name"] }))
        .toEqual([{ id: job.id, customer_name: "Acme" }]);
      const other = store.insert("customers", { name: "Zenith" });
      store.insert("jobs", { title: "Later", customer: other.id });
      expect(store.query({ from: "jobs", select: ["title", "customer"],
        where: [{ field: "customer", op: "contains", value: "acme" }] }))
        .toEqual([{ title: "Install", customer: {
          id: customer.id, label: "Acme", table: "customers",
        } }]);
      expect(store.query({ from: "jobs", select: ["title", "customer"],
        orderBy: [{ field: "customer", dir: "asc" }] }).map(row => row.title))
        .toEqual(["Install", "Later"]);

      const first = store.insert("tasks", { title: "Measure", amount: 25 });
      const second = store.insert("tasks", { title: "Build", amount: 75 });
      const project = store.insert("projects", {
        name: "Kitchen", tasks: [first.id, second.id, first.id],
      });
      const rows = store.query({
        from: "projects",
        select: ["id", "tasks", "task_titles", "task_total", "task_count"],
      });
      expect(rows).toEqual([{
        id: project.id,
        tasks: [
          { id: first.id, label: "Measure", table: "tasks" },
          { id: second.id, label: "Build", table: "tasks" },
        ],
        task_titles: ["Measure", "Build"],
        task_total: 100,
        task_count: 2,
      }]);

      store.update("tasks", second.id as string, { amount: 125 });
      expect(store.query({ from: "projects", select: ["task_total"] }))
        .toEqual([{ task_total: 150 }]);
      expect(store.query({
        from: "projects", select: ["name", "task_total"],
        where: [{ field: "task_total", op: "gte", value: 100 }],
      })).toEqual([{ name: "Kitchen", task_total: 150 }]);

      expect(() => store.query({ from: "jobs", groupBy: ["customer"],
        aggregate: [{ fn: "count", field: "title", as: "count" }] }))
        .toThrow(/relation.*groupBy|groupBy.*relation/i);

      expect(() => store.insert("jobs", {
        title: "Invalid", customer: "018f0000-0000-7000-8000-000000000000",
      })).toThrow(/linked record/i);
      expect(store.semanticSchemaTrace().relationships.some(r => r.kind === "references"))
        .toBe(true);
    } finally { store.close(); }
  });

  it("uses lookup and rollup result types for query validation", async () => {
    const store = await ClayStore.openMemory();
    try {
      commitOps(store, [{ op: "create_table", table: "accounts", columns: [
        { name: "name", type: "text", required: true },
        { name: "renewal", type: "date", required: false },
        { name: "spend", type: "number", required: false },
      ] }]);
      commitOps(store, [{ op: "create_table", table: "orders", columns: [
        { name: "number", type: "text", required: true },
        { name: "account", type: "relation", required: false,
          relation: { target_table: "accounts", cardinality: "one",
            unique_targets: false, display_field: "name" } },
        { name: "renewal", type: "lookup", required: false,
          lookup: { relation_field: "account", target_field: "renewal" } },
        { name: "spend", type: "lookup", required: false,
          lookup: { relation_field: "account", target_field: "spend" } },
      ] }]);
      const account = store.insert("accounts", {
        name: "Northwind", renewal: "2026-09-03", spend: 125,
      });
      store.insert("orders", { number: "SO-1", account: account.id });
      expect(store.query({ from: "orders", select: ["number"],
        where: [{ field: "renewal", op: "within_days", value: 2 }] },
      new Date("2026-09-02T12:00:00"))).toEqual([{ number: "SO-1" }]);
      expect(() => store.query({ from: "orders",
        where: [{ field: "spend", op: "contains", value: "12" }] }))
        .toThrow(/text/i);
    } finally { store.close(); }
  });

  it("previews and converts text values without destroying the source", async () => {
    const store = await ClayStore.openMemory();
    try {
      commitOps(store, [
        { op: "create_table", table: "customers", columns: [
          { name: "name", type: "text", required: true },
        ] },
        { op: "create_table", table: "jobs", columns: [
          { name: "title", type: "text", required: true },
          { name: "customer", type: "text", required: false },
        ] },
      ]);
      const acme = store.insert("customers", { name: "Acme" });
      store.insert("customers", { name: "Duplicate" });
      store.insert("customers", { name: "duplicate" });
      const first = store.insert("jobs", { title: "A", customer: "Acme" });
      store.insert("jobs", { title: "B", customer: "Acme" });
      store.insert("jobs", { title: "C", customer: "Missing" });
      store.insert("jobs", { title: "D", customer: "Duplicate" });

      const preview = store.previewRelationConversion({
        sourceTable: "jobs", sourceField: "customer",
        targetTable: "customers", displayField: "name",
      });
      expect(preview).toMatchObject({
        matchedRows: 2, unmatchedRows: 1, ambiguousRows: 1, duplicateSourceRows: 1,
      });
      const result = store.convertTextToRelation({ ...preview, cardinality: "one" });
      expect(result.convertedRows).toBe(2);
      expect(store.query({ from: "jobs", select: ["id", result.relationField] })[0])
        .toMatchObject({ id: first.id,
          [result.relationField]: { id: acme.id, label: "Acme", table: "customers" } });
      const active = store.registrySnapshot().get("jobs")!;
      expect(active.columns.find(c => c.name === result.relationField)?.type).toBe("relation");
      expect(active.columns.some(c => c.hidden && c.name.startsWith("customer_source")))
        .toBe(true);
      expect(store.validationRegistrySnapshot().get("jobs")!.columns
        .some(c => c.hidden && c.name.startsWith("customer_source"))).toBe(true);

      const convertedVersion = store.currentVersion();
      store.rollbackTo(convertedVersion - 1);
      expect(store.registrySnapshot().get("jobs")!.columns
        .find(c => c.name === "customer")?.type).toBe("text");
      expect(store.query({ from: "jobs", select: ["id", "customer"] })[0])
        .toMatchObject({ id: first.id, customer: "Acme" });
      store.rollForwardTo(convertedVersion);
      expect(store.query({ from: "jobs", select: ["id", result.relationField] })[0])
        .toMatchObject({ id: first.id,
          [result.relationField]: { id: acme.id, label: "Acme", table: "customers" } });
    } finally { store.close(); }
  });

  it("enforces one-to-one targets and rejects malformed connected definitions", async () => {
    const store = await ClayStore.openMemory();
    try {
      commitOps(store, [{ op: "create_table", table: "people", columns: [
        { name: "name", type: "text", required: true },
      ] }]);
      commitOps(store, [{ op: "create_table", table: "profiles", columns: [
        { name: "name", type: "text", required: true },
        { name: "person", type: "relation", required: false,
          relation: { target_table: "people", cardinality: "one",
            unique_targets: true, display_field: "name" } },
      ] }]);
      const person = store.insert("people", { name: "Kai" });
      store.insert("profiles", { name: "Primary", person: person.id });
      expect(() => store.insert("profiles", { name: "Duplicate", person: person.id }))
        .toThrow(/linked only once/i);

      const invalid: ForwardOpT[] = [{ op: "add_column", table: "profiles", column: {
        name: "missing_name", type: "lookup", required: false,
        lookup: { relation_field: "missing_relation", target_field: "name" },
      } }];
      expect(() => deriveInverse(invalid, store.registrySnapshot()))
        .toThrow(/needs a relation field/i);
    } finally { store.close(); }
  });

  it("keeps links, semantic identity, and live values through archive import", async () => {
    const source = await ClayStore.openMemory();
    try {
      commitOps(source, [{ op: "create_table", table: "accounts", columns: [
        { name: "name", type: "text", required: true },
      ] }]);
      commitOps(source, [{ op: "create_table", table: "orders", columns: [
        { name: "number", type: "text", required: true },
        { name: "account", type: "relation", required: false,
          relation: { target_table: "accounts", cardinality: "one",
            unique_targets: false, display_field: "name" } },
        { name: "account_name", type: "lookup", required: false,
          lookup: { relation_field: "account", target_field: "name" } },
      ] }]);
      const account = source.insert("accounts", { name: "Northwind" });
      source.insert("orders", { number: "SO-1", account: account.id });
      const relationshipId = source.semanticSchemaTrace().relationships
        .find(relationship => relationship.kind === "references")!.relationshipId;

      const imported = await ClayStore.importArchive(await source.exportArchive("connected"));
      try {
        expect(imported.store.query({ from: "orders", select: ["account_name"] }))
          .toEqual([{ account_name: "Northwind" }]);
        expect(imported.store.semanticSchemaTrace().relationships
          .find(relationship => relationship.kind === "references")!.relationshipId)
          .toBe(relationshipId);
      } finally { imported.store.close(); }
    } finally { source.close(); }
  });

  it("rewrites cross-table derived targets when the target field is renamed", async () => {
    const store = await ClayStore.openMemory();
    try {
      commitOps(store, [{ op: "create_table", table: "accounts", columns: [
        { name: "name", type: "text", required: true },
        { name: "balance", type: "number", required: false },
      ] }]);
      commitOps(store, [{ op: "create_table", table: "orders", columns: [
        { name: "number", type: "text", required: true },
        { name: "account", type: "relation", required: false,
          relation: { target_table: "accounts", cardinality: "one",
            unique_targets: false, display_field: "name" } },
        { name: "account_name", type: "lookup", required: false,
          lookup: { relation_field: "account", target_field: "name" } },
        { name: "account_balance", type: "rollup", required: false,
          rollup: { relation_field: "account", target_field: "balance", operation: "sum" } },
      ] }]);
      commitOps(store, [
        { op: "rename_column", table: "accounts", from: "name", to: "display_name" },
        { op: "rename_column", table: "accounts", from: "balance", to: "amount_due" },
      ]);
      const orders = store.registrySnapshot().get("orders")!;
      expect(orders.columns.find(column => column.name === "account")!.relation!.display_field)
        .toBe("display_name");
      expect(orders.columns.find(column => column.name === "account_name")!.lookup!.target_field)
        .toBe("display_name");
      expect(orders.columns.find(column => column.name === "account_balance")!.rollup!.target_field)
        .toBe("amount_due");
    } finally { store.close(); }
  });

  it("matches incoming many-links by stable id and preserves unrelated panel prose", async () => {
    const store = await ClayStore.openMemory();
    try {
      const operations: ForwardOpT[] = [
        { op: "create_table", table: "people", columns: [
          { name: "name", type: "text", required: true },
        ] },
        { op: "create_table", table: "teams", columns: [
          { name: "status", type: "text", required: true },
          { name: "members", type: "relation", required: false,
            relation: { target_table: "people", cardinality: "many",
              unique_targets: false, display_field: "name" } },
        ] },
      ];
      store.commit({ intent: "people", summary: "People and teams.",
        migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) },
        panels: [{ panel_id: "team_panel", title: "Team", placement: { region: "main", order: 0 },
          code: `export default function(clay){const help="status should remain prose";clay.db.query({from:"teams",select:["status"]}).then(rows=>clay.ui.render(h(Text,{value:help+rows[0]?.status})))}`,
          declared_queries: [{ from: "teams", select: ["status"] }], declared_writes: [] }],
      });
      const person = store.insert("people", { name: "Kai" });
      store.insert("teams", { status: "Active", members: [person.id] });
      expect(store.query({ from: "teams", select: ["status"],
        where: [{ field: "members", op: "contains", value: String(person.id) }] }))
        .toEqual([{ status: "Active" }]);
      commitOps(store, [{ op: "rename_column", table: "teams", from: "status", to: "state" }]);
      const code = store.livePanels()[0]!.code;
      expect(code).toContain("status should remain prose");
      expect(code).toContain('select:["state"]');
      expect(code).toContain("rows[0]?.state");
    } finally { store.close(); }
  });

  it("rejects stale conversion previews and rewrites affected panel fields", async () => {
    const store = await ClayStore.openMemory();
    try {
      const operations: ForwardOpT[] = [
        { op: "create_table", table: "customers", columns: [
          { name: "name", type: "text", required: true },
        ] },
        { op: "create_table", table: "jobs", columns: [
          { name: "title", type: "text", required: true },
          { name: "customer", type: "text", required: false },
        ] },
      ];
      store.commit({
        intent: "seed conversion", summary: "Seeds a linked conversion.",
        migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) },
        panels: [{
          panel_id: "jobs_table", title: "Jobs", placement: { region: "main", order: 0 },
          code: `export default function(clay){clay.db.query({from:"jobs",select:["id","customer"]}).then(rows=>clay.ui.render(h(Table,{rows,columns:[{field:"customer"}]})))}`,
          declared_queries: [{ from: "jobs", select: ["id", "customer"] }],
          declared_writes: [],
        }],
      });
      store.insert("customers", { name: "Acme" });
      const job = store.insert("jobs", { title: "Install", customer: "Acme" });
      const stale = store.previewRelationConversion({
        sourceTable: "jobs", sourceField: "customer",
        targetTable: "customers", displayField: "name",
      });
      store.update("jobs", String(job.id), { customer: "Changed" });
      expect(() => store.convertTextToRelation({ ...stale, cardinality: "one" }))
        .toThrow(/changed after the conversion preview/i);
      store.update("jobs", String(job.id), { customer: "Acme" });
      const fresh = store.previewRelationConversion({
        sourceTable: "jobs", sourceField: "customer",
        targetTable: "customers", displayField: "name",
      });
      const result = store.convertTextToRelation({ ...fresh, cardinality: "one" });
      const panel = store.livePanels()[0]!;
      expect(panel.declared_queries[0]?.select).toContain(result.relationField);
      expect(panel.code).toContain(`"${result.relationField}"`);
      expect(panel.code).not.toContain('"customer"');
    } finally { store.close(); }
  });
});
