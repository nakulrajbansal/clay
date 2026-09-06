import { createHash } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertBenchmarkEvidence,
  canonicalEvidenceJson,
  sha256Evidence,
  summarizeBenchmarkSamples,
} from "./local-export-evidence-lib.mjs";

const PREFIX = "/__release_f_benchmark__/";
const WARMUP_RUNS = 2;
const SAMPLE_RUNS = 30;

async function filesBelow(root, current = root) {
  const files = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(root, path));
    else if (entry.isFile()) files.push(relative(root, path).split(sep).join("/"));
  }
  return files.sort();
}

async function harnessDigest(root) {
  const files = await filesBelow(root);
  const hash = createHash("sha256");
  let bytes = 0;
  for (const file of files) {
    const data = await readFile(join(root, file));
    hash.update(file).update("\0").update(data);
    bytes += data.byteLength;
  }
  return { harnessSha256: `sha256:${hash.digest("hex")}`, harnessBytes: bytes, files };
}

export async function buildProjectionBenchmarkHarness(outDir) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const shellRoot = join(repoRoot, "packages", "shell");
  const require = createRequire(join(shellRoot, "package.json"));
  const vite = await import(pathToFileURL(require.resolve("vite")).href);
  const reactModule = await import(pathToFileURL(require.resolve("@vitejs/plugin-react")).href);
  await mkdir(outDir, { recursive: true });
  await vite.build({
    root: shellRoot,
    configFile: false,
    plugins: [reactModule.default()],
    logLevel: "warn",
    build: {
      outDir,
      emptyOutDir: true,
      manifest: true,
      minify: "terser",
      cssMinify: "lightningcss",
      rollupOptions: {
        input: {
          owner: join(shellRoot, "test", "browser", "projection-benchmark-owner.tsx"),
          worker: join(shellRoot, "test", "browser", "projection-benchmark-worker.ts"),
        },
      },
    },
    optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
  });
  const manifest = JSON.parse(await readFile(join(outDir, ".vite", "manifest.json"), "utf8"));
  const entry = suffix => {
    const match = Object.entries(manifest).find(([key, value]) =>
      key.endsWith(suffix) && value?.isEntry);
    if (!match || typeof match[1].file !== "string")
      throw new Error(`benchmark build is missing ${suffix}`);
    return match[1];
  };
  const owner = entry("projection-benchmark-owner.tsx");
  const worker = entry("projection-benchmark-worker.ts");
  const digest = await harnessDigest(outDir);
  return {
    root: outDir,
    ownerFile: owner.file,
    workerFile: worker.file,
    cssFiles: Array.isArray(owner.css) ? owner.css : [],
    ...digest,
  };
}

async function installHarnessRoute(context, url, harness) {
  const origin = new URL(url).origin;
  await context.route(`${origin}${PREFIX}**`, async route => {
    const requestUrl = new URL(route.request().url());
    const relativePath = decodeURIComponent(requestUrl.pathname.slice(PREFIX.length));
    const headers = {
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Cache-Control": "no-store",
    };
    if (relativePath === "index.html") {
      const css = harness.cssFiles.map(file =>
        `<link rel="stylesheet" href="${PREFIX}${file}">`).join("");
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        headers,
        body: `<!doctype html><html><head><meta charset="utf-8">${css}</head>`
          + `<body><div id="root"></div><script type="module" src="${PREFIX}${harness.ownerFile}"></script>`
          + "</body></html>",
      });
      return;
    }
    const file = resolve(harness.root, relativePath);
    const root = resolve(harness.root);
    if (file !== root && !file.startsWith(`${root}${sep}`)) {
      await route.abort("blockedbyclient");
      return;
    }
    const body = await readFile(file);
    const extension = relativePath.split(".").at(-1);
    const contentType = extension === "css" ? "text/css"
      : extension === "js" ? "application/javascript" : "application/octet-stream";
    await route.fulfill({ status: 200, contentType, headers, body });
  });
}

async function openHarness(browser, url, harness, rows) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  await installHarnessRoute(context, url, harness);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
  page.on("console", message => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  const origin = new URL(url).origin;
  const workerUrl = `${origin}${PREFIX}${harness.workerFile}`;
  await page.goto(`${origin}${PREFIX}index.html?rows=${rows}&worker=${encodeURIComponent(workerUrl)}`,
    { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.__projectionBenchmark));
  await page.evaluate(() => window.__projectionBenchmark.ready);
  if (errors.length) throw new Error(`benchmark harness failed: ${errors.join("; ")}`);
  const memoryAvailable = await page.evaluate(() =>
    Number((performance).memory?.usedJSHeapSize ?? 0) > 0);
  if (!memoryAvailable) throw new Error("Chromium precise heap measurement is unavailable");
  return { context, page, errors };
}

