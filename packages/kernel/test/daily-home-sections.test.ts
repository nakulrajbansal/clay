import { describe, expect, it } from "vitest";
import { DAILY_HOME_SOURCE_IDS_V1 } from "@clay/schema/daily-home";
import {
  buildDailyHomeSnapshot,
  encodeDailyHomeCursor,
} from "../src/daily-home-basis";

const opaque = (prefix: string, char: string): string => `${prefix}_${char.repeat(26)}`;
const transport = (value: unknown): string => JSON.stringify(value);
const tableId = "tbl_018f4c2a-7b31-7001-8000-000000000001";
const rowId = (suffix: string): string =>
  `018f4c2a-7b31-7001-8000-00000000000${suffix}`;

const sourceLibrary = {
  schema: 1 as const,
  revision: 2,
  profiles: [{
    schema: 1 as const,
    profileId: opaque("dsp", "e"),
    tableId,
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

const end = { kind: "end" as const };
const zeroPage = {
  items: [], returned: 0, continuation: end,
  counts: {
    sourceOccurrences: { kind: "exact" as const, total: 0 },
    renderedUnique: { kind: "exact" as const, total: 0 },
  },
};
const recoveryGap = {
  sourceId: "recovery_notice" as const,
  reason: "unavailable" as const,
  retryable: true,
};
const recoveryPage = {
  items: [], returned: 0, continuation: end,
  counts: {
    sourceOccurrences: { kind: "partial" as const, knownMinimum: 0, gaps: [recoveryGap] },
    renderedUnique: { kind: "partial" as const, knownMinimum: 0, gaps: [recoveryGap] },
  },
};

type Draft = {
  generatedAt: string;
  sources: Array<{
    sourceId: string;
    watermark: string | null;
    status: string;
    statusEpoch: string;
    page: unknown;
  }>;
  sections: Array<{ sectionId: string; page: unknown }>;
};

function dueItem(
  sourceChar: string,
  rowSuffix: string,
  dueAt: string,
  title = `Due ${rowSuffix}`,
) {
  return {
    sourceKey: opaque("inb", sourceChar),
    sourceGeneration: opaque("gen", sourceChar),
    kind: "due_record" as const,
    title,
    severity: "high" as const,
    attentionAt: dueAt,
    dueAt,
    expectedCanonicalRevision: "4",
    dispositionRevision: 0,
    route: { kind: "record" as const, tableId, rowId: rowId(rowSuffix) },
    actions: ["open"] as const,
  };
}

function recentItem(sourceChar: string, rowSuffix: string, updatedAt: string) {
  return {
    sourceKey: opaque("inb", sourceChar),
    sourceGeneration: opaque("gen", sourceChar),
    kind: "record_projection" as const,
    sourceId: "recently_changed_record" as const,
    tableId,
    rowId: rowId(rowSuffix),
    title: `Recent ${rowSuffix}`,
    updatedAt,
    route: { kind: "record" as const, tableId, rowId: rowId(rowSuffix) },
  };
}

function exactPage(items: readonly unknown[], renderedTotal = items.length) {
  return {
    items: [...items], returned: items.length, continuation: end,
    counts: {
      sourceOccurrences: { kind: "exact" as const, total: items.length },
      renderedUnique: { kind: "exact" as const, total: renderedTotal },
    },
  };
}

function baseDraft(): Draft {
  return {
    generatedAt: "2026-09-06T12:00:00.000Z",
    sources: authority.sourceWatermarks.map(source => ({
      ...source,
      page: source.sourceId === "recovery_notice" ? recoveryPage : zeroPage,
    })),
    sections: [
      { sectionId: "needs_attention" as const, page: recoveryPage },
      { sectionId: "due_today" as const, page: zeroPage },
      { sectionId: "continue" as const, page: zeroPage },
      { sectionId: "pinned" as const, page: zeroPage },
      { sectionId: "recently_opened" as const, page: zeroPage },
    ],
  };
}

function withSource(draft: Draft, sourceId: string, page: unknown): Draft {
  return {
    ...draft,
    sources: draft.sources.map(source => source.sourceId === sourceId
      ? { ...source, page } : source),
  };
}

function withSection(draft: Draft, sectionId: string, page: unknown): Draft {
  return {
    ...draft,
    sections: draft.sections.map(section => section.sectionId === sectionId
      ? { ...section, page } : section),
  };
}

const build = (draft: unknown) =>
  buildDailyHomeSnapshot(transport(draft), transport(authority));

describe("Daily Home section closure", () => {
  it("rejects wrong-section items and missing source coverage", () => {
    const item = dueItem("a", "1", "2026-09-06T10:00:00.000Z");
    const page = exactPage([item]);
    const sourced = withSource(baseDraft(), "due_record", page);
    const wrongSection = withSection(sourced, "continue", page);

    expect(() => build(wrongSection)).toThrow(/section.*source/i);
    expect(() => build(sourced)).toThrow(/section.*coverage/i);
  });

  it("derives occurrence and rendered counts and chooses one canonical representative", () => {
    const later = dueItem("b", "1", "2026-09-06T11:00:00.000Z", "A title that sorts first");
    const earlier = dueItem("a", "1", "2026-09-06T09:00:00.000Z", "Z title that sorts last");
    const sourcePage = exactPage([earlier, later], 1);
    const sectionPage = {
      items: [earlier], returned: 1, continuation: end,
      counts: {
        sourceOccurrences: { kind: "exact" as const, total: 2 },
        renderedUnique: { kind: "exact" as const, total: 1 },
      },
    };
    const sourced = withSource(baseDraft(), "due_record", sourcePage);
    const canonical = withSection(sourced, "due_today", sectionPage);

    expect(build(canonical).sections[1]!.page).toEqual(sectionPage);
    expect(() => build(withSection(sourced, "due_today", {
      ...sectionPage,
      items: [later],
    }))).toThrow(/representative|order/i);
    expect(() => build(withSection(sourced, "due_today", {
      ...sectionPage,
      counts: {
        ...sectionPage.counts,
        sourceOccurrences: { kind: "exact", total: 1 },
      },
    }))).toThrow(/section.*counts/i);
  });

  it("rejects non-canonical source and section item ordering", () => {
    const first = dueItem("a", "1", "2026-09-06T09:00:00.000Z");
    const second = dueItem("b", "2", "2026-09-06T11:00:00.000Z");
    const orderedPage = exactPage([first, second]);
    const reversedPage = exactPage([second, first]);
    const orderedSource = withSource(baseDraft(), "due_record", orderedPage);

    expect(() => build(withSection(orderedSource, "due_today", reversedPage)))
      .toThrow(/order/i);
    const reversedSource = withSource(baseDraft(), "due_record", reversedPage);
    expect(() => build(withSection(reversedSource, "due_today", orderedPage)))
      .toThrow(/source.*order/i);
  });

  it("deduplicates rendered identity across sections without losing occurrence counts", () => {
    const due = dueItem("a", "1", "2026-09-06T09:00:00.000Z");
    const recent = recentItem("b", "1", "2026-09-06T11:00:00.000Z");
    const duePage = exactPage([due]);
    const recentPage = exactPage([recent]);
    let draft = withSource(baseDraft(), "due_record", duePage);
    draft = withSource(draft, "recently_changed_record", recentPage);
    draft = withSection(draft, "due_today", duePage);
    draft = withSection(draft, "continue", {
      ...zeroPage,
      counts: {
        sourceOccurrences: { kind: "exact" as const, total: 1 },
        renderedUnique: { kind: "exact" as const, total: 0 },
      },
    });

    const snapshot = build(draft);
    expect(snapshot.aggregateCounts).toEqual({
      sourceOccurrences: {
        kind: "partial", knownMinimum: 2, gaps: [recoveryGap],
      },
      renderedUnique: {
        kind: "partial", knownMinimum: 1, gaps: [recoveryGap],
      },
    });
    expect(() => build(withSection(draft, "continue", {
      ...recentPage,
      counts: {
        sourceOccurrences: { kind: "exact", total: 1 },
        renderedUnique: { kind: "exact", total: 1 },
      },
    }))).toThrow(/representative|duplicate/i);
  });

  it("verifies closed cursor envelopes and preserves exact occurrence totals", () => {
    const item = dueItem("a", "1", "2026-09-06T09:00:00.000Z");
    const adapterContinuations = DAILY_HOME_SOURCE_IDS_V1.map(sourceId => ({
      sourceId,
      continuation: sourceId === "due_record" ? "after:record:1" : null,
    }));
    const sourceCursor = encodeDailyHomeCursor(transport({
      adapterContinuations,
      pageScope: { kind: "source", sourceId: "due_record", pageSize: 20 },
    }), transport(authority));
    const sectionCursor = encodeDailyHomeCursor(transport({
      adapterContinuations,
      pageScope: { kind: "section", sectionId: "due_today", pageSize: 20 },
    }), transport(authority));
    const sourcePage = {
      items: [item], returned: 1,
      counts: {
        sourceOccurrences: { kind: "exact" as const, total: 2 },
        renderedUnique: { kind: "exact" as const, total: 2 },
      },
      continuation: { kind: "cursor" as const, cursor: sourceCursor },
    };
    const limitGap = [{
      sourceId: "due_record" as const, reason: "limit" as const, retryable: true,
    }];
    const sectionPage = {
      items: [item], returned: 1,
      counts: {
        sourceOccurrences: { kind: "exact" as const, total: 2 },
        renderedUnique: { kind: "partial" as const, knownMinimum: 1, gaps: limitGap },
      },
      continuation: { kind: "cursor" as const, cursor: sectionCursor },
    };
    const sourced = withSource(baseDraft(), "due_record", sourcePage);
    const valid = withSection(sourced, "due_today", sectionPage);
    expect(build(valid).sections[1]!.page.counts.sourceOccurrences).toEqual({
      kind: "exact", total: 2,
    });

    const forgedCursor = `dcur_${"A".repeat(32)}.${"0".repeat(64)}`;
    expect(() => build(withSection(sourced, "due_today", {
      ...sectionPage,
      counts: {
        sourceOccurrences: { kind: "partial", knownMinimum: 1, gaps: limitGap },
        renderedUnique: { kind: "partial", knownMinimum: 1, gaps: limitGap },
      },
      continuation: { kind: "cursor", cursor: forgedCursor },
    }))).toThrow(/cursor/i);
  });
});