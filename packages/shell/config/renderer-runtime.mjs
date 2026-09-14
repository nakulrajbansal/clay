// Vite is also Vitest's configuration: tests and shipped JSX resolve the same
// renderer. Exact matches avoid catching other packages or private React APIs.
export const rendererAliases = [
  { find: /^react$/, replacement: "preact/compat" },
  // createRoot lives in the pinned compat/client entry, not compat itself.
  { find: /^react-dom$/, replacement: "preact/compat" },
  { find: /^react-dom\/client$/, replacement: "preact/compat/client" },
  { find: /^react\/jsx-runtime$/, replacement: "preact/jsx-runtime" },
  { find: /^react\/jsx-dev-runtime$/, replacement: "preact/jsx-dev-runtime" },
];

export function assertRendererModules(chunks) {
  const expected = ["dist/preact.module.js", "hooks/dist/hooks.module.js",
    "compat/dist/compat.module.js", "compat/client.mjs", "jsx-runtime/dist/jsxRuntime.module.js"];
  const found = new Set();
  for (const chunk of chunks) for (const module of chunk.modules) {
    if (!module.rendered) continue;
    const id = module.id.replaceAll("\\", "/");
    if (/\/node_modules\/(react|react-dom|scheduler)\//.test(`/${id}`))
      throw new Error("React/ReactDOM/scheduler must not enter the production renderer");
    const match = id.match(/(?:^|\/)node_modules\/preact\/(.+)$/);
    if (!match) continue;
    if (chunk.runtime === "worker") throw new Error("Renderer must not enter the DB worker");
    if (id.includes("/.pnpm/") && !id.includes("/preact@10.29.8/"))
      throw new Error("Unexpected Preact version");
    const part = match[1];
    if (!expected.includes(part)) throw new Error(`Unexpected Preact runtime: ${part}`);
    if (found.has(part)) throw new Error(`duplicate Preact runtime: ${part}`);
    found.add(part);
  }
  for (const part of expected) if (!found.has(part)) throw new Error(`missing Preact runtime: ${part}`);
}

export function productionRendererGuard() {
  return { name: "clay-single-renderer", apply: "build", generateBundle(_options, bundle) {
    const chunks = Object.values(bundle).filter(chunk => chunk.type === "chunk").map(chunk => ({
      file: chunk.fileName, modules: Object.entries(chunk.modules).map(([id, info]) => ({ id, rendered: info.renderedLength })),
    }));
    assertRendererModules(chunks);
    assertPlannerTransportModules(chunks);
  } };
}

export function assertPlannerTransportModules(chunks, requireWorker = false) {
  let raw = false, workerDecoder = false;
  for (const chunk of chunks) for (const module of chunk.modules) {
    if (!module.rendered) continue;
    const id = `/${module.id.replaceAll("\\", "/")}`;
    const isRaw = id.endsWith("/packages/mutation/src/raw-client.ts");
    const isDecoder = id.endsWith("/packages/kernel/src/pipeline.ts");
    if (chunk.runtime === "worker") {
      if (isRaw) throw new Error("Provider transport must not enter the DB worker");
      workerDecoder ||= isDecoder;
    } else {
      if (isDecoder || id.endsWith("/packages/mutation/src/client.ts"))
        throw new Error("Shell must relay opaque plans to the worker, not duplicate plan validation");
      raw ||= isRaw;
    }
  }
  if (!raw || (requireWorker && !workerDecoder)) throw new Error("Missing planner transport/worker boundary");
}
