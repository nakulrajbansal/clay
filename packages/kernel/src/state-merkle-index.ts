import type { DbDriver, SqlRow } from "./db";
import { ClayError } from "./errors";
import {
  stateLeafBucketV1,
  stateLeafHashV1,
  stateBucketRootV1,
  stateRootFromBucketsV1,
  type StateLeafFieldV1,
  type StateLeafV1,
} from "./state-merkle";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TABLES = ["state_digest_buckets", "state_digest_leaves", "state_digest_root"] as const;
const OBJECTS = [...TABLES, "idx_state_digest_leaves_bucket"].sort();
const AUTO_INDEX = "sqlite_autoindex_state_digest_leaves_1";
const DDL = [
  `CREATE TABLE sys.state_digest_leaves(
    leaf_key TEXT NOT NULL PRIMARY KEY,
    bucket INTEGER NOT NULL CHECK(bucket >= 0 AND bucket < 1024),
    leaf_sha256 TEXT NOT NULL
  )`,
  `CREATE TABLE sys.state_digest_buckets(
    bucket INTEGER PRIMARY KEY CHECK(bucket >= 0 AND bucket < 1024),
    root_sha256 TEXT NOT NULL,
    leaf_count INTEGER NOT NULL CHECK(leaf_count >= 0)
  )`,
  `CREATE TABLE sys.state_digest_root(
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    digest_schema INTEGER NOT NULL CHECK(digest_schema = 1),
    state_sha256 TEXT NOT NULL,
    leaf_count INTEGER NOT NULL CHECK(leaf_count >= 0)
  )`,
  "CREATE INDEX sys.idx_state_digest_leaves_bucket ON state_digest_leaves(bucket, leaf_key)",
] as const;

const normalizeDdl = (sql: string): string => sql.replace(/\s+/g, " ").trim();
const EXPECTED_DDL = new Map(DDL.map(ddl => {
  const match = /^CREATE (?:TABLE|INDEX) sys\.([a-z_]+)/.exec(ddl);
  if (!match) throw new Error("invalid trusted Merkle DDL");
  return [match[1]!, normalizeDdl(ddl.replace(/^(CREATE (?:TABLE|INDEX)) sys\./, "$1 "))];
}));

export type StateMerkleSeed = { key: string; fields: StateLeafFieldV1[] };
export type StateMerkleChange = { key: string; fields: StateLeafFieldV1[] | null };
export type StateMerkleSnapshot = {
  schema: 1;
  stateSha256: string;
  leafCount: number;
  bucketRoots: string[];
};
export type StateMerkleApplyResult = {
  changed: boolean;
  stateSha256: string;
  touchedBuckets: number[];
  upserted: number;
  deleted: number;
};

function invalid(message = "target state digest is invalid"): ClayError {
  return new ClayError("E_STATE_DIGEST_INVALID", message);
}

function exactSchema(driver: DbDriver): boolean {
  try {
    const objectPlaceholders = OBJECTS.map(() => "?").join(",");
    const tablePlaceholders = TABLES.map(() => "?").join(",");
    const rows = driver.select(
      `SELECT type, name, tbl_name, sql FROM sys.sqlite_master
       WHERE name IN (${objectPlaceholders}) OR tbl_name IN (${tablePlaceholders})
       ORDER BY name`,
      [...OBJECTS, ...TABLES],
    );
    const expectedNames = [...OBJECTS, AUTO_INDEX].sort();
    if (rows.length !== expectedNames.length
        || !rows.every((row, index) => String(row.name) === expectedNames[index])) return false;
    for (const row of rows) {
      const name = String(row.name);
      if (name === AUTO_INDEX) {
        if (String(row.type) !== "index" || String(row.tbl_name) !== "state_digest_leaves"
            || row.sql !== null) return false;
      } else if (EXPECTED_DDL.get(name) !== normalizeDdl(String(row.sql))) return false;
    }
    const executable = driver.select(
      "SELECT count(*) AS n FROM sys.sqlite_master WHERE type IN ('trigger','view')",
    );
    return executable.length === 1 && Number(executable[0]!.n) === 0;
  } catch {
    return false;
  }
}

