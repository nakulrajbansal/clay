import { defineConfig } from "vitest/config";

// Property tests at the L3 gate (PB_RUNS=10000) run for minutes. Per-test
// budgets are set inline. The L3 runner splits high run counts across
// processes because Vitest 3.2.x has a hard-coded 60-second worker RPC timeout.
export default defineConfig({
  test: {
    testTimeout: 600_000,
    hookTimeout: 600_000,
    teardownTimeout: 600_000,
    pool: "forks",
  },
});
