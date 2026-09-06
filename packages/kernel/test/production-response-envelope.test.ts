import { describe, expect, it } from "vitest";
import {
  authenticatedSampleResponse,
  decodeProductionResponse,
  decodeProductionResponseResult,
  encodeProductionResponse,
  productionResponseRoutePrefix,
} from "../src/production-response-envelope";

const tableId = "tbl_018f4c2a-7b31-7001-8000-000000000001";
const coordinates = [
  { tableId, rowId: "018f4c2a-7b31-7002-8000-000000000001" },
  { tableId, rowId: "018f4c2a-7b31-7002-8000-000000000002" },
] as const;

describe("production receipt response envelope", () => {
  it("canonically binds a sample result to its route and exact coordinates", () => {
    const encoded = encodeProductionResponse(
      "samples.fill", { tables: 1, added: 2 }, coordinates,
    );
    expect(encoded.json).toBe(productionResponseRoutePrefix("samples.fill") + JSON.stringify({
      result: { added: 2, tables: 1 },
      route: "samples.fill",
      sampleProvenance: coordinates.map(entry => ({ rowId: entry.rowId, tableId: entry.tableId })),
      schema: 1,
    }));
    expect(decodeProductionResponse(encoded.json)).toEqual({
      kind: "envelope",
      route: "samples.fill",
      result: { added: 2, tables: 1 },
      sampleProvenance: coordinates,
    });
  });

  it("keeps legacy raw results replayable but never authenticates them as sample evidence", () => {
    const legacy = JSON.stringify({ added: 2, tables: 1 });
    expect(decodeProductionResponseResult(legacy, "samples.fill"))
      .toEqual({ added: 2, tables: 1 });
    expect(authenticatedSampleResponse(legacy)).toBeNull();
  });

  it("keeps every legacy JSON value unambiguous from prefixed envelopes", () => {
    const legacyValues = [{
      id: "018f4c2a-7b31-7002-8000-000000000003",
      result: "user value",
      route: "store.insert",
      schema: 1,
    }, {
      result: "user value",
      route: "store.insert",
      schema: 1,
    }];
    for (const value of legacyValues) {
      const json = JSON.stringify(value);
      expect(decodeProductionResponseResult(json, "store.insert")).toEqual(value);
      expect(authenticatedSampleResponse(json)).toBeNull();
    }
  });

  it("preserves own __proto__ data fields across durable replay", () => {
    const result = Object.create(null) as Record<string, unknown>;
    result.__proto__ = { retained: true };
    result.safe = 1;
    const encoded = encodeProductionResponse("setting.compareAndSet", result as never);
    const replayed = decodeProductionResponseResult(encoded.json, "setting.compareAndSet");
    expect(Object.getPrototypeOf(replayed)).toBeNull();
    expect(Object.isFrozen(replayed)).toBe(true);
    expect(Reflect.ownKeys(replayed as object)).toEqual(["__proto__", "safe"]);
    expect(replayed).toEqual(result);
    expect(Object.isFrozen((replayed as Record<string, object>).__proto__)).toBe(true);
  });

  it("does not downgrade an envelope-looking malformed response to legacy", () => {
    const malformed = productionResponseRoutePrefix("samples.fill") + JSON.stringify({
      route: "samples.fill",
      sampleProvenance: [],
      schema: 1,
    });
    expect(() => decodeProductionResponse(malformed)).toThrow(/envelope/i);
  });

  it("rejects a valid envelope replayed for another route", () => {
    const encoded = encodeProductionResponse(
      "samples.fill", { added: 2, tables: 1 }, coordinates,
    );
    expect(() => decodeProductionResponseResult(encoded.json, "starter.seed"))
      .toThrow(/response route/i);
  });

  it("enforces the complete 2,000,000-byte response envelope", () => {
    const empty = encodeProductionResponse("store.insert", "");
    const overhead = new TextEncoder().encode(empty.json).byteLength;
    const exact = encodeProductionResponse("store.insert", "x".repeat(2_000_000 - overhead));
    expect(new TextEncoder().encode(exact.json).byteLength).toBe(2_000_000);
    expect(() => encodeProductionResponse(
      "store.insert", "x".repeat(2_000_001 - overhead),
    )).toThrow(/durable evidence limit/i);
  });

  it("fits the maximum 10,000 UUIDv7 sample coordinates inside the response budget", () => {
    const maximum = Array.from({ length: 10_000 }, (_, index) => ({
      tableId,
      rowId: `018f4c2a-7b31-7002-8000-${index.toString().padStart(12, "0")}`,
    }));
    const encoded = encodeProductionResponse(
      "samples.fill", { added: 10_000, tables: 1 }, maximum,
    );
    expect(new TextEncoder().encode(encoded.json).byteLength).toBeLessThan(2_000_000);
    expect(authenticatedSampleResponse(encoded.json)?.sampleProvenance).toHaveLength(10_000);
  });

  it("rejects duplicated or reordered coordinates before writing a receipt", () => {
    expect(() => encodeProductionResponse(
      "samples.fill", { added: 2, tables: 1 }, [coordinates[0], coordinates[0]],
    )).toThrow(/duplicated|reordered/i);
    expect(() => encodeProductionResponse(
      "samples.fill", { added: 2, tables: 1 }, [...coordinates].reverse(),
    )).toThrow(/duplicated|reordered/i);
  });

  it("rejects noncanonical, duplicated, or malformed sample coordinates", () => {
    const duplicate = productionResponseRoutePrefix("samples.fill") + JSON.stringify({
      result: { added: 2, tables: 1 },
      route: "samples.fill",
      sampleProvenance: [
        { rowId: coordinates[0].rowId, tableId: coordinates[0].tableId },
        { rowId: coordinates[0].rowId, tableId: coordinates[0].tableId },
      ],
      schema: 1,
    });
    expect(() => decodeProductionResponse(duplicate)).toThrow(/duplicated|reordered/i);
    const malformed = productionResponseRoutePrefix("samples.fill") + JSON.stringify({
      result: { added: 1, tables: 1 },
      route: "samples.fill",
      sampleProvenance: [{ rowId: "row-a", tableId }],
      schema: 1,
    });
    expect(() => decodeProductionResponse(malformed)).toThrow(/sample evidence/i);
    const noncanonical = productionResponseRoutePrefix("samples.fill") + JSON.stringify({
      schema: 1,
      route: "samples.fill",
      result: { added: 0, tables: 0 },
      sampleProvenance: [],
    });
    expect(() => decodeProductionResponse(noncanonical)).toThrow(/envelope/i);
  });
});
