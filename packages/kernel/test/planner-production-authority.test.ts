import { describe, expect, it } from "vitest";
import {
  ClayStore, MutationPipeline, deriveInverse, openMemoryDriver,
  type DbDriver, type ForwardOpT, type Planner, type PlannerResult, type Registry,
} from "../src/index";
import {
  ProductionStoreAuthority,
  armProductionAuthorityFailureForTest,
} from "../src/production-authority";

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

async function fixture(): Promise<{
  authority: ProductionStoreAuthority;
  driver: DbDriver;
}> {
  const driver = await openMemoryDriver();
  driver.exec("ATTACH DATABASE ':memory:' AS catalog");
  const raw = ClayStore.fromDriver(driver);
  const operations: ForwardOpT[] = [{
    op: "create_table", table: "projects",
    columns: [{ name: "name", type: "text", required: true }],
  }];
  raw.commit({
    intent: "seed", summary: "Seed projects.",
    migration: {
      operations,
      inverse: deriveInverse(operations, raw.registrySnapshot()),
    },
  });
  raw.insert("projects", { name: "Alpha" });
  const authority = ProductionStoreAuthority.adoptLegacy(driver, {
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
  });
  return { authority, driver };
}

function addStatusPlan(registry: Registry): unknown {
  const operations: ForwardOpT[] = [{
    op: "add_column", table: "projects",
    column: { name: "status", type: "enum", required: false, values: ["open", "done"] },
  }];
  return {
    api: 1,
    summary: "Adds project status.",
    user_facing_diff: [{ kind: "add_status", detail: "Status on projects" }],
    clarifying_question: null,
    assumptions: [],
    migration: { operations, inverse: deriveInverse(operations, registry) },
    panels: [],
    remove_panels: [],
    confidence: 0.9,
  };
}

function twoProjectRelationsPlan(registry: Registry): unknown {
  const relation = {
    target_table: "projects",
    cardinality: "one" as const,
    unique_targets: false,
    display_field: "name",
  };
  const operations: ForwardOpT[] = [
    {
      op: "add_column",
      table: "projects",
      column: { name: "primary_project", type: "relation", required: false, relation },
    },
    {
      op: "add_column",
      table: "projects",
      column: { name: "secondary_project", type: "relation", required: false, relation },
    },
  ];
  return {
    api: 1,
    summary: "Adds primary and secondary project relationships.",
    user_facing_diff: [],
    clarifying_question: null,
    assumptions: [],
    migration: { operations, inverse: deriveInverse(operations, registry) },
    panels: [],
    remove_panels: [],
    confidence: 0.9,
  };
}

class OnePlan implements Planner {
  constructor(private readonly plan: unknown) {}
  async requestPlan(): Promise<PlannerResult> {
    return { ok: true, plan: this.plan, raw: JSON.stringify(this.plan) };
  }
  async requestRepair(): Promise<PlannerResult> {
    throw new Error("repair not expected");
  }
}

