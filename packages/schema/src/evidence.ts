import { z } from "./validation-runtime";

const Sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const GitObject = z.string().regex(/^[0-9a-f]{40}$/);
const IsoInstant = z.string().datetime({ offset: true });
const RelativeFile = z.string().min(1).max(240).refine(value =>
  !value.startsWith("/") && !value.startsWith("\\")
    && !value.includes("\\") && !value.split("/").includes(".."),
"must be a normalized repository-relative path");
const NonNegativeFinite = z.number().finite().nonnegative();
const PositiveFinite = z.number().finite().positive();
const PositiveInteger = z.number().int().positive();

export const EvidenceSourceV1 = z.object({
  commit: GitObject,
  tree: GitObject,
}).strict();

export const EvidenceBuildV1 = z.object({
  sha256: Sha256,
  bytes: PositiveInteger,
  files: PositiveInteger,
}).strict();

export const EvidenceArtifactV1 = z.object({
  file: RelativeFile,
  bytes: PositiveInteger,
  sha256: Sha256,
}).strict();

export const LOCAL_EXPORT_REQUIRED_REQUIREMENTS_V2 = [
  "F-FR-070", "F-FR-071", "F-FR-072", "F-FR-073", "F-FR-074",
  "F-FR-075", "F-FR-076", "F-FR-078", "F-FR-079", "F-NFR-037",
  "F-NFR-040", "F-NFR-041", "F-NFR-043", "F-NFR-049", "F-NFR-051",
  "F-GATE-010",
] as const;
const RequiredLocalExportRequirementsV2 = z.array(
  z.enum(LOCAL_EXPORT_REQUIRED_REQUIREMENTS_V2),
).length(LOCAL_EXPORT_REQUIRED_REQUIREMENTS_V2.length).refine(value =>
  value.every((requirement, index) => requirement === LOCAL_EXPORT_REQUIRED_REQUIREMENTS_V2[index]),
"requirements must be the exact ordered Release F set");

const ReleaseFGateOutcomesV2 = z.tuple([
  z.object({ id: z.literal("local-print-csv"), status: z.literal("PASS") }).strict(),
  z.object({ id: z.literal("direct-pdf"), status: z.literal("NOT_SHIPPED") }).strict(),
  z.object({ id: z.literal("hosted-encrypted-snapshots"),
    status: z.literal("NOT_SHIPPED") }).strict(),
  z.object({ id: z.literal("hosted-public-intake"),
    status: z.literal("NOT_SHIPPED") }).strict(),
  z.object({ id: z.literal("hosted-file-requests"),
    status: z.literal("NOT_SHIPPED") }).strict(),
]);

export const LOCAL_EXPORT_REQUIRED_ARTIFACTS_V2 = [
  "accessibility-tree.json", "current-view.csv", "record.csv",
  "desktop-current-view.png", "desktop-print-media.png", "desktop-print.pdf",
  "desktop-record.png", "mobile-320px-200pct.png",
] as const;

const BenchmarkSampleV1 = z.object({
  rows: z.union([z.literal(1000), z.literal(5000)]),
  classification: z.enum(["cold", "warm"]),
  operation: z.enum(["csv", "owner-preview", "cancel"]),
  milliseconds: NonNegativeFinite,
  incrementalMemoryBytes: z.number().int().nonnegative(),
  inputBytes: z.number().int().nonnegative(),
  outputBytes: z.number().int().nonnegative(),
  plaintextBytes: z.number().int().nonnegative(),
}).strict();

const MaximumPrintEvidenceV1 = z.object({
  artifact: z.object({
    file: z.literal("maximum-print.pdf"),
    bytes: PositiveInteger,
    sha256: Sha256,
  }).strict(),
  rows: z.literal(5000),
  fields: z.literal(30),
  previewRows: z.literal(100),
  renderedCells: z.literal(150_000),
  maxCellsPerTask: z.literal(600),
  sheets: z.literal(272),
  responsiveBeforePrint: z.literal(true),
  extractedSha256: Sha256,
  exact: z.literal(true),
}).strict();

