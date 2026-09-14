import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(new URL("../../kernel/package.json", import.meta.url));
const defaultRoot = join(dirname(require.resolve("@sqlite.org/sqlite-wasm/package.json")), "dist");
const INITIALIZER = "clay-sqlite-initializer.mjs";
const INDEX_HASH = "f80870f0fa03a39a3338d17ed3fbea04808d344c88e724d90d5f37b9b7b83154";
const WORKER_HASH = "060ec0274c112339c553e38c591d9e1220e67b738113d8868862e99e400bee2f";
const sha256 = source => createHash("sha256").update(source).digest("hex");

/** Packaging only: the pinned package prebundles SQLite twice. Keep its public
 * bundler-friendly initializer byte-for-byte, including licenses, initialization,
 * VFS, journal/lock behavior and error paths. Both entry points import that same
 * module. An SDK change requires an explicit re-audit, never a best-effort patch. */
export function splitSqliteDistribution(index, worker) {
  if (sha256(index) !== INDEX_HASH || sha256(worker) !== WORKER_HASH)
    throw new Error("shared runtime requires the audited pinned SQLite 3.53.0-build1 distribution");
  const start = index.indexOf("//#region src/bin/sqlite3-bundler-friendly.mjs");
  const end = index.lastIndexOf("export { sqlite3_bundler_friendly_default as default,");
  const workerStart = worker.indexOf("//#region src/bin/sqlite3-worker1.mjs");
  if (start < 0 || end <= start || workerStart < 0)
    throw new Error("pinned SQLite entry boundaries are missing");
  const initializerBody = index.slice(start, end);
  return {
    initializerBody,
    initializer: initializerBody + "export { sqlite3_bundler_friendly_default as default };\n",
    indexEntry: index.slice(0, start)
      + `import sqlite3_bundler_friendly_default from './${INITIALIZER}';\n` + index.slice(end),
    workerEntry: `import sqlite3InitModule from './${INITIALIZER}';\n` + worker.slice(workerStart),
  };
}

export function createSharedSqliteRuntime({ distributionRoot = defaultRoot } = {}) {
  const normalize = path => path.replaceAll("\\", "/");
  const root = normalize(distributionRoot);
  const initializerId = `${root}/${INITIALIZER}`;
  let split;
  const read = () => split ??= splitSqliteDistribution(
    readFileSync(join(distributionRoot, "index.mjs"), "utf8"),
    readFileSync(join(distributionRoot, "sqlite3-worker1.mjs"), "utf8"),
  );
  return {
    name: "clay-shared-pinned-sqlite",
    apply: "build",
    enforce: "pre",
    resolveId(id, importer) {
      if (normalize(id) === initializerId || (id === `./${INITIALIZER}`
          && importer && normalize(dirname(importer)) === root)) return initializerId;
    },
    load(id) {
      const normalized = normalize(id);
      if (normalized === initializerId) return read().initializer;
      if (normalized === `${root}/index.mjs`) return read().indexEntry;
      if (normalized === `${root}/sqlite3-worker1.mjs`) return read().workerEntry;
    },
  };
}