async function rawSample(page, rows, classification) {
  return page.evaluate(async ({ rows, classification }) => {
    const api = window.__projectionBenchmark;
    api.beginMemorySample();
    const started = performance.now();
    const output = await api.project();
    const milliseconds = performance.now() - started;
    const memory = api.endMemorySample();
    const outputBytes = output.plaintextBytes + output.csvBytes;
    return {
      rows, classification, operation: "csv", milliseconds,
      incrementalMemoryBytes: Math.max(0,
        Math.round(memory.peak - memory.baseline - api.inputBytes() - outputBytes)),
      inputBytes: api.inputBytes(), outputBytes,
    };
  }, { rows, classification });
}

async function previewSample(page, rows, classification) {
  await page.evaluate(() => {
    window.__projectionBenchmark.beginMemorySample();
    window.__releaseFPreviewStarted = performance.now();
    window.__projectionBenchmark.open();
  });
  await page.locator(".export-dialog tbody").waitFor({ timeout: 15_000 });
  const count = await page.locator(".export-dialog tbody tr").count();
  if (count !== rows) throw new Error(`owner preview rendered ${count} rows instead of ${rows}`);
  const result = await page.evaluate(({ rows, classification }) => {
    const api = window.__projectionBenchmark;
    const milliseconds = performance.now() - window.__releaseFPreviewStarted;
    const memory = api.endMemorySample();
    const output = api.artifactBytes();
    const outputBytes = output.plaintextBytes + output.csvBytes;
    return {
      rows, classification, operation: "owner-preview", milliseconds,
      incrementalMemoryBytes: Math.max(0,
        Math.round(memory.peak - memory.baseline - api.inputBytes() - outputBytes)),
      inputBytes: api.inputBytes(), outputBytes,
    };
  }, { rows, classification });
  await page.locator(".export-dialog").press("Escape");
  await page.locator(".export-dialog").waitFor({ state: "detached" });
  return result;
}

async function cancelSample(page, rows, classification) {
  return page.evaluate(async ({ rows, classification }) => {
    const api = window.__projectionBenchmark;
    api.beginMemorySample();
    const started = performance.now();
    await api.cancel();
    const milliseconds = performance.now() - started;
    const memory = api.endMemorySample();
    return {
      rows, classification, operation: "cancel", milliseconds,
      incrementalMemoryBytes: Math.max(0,
        Math.round(memory.peak - memory.baseline - api.inputBytes())),
      inputBytes: api.inputBytes(), outputBytes: 0,
    };
  }, { rows, classification });
}

function normalizeSample(sample) {
  return {
    ...sample,
    milliseconds: Number(sample.milliseconds.toFixed(3)),
  };
}

async function sampleGroup(browser, url, harness, rows, operation) {
  const { context, page, errors } = await openHarness(browser, url, harness, rows);
  const take = operation === "csv" ? rawSample
    : operation === "owner-preview" ? previewSample : cancelSample;
  const samples = [normalizeSample(await take(page, rows, "cold"))];
  for (let index = 0; index < WARMUP_RUNS; index++) await take(page, rows, "warm");
  for (let index = 0; index < SAMPLE_RUNS; index++)
    samples.push(normalizeSample(await take(page, rows, "warm")));
  if (errors.length) throw new Error(`benchmark browser errors: ${errors.join("; ")}`);
  await context.close();
  return samples;
}