describe("planner production authority", () => {
  it("keeps one prepared command through canonical authority publication", async () => {
    const { authority, driver } = await fixture();
    try {
      const plannerAuthority = authority.plannerMutations();
      expect(Object.isFrozen(plannerAuthority)).toBe(true);
      expect(Reflect.ownKeys(plannerAuthority).sort()).toEqual([
        "assertPlanningBase", "beginAttempt", "capturePlanningBase", "discard",
        "finalizeAttempt", "keep", "preparePreview",
      ].sort());
      for (const forbidden of ["store", "driver", "snapshot", "commit", "finishAttempt"])
        expect(Reflect.get(plannerAuthority, forbidden)).toBeUndefined();

      const result = await new MutationPipeline(
        plannerAuthority,
        new OnePlan(addStatusPlan(authority.readStore().registrySnapshot())),
      ).run("add status to projects");
      if (result.status !== "preview") throw new Error(JSON.stringify(result));
      const shadowField = result.preview.shadow.semanticSchemaTrace().fields
        .find(field => field.fieldName === "status");
      const before = authority.inspectAuthority();
      const requestId = `req_${"k".repeat(26)}`;

      await expect(plannerAuthority.keep(requestId, result.preview.command))
        .resolves.toBe(2);
      result.preview.shadow.close();

      expect(authority.readStore().headVersion()).toBe(2);
      expect(authority.readStore().attemptStats()).toMatchObject({ kept: 1 });
      expect(authority.readStore().semanticSchemaTrace().fields
        .find(field => field.fieldName === "status")?.fieldId).toBe(shadowField?.fieldId);
      const after = authority.inspectAuthority();
      expect(BigInt(after.target.protectionRevision))
        .toBe(BigInt(before.target.protectionRevision) + 1n);
      expect(after.catalog.entries[0]).toMatchObject({
        currentProtectionRevision: after.target.protectionRevision,
        stateSha256: after.target.stateSha256,
      });
      expect(driver.select(
        "SELECT state FROM sys.production_request_receipts WHERE request_id=?",
        [requestId],
      )).toEqual([{ state: "committed" }]);
      expect(driver.select(
        "SELECT state FROM catalog.production_request_receipts WHERE request_id=?",
        [requestId],
      )).toEqual([{ state: "committed" }]);

      await expect(plannerAuthority.keep(requestId, result.preview.command))
        .resolves.toBe(2);
      expect(authority.readStore().headVersion()).toBe(2);
      expect(authority.readStore().attemptStats()).toMatchObject({ kept: 1 });
      expect(authority.inspectAuthority().target).toEqual(after.target);
    } finally {
      authority.close();
    }
  });

  it("rolls back canonical commit and attempt finalization when publication fails", async () => {
    const { authority, driver } = await fixture();
    try {
      const plannerAuthority = authority.plannerMutations();
      const result = await new MutationPipeline(
        plannerAuthority,
        new OnePlan(addStatusPlan(authority.readStore().registrySnapshot())),
      ).run("add status to projects");
      if (result.status !== "preview") throw new Error(JSON.stringify(result));
      const before = authority.inspectAuthority();
      const requestId = `req_${"z".repeat(26)}`;
      armProductionAuthorityFailureForTest(authority, "after_live_mutation");

      await expect(plannerAuthority.keep(requestId, result.preview.command))
        .rejects.toThrow(/after live mutation/i);

      expect(authority.readStore().headVersion()).toBe(1);
      expect(authority.readStore().attemptStats()).toMatchObject({ kept: 0 });
      expect(() => authority.readStore().query({ from: "projects", select: ["status"] }))
        .toThrow();
      expect(authority.inspectAuthority().target).toEqual(before.target);
      expect(driver.select(
        "SELECT state FROM sys.production_request_receipts WHERE request_id=?", [requestId],
      )).toEqual([{ state: "failed" }]);
      await plannerAuthority.discard(`req_${"y".repeat(26)}`, result.preview.command);
      result.preview.shadow.close();
    } finally {
      authority.close();
    }
  });

  it("serializes concurrent Keep decisions so only one can commit", async () => {
    const { authority, driver } = await fixture();
    try {
      const plannerAuthority = authority.plannerMutations();
      const result = await new MutationPipeline(
        plannerAuthority,
        new OnePlan(addStatusPlan(authority.readStore().registrySnapshot())),
      ).run("add status to projects");
      if (result.status !== "preview") throw new Error(JSON.stringify(result));
      const firstId = `req_${"f".repeat(26)}`;
      const secondId = `req_${"g".repeat(26)}`;

      const decisions = await Promise.allSettled([
        plannerAuthority.keep(firstId, result.preview.command),
        plannerAuthority.keep(secondId, result.preview.command),
      ]);

      expect(decisions.filter(decision => decision.status === "fulfilled")).toHaveLength(1);
      expect(decisions.filter(decision => decision.status === "rejected")).toHaveLength(1);
      expect(authority.readStore().headVersion()).toBe(2);
      expect(authority.readStore().attemptStats()).toMatchObject({ kept: 1 });
      expect(driver.select(
        "SELECT state FROM sys.production_request_receipts WHERE request_id IN (?, ?) ORDER BY request_id",
        [firstId, secondId],
      )).toEqual([{ state: "committed" }]);
      result.preview.shadow.close();
    } finally {
      authority.close();
    }
  });

  it("durably discards through the supplied authority request before separate shadow closure", async () => {
    const { authority, driver } = await fixture();
    try {
      const plannerAuthority = authority.plannerMutations();
      const result = await new MutationPipeline(
        plannerAuthority,
        new OnePlan(addStatusPlan(authority.readStore().registrySnapshot())),
      ).run("add status to projects");
      if (result.status !== "preview") throw new Error(JSON.stringify(result));
      const before = authority.inspectAuthority();
      const requestId = `req_${"d".repeat(26)}`;

      await plannerAuthority.discard(requestId, result.preview.command);

      expect(authority.readStore().headVersion()).toBe(1);
      expect(authority.readStore().attemptStats()).toMatchObject({ discarded: 1 });
      expect(result.preview.shadow.query({ from: "projects" })).toHaveLength(1);
      const after = authority.inspectAuthority();
      expect(BigInt(after.target.protectionRevision))
        .toBe(BigInt(before.target.protectionRevision) + 1n);
      expect(driver.select(
        "SELECT state FROM sys.production_request_receipts WHERE request_id=?", [requestId],
      )).toEqual([{ state: "committed" }]);

      result.preview.shadow.close();
      expect(() => result.preview.shadow.query({ from: "projects" }))
        .toThrow(/shadow is closed/i);
    } finally {
      authority.close();
    }
  });

  it("keeps distinct prepared identities for relation fields with the same target", async () => {
    const { authority } = await fixture();
    try {
      const plannerAuthority = authority.plannerMutations();
      const result = await new MutationPipeline(
        plannerAuthority,
        new OnePlan(twoProjectRelationsPlan(authority.readStore().registrySnapshot())),
      ).run("add primary and secondary project relations");
      if (result.status !== "preview") throw new Error(JSON.stringify(result));
      const shadowReferences = result.preview.shadow.semanticSchemaTrace().relationships
        .filter(relationship => relationship.kind === "references")
        .map(relationship => ({
          via: relationship.via,
          relationshipId: relationship.relationshipId,
        }))
        .sort((left, right) => String(left.via).localeCompare(String(right.via)));
      expect(shadowReferences).toHaveLength(2);
      expect(new Set(shadowReferences.map(item => item.relationshipId)).size).toBe(2);

      await plannerAuthority.keep(`req_${"q".repeat(26)}`, result.preview.command);
      const liveReferences = authority.readStore().semanticSchemaTrace().relationships
        .filter(relationship => relationship.kind === "references")
        .map(relationship => ({
          via: relationship.via,
          relationshipId: relationship.relationshipId,
        }))
        .sort((left, right) => String(left.via).localeCompare(String(right.via)));
      expect(liveReferences).toEqual(shadowReferences);
      expect(new Set(liveReferences.map(item => item.relationshipId)).size).toBe(2);
      result.preview.shadow.close();
    } finally {
      authority.close();
    }
  });

  it("binds a durable Discard receipt to the exact prepared command", async () => {
    const { authority } = await fixture();
    try {
      const plannerAuthority = authority.plannerMutations();
      const result = await new MutationPipeline(
        plannerAuthority,
        new OnePlan(addStatusPlan(authority.readStore().registrySnapshot())),
      ).run("add status to projects");
      if (result.status !== "preview") throw new Error(JSON.stringify(result));
      const requestId = `req_${"r".repeat(26)}`;

      await expect(plannerAuthority.discard(requestId, result.preview.command))
        .resolves.toBeUndefined();
      await expect(plannerAuthority.discard(requestId, result.preview.command))
        .resolves.toBeUndefined();
      const substituted = {
        ...result.preview.command,
        intent: "substituted intent for the same attempt",
      };
      await expect(plannerAuthority.discard(requestId, substituted))
        .rejects.toMatchObject({ code: "E_TARGET_AUTHORITY_INVALID" });
      expect(authority.readStore().attemptStats()).toMatchObject({ discarded: 1 });
      result.preview.shadow.close();
    } finally {
      authority.close();
    }
  });

  it("rejects prepared-command accessors without invoking them", async () => {
    const { authority } = await fixture();
    let getterCalls = 0;
    const payload = {
      schema: 1,
      attemptId: "018f0000-0000-7000-8000-000000000001",
      intent: "add status",
      plan: {},
      semanticAssignments: {},
    };
    Object.defineProperty(payload, "base", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return { version: 1, shapeSha256: `sha256:${"0".repeat(64)}` };
      },
    });
    try {
      expect(() => authority.executeMutation({
        requestId: `req_${"x".repeat(26)}`,
        route: "planner.keep",
        payload,
      })).toThrow();
      expect(getterCalls).toBe(0);
      expect(authority.readStore().headVersion()).toBe(1);
    } finally {
      authority.close();
    }
  });

  it.each(["planner.keep", "planner.discard"] as const)(
    "rejects a transparent Proxy at the %s coordinator boundary before reservation",
    async route => {
      const { authority } = await fixture();
      const plannerAuthority = authority.plannerMutations();
      let shadow: { close(): void } | undefined;
      try {
        const result = await new MutationPipeline(
          plannerAuthority,
          new OnePlan(addStatusPlan(authority.readStore().registrySnapshot())),
        ).run("add status to projects");
        if (result.status !== "preview") throw new Error(JSON.stringify(result));
        shadow = result.preview.shadow;
        const before = authority.inspectAuthority();

        await expect(Promise.resolve().then(() => authority.executeMutation({
          requestId: `req_${(route === "planner.keep" ? "u" : "v").repeat(26)}`,
          route,
          payload: new Proxy(result.preview.command, {}),
        }))).rejects.toMatchObject({ code: "E_TARGET_AUTHORITY_INVALID" });

        const after = authority.inspectAuthority();
        expect(after.targetReservations).toEqual(before.targetReservations);
        expect(after.catalogReservations).toEqual(before.catalogReservations);
      } finally {
        shadow?.close();
        authority.close();
      }
    },
  );
});
