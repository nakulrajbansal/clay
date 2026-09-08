import { describe, expect, it } from "vitest";
import {
  BenchmarkEvidenceManifestV1,
  LocalExportEvidenceManifestV2,
  LOCAL_EXPORT_REQUIRED_REQUIREMENTS_V2,
  ManualScreenReaderEvidenceV1,
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
  fixture: { harnessSha256: digest, harnessBytes: 2048, fields: 30,
    rows: [1000, 5000], nearLimitPlaintextBytes: 8_000_000 },
  maximumPrint: {
    artifact: { file: "maximum-print.pdf", bytes: 123, sha256: digest },
    rows: 5000, fields: 30, previewRows: 100, renderedCells: 150_000,
    maxCellsPerTask: 600, sheets: 272, responsiveBeforePrint: true,
    extractedSha256: digest, exact: true,
  },
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
      incrementalMemoryBytes: 100, inputBytes: 200, outputBytes: 50, plaintextBytes: 1_600_000 },
    { rows: 1000, classification: "warm", operation: "csv", milliseconds: 8,
      incrementalMemoryBytes: 80, inputBytes: 200, outputBytes: 50, plaintextBytes: 1_600_000 },
    { rows: 5000, classification: "cold", operation: "owner-preview", milliseconds: 30,
      incrementalMemoryBytes: 200, inputBytes: 500, outputBytes: 100, plaintextBytes: 8_000_000 },
    { rows: 5000, classification: "warm", operation: "owner-preview", milliseconds: 20,
      incrementalMemoryBytes: 150, inputBytes: 500, outputBytes: 100, plaintextBytes: 8_000_000 },
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

