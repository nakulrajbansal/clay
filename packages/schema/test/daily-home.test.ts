import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  CompletenessV1,
  DAILY_HOME_SOURCE_IDS_V1,
  DailyHomeCursorPayloadV1,
  DailyHomeProjectionAuthorityV1,
  DailyHomeSnapshotV1,
  DailyHomeSourceSnapshotV1,
  DailySourceLibraryV1,
  DailySourceProfileV1,
  InboxItemV1,
  SnapshotBasisV1,
  dailyPageV1,
} from "../src/daily-home";

const decisionsUrl = new URL("../../../specs/docs/10-decisions.md", import.meta.url);
const id = (prefix: string, char: string): string => `${prefix}_${char.repeat(26)}`;
const uuidId = (prefix: string, suffix: string): string =>
  `${prefix}_018f4c2a-7b31-7${suffix.padStart(3, "0")}-8000-00000000000${suffix}`;
const rowId = (suffix: string): string => uuidId("row", suffix).slice(4);
const digest = (char: string): string => `sha256:${char.repeat(64)}`;

async function decisions(): Promise<string> {
  return readFile(decisionsUrl, "utf8");
}

const exact = { kind: "exact" as const, total: 2 };
const end = { kind: "end" as const };
const recordRoute = {
  kind: "record" as const,
  tableId: uuidId("tbl", "1"),
  rowId: rowId("1"),
};
const dueItem = {
  sourceKey: id("inb", "a"),
  sourceGeneration: id("gen", "b"),
  kind: "due_record" as const,
  title: "File permit renewal",
  severity: "high" as const,
  attentionAt: "2026-09-06T12:00:00.000Z",
  dueAt: "2026-09-06T12:00:00.000Z",
  expectedCanonicalRevision: "4",
  dispositionRevision: 0,
  route: recordRoute,
  actions: ["open"] as const,
};
const sourceWatermarks = [
  { sourceId: "automation_notification" as const, watermark: "automation:1", status: "ready" as const, statusEpoch: "status:1" },
  { sourceId: "due_record" as const, watermark: "rev:4", status: "ready" as const, statusEpoch: "status:1" },
  { sourceId: "favorite_record" as const, watermark: "favorite:1", status: "ready" as const, statusEpoch: "status:1" },
  { sourceId: "recently_changed_record" as const, watermark: "event:9", status: "ready" as const, statusEpoch: "status:1" },
  { sourceId: "recently_opened_record" as const, watermark: "opened:1", status: "ready" as const, statusEpoch: "status:1" },
  { sourceId: "recovery_notice" as const, watermark: null, status: "unavailable" as const, statusEpoch: "status:2" },
  { sourceId: "saved_view" as const, watermark: "view:1", status: "ready" as const, statusEpoch: "status:1" },
];
function emptySource(source: typeof sourceWatermarks[number]) {
  const counts = source.status === "unavailable" ? {
    sourceOccurrences: {
      kind: "partial" as const, knownMinimum: 0,
      gaps: [{ sourceId: source.sourceId, reason: "unavailable" as const, retryable: true }],
    },
    renderedUnique: {
      kind: "partial" as const, knownMinimum: 0,
      gaps: [{ sourceId: source.sourceId, reason: "unavailable" as const, retryable: true }],
    },
  } : {
    sourceOccurrences: { kind: "exact" as const, total: 0 },
    renderedUnique: { kind: "exact" as const, total: 0 },
  };
  return {
    ...source,
    page: {
      items: [], returned: 0, continuation: end,
      counts,
    },
  };
}
const basis = {
  appInstanceId: id("app", "c"),
  activeGenerationId: id("gen", "g"),
  schemaHead: "version-4",
  profileRevision: 2,
  profileDigest: digest("d"),
  profileResolution: { readyProfileIds: [id("dsp", "e")], issueProfileIds: [] },
  libraryRevision: 0,
  dispositionWatermark: "0",
  sourceWatermarks,
  localDate: "2026-09-06",
  timeZone: "America/New_York",
  rankingVersion: "daily-rank-v1" as const,
  projectionValidUntil: "2026-09-07T04:00:00.000Z",
};

