import { ClayStore, openMemoryDriver } from "@clay/kernel";
import { describe, expect, it, vi } from "vitest";
import {
  FIRST_RUN_PUBLICATION_STAGES,
  activateImportedAppAtomically,
  activateStarterAtomically,
  readFirstRunPublication,
  undoFirstRunImportAtomically,
  type FirstRunPublicationFaultStage,
} from "../src/worker/first-run-activation";
import { FIRST_SUCCESS_SETTING_KEY } from "../src/app/first-success-state";
import {
  SAMPLE_PROVENANCE_SETTING, parseSampleProvenanceLedger,
} from "../src/shells/sample-provenance";

const STARTER_OPERATION = "starter-operation-0001";
const IMPORT_OPERATION = "import-operation-00001";
const review = {
  sourceRows: 2,
  acceptedRows: 2,
  skippedRows: 0,
  truncatedRows: 0,
  sourceColumns: 1,
  acceptedColumns: 1,
  truncatedColumns: 0,
};

async function harness(): Promise<{
  driver: Awaited<ReturnType<typeof openMemoryDriver>>;
  owner: { store: ClayStore };
  install: (store: ClayStore) => void;
}> {
  const driver = await openMemoryDriver();
  const owner = { store: ClayStore.fromDriver(driver) };
  return {
    driver,
    owner,
    install: store => { owner.store = store; },
  };
}

const starterRequest = {
  operationId: STARTER_OPERATION,
  appId: "default",
  shellId: "tracker" as const,
};
const importRequest = {
  operationId: IMPORT_OPERATION,
  appId: "default",
  table: "jobs",
  columns: [{ name: "name", type: "text" }],
  rows: [{ name: "One" }, { name: "Two" }],
  review,
};

function failAt(target: FirstRunPublicationFaultStage): (stage: FirstRunPublicationFaultStage) => void {
  return stage => {
    if (stage === target) throw new Error(`injected ${stage} failure`);
  };
}

function concurrentGate(): {
  wait: () => Promise<void>;
  arrivals: () => number;
} {
  let count = 0;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  return {
    arrivals: () => count,
    wait: async () => {
      count++;
      if (count === 2) release();
      await ready;
    },
  };
}

async function expectEmpty(store: ClayStore): Promise<void> {
  expect(store.headVersion()).toBe(0);
  expect(store.registrySnapshot().size).toBe(0);
  expect(store.getSetting("shell_id")).toBeUndefined();
  expect(store.getSetting(FIRST_SUCCESS_SETTING_KEY)).toBeUndefined();
  expect(readFirstRunPublication(store, "default")).toBeNull();
}

