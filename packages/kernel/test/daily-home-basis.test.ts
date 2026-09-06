import { describe, expect, it, vi } from "vitest";
import type { SnapshotBasisV1 } from "@clay/schema/daily-home";
import {
  buildDailyHomeSnapshot,
  canonicalDailyHomeBasis,
  dailyHomeSnapshotDigest,
  verifyDailyHomeSnapshot,
} from "../src/daily-home-basis";

const id = (char: string): string => `app_${char.repeat(26)}`;
const digest = (char: string): string => `sha256:${char.repeat(64)}`;
const transport = (value: unknown): string => JSON.stringify(value);
const sourceLibrary = {
  schema: 1 as const,
  revision: 2,
  profiles: [{
    schema: 1 as const,
    profileId: `dsp_${"e".repeat(26)}`,
    tableId: "tbl_018f4c2a-7b31-7001-8000-000000000001",
    labelFieldId: "fld_018f4c2a-7b31-7002-8000-000000000002",
    dueFieldId: "fld_018f4c2a-7b31-7003-8000-000000000003",
    completion: { kind: "none" as const },
    enabled: true,
  }],
};
const basis: SnapshotBasisV1 = {
  appInstanceId: id("c"),
  activeGenerationId: `gen_${"g".repeat(26)}`,
  schemaHead: "version-4",
  profileRevision: 2,
  profileDigest: "sha256:a25db140eee120eb33e7ebbf8d173afb6d02dd7bcca749e0042954bc51d8f284",
  profileResolution: {
    readyProfileIds: [sourceLibrary.profiles[0]!.profileId],
    issueProfileIds: [],
  },
  libraryRevision: 2,
  dispositionWatermark: "0",
  sourceWatermarks: [
    { sourceId: "automation_notification", watermark: "automation:1", status: "ready", statusEpoch: "status:1" },
    { sourceId: "due_record", watermark: "rev:4", status: "ready", statusEpoch: "status:1" },
    { sourceId: "favorite_record", watermark: "favorite:1", status: "ready", statusEpoch: "status:1" },
    { sourceId: "recently_changed_record", watermark: "event:9", status: "ready", statusEpoch: "status:1" },
    { sourceId: "recently_opened_record", watermark: "opened:1", status: "ready", statusEpoch: "status:1" },
    { sourceId: "recovery_notice", watermark: null, status: "unavailable", statusEpoch: "status:2" },
    { sourceId: "saved_view", watermark: "view:1", status: "ready", statusEpoch: "status:1" },
  ],
  localDate: "2026-09-06",
  timeZone: "America/New_York",
  rankingVersion: "daily-rank-v1",
  projectionValidUntil: "2026-09-07T04:00:00.000Z",
};
const projectionAuthority = {
  schema: 1 as const,
  appInstanceId: basis.appInstanceId,
  activeGenerationId: basis.activeGenerationId,
  schemaHead: basis.schemaHead,
  sourceLibrary,
  profileResolution: {
    readyProfileIds: [sourceLibrary.profiles[0]!.profileId],
    issueProfileIds: [],
  },
  dispositionWatermark: basis.dispositionWatermark,
  sourceWatermarks: basis.sourceWatermarks,
  localDate: basis.localDate,
  timeZone: basis.timeZone,
  projectionValidUntil: basis.projectionValidUntil,
};

const CANONICAL = JSON.stringify(basis);

