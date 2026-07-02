// WEEK 1 EXIT TEST (doc 09): scripted sequence — create table, insert rows,
// add computed column, roll back, roll forward — data intact (bit-equal).
import { describe, expect, it } from "vitest";
import { ClayError, registryToJson } from "../src/index";
import { HEALTH_COMPUTED, seededStore } from "./helpers";

describe("W1 spine", () => {
  it("create / insert / computed / rollback / rollforward, data bit-equal", async () => {
    const store = await seededStore();          // v1: create projects + 3 rows
    expect(store.headVersion()).toBe(1);

    const dump0 = JSON.stringify(store.dumpTable("projects"));
    const reg0 = registryToJson(store.registrySnapshot());

    // v2: computed health_score
    const v2 = store.commit({
      intent: "health score",
      summary: "Adds a health score to each project.",
      migration: HEALTH_COMPUTED,
    });
    expect(v2).toBe(2);

    // computed values are projected at query time (no physical column)
    const scores = store.query({
      from: "projects", select: ["name", "health_score"],
      orderBy: [{ field: "name", dir: "asc" }],
    });
    expect(scores).toEqual([
      { name: "Apollo", health_score: 95 },
      { name: "Borealis", health_score: 65 },
      { name: "Cygnus", health_score: 35 },
    ]);
    const flagged = store.query({
      from: "projects",
      where: [{ field: "health_score", op: "lt", value: 60 }],
      orderBy: [{ field: "health_score", dir: "asc" }],
    });
    expect(flagged.map(r => r.name)).toEqual(["Cygnus"]);

    // physical storage unchanged by the computed column (doc 04 §2)
    expect(JSON.stringify(store.dumpTable("projects"))).toBe(dump0);

    // roll back: schema at v1, data bit-equal
    store.rollbackTo(1);
    expect(store.currentVersion()).toBe(1);
    expect(store.headVersion()).toBe(2);
    expect(registryToJson(store.registrySnapshot())).toBe(reg0);
    expect(JSON.stringify(store.dumpTable("projects"))).toBe(dump0);
    expect(() => store.query({ from: "projects", select: ["health_score"] }))
      .toThrowError(ClayError);

    // commits are blocked while scrubbed back (doc 05 §6 spirit)
    expect(() => store.commit({ intent: "x", summary: "X.", migration: null }))
      .toThrowError(ClayError);

    // roll forward: computed returns, data still bit-equal
    store.rollForwardTo(2);
    expect(store.currentVersion()).toBe(2);
    expect(JSON.stringify(store.dumpTable("projects"))).toBe(dump0);
    expect(store.query({
      from: "projects",
      where: [{ field: "health_score", op: "lt", value: 60 }],
    }).map(r => r.name)).toEqual(["Cygnus"]);

    store.close();
  });

  it("truncation discards the chain above K (ADR-007)", async () => {
    const store = await seededStore();
    store.commit({ intent: "health", summary: "Health.", migration: HEALTH_COMPUTED });
    store.rollbackTo(1, { truncate: true });
    expect(store.headVersion()).toBe(1);
    expect(store.currentVersion()).toBe(1);
    expect(() => store.getEntry(2)).toThrowError(ClayError);
    // and the store accepts new commits again
    const v = store.commit({ intent: "again", summary: "Health again.", migration: HEALTH_COMPUTED });
    expect(v).toBe(2);
    store.close();
  });

  it("soft delete excludes rows from queries but keeps them in storage", async () => {
    const store = await seededStore();
    const id = String(store.query({ from: "projects", where: [{ field: "name", op: "eq", value: "Apollo" }] })[0]!.id);
    store.softDelete("projects", id);
    expect(store.query({ from: "projects" })).toHaveLength(2);
    expect(store.query({ from: "projects", includeDeleted: true })).toHaveLength(3);
    expect(store.dumpTable("projects")).toHaveLength(3);
    store.close();
  });
});
