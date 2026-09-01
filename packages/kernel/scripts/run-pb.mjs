// Run the L3 property gate without triggering Vitest 3.2.x's independent
// 60-second worker RPC timeout. Each process gets a distinct fast-check seed,
// so PB_RUNS remains the total number of cases exercised per property.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Keep ample headroom below Vitest's 60-second RPC ceiling on slower CI hosts.
const MAX_RUNS_PER_PROCESS = 1_000;
const DEFAULT_SEED = 20_260_831;
const rawRuns = process.env.PB_RUNS;
const requestedRuns = rawRuns === undefined ? 0 : Number(rawRuns);
const baseSeed = Number(process.env.PB_SEED ?? DEFAULT_SEED);

if (!Number.isSafeInteger(requestedRuns) || requestedRuns < 0) {
  console.error("PB_RUNS must be a non-negative safe integer.");
  process.exit(2);
}
if (!Number.isSafeInteger(baseSeed)) {
  console.error("PB_SEED must be a safe integer.");
  process.exit(2);
}

const shards = requestedRuns === 0
  ? [{ numRuns: 0, seed: undefined }]
  : Array.from(
    { length: Math.ceil(requestedRuns / MAX_RUNS_PER_PROCESS) },
    (_, index) => ({
      numRuns: Math.min(
        MAX_RUNS_PER_PROCESS,
        requestedRuns - index * MAX_RUNS_PER_PROCESS,
      ),
      seed: baseSeed + index,
    }),
  );

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const vitestBin = fileURLToPath(
  new URL("../node_modules/vitest/vitest.mjs", import.meta.url),
);

for (const [index, shard] of shards.entries()) {
  if (requestedRuns > 0) {
    console.log(
      `\nProperty shard ${index + 1}/${shards.length}: `
      + `${shard.numRuns} cases per property, seed ${shard.seed}`,
    );
  }

  const env = { ...process.env };
  if (shard.numRuns > 0) {
    env.PB_RUNS = String(shard.numRuns);
    env.PB_SEED = String(shard.seed);
  }

  const result = spawnSync(
    process.execPath,
    [vitestBin, "run", "pb.property"],
    { cwd: packageRoot, env, stdio: "inherit" },
  );
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (requestedRuns > 0) {
  console.log(
    `\nL3 property gate passed: ${requestedRuns} cases per property `
    + `across ${shards.length} process${shards.length === 1 ? "" : "es"}.`,
  );
}