describe("worker-owned staged first-run publication", () => {
  it("defines one closed, unique fault stage registry", () => {
    expect(FIRST_RUN_PUBLICATION_STAGES).toEqual([
      "stage-opened",
      "structure-staged",
      "records-staged",
      "provenance-staged",
      "receipt-staged",
      "stage-validated",
      "before-publication",
      "during-publication",
      "after-publication",
    ]);
    expect(new Set(FIRST_RUN_PUBLICATION_STAGES).size)
      .toBe(FIRST_RUN_PUBLICATION_STAGES.length);
  });

  it("retains the exact frozen starter.seed result in the durable publication receipt", async () => {
    const { driver, owner, install } = await harness();
    const result = await activateStarterAtomically(driver, owner.store, starterRequest, {
      onPublishedStore: install,
    });
    const ledger = parseSampleProvenanceLedger(
      owner.store.getSetting(SAMPLE_PROVENANCE_SETTING),
    );

    expect(result.receipt.sampleCreation).toEqual({
      route: "starter.seed",
      created: ledger.entries,
    });
    expect(result.receipt.sampleCreation?.created).toHaveLength(3);
    expect(Object.isFrozen(result.receipt.sampleCreation)).toBe(true);
    expect(Object.isFrozen(result.receipt.sampleCreation?.created)).toBe(true);
    owner.store.close();
  });

  it.each(FIRST_RUN_PUBLICATION_STAGES)(
    "starter retry is old-or-new and duplicate-free after %s failure",
    async stage => {
      const { driver, owner, install } = await harness();
      const close = vi.spyOn(ClayStore.prototype, "close");
      await expect(activateStarterAtomically(driver, owner.store, starterRequest, {
        fault: failAt(stage), onPublishedStore: install,
      })).rejects.toThrow(`injected ${stage} failure`);

      if (stage === "after-publication") {
        expect(owner.store.registrySnapshot().has("items")).toBe(true);
        expect(readFirstRunPublication(owner.store, "default")?.operationId)
          .toBe(STARTER_OPERATION);
      } else {
        await expectEmpty(owner.store);
      }

      const result = await activateStarterAtomically(driver, owner.store, starterRequest, {
        onPublishedStore: install,
      });
      expect(result.receipt.operationId).toBe(STARTER_OPERATION);
      expect(result.receipt).toEqual(readFirstRunPublication(owner.store, "default"));
      expect(owner.store.query({ from: "items" })).toHaveLength(3);
      expect(owner.store.history()).toHaveLength(result.receipt.revision);
      expect(result.receipt.revision).toBeGreaterThan(0);
      expect(close).toHaveBeenCalled();
      close.mockRestore();
      owner.store.close();
    },
  );

  it.each(FIRST_RUN_PUBLICATION_STAGES)(
    "import retry is old-or-new and duplicate-free after %s failure",
    async stage => {
      const { driver, owner, install } = await harness();
      const close = vi.spyOn(ClayStore.prototype, "close");
      await expect(activateImportedAppAtomically(driver, owner.store, importRequest, {
        fault: failAt(stage), onPublishedStore: install,
      })).rejects.toThrow(`injected ${stage} failure`);

      if (stage === "after-publication") {
        expect(owner.store.query({ from: "jobs" })).toHaveLength(2);
        expect(readFirstRunPublication(owner.store, "default")?.operationId)
          .toBe(IMPORT_OPERATION);
      } else {
        await expectEmpty(owner.store);
      }

      const result = await activateImportedAppAtomically(driver, owner.store, importRequest, {
        onPublishedStore: install,
      });
      expect(result.receipt.operationId).toBe(IMPORT_OPERATION);
      expect(result.receipt).toEqual(readFirstRunPublication(owner.store, "default"));
      expect(owner.store.query({ from: "jobs" }).map(row => row.name)).toEqual(["One", "Two"]);
      expect(owner.store.history()).toHaveLength(1);
      expect(close).toHaveBeenCalled();
      close.mockRestore();
      owner.store.close();
    },
  );

  it("serializes concurrent retries so every caller receives the one canonical receipt", async () => {
    const { driver, owner, install } = await harness();
    const gate = concurrentGate();
    const activate = () => activateImportedAppAtomically(
      driver, owner.store, importRequest, {
        beforeExclusive: gate.wait, onPublishedStore: install,
      },
    );
    const [first, second] = await Promise.all([activate(), activate()]);
    expect(gate.arrivals()).toBe(2);
    const canonical = readFirstRunPublication(owner.store, "default");
    expect(first.receipt).toEqual(canonical);
    expect(second.receipt).toEqual(canonical);
    expect(owner.store.query({ from: "jobs" })).toHaveLength(2);
    owner.store.close();
  });

  it("allows only one of two concurrent distinct operations to claim the fresh target", async () => {
    const { driver, owner, install } = await harness();
    const gate = concurrentGate();
    const settled = await Promise.allSettled([
      activateImportedAppAtomically(
        driver, owner.store, importRequest, {
          beforeExclusive: gate.wait, onPublishedStore: install,
        },
      ),
      activateImportedAppAtomically(driver, owner.store, {
        ...importRequest, operationId: "import-operation-00002",
      }, { beforeExclusive: gate.wait, onPublishedStore: install }),
    ]);
    expect(gate.arrivals()).toBe(2);
    expect(settled.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(owner.store.query({ from: "jobs" })).toHaveLength(2);
    owner.store.close();
  });

  it("rejects an invalid imported row without publishing any subset", async () => {
    const { driver, owner, install } = await harness();
    await expect(activateImportedAppAtomically(driver, owner.store, {
      ...importRequest,
      columns: [{ name: "amount", type: "number" }],
      rows: [{ amount: 10 }, { amount: "not-a-number" }],
    }, { onPublishedStore: install })).rejects.toThrow();
    await expectEmpty(owner.store);
    owner.store.close();
  });

  it("returns a durable receipt bound to the canonical app, revision, review, and exact rows", async () => {
    const { driver, owner, install } = await harness();
    const result = await activateImportedAppAtomically(driver, owner.store, importRequest, {
      onPublishedStore: install,
    });

    expect(result.receipt).toMatchObject({
      version: 1,
      operationId: IMPORT_OPERATION,
      appId: "default",
      kind: "import",
      revision: 1,
      shellId: "blank",
      undone: false,
      import: {
        table: "jobs",
        acceptedRows: 2,
        review,
        structureRetainedOnUndo: true,
      },
    });
    expect(result.receipt.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result.receipt.import?.rowIds).toHaveLength(2);
    expect(new Set(result.receipt.import?.rowIds).size).toBe(2);
    expect(result.receipt.import?.batchIds).toHaveLength(1);
    expect(owner.store.getSetting(FIRST_SUCCESS_SETTING_KEY)).toMatchObject({
      start: { state: "complete", path: "import", shellId: "blank" },
      steps: {
        realRecord: { state: "complete", source: "import" },
        everyday: { state: "pending" },
      },
    });
    owner.store.close();
  });

  it("returns the same receipt for an exact retry and rejects source or app rebinding", async () => {
    const { driver, owner, install } = await harness();
    const first = await activateImportedAppAtomically(driver, owner.store, importRequest, {
      onPublishedStore: install,
    });
    const again = await activateImportedAppAtomically(driver, owner.store, importRequest, {
      onPublishedStore: install,
    });
    expect(again.receipt).toEqual(first.receipt);
    expect(owner.store.query({ from: "jobs" })).toHaveLength(2);

    await expect(activateImportedAppAtomically(driver, owner.store, {
      ...importRequest, rows: [{ name: "Different" }],
      review: { ...review, sourceRows: 1, acceptedRows: 1 },
    }, { onPublishedStore: install })).rejects.toThrow(/operation.*different source/i);
    await expect(activateImportedAppAtomically(driver, owner.store, {
      ...importRequest, operationId: "other-import-operation", appId: "other-app",
    }, { onPublishedStore: install })).rejects.toThrow(/app.*binding/i);
    expect(owner.store.query({ from: "jobs" })).toHaveLength(2);
    owner.store.close();
  });
});

describe("first-run import receipt Undo", () => {
  it("soft-deletes exactly imported rows and retains the empty table and view", async () => {
    const { driver, owner, install } = await harness();
    const published = await activateImportedAppAtomically(driver, owner.store, importRequest, {
      onPublishedStore: install,
    });
    const undone = undoFirstRunImportAtomically(driver, owner.store, {
      operationId: IMPORT_OPERATION,
      appId: "default",
      expectedRevision: published.receipt.revision,
    });

    expect(undone.undone).toBe(true);
    expect(owner.store.query({ from: "jobs" })).toHaveLength(0);
    expect(owner.store.query({ from: "jobs", includeDeleted: true })).toHaveLength(2);
    expect(owner.store.registrySnapshot().has("jobs")).toBe(true);
    expect(owner.store.livePanels().some(panel => panel.declared_queries
      .some(query => query.from === "jobs"))).toBe(true);
    expect(readFirstRunPublication(owner.store, "default")?.undone).toBe(true);
    expect(owner.store.getSetting(FIRST_SUCCESS_SETTING_KEY)).toMatchObject({
      revision: 3,
      start: { state: "complete", path: "import", shellId: "blank" },
      steps: {
        realRecord: { state: "pending" },
        everyday: { state: "pending" },
      },
    });
    owner.store.close();
  });

  it("changes nothing when any imported after-snapshot conflicts, even across batches", async () => {
    const { driver, owner, install } = await harness();
    const rows = Array.from({ length: 501 }, (_, index) => ({ name: `Row ${index}` }));
    const published = await activateImportedAppAtomically(driver, owner.store, {
      ...importRequest,
      rows,
      review: { ...review, sourceRows: 501, acceptedRows: 501 },
    }, { onPublishedStore: install });
    const firstId = published.receipt.import!.rowIds[0]!;
    owner.store.update("jobs", firstId, { name: "Changed later" });

    expect(() => undoFirstRunImportAtomically(driver, owner.store, {
      operationId: IMPORT_OPERATION,
      appId: "default",
      expectedRevision: published.receipt.revision,
    })).toThrow(/changed after.*undo/i);
    const allRows = owner.store.dumpTable("jobs");
    expect(allRows).toHaveLength(501);
    expect(allRows.every(row => row.deleted_at === null)).toBe(true);
    expect(readFirstRunPublication(owner.store, "default")?.undone).toBe(false);
    owner.store.close();
  });

  it("rejects stale revision, wrong app, and repeat Undo without changing rows", async () => {
    const { driver, owner, install } = await harness();
    const published = await activateImportedAppAtomically(driver, owner.store, importRequest, {
      onPublishedStore: install,
    });
    const request = {
      operationId: IMPORT_OPERATION,
      appId: "default",
      expectedRevision: published.receipt.revision,
    };
    expect(() => undoFirstRunImportAtomically(driver, owner.store, {
      ...request, expectedRevision: request.expectedRevision + 1,
    })).toThrow(/revision/i);
    expect(() => undoFirstRunImportAtomically(driver, owner.store, {
      ...request, appId: "other-app",
    })).toThrow(/app.*binding/i);
    expect(owner.store.query({ from: "jobs" })).toHaveLength(2);

    undoFirstRunImportAtomically(driver, owner.store, request);
    expect(() => undoFirstRunImportAtomically(driver, owner.store, request))
      .toThrow(/already undone/i);
    expect(owner.store.query({ from: "jobs" })).toHaveLength(0);
    owner.store.close();
  });
});
