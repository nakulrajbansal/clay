import { describe, expect, it } from "vitest";
import {
  ClayStore, deriveInverse, openMemoryDriver,
  type DbDriver, type ForwardOpT,
} from "../src/index";
import {
  ProductionStoreAuthority,
  armProductionAuthorityFailureForTest,
} from "../src/production-authority";
import { encodeProductionResponse } from "../src/production-response-envelope";

const opaque = (prefix: string, char: string): string => `${prefix}_${char.repeat(26)}`;
const legacyInventory = {
  state: "complete" as const,
  catalogPresent: false,
  namespaces: [{
    storageKey: "default",
    userFile: "/user.db",
    systemFile: "/system.db",
    kind: "legacy" as const,
  }],
};

async function automationAuthority(dealCount = 1): Promise<{
  authority: ProductionStoreAuthority;
  driver: DbDriver;
}> {
  const driver = await openMemoryDriver();
  driver.exec("ATTACH DATABASE ':memory:' AS catalog");
  const store = ClayStore.fromDriver(driver);
  const operations: ForwardOpT[] = [
    { op: "create_table", table: "deals", columns: [
      { name: "name", type: "text", required: true },
      { name: "status", type: "enum", required: false, values: ["open", "won"] },
      { name: "onboarded", type: "boolean", required: false },
    ] },
    { op: "create_table", table: "tasks", columns: [
      { name: "name", type: "text", required: true },
      { name: "status", type: "enum", required: false, values: ["todo", "done"] },
      { name: "deal", type: "relation", required: false,
        relation: { target_table: "deals", cardinality: "one",
          unique_targets: false, display_field: "name" } },
    ] },
  ];
  store.commit({
    intent: "create automation fixtures",
    summary: "Created automation fixtures.",
    migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) },
  });
  for (let index = 0; index < dealCount; index++)
    store.insert("deals", { name: `Deal ${index}`, status: "open", onboarded: false });
  return {
    driver,
    authority: ProductionStoreAuthority.adoptLegacy(driver, {
      inventory: legacyInventory,
      storageKey: "default",
      displayName: "My app",
      appInstanceId: opaque("app", "a"),
      generationId: opaque("gen", "b"),
      namespaceId: opaque("ns", "c"),
      adoptionOperationId: opaque("op", "d"),
      releaseId: opaque("rel", "e"),
      nowMs: Date.now(),
      leaseTtlMs: 60_000,
    }),
  };
}