function profile(index = 1) {
  return {
    schema: 1 as const,
    profileId: id("dsp", index % 2 === 0 ? "d" : "e"),
    tableId: uuidId("tbl", String(index)),
    labelFieldId: uuidId("fld", String(index * 3)),
    dueFieldId: uuidId("fld", String(index * 3 + 1)),
    completion: {
      kind: "boolean" as const,
      fieldId: uuidId("fld", String(index * 3 + 2)),
      completeValue: true as const,
    },
    enabled: true,
    labelSnapshot: "Tasks",
    dueLabelSnapshot: "Due date",
  };
}

describe("Daily Home binding decisions", () => {
  it("ratifies the local D0 contracts without claiming blocked writes or hosted delivery", async () => {
    const text = (await decisions()).replace(/\s+/g, " ");
    const adr = text.slice(text.indexOf("ADR-050"));

    expect(adr).toContain("ADR-050");
    expect(adr).toContain("explicit stable field identities");
    expect(adr).toContain("never inferred from labels or field order");
    expect(adr).toContain("sys.inbox_dispositions");
    expect(adr).toContain("no copied Inbox or Today item table");
    expect(adr).toContain("archive format 5");
    expect(adr).toContain("Intl.DateTimeFormat.formatToParts");
    expect(adr).toContain("no new runtime dependency");
    expect(adr).toContain("local Inbox is independent of off-device delivery");
    expect(adr.toLowerCase()).toContain("off-device reminder delivery remains deferred");
    expect(adr).toContain("B3/B4 recovery-source contract");
    expect(adr).toContain("C2 entry descriptor contract");
    expect(adr.toLowerCase()).toContain("read-only d1 projection work may proceed");
    expect(adr).toContain("every state-changing D route remains fail-closed");
    expect(adr).toContain("release-bound physical transaction certificate");
  });
});

