import { describe, expect, it } from "vitest";
import type { DbDriver, SqlRow, SqlValue } from "../src/db";
import { productionOperationIdV2 } from "../src/production-operation-id";
import { encodeProductionResponse } from "../src/production-response-envelope";
import { readCommittedSampleProducerReceipts } from "../src/production-request-journal";

const scope = {
  authorityIncarnationId: `auth_${"m".repeat(26)}`,
  appInstanceId: `app_${"p".repeat(26)}`,
  activeGenerationId: `gen_${"q".repeat(26)}`,
  lineageEpoch: "0",
};
const requestId = `req_${"n".repeat(26)}`;
const producerOperationId = productionOperationIdV2(
  scope.authorityIncarnationId, requestId, "samples.fill",
);

function producerMetadata(count: number, responseBytes: number): SqlRow[] {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  return Array.from({ length: count }, (_, index) => {
    let value = index + 1;
    let suffix = "";
    while (suffix.length < 26) {
      suffix = `${alphabet[value % 32]}${suffix}`;
      value = Math.floor(value / 32);
    }
    const id = `req_${suffix}`;
    return {
      request_id: id,
      operation_id: productionOperationIdV2(
        scope.authorityIncarnationId, id, "samples.fill",
      ),
      response_bytes: responseBytes,
    };
  });
}

function historyDriver(
  row: SqlRow,
  metadata: SqlRow[] = [],
): { driver: DbDriver; calls: string[] } {
  const calls: string[] = [];
  const driver = {
    select(sql: string, _params?: SqlValue[]): SqlRow[] {
      calls.push(sql);
      if (sql.includes("COUNT(*)")) return [row];
      if (sql.includes("request_id,operation_id")) return metadata;
      throw new Error("receipt bodies must remain unread");
    },
  } as unknown as DbDriver;
  return { driver, calls };
}

describe("bounded sample producer receipt history", () => {
  it("does not derive producer membership from response JSON", () => {
    const { driver, calls } = historyDriver({ receipt_count: 0 });
    expect(readCommittedSampleProducerReceipts(driver, scope)).toEqual([]);
    expect(calls).toHaveLength(4);
    expect(calls.join("\n")).not.toMatch(
      /substr\s*\(\s*response_json|clay-response|starter\.seed|samples\.fill/i,
    );
  });

  it("rejects excessive route metadata before reading operation identities", () => {
    const { driver, calls } = historyDriver({
      receipt_count: 100_001,
    });
    expect(() => readCommittedSampleProducerReceipts(driver, scope)).toThrow(
      /route history exceeds.*limit/i,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toMatch(/response_json/i);
  });

  it("loads a producer operation even when its response claims a nonproducer route", () => {
    const relabeled = encodeProductionResponse("store.insert", {
      id: "018f4c2a-7b31-7002-8000-000000000003",
    });
    const commonRow: SqlRow = {
      request_id: requestId,
      operation_id: producerOperationId,
      request_sha256: `sha256:${"a".repeat(64)}`,
      app_instance_id: scope.appInstanceId,
      active_generation_id: scope.activeGenerationId,
      lineage_epoch: scope.lineageEpoch,
      expected_protection_revision: "0",
      expected_state_sha256: `sha256:${"b".repeat(64)}`,
      state: "committed",
      resulting_protection_revision: "1",
      resulting_state_sha256: `sha256:${"c".repeat(64)}`,
      response_sha256: relabeled.sha256,
      prepared_at: "2026-09-06T00:00:00.000Z",
      invoked_at: "2026-09-06T00:00:01.000Z",
      completed_at: "2026-09-06T00:00:02.000Z",
    };
    const driver = {
      select(sql: string): SqlRow[] {
        if (sql.includes("COUNT(*)")) return [{ receipt_count: 1 }];
        if (sql.includes("request_id,operation_id")) return [{
          request_id: requestId,
          operation_id: producerOperationId,
          response_bytes: new TextEncoder().encode(relabeled.json).byteLength,
        }];
        if (sql.includes("FROM sys.production_request_receipts"))
          return [{ ...commonRow, response_json: relabeled.json }];
        if (sql.includes("FROM catalog.production_request_receipts")) return [commonRow];
        throw new Error(`unexpected query: ${sql}`);
      },
    } as unknown as DbDriver;
    const receipts = readCommittedSampleProducerReceipts(driver, scope);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.operationId).toBe(producerOperationId);
    expect(receipts[0]?.responseJson).toBe(relabeled.json);
  });

  it("rejects a catalog-only producer receipt", () => {
    const driver = {
      select(sql: string): SqlRow[] {
        if (sql.includes("COUNT(*)")) {
          const catalog = sql.includes("catalog.production_request_receipts");
          return [{ receipt_count: catalog ? 1 : 0 }];
        }
        if (sql.includes("FROM sys.production_request_receipts")
            && sql.includes("request_id,operation_id")) return [];
        if (sql.includes("FROM catalog.production_request_receipts")
            && sql.includes("request_id,operation_id")) {
          return [{ request_id: requestId, operation_id: producerOperationId }];
        }
        throw new Error(`unexpected query: ${sql}`);
      },
    } as unknown as DbDriver;
    expect(() => readCommittedSampleProducerReceipts(driver, scope)).toThrow(
      /mirror|incomplete/i,
    );
  });

  it("rejects producer receipts disappearing after metadata discovery", () => {
    const driver = {
      select(sql: string): SqlRow[] {
        if (sql.includes("COUNT(*)")) return [{ receipt_count: 1 }];
        if (sql.includes("request_id,operation_id")) return [{
          request_id: requestId,
          operation_id: producerOperationId,
          response_bytes: 1,
        }];
        if (sql.includes("SELECT *")) return [];
        throw new Error(`unexpected query: ${sql}`);
      },
    } as unknown as DbDriver;
    expect(() => readCommittedSampleProducerReceipts(driver, scope)).toThrow(
      /changed|incomplete/i,
    );
  });

  it("rejects excessive producer count before loading receipt bodies", () => {
    const metadata = producerMetadata(10_002, 1);
    const { driver, calls } = historyDriver({
      receipt_count: 10_002,
    }, metadata);
    expect(() => readCommittedSampleProducerReceipts(driver, scope))
      .toThrow(/receipt history exceeds.*limit/i);
    expect(calls).toHaveLength(4);
  });

  it("rejects excessive aggregate response bytes before loading receipt bodies", () => {
    const metadata = producerMetadata(5, 2_000_000);
    const { driver, calls } = historyDriver({ receipt_count: 5 }, metadata);
    expect(() => readCommittedSampleProducerReceipts(driver, scope))
      .toThrow(/receipt history exceeds.*limit/i);
    expect(calls).toHaveLength(4);
  });
});
