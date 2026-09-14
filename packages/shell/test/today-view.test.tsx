/** @vitest-environment jsdom */
import { act } from "preact/test-utils";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type DailyHomeSnapshot, type RegTable } from "@clay/kernel";
import { TodayView } from "../src/app/TodayView";
import { createWorkerMutationContext, type WorkerClient } from "../src/app/worker-client";
import { DAILY_HOME_SOURCE_IDS_V1 } from "@clay/schema/daily-home";
import { readPresentationIntent } from "../src/app/presentation-intent";
import { expectControlCensus } from "./helpers/control-census";

afterEach(() => sessionStorage.clear());

it("ends a failed setup read truthfully and retries only that read before enabling review", async () => {
  let reads = 0;
  const worker = fixtureWorker({ dailyHome: async () => {
    if (++reads === 2) throw new Error("source read unavailable");
    return snapshot();
  } });
  const host = document.createElement("div"); document.body.replaceChildren(host);
  const root = createRoot(host); const onError = vi.fn();
  try {
    await act(async () => root.render(<TodayView worker={worker} tables={[]}
      onOpenRecord={() => undefined} onOpenAutomation={() => undefined} onOpenSavedView={() => undefined}
      onQuickCapture={() => undefined} onSetup={() => undefined} onCreateRecurring={() => undefined}
      dailyHomeMutationsAvailable onError={onError} />));
    const button = (name: string) => [...host.querySelectorAll("button")].find(b => b.textContent === name);
    await waitFor(() => !!button("Review setup"));
    await act(async () => button("Review setup")!.click());
    await waitFor(() => onError.mock.calls.length === 1);
    expect(onError).toHaveBeenCalledWith("source read unavailable");
    expect(host.textContent).not.toContain("Reading the original source");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("source read unavailable");
    expect(button("Retry source review")).toBeDefined();
    await act(async () => button("Retry source review")!.click());
    await waitFor(() => !button("Retry source review"));
    expect(reads).toBe(3); expect(button("Retry source review")).toBeUndefined();
    expect(host.querySelector('[role="alert"]')).toBeNull();
  } finally { await act(async () => root.unmount()); }
});
function fixtureWorker(input: Record<string, any>): WorkerClient {
  const worker = { createMutationContext: createWorkerMutationContext,
    mutationOutcome: async () => ({ status: "not_invoked" }),
    compareAndSetDailyNavigation: vi.fn(async (_revision: number, value: unknown) => ({ ok: true, current: value })), ...input };
  return { ...worker, dailyPresentation: async () => {
    const snap = await input.dailyHome();
    return { snapshot: snap, authorityTarget: { appInstanceId: snap.basis.appInstanceId,
      activeGenerationId: snap.basis.activeGenerationId, lineageEpoch: "0", protectionRevision: "1", digestSchema: 1,
      stateSha256: `sha256:${"a".repeat(64)}` }, sourceLibrary: await input.getSetting?.() ?? null, navigation: null };
  } } as unknown as WorkerClient;
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tableId = "tbl_018f4c2a-7b31-7001-8000-000000000001";
const rowId = "018f4c2a-7b31-7001-8000-000000000011";
const activeGenerationId = `gen_${"b".repeat(26)}`;

async function waitFor(condition: () => boolean): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > 2_000) throw new Error(document.body.innerHTML);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  }
}

