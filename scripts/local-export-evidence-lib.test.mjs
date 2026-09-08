import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { LOCAL_EXPORT_REQUIRED_REQUIREMENTS_V2 } from "../packages/schema/src/evidence.ts";
import * as evidenceLib from "./local-export-evidence-lib.mjs";
import {
  assertBenchmarkEvidence,
  buildDirectoryDigest,
  canonicalEvidenceJson,
  sha256Evidence,
  summarizeBenchmarkSamples,
  verifyReleaseEvidenceDirectory,
} from "./local-export-evidence-lib.mjs";

const source = { commit: "b".repeat(40), tree: "c".repeat(40) };
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
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
  plaintextBytes: operation === "cancel" ? 0 : rows === 5000 ? 8_000_000 : 1_600_000,
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
  fixture: { harnessSha256: digest("fixture"), harnessBytes: 2048, fields: 30,
    rows: [1000, 5000], nearLimitPlaintextBytes: 8_000_000 },
  methodology,
  limits,
  samples,
  results: summarizeBenchmarkSamples(samples),
  rawResultsSha256: sha256Evidence(Buffer.from(canonicalEvidenceJson({ methodology, samples }))),
  verdict: "PASS",
};
const textScaleSurfaces = [
  "body", ".dataview", ".appbar-menu", ".appbar-theme-menu", ".export-dialog",
].map((surface, index) => ({
  surface,
  coverage: { textNodes: 8, formControls: 3,
    placeholderControls: surface === ".dataview" ? 1 : 0,
    selectedOptions: surface === ".dataview" ? 1 : 0,
    pseudoElements: index === 0 ? 1 : 0 },
  renderedTextNodes: index === 0 ? 12 : 11,
  scaledTextNodes: index === 0 ? 12 : 11,
}));

