import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { ProjectionManifestV1 as ProjectionManifestSchema } from "@clay/schema/projection";
import {
  ClayStore, deriveInverse, openMemoryDriver, type ForwardOpT,
} from "../src/index";
import {
  decodeProjectionArtifactV1, decodeProjectionPlaintextV1, decodeProjectionTransportV1,
  projectPlaintextV1,
  projectionTransportV1, type ProjectionRequestV1,
} from "../src/projection";

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(fileURLToPath(
  new URL(`./fixtures/${name}`, import.meta.url),
)));

async function projectionFixture(): Promise<{ store: ClayStore; driver: Awaited<ReturnType<typeof openMemoryDriver>> }> {
  const driver = await openMemoryDriver();
  const store = ClayStore.fromDriver(driver);
  const create: ForwardOpT[] = [
    { op: "create_table", table: "customers", columns: [
      { name: "name", label: "Name", type: "text", required: true },
    ] },
    { op: "create_table", table: "jobs", columns: [
      { name: "title", label: "Title", type: "text", required: true },
      { name: "notes", label: "Notes", type: "rich_text", required: false },
      { name: "status", label: "Status", type: "enum", required: false, values: ["open", "done"] },
      { name: "amount", label: "Amount", type: "number", required: false },
      { name: "empty", label: "Empty", type: "text", required: false },
      { name: "secret", label: "Secret", type: "text", required: false },
      { name: "files", label: "Files", type: "attachment", required: false },
      { name: "customer", label: "Customer", type: "relation", required: false,
        relation: { target_table: "customers", cardinality: "one",
          unique_targets: false, display_field: "name" } },
    ] },
  ];
  store.commit({ intent: "projection fixture", summary: "Create export fixture.",
    migration: { operations: create, inverse: deriveInverse(create, store.registrySnapshot()) } });
  const acme = store.insert("customers", { name: "Acme" });
  const beta = store.insert("customers", { name: "Beta" });
  store.insert("jobs", {
    title: "=2+3", notes: "Line 1\r\n\"quoted\", yes", status: "open", amount: 7.5,
    empty: null, secret: "NEVER_EXPORT", customer: acme.id,
  });
  store.insert("jobs", {
    title: "Alpha", notes: "plain", status: "open", amount: 10,
    empty: null, secret: "ALSO_NEVER_EXPORT", customer: beta.id,
  });
  store.insert("jobs", {
    title: "Filtered out", notes: "not visible", status: "done", amount: 99,
    empty: null, secret: "FILTERED_SECRET", customer: acme.id,
  });
  const evolve: ForwardOpT[] = [
    { op: "create_computed", table: "jobs", column: "double_amount", expr: "amount * 2" },
    { op: "hide_column", table: "jobs", column: "secret" },
  ];
  store.commit({ intent: "finish projection fixture", summary: "Add derived and hidden fields.",
    migration: { operations: evolve, inverse: deriveInverse(evolve, store.registrySnapshot()) } });
  return { store, driver };
}

function requestFor(store: ClayStore): Extract<ProjectionRequestV1, { kind: "current_view" }> {
  const trace = store.semanticSchemaTrace();
  const table = trace.tables.find(item => item.name === "jobs")!;
  const fieldId = (name: string): string => trace.fields.find(item =>
    item.tableId === table.tableId && item.fieldName === name)!.fieldId;
  return {
    schema: 1,
    kind: "current_view",
    expectedSchemaVersion: trace.atVersion,
    tableId: table.tableId,
    fieldIds: ["title", "notes", "amount", "customer", "double_amount", "empty"].map(fieldId),
    view: {
      search: "",
      filter: { fieldId: fieldId("status"), op: "eq", value: "open" },
      sort: { fieldId: fieldId("amount"), dir: "desc" },
      dateAnchor: "2026-09-06",
    },
    options: { includeRecordIds: false, redactedFieldIds: [] },
  };
}