export const BenchmarkEvidenceManifestV1 = z.object({
  schema: z.literal("BenchmarkEvidenceManifestV1"),
  generatedAt: IsoInstant,
  source: EvidenceSourceV1,
  build: EvidenceBuildV1,
  browser: z.object({
    name: z.literal("chromium"),
    version: z.string().min(1).max(120),
    headless: z.boolean(),
  }).strict(),
  path: z.literal("browser-worker-rpc-owner-preview"),
  fixture: z.object({
    harnessSha256: Sha256,
    harnessBytes: PositiveInteger,
    fields: z.literal(30),
    rows: z.tuple([z.literal(1000), z.literal(5000)]),
    nearLimitPlaintextBytes: z.number().int().min(7_800_000).max(8 * 1024 * 1024),
  }).strict(),
  maximumPrint: MaximumPrintEvidenceV1,
  methodology: z.object({
    clock: z.literal("performance.now"),
    percentile: z.literal("nearest-rank-p95"),
    warmupRuns: z.literal(2),
    sampleRuns: z.literal(30),
    coldDefinition: z.string().min(1).max(500),
    warmDefinition: z.string().min(1).max(500),
    memory: z.string().min(1).max(500),
  }).strict(),
  limits: z.object({
    rows1000CsvP95Ms: z.literal(1000),
    rows5000CsvP95Ms: z.literal(2000),
    rows5000PreviewP95Ms: z.literal(4000),
    cancelMs: z.literal(250),
    incrementalMemoryBytes: z.literal(64 * 1024 * 1024),
  }).strict(),
  samples: z.array(BenchmarkSampleV1).min(4).max(1_000),
  results: z.object({
    rows1000CsvP95Ms: NonNegativeFinite,
    rows5000CsvP95Ms: NonNegativeFinite,
    rows5000PreviewP95Ms: NonNegativeFinite,
    cancelP95Ms: NonNegativeFinite,
    peakIncrementalMemoryBytes: z.number().int().nonnegative(),
  }).strict(),
  rawResultsSha256: Sha256,
  verdict: z.enum(["PASS", "FAIL"]),
}).strict().superRefine((value, context) => {
  const nearLimitObserved = Math.max(...value.samples
    .filter(sample => sample.rows === 5000 && sample.operation !== "cancel")
    .map(sample => sample.plaintextBytes));
  if (nearLimitObserved !== value.fixture.nearLimitPlaintextBytes) context.addIssue({
    code: z.ZodIssueCode.custom,
    path: ["fixture", "nearLimitPlaintextBytes"],
    message: "near-limit fixture bytes must match observed 5,000-row plaintext",
  });
  const classes = new Set(value.samples.map(sample => sample.classification));
  for (const classification of ["cold", "warm"] as const) {
    if (!classes.has(classification)) context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["samples"],
      message: `missing ${classification} benchmark sample`,
    });
  }
});

export const MANUAL_SCREEN_READER_ASSERTION_IDS_V1 = [
  "dialog-status-and-error-announcements",
  "manifest-policy-comprehension",
  "preview-table-navigation",
  "formula-neutralization-disclosure",
  "controls-names-states-and-keyboard",
  "focus-trap-and-restoration",
  "current-view-and-record-journeys",
] as const;
export const ManualScreenReaderAssertionIdV1 =
  z.enum(MANUAL_SCREEN_READER_ASSERTION_IDS_V1);

const MeaningfulText = (minimum: number, maximum: number) =>
  z.string().trim().min(minimum).max(maximum);
const ManualTranscriptArtifactV1 = EvidenceArtifactV1.extend({
  file: RelativeFile.refine(value => value.endsWith(".txt"),
    "manual screen-reader proof must be a UTF-8 transcript"),
  bytes: z.number().int().min(256),
}).strict();
const TranscriptLocatorV1 = z.string()
  .regex(/^transcript-lines:[1-9][0-9]{0,5}-[1-9][0-9]{0,5}$/);

function manualScreenReaderAssertion(id: typeof MANUAL_SCREEN_READER_ASSERTION_IDS_V1[number]) {
  return z.object({
    id: z.literal(id),
    status: z.literal("PASS"),
    observation: MeaningfulText(20, 1_000),
    performedAt: IsoInstant,
    artifact: ManualTranscriptArtifactV1,
    locator: TranscriptLocatorV1,
  }).strict();
}

const ManualScreenReaderAssertionsV1 = z.tuple([
  manualScreenReaderAssertion("dialog-status-and-error-announcements"),
  manualScreenReaderAssertion("manifest-policy-comprehension"),
  manualScreenReaderAssertion("preview-table-navigation"),
  manualScreenReaderAssertion("formula-neutralization-disclosure"),
  manualScreenReaderAssertion("controls-names-states-and-keyboard"),
  manualScreenReaderAssertion("focus-trap-and-restoration"),
  manualScreenReaderAssertion("current-view-and-record-journeys"),
]);