const accessibility = {
  schema: "AccessibilityEvidenceV1",
  axe: { status: "PASS", serious: 0, critical: 0,
    states: ["loading", "success", "error"] },
  keyboard: { status: "PASS", viewportWidth: 320, textScalePercent: 200,
    assertions: ["open", "operate", "close"] },
  reflow320At200Percent: { status: "PASS", viewportWidth: 320, textScalePercent: 200,
    method: "computed-font-size-per-rendered-text-node", renderedTextNodes: 24,
    scaledTextNodes: 24, surfaces: textScaleSurfaces,
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
  "record.csv",
  "desktop-current-view.png",
  "desktop-print-media.png",
  "desktop-print.pdf",
  "desktop-record.png",
  "mobile-320px-200pct.png",
];

test("build directory digest length-frames paths and payloads", async () => {
  const root = await mkdtemp(join(tmpdir(), "clay-build-digest-"));
  const left = join(root, "left");
  const right = join(root, "right");
  try {
    await Promise.all([mkdir(left), mkdir(right)]);
    await Promise.all([
      writeFile(join(left, "a"), Buffer.from([0x62, 0])),
      writeFile(join(left, "c"), Buffer.alloc(0)),
      writeFile(join(right, "a"), Buffer.alloc(0)),
      writeFile(join(right, "b"), Buffer.from([0x63, 0])),
    ]);
    const leftDigest = await buildDirectoryDigest(left);
    const rightDigest = await buildDirectoryDigest(right);
    assert.deepEqual({ bytes: leftDigest.bytes, files: leftDigest.files }, { bytes: 2, files: 2 });
    assert.deepEqual({ bytes: rightDigest.bytes, files: rightDigest.files }, { bytes: 2, files: 2 });
    assert.notEqual(leftDigest.sha256, rightDigest.sha256);
  } finally { await rm(root, { recursive: true, force: true }); }
});

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
    requirements: [...LOCAL_EXPORT_REQUIRED_REQUIREMENTS_V2],
    gates: [
      { id: "local-print-csv", status: "PASS" },
      { id: "direct-pdf", status: "NOT_SHIPPED" },
      { id: "hosted-encrypted-snapshots", status: "NOT_SHIPPED" },
      { id: "hosted-public-intake", status: "NOT_SHIPPED" },
      { id: "hosted-file-requests", status: "NOT_SHIPPED" },
    ],
    observations: {
      desktop: {
        currentView: { headings: ["Title"], rows: [["Example"]],
          csv: { bytes: 3, sha256: digest("bin"), rows: 1, fields: 1, exact: true } },
        record: { id: "018f0000-0000-7000-8000-000000000001",
          headings: ["Title"], rows: [["Example"]],
          csv: { bytes: 3, sha256: digest("bin") }, csvExact: true, printCalls: 1 },
        print: { artifact: "desktop-print.pdf", extractedSha256: digest("text"), exact: true },
        opfsUnchanged: true, historyUnchanged: true, axeBlocking: 0,
      },
      mobile: { viewport: { width: 320, height: 800 }, textScalePercent: 200,
        surfaces: textScaleSurfaces, horizontalDocumentOverflow: false,
        dialogFitsViewport: true, appMenuReachable: true, themeMenuReachable: true,
        keyboardAssertions: ["tab route", "forward wrap", "reverse wrap", "inert outside",
          "Space closes", "focus returns", "Escape returns"],
        actionsReachable: true, axeBlocking: 0 },
      network: { desktopExportRequests: 0, recordExportRequests: 0,
        mobileExportRequests: 0, unexpected: [] },
    },
    cases: [
      "current-view-preview-exact", "current-view-csv-exact", "print-document-exact",
      "record-preview-exact", "record-actions-exact", "network-local-only",
      "durable-state-unchanged", "mobile-reflow", "mobile-controls-reachable",
      "keyboard-complete", "automated-accessibility",
    ].map(id => ({ id, status: "PASS" })),
    errors: [], artifacts, accessibility,
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
    "runtime/desktop-record.png", "runtime/mobile-320px-200pct.png", "runtime/record.csv",
    "runtime/report.json",
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
  const assertionIds = [
    "dialog-status-and-error-announcements", "manifest-policy-comprehension",
    "preview-table-navigation", "formula-neutralization-disclosure",
    "controls-names-states-and-keyboard", "focus-trap-and-restoration",
    "current-view-and-record-journeys",
  ];
  const transcript = Buffer.from(`${assertionIds.flatMap(id => [
    `[${id}]`, `Observed concrete screen-reader behavior for ${id}.`,
    `Verified the required result for ${id}.`,
  ]).join("\n")}\n`);
  const procedureBytes = await readFile(join(
    repositoryRoot, "specs", "release-f-manual-screen-reader-procedure.md",
  ));
  await writeFile(join(root, "nvda-transcript.txt"), transcript);
  const sourceArtifact = {
    file: "nvda-transcript.txt", bytes: transcript.byteLength,
    sha256: sha256Evidence(transcript),
  };
  const manual = {
    status: "PASS", mode: "manual", product: "NVDA", productVersion: "2026.1",
    platform: "Windows 11", performedAt: "2026-09-06T00:00:00.000Z",
    tester: "Release accessibility tester",
    method: "Manual NVDA run with Speech Viewer transcript capture",
    procedure: {
      id: "release-f-manual-screen-reader", version: 1,
      sha256: sha256Evidence(procedureBytes),
    },
    source, build,
    assertions: [
      { id: "dialog-status-and-error-announcements", status: "PASS",
        observation: "Dialog, progress, and error were announced." },
      { id: "manifest-policy-comprehension", status: "PASS",
        observation: "Scope and export policy were understandable." },
      { id: "preview-table-navigation", status: "PASS",
        observation: "Table headers and cells were navigable." },
      { id: "formula-neutralization-disclosure", status: "PASS",
        observation: "Formula neutralization was announced." },
      { id: "controls-names-states-and-keyboard", status: "PASS",
        observation: "Controls exposed clear names and states." },
      { id: "focus-trap-and-restoration", status: "PASS",
        observation: "Focus stayed contained and returned." },
      { id: "current-view-and-record-journeys", status: "PASS",
        observation: "Both required journeys completed." },
    ].map((assertion, index) => ({ ...assertion, performedAt: "2026-09-06T00:00:00.000Z", artifact: sourceArtifact,
      locator: `transcript-lines:${index * 3 + 1}-${index * 3 + 3}` })),
    artifact: sourceArtifact,
  };
  const manualOptions = { source, build, outputDirectory, sourceDirectory: repositoryRoot };
  const input = join(root, "manual.json");
  await writeFile(input, `${JSON.stringify(manual)}\n`);
  const ingested = await evidenceLib.ingestManualScreenReaderEvidence(input, manualOptions);
  assert.equal(ingested.screenReader.status, "PASS");
  assert.equal(ingested.artifact.file, "manual-screen-reader/nvda-transcript.txt");
  assert.deepEqual(await readFile(join(outputDirectory, ingested.artifact.file)), transcript);
  assert.deepEqual(ingested.screenReader.artifact, ingested.artifact);
  assert.ok(ingested.screenReader.assertions.every(assertion =>
    JSON.stringify(assertion.artifact) === JSON.stringify(ingested.artifact)));
  const unavailable = await evidenceLib.ingestManualScreenReaderEvidence(undefined, {
    source, build, outputDirectory,
  });
  assert.equal(unavailable.screenReader.status, "UNAVAILABLE");
  assert.equal(unavailable.artifact, null);
  await writeFile(input, `${JSON.stringify({
    ...manual, assertions: manual.assertions.map((assertion, index) =>
      index === 0 ? { ...assertion, locator: "transcript-lines:999-1000" } : assertion),
  })}\n`);
  await assert.rejects(evidenceLib.ingestManualScreenReaderEvidence(input, manualOptions), /locator/i);
  await writeFile(input, `${JSON.stringify({
    ...manual, procedure: { ...manual.procedure, sha256: digest("wrong-procedure") },
  })}\n`);
  await assert.rejects(evidenceLib.ingestManualScreenReaderEvidence(input, manualOptions), /procedure/i);
  const missingMarker = Buffer.from(transcript.toString("utf8")
    .replace("[dialog-status-and-error-announcements]", "[missing-marker]"));
  await writeFile(join(root, "nvda-transcript.txt"), missingMarker);
  await writeFile(input, `${JSON.stringify({
    ...manual,
    artifact: { ...sourceArtifact, bytes: missingMarker.byteLength,
      sha256: sha256Evidence(missingMarker) },
    assertions: manual.assertions.map(assertion => ({ ...assertion,
      artifact: { ...sourceArtifact, bytes: missingMarker.byteLength,
        sha256: sha256Evidence(missingMarker) } })),
  })}\n`);
  await assert.rejects(evidenceLib.ingestManualScreenReaderEvidence(input, manualOptions), /assertion segment/i);
  await writeFile(join(root, "nvda-transcript.txt"), transcript);
  await writeFile(input, `${JSON.stringify({
    ...manual, assertions: ["opened", "heard text", "closed"],
  })}\n`);
  await assert.rejects(evidenceLib.ingestManualScreenReaderEvidence(input, manualOptions), /assertions|array|string/i);
  await writeFile(input, `${JSON.stringify({
    ...manual, source: { ...source, tree: "d".repeat(40) },
  })}\n`);
  await assert.rejects(evidenceLib.ingestManualScreenReaderEvidence(input, manualOptions), /source/i);
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

test("PDF content-stream text exactly matches the complete normalized print document", () => {
  const text = "\fReport heading\n3 rows × 2 fields · Complete, no truncation\nCurrent view\nTITLE\nBrightLab\nexpansion\nHarbor\nCafe\nsetup\n=1+1\n2026-\n09-\n10\n";
  const expected = ["Report heading", "3 rows × 2 fields · Complete, no truncation",
    "Current view", "TITLE", "BrightLab expansion", "Harbor Cafe setup", "=1+1", "2026-09-10"];
  assert.equal(evidenceLib.pdfTextMatchesExactSequence(text, expected), true);
  assert.equal(evidenceLib.pdfTextMatchesExactSequence(`Unexpected\n${text}`, expected), false);
  assert.equal(evidenceLib.pdfTextMatchesExactSequence(text,
    ["Report heading", "3 rows × 2 fields · Complete, no truncation", "Current view",
      "TITLE", "Harbor Cafe setup", "BrightLab expansion", "=1+1", "2026-09-10"]), false);
  assert.equal(evidenceLib.pdfTextMatchesExactSequence("\fＴＩＴＬＥ\n", ["TITLE"]), false);
});

test("preview cleanup settles when termination emits exit synchronously", async () => {
  class ImmediateExitChild extends EventEmitter {
    exitCode = null;
    signals = [];
    kill(signal) {
      this.signals.push(signal);
      this.exitCode = 0;
      this.emit("exit", 0, signal);
      return true;
    }
  }
  const child = new ImmediateExitChild();
  await Promise.race([
    evidenceLib.stopChildProcess(child, 10),
    new Promise((_, reject) => setTimeout(() => reject(new Error("cleanup remained unsettled")), 100)),
  ]);
  assert.deepEqual(child.signals, ["SIGTERM"]);
});

test("worktree cleanup trusts only exact absent-and-unregistered readback", () => {
  const checkout = "C:/Temp/clay certificate/source";
  assert.equal(evidenceLib.worktreeRemovalComplete(checkout, false,
    "worktree C:/repo\nHEAD aaaa\ndetached\n"), true);
  assert.equal(evidenceLib.worktreeRemovalComplete(checkout, true, ""), false);
  assert.equal(evidenceLib.worktreeRemovalComplete(checkout, false,
    `worktree ${checkout}\nHEAD bbbb\ndetached\n`), false);
});