describe("ProjectionPlaintextV1 current Data view", () => {
  it("matches frozen plaintext and CSV bytes for exact filtered, sorted, visible output", async () => {
    const { store } = await projectionFixture();
    try {
      const artifact = await projectPlaintextV1(store, requestFor(store));
      expect(artifact.plaintext).toEqual(fixture("projection-current-view-v1.plaintext.json"));
      expect(artifact.csv).toEqual(fixture("projection-current-view-v1.csv"));
      const decoded = decodeProjectionPlaintextV1(artifact.plaintext);
      expect(decoded.manifest).toMatchObject({
        kind: "current_view", rowCount: 2, fieldCount: 6,
        completeness: { truncated: false, reason: null },
        policies: { relations: "friendly_labels", recordIds: "excluded",
          attachments: "excluded", hiddenFields: "excluded" },
      });
      const raw = new TextDecoder().decode(artifact.plaintext);
      expect(raw).not.toContain("NEVER_EXPORT");
      expect(raw).not.toContain("files");
      expect(raw).not.toContain("Filtered out");
    } finally { store.close(); }
  });

  it("rejects valid projection JSON whose keys are not in canonical order", async () => {
    const { store } = await projectionFixture();
    try {
      const artifact = await projectPlaintextV1(store, requestFor(store));
      const parsed = JSON.parse(new TextDecoder().decode(artifact.plaintext));
      const normalized = JSON.stringify({
        manifest: ProjectionManifestSchema.parse(parsed.manifest),
        rows: parsed.rows,
        schema: parsed.schema,
      });
      expect(normalized).toBe(new TextDecoder().decode(artifact.plaintext));
      const reordered = new TextEncoder().encode(JSON.stringify({
        schema: parsed.schema, rows: parsed.rows, manifest: parsed.manifest,
      }));
      expect(() => decodeProjectionPlaintextV1(reordered)).toThrow(/not canonical/i);
    } finally { store.close(); }
  });

  it("returns the exact recursively frozen preview with its canonical bytes", async () => {
    const { store } = await projectionFixture();
    try {
      const artifact = await projectPlaintextV1(store, requestFor(store));
      const plaintext = decodeProjectionPlaintextV1(artifact.plaintext);
      expect(artifact.projection).toEqual(plaintext);
      expect(Object.isFrozen(artifact.projection)).toBe(true);
      expect(Object.isFrozen(artifact.projection.manifest)).toBe(true);
      expect(Object.isFrozen(artifact.projection.manifest.fields)).toBe(true);
      expect(Object.isFrozen(artifact.projection.rows)).toBe(true);
      expect(Object.isFrozen(artifact.projection.rows[0])).toBe(true);
    } finally { store.close(); }
  });

  it("transports only canonical bytes without copying their buffers", async () => {
    const { store } = await projectionFixture();
    try {
      const artifact = await projectPlaintextV1(store, requestFor(store));
      const transport = projectionTransportV1(artifact);
      expect(Object.keys(transport)).toEqual(["plaintext", "csv"]);
      expect(transport.plaintext).toBe(artifact.plaintext);
      expect(transport.csv).toBe(artifact.csv);
      expect(Object.isFrozen(transport)).toBe(true);
      expect(decodeProjectionTransportV1(transport)).toEqual(artifact.projection);
    } finally { store.close(); }
  });

  it("lists explicit relation-label and computed dependencies in the frozen manifest", async () => {
    const { store } = await projectionFixture();
    try {
      const plaintext = decodeProjectionArtifactV1(
        projectPlaintextV1(store, requestFor(store)),
      );
      expect(plaintext.manifest.dependencies).toEqual([
        {
          fields: [{ field: "name", label: "Name", table: "customers" }],
          kind: "relation",
          output: "customer",
        },
        {
          fields: [{ field: "amount", label: "Amount", table: "jobs" }],
          kind: "computed",
          output: "double_amount",
        },
      ]);
    } finally { store.close(); }
  });

  it("binds the semantic print renderer version inside the canonical manifest", async () => {
    const { store } = await projectionFixture();
    try {
      const artifact = await projectPlaintextV1(store, requestFor(store));
      expect(decodeProjectionPlaintextV1(artifact.plaintext).manifest.renderer)
        .toEqual({ id: "clay-semantic-table", version: 1 });
    } finally { store.close(); }
  });

  it("binds CSV bytes to the exact frozen plaintext before any export action", async () => {
    const { store } = await projectionFixture();
    try {
      const artifact = await projectPlaintextV1(store, requestFor(store));
      expect(decodeProjectionArtifactV1(artifact).manifest.csv.byteCount)
        .toBe(artifact.csv.byteLength);
      const tampered = { ...artifact, csv: artifact.csv.slice() };
      const last = tampered.csv.byteLength - 1;
      tampered.csv[last] = (tampered.csv[last] ?? 0) ^ 1;
      expect(() => decodeProjectionArtifactV1(tampered))
        .toThrow(/CSV bytes do not match/i);
    } finally { store.close(); }
  });

  it("projects one record with explicit IDs and structural redaction only when requested", async () => {
    const { store } = await projectionFixture();
    try {
      const trace = store.semanticSchemaTrace();
      const table = trace.tables.find(entry => entry.name === "jobs")!;
      const field = (name: string) => trace.fields.find(entry =>
        entry.tableId === table.tableId && entry.fieldName === name)!.fieldId;
      const row = store.query({ from: "jobs" }).find(entry => entry.title === "=2+3")!;
      const plaintext = decodeProjectionArtifactV1(await projectPlaintextV1(store, {
        schema: 1,
        kind: "record",
        expectedSchemaVersion: trace.atVersion,
        tableId: table.tableId,
        fieldIds: [field("title"), field("customer")],
        recordId: String(row.id),
        options: { includeRecordIds: true, redactedFieldIds: [field("title")] },
      }));
      expect(plaintext.manifest.fields.map(item => item.name)).toEqual([
        "_clay_record_id", "title", "customer", "customer_clay_record_id",
      ]);
      expect(plaintext.manifest.policies).toMatchObject({
        recordIds: "included", relations: "friendly_labels_with_record_ids",
      });
      expect(plaintext.manifest.redactions).toEqual(["Title"]);
      expect(plaintext.rows).toEqual([[
        String(row.id), "[redacted]", "Acme", expect.stringMatching(/^[0-9a-f-]{36}$/),
      ]]);
    } finally { store.close(); }
  });

  it("redacts generated relation IDs whenever their source relation is redacted", async () => {
    const { store } = await projectionFixture();
    try {
      const trace = store.semanticSchemaTrace();
      const table = trace.tables.find(entry => entry.name === "jobs")!;
      const field = (name: string) => trace.fields.find(entry =>
        entry.tableId === table.tableId && entry.fieldName === name)!.fieldId;
      const row = store.query({ from: "jobs" }).find(entry => entry.title === "=2+3")!;
      const relationId = (row.customer as { id: string }).id;
      const artifact = projectPlaintextV1(store, {
        schema: 1,
        kind: "record",
        expectedSchemaVersion: trace.atVersion,
        tableId: table.tableId,
        fieldIds: [field("title"), field("customer")],
        recordId: String(row.id),
        options: { includeRecordIds: true, redactedFieldIds: [field("customer")] },
      });
      const plaintext = decodeProjectionArtifactV1(artifact);
      expect(plaintext.manifest.fields.map(output => ({
        name: output.name, redacted: output.redacted,
      }))).toEqual([
        { name: "_clay_record_id", redacted: false },
        { name: "title", redacted: false },
        { name: "customer", redacted: true },
        { name: "customer_clay_record_id", redacted: true },
      ]);
      expect(plaintext.manifest.redactions).toEqual(["Customer"]);
      expect(plaintext.rows).toEqual([[
        String(row.id), "=2+3", "[redacted]", "[redacted]",
      ]]);
      expect(new TextDecoder().decode(artifact.plaintext)).not.toContain(relationId);
      expect(new TextDecoder().decode(artifact.csv)).not.toContain(relationId);
    } finally { store.close(); }
  });

  it("does not write Store/history or call network while projecting", async () => {
    const { store, driver } = await projectionFixture();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    try {
      const changes = Number(driver.select("SELECT total_changes() AS n")[0]!.n);
      const history = store.history();
      const rowHistory = store.rowHistoryCount();
      const rows = JSON.stringify(store.query({ from: "jobs" }));
      await projectPlaintextV1(store, requestFor(store));
      expect(Number(driver.select("SELECT total_changes() AS n")[0]!.n)).toBe(changes);
      expect(store.history()).toEqual(history);
      expect(store.rowHistoryCount()).toBe(rowHistory);
      expect(JSON.stringify(store.query({ from: "jobs" }))).toBe(rows);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); store.close(); }
  });

  it("fails closed on stale identities and excluded attachment fields", async () => {
    const { store } = await projectionFixture();
    try {
      const request = requestFor(store);
      expect(() => projectPlaintextV1(store, {
        ...request, expectedSchemaVersion: request.expectedSchemaVersion + 1,
      })).toThrow(/schema changed/i);
      const trace = store.semanticSchemaTrace();
      const table = trace.tables.find(entry => entry.name === "jobs")!;
      const files = trace.fields.find(entry => entry.tableId === table.tableId
        && entry.fieldName === "files")!;
      expect(() => projectPlaintextV1(store, {
        ...request, fieldIds: [...request.fieldIds, files.fieldId],
      })).toThrow(/attachment.*excluded/i);
      expect(() => projectPlaintextV1(store, {
        ...request,
        view: {
          ...request.view,
          filter: { fieldId: files.fieldId, op: "not_null" },
        },
      })).toThrow(/attachment.*filter.*excluded/i);
    } finally { store.close(); }
  });
});
