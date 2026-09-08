import { describe, expect, it, vi } from "vitest";
import { openMemoryDriver } from "../src/index";
import { ProductionStoreAuthority } from "../src/production-authority";

const opaque = (prefix: string, char: string): string => `${prefix}_${char.repeat(26)}`;

async function freshAuthority(char: string): Promise<ProductionStoreAuthority> {
  const driver = await openMemoryDriver();
  driver.exec("ATTACH DATABASE ':memory:' AS catalog");
  const namespaceId = opaque("ns", char);
  return ProductionStoreAuthority.initializeFresh(driver, {
    inventory: { state: "complete", catalogPresent: false, namespaces: [] },
    storageKey: namespaceId,
    displayName: "Seed test",
    shellId: "blank",
    appInstanceId: opaque("app", char),
    generationId: opaque("gen", char),
    namespaceId,
    adoptionOperationId: opaque("op", char),
    releaseId: opaque("rel", char),
    nowMs: Date.now(),
    leaseTtlMs: 60_000,
  });
}

function trackerBundle() {
  const table = (name: string) => ({
    name,
    columns: [{ name: "title", type: "text", required: true }],
    sampleRows: [{ title: `${name} sample` }],
  });
  return {
    schema: 1,
    shellId: "tracker",
    shellName: "Tracker",
    tables: [table("alpha"), table("beta"), table("gamma"), table("delta")],
    panels: [{
      panel_id: "alpha_table",
      title: "Alpha",
      placement: { region: "main", order: 0 },
      code: '//#blueprint {"kind":"table","table":"alpha"}',
      declared_queries: [],
      declared_writes: [],
    }],
  };
}

function blankBundle(): {
  schema: number;
  shellId: string;
  shellName: string;
  tables: unknown[];
  panels: unknown[];
} {
  return {
    schema: 1,
    shellId: "blank",
    shellName: "Blank canvas",
    tables: [],
    panels: [],
  };
}