export const ManualScreenReaderEvidenceV1 = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("UNAVAILABLE"),
    mode: z.literal("manual"),
    products: z.tuple([z.literal("NVDA"), z.literal("VoiceOver")]),
    reason: z.string().min(1).max(500),
  }).strict(),
  z.object({
    status: z.literal("PASS"),
    mode: z.literal("manual"),
    product: z.enum(["NVDA", "VoiceOver"]),
    productVersion: MeaningfulText(2, 120),
    platform: MeaningfulText(3, 120),
    performedAt: IsoInstant,
    tester: MeaningfulText(3, 200),
    method: MeaningfulText(20, 500),
    procedure: z.object({
      id: z.literal("release-f-manual-screen-reader"),
      version: z.literal(1),
      sha256: Sha256,
    }).strict(),
    source: EvidenceSourceV1,
    build: EvidenceBuildV1,
    assertions: ManualScreenReaderAssertionsV1,
    notes: MeaningfulText(1, 2_000).optional(),
    artifact: ManualTranscriptArtifactV1,
  }).strict(),
]).superRefine((value, context) => {
  if (value.status !== "PASS") return;
  if ((value.product === "NVDA" && !/^Windows(?:\s|$)/i.test(value.platform))
      || (value.product === "VoiceOver" && !/^macOS(?:\s|$)/i.test(value.platform)))
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["platform"],
      message: "screen-reader product and platform are incompatible" });
  const startedAt = Date.parse(value.performedAt);
  const latestAllowed = Date.now() + 5 * 60_000;
  if (startedAt > latestAllowed) context.addIssue({ code: z.ZodIssueCode.custom,
    path: ["performedAt"], message: "manual session cannot start in the future" });
  const locators = new Set<string>();
  let previous = startedAt;
  value.assertions.forEach((assertion, index) => {
    const at = Date.parse(assertion.performedAt);
    if (at < startedAt || at < previous || at > startedAt + 4 * 60 * 60_000
        || at > latestAllowed) context.addIssue({ code: z.ZodIssueCode.custom,
      path: ["assertions", index, "performedAt"],
      message: "manual assertion chronology is invalid" });
    previous = at;
    if (locators.has(assertion.locator)) context.addIssue({ code: z.ZodIssueCode.custom,
      path: ["assertions", index, "locator"], message: "manual locators must be unique" });
    locators.add(assertion.locator);
    if (assertion.artifact.file !== value.artifact.file
        || assertion.artifact.bytes !== value.artifact.bytes
        || assertion.artifact.sha256 !== value.artifact.sha256)
      context.addIssue({ code: z.ZodIssueCode.custom,
        path: ["assertions", index, "artifact"],
        message: "every manual assertion must bind the complete session transcript" });
  });
});

const TextScaleSurfaceV1 = z.object({
  surface: z.enum(["body", ".dataview", ".appbar-menu", ".appbar-theme-menu", ".export-dialog"]),
  coverage: z.object({
    textNodes: z.number().int().nonnegative(),
    formControls: z.number().int().nonnegative(),
    placeholderControls: z.number().int().nonnegative(),
    selectedOptions: z.number().int().nonnegative(),
    pseudoElements: z.number().int().nonnegative(),
  }).strict(),
  renderedTextNodes: PositiveInteger,
  scaledTextNodes: PositiveInteger,
}).strict().superRefine((value, context) => {
  if (value.renderedTextNodes !== value.scaledTextNodes) context.addIssue({
    code: z.ZodIssueCode.custom,
    path: ["scaledTextNodes"],
    message: "every rendered item on the surface must be scaled",
  });
  if (value.coverage.textNodes + value.coverage.formControls
      + value.coverage.pseudoElements !== value.renderedTextNodes
      || value.coverage.placeholderControls > value.coverage.formControls
      || value.coverage.selectedOptions > value.coverage.formControls) context.addIssue({
    code: z.ZodIssueCode.custom,
    path: ["coverage"],
    message: "surface text coverage does not match its measured items",
  });
});

