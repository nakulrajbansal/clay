import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as evidenceLib from "./local-export-evidence-lib.mjs";
import {
  assertBenchmarkEvidence,
  canonicalEvidenceJson,
  sha256Evidence,
  summarizeBenchmarkSamples,
  verifyReleaseEvidenceDirectory,
} from "./local-export-evidence-lib.mjs";

const source = { commit: "b".repeat(40), tree: "c".repeat(40) };
const digest = value => sha256Evidence(Buffer.from(value));
const build = { sha256: digest("build"), bytes: 123, files: 4 };
const methodology = {
  clock: "performance.now",
  percentile: "nearest-rank-p95",
  warmupRuns: 2,
  sampleRuns: 30,
  coldDefinition: "fresh browser context, worker, imported fixture, and first projection",
  warmDefinition: "same worker and fixture after declared warm-up projections",
  memory: "measureUserAgentSpecificMemory peak sampling",
};
const limits = {
  rows1000CsvP95Ms: 1000,
  rows5000CsvP95Ms: 2000,
  rows5000PreviewP95Ms: 4000,
  cancelMs: 250,
  incrementalMemoryBytes: 64 * 1024 * 1024,
};
const sample = (rows, classification, operation, milliseconds) => ({
  rows, classification, operation, milliseconds,
  incrementalMemoryBytes: 100, inputBytes: 200, outputBytes: 50,
});
const warm = (rows, operation, milliseconds) => Array.from({ length: 30 }, () =>
  sample(rows, "warm", operation, milliseconds));
const samples = [
  sample(1000, "cold", "csv", 12), ...warm(1000, "csv", 8),
  sample(5000, "cold", "csv", 20), ...warm(5000, "csv", 15),
  sample(5000, "cold", "owner-preview", 30), ...warm(5000, "owner-preview", 25),
  sample(5000, "cold", "cancel", 5), ...warm(5000, "cancel", 4),
];
const benchmark = {
  schema: "BenchmarkEvidenceManifestV1",
  generatedAt: "2026-09-06T00:00:00.000Z",
  source,
  build,
  browser: { name: "chromium", version: "140", headless: true },
  path: "browser-worker-rpc-owner-preview",
  fixture: { harnessSha256: digest("fixture"), harnessBytes: 2048, fields: 1, rows: [1000, 5000] },
  methodology,
  limits,
  samples,
  results: summarizeBenchmarkSamples(samples),
  rawResultsSha256: sha256Evidence(Buffer.from(canonicalEvidenceJson({ methodology, samples }))),
  verdict: "PASS",
};
const accessibility = {
  schema: "AccessibilityEvidenceV1",
  axe: { status: "PASS", serious: 0, critical: 0,
    states: ["loading", "success", "error"] },
  keyboard: { status: "PASS", viewportWidth: 320, textScalePercent: 200,
    assertions: ["open", "operate", "close"] },
  reflow320At200Percent: { status: "PASS", viewportWidth: 320, textScalePercent: 200,
    method: "computed-font-size-per-rendered-text-node", renderedTextNodes: 24,
    scaledTextNodes: 24,
    representativeFontSizes: [
      { label: "dialog title", beforeCssPixels: 22, afterCssPixels: 44 },
      { label: "local-only badge", beforeCssPixels: 10.5, afterCssPixels: 21 },
      { label: "primary print action", beforeCssPixels: 13, afterCssPixels: 26 },
    ],
    horizontalDocumentOverflow: false, dialogFitsViewport: true,
    targetReachability: {
      status: "PASS", actions: ["Cancel", "Download CSV", "Print / Save as PDF"],
      allReachable: true,
    },
    artifact: "mobile-320px-200pct.png" },
  screenReader: { status: "UNAVAILABLE", mode: "manual", products: ["NVDA", "VoiceOver"],
    reason: "Manual assistive technology is unavailable in this automated environment." },
  accessibilityTree: { status: "PASS", browser: "Chromium 140",
    assertions: ["dialog", "progress", "table", "errors"], artifact: "accessibility-tree.json" },
  focusRestoration: { status: "PASS", restoredToTrigger: true },
  liveProgress: { status: "PASS", role: "status", announcement: "Building…" },
  errorLinkage: { status: "PASS", role: "alert", describedBy: "export-dialog-error" },
  printReadingOrder: { status: "PASS", method: "PDF text extraction", artifact: "desktop-print.pdf",
    extractedSha256: digest("text") },
  adaptations: { status: "PASS", assertions: ["forced colors", "reduced motion", "text spacing"] },
};