function rootRow(driver: DbDriver): { stateSha256: string; leafCount: number } {
  const rows = driver.select(
    "SELECT singleton, digest_schema, state_sha256, leaf_count FROM sys.state_digest_root",
  );
  if (rows.length !== 1 || Number(rows[0]!.singleton) !== 1
      || Number(rows[0]!.digest_schema) !== 1 || !DIGEST.test(String(rows[0]!.state_sha256)))
    throw invalid();
  const leafCount = Number(rows[0]!.leaf_count);
  if (!Number.isSafeInteger(leafCount) || leafCount < 0) throw invalid();
  return { stateSha256: String(rows[0]!.state_sha256), leafCount };
}

function bucketRows(driver: DbDriver): Array<{ bucket: number; rootSha256: string; leafCount: number }> {
  const rows = driver.select(
    "SELECT bucket, root_sha256, leaf_count FROM sys.state_digest_buckets ORDER BY bucket",
  );
  if (rows.length !== 1024) throw invalid();
  return rows.map((row, index) => {
    const bucket = Number(row.bucket);
    const leafCount = Number(row.leaf_count);
    const rootSha256 = String(row.root_sha256);
    if (bucket !== index || !DIGEST.test(rootSha256)
        || !Number.isSafeInteger(leafCount) || leafCount < 0) throw invalid();
    return { bucket, rootSha256, leafCount };
  });
}

function leafFromRow(row: SqlRow): StateLeafV1 & { bucket: number } {
  if (typeof row.leaf_key !== "string") throw invalid("state leaf key is not text");
  const key = row.leaf_key;
  const sha256 = String(row.leaf_sha256);
  const bucket = Number(row.bucket);
  if (!DIGEST.test(sha256) || stateLeafBucketV1(key) !== bucket) throw invalid();
  return { key, sha256, bucket };
}

function leavesInBucket(driver: DbDriver, bucket: number): StateLeafV1[] {
  return driver.select(
    `SELECT leaf_key, bucket, leaf_sha256 FROM sys.state_digest_leaves
     WHERE bucket = ? ORDER BY leaf_key`,
    [bucket],
  ).map(leafFromRow);
}

function verifiedPrestate(driver: DbDriver, touchedBuckets: number[]): {
  root: { stateSha256: string; leafCount: number };
  buckets: Array<{ bucket: number; rootSha256: string; leafCount: number }>;
} {
  const root = rootRow(driver);
  const buckets = bucketRows(driver);
  if (stateRootFromBucketsV1(buckets.map(bucket => bucket.rootSha256)) !== root.stateSha256)
    throw invalid("persisted state root does not match bucket roots");
  const leafCount = buckets.reduce((total, bucket) => total + bucket.leafCount, 0);
  if (!Number.isSafeInteger(leafCount) || leafCount !== root.leafCount)
    throw invalid("persisted state leaf count does not match buckets");
  for (const bucket of touchedBuckets) {
    const leaves = leavesInBucket(driver, bucket);
    if (leaves.length !== buckets[bucket]!.leafCount
        || stateBucketRootV1(bucket, leaves) !== buckets[bucket]!.rootSha256)
      throw invalid("persisted state bucket does not match its leaves");
  }
  return { root, buckets };
}

export class StateMerkleIndex {
  private constructor(private readonly driver: DbDriver) {}

  static createSchema(driver: DbDriver): void {
    try {
      const existing = driver.select(
        `SELECT name FROM sys.sqlite_master
         WHERE name IN ('state_digest_leaves','state_digest_buckets','state_digest_root',
                        'idx_state_digest_leaves_bucket')`,
      );
      if (existing.length > 0) throw invalid("target state digest schema already exists");
      driver.tx(() => { for (const ddl of DDL) driver.exec(ddl); });
      if (!exactSchema(driver)) throw invalid("target state digest schema failed read-back");
    } catch (error) {
      if (error instanceof ClayError && error.code === "E_STATE_DIGEST_INVALID") throw error;
      throw invalid("target state digest schema creation failed");
    }
  }

