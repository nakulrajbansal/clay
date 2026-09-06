import { describe, expect, it } from "vitest";
import { assertAuthenticatedSampleProvenance } from "../src/sample-provenance-proof";
import { productionOperationIdV2 } from "../src/production-operation-id";
import { encodeProductionResponse } from "../src/production-response-envelope";
import { sha256HexSync } from "../src/state-digest";

const id = (prefix: string, char: string): string => `${prefix}_${char.repeat(26)}`;
const digest = (char: string): string => `sha256:${char.repeat(64)}`;
const tableId = "tbl_018f4c2a-7b31-7001-8000-000000000001";
const authorityIncarnationId = id("auth", "m");
const requestId = id("req", "n");
const operationId = productionOperationIdV2(
  authorityIncarnationId, requestId, "samples.fill",
);
const requestSha256 = digest("c");
const expectedStateSha256 = digest("a");
const resultingStateSha256 = digest("b");
const coordinates = [
  { tableId, rowId: "018f4c2a-7b31-7002-8000-000000000001" },
  { tableId, rowId: "018f4c2a-7b31-7002-8000-000000000002" },
] as const;
const response = encodeProductionResponse(
  "samples.fill", { added: 2, tables: 1 }, coordinates,
);
const receipt = {
  schema: 1 as const,
  requestId,
  operationId,
  requestSha256,
  appInstanceId: id("app", "p"),
  activeGenerationId: id("gen", "q"),
  lineageEpoch: "0",
  expectedProtectionRevision: "0",
  expectedStateSha256,
  state: "committed" as const,
  resultingProtectionRevision: "1",
  resultingStateSha256,
  responseSha256: response.sha256,
  preparedAt: "2026-09-06T00:00:00.000Z",
  invokedAt: "2026-09-06T00:00:01.000Z",
  completedAt: "2026-09-06T00:00:02.000Z",
};
const targetReservation = {
  operationId,
  revision: "1",
  expectedProtectionRevision: "0",
  expectedStateSha256,
  requestSha256,
  state: "committed" as const,
  reservedAt: receipt.preparedAt,
  finalizedAt: receipt.completedAt,
  stateSha256: resultingStateSha256,
};
const catalogReservation = {
  schema: 1 as const,
  authorityIncarnationId: id("auth", "r"),
  reservedCatalogGeneration: "3",
  finalizedCatalogGeneration: "4",
  writeEpoch: "1",
  leaseId: id("lease", "s"),
  releaseId: id("rel", "t"),
  finalizedWriteEpoch: "1",
  finalizedLeaseId: id("lease", "s"),
  finalizedReleaseId: id("rel", "t"),
  appInstanceId: receipt.appInstanceId,
  activeGenerationId: receipt.activeGenerationId,
  lineageEpoch: receipt.lineageEpoch,
  revision: "1",
  operationId,
  expectedProtectionRevision: "0",
  expectedStateSha256,
  requestSha256,
  state: "committed" as const,
  publishedActiveGenerationId: receipt.activeGenerationId,
  publishedLineageEpoch: receipt.lineageEpoch,
  stateSha256: resultingStateSha256,
  reservedAt: receipt.preparedAt,
  finalizedAt: receipt.completedAt,
};
const proof = {
  authorityIncarnationId,
  target: {
    appInstanceId: receipt.appInstanceId,
    activeGenerationId: receipt.activeGenerationId,
    lineageEpoch: receipt.lineageEpoch,
  },
  ledgerEntries: coordinates.map(coordinate => ({ ...coordinate, operationId })),
  receipts: [{ receipt, responseJson: response.json }],
  catalogReceipts: [receipt],
  targetReservations: [targetReservation],
  catalogReservations: [catalogReservation],
};

