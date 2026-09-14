import type { Plugin } from "vite";
export function splitSqliteDistribution(index: string, worker: string): {
  initializerBody: string; initializer: string; indexEntry: string; workerEntry: string;
};
export function createSharedSqliteRuntime(options?: { distributionRoot?: string }): Plugin;