export const AccessibilityEvidenceV1 = z.object({
  schema: z.literal("AccessibilityEvidenceV1"),
  axe: z.object({
    status: z.literal("PASS"),
    serious: z.literal(0),
    critical: z.literal(0),
    states: z.array(z.string().min(1).max(120)).min(3).max(100),
  }).strict(),
  keyboard: z.object({
    status: z.literal("PASS"),
    viewportWidth: z.literal(320),
    textScalePercent: z.literal(200),
    assertions: z.array(z.string().min(1).max(300)).min(3).max(100),
  }).strict(),
  reflow320At200Percent: z.object({
    status: z.literal("PASS"),
    viewportWidth: z.literal(320),
    textScalePercent: z.literal(200),
    method: z.literal("computed-font-size-per-rendered-text-node"),
    renderedTextNodes: PositiveInteger,
    scaledTextNodes: PositiveInteger,
    surfaces: z.array(TextScaleSurfaceV1).min(5).max(20),
    representativeFontSizes: z.array(z.object({
      label: z.string().min(1).max(120),
      beforeCssPixels: PositiveFinite,
      afterCssPixels: PositiveFinite,
    }).strict()).min(3).max(20),
    horizontalDocumentOverflow: z.literal(false),
    dialogFitsViewport: z.literal(true),
    targetReachability: z.object({
      status: z.literal("PASS"),
      actions: z.tuple([
        z.literal("Cancel"), z.literal("Download CSV"), z.literal("Print / Save as PDF"),
      ]),
      allReachable: z.literal(true),
    }).strict(),
    artifact: RelativeFile,
  }).strict().superRefine((value, context) => {
    const observedSurfaces = new Set(value.surfaces.map(surface => surface.surface));
    for (const required of [
      "body", ".dataview", ".appbar-menu", ".appbar-theme-menu", ".export-dialog",
    ] as const) if (!observedSurfaces.has(required)) context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["surfaces"],
      message: `missing 200% text surface ${required}`,
    });
    if (!value.surfaces.some(surface => surface.coverage.placeholderControls > 0)
        || !value.surfaces.some(surface => surface.coverage.selectedOptions > 0)) context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["surfaces"],
      message: "200% text evidence must cover placeholders and selected options",
    });
    if (value.renderedTextNodes !== value.scaledTextNodes) context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["scaledTextNodes"],
      message: "every rendered text node must be scaled",
    });
    value.representativeFontSizes.forEach((measurement, index) => {
      if (Math.abs(measurement.afterCssPixels - measurement.beforeCssPixels * 2) > 0.05)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["representativeFontSizes", index, "afterCssPixels"],
          message: "representative text must measure exactly 200% of its baseline size",
        });
    });
  }),
  screenReader: ManualScreenReaderEvidenceV1,
  accessibilityTree: z.object({
    status: z.literal("PASS"),
    browser: z.string().min(1).max(120),
    assertions: z.array(z.string().min(1).max(300)).min(4).max(100),
    artifact: RelativeFile,
  }).strict(),
  focusRestoration: z.object({
    status: z.literal("PASS"),
    restoredToTrigger: z.literal(true),
  }).strict(),
  liveProgress: z.object({
    status: z.literal("PASS"),
    role: z.literal("status"),
    announcement: z.string().min(1).max(300),
  }).strict(),
  errorLinkage: z.object({
    status: z.literal("PASS"),
    role: z.literal("alert"),
    describedBy: z.literal("export-dialog-error"),
  }).strict(),
  printReadingOrder: z.object({
    status: z.literal("PASS"),
    method: z.string().min(1).max(300),
    artifact: RelativeFile,
    extractedSha256: Sha256,
  }).strict(),
  adaptations: z.object({
    status: z.literal("PASS"),
    assertions: z.array(z.string().min(1).max(300)).min(3).max(100),
  }).strict(),
}).strict();

const EvidenceText = z.string().max(2_000);
const EvidenceStringMatrix = z.array(z.array(EvidenceText).min(1).max(30)).min(1).max(5_000);
const CsvEvidenceV2 = z.object({
  bytes: PositiveInteger, sha256: Sha256, rows: PositiveInteger,
  fields: z.number().int().min(1).max(30), exact: z.literal(true),
}).strict();
const DesktopObservationsV2 = z.object({
  currentView: z.object({
    headings: z.array(MeaningfulText(1, 200)).min(1).max(30),
    rows: EvidenceStringMatrix,
    csv: CsvEvidenceV2,
  }).strict(),
  record: z.object({
    id: z.string().uuid(),
    headings: z.array(MeaningfulText(1, 200)).min(1).max(30),
    rows: z.tuple([z.array(EvidenceText).min(1).max(30)]),
    csv: z.object({ bytes: PositiveInteger, sha256: Sha256 }).strict(),
    csvExact: z.literal(true),
    printCalls: z.literal(1),
  }).strict(),
  print: z.object({
    artifact: z.literal("desktop-print.pdf"), extractedSha256: Sha256,
    exact: z.literal(true),
  }).strict(),
  opfsUnchanged: z.literal(true),
  historyUnchanged: z.literal(true),
  axeBlocking: z.literal(0),
}).strict();