const dialogStateObservations = {
  loading: {
    axeBlocking: [],
    liveStatus: {
      role: "status", ariaLive: "polite", announcement: "Building a complete local preview…",
    },
  },
  success: { axeBlocking: [] },
  error: {
    axeBlocking: [],
    alert: { role: "alert", id: "export-dialog-error" },
    dialogDescribedBy: ["export-dialog-description", "export-dialog-error"],
  },
};

const runtimeArtifactNames = [
  "accessibility-tree.json",
  "current-view.csv",
  "desktop-current-view.png",
  "desktop-print-media.png",
  "desktop-print.pdf",
  "desktop-record.png",
  "mobile-320px-200pct.png",
];

async function fixtureDirectory(writeManifests = true) {
  const root = await mkdtemp(join(tmpdir(), "clay-release-f-evidence-"));
  const runtime = join(root, "runtime");
  await mkdir(runtime);
  await Promise.all(runtimeArtifactNames.map(file => writeFile(join(runtime, file), "bin")));
  const artifacts = runtimeArtifactNames.map(file => ({
    file, bytes: 3, sha256: digest("bin"),
  }));
  const report = {
    schema: "LocalExportEvidenceManifestV2",
    generatedAt: "2026-09-06T00:00:00.000Z",
    source, build,
    browser: { name: "chromium", version: "140", headless: true },
    url: "http://127.0.0.1:4173",
    requirements: ["F-AT-030", "F-AT-060"],
    exclusions: ["manual screen-reader evidence unavailable"],
    observations: { desktop: {}, mobile: {}, network: {} },
    checks: [{ ok: true, label: "local" }], errors: [], artifacts, accessibility,
    verdict: "BLOCKED",
  };
  const reportBytes = Buffer.from(`${JSON.stringify(report)}\n`);
  const benchmarkBytes = Buffer.from(`${JSON.stringify(benchmark)}\n`);
  const release = {
    schema: "ReleaseEvidenceManifestV1",
    generatedAt: "2026-09-06T00:00:00.000Z",
    source,
    reports: [
      { file: "runtime/report.json", schema: report.schema, sha256: sha256Evidence(reportBytes) },
      { file: "benchmark.json", schema: benchmark.schema, sha256: sha256Evidence(benchmarkBytes) },
    ],
    artifacts: artifacts.map(artifact => ({ ...artifact, file: `runtime/${artifact.file}` })),
    verdict: "BLOCKED",
  };
  if (writeManifests) {
    await writeFile(join(runtime, "report.json"), reportBytes);
    await writeFile(join(root, "benchmark.json"), benchmarkBytes);
    await writeFile(join(root, "release.json"), `${JSON.stringify(release)}\n`);
  }
  return { root, report, release, benchmark };
}

test("benchmark semantics bind raw samples, p95 method, counts, memory, and verdict", () => {
  assert.doesNotThrow(() => assertBenchmarkEvidence(benchmark));
  assert.throws(() => assertBenchmarkEvidence({
    ...benchmark,
    samples: benchmark.samples.map((entry, index) => index === 1
      ? { ...entry, milliseconds: 999 } : entry),
  }), /raw-results digest|result/i);
  assert.throws(() => assertBenchmarkEvidence({
    ...benchmark,
    samples: benchmark.samples.filter(entry => entry.classification !== "cold"),
  }), /cold/i);
});

test("outer release verification closes source, reports, and every referenced artifact", async () => {
  const { root } = await fixtureDirectory();
  await assert.doesNotReject(verifyReleaseEvidenceDirectory(root, source));
  await assert.rejects(verifyReleaseEvidenceDirectory(root, {
    commit: "d".repeat(40), tree: source.tree,
  }), /source/i);
  await writeFile(join(root, "runtime", "desktop-print.pdf"), "changed");
  await assert.rejects(verifyReleaseEvidenceDirectory(root, source), /digest|bytes/i);
});

