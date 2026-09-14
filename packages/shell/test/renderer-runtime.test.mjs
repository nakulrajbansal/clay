import { describe, expect, it } from "vitest";
import { rendererAliases, assertRendererModules } from "../config/renderer-runtime.mjs";

const root = "node_modules/.pnpm/preact@10.29.8/node_modules/preact/";
const paths = ["dist/preact.module.js", "hooks/dist/hooks.module.js", "compat/dist/compat.module.js", "compat/client.mjs", "jsx-runtime/dist/jsxRuntime.module.js"];
const modules = paths.map(id => ({ id: root + id, rendered: 100 }));
const chunks = [{ runtime: "shell", file: "assets/app.js", modules }];

describe("one production renderer", () => {
  it("aliases exact React entry points for both Vite and Vitest without catching unrelated names", () => {
    for (const [source, target] of Object.entries({ react: "preact/compat", "react-dom": "preact/compat",
      "react-dom/client": "preact/compat/client", "react/jsx-runtime": "preact/jsx-runtime", "react/jsx-dev-runtime": "preact/jsx-dev-runtime" })) {
      const match = rendererAliases.find(alias => alias.find.test(source));
      expect(match?.replacement).toBe(target);
    }
    expect(rendererAliases.some(alias => alias.find.test("react-dom-extra"))).toBe(false);
  });
  it("accepts exactly one core/hooks/compat/JSX closure and ignores non-rendered wrappers", () => {
    expect(() => assertRendererModules(chunks)).not.toThrow();
    expect(() => assertRendererModules([...chunks, { file: "empty.js", modules: [{ id: modules[0].id, rendered: 0 }] }])).not.toThrow();
  });
  it.each(["react", "react-dom", "scheduler"])("rejects even a small emitted %s module", name => {
    expect(() => assertRendererModules([...chunks, { file: "bad.js", modules: [{ id: `node_modules/${name}/index.js`, rendered: 1 }] }])).toThrow(/React|scheduler/);
  });
  it("rejects duplicate, missing, mixed-version and worker renderer closures", () => {
    expect(() => assertRendererModules([...chunks, { file: "copy.js", modules }])).toThrow(/duplicate/);
    expect(() => assertRendererModules([{ file: "app.js", modules: modules.slice(1) }])).toThrow(/missing/);
    expect(() => assertRendererModules([...chunks, { file: "copy.js", modules: modules.map(m => ({ ...m, id: m.id.replace("10.29.8", "10.28.0") })) }])).toThrow(/duplicate|version/);
    expect(() => assertRendererModules([{ ...chunks[0], runtime: "worker" }])).toThrow(/worker/);
  });
});