  static initialize(driver: DbDriver, seeds: StateMerkleSeed[]): StateMerkleIndex {
    if (!exactSchema(driver) || !Array.isArray(seeds)) throw invalid();
    const seen = new Set<string>();
    const grouped = Array.from({ length: 1024 }, () => [] as StateLeafV1[]);
    const leaves: StateLeafV1[] = seeds.map(seed => {
      if (seen.has(seed.key)) throw invalid("duplicate initial state leaf");
      seen.add(seed.key);
      const leaf = { key: seed.key, sha256: stateLeafHashV1(seed.key, seed.fields) };
      grouped[stateLeafBucketV1(leaf.key)]!.push(leaf);
      return leaf;
    });
    const index = new StateMerkleIndex(driver);
    try {
      driver.tx(() => {
        const counts = driver.select(
          `SELECT (SELECT count(*) FROM sys.state_digest_leaves)
                + (SELECT count(*) FROM sys.state_digest_buckets)
                + (SELECT count(*) FROM sys.state_digest_root) AS n`,
        );
        if (counts.length !== 1 || Number(counts[0]!.n) !== 0)
          throw invalid("target state digest is already initialized");
        for (const leaf of leaves) driver.exec(
          "INSERT INTO sys.state_digest_leaves(leaf_key,bucket,leaf_sha256) VALUES (?,?,?)",
          [leaf.key, stateLeafBucketV1(leaf.key), leaf.sha256],
        );
        const roots: string[] = [];
        for (let bucket = 0; bucket < 1024; bucket++) {
          const bucketLeaves = grouped[bucket]!;
          const root = stateBucketRootV1(bucket, bucketLeaves);
          roots.push(root);
          driver.exec(
            "INSERT INTO sys.state_digest_buckets(bucket,root_sha256,leaf_count) VALUES (?,?,?)",
            [bucket, root, bucketLeaves.length],
          );
        }
        driver.exec(
          `INSERT INTO sys.state_digest_root(singleton,digest_schema,state_sha256,leaf_count)
           VALUES (1,1,?,?)`,
          [stateRootFromBucketsV1(roots), leaves.length],
        );
        index.audit();
      });
      return index;
    } catch (error) {
      if (error instanceof ClayError && error.code === "E_STATE_DIGEST_INVALID") throw error;
      throw invalid("target state digest initialization failed");
    }
  }

  static open(driver: DbDriver): StateMerkleIndex {
    if (!exactSchema(driver)) throw invalid("target state digest schema is unavailable");
    const index = new StateMerkleIndex(driver);
    index.audit();
    return index;
  }

  audit(): StateMerkleSnapshot {
    if (!exactSchema(this.driver)) throw invalid("target state digest schema is unavailable");
    try {
      const root = rootRow(this.driver);
      const buckets = bucketRows(this.driver);
      const grouped = Array.from({ length: 1024 }, () => [] as StateLeafV1[]);
      const seen = new Set<string>();
      for (const row of this.driver.select(
        "SELECT leaf_key, bucket, leaf_sha256 FROM sys.state_digest_leaves ORDER BY leaf_key",
      )) {
        const leaf = leafFromRow(row);
        if (seen.has(leaf.key)) throw invalid();
        seen.add(leaf.key);
        grouped[leaf.bucket]!.push(leaf);
      }
      if (seen.size !== root.leafCount) throw invalid();
      for (let bucket = 0; bucket < 1024; bucket++) {
        if (grouped[bucket]!.length !== buckets[bucket]!.leafCount
            || stateBucketRootV1(bucket, grouped[bucket]!) !== buckets[bucket]!.rootSha256)
          throw invalid();
      }
      const roots = buckets.map(bucket => bucket.rootSha256);
      if (stateRootFromBucketsV1(roots) !== root.stateSha256) throw invalid();
      return { schema: 1, stateSha256: root.stateSha256, leafCount: root.leafCount, bucketRoots: roots };
    } catch (error) {
      if (error instanceof ClayError && error.code === "E_STATE_DIGEST_INVALID") throw error;
      throw invalid();
    }
  }

