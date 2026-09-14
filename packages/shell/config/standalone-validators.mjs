import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Actual emitted-module assertion, independent of the frozen size collector. */
export function assertStandaloneModules(chunks, requireRuntime = true) {
  const files = new Set(), identities = new Set();
  for (const chunk of chunks) for (const module of chunk.modules) {
    if (!module.rendered) continue;
    const id = `/${module.id.replaceAll("\\", "/")}`;
    if (/\/node_modules\/zod\//.test(id)
        || /\/schema\/src\/(?:validation-runtime|index|archive|backup|catalog|daily-home|intake|intake-workflow|legacy-owner|owner-witness|projection|restore|share|import-staging|import|private-metrics|saved-views|intake-state|worker-contracts)\.ts$/.test(id))
      throw new Error(`Authoring schema runtime in production: ${module.id}`);
    if (id.endsWith("/schema/src/standalone/runtime.mjs")) {
      files.add(chunk.file); identities.add(id);
    }
  }
  if (files.size > 1 || identities.size > 1) throw new Error("Duplicated standalone validator runtime");
  if (requireRuntime && files.size !== 1) throw new Error("Missing standalone validator runtime");
}

export function productionStandaloneGuard({ verifyInputs = false } = {}) {
  return { name: "clay-closed-standalone-validators", apply: "build",
    buildStart() {
      if (verifyInputs) execFileSync(process.execPath,
        [fileURLToPath(new URL("../../schema/scripts/generate-standalone.mjs", import.meta.url)), "--check"],
        { stdio: ["ignore", "pipe", "pipe"] });
    },
    generateBundle(_options, bundle) {
      assertStandaloneModules(Object.values(bundle).filter(chunk => chunk.type === "chunk").map(chunk => ({
        file: chunk.fileName, modules: Object.entries(chunk.modules).map(([id, info]) => ({ id, rendered: info.renderedLength })),
      })), false);
    },
  };
}
