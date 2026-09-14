import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { build } from "vite";
import { describe, expect, it } from "vitest";
import { createSharedSqliteRuntime, splitSqliteDistribution } from "../config/shared-sqlite-runtime.mjs";

const require = createRequire(new URL("../../kernel/package.json", import.meta.url));
const dist = join(dirname(require.resolve("@sqlite.org/sqlite-wasm/package.json")), "dist");
const index = readFileSync(join(dist, "index.mjs"), "utf8");
const worker = readFileSync(join(dist, "sqlite3-worker1.mjs"), "utf8");

describe("shared pinned SQLite initializer", () => {
  it("moves the intact public initializer, retaining both entry APIs and failing closed on any upstream drift", () => {
    const split = splitSqliteDistribution(index, worker);
    expect(index.includes(split.initializerBody)).toBe(true);
    expect(split.initializerBody.includes("xCheckReservedLock")).toBe(true);
    expect(split.indexEntry.includes("sqlite3Worker1Promiser")).toBe(true);
    expect(split.workerEntry.includes("sqlite3.initWorker1API()")).toBe(true);
    expect(split.workerEntry.includes("async function sqlite3InitModule")).toBe(false);
    expect(() => splitSqliteDistribution(index + "\n", worker)).toThrow(/pinned SQLite/);
    expect(() => splitSqliteDistribution(index, worker.replace("initWorker1API()", "differentAPI()")))
      .toThrow(/pinned SQLite/);
  });

  it("executes the production-extracted initializer with the real pinned WASM and no network", async () => {
    const plugin = createSharedSqliteRuntime({ distributionRoot: dist });
    const result = await build({ configFile: false, logLevel: "silent", plugins: [plugin],
      build: { write: false, minify: "terser", target: "es2022",
        lib: { entry: join(dist, "clay-sqlite-initializer.mjs"), name: "OwnedSqlite", formats: ["iife"] } } });
    const chunk = (Array.isArray(result) ? result[0] : result).output.find(item => item.type === "chunk");
    const network = [];
    // Keep intrinsic constructors/WASM in the same realm: SQLite intentionally
    // checks exported functions/typed arrays against that realm's constructors.
    const context = vm.createContext({ URL, URLSearchParams, TextEncoder, TextDecoder, performance,
      setTimeout, clearTimeout, console: { log() {}, warn() {}, error() {}, debug() {} },
      location: { href: "https://owned.invalid/sqlite.js" },
      document: { currentScript: { src: "https://owned.invalid/sqlite.js", tagName: "SCRIPT" },
        baseURI: "https://owned.invalid/" },
      fetch: url => { network.push(url); throw new Error("network is forbidden in this fixture"); } });
    vm.runInContext(chunk.code, context);
    const sqlite = await context.OwnedSqlite({ wasmBinary: readFileSync(join(dist, "sqlite3.wasm")) });
    const db = new sqlite.oo1.DB(":memory:", "c");
    try {
      db.exec("CREATE TABLE owned(value TEXT NOT NULL); INSERT INTO owned VALUES ('original');");
      db.exec("BEGIN; UPDATE owned SET value='uncommitted'; ROLLBACK;");
      expect(db.selectValue("SELECT value FROM owned")).toBe("original");
      expect(sqlite.version.libVersion).toBe("3.53.0");
      expect(typeof sqlite.initWorker1API).toBe("function");
      expect(typeof sqlite.installOpfsSAHPoolVfs).toBe("function");
      expect(network).toEqual([]);
    } finally { db.close(); }

    // Exercise the unchanged support-worker message API in this owned VM. This
    // is memory/RPC coverage, not a physical OPFS or browser certificate.
    const messages = [];
    context.postMessage = message => messages.push(message);
    vm.runInContext("globalThis.WorkerGlobalScope = function OwnedWorkerScope() {};", context);
    sqlite.initWorker1API();
    expect(messages[0]).toMatchObject({ type: "sqlite3-api", result: "worker1-ready" });
    const call = async (type, messageId, args, dbId) => {
      await context.onmessage({ data: { type, messageId, args, dbId } });
      return messages.find(message => message.messageId === messageId);
    };
    const opened = await call("open", "owned-open", { filename: ":memory:" });
    expect(opened.type).toBe("open");
    const dbId = opened.result.dbId;
    try {
      const queried = await call("exec", "owned-query", {
        sql: "CREATE TABLE owned(value INTEGER); INSERT INTO owned VALUES (17); SELECT value FROM owned;",
        rowMode: "array", resultRows: [],
      }, dbId);
      expect(queried.type).toBe("exec");
      expect(queried.result.resultRows).toEqual([[17]]);
      expect((await call("exec", "owned-fault", { sql: "SELECT missing FROM absent" }, dbId)).type).toBe("error");
    } finally {
      expect((await call("close", "owned-close", {}, dbId)).type).toBe("close");
    }
  });
});