function snapshot(): DailyHomeSnapshot {
  const item = {
    sourceKey: `inb_${"c".repeat(26)}`,
    sourceGeneration: `gen_${"b".repeat(26)}`,
    kind: "due_record",
    title: "Overdue tax",
    severity: "high",
    attentionAt: "2026-09-05T00:00:00.000Z",
    dueAt: "2026-09-05T00:00:00.000Z",
    dispositionRevision: 0,
    route: { kind: "record", tableId, rowId },
    actions: ["open"],
  } as const;
  const empty = {
    items: [], returned: 0,
    counts: {
      sourceOccurrences: { kind: "exact", total: 0 },
      renderedUnique: { kind: "exact", total: 0 },
    },
    continuation: { kind: "end" },
  } as const;
  const one = {
    items: [item], returned: 1,
    counts: {
      sourceOccurrences: { kind: "exact", total: 1 },
      renderedUnique: { kind: "exact", total: 1 },
    },
    continuation: { kind: "end" },
  } as const;
  return {
    generatedAt: "2026-09-06T12:00:00.000Z",
    basis: {
      appInstanceId: `app_${"a".repeat(26)}`,
      activeGenerationId: `gen_${"b".repeat(26)}`,
      schemaHead: "version:7",
      profileRevision: 1,
      profileDigest: `sha256:${"0".repeat(64)}`,
      profileResolution: { readyProfileIds: [`dsp_${"d".repeat(26)}`], issueProfileIds: [] },
      libraryRevision: 1,
      dispositionWatermark: "0",
      sourceWatermarks: DAILY_HOME_SOURCE_IDS_V1.map(sourceId => ({ sourceId,
        watermark: sourceId === "recovery_notice" ? null : "0", status: sourceId === "recovery_notice" ? "unavailable" : "ready", statusEpoch: "1" })),
      localDate: "2026-09-06",
      timeZone: "UTC",
      rankingVersion: "daily-rank-v1",
      projectionValidUntil: "2099-09-07T00:00:00.000Z",
    },
    snapshotDigest: `sha256:${"1".repeat(64)}`,
    configurationStatus: "partial",
    sources: [{
      sourceId: "favorite_record", watermark: "navigation:1", status: "ready",
      statusEpoch: "daily-home:ready:1",
      page: {
        items: [{
          kind: "record_projection", sourceId: "favorite_record",
          sourceKey: `inb_${"f".repeat(26)}`, sourceGeneration: activeGenerationId,
          tableId, rowId, title: "Send invoice", updatedAt: "2026-09-06T10:00:00.000Z",
          favoriteOrder: 0, route: { kind: "record", tableId, rowId },
        }],
        returned: 1,
        counts: { sourceOccurrences: { kind: "exact", total: 1 }, renderedUnique: { kind: "exact", total: 1 } },
        continuation: { kind: "end" },
      },
    }, {
      sourceId: "recently_opened_record", watermark: "navigation:1", status: "ready",
      statusEpoch: "daily-home:ready:1",
      page: {
        items: [{
          kind: "record_projection", sourceId: "recently_opened_record",
          sourceKey: `inb_${"g".repeat(26)}`, sourceGeneration: activeGenerationId,
          tableId, rowId, title: "Send invoice", updatedAt: "2026-09-06T10:00:00.000Z",
          openedAt: "2026-09-06T11:00:00.000Z", route: { kind: "record", tableId, rowId },
        }],
        returned: 1,
        counts: { sourceOccurrences: { kind: "exact", total: 1 }, renderedUnique: { kind: "exact", total: 1 } },
        continuation: { kind: "end" },
      },
    }],
    sections: [
      { sectionId: "needs_attention", page: empty },
      { sectionId: "due_today", page: one },
      { sectionId: "continue", page: empty },
      { sectionId: "pinned", page: empty },
      { sectionId: "recently_opened", page: empty },
    ],
    aggregateCounts: one.counts,
  } as unknown as DailyHomeSnapshot;
}

