import { describe, expect, it } from "vitest";
import {
  BenchmarkEvidenceManifestV1,
  LocalExportEvidenceManifestV2,
  ReleaseEvidenceManifestV1,
} from "../src/evidence";

const digest = `sha256:${"a".repeat(64)}`;
const commit = "b".repeat(40);
const tree = "c".repeat(40);
const source = { commit, tree };
const build = { sha256: digest, bytes: 123, files: 4 };

const benchmark = {
  schema: "BenchmarkEvidenceManifestV1",
  generatedAt: "2026-09-06T00:00:00.000Z",
  source,
  build,
  browser: { name: "chromium", version: "140.0", headless: true },
  path: "browser-worker-rpc-owner-preview",
  fixture: { harnessSha256: digest, harnessBytes: 2048, fields: 1, rows: [1000, 5000] },
  methodology: {
    clock: "performance.now",
    percentile: "nearest-rank-p95",
    warmupRuns: 2,
    sampleRuns: 30,
    coldDefinition: "fresh browser context, worker, imported fixture, and first projection",
    warmDefinition: "same worker and fixture after declared warm-up projections",
    memory: "measureUserAgentSpecificMemory peak sampling",
  },
  limits: {
    rows1000CsvP95Ms: 1000,
    rows5000CsvP95Ms: 2000,
    rows5000PreviewP95Ms: 4000,
    cancelMs: 250,
    incrementalMemoryBytes: 64 * 1024 * 1024,
  },
  samples: [
    { rows: 1000, classification: "cold", operation: "csv", milliseconds: 10,
      incrementalMemoryBytes: 100, inputBytes: 200, outputBytes: 50 },
    { rows: 1000, classification: "warm", operation: "csv", milliseconds: 8,
      incrementalMemoryBytes: 80, inputBytes: 200, outputBytes: 50 },
    { rows: 5000, classification: "cold", operation: "owner-preview", milliseconds: 30,
      incrementalMemoryBytes: 200, inputBytes: 500, outputBytes: 100 },
    { rows: 5000, classification: "warm", operation: "owner-preview", milliseconds: 20,
      incrementalMemoryBytes: 150, inputBytes: 500, outputBytes: 100 },
  ],
  results: {
    rows1000CsvP95Ms: 8,
    rows5000CsvP95Ms: 12,
    rows5000PreviewP95Ms: 20,
    cancelP95Ms: 5,
    peakIncrementalMemoryBytes: 200,
  },
  rawResultsSha256: digest,
  verdict: "PASS",
} as const;

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
  liveProgress: { status: "PASS", role: "status", announcement: "Building a complete local preview…" },
  errorLinkage: { status: "PASS", role: "alert", describedBy: "export-dialog-error" },
  printReadingOrder: { status: "PASS", method: "PDF tagged-text extraction",
    artifact: "desktop-print.pdf", extractedSha256: digest },
  adaptations: { status: "PASS", assertions: ["forced colors", "reduced motion", "text spacing"] },
} as const;

const manualScreenReaderPass = {
  status: "PASS",
  mode: "manual",
  product: "NVDA",
  productVersion: "2026.1",
  platform: "Windows 11",
  performedAt: "2026-09-06T00:00:00.000Z",
  tester: "Release accessibility tester",
  method: "Manual NVDA run with Speech Viewer transcript capture",
  source,
  build,
  assertions: [
    "The named export dialog and description were announced.",
    "The loading status was announced without moving focus.",
    "The linked projection error and recovery action were announced.",
  ],
  artifact: {
    file: "manual-screen-reader/nvda-speech-viewer.txt",
    bytes: 123,
    sha256: digest,
  },
} as const;

const localExport = {
  schema: "LocalExportEvidenceManifestV2",
  generatedAt: "2026-09-06T00:00:00.000Z",
  source,
  build,
  browser: { name: "chromium", version: "140.0", headless: true },
  url: "http://127.0.0.1:4173",
  requirements: ["F-AT-030", "F-AT-060"],
  exclusions: ["manual screen-reader evidence unavailable"],
  observations: { desktop: {}, mobile: {}, network: {} },
  checks: [{ ok: true, label: "local" }],
  errors: [],
  artifacts: [{ file: "desktop-print.pdf", bytes: 123, sha256: digest }],
  accessibility,
  verdict: "BLOCKED",
} as const;

const release = {
  schema: "ReleaseEvidenceManifestV1",
  generatedAt: "2026-09-06T00:00:00.000Z",
  source,
  reports: [
    { file: "runtime/report.json", schema: "LocalExportEvidenceManifestV2", sha256: digest },
    { file: "benchmark.json", schema: "BenchmarkEvidenceManifestV1", sha256: digest },
  ],
  artifacts: [{ file: "runtime/desktop-print.pdf", bytes: 123, sha256: digest }],
  verdict: "BLOCKED",
} as const;

