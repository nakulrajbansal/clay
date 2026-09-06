import { describe, expect, it } from "vitest";
import {
  productionOperationIdV1,
  productionOperationIdV2,
  sampleProducerRouteForOperationId,
} from "../src/production-operation-id";

const authority = `auth_${"a".repeat(26)}`;
const request = `req_${"b".repeat(26)}`;

describe("production operation identity", () => {
  it("preserves the legacy v1 vector for ordinary receipt replay", () => {
    expect(productionOperationIdV1(authority, request))
      .toBe("op_2353ctnne5zoilaitvv77pqctd");
  });

  it("binds v2 identities to the captured route", () => {
    expect(productionOperationIdV2(authority, request, "samples.fill"))
      .toBe("op_bv6vsa3tcaej3nopfsp2nfzaxd");
    expect(productionOperationIdV2(authority, request, "starter.seed"))
      .not.toBe(productionOperationIdV2(authority, request, "samples.fill"));
  });

  it("classifies producer membership without reading response data", () => {
    expect(sampleProducerRouteForOperationId(
      authority, request, productionOperationIdV2(authority, request, "samples.fill"),
    )).toBe("samples.fill");
    expect(sampleProducerRouteForOperationId(
      authority, request, productionOperationIdV2(authority, request, "starter.seed"),
    )).toBe("starter.seed");
    expect(sampleProducerRouteForOperationId(
      authority, request, productionOperationIdV2(authority, request, "store.insert"),
    )).toBeNull();
    expect(sampleProducerRouteForOperationId(
      authority, request, productionOperationIdV1(authority, request),
    )).toBeNull();
  });
});
