import { build } from "vite";
import { describe, expect, it } from "vitest";
import { sharedRuntimeChunk } from "../config/shared-runtime-chunks.mjs";
import { assertStandaloneModules } from "../config/standalone-validators.mjs";

describe("one closed validation runtime across realm builds", () => {
  it("standalone realm compilations share the same closed interpreter and literal asset", async () => {
    async function compile(module, name) {
      const output=await build({ configFile:false,logLevel:"silent",plugins:[{
        name:"owned-standalone-fixture",
        resolveId(id){if(id==='fixture')return id;},
        load(id){if(id==='fixture')return `import {${name}} from '${module}'; export const parse=value=>${name}.safeParse(value);`;},
      }],build:{write:false,minify:'terser',target:'es2022',rollupOptions:{input:'fixture',preserveEntrySignatures:'strict',
        output:{onlyExplicitManualChunks:true,manualChunks:sharedRuntimeChunk}}}});
      const chunks=output.output.filter(file=>file.type==='chunk');
      assertStandaloneModules(chunks.map(chunk=>({file:chunk.fileName,modules:Object.entries(chunk.modules)
        .map(([id,info])=>({id,rendered:info.renderedLength}))})));
      const runtime=chunks.filter(chunk=>chunk.name==='validation-runtime');expect(runtime).toHaveLength(1);
      expect(runtime[0].imports).toEqual([]);expect(runtime[0].dynamicImports).toEqual([]);
      return runtime[0].code;
    }
    expect(await compile('@clay/schema/standalone/index','AppInstanceId'))
      .toBe(await compile('@clay/schema/standalone/backup','ManualBackupDownloadV2'));
  });
  it("independent shell/worker compilations emit byte-identical runtime code without DOM or worker imports", async () => {
    async function compile(expression) {
      const output = await build({ configFile: false, logLevel: "silent", plugins: [{
        name: "owned-validation-fixture",
        resolveId(id) { if (id === "fixture") return id; },
        load(id) { if (id === "fixture") return `import { z } from '@clay/schema/validation-runtime'; export default ${expression};`; },
      }], build: { write: false, minify: "terser", target: "es2022",
        rollupOptions: { input: "fixture", preserveEntrySignatures: "strict",
          output: { onlyExplicitManualChunks: true, manualChunks: sharedRuntimeChunk } } } });
      const runtime = output.output.filter(file => file.type === "chunk" && file.name === "validation-runtime");
      expect(runtime).toHaveLength(1);
      expect(runtime[0].imports).toEqual([]);
      expect(runtime[0].dynamicImports).toEqual([]);
      expect(Object.keys(runtime[0].modules).every(id => id.replaceAll("\\", "/").includes("/node_modules/zod/")
        || id.replaceAll("\\", "/").endsWith("/schema/src/validation-runtime.ts"))).toBe(true);
      return runtime[0].code;
    }
    expect(await compile("z.string().regex(/^original$/)"))
      .toBe(await compile("z.object({rows: z.array(z.number())}).strict()"));
  });
});