describe("Today home", () => {
  it("offers local Inbox actions and persists their original Undo before presentation, recovering both across reload", async () => {
    const view = snapshot();
    const item = view.sections[1]!.page.items[0]!;
    if (item.kind !== "due_record") throw new Error("due fixture required");
    item.actions = ["open", "complete", "snooze", "dismiss"];
    view.sources.push({ sourceId: "due_record", watermark: "1", status: "ready", statusEpoch: "1", page: view.sections[1]!.page });
    let receipt: unknown = null; let undone = false; let presentationFails = true;
    const actionCalls: unknown[][] = []; const undoCalls: unknown[][] = [];
    const worker = fixtureWorker({ dailyHome: async () => view,
      dailyInboxAction: async (...args: any[]) => {
        actionCalls.push(structuredClone(args)); receipt = { previous: null, batchId: null, disposition: { schema: 1,
          sourceKey: item.sourceKey, sourceGeneration: item.sourceGeneration, revision: 1, requestId: args[1].requestId,
          state: "active", until: null, localDate: null, timeZone: null } }; return receipt;
      },
      dailyInboxUndo: async (...args: unknown[]) => { undoCalls.push(structuredClone(args)); undone = true; throw new Error("Undo response lost"); },
      mutationOutcome: async (route: string) => route === "daily.inbox" && receipt || route === "daily.undoInbox" && undone
        ? { status: "recorded", current: false, result: route === "daily.inbox" ? receipt : { undone: true },
          target: { appInstanceId: view.basis.appInstanceId, activeGenerationId, lineageEpoch: "0", protectionRevision: "2", digestSchema: 1,
            stateSha256: `sha256:${"a".repeat(64)}` } } : { status: "not_invoked" },
      cancelPresentation: async () => ({ status: "uncertain" }),
    });
    const host = document.createElement("div"); document.body.replaceChildren(host); let root = createRoot(host);
    const render = () => root.render(<TodayView worker={worker} tables={[{ name: "tasks", semantic: { tableId }, columns: [] } as unknown as RegTable]}
      dailyHomeMutationsAvailable onOpenRecord={() => {}} onOpenAutomation={() => {}} onOpenSavedView={() => {}} onQuickCapture={() => {}}
      onSetup={() => {}} onCreateRecurring={() => {}} onError={() => {}} onWrite={() => {
        expect(readPresentationIntent(sessionStorage, view.basis.appInstanceId, "dailyInboxUndo")).not.toBeNull();
        if (presentationFails) throw new Error("Panel refresh failed");
      }} />);
    const click = async (label: string) => {
      await waitFor(() => [...document.querySelectorAll("button")].some(button => button.textContent === label && !button.disabled));
      await act(async () => {
      const button = [...document.querySelectorAll("button")].find(button => button.textContent === label);
      expect(button, label).toBeDefined(); button!.click();
      });
    };
    const remount = async () => { await act(async () => root.unmount()); root = createRoot(host); await act(async () => render()); };
    try {
      await act(async () => render()); await click("Inbox");
      expectControlCensus("D.inbox"); await click("Complete");
      await waitFor(() => readPresentationIntent(sessionStorage, view.basis.appInstanceId, "dailyInboxUndo") !== null);
      const retained = readPresentationIntent(sessionStorage, view.basis.appInstanceId, "dailyInboxUndo");
      expect(retained).not.toBeNull();
      await remount(); presentationFails = false; await click("Retry original Daily change");
      expect(actionCalls).toHaveLength(1);
      await click("Undo Inbox change"); expect(readPresentationIntent(sessionStorage, view.basis.appInstanceId, "dailyInboxUndo")).toEqual(retained);
      await click("Keep Inbox change"); expect(readPresentationIntent(sessionStorage, view.basis.appInstanceId, "dailyInboxUndo")).toEqual(retained);
      await remount(); await click("Undo Inbox change");
      await waitFor(() => readPresentationIntent(sessionStorage, view.basis.appInstanceId, "dailyInboxUndo") === null);
      expect(undoCalls).toEqual([[retained!.payload, { requestId: retained!.requestId }]]);
      expect(readPresentationIntent(sessionStorage, view.basis.appInstanceId, "dailyInboxUndo")).toBeNull();
    } finally { await act(async () => root.unmount()); }
  });
  it("never replaces a newer projection with a late result from an earlier refresh", async () => {
    let release!: (value: DailyHomeSnapshot) => void;
    const old = new Promise<DailyHomeSnapshot>(resolve => { release = resolve; });
    const latest = snapshot(); latest.sections[1]!.page.items[0]!.title = "Current work";
    const worker = fixtureWorker({ dailyHome: vi.fn().mockReturnValueOnce(old).mockResolvedValue(latest) });
    const props = { worker, tables: [] as RegTable[], onOpenRecord: () => {}, onOpenAutomation: () => {},
      onOpenSavedView: () => {}, onQuickCapture: () => {}, onSetup: () => {}, onCreateRecurring: () => {}, onError: () => {} };
    const host = document.createElement("div"); document.body.replaceChildren(host); const root = createRoot(host);
    try {
      await act(async () => root.render(<TodayView {...props} refreshToken={1} />));
      await act(async () => root.render(<TodayView {...props} refreshToken={2} />));
      await waitFor(() => document.body.textContent?.includes("Current work") ?? false);
      expect(document.body.textContent).toContain("Current work");
      await act(async () => release(snapshot()));
      expect(document.body.textContent).toContain("Current work");
      expect(document.body.textContent).not.toContain("Overdue tax");
    } finally { await act(async () => root.unmount()); }
  });
  it("opens a projected due record through its stable table route", async () => {
    const opened: Array<{ table: string; id: string }> = [];
    const worker = fixtureWorker({ dailyHome: async () => snapshot() });
    const tables = [{ name: "tasks", semantic: { tableId }, columns: [] }] as unknown as RegTable[];
    const host = document.createElement("div");
    document.body.replaceChildren(host);
    const root = createRoot(host);

    await act(async () => root.render(<TodayView
      worker={worker}
      tables={tables}
      onOpenRecord={(table, id) => opened.push({ table, id })}
      onOpenAutomation={() => undefined}
      onOpenSavedView={() => undefined}
      onQuickCapture={() => undefined}
      onSetup={() => undefined}
      onCreateRecurring={() => undefined}
      dailyHomeMutationsAvailable
      onError={message => { throw new Error(message); }}
    />));
    await waitFor(() => document.body.textContent?.includes("Overdue tax") ?? false);

    expect(document.querySelector("h1")?.textContent).toBe("Today");
    expect(document.body.textContent).toContain("Overdue");
    expect(document.body.textContent).toContain("Favorite");
    expect(document.body.textContent).toContain("Opened recently");
    const pin = document.querySelector<HTMLButtonElement>('button[aria-label="Unpin Overdue tax"]')!;
    await act(async () => { pin.click(); await Promise.resolve(); });
    expect(worker.compareAndSetDailyNavigation).toHaveBeenCalledWith(0, expect.objectContaining({ favorites: [] }),
      expect.objectContaining({ requestId: expect.stringMatching(/^req_/) }), expect.objectContaining({ authorityTarget: expect.objectContaining({ appInstanceId: snapshot().basis.appInstanceId }) }));
    expect(opened).toEqual([]);

    const open = [...document.querySelectorAll<HTMLButtonElement>(".today-item-main")]
      .find(button => button.textContent?.includes("Overdue tax"))!;
    await act(async () => open.click());
    expect(opened).toEqual([{ table: "tasks", id: rowId }]);

    await act(async () => root.unmount());
  });

  it("shows one truthful due total and never asserts an empty split from a partial page", async () => {
    const partial = snapshot();
    const sections = partial.sections.map(section => section.sectionId === "due_today" ? {
      ...section,
      page: {
        ...section.page,
        items: [], returned: 0,
        counts: {
          sourceOccurrences: {
            kind: "partial", knownMinimum: 0,
            gaps: [{ sourceId: "due_record", reason: "limit", retryable: true }],
          },
          renderedUnique: {
            kind: "partial", knownMinimum: 0,
            gaps: [{ sourceId: "due_record", reason: "limit", retryable: true }],
          },
        },
      },
    } : section) as DailyHomeSnapshot["sections"];
    const worker = fixtureWorker({ dailyHome: async () => ({ ...partial, sections }) });
    const host = document.createElement("div");
    document.body.replaceChildren(host);
    const root = createRoot(host);
    await act(async () => root.render(<TodayView
      worker={worker} tables={[]} onOpenRecord={() => undefined}
      onOpenAutomation={() => undefined} onOpenSavedView={() => undefined}
      onQuickCapture={() => undefined} onSetup={() => undefined}
      onCreateRecurring={() => undefined} onError={message => { throw new Error(message); }}
    />));
    await waitFor(() => document.body.textContent?.includes("Due today & overdue") ?? false);

    const dueSection = document.querySelector<HTMLElement>(".today-section-due_today")!;
    expect(dueSection.querySelector("header span")?.textContent).toBe("0+");
    expect(dueSection.textContent).toContain("Due results are partial; more work may exist.");
    expect(document.body.textContent).not.toContain("Nothing overdue");
    expect(document.body.textContent).not.toContain("Nothing else is due today");

    await act(async () => root.unmount());
  });

  it("stores an explicitly reviewed due source by stable semantic identity", async () => {
    const labelFieldId = "fld_018f4c2a-7b31-7001-8000-000000000081";
    const dueFieldId = "fld_018f4c2a-7b31-7001-8000-000000000082";
    const tables = [{
      name: "renamed_tasks",
      label: "Tasks",
      semantic: { tableId, label: "Tasks" },
      columns: [{
        name: "renamed_title", label: "Title", type: "text", required: true,
        semantic: { fieldId: labelFieldId, label: "Title" },
      }, {
        name: "target_date", label: "Due date", type: "date", required: false,
        semantic: { fieldId: dueFieldId, label: "Due date" },
      }],
    }] as unknown as RegTable[];
    let projected = 0;
    const writes: Array<{ expected: number; value: unknown }> = [];
    const worker = fixtureWorker({
      dailyHome: async () => {
        projected++;
        return { ...snapshot(), configurationStatus: projected === 1 ? "needs_setup" : "partial" };
      },
      getSetting: async () => null,
      compareAndSetDailySource: async (expected: number, value: unknown) => {
        writes.push({ expected, value });
        return { ok: true, current: value };
      },
    });
    const host = document.createElement("div");
    document.body.replaceChildren(host);
    const root = createRoot(host);
    await act(async () => root.render(<TodayView
      worker={worker} tables={tables} onOpenRecord={() => undefined}
      onOpenAutomation={() => undefined} onOpenSavedView={() => undefined}
      onQuickCapture={() => undefined} onSetup={() => undefined}
      onCreateRecurring={() => undefined} dailyHomeMutationsAvailable
      onError={message => { throw new Error(message); }}
    />));
    await waitFor(() => document.body.textContent?.includes("Set up Today") ?? false);
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent === "Set up Today")!.click());
    await waitFor(() => document.querySelector<HTMLSelectElement>('select[aria-label="Record type"]')?.disabled === false);

    expect(document.querySelector<HTMLSelectElement>('select[aria-label="Record type"]')?.value).toBe(tableId);
    expect(document.querySelector<HTMLSelectElement>('select[aria-label="Title field"]')?.value).toBe(labelFieldId);
    expect(document.querySelector<HTMLSelectElement>('select[aria-label="Due date field"]')?.value).toBe(dueFieldId);
    const form = document.querySelector<HTMLFormElement>("form.today-source-form")!;
    await act(async () => void form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await waitFor(() => projected >= 3);

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      expected: 0,
      value: {
        schema: 1, revision: 1,
        profiles: [{
          schema: 1, tableId, labelFieldId, dueFieldId, completion: { kind: "none" },
          enabled: true, labelSnapshot: "Tasks", dueLabelSnapshot: "Due date",
        }],
      },
    });
    expect((writes[0]!.value as { profiles: Array<{ profileId: string }> }).profiles[0]!.profileId)
      .toMatch(/^dsp_[a-z2-7]{26}$/);

    await act(async () => root.unmount());
  });

  it("reviews completion rules and repairs stale or malformed source profiles", async () => {
    const labelFieldId = "fld_018f4c2a-7b31-7001-8000-000000000081";
    const dueFieldId = "fld_018f4c2a-7b31-7001-8000-000000000082";
    const doneFieldId = "fld_018f4c2a-7b31-7001-8000-000000000083";
    const staleTableId = "tbl_018f4c2a-7b31-7001-8000-000000000099";
    const tables = [{
      name: "tasks",
      semantic: { tableId, label: "Tasks" },
      columns: [{
        name: "title", label: "Title", type: "text", required: true,
        semantic: { fieldId: labelFieldId, label: "Title" },
      }, {
        name: "due_on", label: "Due", type: "date", required: false,
        semantic: { fieldId: dueFieldId, label: "Due" },
      }, {
        name: "done", label: "Done", type: "boolean", required: false,
        semantic: { fieldId: doneFieldId, label: "Done" },
      }],
    }] as unknown as RegTable[];
    let current: unknown = {
      schema: 1, revision: 4, profiles: [{
        schema: 1, profileId: `dsp_${"d".repeat(26)}`, tableId,
        labelFieldId, dueFieldId, completion: { kind: "none" }, enabled: true,
        labelSnapshot: "Tasks", dueLabelSnapshot: "Due",
      }, {
        schema: 1, profileId: `dsp_${"e".repeat(26)}`, tableId: staleTableId,
        labelFieldId, dueFieldId, completion: { kind: "none" }, enabled: true,
        labelSnapshot: "Missing tasks", dueLabelSnapshot: "Due",
      }],
    };
    const writes: unknown[] = [];
    const worker = fixtureWorker({
      dailyHome: async () => ({ ...snapshot(), configurationStatus: "partial" }),
      getSetting: async () => current,
      compareAndSetDailySource: async (expectedRevision: number, value: unknown) => {
        const revision = typeof current === "object" && current !== null
          && Number.isSafeInteger((current as { revision?: unknown }).revision)
          ? Number((current as { revision: number }).revision) : 0;
        if (expectedRevision !== revision) return { ok: false, current };
        current = value; writes.push(value); return { ok: true, current };
      },
    });
    const host = document.createElement("div");
    document.body.replaceChildren(host);
    const root = createRoot(host);
    await act(async () => root.render(<TodayView
      worker={worker} tables={tables} onOpenRecord={() => undefined}
      onOpenAutomation={() => undefined} onOpenSavedView={() => undefined}
      onQuickCapture={() => undefined} onSetup={() => undefined}
      onCreateRecurring={() => undefined} dailyHomeMutationsAvailable
      onError={message => { throw new Error(message); }}
    />));
    await waitFor(() => document.body.textContent?.includes("Review setup") ?? false);
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent === "Review setup")!.click());
    await waitFor(() => document.querySelector<HTMLSelectElement>('select[aria-label="Completion rule"]')?.disabled === false);

    const completion = document.querySelector<HTMLSelectElement>('select[aria-label="Completion rule"]')!;
    await act(async () => {
      completion.value = `boolean:${doneFieldId}`;
      completion.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => void document.querySelector<HTMLFormElement>("form.today-source-form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await waitFor(() => writes.length === 1);
    expect(writes[0]).toMatchObject({ profiles: [
      { tableId, completion: { kind: "boolean", fieldId: doneFieldId, completeValue: true } },
      { tableId: staleTableId },
    ] });
    await waitFor(() => document.querySelector("form.today-source-form") === null);

    await act(async () => [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent === "Review setup")!.click());
    await waitFor(() => document.querySelector<HTMLButtonElement>('[aria-label="Remove source Missing tasks"]')?.disabled === false);
    await act(async () => document.querySelector<HTMLButtonElement>(
      '[aria-label="Remove source Missing tasks"]',
    )!.click());
    await waitFor(() => writes.length === 2);
    expect((writes[1] as { profiles: unknown[] }).profiles).toHaveLength(1);
    await waitFor(() => readPresentationIntent(sessionStorage, snapshot().basis.appInstanceId, "dailySource") === null);

    current = { schema: 99, revision: 8, profiles: "broken" };
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent === "Close")?.click());
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent === "Review setup")!.click());
    await waitFor(() => document.querySelector<HTMLButtonElement>('[aria-label="Reset Today sources"]')?.disabled === false);
    await act(async () => document.querySelector<HTMLButtonElement>(
      '[aria-label="Reset Today sources"]',
    )!.click());
    await waitFor(() => writes.length === 3);
    expect(writes[2]).toEqual({ schema: 1, revision: 9, profiles: [] });
    await waitFor(() => readPresentationIntent(sessionStorage, snapshot().basis.appInstanceId, "dailySource") === null);

    await act(async () => root.unmount());
  });

  it("surfaces the exact active-profile binding issue and reviewed recovery controls", async () => {
    const labelFieldId = "fld_018f4c2a-7b31-7001-8000-000000000081";
    const staleDueFieldId = "fld_018f4c2a-7b31-7001-8000-000000000082";
    const replacementDueFieldId = "fld_018f4c2a-7b31-7001-8000-000000000084";
    const profileId = `dsp_${"d".repeat(26)}`;
    const tables = [{
      name: "tasks",
      semantic: { tableId, label: "Tasks" },
      columns: [{
        name: "title", label: "Title", type: "text", required: true,
        semantic: { fieldId: labelFieldId, label: "Title" },
      }, {
        name: "due_text", label: "Due", type: "text", required: false,
        semantic: { fieldId: staleDueFieldId, label: "Due" },
      }, {
        name: "due_on", label: "New due date", type: "date", required: false,
        semantic: { fieldId: replacementDueFieldId, label: "New due date" },
      }],
    }] as unknown as RegTable[];
    const library = {
      schema: 1, revision: 4, profiles: [{
        schema: 1, profileId, tableId, labelFieldId,
        dueFieldId: staleDueFieldId,
        completion: { kind: "none" }, enabled: true,
        labelSnapshot: "Tasks", dueLabelSnapshot: "Due",
      }],
    };
    const worker = fixtureWorker({
      dailyHome: async () => ({ ...snapshot(), configurationStatus: "partial" }),
      getSetting: async () => library,
    });
    let openedData = 0;
    const host = document.createElement("div");
    document.body.replaceChildren(host);
    const root = createRoot(host);
    await act(async () => root.render(<TodayView
      worker={worker} tables={tables} onOpenRecord={() => undefined}
      onOpenAutomation={() => undefined} onOpenSavedView={() => undefined}
      onQuickCapture={() => undefined} onSetup={() => { openedData++; }}
      onCreateRecurring={() => undefined} onError={message => { throw new Error(message); }}
    />));
    await waitFor(() => document.body.textContent?.includes("Review setup") ?? false);
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent === "Review setup")!.click());
    await waitFor(() => document.body.textContent?.includes("Due field “Due” is no longer a date.") ?? false);

    const review = document.querySelector<HTMLButtonElement>(
      '[aria-label="Review binding for Tasks"]',
    )!;
    expect(review).not.toBeNull();
    await act(async () => review.click());
    expect(document.querySelector<HTMLSelectElement>('select[aria-label="Due date field"]')?.value)
      .toBe(replacementDueFieldId);
    const repair = document.querySelector<HTMLButtonElement>(
      '[aria-label="Repair schema for Tasks"]',
    )!;
    await act(async () => repair.click());
    expect(openedData).toBe(1);
    expect(document.querySelector<HTMLButtonElement>(
      '[aria-label="Remove source Tasks"]',
    )?.disabled).toBe(true);

    await act(async () => root.unmount());
  });

  it("refreshes exactly at projection expiry and when the app becomes visible", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-06T12:00:00.000Z"));
    let projected = 0;
    const worker = fixtureWorker({
      dailyHome: async () => {
        projected++;
        return {
          ...snapshot(),
          basis: {
            ...snapshot().basis,
            projectionValidUntil: projected === 1
              ? "2026-09-06T12:00:01.000Z" : "2026-09-06T12:01:00.000Z",
          },
        };
      },
    });
    const host = document.createElement("div");
    document.body.replaceChildren(host);
    const root = createRoot(host);
    try {
      await act(async () => { root.render(<TodayView
        worker={worker} tables={[]} onOpenRecord={() => undefined}
        onOpenAutomation={() => undefined} onOpenSavedView={() => undefined}
        onQuickCapture={() => undefined} onSetup={() => undefined}
        onCreateRecurring={() => undefined} onError={message => { throw new Error(message); }}
      />); await Promise.resolve(); });
      expect(projected).toBe(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });

      await act(async () => { await vi.advanceTimersByTimeAsync(1_001); });
      expect(projected).toBe(2);

      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
        await Promise.resolve();
      });
      expect(projected).toBe(3);
    } finally {
      await act(async () => root.unmount());
      vi.useRealTimers();
    }
  });
});