describe("closed Release F evidence schemas", () => {
  it("accepts complete browser benchmark, accessibility, and outer release manifests", () => {
    expect(BenchmarkEvidenceManifestV1.parse(benchmark)).toEqual(benchmark);
    expect(LocalExportEvidenceManifestV2.parse(localExport)).toEqual(localExport);
    expect(ReleaseEvidenceManifestV1.parse(release)).toEqual(release);
  });

  it.each([
    [BenchmarkEvidenceManifestV1, benchmark],
    [LocalExportEvidenceManifestV2, localExport],
    [ReleaseEvidenceManifestV1, release],
  ])("rejects unknown top-level keys", (schema, value) => {
    expect(schema.safeParse({ ...value, unbound: true }).success).toBe(false);
  });

  it("rejects a benchmark that omits cold/warm classification or measured memory", () => {
    expect(BenchmarkEvidenceManifestV1.safeParse({
      ...benchmark,
      samples: benchmark.samples.filter(sample => sample.classification === "warm"),
    }).success).toBe(false);
    expect(BenchmarkEvidenceManifestV1.safeParse({
      ...benchmark,
      results: { ...benchmark.results, peakIncrementalMemoryBytes: undefined },
    }).success).toBe(false);
  });

  it("requires explicit 200% text scaling at 320 CSS px", () => {
    expect(LocalExportEvidenceManifestV2.safeParse({
      ...localExport,
      accessibility: {
        ...accessibility,
        reflow320At200Percent: {
          ...accessibility.reflow320At200Percent,
          textScalePercent: 199,
        },
      },
    }).success).toBe(false);
    expect(LocalExportEvidenceManifestV2.safeParse({
      ...localExport,
      accessibility: {
        ...accessibility,
        reflow320At200Percent: { ...accessibility.reflow320At200Percent, viewportWidth: 390 },
      },
    }).success).toBe(false);
    const { textScalePercent: _textScalePercent, ...legacyReflow } =
      accessibility.reflow320At200Percent;
    expect(LocalExportEvidenceManifestV2.safeParse({
      ...localExport,
      accessibility: {
        ...accessibility,
        reflow320At200Percent: { ...legacyReflow, zoomPercent: 200 },
      },
    }).success).toBe(false);
    expect(LocalExportEvidenceManifestV2.safeParse({
      ...localExport,
      accessibility: {
        ...accessibility,
        reflow320At200Percent: {
          ...accessibility.reflow320At200Percent,
          scaledTextNodes: accessibility.reflow320At200Percent.renderedTextNodes - 1,
        },
      },
    }).success).toBe(false);
    expect(LocalExportEvidenceManifestV2.safeParse({
      ...localExport,
      accessibility: {
        ...accessibility,
        reflow320At200Percent: {
          ...accessibility.reflow320At200Percent,
          representativeFontSizes: [
            { label: "fixed pixel descendant", beforeCssPixels: 12, afterCssPixels: 12 },
            ...accessibility.reflow320At200Percent.representativeFontSizes.slice(1),
          ],
        },
      },
    }).success).toBe(false);
  });

  it("keeps unavailable manual screen-reader evidence from receiving a PASS verdict", () => {
    const passResult = LocalExportEvidenceManifestV2.safeParse({
      ...localExport,
      verdict: "PASS",
    });
    expect(passResult.success).toBe(false);
    if (!passResult.success) expect(passResult.error.issues.some(issue =>
      issue.path[0] === "verdict" && /screen-reader/i.test(issue.message))).toBe(true);
    expect(LocalExportEvidenceManifestV2.safeParse({
      ...localExport,
      accessibility: {
        ...accessibility,
        screenReader: { ...accessibility.screenReader, mode: "accessibility-tree" },
      },
    }).success).toBe(false);
  });

  it("accepts only a source/build-bound manual NVDA or VoiceOver PASS with an inventoried artifact", () => {
    const passing = {
      ...localExport,
      artifacts: [...localExport.artifacts, manualScreenReaderPass.artifact],
      accessibility: { ...accessibility, screenReader: manualScreenReaderPass },
      exclusions: [],
      verdict: "PASS",
    } as const;
    expect(LocalExportEvidenceManifestV2.parse(passing)).toEqual(passing);
    expect(LocalExportEvidenceManifestV2.safeParse({
      ...passing,
      accessibility: {
        ...passing.accessibility,
        screenReader: {
          ...manualScreenReaderPass,
          source: { ...source, tree: "d".repeat(40) },
        },
      },
    }).success).toBe(false);
    expect(LocalExportEvidenceManifestV2.safeParse({
      ...passing,
      accessibility: {
        ...passing.accessibility,
        screenReader: {
          ...manualScreenReaderPass,
          build: { ...build, sha256: `sha256:${"e".repeat(64)}` },
        },
      },
    }).success).toBe(false);
    expect(LocalExportEvidenceManifestV2.safeParse({
      ...passing,
      artifacts: localExport.artifacts,
    }).success).toBe(false);
    expect(LocalExportEvidenceManifestV2.safeParse({
      ...passing,
      accessibility: {
        ...passing.accessibility,
        screenReader: { ...manualScreenReaderPass, product: "JAWS" },
      },
    }).success).toBe(false);
  });
});