describe("authenticated sample provenance proof", () => {
  it("accepts exact bidirectional producer, ledger, receipt, and reservation evidence", () => {
    expect(() => assertAuthenticatedSampleProvenance(proof)).not.toThrow();
  });

  it("rejects an unrelated committed route for a ledger operation", () => {
    const unrelated = encodeProductionResponse("store.insert", { id: "row-a" });
    const unrelatedReceipt = { ...receipt, responseSha256: unrelated.sha256 };
    expect(() => assertAuthenticatedSampleProvenance({
      ...proof,
      receipts: [{
        receipt: unrelatedReceipt,
        responseJson: unrelated.json,
      }],
      catalogReceipts: [unrelatedReceipt],
    })).toThrow(/operation.*response route/i);
  });

  it("rejects a producer operation relabeled as a nonproducer with its ledger omitted", () => {
    const relabeled = encodeProductionResponse("store.insert", {
      id: "018f4c2a-7b31-7002-8000-000000000003",
    });
    const relabeledReceipt = { ...receipt, responseSha256: relabeled.sha256 };
    expect(() => assertAuthenticatedSampleProvenance({
      ...proof,
      ledgerEntries: [],
      receipts: [{ receipt: relabeledReceipt, responseJson: relabeled.json }],
      catalogReceipts: [relabeledReceipt],
    })).toThrow(/producer|operation.*route|route.*operation/i);
  });

  it("rejects substitution between authenticated producer routes", () => {
    const substituted = encodeProductionResponse("starter.seed", null, coordinates);
    const substitutedReceipt = { ...receipt, responseSha256: substituted.sha256 };
    expect(() => assertAuthenticatedSampleProvenance({
      ...proof,
      receipts: [{ receipt: substitutedReceipt, responseJson: substituted.json }],
      catalogReceipts: [substitutedReceipt],
    })).toThrow(/operation.*route|route.*operation/i);
  });

  it("binds the fill table count to distinct stable table identities", () => {
    const wrongCount = encodeProductionResponse(
      "samples.fill", { added: 2, tables: 2 }, coordinates,
    );
    const wrongReceipt = { ...receipt, responseSha256: wrongCount.sha256 };
    expect(() => assertAuthenticatedSampleProvenance({
      ...proof,
      receipts: [{ receipt: wrongReceipt, responseJson: wrongCount.json }],
      catalogReceipts: [wrongReceipt],
    })).toThrow(/fill provenance result/i);
  });

  it("rejects either direction of ledger and authenticated-result omission", () => {
    expect(() => assertAuthenticatedSampleProvenance({
      ...proof,
      ledgerEntries: proof.ledgerEntries.slice(0, 1),
    })).toThrow(/ledger.*authenticated results/i);
    const oneCoordinate = encodeProductionResponse(
      "samples.fill", { added: 1, tables: 1 }, coordinates.slice(0, 1),
    );
    const oneCoordinateReceipt = { ...receipt, responseSha256: oneCoordinate.sha256 };
    expect(() => assertAuthenticatedSampleProvenance({
      ...proof,
      receipts: [{
        receipt: oneCoordinateReceipt,
        responseJson: oneCoordinate.json,
      }],
      catalogReceipts: [oneCoordinateReceipt],
    })).toThrow(/ledger.*authenticated results/i);
  });

  it("rejects missing or divergent mirrored reservation evidence", () => {
    expect(() => assertAuthenticatedSampleProvenance({
      ...proof,
      catalogReceipts: [],
    })).toThrow(/receipt mirror/i);
    expect(() => assertAuthenticatedSampleProvenance({
      ...proof,
      targetReservations: [],
    })).toThrow(/reservation evidence.*incomplete/i);
    expect(() => assertAuthenticatedSampleProvenance({
      ...proof,
      catalogReservations: [{ ...catalogReservation, requestSha256: digest("d") }],
    })).toThrow(/reservation evidence diverges/i);
  });

  it("ignores mirrored receipts from another generation of the same app", () => {
    const oldRequestId = id("req", "o");
    const oldReceipt = {
      ...receipt,
      requestId: oldRequestId,
      operationId: productionOperationIdV2(
        authorityIncarnationId, oldRequestId, "samples.fill",
      ),
      activeGenerationId: id("gen", "r"),
    };
    expect(() => assertAuthenticatedSampleProvenance({
      ...proof,
      catalogReceipts: [receipt, oldReceipt],
    })).not.toThrow();
  });

  it("allows an empty producer no-op to authorize zero provenance", () => {
    const noOpResponse = encodeProductionResponse(
      "samples.fill", { added: 0, tables: 0 }, [],
    );
    const noOpReceipt = {
      ...receipt,
      state: "no_op" as const,
      resultingProtectionRevision: receipt.expectedProtectionRevision,
      resultingStateSha256: receipt.expectedStateSha256,
      responseSha256: noOpResponse.sha256,
      invokedAt: null,
    };
    expect(() => assertAuthenticatedSampleProvenance({
      authorityIncarnationId,
      target: proof.target,
      ledgerEntries: [],
      receipts: [{ receipt: noOpReceipt, responseJson: noOpResponse.json }],
      catalogReceipts: [noOpReceipt],
      targetReservations: [],
      catalogReservations: [],
    })).not.toThrow();
  });

  it("never treats a legacy raw result as provenance authentication", () => {
    const legacy = JSON.stringify({ added: 2, tables: 1 });
    const legacySha256 = `sha256:${sha256HexSync(new TextEncoder().encode(legacy))}`;
    const legacyReceipt = { ...receipt, responseSha256: legacySha256 };
    expect(() => assertAuthenticatedSampleProvenance({
      ...proof,
      receipts: [{
        receipt: legacyReceipt,
        responseJson: legacy,
      }],
      catalogReceipts: [legacyReceipt],
    })).toThrow(/producer operation.*legacy response/i);
  });
});
