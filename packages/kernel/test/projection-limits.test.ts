import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, release, totalmem } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ClayStore, deriveInverse, openMemoryDriver, type DbDriver, type ForwardOpT,
} from "../src/index";
import {
  decodeProjectionArtifactV1, projectPlaintextV1, projectPlaintextV1Cooperative,
  type ProjectionRequestV1,
} from "../src/projection";

async function seeded(count: number, keepOnlyFirst = false): Promise<{
  store: ClayStore; driver: DbDriver; request: ProjectionRequestV1;
}> {
  const driver = await openMemoryDriver();
  const store = ClayStore.fromDriver(driver);
  const operations: ForwardOpT[] = [{ op: "create_table", table: "tasks", columns: [
    { name: "title", type: "text", required: true },
  ] }];
  store.commit({ intent: "tasks", summary: "Tasks.", migration: {
    operations, inverse: deriveInverse(operations, store.registrySnapshot()),
  } });
  driver.tx(() => {
    for (let index = 0; index < count; index++) {
      const id = `018f0000-0000-7000-8000-${index.toString(16).padStart(12, "0")}`;
      driver.exec(`INSERT INTO "tasks"("id","created_at","updated_at","deleted_at","title")
        VALUES (?,?,?,?,?)`, [id, "2026-09-06", "2026-09-06", null,
        keepOnlyFirst && index === 0 ? "keep" : `Task ${index}`]);
    }
  });
  const trace = store.semanticSchemaTrace();
  const table = trace.tables.find(entry => entry.name === "tasks")!;
  const title = trace.fields.find(entry => entry.tableId === table.tableId
    && entry.fieldName === "title")!;
  return {
    store,
    driver,
    request: {
      schema: 1,
      kind: "current_view",
      expectedSchemaVersion: trace.atVersion,
      tableId: table.tableId,
      fieldIds: [title.fieldId],
      view: {
        search: "",
        filter: keepOnlyFirst ? { fieldId: title.fieldId, op: "eq", value: "keep" } : null,
        sort: null,
        dateAnchor: "2026-09-06",
      },
      options: { includeRecordIds: false, redactedFieldIds: [] },
    },
  };
}

function percentile95(samples: readonly number[]): number {
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
}