test("release writer emits closed V2 reports and the complete runtime artifact inventory", async t => {
  const { root, report } = await fixtureDirectory(false);
  t.after(() => rm(root, { recursive: true, force: true }));
  const writeReleaseEvidenceDirectory = evidenceLib.writeReleaseEvidenceDirectory;
  assert.equal(typeof writeReleaseEvidenceDirectory, "function",
    "release evidence writer must be exported");
  const verified = await writeReleaseEvidenceDirectory(root, report, benchmark);
  assert.equal(verified.report.schema, "LocalExportEvidenceManifestV2");
  assert.equal(verified.release.schema, "ReleaseEvidenceManifestV1");
  assert.equal(verified.release.verdict, "BLOCKED");
  assert.deepEqual(verified.inventory, [
    "benchmark.json", "release.json", "runtime/accessibility-tree.json",
    "runtime/current-view.csv", "runtime/desktop-current-view.png",
    "runtime/desktop-print-media.png", "runtime/desktop-print.pdf",
    "runtime/desktop-record.png", "runtime/mobile-320px-200pct.png", "runtime/report.json",
  ]);
});

test("source binding rejects tracked, staged, and untracked worktree changes", async t => {
  const root = await mkdtemp(join(tmpdir(), "clay-release-f-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  git("init");
  await writeFile(join(root, "tracked.txt"), "clean\n");
  git("add", "tracked.txt");
  git("-c", "user.name=Release F Test", "-c", "user.email=release-f@example.invalid",
    "commit", "-m", "fixture");

  const assertCleanGitWorktree = evidenceLib.assertCleanGitWorktree;
  assert.equal(typeof assertCleanGitWorktree, "function",
    "clean-worktree assertion must be exported");
  assert.doesNotThrow(() => assertCleanGitWorktree(root));
  await writeFile(join(root, "tracked.txt"), "dirty\n");
  assert.throws(() => assertCleanGitWorktree(root), /clean worktree/i);
  git("add", "tracked.txt");
  assert.throws(() => assertCleanGitWorktree(root), /clean worktree/i);
  git("reset", "--hard", "HEAD");
  await writeFile(join(root, "untracked.txt"), "untracked\n");
  assert.throws(() => assertCleanGitWorktree(root), /clean worktree/i);
});

test("canonical evidence JSON is byte-stable across object insertion order", () => {
  assert.equal(canonicalEvidenceJson({ b: 2, a: { d: 4, c: 3 } }),
    canonicalEvidenceJson({ a: { c: 3, d: 4 }, b: 2 }));
});

test("clean HEAD source is derived from Git and exact identity rejects drift", async t => {
  const root = await mkdtemp(join(tmpdir(), "clay-release-f-head-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  git("init");
  await writeFile(join(root, "tracked.txt"), "clean\n");
  git("add", "tracked.txt");
  git("-c", "user.name=Release F Test", "-c", "user.email=release-f@example.invalid",
    "commit", "-m", "fixture");
  const expected = { commit: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}") };
  const previous = process.env.CLAY_SOURCE_TREE;
  process.env.CLAY_SOURCE_TREE = "f".repeat(40);
  try {
    assert.deepEqual(evidenceLib.deriveCleanHeadSource(root), expected);
  } finally {
    if (previous === undefined) delete process.env.CLAY_SOURCE_TREE;
    else process.env.CLAY_SOURCE_TREE = previous;
  }
  assert.doesNotThrow(() => evidenceLib.assertExactCleanSource(root, expected, "fixture"));
  await writeFile(join(root, "tracked.txt"), "dirty\n");
  assert.throws(() => evidenceLib.assertExactCleanSource(root, expected, "fixture"), /clean/i);
  git("reset", "--hard", "HEAD");
  assert.throws(() => evidenceLib.assertExactCleanSource(root, {
    ...expected, tree: "e".repeat(40),
  }, "fixture"), /tree/i);
});

test("manual screen-reader input is strict, source/build-bound, copied, and inventoried", async t => {
  const root = await mkdtemp(join(tmpdir(), "clay-release-f-manual-"));
  const outputDirectory = join(root, "output");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(outputDirectory);
  const transcript = Buffer.from("NVDA Speech Viewer transcript\n");
  await writeFile(join(root, "nvda-transcript.txt"), transcript);
  const manual = {
    status: "PASS", mode: "manual", product: "NVDA", productVersion: "2026.1",
    platform: "Windows 11", performedAt: "2026-09-06T00:00:00.000Z",
    tester: "Release accessibility tester",
    method: "Manual NVDA run with Speech Viewer transcript capture",
    source, build,
    assertions: ["dialog announced", "loading announced", "linked error announced"],
    artifact: {
      file: "nvda-transcript.txt", bytes: transcript.byteLength,
      sha256: sha256Evidence(transcript),
    },
  };
  const input = join(root, "manual.json");
  await writeFile(input, `${JSON.stringify(manual)}\n`);
  const ingested = await evidenceLib.ingestManualScreenReaderEvidence(input, {
    source, build, outputDirectory,
  });
  assert.equal(ingested.screenReader.status, "PASS");
  assert.equal(ingested.artifact.file, "manual-screen-reader/nvda-transcript.txt");
  assert.deepEqual(await readFile(join(outputDirectory, ingested.artifact.file)), transcript);
  assert.deepEqual(ingested.screenReader.artifact, ingested.artifact);
  const unavailable = await evidenceLib.ingestManualScreenReaderEvidence(undefined, {
    source, build, outputDirectory,
  });
  assert.equal(unavailable.screenReader.status, "UNAVAILABLE");
  assert.equal(unavailable.artifact, null);
  await writeFile(input, `${JSON.stringify({
    ...manual, source: { ...source, tree: "d".repeat(40) },
  })}\n`);
  await assert.rejects(evidenceLib.ingestManualScreenReaderEvidence(input, {
    source, build, outputDirectory,
  }), /source/i);
});

test("loading, success, and error accessibility claims are derived from observations", () => {
  assert.deepEqual(evidenceLib.summarizeExportDialogStateEvidence(dialogStateObservations), {
    axe: {
      status: "PASS", serious: 0, critical: 0,
      states: ["loading", "success", "error"],
    },
    liveProgress: {
      status: "PASS", role: "status", announcement: "Building a complete local preview…",
    },
    errorLinkage: { status: "PASS", role: "alert", describedBy: "export-dialog-error" },
  });
  assert.throws(() => evidenceLib.summarizeExportDialogStateEvidence({
    ...dialogStateObservations,
    error: { ...dialogStateObservations.error, dialogDescribedBy: ["export-dialog-description"] },
  }), /describedby|link/i);
  assert.throws(() => evidenceLib.summarizeExportDialogStateEvidence({
    ...dialogStateObservations,
    loading: { ...dialogStateObservations.loading, axeBlocking: [{ impact: "serious" }] },
  }), /axe/i);
});

test("certificate environment is allowlisted and pins deterministic build inputs", () => {
  const environment = evidenceLib.createCertificateEnvironment({
    source, outputRoot: "C:/safe/evidence", manualScreenReader: "C:/safe/manual.json",
    hostEnvironment: {
      PATH: "C:/tools", HOME: "C:/home", LOCALAPPDATA: "C:/local",
      NODE_OPTIONS: "--require=C:/hostile.js", NODE_PATH: "C:/hostile-modules",
      VITE_INJECT: "hostile", CLAY_UNTRUSTED: "hostile", DEBUG: "*",
    },
  });
  assert.equal(environment.PATH, "C:/tools");
  assert.equal(environment.HOME, "C:/home");
  assert.equal(environment.LOCALAPPDATA, "C:/local");
  assert.equal(environment.NODE_ENV, "production");
  assert.equal(environment.TZ, "UTC");
  assert.equal(environment.CLAY_SOURCE_TREE, source.tree);
  assert.equal(environment.CLAY_EVIDENCE_OUTPUT_ROOT, "C:/safe/evidence");
  assert.equal(environment.CLAY_MANUAL_SCREEN_READER_INPUT, "C:/safe/manual.json");
  for (const forbidden of ["NODE_OPTIONS", "NODE_PATH", "VITE_INJECT", "CLAY_UNTRUSTED", "DEBUG"])
    assert.equal(environment[forbidden], undefined);
});

test("evidence output cleanup rejects unknown entries and deletes only owned outputs", async t => {
  const root = await mkdtemp(join(tmpdir(), "clay-release-f-output-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sentinel = join(root, "do-not-delete.txt");
  await writeFile(sentinel, "keep\n");
  await assert.rejects(evidenceLib.prepareEvidenceOutput(root), /unowned|unknown/i);
  assert.equal(await readFile(sentinel, "utf8"), "keep\n");

  await rm(sentinel);
  await mkdir(join(root, "runtime"));
  await writeFile(join(root, "runtime", "report.json"), "old\n");
  await writeFile(join(root, "benchmark.json"), "old\n");
  await writeFile(join(root, "release.json"), "old\n");
  await evidenceLib.prepareEvidenceOutput(root);
  assert.deepEqual(await readdir(root), []);
});
