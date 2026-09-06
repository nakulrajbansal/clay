// Inner benchmark phase; invoked only by the isolated certificate wrapper.
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { runProjectionBrowserBenchmark } from "./local-export-browser-benchmark.mjs";
import {
  assertExactCleanSource, buildDirectoryDigest, deriveCleanHeadSource,
} from "./local-export-evidence-lib.mjs";
import { productGateUrl } from "./product-gate-url.mjs";

const outputFile = process.argv[2];
if (!outputFile || !isAbsolute(outputFile))
  throw new Error("benchmark evidence output must be an absolute external path");
const checkout = process.cwd();
const resolvedOutput = resolve(outputFile);
const outputRelative = relative(checkout, resolvedOutput);
if (outputRelative === "" || (!outputRelative.startsWith(`..${sep}`) && outputRelative !== ".."))
  throw new Error("benchmark evidence output must be outside the isolated checkout");
const source = deriveCleanHeadSource(checkout);
if (process.env.CLAY_SOURCE_TREE !== source.tree)
  throw new Error("wrapper-derived source tree does not match benchmark checkout tree");
const build = await buildDirectoryDigest(join(checkout, "packages", "shell", "dist"));
const url = productGateUrl();
assertExactCleanSource(checkout, source, "benchmark before browser");
const browser = await chromium.launch({ args: ["--enable-precise-memory-info"] });
try {
  const benchmark = await runProjectionBrowserBenchmark({
    browser, url, source, build, outDir: dirname(resolvedOutput),
  });
  await mkdir(dirname(resolvedOutput), { recursive: true });
  await writeFile(resolvedOutput, `${JSON.stringify(benchmark, null, 2)}\n`);
} finally {
  await browser.close();
  assertExactCleanSource(checkout, source, "benchmark after browser");
}