describe("finite projection limits and performance", () => {
  it("allows exactly 5,000 rows and fails instead of returning a truncated 5,001st", async () => {
    const { store, driver, request } = await seeded(5000);
    try {
      const complete = decodeProjectionArtifactV1(await projectPlaintextV1(store, request));
      expect(complete.manifest.rowCount).toBe(5000);
      expect(complete.rows.at(-1)).toEqual(["Task 4999"]);
      driver.exec(`INSERT INTO "tasks"("id","created_at","updated_at","deleted_at","title")
        VALUES (?,?,?,?,?)`, ["018f0000-0000-7000-8000-000000005001",
        "2026-09-06", "2026-09-06", null, "Task 5000"]);
      expect(() => projectPlaintextV1(store, request)).toThrow(/more than 5,000 matching rows/i);
    } finally { store.close(); }
  }, 20_000);

  it("blocks a projection whose canonical plaintext exceeds 8 MiB without truncating a cell", async () => {
    const { store, driver, request } = await seeded(1);
    try {
      driver.exec(`UPDATE "tasks" SET "title" = ?`, ["x".repeat(8 * 1024 * 1024 - 100)]);
      expect(() => projectPlaintextV1(store, request)).toThrow(/8 MiB plaintext limit/i);
    } finally { store.close(); }
  }, 15_000);

  it("blocks a narrow filter when the Data surface cannot prove source completeness", async () => {
    const { store, request } = await seeded(20_001, true);
    try {
      expect(() => projectPlaintextV1(store, request))
        .toThrow(/more than 20,000 source rows.*cannot prove completeness/i);
    } finally { store.close(); }
  }, 30_000);

  it("fails closed at the incremental source-input budget even when filtering would hide it", async () => {
    const { store, driver, request } = await seeded(33);
    try {
      driver.exec(`UPDATE "tasks" SET "title" = ?`, ["x".repeat(1024 * 1024)]);
      if (request.kind !== "current_view") throw new Error("fixture request changed kind");
      request.view.filter = { fieldId: request.fieldIds[0]!, op: "eq", value: "never" };
      expect(() => projectPlaintextV1(store, request))
        .toThrow(/32 MiB source-input limit/i);
    } finally { store.close(); }
  }, 20_000);

  it.each([5000, 5001])(
    "cooperatively cancels the worker path before finishing a %i-row projection",
    async (rowCount) => {
      const { store, request } = await seeded(rowCount);
      let cancelled = false;
      let yields = 0;
      try {
        await expect(projectPlaintextV1Cooperative(store, request, {
          isCancelled: () => cancelled,
          yieldControl: async () => {
            yields++;
            cancelled = true;
            await Promise.resolve();
          },
        })).rejects.toMatchObject({ code: "E_CANCELLED" });
        expect(yields).toBe(1);
      } finally { store.close(); }
    },
    20_000,
  );

  it("meets the explicit 1k/5k worker projection p95 budgets over 30 samples", async () => {
    const small = await seeded(1000);
    const large = await seeded(5000);
    try {
      const measure = async (store: ClayStore, request: ProjectionRequestV1): Promise<number> => {
        const started = performance.now();
        await projectPlaintextV1(store, request);
        return performance.now() - started;
      };
      await measure(small.store, small.request);
      await measure(large.store, large.request);
      const smallSamples: number[] = [];
      const largeSamples: number[] = [];
      for (let index = 0; index < 30; index++)
        smallSamples.push(await measure(small.store, small.request));
      for (let index = 0; index < 30; index++)
        largeSamples.push(await measure(large.store, large.request));
      const smallP95 = percentile95(smallSamples);
      const largeP95 = percentile95(largeSamples);
      const result = {
        sampleSize: 30,
        rows1000P95Ms: Number(smallP95.toFixed(3)),
        rows5000P95Ms: Number(largeP95.toFixed(3)),
        limitsMs: { rows1000: 2000, rows5000: 5000 },
      };
      console.info("PROJECTION_BENCHMARK", JSON.stringify(result));
      if (process.env.CLAY_PROJECTION_BENCHMARK_REPORT) {
        const reportPath = resolve(process.env.CLAY_PROJECTION_BENCHMARK_REPORT);
        const descriptor = JSON.stringify({ schema: 1, fields: ["title"],
          conditions: [{ rows: 1000 }, { rows: 5000 }], samples: 30 });
        const git = (...args: string[]): string => execFileSync("git", args, {
          cwd: resolve(import.meta.dirname, "../../.."), encoding: "utf8",
        }).trim();
        const cpu = cpus();
        const report = {
          schema: "ProjectionBenchmarkEvidenceManifestV1",
          generatedAt: new Date().toISOString(),
          source: { commit: git("rev-parse", "HEAD"), tree: git("write-tree") },
          runtime: { node: process.version, platform: process.platform,
            arch: process.arch, osRelease: release() },
          hardware: { cpuModel: cpu[0]?.model ?? "unknown", logicalCpuCount: cpu.length,
            totalMemoryBytes: totalmem() },
          conditions: {
            workerEquivalent: "synchronous Kernel projector used by dedicated DB worker",
            command: "vitest run test/projection-limits.test.ts --maxWorkers=1 --minWorkers=1",
            fixtureSha256: `sha256:${createHash("sha256").update(descriptor).digest("hex")}`,
            plaintextLimitBytes: 8 * 1024 * 1024, rowLimit: 5000,
            peakMemory: "not measured; finite row/field/byte caps are asserted separately",
          },
          samplesMs: { rows1000: smallSamples, rows5000: largeSamples },
          result,
          verdict: smallP95 < 2000 && largeP95 < 5000 ? "PASS" : "FAIL",
        };
        mkdirSync(dirname(reportPath), { recursive: true });
        writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
      }
      expect(smallP95).toBeLessThan(2000);
      expect(largeP95).toBeLessThan(5000);
    } finally { small.store.close(); large.store.close(); }
  }, 30_000);
});