describe("Daily Home snapshot basis", () => {
  it("uses one fixed canonical encoding and known SHA-256 fixture", () => {
    expect(canonicalDailyHomeBasis(transport(basis))).toBe(CANONICAL);
    expect(dailyHomeSnapshotDigest(transport(basis)))
      .toBe("sha256:a7cc4c41597b8715adeedf68b24ad9b30c94517e34e51990fe640ddeb8752dc9");
  });

  it("is independent of caller object insertion order", () => {
    const reversed = Object.fromEntries(Object.entries(basis).reverse());
    expect(canonicalDailyHomeBasis(transport(reversed))).toBe(CANONICAL);
    expect(dailyHomeSnapshotDigest(transport(reversed))).toBe(dailyHomeSnapshotDigest(transport(basis)));
  });

  it("binds the selected generation into canonical bytes, digest, and verification", () => {
    const otherGeneration = `gen_${"h".repeat(26)}`;
    const changed = { ...basis, activeGenerationId: otherGeneration };

    expect(canonicalDailyHomeBasis(transport(basis))).toContain(basis.activeGenerationId);
    expect(dailyHomeSnapshotDigest(transport(changed)))
      .not.toBe(dailyHomeSnapshotDigest(transport(basis)));
  });

  it("binds canonical profile resolution into the basis digest", () => {
    const changed = {
      ...basis,
      profileResolution: {
        readyProfileIds: [],
        issueProfileIds: [sourceLibrary.profiles[0]!.profileId],
      },
    };

    expect(canonicalDailyHomeBasis(transport(basis))).toContain("profileResolution");
    expect(dailyHomeSnapshotDigest(transport(changed)))
      .not.toBe(dailyHomeSnapshotDigest(transport(basis)));
  });

  it("changes when every mutable basis member changes", () => {
    const variants: unknown[] = [
      { ...basis, appInstanceId: id("e") },
      { ...basis, activeGenerationId: `gen_${"h".repeat(26)}` },
      { ...basis, schemaHead: "version-5" },
      { ...basis, profileRevision: 3 },
      { ...basis, profileDigest: digest("e") },
      {
        ...basis,
        profileResolution: {
          readyProfileIds: [],
          issueProfileIds: [sourceLibrary.profiles[0]!.profileId],
        },
      },
      { ...basis, libraryRevision: 1 },
      { ...basis, dispositionWatermark: "1" },
      {
        ...basis,
        sourceWatermarks: basis.sourceWatermarks.map((source, index) =>
          index === 0 ? { ...source, watermark: "automation:2" } : source),
      },
      { ...basis, localDate: "2026-09-07" },
      { ...basis, timeZone: "UTC" },
      { ...basis, projectionValidUntil: "2026-09-07T05:00:00.000Z" },
    ];
    const hashes = new Set([
      dailyHomeSnapshotDigest(transport(basis)),
      ...variants.map(value => dailyHomeSnapshotDigest(transport(value))),
    ]);
    expect(hashes.size).toBe(variants.length + 1);
  });

  it("rejects unsorted, duplicate, unknown, or malformed basis data", () => {
    expect(() => dailyHomeSnapshotDigest(transport({
      ...basis,
      sourceWatermarks: [...basis.sourceWatermarks].reverse(),
    }))).toThrow(/invalid/i);
    expect(() => dailyHomeSnapshotDigest(transport({ ...basis, hiddenTotal: 4 }))).toThrow(/invalid/i);
    expect(() => dailyHomeSnapshotDigest(transport({ ...basis, timeZone: "Mars/Olympus" }))).toThrow(/invalid/i);
    const prototypeKey = { ...basis };
    Object.defineProperty(prototypeKey, "__proto__", {
      value: { hiddenTotal: 4 }, enumerable: true,
    });
    expect(() => dailyHomeSnapshotDigest(transport(prototypeKey))).toThrow(/invalid/i);
  });

  it("derives the snapshot digest and exact aggregate counts", () => {
    const item = {
      sourceKey: `inb_${"a".repeat(26)}`,
      sourceGeneration: `gen_${"b".repeat(26)}`,
      kind: "due_record" as const,
      title: "File permit renewal",
      severity: "high" as const,
      attentionAt: "2026-09-06T12:00:00.000Z",
      dueAt: "2026-09-06T12:00:00.000Z",
      expectedCanonicalRevision: "4",
      dispositionRevision: 0,
      route: {
        kind: "record" as const,
        tableId: "tbl_018f4c2a-7b31-7001-8000-000000000001",
        rowId: "018f4c2a-7b31-7001-8000-000000000001",
      },
      actions: ["open"] as const,
    };
    const zeroPage = {
      items: [], returned: 0,
      counts: {
        sourceOccurrences: { kind: "exact" as const, total: 0 },
        renderedUnique: { kind: "exact" as const, total: 0 },
      },
      continuation: { kind: "end" as const },
    };
    const recoveryGap = {
      sourceId: "recovery_notice" as const, reason: "unavailable" as const, retryable: true,
    };
    const recoveryPage = {
      items: [], returned: 0,
      counts: {
        sourceOccurrences: { kind: "partial" as const, knownMinimum: 0, gaps: [recoveryGap] },
        renderedUnique: { kind: "partial" as const, knownMinimum: 0, gaps: [recoveryGap] },
      },
      continuation: { kind: "end" as const },
    };
    const itemPage = {
      items: [item], returned: 1,
      counts: {
        sourceOccurrences: { kind: "exact" as const, total: 1 },
        renderedUnique: { kind: "exact" as const, total: 1 },
      },
      continuation: { kind: "end" as const },
    };
    const draft = {
      generatedAt: "2026-09-06T12:00:00.000Z",
      sources: basis.sourceWatermarks.map(source => ({
        ...source,
        page: source.sourceId === "due_record" ? itemPage
          : source.sourceId === "recovery_notice" ? recoveryPage : zeroPage,
      })),
      sections: [
        { sectionId: "needs_attention" as const, page: recoveryPage },
        { sectionId: "due_today" as const, page: itemPage },
        { sectionId: "continue" as const, page: zeroPage },
        { sectionId: "pinned" as const, page: zeroPage },
        { sectionId: "recently_opened" as const, page: zeroPage },
      ],
    };
    const snapshot = buildDailyHomeSnapshot(transport(draft), transport(projectionAuthority));
    expect(snapshot.basis.activeGenerationId).toBe(projectionAuthority.activeGenerationId);
    expect(snapshot.snapshotDigest).toBe(dailyHomeSnapshotDigest(transport(basis)));
    expect(snapshot.aggregateCounts).toEqual({
      sourceOccurrences: { kind: "partial", knownMinimum: 1, gaps: [recoveryGap] },
      renderedUnique: { kind: "partial", knownMinimum: 1, gaps: [recoveryGap] },
    });
    expect(verifyDailyHomeSnapshot(transport(snapshot), transport(projectionAuthority))).toEqual(snapshot);
    expect(() => verifyDailyHomeSnapshot(transport(snapshot), transport({
      ...projectionAuthority,
      activeGenerationId: `gen_${"h".repeat(26)}`,
    }))).toThrow(/authority basis/i);
    expect(() => buildDailyHomeSnapshot(
      transport({ ...draft, basis }), transport(projectionAuthority),
    )).toThrow(/draft/i);
    expect(() => verifyDailyHomeSnapshot(transport({
      ...snapshot,
      basis: { ...snapshot.basis, profileDigest: digest("d") },
    }), transport(projectionAuthority))).toThrow(/authority basis/i);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.sources[0]?.page.items[0])).toBe(true);
    expect(() => verifyDailyHomeSnapshot(
      transport({ ...snapshot, snapshotDigest: digest("0") }), transport(projectionAuthority),
    ))
      .toThrow(/digest/i);
    expect(() => verifyDailyHomeSnapshot(transport({
      ...snapshot,
      aggregateCounts: {
        sourceOccurrences: { kind: "exact", total: 999 },
        renderedUnique: { kind: "exact", total: 999 },
      },
    }), transport(projectionAuthority))).toThrow(/aggregate/i);
    expect(() => buildDailyHomeSnapshot(transport({
      ...draft,
      sections: draft.sections.map(section => section.sectionId === "due_today"
        ? { ...section, page: { ...itemPage, items: [{
          ...item,
          sourceKey: `inb_${"c".repeat(26)}`,
        }] } }
        : section),
    }), transport(projectionAuthority))).toThrow(/source/i);

    const partialDuePage = {
      ...itemPage,
      counts: {
        sourceOccurrences: {
          kind: "partial" as const, knownMinimum: 1,
          gaps: [{ sourceId: "due_record" as const, reason: "limit" as const, retryable: true }],
        },
        renderedUnique: {
          kind: "partial" as const, knownMinimum: 1,
          gaps: [{ sourceId: "due_record" as const, reason: "limit" as const, retryable: true }],
        },
      },
    };
    expect(() => buildDailyHomeSnapshot(transport({
      ...draft,
      sections: draft.sections.map(section => section.sectionId === "due_today"
        ? { sectionId: "due_today" as const, page: partialDuePage }
        : section),
    }), transport(projectionAuthority))).toThrow(/section.*(?:counts|completeness)/i);

    const recentItem = {
      sourceKey: `inb_${"e".repeat(26)}`,
      sourceGeneration: `gen_${"f".repeat(26)}`,
      kind: "record_projection" as const,
      sourceId: "recently_changed_record" as const,
      tableId: item.route.tableId,
      rowId: item.route.rowId,
      title: item.title,
      updatedAt: "2026-09-06T11:00:00.000Z",
      route: item.route,
    };
    const recentPage = { ...itemPage, items: [recentItem] };
    const duplicateDraft = {
      ...draft,
      sources: draft.sources.map(source => source.sourceId === "recently_changed_record"
        ? { ...source, page: recentPage } : source),
      sections: draft.sections.map(section => section.sectionId === "continue"
        ? { sectionId: "continue" as const, page: recentPage }
        : section),
    };
    expect(() => buildDailyHomeSnapshot(
      transport(duplicateDraft), transport(projectionAuthority),
    )).toThrow(/duplicate.*record/i);

    const unavailableDraft = {
      ...draft,
      sections: draft.sections.map(section => section.sectionId === "needs_attention"
        ? { sectionId: "needs_attention" as const, page: zeroPage }
        : section),
    };
    expect(() => buildDailyHomeSnapshot(
      transport(unavailableDraft), transport(projectionAuthority),
    )).toThrow(/section.*completeness/i);
  });

  it("binds configuration-affecting profile resolution with byte-stable profile ordering", () => {
    const secondProfile = {
      ...sourceLibrary.profiles[0]!,
      profileId: `dsp_${"d".repeat(26)}`,
      tableId: "tbl_018f4c2a-7b31-7004-8000-000000000004",
      labelFieldId: "fld_018f4c2a-7b31-7005-8000-000000000005",
      dueFieldId: "fld_018f4c2a-7b31-7006-8000-000000000006",
    };
    const readyProfileIds = [secondProfile.profileId, sourceLibrary.profiles[0]!.profileId];
    const dueGap = {
      sourceId: "due_record" as const, reason: "invalid_source" as const, retryable: false,
    };
    const recoveryGap = {
      sourceId: "recovery_notice" as const, reason: "unavailable" as const, retryable: true,
    };
    const partialPage = (gap: typeof dueGap | typeof recoveryGap) => ({
      items: [], returned: 0, continuation: { kind: "end" as const },
      counts: {
        sourceOccurrences: { kind: "partial" as const, knownMinimum: 0, gaps: [gap] },
        renderedUnique: { kind: "partial" as const, knownMinimum: 0, gaps: [gap] },
      },
    });
    const zeroPage = {
      items: [], returned: 0, continuation: { kind: "end" as const },
      counts: {
        sourceOccurrences: { kind: "exact" as const, total: 0 },
        renderedUnique: { kind: "exact" as const, total: 0 },
      },
    };
    const sourceWatermarks = projectionAuthority.sourceWatermarks.map(source =>
      source.sourceId === "due_record"
        ? { ...source, status: "partial" as const, statusEpoch: "status:3" }
        : source);
    const partialAuthority = {
      ...projectionAuthority,
      sourceLibrary: {
        ...sourceLibrary,
        profiles: [sourceLibrary.profiles[0]!, secondProfile],
      },
      profileResolution: { readyProfileIds, issueProfileIds: [] },
      sourceWatermarks,
    };
    const draft = {
      generatedAt: "2026-09-06T12:00:00.000Z",
      sources: sourceWatermarks.map(source => ({
        ...source,
        page: source.sourceId === "due_record" ? partialPage(dueGap)
          : source.sourceId === "recovery_notice" ? partialPage(recoveryGap) : zeroPage,
      })),
      sections: [
        { sectionId: "needs_attention" as const, page: partialPage(recoveryGap) },
        { sectionId: "due_today" as const, page: partialPage(dueGap) },
        { sectionId: "continue" as const, page: zeroPage },
        { sectionId: "pinned" as const, page: zeroPage },
        { sectionId: "recently_opened" as const, page: zeroPage },
      ],
    };

    const localeCompare = vi.spyOn(String.prototype, "localeCompare")
      .mockImplementation(() => { throw new Error("locale-dependent comparison used"); });
    let partialSnapshot: ReturnType<typeof buildDailyHomeSnapshot>;
    try {
      partialSnapshot = buildDailyHomeSnapshot(transport(draft), transport(partialAuthority));
    } finally {
      localeCompare.mockRestore();
    }
    const setupAuthority = {
      ...partialAuthority,
      profileResolution: { readyProfileIds: [], issueProfileIds: readyProfileIds },
    };
    const setupSnapshot = buildDailyHomeSnapshot(transport(draft), transport(setupAuthority));
    expect(partialSnapshot.configurationStatus).toBe("partial");
    expect(setupSnapshot.configurationStatus).toBe("needs_setup");
    expect(partialSnapshot.basis.profileResolution).toEqual(partialAuthority.profileResolution);
    expect(setupSnapshot.basis.profileResolution).toEqual(setupAuthority.profileResolution);
    expect(partialSnapshot.snapshotDigest).not.toBe(setupSnapshot.snapshotDigest);
    expect(() => verifyDailyHomeSnapshot(
      transport(partialSnapshot), transport(setupAuthority),
    )).toThrow(/authority basis/i);
  });

  it("rejects accessor-bearing drafts without invoking them", () => {
    let calls = 0;
    const draft = {};
    Object.defineProperty(draft, "basis", {
      enumerable: true,
      get() {
        calls += 1;
        return basis;
      },
    });
    expect(() => buildDailyHomeSnapshot(draft, transport(projectionAuthority))).toThrow(/transport/i);
    expect(calls).toBe(0);
  });

  it("rejects oversized objects before materializing their descriptors", () => {
    const oversized: Record<string, unknown> = { ...basis };
    for (let index = 0; index < 1_025; index++) oversized[`extra_${index}`] = index;
    let descriptorCalls = 0;
    const observed = new Proxy(oversized, {
      getOwnPropertyDescriptor(target, property) {
        descriptorCalls += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    expect(() => dailyHomeSnapshotDigest(observed)).toThrow(/payload|invalid/i);
    expect(descriptorCalls).toBe(0);
  });
});