const MobileObservationsV2 = z.object({
  viewport: z.object({ width: z.literal(320), height: z.literal(800) }).strict(),
  textScalePercent: z.literal(200),
  surfaces: z.array(TextScaleSurfaceV1).min(5).max(20),
  horizontalDocumentOverflow: z.literal(false),
  dialogFitsViewport: z.literal(true),
  appMenuReachable: z.literal(true),
  themeMenuReachable: z.literal(true),
  keyboardAssertions: z.array(MeaningfulText(3, 300)).min(7).max(100),
  actionsReachable: z.literal(true),
  axeBlocking: z.literal(0),
}).strict();
const NetworkObservationsV2 = z.object({
  desktopExportRequests: z.literal(0),
  recordExportRequests: z.literal(0),
  mobileExportRequests: z.literal(0),
  desktopActions: z.tuple([z.literal("csv"), z.literal("print")]),
  recordActions: z.tuple([z.literal("csv"), z.literal("print")]),
  desktopWebSockets: z.literal(0),
  recordWebSockets: z.literal(0),
  desktopBlobUrls: z.literal(1),
  recordBlobUrls: z.literal(1),
  desktopDownloadBlobUrls: z.literal(1),
  recordDownloadBlobUrls: z.literal(1),
  unexpected: z.tuple([]),
}).strict();
const RuntimeObservationsV2 = z.object({
  desktop: DesktopObservationsV2,
  mobile: MobileObservationsV2,
  network: NetworkObservationsV2,
}).strict();
const caseStatus = (id: string) => z.object({
  id: z.literal(id), status: z.enum(["PASS", "FAIL"]),
}).strict();
const LocalExportCasesV2 = z.tuple([
  caseStatus("current-view-preview-exact"), caseStatus("current-view-csv-exact"),
  caseStatus("print-document-exact"), caseStatus("record-preview-exact"),
  caseStatus("record-actions-exact"), caseStatus("network-local-only"),
  caseStatus("durable-state-unchanged"), caseStatus("mobile-reflow"),
  caseStatus("mobile-controls-reachable"), caseStatus("keyboard-complete"),
  caseStatus("automated-accessibility"),
]);