const textScaleSurfaces = [
  "body", ".dataview", ".appbar-menu", ".appbar-theme-menu", ".export-dialog",
].map((surface, index) => ({
  surface,
  coverage: {
    textNodes: 8, formControls: 3,
    placeholderControls: surface === ".dataview" ? 1 : 0,
    selectedOptions: surface === ".dataview" ? 1 : 0,
    pseudoElements: index === 0 ? 1 : 0,
  },
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
  liveProgress: { status: "PASS", role: "status", announcement: "Building a complete local preview…" },
  errorLinkage: { status: "PASS", role: "alert", describedBy: "export-dialog-error" },
  printReadingOrder: { status: "PASS", method: "PDF tagged-text extraction",
    artifact: "desktop-print.pdf", extractedSha256: digest },
  adaptations: { status: "PASS", assertions: ["forced colors", "reduced motion", "text spacing"] },
} as const;

const manualArtifact = {
  file: "manual-screen-reader/nvda-speech-viewer.txt",
  bytes: 512,
  sha256: digest,
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
  procedure: {
    id: "release-f-manual-screen-reader",
    version: 1,
    sha256: digest,
  },
  source,
  build,
  assertions: [
    { id: "dialog-status-and-error-announcements", status: "PASS",
      observation: "The named dialog, loading status, and linked error alert were announced." },
    { id: "manifest-policy-comprehension", status: "PASS",
      observation: "Scope, exclusions, relations, redactions, and completeness were understood." },
    { id: "preview-table-navigation", status: "PASS",
      observation: "Headers, cells, and row order were navigable and associated." },
    { id: "formula-neutralization-disclosure", status: "PASS",
      observation: "Spreadsheet formula neutralization was announced before download." },
    { id: "controls-names-states-and-keyboard", status: "PASS",
      observation: "Every policy and action exposed a clear name, state, and keyboard operation." },
    { id: "focus-trap-and-restoration", status: "PASS",
      observation: "Focus stayed inside the dialog and returned to its invoking control." },
    { id: "current-view-and-record-journeys", status: "PASS",
      observation: "Both view and record journeys completed without a trap or ambiguous action." },
  ].map((assertion, index) => ({ ...assertion, performedAt: "2026-09-06T00:00:00.000Z", artifact: manualArtifact,
    locator: `transcript-lines:${index * 3 + 1}-${index * 3 + 3}` })),
  artifact: manualArtifact,
} as const;

const requiredArtifactNames = [
  "accessibility-tree.json", "current-view.csv", "record.csv",
  "desktop-current-view.png", "desktop-print-media.png", "desktop-print.pdf",
  "desktop-record.png", "mobile-320px-200pct.png",
] as const;

const localExport = {
  schema: "LocalExportEvidenceManifestV2",
  generatedAt: "2026-09-06T00:00:00.000Z",
  source,
  build,
  browser: { name: "chromium", version: "140.0", headless: true },
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
        csv: { bytes: 123, sha256: digest, rows: 1, fields: 1, exact: true } },
      record: { id: "018f0000-0000-7000-8000-000000000001",
        headings: ["Title"], rows: [["Example"]],
        csv: { bytes: 123, sha256: digest }, csvExact: true, printCalls: 1 },
      print: { artifact: "desktop-print.pdf", extractedSha256: digest, exact: true },
      opfsUnchanged: true, historyUnchanged: true, axeBlocking: 0,
    },
    mobile: {
      viewport: { width: 320, height: 800 }, textScalePercent: 200,
      surfaces: textScaleSurfaces, horizontalDocumentOverflow: false,
      dialogFitsViewport: true, appMenuReachable: true, themeMenuReachable: true,
      keyboardAssertions: ["tab route", "forward wrap", "reverse wrap", "inert outside",
        "Space closes", "focus returns", "Escape returns"],
      actionsReachable: true, axeBlocking: 0,
    },
    network: {
      desktopExportRequests: 0, recordExportRequests: 0, mobileExportRequests: 0,
      desktopActions: ["csv", "print"], recordActions: ["csv", "print"],
      desktopWebSockets: 0, recordWebSockets: 0,
      desktopBlobUrls: 1, recordBlobUrls: 1,
      desktopDownloadBlobUrls: 1, recordDownloadBlobUrls: 1,
      unexpected: [],
    },
  },
  cases: [
    "current-view-preview-exact", "current-view-csv-exact", "print-document-exact",
    "record-preview-exact", "record-actions-exact", "network-local-only",
    "durable-state-unchanged", "mobile-reflow", "mobile-controls-reachable",
    "keyboard-complete", "automated-accessibility",
  ].map(id => ({ id, status: "PASS" })),
  errors: [],
  artifacts: requiredArtifactNames.map(file => ({ file, bytes: 123, sha256: digest })),
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
  artifacts: [
    ...requiredArtifactNames.map(file => ({
      file: `runtime/${file}`, bytes: 123, sha256: digest,
    })),
    { file: "maximum-print.pdf", bytes: 123, sha256: digest },
  ],
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
    expect(LocalExportEvidenceManifestV2.safeParse({
      ...localExport,
      accessibility: {
        ...accessibility,
        reflow320At200Percent: {
          ...accessibility.reflow320At200Percent,
          surfaces: textScaleSurfaces.slice(1),
        },
      },
    }).success).toBe(false);
    expect(LocalExportEvidenceManifestV2.safeParse({
      ...localExport,
      accessibility: {
        ...accessibility,
        reflow320At200Percent: {
          ...accessibility.reflow320At200Percent,
          surfaces: textScaleSurfaces.map(surface => surface.surface === ".dataview"
            ? { ...surface, scaledTextNodes: surface.scaledTextNodes - 1 } : surface),
        },
      },
    }).success).toBe(false);
  });

  it("requires the exact automated artifact inventory and accessibility references", () => {
    for (const missing of requiredArtifactNames) expect(LocalExportEvidenceManifestV2.safeParse({
      ...localExport,
      artifacts: localExport.artifacts.filter(artifact => artifact.file !== missing),
    }).success).toBe(false);
    expect(LocalExportEvidenceManifestV2.safeParse({
      ...localExport,
      cases: localExport.cases.slice(1),
    }).success).toBe(false);
    expect(LocalExportEvidenceManifestV2.safeParse({
      ...localExport,
      cases: localExport.cases.map((item, index) =>
        index === 0 ? { ...item, status: "FAIL" } : item),
      verdict: "BLOCKED",
    }).success).toBe(false);
    expect(LocalExportEvidenceManifestV2.safeParse({
      ...localExport,
      requirements: localExport.requirements.slice(1),
    }).success).toBe(false);
    expect(LocalExportEvidenceManifestV2.safeParse({
      ...localExport,
      requirements: [...localExport.requirements].reverse(),
    }).success).toBe(false);
    expect(LocalExportEvidenceManifestV2.safeParse({
      ...localExport,
      accessibility: { ...accessibility,
        accessibilityTree: { ...accessibility.accessibilityTree, artifact: "missing.json" } },
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

  it("rejects manual PASS without timestamped per-step proof", () => {
    const weak = {
      ...manualScreenReaderPass,
      assertions: manualScreenReaderPass.assertions.map(({ id, status, observation }) =>
        ({ id, status, observation })),
    };
    expect(ManualScreenReaderEvidenceV1.safeParse(weak).success).toBe(false);
  });

  it("accepts only a source/build-bound manual NVDA or VoiceOver PASS with inventoried proof", () => {
    const passing = {
      ...localExport,
      artifacts: [...localExport.artifacts, manualScreenReaderPass.artifact],
      accessibility: { ...accessibility, screenReader: manualScreenReaderPass },
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
    expect(LocalExportEvidenceManifestV2.safeParse({
      ...passing,
      accessibility: {
        ...passing.accessibility,
        screenReader: { ...manualScreenReaderPass,
          assertions: ["opened", "heard text", "closed"] },
      },
    }).success).toBe(false);
    expect(LocalExportEvidenceManifestV2.safeParse({
      ...passing,
      accessibility: {
        ...passing.accessibility,
        screenReader: { ...manualScreenReaderPass,
          assertions: manualScreenReaderPass.assertions.slice(0, 6) },
      },
    }).success).toBe(false);
    expect(LocalExportEvidenceManifestV2.safeParse({
      ...passing,
      accessibility: {
        ...passing.accessibility,
        screenReader: { ...manualScreenReaderPass,
          assertions: manualScreenReaderPass.assertions.map((assertion, index) =>
            index === 6 ? manualScreenReaderPass.assertions[0] : assertion) },
      },
    }).success).toBe(false);
  });

  it("rejects content-free or chronologically invalid manual PASS evidence", () => {
    const rejected = [
      { ...manualScreenReaderPass, platform: "macOS 15" },
      { ...manualScreenReaderPass,
        assertions: manualScreenReaderPass.assertions.map((item, index) =>
          index === 0 ? { ...item, observation: "   " } : item) },
      { ...manualScreenReaderPass,
        assertions: manualScreenReaderPass.assertions.map((item, index) =>
          index === 1 ? { ...item, locator: manualScreenReaderPass.assertions[0]!.locator } : item) },
      { ...manualScreenReaderPass, performedAt: "2999-01-01T00:00:00.000Z" },
      { ...manualScreenReaderPass, artifact: { ...manualArtifact, bytes: 1 },
        assertions: manualScreenReaderPass.assertions.map(item => ({
          ...item, artifact: { ...manualArtifact, bytes: 1 },
        })) },
    ];
    for (const candidate of rejected)
      expect(ManualScreenReaderEvidenceV1.safeParse(candidate).success).toBe(false);
  });
});
