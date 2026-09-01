import { describe, expect, it } from "vitest";
import { ClayStore, deriveInverse, type ForwardOpT } from "../src/index";

function commitOps(store: ClayStore, operations: ForwardOpT[], summary = "shape"): number {
  return store.commit({
    intent: summary,
    summary,
    migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) },
  });
}

async function baseStore(): Promise<ClayStore> {
  const store = await ClayStore.openMemory();
  commitOps(store, [{
    op: "create_table",
    table: "tasks",
    columns: [{ name: "title", type: "text", required: true }],
  }], "base");
  return store;
}

describe("Principle 1: data outlives interface rollback", () => {
  it("preserves values in a post-version column across rollback and roll-forward", async () => {
    const store = await baseStore();
    try {
      const row = store.insert("tasks", { title: "Keep me" });
      commitOps(store, [{
        op: "add_column", table: "tasks",
        column: { name: "note", type: "text", required: false },
      }], "add note");
      store.update("tasks", String(row.id), { note: "irreplaceable" });

      store.rollbackTo(1);
      expect(store.registrySnapshot().get("tasks")!.columns.some(c => c.name === "note")).toBe(false);
      store.rollForwardTo(2);

      expect(store.query({ from: "tasks" })[0]!.note).toBe("irreplaceable");
    } finally { store.close(); }
  });

  it("preserves rows in a post-version table across rollback and roll-forward", async () => {
    const store = await baseStore();
    try {
      commitOps(store, [{
        op: "create_table", table: "journal",
        columns: [{ name: "entry", type: "text", required: true },
          { name: "secret", type: "text", required: false }],
      }], "add journal");
      store.insert("journal", { entry: "Never delete this", secret: "kept but hidden" });

      store.rollbackTo(1);
      expect(store.registrySnapshot().has("journal")).toBe(false);
      store.rollForwardTo(2);

      expect(store.query({ from: "journal" }).map(row => row.entry)).toEqual(["Never delete this"]);
      store.rollbackTo(1,{truncate:true});
      commitOps(store,[{op:"create_table",table:"journal",columns:[{name:"entry",type:"text",required:true}]}],"subset");
      expect(store.query({from:"journal"})[0]).not.toHaveProperty("secret");
    } finally { store.close(); }
  });

  it("backfills only rows missing a value when a preserved column returns", async () => {
    const store = await baseStore();
    try {
      const old = store.insert("tasks", { title: "Old" });
      commitOps(store, [
        { op: "add_column", table: "tasks",
          column: { name: "score", type: "number", required: false } },
        { op: "backfill", table: "tasks", column: "score", value: 7 },
      ], "add score");
      store.update("tasks", String(old.id), { score: 42 });
      store.insert("tasks", { title: "Explicit null" });

      store.rollbackTo(1, { truncate: true });
      store.insert("tasks", { title: "Created while score was hidden" });
      const restored: ForwardOpT[] = [];
      restored.push({op:"add_column",table:"tasks",column:{name:"score",type:"number",required:false}});
      restored.push({op:"rename_column",table:"tasks",from:"score",to:"rating"});
      restored.push({op:"backfill",table:"tasks",column:"rating",value:7});
      restored.push({op:"backfill",table:"tasks",column:"rating",value:8});
      commitOps(store, restored);

      const byTitle = Object.fromEntries(store.query({ from: "tasks" }).map(row => [row.title, row.rating]));
      expect(byTitle).toEqual({
        Old: 42,
        "Explicit null": null,
        "Created while score was hidden": 8,
      });
    } finally { store.close(); }
  });

  it("reactivates preserved data when the same compatible shape is re-added after truncation", async () => {
    const store = await baseStore();
    try {
      const row = store.insert("tasks", { title: "Old" });
      const addScore: ForwardOpT[] = [
        { op: "add_column", table: "tasks",
          column: { name: "score", type: "number", required: false } },
        { op: "backfill", table: "tasks", column: "score", value: 7 },
      ];
      commitOps(store, addScore, "add score");
      store.update("tasks", String(row.id), { score: 42 });
      store.rollbackTo(1, { truncate: true });
      store.insert("tasks", { title: "New" });

      commitOps(store, addScore, "bring score back");

      const byTitle = Object.fromEntries(store.query({ from: "tasks" }).map(item => [item.title, item.score]));
      expect(byTitle).toEqual({ Old: 42, New: 7 });
    } finally { store.close(); }
  });
  it("reserves renamed-away names",async()=>{const s=await baseStore();try{commitOps(s,[{op:"rename_column",table:"tasks",from:"title",to:"name"}],"rename");
expect(()=>commitOps(s,[{op:"add_column",table:"tasks",column:{name:"title",type:"text",required:false}}],"reuse")).toThrow(/reserved/);
}finally{s.close();}});

  it("rejects a renamed-away name as a later rename target", async () => {
    const store = await ClayStore.openMemory();
    try {
      commitOps(store, [{
        op: "create_table", table: "t", columns: [
          { name: "a", type: "text", required: false },
          { name: "d", type: "text", required: false },
        ],
      }]);
      commitOps(store, [{ op: "rename_column", table: "t", from: "a", to: "b" }]);

      expect(() => commitOps(store, [
        { op: "rename_column", table: "t", from: "d", to: "a" },
      ])).toThrow(/reserved/);
    } finally { store.close(); }
  });
});
