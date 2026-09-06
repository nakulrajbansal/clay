import { describe, expect, it } from "vitest";
import { DAILY_HOME_SOURCE_IDS_V1 } from "@clay/schema/daily-home";
import {
  decodeDailyHomeCursor,
  encodeDailyHomeCursor,
  verifyDailyHomeCursor,
} from "../src/daily-home-basis";

const opaque = (prefix: string, char: string): string => `${prefix}_${char.repeat(26)}`;
const transport = (value: unknown): string => JSON.stringify(value);

const sourceLibrary = {
  schema: 1 as const,
  revision: 2,
  profiles: [{
    schema: 1 as const,
    profileId: opaque("dsp", "e"),
    tableId: "tbl_018f4c2a-7b31-7001-8000-000000000001",
    labelFieldId: "fld_018f4c2a-7b31-7002-8000-000000000002",
    dueFieldId: "fld_018f4c2a-7b31-7003-8000-000000000003",
    completion: { kind: "none" as const },
    enabled: true,
  }],
};

const authority = {
  schema: 1 as const,
  appInstanceId: opaque("app", "c"),
  activeGenerationId: opaque("gen", "g"),
  schemaHead: "version-4",
  sourceLibrary,
  profileResolution: {
    readyProfileIds: [sourceLibrary.profiles[0]!.profileId],
    issueProfileIds: [],
  },
  dispositionWatermark: "0",
  sourceWatermarks: [
    { sourceId: "automation_notification" as const, watermark: "automation:1", status: "ready" as const, statusEpoch: "status:1" },
    { sourceId: "due_record" as const, watermark: "rev:4", status: "ready" as const, statusEpoch: "status:1" },
    { sourceId: "favorite_record" as const, watermark: "favorite:1", status: "ready" as const, statusEpoch: "status:1" },
    { sourceId: "recently_changed_record" as const, watermark: "event:9", status: "ready" as const, statusEpoch: "status:1" },
    { sourceId: "recently_opened_record" as const, watermark: "opened:1", status: "ready" as const, statusEpoch: "status:1" },
    { sourceId: "recovery_notice" as const, watermark: null, status: "unavailable" as const, statusEpoch: "status:2" },
    { sourceId: "saved_view" as const, watermark: "view:1", status: "ready" as const, statusEpoch: "status:1" },
  ],
  localDate: "2026-09-06",
  timeZone: "America/New_York",
  projectionValidUntil: "2026-09-07T04:00:00.000Z",
};

const cursorState = {
  adapterContinuations: DAILY_HOME_SOURCE_IDS_V1.map(sourceId => ({
    sourceId,
    continuation: sourceId === "due_record" ? "after:record:7" : null,
  })),
  pageScope: { kind: "section" as const, sectionId: "due_today" as const, pageSize: 20 },
};

describe("Daily Home cursor", () => {
  it("encodes and decodes one deterministic closed basis-bound envelope", () => {
    const cursor = encodeDailyHomeCursor(transport(cursorState), transport(authority));
    const reversedState = Object.fromEntries(Object.entries(cursorState).reverse());

    expect(encodeDailyHomeCursor(transport(reversedState), transport(authority))).toBe(cursor);
    expect(cursor).toMatch(/^dcur_[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);
    const decoded = decodeDailyHomeCursor(cursor);
    expect(decoded).toMatchObject({
      schema: 1,
      appInstanceId: authority.appInstanceId,
      activeGenerationId: authority.activeGenerationId,
      adapterContinuations: cursorState.adapterContinuations,
      pageScope: cursorState.pageScope,
      rankingVersion: "daily-rank-v1",
      localDate: authority.localDate,
      timeZone: authority.timeZone,
      projectionValidUntil: authority.projectionValidUntil,
    });
    expect(decoded.basisDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.adapterContinuations)).toBe(true);
  });

  it("binds every adapter continuation and the exact page scope", () => {
    const baseline = encodeDailyHomeCursor(transport(cursorState), transport(authority));
    const cursors = cursorState.adapterContinuations.map((_, changedIndex) =>
      encodeDailyHomeCursor(transport({
        ...cursorState,
        adapterContinuations: cursorState.adapterContinuations.map((entry, index) =>
          index === changedIndex ? { ...entry, continuation: `changed:${index}` } : entry),
      }), transport(authority)));

    expect(new Set([baseline, ...cursors]).size).toBe(DAILY_HOME_SOURCE_IDS_V1.length + 1);
    expect(encodeDailyHomeCursor(transport({
      ...cursorState,
      pageScope: { ...cursorState.pageScope, pageSize: 19 },
    }), transport(authority))).not.toBe(baseline);
    expect(() => encodeDailyHomeCursor(transport({
      ...cursorState,
      adapterContinuations: cursorState.adapterContinuations.slice(0, -1),
    }), transport(authority))).toThrow(/cursor/i);
  });

  it("rejects arbitrary, tampered, cross-basis, cross-scope, and stale cursors", () => {
    const cursor = encodeDailyHomeCursor(transport(cursorState), transport(authority));
    expect(verifyDailyHomeCursor(
      cursor,
      transport(authority),
      transport(cursorState.pageScope),
      "2026-09-07T03:59:59.999Z",
    )).toEqual(decodeDailyHomeCursor(cursor));

    expect(() => decodeDailyHomeCursor(`dcur_${"A".repeat(32)}.${"0".repeat(64)}`))
      .toThrow(/cursor/i);
    const tampered = `${cursor.slice(0, 12)}${cursor[12] === "A" ? "B" : "A"}${cursor.slice(13)}`;
    expect(() => decodeDailyHomeCursor(tampered)).toThrow(/cursor/i);

    for (const changedAuthority of [
      { ...authority, appInstanceId: opaque("app", "d") },
      { ...authority, activeGenerationId: opaque("gen", "h") },
      { ...authority, schemaHead: "version-5" },
      { ...authority, localDate: "2026-09-07" },
      { ...authority, timeZone: "US/Eastern" },
      { ...authority, projectionValidUntil: "2026-09-07T05:00:00.000Z" },
    ]) {
      expect(() => verifyDailyHomeCursor(
        cursor,
        transport(changedAuthority),
        transport(cursorState.pageScope),
        "2026-09-06T12:00:00.000Z",
      )).toThrow(/basis|cursor/i);
    }

    expect(() => verifyDailyHomeCursor(
      cursor,
      transport(authority),
      transport({ ...cursorState.pageScope, pageSize: 19 }),
      "2026-09-06T12:00:00.000Z",
    )).toThrow(/scope/i);
    expect(() => verifyDailyHomeCursor(
      cursor,
      transport(authority),
      transport(cursorState.pageScope),
      authority.projectionValidUntil,
    )).toThrow(/stale|expired/i);
  });
});