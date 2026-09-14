import ts from "typescript";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const pureFiles = new Set(["packages/kernel/src/strict-json-capture.ts",
  "packages/shell/src/shells/seed.ts", "packages/shell/src/shells/seed-panels.ts",
  "packages/shell/src/worker/pure-compute-contract.ts", "packages/shell/src/worker/pure-compute.ts",
  "packages/shell/src/worker/pure-compute-worker.ts"]);
const schemas = new Set(["archive", "backup", "catalog", "daily-home", "import-staging", "import", "index",
  "intake-state", "intake-workflow", "intake", "legacy-owner", "owner-witness", "private-metrics", "programs",
  "projection", "pure-compute", "restore", "runtime", "saved-views", "share", "worker-contracts"]
  .map(name => `packages/schema/src/standalone/${name}.mjs`));
const normalized = id => id.replaceAll("\\", "/").replace(/^.*?(?=packages\/)/, "");
export function assertPureComputeModules(ids) {
  for (const raw of ids) {
    const id = normalized(raw);
    if (!pureFiles.has(id) && !schemas.has(id))
      throw new Error(`Forbidden pure computation import: ${id}`);
  }
}
const forbidden = new Set(["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "navigator", "indexedDB",
  "localStorage", "sessionStorage", "caches", "Worker", "SharedWorker", "BroadcastChannel", "importScripts",
  "globalThis", "window", "document", "eval", "Function", "WebAssembly", "constructor"]);
export function assertComputeSource(source, mode = "pure") {
  if (mode !== "pure" && mode !== "private-entry") throw new Error("Unknown pure computation mode");
  const ast = ts.createSourceFile("pure.ts", source, ts.ScriptTarget.Latest, true);
  const visit = node => {
    if (ts.isIdentifier(node) && forbidden.has(node.text)) throw new Error(`Forbidden pure computation capability: ${node.text}`);
    if (ts.isIdentifier(node) && node.text === "self" && !(mode === "private-entry"
        && ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node
        && ["onmessage", "close"].includes(node.parent.name.text)))
      throw new Error("Forbidden pure computation global escape");
    if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)
        && forbidden.has(node.argumentExpression.text)) throw new Error("Forbidden pure computation property escape");
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
      throw new Error("Dynamic pure computation import");
    ts.forEachChild(node, visit);
  };
  visit(ast);
}
export function productionPureComputeGuard({ verifyInputs = false } = {}) {
  return { name: "clay-pure-compute-boundary", apply: "build",
    buildStart() {
      if (verifyInputs) execFileSync(process.execPath,
        [fileURLToPath(new URL("../../../scripts/seed-manifest.mjs", import.meta.url)), "--check"], { stdio: ["ignore", "pipe", "pipe"] });
    },
    generateBundle(_options, bundle) {
      const entry = Object.values(bundle).find(chunk => chunk.type === "chunk"
        && chunk.facadeModuleId?.replaceAll("\\", "/").endsWith("/pure-compute-worker.ts"));
      if (!entry) return;
      for (const module of this.getModuleIds()) {
        const info = this.getModuleInfo(module);
        if (info?.isExternal) throw new Error("External pure computation dependency");
        assertPureComputeModules([module]);
        if (info?.code) assertComputeSource(info.code, normalized(module).endsWith("/pure-compute-worker.ts") ? "private-entry" : "pure");
      }
    },
  };
}