export async function runProjectionBrowserBenchmark({ browser, url, source, build, outDir }) {
  const temporaryBuild = await mkdtemp(join(tmpdir(), "clay-release-f-benchmark-"));
  let harness;
  let samples;
  try {
    harness = await buildProjectionBenchmarkHarness(temporaryBuild);
    samples = [
      ...await sampleGroup(browser, url, harness, 1000, "csv"),
      ...await sampleGroup(browser, url, harness, 5000, "csv"),
      ...await sampleGroup(browser, url, harness, 5000, "owner-preview"),
      ...await sampleGroup(browser, url, harness, 5000, "cancel"),
    ];
  } finally {
    await rm(temporaryBuild, { recursive: true, force: true });
  }
  const methodology = {
    clock: "performance.now",
    percentile: "nearest-rank-p95",
    warmupRuns: WARMUP_RUNS,
    sampleRuns: SAMPLE_RUNS,
    coldDefinition: "fresh Chromium context and module worker; first operation after fixture initialization",
    warmDefinition: "same Chromium context, production projector/client/owner, and fixture after two declared warm-ups",
    memory: "Chromium --enable-precise-memory-info usedJSHeapSize peak sampled every 2 ms; declared input/output bytes subtracted",
  };
  const limits = {
    rows1000CsvP95Ms: 1000,
    rows5000CsvP95Ms: 2000,
    rows5000PreviewP95Ms: 4000,
    cancelMs: 250,
    incrementalMemoryBytes: 64 * 1024 * 1024,
  };
  const results = summarizeBenchmarkSamples(samples);
  const pass = results.rows1000CsvP95Ms <= limits.rows1000CsvP95Ms
    && results.rows5000CsvP95Ms <= limits.rows5000CsvP95Ms
    && results.rows5000PreviewP95Ms <= limits.rows5000PreviewP95Ms
    && results.cancelP95Ms <= limits.cancelMs
    && results.peakIncrementalMemoryBytes <= limits.incrementalMemoryBytes;
  const manifest = {
    schema: "BenchmarkEvidenceManifestV1",
    generatedAt: new Date().toISOString(),
    source,
    build,
    browser: { name: "chromium", version: browser.version(), headless: true },
    path: "browser-worker-rpc-owner-preview",
    fixture: {
      harnessSha256: harness.harnessSha256,
      harnessBytes: harness.harnessBytes,
      fields: 1,
      rows: [1000, 5000],
    },
    methodology,
    limits,
    samples,
    results,
    rawResultsSha256: sha256Evidence(Buffer.from(canonicalEvidenceJson({ methodology, samples }))),
    verdict: pass ? "PASS" : "FAIL",
  };
  return assertBenchmarkEvidence(manifest);
}

export async function runExportDialogStateEvidence({ browser, url }) {
  const temporaryBuild = await mkdtemp(join(tmpdir(), "clay-release-f-dialog-states-"));
  let context;
  try {
    const harness = await buildProjectionBenchmarkHarness(temporaryBuild);
    const opened = await openHarness(browser, url, harness, 1000);
    context = opened.context;
    const { page, errors } = opened;
    const observations = {};
    for (const state of ["loading", "success", "error"]) {
      await page.evaluate(nextState => window.__projectionBenchmark.openState(nextState), state);
      const dialog = page.locator(".export-dialog");
      await dialog.waitFor({ timeout: 15_000 });
      if (state === "loading")
        await dialog.getByRole("status").waitFor({ timeout: 15_000 });
      else if (state === "success") await dialog.locator("tbody").waitFor({ timeout: 15_000 });
      else await dialog.getByRole("alert").waitFor({ timeout: 15_000 });
      const axeResult = await new AxeBuilder({ page }).include(".export-dialog").analyze();
      const axeBlocking = axeResult.violations
        .filter(item => item.impact === "serious" || item.impact === "critical")
        .map(item => ({ id: item.id, impact: item.impact,
          targets: item.nodes.map(node => node.target) }));
      if (state === "loading") {
        const live = dialog.getByRole("status");
        observations.loading = {
          axeBlocking,
          liveStatus: {
            role: await live.getAttribute("role"),
            ariaLive: await live.getAttribute("aria-live"),
            announcement: (await live.textContent())?.trim() ?? "",
          },
        };
      } else if (state === "error") {
        const alert = dialog.getByRole("alert");
        observations.error = {
          axeBlocking,
          alert: { role: await alert.getAttribute("role"), id: await alert.getAttribute("id") },
          dialogDescribedBy: (await dialog.getAttribute("aria-describedby") ?? "")
            .split(/\s+/).filter(Boolean),
        };
      } else observations.success = { axeBlocking };
      await dialog.press("Escape");
      await dialog.waitFor({ state: "detached" });
    }
    if (errors.length) throw new Error(`dialog-state harness errors: ${errors.join("; ")}`);
    return observations;
  } finally {
    if (context) await context.close();
    await rm(temporaryBuild, { recursive: true, force: true });
  }
}

/** Fast wiring probe; release evidence always uses the fixed 30-run path above. */
export async function smokeProjectionBrowserBenchmark({ browser, url }) {
  const temporaryBuild = await mkdtemp(join(tmpdir(), "clay-release-f-benchmark-smoke-"));
  try {
    const harness = await buildProjectionBenchmarkHarness(temporaryBuild);
    const { context, page, errors } = await openHarness(browser, url, harness, 1000);
    try {
      const csv = normalizeSample(await rawSample(page, 1000, "cold"));
      const preview = normalizeSample(await previewSample(page, 1000, "cold"));
      const cancel = normalizeSample(await cancelSample(page, 1000, "cold"));
      if (errors.length) throw new Error(errors.join("; "));
      return { csv, preview, cancel, harnessSha256: harness.harnessSha256 };
    } finally {
      await context.close();
    }
  } finally {
    await rm(temporaryBuild, { recursive: true, force: true });
  }
}
