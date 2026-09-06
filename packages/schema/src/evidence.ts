import { z } from "zod";

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

const BenchmarkSampleV1 = z.object({
  rows: z.union([z.literal(1000), z.literal(5000)]),
  classification: z.enum(["cold", "warm"]),
  operation: z.enum(["csv", "owner-preview", "cancel"]),
  milliseconds: NonNegativeFinite,
  incrementalMemoryBytes: z.number().int().nonnegative(),
  inputBytes: z.number().int().nonnegative(),
  outputBytes: z.number().int().nonnegative(),
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
    fields: z.number().int().min(1).max(30),
    rows: z.tuple([z.literal(1000), z.literal(5000)]),
  }).strict(),
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
  const classes = new Set(value.samples.map(sample => sample.classification));
  for (const classification of ["cold", "warm"] as const) {
    if (!classes.has(classification)) context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["samples"],
      message: `missing ${classification} benchmark sample`,
    });
  }
});

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
    productVersion: z.string().min(1).max(120),
    platform: z.string().min(1).max(120),
    performedAt: IsoInstant,
    tester: z.string().min(1).max(200),
    method: z.string().min(1).max(500),
    source: EvidenceSourceV1,
    build: EvidenceBuildV1,
    assertions: z.array(z.string().min(1).max(500)).min(3).max(100),
    artifact: EvidenceArtifactV1,
  }).strict(),
]);

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
  requirements: z.array(z.string().regex(/^F-(?:FR|NFR|AT|GATE)-[0-9]{3}$/)).min(1).max(200),
  exclusions: z.array(z.string().min(1).max(500)).max(100),
  observations: z.object({
    desktop: z.unknown(),
    mobile: z.unknown(),
    network: z.unknown(),
  }).strict(),
  checks: z.array(z.object({
    ok: z.boolean(),
    label: z.string().min(1).max(500),
    detail: z.unknown().optional(),
  }).strict()).min(1).max(1_000),
  errors: z.array(z.string().min(1).max(2_000)).max(1_000),
  artifacts: z.array(EvidenceArtifactV1).min(1).max(1_000),
  accessibility: AccessibilityEvidenceV1,
  verdict: z.enum(["PASS", "BLOCKED", "FAIL"]),
}).strict().superRefine((value, context) => {
  const screenReader = value.accessibility.screenReader;
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