  apply(changes: StateMerkleChange[]): StateMerkleApplyResult {
    if (!exactSchema(this.driver) || !Array.isArray(changes)) throw invalid();
    const seen = new Set<string>();
    const prepared: Array<{ key: string; bucket: number; sha256: string | null }> = [];
    for (const change of changes) {
      if (seen.has(change.key)) throw invalid("duplicate state change key");
      seen.add(change.key);
      let bucket: number;
      let sha256: string | null;
      try {
        bucket = stateLeafBucketV1(change.key);
        sha256 = change.fields === null ? null : stateLeafHashV1(change.key, change.fields);
      } catch {
        throw invalid("malformed state digest change");
      }
      prepared.push({ key: change.key, bucket, sha256 });
    }
    const requestedBuckets = [...new Set(prepared.map(change => change.bucket))].sort((a, b) => a - b);

    try {
      return this.driver.tx(() => {
        const { root } = verifiedPrestate(this.driver, requestedBuckets);
        const planned: Array<{ key: string; bucket: number; sha256: string | null; exists: boolean }> = [];
        for (const change of prepared) {
          const rows = this.driver.select(
            `SELECT leaf_key, bucket, leaf_sha256 FROM sys.state_digest_leaves
             WHERE leaf_key = ?`,
            [change.key],
          );
          if (rows.length > 1) throw invalid();
          const priorLeaf = rows.length === 1 ? leafFromRow(rows[0]!) : null;
          if (priorLeaf && (priorLeaf.key !== change.key || priorLeaf.bucket !== change.bucket))
            throw invalid();
          const prior = priorLeaf?.sha256 ?? null;
          if (prior === change.sha256 || (prior === null && change.sha256 === null)) continue;
          planned.push({ ...change, exists: prior !== null });
        }
        if (planned.length === 0) return {
          changed: false,
          stateSha256: root.stateSha256,
          touchedBuckets: [],
          upserted: 0,
          deleted: 0,
        };

        let upserted = 0;
        let deleted = 0;
        for (const change of planned) {
          if (change.sha256 === null) {
            this.driver.exec("DELETE FROM sys.state_digest_leaves WHERE leaf_key = ?", [change.key]);
            deleted++;
          } else {
            this.driver.exec(
              `INSERT INTO sys.state_digest_leaves(leaf_key,bucket,leaf_sha256) VALUES (?,?,?)
               ON CONFLICT(leaf_key) DO UPDATE SET bucket=excluded.bucket, leaf_sha256=excluded.leaf_sha256`,
              [change.key, change.bucket, change.sha256],
            );
            upserted++;
          }
          const readBack = this.driver.select(
            `SELECT leaf_key, bucket, leaf_sha256 FROM sys.state_digest_leaves
             WHERE leaf_key = ?`,
            [change.key],
          );
          if (change.sha256 === null) {
            if (readBack.length !== 0) throw invalid("state leaf delete failed read-back");
          } else {
            if (readBack.length !== 1) throw invalid("state leaf upsert failed read-back");
            const leaf = leafFromRow(readBack[0]!);
            if (leaf.key !== change.key || leaf.bucket !== change.bucket
                || leaf.sha256 !== change.sha256)
              throw invalid("state leaf upsert failed read-back");
          }
        }
        const touchedBuckets = [...new Set(planned.map(change => change.bucket))].sort((a, b) => a - b);
        for (const bucket of touchedBuckets) {
          const leaves = leavesInBucket(this.driver, bucket);
          const expectedRoot = stateBucketRootV1(bucket, leaves);
          this.driver.exec(
            "UPDATE sys.state_digest_buckets SET root_sha256 = ?, leaf_count = ? WHERE bucket = ?",
            [expectedRoot, leaves.length, bucket],
          );
          const published = this.driver.select(
            "SELECT root_sha256, leaf_count FROM sys.state_digest_buckets WHERE bucket = ?",
            [bucket],
          );
          if (published.length !== 1 || String(published[0]!.root_sha256) !== expectedRoot
              || Number(published[0]!.leaf_count) !== leaves.length) throw invalid();
        }
        const buckets = bucketRows(this.driver);
        const stateSha256 = stateRootFromBucketsV1(buckets.map(bucket => bucket.rootSha256));
        const leafCount = root.leafCount + upserted
          - planned.filter(change => change.exists && change.sha256 !== null).length - deleted;
        if (!Number.isSafeInteger(leafCount) || leafCount < 0) throw invalid();
        const bucketLeafCount = buckets.reduce((total, bucket) => total + bucket.leafCount, 0);
        if (!Number.isSafeInteger(bucketLeafCount) || bucketLeafCount !== leafCount) throw invalid();
        this.driver.exec(
          "UPDATE sys.state_digest_root SET state_sha256 = ?, leaf_count = ? WHERE singleton = 1",
          [stateSha256, leafCount],
        );
        const readBack = rootRow(this.driver);
        if (readBack.stateSha256 !== stateSha256 || readBack.leafCount !== leafCount) throw invalid();
        return { changed: true, stateSha256, touchedBuckets, upserted, deleted };
      });
    } catch (error) {
      if (error instanceof ClayError && error.code === "E_STATE_DIGEST_INVALID") throw error;
      throw invalid("target state digest update failed");
    }
  }
}