describe("production automation and operational authority", () => {
  it("authority-routes automation definition upsert with replayable receipts", async () => {
    const { authority } = await automationAuthority();
    const request = {
      requestId: opaque("req", "a"),
      route: "upsertAutomation",
      payload: { input: {
        name: "Onboard won deals",
        enabled: false,
        trigger: { kind: "record_matches", table: "deals",
          conditions: [{ field: "status", op: "eq", value: "won" }] },
        actions: [{ kind: "set_fields", values: {
          onboarded: { source: "literal", value: true },
        } }],
      } },
    } as const;
    try {
      const first = await authority.executeMutation(request);
      expect(first).toMatchObject({
        changed: true,
        replayed: false,
        result: { id: expect.stringMatching(/^auto_[0-9a-f]{32}$/), enabled: false },
      });
      expect(authority.readStore().listAutomations()).toEqual([first.result]);
      await expect(authority.executeMutation(request))
        .resolves.toEqual({ ...first, replayed: true });
      expect(authority.readStore().listAutomations()).toHaveLength(1);
    } finally {
      authority.close();
    }
  });

  it("authority-routes automation deletion atomically and replays it", async () => {
    const { authority } = await automationAuthority();
    try {
      const created = await authority.executeMutation({
        requestId: opaque("req", "b"),
        route: "upsertAutomation",
        payload: { input: {
          name: "Temporary rule",
          enabled: false,
          trigger: { kind: "manual", table: "deals", conditions: [] },
          actions: [{ kind: "notify", title: "Review", body: "Review this deal." }],
        } },
      });
      const automationId = (created.result as { id: string }).id;
      const request = {
        requestId: opaque("req", "c"),
        route: "deleteAutomation",
        payload: { id: automationId },
      } as const;

      const removed = await authority.executeMutation(request);
      expect(removed).toMatchObject({ changed: true, replayed: false, result: null });
      expect(authority.readStore().listAutomations()).toEqual([]);
      await expect(authority.executeMutation(request))
        .resolves.toEqual({ ...removed, replayed: true });
    } finally {
      authority.close();
    }
  });

  it("runs a manual automation through authority with atomic effects, run receipt, and notification", async () => {
    const { authority } = await automationAuthority();
    try {
      const created = await authority.executeMutation({
        requestId: opaque("req", "d"),
        route: "upsertAutomation",
        payload: { input: {
          name: "Onboard and notify",
          enabled: false,
          trigger: { kind: "manual", table: "deals", conditions: [] },
          actions: [
            { kind: "set_fields", values: {
              onboarded: { source: "literal", value: true },
            } },
            { kind: "notify", title: "Onboarded", body: "The deal was onboarded." },
          ],
        } },
      });
      const automationId = (created.result as { id: string }).id;
      const request = {
        requestId: opaque("req", "f"),
        route: "runAutomationNow",
        payload: { id: automationId },
      } as const;

      const executed = await authority.executeMutation(request);
      expect(executed).toMatchObject({
        changed: true,
        replayed: false,
        result: { automationId, status: "success", matchedRecords: 1, changed: 1 },
      });
      expect(authority.query({ from: "deals" })[0]).toMatchObject({ onboarded: true });
      expect(authority.readStore().automationRuns(automationId)).toEqual([executed.result]);
      expect(authority.readStore().listNotifications()).toMatchObject([{
        automationId,
        runId: (executed.result as { id: string }).id,
        title: "Onboarded",
        read: false,
      }]);
      await expect(authority.executeMutation(request))
        .resolves.toEqual({ ...executed, replayed: true });
      expect(authority.readStore().automationRuns(automationId)).toHaveLength(1);
      expect(authority.readStore().listNotifications()).toHaveLength(1);
    } finally {
      authority.close();
    }
  });

  it("runs due automations through one authority request and replays the exact run list", async () => {
    const { authority } = await automationAuthority();
    try {
      const created = await authority.executeMutation({
        requestId: opaque("req", "g"),
        route: "upsertAutomation",
        payload: { input: {
          name: "Onboard open deals",
          enabled: true,
          trigger: { kind: "record_matches", table: "deals",
            conditions: [{ field: "status", op: "eq", value: "open" }] },
          actions: [{ kind: "set_fields", values: {
            onboarded: { source: "literal", value: true },
          } }],
        } },
      });
      const automationId = (created.result as { id: string }).id;
      const request = {
        requestId: opaque("req", "h"),
        route: "runDueAutomations",
        payload: {},
      } as const;

      const executed = await authority.executeMutation(request);
      expect(executed).toMatchObject({
        changed: true,
        result: [{ automationId, status: "success", changed: 1 }],
      });
      expect(authority.query({ from: "deals" })[0]).toMatchObject({ onboarded: true });
      await expect(authority.executeMutation(request))
        .resolves.toEqual({ ...executed, replayed: true });
      expect(authority.readStore().automationRuns(automationId)).toHaveLength(1);
    } finally {
      authority.close();
    }
  });

  it("keeps simulation read-only and execution at the exact 100-record bound", async () => {
    const { authority } = await automationAuthority(100);
    try {
      const created = await authority.executeMutation({
        requestId: opaque("req", "i"),
        route: "upsertAutomation",
        payload: { input: {
          name: "Onboard exactly one hundred",
          enabled: true,
          trigger: { kind: "manual", table: "deals", conditions: [] },
          actions: [{ kind: "set_fields", values: {
            onboarded: { source: "literal", value: true },
          } }],
        } },
      });
      const automationId = (created.result as { id: string }).id;
      const beforeSimulation = authority.inspectAuthority();

      expect(authority.readStore().simulateAutomation(automationId)).toMatchObject({
        matchedRecords: 100,
        plannedMutations: 100,
      });
      expect(authority.inspectAuthority()).toEqual(beforeSimulation);
      expect(authority.query({ from: "deals", where: [
        { field: "onboarded", op: "eq", value: true },
      ], limit: 500 })).toEqual([]);

      const executed = await authority.executeMutation({
        requestId: opaque("req", "j"),
        route: "runAutomationNow",
        payload: { id: automationId },
      });
      expect(executed).toMatchObject({
        changed: true,
        result: { status: "success", matchedRecords: 100, changed: 100 },
      });
      expect(authority.query({ from: "deals", where: [
        { field: "onboarded", op: "eq", value: true },
      ], limit: 500 })).toHaveLength(100);
    } finally {
      authority.close();
    }
  });

  it("fails closed above 100 records before effects, runs, notifications, or receipts", async () => {
    const { authority, driver } = await automationAuthority(101);
    try {
      const created = await authority.executeMutation({
        requestId: opaque("req", "k"),
        route: "upsertAutomation",
        payload: { input: {
          name: "Reject one hundred and one",
          enabled: true,
          trigger: { kind: "manual", table: "deals", conditions: [] },
          actions: [
            { kind: "set_fields", values: {
              onboarded: { source: "literal", value: true },
            } },
            { kind: "notify", title: "Onboarded", body: "The deal was onboarded." },
          ],
        } },
      });
      const automationId = (created.result as { id: string }).id;
      const before = authority.inspectAuthority();
      const requestId = opaque("req", "l");

      expect(() => authority.readStore().simulateAutomation(automationId)).toThrow(/100|limit/i);
      await expect(authority.executeMutation({
        requestId,
        route: "runAutomationNow",
        payload: { id: automationId },
      })).rejects.toThrow(/100|limit/i);

      expect(authority.inspectAuthority()).toEqual(before);
      expect(authority.query({ from: "deals", where: [
        { field: "onboarded", op: "eq", value: true },
      ], limit: 500 })).toEqual([]);
      expect(authority.readStore().automationRuns(automationId)).toEqual([]);
      expect(authority.readStore().listNotifications()).toEqual([]);
      expect(driver.select(
        "SELECT state FROM sys.production_request_receipts WHERE request_id = ?", [requestId],
      )).toEqual([]);
      expect(driver.select(
        "SELECT state FROM catalog.production_request_receipts WHERE request_id = ?", [requestId],
      )).toEqual([]);
    } finally {
      authority.close();
    }
  });

  it("fails closed when one run-due request cumulatively exceeds 100 records", async () => {
    const { authority, driver } = await automationAuthority(51);
    try {
      await authority.executeMutation({
        requestId: opaque("req", "m"),
        route: "upsertAutomation",
        payload: { input: {
          name: "First bounded rule",
          enabled: true,
          trigger: { kind: "record_matches", table: "deals",
            conditions: [{ field: "status", op: "eq", value: "open" }] },
          actions: [{ kind: "set_fields", values: {
            onboarded: { source: "literal", value: true },
          } }],
        } },
      });
      await authority.executeMutation({
        requestId: opaque("req", "n"),
        route: "upsertAutomation",
        payload: { input: {
          name: "Second bounded rule",
          enabled: true,
          trigger: { kind: "record_matches", table: "deals",
            conditions: [{ field: "status", op: "eq", value: "open" }] },
          actions: [{ kind: "notify", title: "Changed", body: "Must remain absent." }],
        } },
      });
      const before = authority.inspectAuthority();
      const requestId = opaque("req", "o");

      await expect(authority.executeMutation({
        requestId, route: "runDueAutomations", payload: {},
      })).rejects.toThrow(/100|limit/i);

      expect(authority.inspectAuthority()).toEqual(before);
      expect(authority.query({ from: "deals", where: [
        { field: "onboarded", op: "eq", value: true },
      ], limit: 500 })).toEqual([]);
      expect(authority.readStore().automationRuns()).toEqual([]);
      expect(authority.readStore().listNotifications()).toEqual([]);
      expect(driver.select(
        "SELECT state FROM sys.production_request_receipts WHERE request_id = ?", [requestId],
      )).toEqual([]);
      expect(driver.select(
        "SELECT state FROM catalog.production_request_receipts WHERE request_id = ?", [requestId],
      )).toEqual([]);
    } finally {
      authority.close();
    }
  });

  it("rejects a stale automation fence before effects, runs, notifications, or receipts", async () => {
    const { authority, driver } = await automationAuthority();
    try {
      const created = await authority.executeMutation({
        requestId: opaque("req", "k"),
        route: "upsertAutomation",
        payload: { input: {
          name: "Stale fence rule",
          enabled: false,
          trigger: { kind: "manual", table: "deals", conditions: [] },
          actions: [
            { kind: "set_fields", values: {
              onboarded: { source: "literal", value: true },
            } },
            { kind: "notify", title: "Changed", body: "Must remain absent." },
          ],
        } },
      });
      const automationId = (created.result as { id: string }).id;
      const targetBeforeTakeover = authority.inspectAuthority().target;
      const reservationsBeforeTakeover = authority.inspectAuthority().targetReservations;
      armProductionAuthorityFailureForTest(authority, "stale_fence");
      const requestId = opaque("req", "l");

      await expect(authority.executeMutation({
        requestId,
        route: "runAutomationNow",
        payload: { id: automationId },
      })).rejects.toMatchObject({ code: "E_STALE_WRITE_EPOCH" });

      expect(authority.inspectAuthority().target).toEqual(targetBeforeTakeover);
      expect(authority.inspectAuthority().targetReservations).toEqual(reservationsBeforeTakeover);
      expect(authority.query({ from: "deals" })[0]).toMatchObject({ onboarded: false });
      expect(authority.readStore().automationRuns(automationId)).toEqual([]);
      expect(authority.readStore().listNotifications()).toEqual([]);
      expect(driver.select(
        "SELECT state FROM sys.production_request_receipts WHERE request_id = ?", [requestId],
      )).toEqual([]);
      expect(driver.select(
        "SELECT state FROM catalog.production_request_receipts WHERE request_id = ?", [requestId],
      )).toEqual([]);
    } finally {
      authority.close();
    }
  });

  it("rejects nested automation accessors without invoking them", async () => {
    const { authority, driver } = await automationAuthority();
    let getterCalls = 0;
    const input = {
      enabled: false,
      trigger: { kind: "manual", table: "deals", conditions: [] },
      actions: [{ kind: "notify", title: "Review", body: "Review this deal." }],
    } as Record<string, unknown>;
    Object.defineProperty(input, "name", {
      enumerable: true,
      get() {
        getterCalls++;
        return "Getter rule";
      },
    });
    const requestId = opaque("req", "m");
    try {
      expect(() => authority.executeMutation({
        requestId,
        route: "upsertAutomation",
        payload: { input },
      })).toThrow(/invalid/i);
      expect(getterCalls).toBe(0);
      expect(authority.readStore().listAutomations()).toEqual([]);
      expect(driver.select(
        "SELECT state FROM sys.production_request_receipts WHERE request_id = ?", [requestId],
      )).toEqual([]);
    } finally {
      authority.close();
    }
  });

  it("undoes an automation run through authority with effects and notification dismissal atomic", async () => {
    const { authority } = await automationAuthority();
    try {
      const created = await authority.executeMutation({
        requestId: opaque("req", "n"),
        route: "upsertAutomation",
        payload: { input: {
          name: "Temporary onboarding",
          enabled: false,
          trigger: { kind: "manual", table: "deals", conditions: [] },
          actions: [
            { kind: "set_fields", values: {
              onboarded: { source: "literal", value: true },
            } },
            { kind: "notify", title: "Temporary", body: "Temporary notice." },
          ],
        } },
      });
      const automationId = (created.result as { id: string }).id;
      const executed = await authority.executeMutation({
        requestId: opaque("req", "o"),
        route: "runAutomationNow",
        payload: { id: automationId },
      });
      const runId = (executed.result as { id: string }).id;
      const request = {
        requestId: opaque("req", "p"),
        route: "undoAutomationRun",
        payload: { id: runId },
      } as const;

      const undone = await authority.executeMutation(request);
      expect(undone).toMatchObject({
        changed: true,
        result: { id: runId, automationId, undone: true },
      });
      expect(authority.query({ from: "deals" })[0]).toMatchObject({ onboarded: false });
      expect(authority.readStore().automationRuns(automationId)[0]).toMatchObject({ undone: true });
      expect(authority.readStore().listNotifications()).toEqual([]);
      await expect(authority.executeMutation(request))
        .resolves.toEqual({ ...undone, replayed: true });
    } finally {
      authority.close();
    }
  });

  it("marks a notification read through authority and mirrors a replayable canonical no-op", async () => {
    const { authority, driver } = await automationAuthority();
    try {
      const created = await authority.executeMutation({
        requestId: opaque("req", "q"),
        route: "upsertAutomation",
        payload: { input: {
          name: "Notify manually",
          enabled: false,
          trigger: { kind: "manual", table: "deals", conditions: [] },
          actions: [{ kind: "notify", title: "Review", body: "Review this deal." }],
        } },
      });
      const automationId = (created.result as { id: string }).id;
      await authority.executeMutation({
        requestId: opaque("req", "r"),
        route: "runAutomationNow",
        payload: { id: automationId },
      });
      const notificationId = authority.readStore().listNotifications()[0]!.id;
      const request = {
        requestId: opaque("req", "s"),
        route: "markNotificationRead",
        payload: { id: notificationId },
      } as const;

      const marked = await authority.executeMutation(request);
      expect(marked).toMatchObject({ changed: true, result: null });
      expect(authority.readStore().listNotifications()[0]).toMatchObject({
        id: notificationId,
        read: true,
      });
      await expect(authority.executeMutation(request))
        .resolves.toEqual({ ...marked, replayed: true });

      const beforeUnknown = authority.inspectAuthority();
      const unknownRequest = {
        requestId: opaque("req", "t"),
        route: "markNotificationRead",
        payload: { id: "00000000-0000-7000-8000-000000000000" },
      } as const;
      const unknown = await authority.executeMutation(unknownRequest);
      expect(unknown).toMatchObject({ changed: false, replayed: false, result: null });
      expect(authority.inspectAuthority()).toEqual(beforeUnknown);
      expect(driver.select(
        "SELECT state, response_json FROM sys.production_request_receipts WHERE request_id = ?",
        [unknownRequest.requestId],
      )).toEqual([{
        state: "no_op",
        response_json: encodeProductionResponse("markNotificationRead", null).json,
      }]);
      expect(driver.select(
        "SELECT state FROM catalog.production_request_receipts WHERE request_id = ?",
        [unknownRequest.requestId],
      )).toEqual([{ state: "no_op" }]);
      await expect(authority.executeMutation(unknownRequest))
        .resolves.toEqual({ ...unknown, replayed: true });
      expect(authority.inspectAuthority()).toEqual(beforeUnknown);
    } finally {
      authority.close();
    }
  });

  it("records bounded usage through authority and replays without duplicating observer input", async () => {
    const { authority, driver } = await automationAuthority();
    try {
      const requests = ["u", "v", "w"].map(char => ({
        requestId: opaque("req", char),
        route: "recordUsage" as const,
        payload: { event: {
          kind: "filter",
          subject: "board_filter",
          detail: { owner: "Dev" },
        } },
      }));
      await expect(authority.executeMutation(requests[0]!)).resolves.toMatchObject({
        changed: true,
        result: null,
      });
      await expect(authority.executeMutation(requests[0]!)).resolves.toMatchObject({
        changed: true,
        replayed: true,
      });
      for (const request of requests.slice(1)) {
        await expect(authority.executeMutation(request)).resolves.toMatchObject({
          changed: true,
          result: null,
        });
      }
      expect(authority.readStore().suggestions()).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "pin_filtered_panel" }),
      ]));
      expect(driver.select("SELECT COUNT(*) AS n FROM sys.usage_events"))
        .toEqual([{ n: 4 }]);
    } finally {
      authority.close();
    }
  });

  it("accepts an observer suggestion through authority and replays its state transition", async () => {
    const { authority, driver } = await automationAuthority(3);
    try {
      const suggestion = authority.readStore().suggestions()
        .find(candidate => candidate.kind === "add_view" && candidate.subject === "deals");
      expect(suggestion).toBeDefined();
      const request = {
        requestId: opaque("req", "x"),
        route: "acceptSuggestion",
        payload: { subject: suggestion!.subject, kind: suggestion!.kind },
      } as const;

      const accepted = await authority.executeMutation(request);
      expect(accepted).toMatchObject({ changed: true, result: null });
      expect(authority.readStore().suggestions()
        .some(candidate => candidate.subject === suggestion!.subject
          && candidate.kind === suggestion!.kind)).toBe(false);
      expect(driver.select(
        "SELECT subject, kind, state FROM sys.suggestions WHERE state = 'accepted'",
      )).toEqual([{ subject: suggestion!.subject, kind: suggestion!.kind, state: "accepted" }]);
      await expect(authority.executeMutation(request))
        .resolves.toEqual({ ...accepted, replayed: true });
    } finally {
      authority.close();
    }
  });

  it("dismisses an observer suggestion through authority and persists the dismissal", async () => {
    const { authority, driver } = await automationAuthority(3);
    try {
      const suggestion = authority.readStore().suggestions()
        .find(candidate => candidate.kind === "add_view" && candidate.subject === "deals");
      expect(suggestion).toBeDefined();
      const request = {
        requestId: opaque("req", "y"),
        route: "dismissSuggestion",
        payload: { subject: suggestion!.subject, kind: suggestion!.kind },
      } as const;

      const dismissed = await authority.executeMutation(request);
      expect(dismissed).toMatchObject({ changed: true, result: null });
      expect(authority.readStore().suggestions()
        .some(candidate => candidate.subject === suggestion!.subject
          && candidate.kind === suggestion!.kind)).toBe(false);
      expect(driver.select(
        "SELECT subject, kind, state FROM sys.suggestions WHERE state = 'dismissed'",
      )).toEqual([{ subject: suggestion!.subject, kind: suggestion!.kind, state: "dismissed" }]);
      await expect(authority.executeMutation(request))
        .resolves.toEqual({ ...dismissed, replayed: true });
    } finally {
      authority.close();
    }
  });

  it("records excluded private metrics on the fixed operational authority path", async () => {
    const { authority, driver } = await automationAuthority();
    const request = {
      requestId: opaque("req", "z"),
      route: "recordPrivateMetric",
      payload: { event: { type: "trust_surface_opened", surface: "history" } },
    } as const;
    try {
      const before = authority.inspectAuthority();
      expect(() => authority.executeMutation(request)).toThrow(/invalid/i);
      const recorded = await authority.executeOperationalMetricMutation(request);

      expect(recorded).toMatchObject({ changed: true, replayed: false, result: null });
      expect(authority.readStore().privateMetricsSummary().trust.historyOpened).toBe(1);
      expect(authority.inspectAuthority()).toEqual(before);
      expect(driver.select(
        "SELECT state FROM sys.production_request_receipts WHERE request_id = ?", [request.requestId],
      )).toEqual([]);
      expect(driver.select(
        "SELECT state FROM catalog.production_request_receipts WHERE request_id = ?", [request.requestId],
      )).toEqual([]);
      expect(authority.inspectAuthority().targetReservations).toEqual([]);
      expect(authority.inspectAuthority().catalogReservations).toEqual([]);
    } finally {
      authority.close();
    }
  });

  it("enforces the exact shared two-megabyte recordUsage capture budget", async () => {
    const { authority, driver } = await automationAuthority();
    try {
      const exactRequest = {
        requestId: opaque("req", "2"),
        route: "recordUsage" as const,
        payload: { event: {
          kind: "filter", subject: "boundary_filter",
          detail: { first: "", second: "" },
        } },
      };
      const encoder = new TextEncoder();
      const overhead = encoder.encode(JSON.stringify(exactRequest)).byteLength;
      exactRequest.payload.event.detail.first = "a".repeat(999_999);
      exactRequest.payload.event.detail.second = "b".repeat(2_000_000 - overhead - 999_999);
      expect(encoder.encode(JSON.stringify(exactRequest)).byteLength).toBe(2_000_000);
      await expect(authority.executeMutation(exactRequest))
        .resolves.toMatchObject({ changed: true });

      const rejectedId = opaque("req", "3");
      await expect(Promise.resolve().then(() => authority.executeMutation({
        requestId: rejectedId, route: "recordUsage",
        payload: { event: {
          kind: "filter", subject: "oversized_filter",
          detail: {
            first: "a".repeat(700_000),
            second: "b".repeat(700_000),
            third: "c".repeat(700_000),
          },
        } },
      }))).rejects.toThrow(/limit|exceeds/i);
      expect(driver.select(
        "SELECT state FROM sys.production_request_receipts WHERE request_id = ?", [rejectedId],
      )).toEqual([]);
      expect(driver.select("SELECT subject FROM sys.usage_events WHERE subject = 'oversized_filter'"))
        .toEqual([]);
    } finally {
      authority.close();
    }
  });

  it("changes private metric collection and classifies an unchanged setting as an operational no-op", async () => {
    const { authority, driver } = await automationAuthority();
    try {
      const before = authority.inspectAuthority();
      const disabled = await authority.executeOperationalMetricMutation({
        requestId: opaque("req", "3"),
        route: "setPrivateMetricsEnabled",
        payload: { enabled: false },
      });
      expect(disabled).toMatchObject({
        changed: true,
        replayed: false,
        result: { collectionEnabled: false },
      });
      expect(authority.inspectAuthority()).toEqual(before);

      const noOpRequestId = opaque("req", "4");
      const noOp = await authority.executeOperationalMetricMutation({
        requestId: noOpRequestId,
        route: "setPrivateMetricsEnabled",
        payload: { enabled: false },
      });
      expect(noOp).toMatchObject({
        changed: false,
        replayed: false,
        result: { collectionEnabled: false },
      });
      expect(authority.inspectAuthority()).toEqual(before);
      expect(driver.select(
        "SELECT state FROM sys.production_request_receipts WHERE request_id = ?", [noOpRequestId],
      )).toEqual([]);

      const ignoredRequestId = opaque("req", "5");
      const ignored = await authority.executeOperationalMetricMutation({
        requestId: ignoredRequestId,
        route: "recordPrivateMetric",
        payload: { event: { type: "trust_surface_opened", surface: "history" } },
      });
      expect(ignored).toMatchObject({ changed: false, result: null });
      expect(authority.readStore().privateMetricsSummary().trust.historyOpened).toBe(0);
      expect(driver.select(
        "SELECT state FROM sys.production_request_receipts WHERE request_id = ?", [ignoredRequestId],
      )).toEqual([]);
    } finally {
      authority.close();
    }
  });

  it("clears private metrics through operational authority and no-ops when empty", async () => {
    const { authority, driver } = await automationAuthority();
    try {
      await authority.executeOperationalMetricMutation({
        requestId: opaque("req", "6"), route: "recordPrivateMetric",
        payload: { event: { type: "trust_surface_opened", surface: "history" } },
      });
      const before = authority.inspectAuthority();
      const cleared = await authority.executeOperationalMetricMutation({
        requestId: opaque("req", "7"), route: "clearPrivateMetrics", payload: {},
      });
      expect(cleared).toMatchObject({
        changed: true,
        result: { collectionEnabled: true, trust: { historyOpened: 0 } },
      });
      expect(authority.inspectAuthority()).toEqual(before);

      const noOpId = opaque("req", "a");
      const noOp = await authority.executeOperationalMetricMutation({
        requestId: noOpId, route: "clearPrivateMetrics", payload: {},
      });
      expect(noOp).toMatchObject({
        changed: false,
        result: { collectionEnabled: true, trust: { historyOpened: 0 } },
      });
      expect(driver.select(
        "SELECT state FROM sys.production_request_receipts WHERE request_id = ?", [noOpId],
      )).toEqual([]);
    } finally {
      authority.close();
    }
  });

  it("rolls back automation effects, notifications, and run receipts after live execution", async () => {
    const { authority, driver } = await automationAuthority();
    try {
      const created = await authority.executeMutation({
        requestId: opaque("req", "b"), route: "upsertAutomation",
        payload: { input: {
          name: "Atomic run", enabled: false,
          trigger: { kind: "manual", table: "deals", conditions: [] },
          actions: [
            { kind: "set_fields", values: {
              onboarded: { source: "literal", value: true },
            } },
            { kind: "notify", title: "Changed", body: "Changed atomically." },
          ],
        } },
      });
      const automationId = (created.result as { id: string }).id;
      const requestId = opaque("req", "c");
      armProductionAuthorityFailureForTest(authority, "after_live_mutation");

      await expect(authority.executeMutation({
        requestId, route: "runAutomationNow", payload: { id: automationId },
      })).rejects.toThrow(/after live/i);
      expect(authority.query({ from: "deals" })[0]).toMatchObject({ onboarded: false });
      expect(authority.readStore().automationRuns(automationId)).toEqual([]);
      expect(authority.readStore().listNotifications()).toEqual([]);
      expect(driver.select(
        "SELECT state FROM sys.production_request_receipts WHERE request_id = ?", [requestId],
      )).toEqual([{ state: "failed" }]);
      expect(driver.select(
        "SELECT state FROM catalog.production_request_receipts WHERE request_id = ?", [requestId],
      )).toEqual([{ state: "failed" }]);
      expect(authority.inspectAuthority().targetReservations.at(-1)?.state).toBe("abandoned");
      expect(authority.inspectAuthority().catalogReservations.at(-1)?.state).toBe("abandoned");
    } finally {
      authority.close();
    }
  });

  it("never invokes accessors on any added route payload", async () => {
    const { authority } = await automationAuthority();
    const routes = [
      "upsertAutomation", "deleteAutomation", "runDueAutomations", "runAutomationNow",
      "undoAutomationRun", "markNotificationRead", "recordPrivateMetric",
      "setPrivateMetricsEnabled", "clearPrivateMetrics", "recordUsage",
      "acceptSuggestion", "dismissSuggestion",
    ] as const;
    let reads = 0;
    try {
      const privateRoutes = new Set<string>([
        "recordPrivateMetric", "setPrivateMetricsEnabled", "clearPrivateMetrics",
      ]);
      for (const route of routes) {
        const payload: Record<string, unknown> = {};
        Object.defineProperty(payload, "hostile", {
          enumerable: true,
          get: () => { reads++; return "must not be read"; },
        });
        const execute = (): Promise<unknown> => privateRoutes.has(route)
          ? authority.executeOperationalMetricMutation({
              requestId: opaque("req", "d"), route, payload,
            })
          : authority.executeMutation({ requestId: opaque("req", "d"), route, payload });
        expect(execute).toThrow(/invalid/i);
      }
      expect(reads).toBe(0);
      expect(authority.inspectAuthority().targetReservations).toEqual([]);
    } finally {
      authority.close();
    }
  });

  it("accepts only dense standard arrays and plain enumerable data records", async () => {
    const { authority } = await automationAuthority();
    try {
      const base = {
        name: "Shape check", enabled: false,
        trigger: { kind: "manual", table: "deals", conditions: [] },
      };
      const sparseActions = new Array(1);
      const symbolic = { ...base, actions: [] as unknown[] } as Record<PropertyKey, unknown>;
      symbolic[Symbol("hidden")] = true;
      const nonEnumerable = { ...base, actions: [] as unknown[] };
      Object.defineProperty(nonEnumerable, "hidden", { value: true, enumerable: false });
      const cases: unknown[] = [
        { ...base, actions: sparseActions }, symbolic, nonEnumerable,
      ];
      for (const input of cases) expect(() => authority.executeMutation({
        requestId: opaque("req", "e"), route: "upsertAutomation", payload: { input },
      })).toThrow(/invalid|limits/i);
      expect(authority.readStore().listAutomations()).toEqual([]);
    } finally {
      authority.close();
    }
  });

  it("rolls back a fixed operational metric after its live write when physical authority fails", async () => {
    const { authority, driver } = await automationAuthority();
    const before = authority.inspectAuthority();
    const requestId = opaque("req", "f");
    try {
      armProductionAuthorityFailureForTest(authority, "after_live_mutation");
      await expect(authority.executeOperationalMetricMutation({
        requestId, route: "recordPrivateMetric",
        payload: { event: { type: "trust_surface_opened", surface: "history" } },
      })).rejects.toThrow(/after live/i);
      expect(authority.readStore().privateMetricsSummary().trust.historyOpened).toBe(0);
      expect(authority.inspectAuthority()).toEqual(before);
      expect(driver.select(
        "SELECT state FROM sys.production_request_receipts WHERE request_id = ?", [requestId],
      )).toEqual([]);
    } finally {
      authority.close();
    }
  });
});
