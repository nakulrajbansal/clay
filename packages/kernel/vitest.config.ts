import { defineConfig } from "vitest/config";

// Property tests at the L3 gate (PB_RUNS=10000) run for minutes and block
// the worker's reporter RPC; raise the infra timeouts so the run exits
// clean. Per-test budgets are set inline (fc.assert timeouts).
export default defineConfig({
  test: {
    testTimeout: 600_000,
    hookTimeout: 600_000,
    teardownTimeout: 600_000,
    // forks tolerate long CPU-bound runs (L3, 10k) without the worker
    // reporter-RPC timeout that the threads pool hits.
    pool: "forks",
  },
});
