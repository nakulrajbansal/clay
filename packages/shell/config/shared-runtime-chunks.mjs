// The same dependency-only module closure and export namespace are built for
// each realm. Identical content hashes deduplicate actual emitted bytes; imports
// stay normal ESM and every frozen collector still counts its full closure.
export function sharedRuntimeChunk(id) {
  const normalized = id.replaceAll("\\", "/");
  if (normalized.endsWith("/@sqlite.org/sqlite-wasm/dist/clay-sqlite-initializer.mjs"))
    return "sqlite-initializer";
  return normalized.includes("/node_modules/zod/")
    || normalized.endsWith("/schema/src/validation-runtime.ts")
    ? "validation-runtime" : undefined;
}