describe("production starter seed authority", () => {
  it("routes one captured starter bundle through one protection revision and stable replay", async () => {
    const authority = await freshAuthority("s");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const bundle = trackerBundle();
      const request = {
        requestId: opaque("req", "s"),
        route: "starter.seed",
        payload: bundle,
      };
      const replayRequest = structuredClone(request);

      let titleDescriptorReads = 0;
      const sourceRow = { title: "alpha sample" };
      bundle.tables[0]!.sampleRows[0] = new Proxy(sourceRow, {
        getOwnPropertyDescriptor(target, property) {
          if (property === "title") titleDescriptorReads += 1;
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
      });
      const pending = authority.executeMutation(request);
      sourceRow.title = "tampered after receipt";
      bundle.shellId = "tampered";

      const committed = await pending;
      expect(committed).toMatchObject({
        requestId: request.requestId,
        operationId: expect.stringMatching(/^op_[a-z2-7]{26}$/),
        changed: true,
        replayed: false,
        evidence: { protectionRevision: "1" },
        result: null,
      });
      expect(titleDescriptorReads).toBe(1);
      expect(authority.readStore().headVersion()).toBe(3);
      expect([...authority.readStore().registrySnapshot().keys()].sort())
        .toEqual(["alpha", "beta", "delta", "gamma"]);
      expect(authority.query({ from: "alpha" })).toMatchObject([{ title: "alpha sample" }]);
      const panel = authority.readStore().livePanels()[0]!;
      expect(panel.panel_id).toBe("alpha_table");
      expect(panel.code).not.toContain("//#blueprint");
      expect(panel.declared_queries).toEqual([expect.objectContaining({ from: "alpha" })]);
      const sampleRows = authority.readSetting<{
        format: 1; tables: Record<string, string[]>;
      }>("sample_rows")!;
      expect(sampleRows.format).toBe(1);
      for (const table of ["alpha", "beta", "gamma", "delta"])
        expect(sampleRows.tables[table]).toEqual(authority.query({ from: table }).map(row => String(row.id)));
      expect(authority.readSetting("shell_id")).toBe("tracker");
      expect(authority.inspectAuthority().targetReservations).toHaveLength(1);
      expect(authority.inspectAuthority().catalogReservations).toHaveLength(1);
      expect(authority.inspectAuthority().catalog.entries[0]!.shellId).toBe("tracker");

      await expect(authority.executeMutation(replayRequest)).resolves.toEqual({
        ...committed,
        replayed: true,
      });
      expect(authority.inspectAuthority().targetReservations).toHaveLength(1);
      expect(authority.query({ from: "alpha" })).toHaveLength(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      authority.close();
    }
  });

  it("preserves the blank starter's empty first version and settings", async () => {
    const authority = await freshAuthority("t");
    try {
      const committed = await authority.executeMutation({
        requestId: opaque("req", "t"),
        route: "starter.seed",
        payload: blankBundle(),
      });
      expect(committed).toMatchObject({
        changed: true,
        replayed: false,
        evidence: { protectionRevision: "1" },
        result: null,
      });
      expect(authority.readStore().headVersion()).toBe(1);
      expect(authority.readStore().registrySnapshot().size).toBe(0);
      expect(authority.readStore().livePanels()).toEqual([]);
      expect(authority.readSetting("sample_rows")).toEqual({ format: 1, tables: {} });
      expect(authority.readSetting("shell_id")).toBe("blank");
      expect(authority.inspectAuthority().targetReservations).toHaveLength(1);
    } finally {
      authority.close();
    }
  });

  it("materializes replay-stable relative dates once at starter execution", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-15T12:00:00.000Z"));
    const authority = await freshAuthority("5");
    const request = {
      requestId: opaque("req", "5"),
      route: "starter.seed",
      payload: {
        schema: 1,
        shellId: "tracker",
        shellName: "Tracker",
        tables: [{
          name: "dated_items",
          columns: [
            { name: "title", type: "text", required: true },
            { name: "due", type: "date", required: false },
          ],
          sampleRows: [{ title: "Soon", due: "@clay/starter-day:+3" }],
        }],
        panels: [],
      },
    };
    try {
      const committed = await authority.executeMutation(request);
      expect(authority.query({ from: "dated_items" })).toMatchObject([{
        title: "Soon",
        due: "2030-01-18",
      }]);
      vi.setSystemTime(new Date("2030-01-16T12:00:00.000Z"));
      await expect(authority.executeMutation(request)).resolves.toEqual({
        ...committed,
        replayed: true,
      });
      expect(authority.query({ from: "dated_items" })[0]!.due).toBe("2030-01-18");
      expect(authority.inspectAuthority().targetReservations).toHaveLength(1);
    } finally {
      authority.close();
      vi.useRealTimers();
    }
  });

  it("rejects accessors, malformed arrays, exotic records, and aggregate excess before reservation", async () => {
    const authority = await freshAuthority("u");
    try {
      let accessorCalls = 0;
      const accessor = blankBundle() as Record<string, unknown>;
      Object.defineProperty(accessor, "tables", {
        enumerable: true,
        configurable: true,
        get: () => { accessorCalls += 1; return []; },
      });
      const sparse = blankBundle();
      sparse.tables = new Array(1);
      const extra = blankBundle();
      Object.defineProperty(extra.panels, "extra", { enumerable: true, value: true });
      const exotic = Object.assign(Object.create({ inherited: true }), blankBundle()) as unknown;
      const aggregate = blankBundle();
      aggregate.panels = ["a", "b"].map((id, order) => ({
        panel_id: `panel_${id}`,
        title: id,
        placement: { region: "main", order },
        code: "x".repeat(600_000),
        declared_queries: [],
        declared_writes: [],
      }));

      const cases: Array<[string, unknown, RegExp]> = [
        ["v", accessor, /starter seed.*data propert/i],
        ["w", sparse, /starter seed.*array/i],
        ["x", extra, /starter seed.*array/i],
        ["y", exotic, /starter seed.*plain/i],
        ["z", aggregate, /starter seed.*aggregate.*limit/i],
      ];
      for (const [char, payload, message] of cases) {
        let thrown: unknown;
        let returned: Promise<unknown> | undefined;
        try {
          returned = authority.executeMutation({
            requestId: opaque("req", char), route: "starter.seed", payload,
          });
        } catch (error) {
          thrown = error;
        }
        if (returned) void returned.catch(() => undefined);
        expect(thrown).toMatchObject({ code: "E_TARGET_AUTHORITY_INVALID" });
        expect((thrown as Error).message).toMatch(message);
        expect(authority.inspectAuthority().targetReservations).toHaveLength(0);
        expect(authority.inspectAuthority().catalogReservations).toHaveLength(0);
      }
      expect(accessorCalls).toBe(0);
    } finally {
      authority.close();
    }
  });

  it("reserves shell_id for starter activation instead of allowing divergent generic settings", async () => {
    const authority = await freshAuthority("2");
    try {
      const requests = [{
        requestId: opaque("req", "2"),
        route: "setting.set",
        payload: { key: "shell_id", value: "tracker" },
      }, {
        requestId: opaque("req", "3"),
        route: "setting.delete",
        payload: { key: "shell_id" },
      }, {
        requestId: opaque("req", "4"),
        route: "setting.compareAndSet",
        payload: { key: "shell_id", expectedRevision: 0, value: "tracker" },
      }];
      for (const request of requests) {
        await expect(Promise.resolve().then(() => authority.executeMutation(request)))
          .rejects.toMatchObject({
            code: "E_TARGET_AUTHORITY_INVALID",
            message: expect.stringMatching(/reserved.*shell_id/i),
          });
      }
      expect(authority.readSetting("shell_id")).toBeUndefined();
      expect(authority.inspectAuthority().catalog.entries[0]!.shellId).toBe("blank");
      expect(authority.inspectAuthority().targetReservations).toHaveLength(0);
      expect(authority.inspectAuthority().catalogReservations).toHaveLength(0);
    } finally {
      authority.close();
    }
  });

  it("rejects a mutation-envelope accessor without invoking it", async () => {
    const authority = await freshAuthority("6");
    try {
      let accessorCalls = 0;
      const request: Record<string, unknown> = {
        requestId: opaque("req", "6"),
        route: "starter.seed",
      };
      Object.defineProperty(request, "payload", {
        enumerable: true,
        get: () => {
          accessorCalls += 1;
          throw new Error("envelope getter invoked");
        },
      });
      expect(() => authority.executeMutation(request)).toThrowError(expect.objectContaining({
        code: "E_TARGET_AUTHORITY_INVALID",
        message: expect.stringMatching(/envelope.*data propert/i),
      }));
      expect(accessorCalls).toBe(0);
      expect(authority.inspectAuthority().targetReservations).toHaveLength(0);
      expect(authority.inspectAuthority().catalogReservations).toHaveLength(0);
    } finally {
      authority.close();
    }
  });
});