export const LocalExportEvidenceManifestV2 = z.object({
  schema: z.literal("LocalExportEvidenceManifestV2"),
  generatedAt: IsoInstant,
  source: EvidenceSourceV1,
  build: EvidenceBuildV1,
  browser: z.object({
    name: z.literal("chromium"),
    version: z.string().min(1).max(120),
    headless: z.boolean(),
  }).strict(),
  url: z.string().url().max(500),
  requirements: RequiredLocalExportRequirementsV2,
  gates: ReleaseFGateOutcomesV2,
  observations: RuntimeObservationsV2,
  cases: LocalExportCasesV2,
  errors: z.array(z.string().min(1).max(2_000)).max(1_000),
  artifacts: z.array(EvidenceArtifactV1).min(1).max(1_000),
  accessibility: AccessibilityEvidenceV1,
  verdict: z.enum(["PASS", "BLOCKED", "FAIL"]),
}).strict().superRefine((value, context) => {
  const screenReader = value.accessibility.screenReader;
  const expectedArtifacts = [...LOCAL_EXPORT_REQUIRED_ARTIFACTS_V2,
    ...(screenReader.status === "PASS" ? [screenReader.artifact.file] : [])].sort();
  const actualArtifacts = value.artifacts.map(artifact => artifact.file).sort();
  if (new Set(actualArtifacts).size !== actualArtifacts.length
      || JSON.stringify(actualArtifacts) !== JSON.stringify(expectedArtifacts))
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["artifacts"],
      message: "runtime artifact inventory is not the exact Release F set" });
  for (const [file, path] of [
    [value.accessibility.reflow320At200Percent.artifact,
      ["accessibility", "reflow320At200Percent", "artifact"]],
    [value.accessibility.accessibilityTree.artifact,
      ["accessibility", "accessibilityTree", "artifact"]],
    [value.accessibility.printReadingOrder.artifact,
      ["accessibility", "printReadingOrder", "artifact"]],
  ] as const) if (!value.artifacts.some(artifact => artifact.file === file))
    context.addIssue({ code: z.ZodIssueCode.custom, path: [...path],
      message: "accessibility artifact must be present in the runtime inventory" });
  const automatedPass = value.cases.every(item => item.status === "PASS")
    && value.errors.length === 0;
  const expectedVerdict = !automatedPass ? "FAIL"
    : screenReader.status === "PASS" ? "PASS" : "BLOCKED";
  if (value.verdict !== expectedVerdict) context.addIssue({
    code: z.ZodIssueCode.custom, path: ["verdict"],
    message: "runtime verdict does not follow exact automated and manual cases",
  });
  if (screenReader.status === "UNAVAILABLE" && value.verdict === "PASS")
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["verdict"],
      message: "manual screen-reader evidence is unavailable, so the report cannot PASS",
    });
  if (screenReader.status === "PASS") {
    if (screenReader.source.commit !== value.source.commit
        || screenReader.source.tree !== value.source.tree)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["accessibility", "screenReader", "source"],
        message: "manual screen-reader source must match the runtime report source",
      });
    if (screenReader.build.sha256 !== value.build.sha256
        || screenReader.build.bytes !== value.build.bytes
        || screenReader.build.files !== value.build.files)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["accessibility", "screenReader", "build"],
        message: "manual screen-reader build must match the runtime report build",
      });
    const artifact = value.artifacts.find(item => item.file === screenReader.artifact.file);
    if (!artifact || artifact.bytes !== screenReader.artifact.bytes
        || artifact.sha256 !== screenReader.artifact.sha256)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["accessibility", "screenReader", "artifact"],
        message: "manual screen-reader artifact must be hash-inventoried by the runtime report",
      });
    screenReader.assertions.forEach((assertion, index) => {
      const proof = value.artifacts.find(item => item.file === assertion.artifact.file);
      if (!proof || proof.bytes !== assertion.artifact.bytes
          || proof.sha256 !== assertion.artifact.sha256)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["accessibility", "screenReader", "assertions", index, "artifact"],
          message: "manual screen-reader step proof must be hash-inventoried by the runtime report",
        });
    });
  }
});

const ReportReferenceV1 = z.object({
  file: RelativeFile,
  schema: z.enum(["LocalExportEvidenceManifestV2", "BenchmarkEvidenceManifestV1"]),
  sha256: Sha256,
}).strict();

export const ReleaseEvidenceManifestV1 = z.object({
  schema: z.literal("ReleaseEvidenceManifestV1"),
  generatedAt: IsoInstant,
  source: EvidenceSourceV1,
  reports: z.array(ReportReferenceV1).length(2),
  artifacts: z.array(EvidenceArtifactV1).min(1).max(1_000),
  verdict: z.enum(["PASS", "BLOCKED", "FAIL"]),
}).strict().superRefine((value, context) => {
  const paths = [...value.reports.map(report => report.file),
    ...value.artifacts.map(artifact => artifact.file)];
  if (new Set(paths).size !== paths.length) context.addIssue({
    code: z.ZodIssueCode.custom,
    path: ["artifacts"],
    message: "evidence paths must be unique",
  });
  const schemas = new Set(value.reports.map(report => report.schema));
  for (const schema of ["LocalExportEvidenceManifestV2", "BenchmarkEvidenceManifestV1"] as const) {
    if (!schemas.has(schema)) context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reports"],
      message: `missing ${schema} report`,
    });
  }
});

export type BenchmarkEvidenceManifestV1 = z.infer<typeof BenchmarkEvidenceManifestV1>;
export type ManualScreenReaderEvidenceV1 = z.infer<typeof ManualScreenReaderEvidenceV1>;
export type AccessibilityEvidenceV1 = z.infer<typeof AccessibilityEvidenceV1>;
export type LocalExportEvidenceManifestV2 = z.infer<typeof LocalExportEvidenceManifestV2>;
export type ReleaseEvidenceManifestV1 = z.infer<typeof ReleaseEvidenceManifestV1>;