describe("Daily Home shared schemas", () => {
  it("keeps exact totals and partial known minimums as disjoint strict arms", () => {
    expect(CompletenessV1.parse(exact)).toEqual(exact);
    const partial = {
      kind: "partial" as const,
      knownMinimum: 1,
      gaps: [{ sourceId: "recovery_notice" as const, reason: "unavailable" as const, retryable: true }],
    };
    expect(CompletenessV1.parse(partial)).toEqual(partial);
    expect(CompletenessV1.safeParse({ ...partial, total: 2 }).success).toBe(false);
    expect(CompletenessV1.safeParse({ ...partial, gaps: [] }).success).toBe(false);
    expect(CompletenessV1.safeParse({ kind: "exact", total: -1 }).success).toBe(false);
    expect(CompletenessV1.safeParse({
      ...partial,
      gaps: [partial.gaps[0], partial.gaps[0]],
    }).success).toBe(false);
  });

  it("bounds pages and keeps returned length separate from totals", () => {
    const schema = dailyPageV1(InboxItemV1);
    const page = {
      items: [dueItem],
      returned: 1,
      counts: { sourceOccurrences: exact, renderedUnique: exact },
      continuation: end,
    };
    expect(schema.parse(page)).toEqual(page);
    expect(schema.safeParse({ ...page, returned: 2 }).success).toBe(false);
    expect(schema.safeParse({ ...page, items: Array.from({ length: 21 }, () => dueItem), returned: 21 }).success)
      .toBe(false);
    expect(schema.safeParse({ ...page, continuation: { kind: "cursor", cursor: "dcur_short" } }).success)
      .toBe(false);
  });

  it("closes every cursor field, adapter continuation, and page scope", () => {
    const payload = {
      schema: 1,
      appInstanceId: basis.appInstanceId,
      activeGenerationId: basis.activeGenerationId,
      basisDigest: digest("a"),
      adapterContinuations: DAILY_HOME_SOURCE_IDS_V1.map(sourceId => ({
        sourceId,
        continuation: sourceId === "due_record" ? "after:record:7" : null,
      })),
      pageScope: { kind: "section", sectionId: "due_today", pageSize: 20 },
      rankingVersion: basis.rankingVersion,
      localDate: basis.localDate,
      timeZone: basis.timeZone,
      projectionValidUntil: basis.projectionValidUntil,
    };
    expect(DailyHomeCursorPayloadV1.parse(payload)).toEqual(payload);
    expect(DailyHomeCursorPayloadV1.safeParse({
      ...payload,
      adapterContinuations: [...payload.adapterContinuations].reverse(),
    }).success).toBe(false);
    expect(DailyHomeCursorPayloadV1.safeParse({
      ...payload,
      adapterContinuations: payload.adapterContinuations.slice(0, -1),
    }).success).toBe(false);
    expect(DailyHomeCursorPayloadV1.safeParse({
      ...payload,
      pageScope: { kind: "section", sectionId: "due_today", pageSize: 21 },
    }).success).toBe(false);
    expect(DailyHomeCursorPayloadV1.safeParse({
      ...payload,
      pageScope: { kind: "arbitrary", name: "all rows", pageSize: 20 },
    }).success).toBe(false);
    expect(dailyPageV1(InboxItemV1).safeParse({
      items: [], returned: 0,
      counts: {
        sourceOccurrences: { kind: "exact", total: 0 },
        renderedUnique: { kind: "exact", total: 0 },
      },
      continuation: {
        kind: "cursor",
        cursor: `dcur_${"A".repeat(16)}.${"a".repeat(64)}`,
      },
    }).success).toBe(true);
  });

  it("accepts only explicit stable reviewed source profiles", () => {
    expect(DailySourceProfileV1.parse(profile())).toEqual(profile());
    expect(DailySourceProfileV1.safeParse({
      ...profile(),
      labelFieldId: profile().dueFieldId,
    }).success).toBe(true);
    expect(DailySourceProfileV1.safeParse({ ...profile(), guessedDueLabel: "due" }).success).toBe(false);
    expect(DailySourceProfileV1.safeParse({ ...profile(), dueFieldId: "due_date" }).success).toBe(false);
    expect(DailySourceProfileV1.safeParse({
      ...profile(),
      tableId: "tbl_018f4c2a-7b31-4abc-8def-0123456789ab",
    }).success).toBe(false);
    expect(DailySourceProfileV1.safeParse({
      ...profile(),
      completion: {
        kind: "enum",
        fieldId: uuidId("fld", "9"),
        completeValue: "done",
        terminalValues: ["closed"],
      },
    }).success).toBe(false);
  });

  it("caps libraries and rejects duplicate enabled table/profile identities", () => {
    const first = profile(1);
    const second = { ...profile(2), tableId: first.tableId };
    expect(DailySourceLibraryV1.safeParse({ schema: 1, revision: 0, profiles: [first, second] }).success)
      .toBe(false);
    expect(DailySourceLibraryV1.safeParse({
      schema: 1,
      revision: 0,
      profiles: [first, { ...first, tableId: uuidId("tbl", "2"), enabled: false }],
    }).success).toBe(false);
    expect(DailySourceLibraryV1.safeParse({
      schema: 1,
      revision: 0,
      profiles: Array.from({ length: 33 }, (_, index) => ({
        ...profile((index % 9) + 1),
        profileId: `dsp_${index.toString(32).padStart(26, "a").replace(/[0189]/g, "a")}`,
        tableId: `tbl_018f4c2a-7b31-7000-8000-${index.toString().padStart(12, "0")}`,
      })),
    }).success).toBe(false);
  });

  it("requires the selected generation in both trusted authority and snapshot basis", () => {
    const activeGenerationId = basis.activeGenerationId;
    const boundBasis = { ...basis, activeGenerationId };
    const authority = {
      schema: 1,
      appInstanceId: basis.appInstanceId,
      activeGenerationId,
      schemaHead: basis.schemaHead,
      sourceLibrary: { schema: 1, revision: 0, profiles: [profile()] },
      profileResolution: { readyProfileIds: [profile().profileId], issueProfileIds: [] },
      dispositionWatermark: basis.dispositionWatermark,
      sourceWatermarks,
      localDate: basis.localDate,
      timeZone: basis.timeZone,
      projectionValidUntil: basis.projectionValidUntil,
    };

    expect(SnapshotBasisV1.safeParse(boundBasis).success).toBe(true);
    const { activeGenerationId: _basisGeneration, ...unboundBasis } = basis;
    expect(SnapshotBasisV1.safeParse(unboundBasis).success).toBe(false);
    expect(DailyHomeProjectionAuthorityV1.safeParse(authority).success).toBe(true);
    const { activeGenerationId: _omitted, ...unboundAuthority } = authority;
    expect(DailyHomeProjectionAuthorityV1.safeParse(unboundAuthority).success).toBe(false);
  });

  it("requires a canonical profile-resolution partition without locale-sensitive ordering", () => {
    const readyProfileIds = [profile(2).profileId, profile(1).profileId];
    const canonicalResolution = { readyProfileIds, issueProfileIds: [] };
    const boundBasis = { ...basis, profileResolution: canonicalResolution };
    const localeCompare = vi.spyOn(String.prototype, "localeCompare")
      .mockImplementation(() => { throw new Error("locale-dependent comparison used"); });
    try {
      expect(SnapshotBasisV1.safeParse(boundBasis).success).toBe(true);
    } finally {
      localeCompare.mockRestore();
    }
    const { profileResolution: _resolution, ...unboundBasis } = boundBasis;
    expect(SnapshotBasisV1.safeParse(unboundBasis).success).toBe(false);
    expect(SnapshotBasisV1.safeParse({
      ...boundBasis,
      profileResolution: { ...canonicalResolution, readyProfileIds: [...readyProfileIds].reverse() },
    }).success).toBe(false);
    expect(SnapshotBasisV1.safeParse({
      ...boundBasis,
      profileResolution: {
        readyProfileIds,
        issueProfileIds: [readyProfileIds[0]],
      },
    }).success).toBe(false);
  });

  it("binds a recognized persisted timezone and sorted unique source basis", () => {
    expect(SnapshotBasisV1.parse(basis)).toEqual(basis);
    expect(SnapshotBasisV1.safeParse({ ...basis, timeZone: "US/Eastern" }).success).toBe(true);
    expect(SnapshotBasisV1.safeParse({ ...basis, timeZone: "Asia/Katmandu" }).success).toBe(true);
    expect(SnapshotBasisV1.safeParse({ ...basis, timeZone: "+05:30" }).success).toBe(false);
    expect(SnapshotBasisV1.safeParse({ ...basis, timeZone: "-04" }).success).toBe(false);
    expect(SnapshotBasisV1.safeParse({ ...basis, timeZone: "Mars/Olympus" }).success).toBe(false);
    expect(SnapshotBasisV1.safeParse({ ...basis, localDate: "2026-02-30" }).success).toBe(false);
    expect(SnapshotBasisV1.safeParse({ ...basis, projectionValidUntil: "2026-09-07T00:00:00-04:00" }).success)
      .toBe(false);
    expect(SnapshotBasisV1.safeParse({ ...basis, sourceWatermarks: [...sourceWatermarks].reverse() }).success)
      .toBe(false);
    expect(SnapshotBasisV1.safeParse({ ...basis, sourceWatermarks: sourceWatermarks.slice(0, 6) }).success)
      .toBe(false);
    expect(SnapshotBasisV1.safeParse({
      ...basis,
      sourceWatermarks: [sourceWatermarks[0], sourceWatermarks[0]],
    }).success).toBe(false);
  });

  it("keeps Inbox actions strict and source-compatible", () => {
    expect(InboxItemV1.parse(dueItem)).toEqual({ ...dueItem, actions: [...dueItem.actions] });
    expect(InboxItemV1.safeParse({ ...dueItem, actions: ["open", "run_sql"] }).success).toBe(false);
    for (const action of ["complete", "snooze", "dismiss"])
      expect(InboxItemV1.safeParse({ ...dueItem, actions: [action] }).success).toBe(false);
    expect(InboxItemV1.safeParse({
      ...dueItem,
      route: { kind: "setup", area: "daily_sources" },
      actions: ["setup"],
    }).success).toBe(true);
    expect(InboxItemV1.safeParse({
      ...dueItem,
      route: { kind: "setup", area: "recovery" },
      actions: ["fix"],
    }).success).toBe(false);
    expect(InboxItemV1.safeParse({
      ...dueItem,
      kind: "automation_notification",
      route: { kind: "setup", area: "automations" },
      actions: ["fix"],
    }).success).toBe(true);
    expect(InboxItemV1.safeParse({
      ...dueItem,
      kind: "automation_notification",
      route: { kind: "automation", automationId: `auto_${"a".repeat(32)}` },
      actions: ["complete", "open"],
    }).success).toBe(false);
    expect(InboxItemV1.safeParse({ ...dueItem, secret: "not allowed" }).success).toBe(false);
    expect(InboxItemV1.safeParse({
      ...dueItem,
      expectedCanonicalRevision: "18446744073709551616",
    }).success).toBe(false);
    expect(InboxItemV1.safeParse({
      ...dueItem,
      route: { ...recordRoute, rowId: "not-a-row-id" },
    }).success).toBe(false);
    expect(InboxItemV1.safeParse({
      ...dueItem,
      route: { ...recordRoute, rowId: "018f4c2a-7b31-4abc-8000-000000000001" },
    }).success).toBe(true);
    expect(InboxItemV1.safeParse({
      ...dueItem,
      kind: "automation_notification",
      route: { kind: "automation", automationId: "not-an-automation-id" },
      actions: ["open"],
    }).success).toBe(false);
  });

  it("keeps rendered counts within source counts and status consistent with completeness", () => {
    const page = {
      items: [dueItem],
      returned: 1,
      counts: {
        sourceOccurrences: { kind: "exact" as const, total: 1 },
        renderedUnique: { kind: "exact" as const, total: 2 },
      },
      continuation: end,
    };
    const source = {
      sourceId: "due_record" as const,
      watermark: "rev:4",
      status: "ready" as const,
      statusEpoch: "status:1",
      page,
    };
    expect(DailyHomeSnapshotV1.safeParse({
      generatedAt: "2026-09-06T12:00:00.000Z",
      basis,
      snapshotDigest: digest("f"),
      configurationStatus: "ready",
      sources: [source],
      sections: [{ sectionId: "quick_capture", page }],
      aggregateCounts: page.counts,
    }).success).toBe(false);

    const partialPage = {
      ...page,
      counts: {
        sourceOccurrences: {
          kind: "partial" as const,
          knownMinimum: 1,
          gaps: [{ sourceId: "due_record" as const, reason: "timeout" as const, retryable: true }],
        },
        renderedUnique: {
          kind: "partial" as const,
          knownMinimum: 1,
          gaps: [{ sourceId: "due_record" as const, reason: "timeout" as const, retryable: true }],
        },
      },
    };
    expect(DailyHomeSnapshotV1.safeParse({
      generatedAt: "2026-09-06T12:00:00.000Z",
      basis: {
        ...basis,
        sourceWatermarks: [{
          sourceId: "due_record",
          watermark: "rev:4",
          status: "partial",
          statusEpoch: "status:2",
        }],
      },
      snapshotDigest: digest("f"),
      configurationStatus: "ready",
      sources: [{ ...source, status: "partial", statusEpoch: "status:2", page: partialPage }],
      sections: [{ sectionId: "quick_capture", page: partialPage }],
      aggregateCounts: partialPage.counts,
    }).success).toBe(false);
  });

  it("closes source status, gap, and occurrence identity claims", () => {
    const emptyExactPage = {
      items: [], returned: 0, continuation: end,
      counts: {
        sourceOccurrences: { kind: "exact" as const, total: 5 },
        renderedUnique: { kind: "exact" as const, total: 5 },
      },
    };
    expect(DailyHomeSourceSnapshotV1.safeParse({
      sourceId: "due_record",
      watermark: null,
      status: "unavailable",
      statusEpoch: "status:3",
      page: emptyExactPage,
    }).success).toBe(false);

    const dueGap = [{ sourceId: "due_record" as const, reason: "timeout" as const, retryable: true }];
    expect(DailyHomeSourceSnapshotV1.safeParse({
      sourceId: "due_record",
      watermark: "rev:4",
      status: "partial",
      statusEpoch: "status:2",
      page: {
        items: [dueItem], returned: 1, continuation: end,
        counts: {
          sourceOccurrences: { kind: "exact", total: 1 },
          renderedUnique: { kind: "partial", knownMinimum: 1, gaps: dueGap },
        },
      },
    }).success).toBe(false);
    expect(DailyHomeSourceSnapshotV1.safeParse({
      sourceId: "due_record",
      watermark: "rev:4",
      status: "partial",
      statusEpoch: "status:2",
      page: {
        items: [dueItem], returned: 1, continuation: end,
        counts: {
          sourceOccurrences: { kind: "partial", knownMinimum: 1, gaps: [{
            sourceId: "saved_view", reason: "timeout", retryable: true,
          }] },
          renderedUnique: { kind: "partial", knownMinimum: 1, gaps: dueGap },
        },
      },
    }).success).toBe(false);
    expect(DailyHomeSourceSnapshotV1.safeParse({
      sourceId: "due_record",
      watermark: "rev:4",
      status: "partial",
      statusEpoch: "status:2",
      page: {
        items: [dueItem], returned: 1, continuation: end,
        counts: {
          sourceOccurrences: { kind: "partial", knownMinimum: 1, gaps: dueGap },
          renderedUnique: { kind: "partial", knownMinimum: 1, gaps: [{
            sourceId: "due_record", reason: "limit", retryable: false,
          }] },
        },
      },
    }).success).toBe(false);
    expect(DailyHomeSourceSnapshotV1.safeParse({
      sourceId: "due_record",
      watermark: "rev:4",
      status: "ready",
      statusEpoch: "status:1",
      page: {
        items: [dueItem, dueItem], returned: 2, continuation: end,
        counts: {
          sourceOccurrences: { kind: "exact", total: 2 },
          renderedUnique: { kind: "exact", total: 2 },
        },
      },
    }).success).toBe(false);

    const secondOccurrence = {
      ...dueItem,
      sourceKey: id("inb", "f"),
      sourceGeneration: id("gen", "g"),
    };
    expect(DailyHomeSourceSnapshotV1.safeParse({
      sourceId: "due_record",
      watermark: "rev:4",
      status: "ready",
      statusEpoch: "status:1",
      page: {
        items: [dueItem, secondOccurrence], returned: 2, continuation: end,
        counts: {
          sourceOccurrences: { kind: "exact", total: 2 },
          renderedUnique: { kind: "exact", total: 1 },
        },
      },
    }).success).toBe(true);
  });

  it("requires ordered unique sections and consistent snapshot counts", () => {
    const itemPage = {
      items: [dueItem],
      returned: 1,
      counts: { sourceOccurrences: { kind: "exact" as const, total: 1 }, renderedUnique: { kind: "exact" as const, total: 1 } },
      continuation: end,
    };
    const zeroPage = {
      items: [], returned: 0, continuation: end,
      counts: {
        sourceOccurrences: { kind: "exact" as const, total: 0 },
        renderedUnique: { kind: "exact" as const, total: 0 },
      },
    };
    const recoveryGap = [{
      sourceId: "recovery_notice" as const, reason: "unavailable" as const, retryable: true,
    }];
    const needsAttentionPage = {
      items: [], returned: 0, continuation: end,
      counts: {
        sourceOccurrences: { kind: "partial" as const, knownMinimum: 0, gaps: recoveryGap },
        renderedUnique: { kind: "partial" as const, knownMinimum: 0, gaps: recoveryGap },
      },
    };
    const snapshot = {
      generatedAt: "2026-09-06T12:00:00.000Z",
      basis,
      snapshotDigest: digest("f"),
      configurationStatus: "partial" as const,
      sources: sourceWatermarks.map(source => source.sourceId === "due_record"
        ? { ...source, page: itemPage }
        : emptySource(source)),
      sections: [
        { sectionId: "needs_attention" as const, page: needsAttentionPage },
        { sectionId: "due_today" as const, page: itemPage },
        { sectionId: "continue" as const, page: zeroPage },
        { sectionId: "pinned" as const, page: zeroPage },
        { sectionId: "recently_opened" as const, page: zeroPage },
      ],
      aggregateCounts: {
        sourceOccurrences: { kind: "partial" as const, knownMinimum: 1, gaps: recoveryGap },
        renderedUnique: { kind: "partial" as const, knownMinimum: 1, gaps: recoveryGap },
      },
    };
    expect(DailyHomeSnapshotV1.parse(snapshot)).toEqual(snapshot);
    expect(DailyHomeSnapshotV1.safeParse({
      ...snapshot,
      sections: [...snapshot.sections].reverse(),
    }).success).toBe(false);
    expect(DailyHomeSnapshotV1.safeParse({
      ...snapshot,
      sources: [snapshot.sources[0], snapshot.sources[0]],
    }).success).toBe(false);
    expect(DailyHomeSnapshotV1.safeParse({
      ...snapshot,
      sections: [{ sectionId: "needs_attention", page: itemPage }],
    }).success).toBe(false);
    expect(DailyHomeSnapshotV1.safeParse({
      ...snapshot,
      sources: [{ ...snapshot.sources[0], watermark: "rev:5" }],
    }).success).toBe(false);
    expect(DailyHomeSnapshotV1.safeParse({ ...snapshot, generatedAt: basis.projectionValidUntil }).success)
      .toBe(false);
  });
});
