// Diagnostic production build: report Rollup's actual module membership without
// changing chunks, minification, frozen budgets, or release evidence.
import { build } from "../packages/shell/node_modules/vite/dist/node/index.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(root, "test-results/fix-batch/bundle-modules.json");
const chunks = [];
const report = runtime => ({ name: `clay-diagnostic-${runtime}`, generateBundle(_options, bundle) {
  for (const chunk of Object.values(bundle)) if (chunk.type === "chunk") chunks.push({
    runtime, file: chunk.fileName, imports: chunk.imports, dynamicImports: chunk.dynamicImports,
    modules: Object.entries(chunk.modules).map(([id, info]) => ({
      id: relative(root, id).replaceAll("\\", "/"), rendered: info.renderedLength,
    })).sort((a, b) => b.rendered - a.rendered),
  });
} });
await build({ root: resolve(root, "packages/shell"), plugins: [report("shell")], worker: { plugins: () => [report("worker")] } });
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify({ kind: "build_module_diagnostic_not_certification", chunks }, null, 2));
console.log(`Module diagnostic: ${relative(root, output)}`);
