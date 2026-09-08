import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  BenchmarkEvidenceManifestV1,
  EvidenceSourceV1,
  LocalExportEvidenceManifestV2,
  ManualScreenReaderEvidenceV1,
  ReleaseEvidenceManifestV1,
} from "../packages/schema/src/evidence.ts";

function plainRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function canonicalEvidenceJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("evidence contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalEvidenceJson).join(",")}]`;
  if (!plainRecord(value)) throw new Error("evidence contains a non-canonical value");
  return `{${Object.keys(value).sort().map(key => {
    if (value[key] === undefined) throw new Error("evidence contains an undefined value");
    return `${JSON.stringify(key)}:${canonicalEvidenceJson(value[key])}`;
  }).join(",")}}`;
}

export function sha256Evidence(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function normalizedPdfText(value) {
  return value.replace(/(\p{N})-\s+(?=\p{N})/gu, "$1-").replace(/\s+/gu, " ").trim();
}

export function pdfTextMatchesExactSequence(text, values) {
  const expected = normalizedPdfText(values.filter(value => value !== "").join(" "));
  return expected.length > 0 && normalizedPdfText(text) === expected;
}

function hasExited(child) {
  return child.exitCode !== null && child.exitCode !== undefined
    || child.signalCode !== null && child.signalCode !== undefined;
}

function waitForChildExit(child, timeoutMs) {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise(resolveExit => {
    let timer;
    const finish = exited => {
      if (timer) clearTimeout(timer);
      child.off("exit", onExit);
      resolveExit(exited);
    };
    const onExit = () => finish(true);
    child.once("exit", onExit);
    if (hasExited(child)) return finish(true);
    timer = setTimeout(() => finish(false), timeoutMs);
  });
}

export async function stopChildProcess(child, graceMs = 3_000) {
  if (hasExited(child)) return;
  const gracefulExit = waitForChildExit(child, graceMs);
  child.kill("SIGTERM");
  if (await gracefulExit) return;
  const forcedExit = waitForChildExit(child, graceMs);
  child.kill("SIGKILL");
  if (!await forcedExit) throw new Error("preview process did not exit after SIGKILL");
}

function comparablePath(value) {
  const canonical = resolve(value);
  return process.platform === "win32" ? canonical.toLocaleLowerCase("en-US") : canonical;
}

export function worktreeRemovalComplete(checkout, checkoutExists, porcelain) {
  if (checkoutExists) return false;
  const expected = comparablePath(checkout);
  return !porcelain.split(/\r?\n/u)
    .filter(line => line.startsWith("worktree "))
    .some(line => comparablePath(line.slice("worktree ".length)) === expected);
}

export function assertCleanGitWorktree(directory = process.cwd()) {
  const status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: directory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (status.length > 0)
    throw new Error("release evidence requires a clean worktree with no tracked, staged, or untracked changes");
}

function gitObject(directory, expression) {
  return execFileSync("git", ["rev-parse", expression], {
    cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function deriveCleanHeadSource(directory = process.cwd()) {
  assertCleanGitWorktree(directory);
  return {
    commit: gitObject(directory, "HEAD"),
    tree: gitObject(directory, "HEAD^{tree}"),
  };
}

export function assertExactCleanSource(directory, expectedSource, label = "isolated checkout") {
  assertCleanGitWorktree(directory);
  const actual = {
    commit: gitObject(directory, "HEAD"),
    tree: gitObject(directory, "HEAD^{tree}"),
  };
  if (actual.commit !== expectedSource.commit)
    throw new Error(`${label} HEAD does not match authoritative commit`);
  if (actual.tree !== expectedSource.tree)
    throw new Error(`${label} tree does not match authoritative tree`);
  return actual;
}

const CERTIFICATE_ENVIRONMENT_KEYS = [
  "PATH", "Path", "SYSTEMROOT", "SystemRoot", "COMSPEC", "ComSpec", "PATHEXT", "WINDIR",
  "TEMP", "TMP", "TMPDIR", "LOCALAPPDATA", "APPDATA", "USERPROFILE", "HOME",
  "PNPM_HOME", "COREPACK_HOME", "CI",
];

export function createCertificateEnvironment({
  source, outputRoot, manualScreenReader, hostEnvironment = process.env,
}) {
  const parsedSource = EvidenceSourceV1.parse(source);
  const environment = {};
  for (const key of CERTIFICATE_ENVIRONMENT_KEYS) {
    const value = hostEnvironment[key];
    if (typeof value === "string" && value.length > 0) environment[key] = value;
  }
  Object.assign(environment, {
    NODE_ENV: "production",
    TZ: "UTC",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    CLAY_SOURCE_TREE: parsedSource.tree,
    CLAY_EVIDENCE_OUTPUT_ROOT: outputRoot,
  });
  if (manualScreenReader !== undefined)
    environment.CLAY_MANUAL_SCREEN_READER_INPUT = manualScreenReader;
  return environment;
}

const OWNED_EVIDENCE_OUTPUTS = new Set(["benchmark.json", "release.json", "runtime"]);

export async function prepareEvidenceOutput(directory) {
  const root = resolve(directory);
  if (dirname(root) === root) throw new Error("evidence output cannot be a filesystem root");
  let rootStat;
  try {
    rootStat = await lstat(root);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(root, { recursive: true });
    return;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory())
    throw new Error("evidence output must be a real directory, not a file or symbolic link");
  const entries = await readdir(root);
  const unknown = entries.filter(entry => !OWNED_EVIDENCE_OUTPUTS.has(entry));
  if (unknown.length > 0)
    throw new Error(`evidence output contains unowned entries: ${unknown.sort().join(", ")}`);
  for (const entry of entries) {
    const path = join(root, entry);
    const stat = await lstat(path);
    if (stat.isSymbolicLink())
      throw new Error(`evidence output contains a symbolic link: ${entry}`);
  }
  await Promise.all(entries.map(entry => rm(join(root, entry), { recursive: true, force: true })));
}

export function nearestRankP95(values) {
  if (!Array.isArray(values) || values.length === 0
      || values.some(value => typeof value !== "number" || !Number.isFinite(value) || value < 0))
    throw new Error("p95 needs finite non-negative samples");
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.95) - 1];
}

function sampleTimes(samples, rows, operation, classification = "warm") {
  return samples.filter(sample => sample.rows === rows && sample.operation === operation
    && sample.classification === classification).map(sample => sample.milliseconds);
}

export function summarizeBenchmarkSamples(samples) {
  return {
    rows1000CsvP95Ms: nearestRankP95(sampleTimes(samples, 1000, "csv")),
    rows5000CsvP95Ms: nearestRankP95(sampleTimes(samples, 5000, "csv")),
    rows5000PreviewP95Ms: nearestRankP95(sampleTimes(samples, 5000, "owner-preview")),
    cancelP95Ms: nearestRankP95(sampleTimes(samples, 5000, "cancel")),
    peakIncrementalMemoryBytes: Math.max(...samples.map(sample => sample.incrementalMemoryBytes)),
  };
}

function sameJson(left, right) {
  return canonicalEvidenceJson(left) === canonicalEvidenceJson(right);
}

export function assertBenchmarkEvidence(input) {
  const manifest = BenchmarkEvidenceManifestV1.parse(input);
  const required = [
    [1000, "csv"],
    [5000, "csv"],
    [5000, "owner-preview"],
    [5000, "cancel"],
  ];
  for (const [rows, operation] of required) {
    const matching = manifest.samples.filter(sample =>
      sample.rows === rows && sample.operation === operation);
    const cold = matching.filter(sample => sample.classification === "cold");
    const warm = matching.filter(sample => sample.classification === "warm");
    if (cold.length !== 1)
      throw new Error(`${rows}/${operation} benchmark needs exactly one cold sample`);
    if (warm.length !== manifest.methodology.sampleRuns)
      throw new Error(`${rows}/${operation} benchmark warm sample count does not match methodology`);
  }
  const expectedDigest = sha256Evidence(Buffer.from(canonicalEvidenceJson({
    methodology: manifest.methodology,
    samples: manifest.samples,
  })));
  if (manifest.rawResultsSha256 !== expectedDigest)
    throw new Error("benchmark raw-results digest does not match samples and methodology");
  const expectedResults = summarizeBenchmarkSamples(manifest.samples);
  if (!sameJson(manifest.results, expectedResults))
    throw new Error("benchmark result does not match nearest-rank p95 raw samples");
  const pass = expectedResults.rows1000CsvP95Ms <= manifest.limits.rows1000CsvP95Ms
    && expectedResults.rows5000CsvP95Ms <= manifest.limits.rows5000CsvP95Ms
    && expectedResults.rows5000PreviewP95Ms <= manifest.limits.rows5000PreviewP95Ms
    && expectedResults.cancelP95Ms <= manifest.limits.cancelMs
    && expectedResults.peakIncrementalMemoryBytes <= manifest.limits.incrementalMemoryBytes;
  if (manifest.verdict !== (pass ? "PASS" : "FAIL"))
    throw new Error("benchmark verdict does not match measured limits");
  if (!pass) throw new Error("benchmark evidence exceeds a release limit");
  return manifest;
}

function assertSameSource(actual, expected, label) {
  if (!sameJson(actual, expected)) throw new Error(`${label} source does not match immutable source`);
}

export function summarizeExportDialogStateEvidence(observations) {
  const states = ["loading", "success", "error"];
  for (const state of states) {
    const blocking = observations?.[state]?.axeBlocking;
    if (!Array.isArray(blocking)) throw new Error(`${state} Axe observation is missing`);
    if (blocking.length > 0) throw new Error(`${state} Axe observation has blocking violations`);
  }
  const live = observations.loading.liveStatus;
  if (live?.role !== "status" || live.ariaLive !== "polite"
      || typeof live.announcement !== "string" || live.announcement.length === 0)
    throw new Error("loading live status was not observed");
  const error = observations.error;
  if (error.alert?.role !== "alert" || typeof error.alert.id !== "string"
      || !Array.isArray(error.dialogDescribedBy)
      || !error.dialogDescribedBy.includes(error.alert.id))
    throw new Error("error alert is not linked by dialog aria-describedby");
  return {
    axe: { status: "PASS", serious: 0, critical: 0, states },
    liveProgress: { status: "PASS", role: "status", announcement: live.announcement },
    errorLinkage: { status: "PASS", role: "alert", describedBy: error.alert.id },
  };
}

export async function ingestManualScreenReaderEvidence(inputPath, {
  source, build, outputDirectory, sourceDirectory = process.cwd(),
}) {
  if (inputPath === undefined) return {
    screenReader: {
      status: "UNAVAILABLE", mode: "manual", products: ["NVDA", "VoiceOver"],
      reason: "Manual screen-reader evidence was not supplied to the isolated certificate run.",
    },
    artifact: null,
  };
  if (!isAbsolute(inputPath))
    throw new Error("manual screen-reader evidence input must be an absolute external path");
  const loaded = await readJson(inputPath);
  const manual = ManualScreenReaderEvidenceV1.parse(loaded.value);
  if (manual.status !== "PASS")
    throw new Error("external manual screen-reader input must be the PASS variant");
  assertSameSource(manual.source, source, "manual screen-reader");
  if (!sameJson(manual.build, build))
    throw new Error("manual screen-reader build does not match the isolated build");
  const procedureBytes = await readFile(join(
    sourceDirectory, "specs", "release-f-manual-screen-reader-procedure.md",
  ));
  if (manual.procedure.sha256 !== sha256Evidence(procedureBytes))
    throw new Error("manual screen-reader procedure digest does not match tracked source");
  if (!manual.assertions.every(assertion => sameJson(assertion.artifact, manual.artifact)))
    throw new Error("manual screen-reader step artifact must match the session artifact");
  const sourceArtifact = resolve(dirname(inputPath), manual.artifact.file);
  const inputRoot = resolve(dirname(inputPath));
  if (sourceArtifact === inputRoot || !sourceArtifact.startsWith(`${inputRoot}${sep}`))
    throw new Error("manual screen-reader artifact escapes its input directory");
  const bytes = await readFile(sourceArtifact);
  if (bytes.byteLength !== manual.artifact.bytes || sha256Evidence(bytes) !== manual.artifact.sha256)
    throw new Error("manual screen-reader artifact bytes or digest do not match input");
  let transcript;
  try { transcript = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("manual screen-reader transcript is not valid UTF-8"); }
  const lines = transcript.replace(/\r\n?/g, "\n").split("\n");
  const ranges = [];
  for (const assertion of manual.assertions) {
    const match = /^transcript-lines:([1-9][0-9]{0,5})-([1-9][0-9]{0,5})$/
      .exec(assertion.locator);
    const start = Number(match?.[1]);
    const end = Number(match?.[2]);
    if (!match || start > end || end > lines.length
        || ranges.some(range => start <= range.end && end >= range.start))
      throw new Error(`manual screen-reader locator is missing or overlaps: ${assertion.locator}`);
    const segment = lines.slice(start - 1, end).join("\n").trim();
    if (segment.length < 20 || !segment.includes(`[${assertion.id}]`))
      throw new Error(`manual screen-reader locator has no bound assertion segment: ${assertion.id}`);
    ranges.push({ start, end });
  }
  const copiedFile = `manual-screen-reader/${basename(manual.artifact.file)}`;
  const copiedPath = join(outputDirectory, copiedFile);
  await mkdir(dirname(copiedPath), { recursive: true });
  await copyFile(sourceArtifact, copiedPath);
  const artifact = { file: copiedFile, bytes: bytes.byteLength, sha256: sha256Evidence(bytes) };
  const assertions = manual.assertions.map(assertion => ({ ...assertion, artifact }));
  const screenReader = ManualScreenReaderEvidenceV1.parse({ ...manual, assertions, artifact });
  return { screenReader, artifact };
}

async function readJson(path) {
  const bytes = await readFile(path);
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch (error) { throw new Error(`${path} is not valid JSON: ${String(error)}`); }
  return { bytes, value };
}

async function inventoryFiles(root, current = root) {
  const files = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...await inventoryFiles(root, path));
    else if (entry.isFile()) files.push(relative(root, path).split(sep).join("/"));
    else throw new Error(`evidence contains unsupported entry ${path}`);
  }
  return files.sort();
}

export async function buildDirectoryDigest(root) {
  const files = await inventoryFiles(root);
  if (files.length === 0) throw new Error("production build directory is empty");
  const inventory = [];
  let bytes = 0;
  for (const file of files) {
    const data = await readFile(join(root, file));
    bytes += data.byteLength;
    inventory.push({ path: file, bytes: data.byteLength, sha256: sha256Evidence(data) });
  }
  const framed = Buffer.from(canonicalEvidenceJson({
    schema: "BuildDirectoryDigestV1", files: inventory,
  }), "utf8");
  return { sha256: sha256Evidence(framed), bytes, files: files.length };
}

export async function verifyReleaseEvidenceDirectory(directory, expectedSource) {
  const root = resolve(directory);
  const releaseFile = await readJson(join(root, "release.json"));
  const release = ReleaseEvidenceManifestV1.parse(releaseFile.value);
  assertSameSource(release.source, expectedSource, "release manifest");
  if (release.verdict === "FAIL") throw new Error("release evidence verdict is FAIL");

  const expectedReports = new Map([
    ["runtime/report.json", "LocalExportEvidenceManifestV2"],
    ["benchmark.json", "BenchmarkEvidenceManifestV1"],
  ]);
  if (release.reports.some(report => expectedReports.get(report.file) !== report.schema))
    throw new Error("release report inventory is not the closed Release F set");

  let report;
  let benchmark;
  for (const reference of release.reports) {
    const loaded = await readJson(join(root, reference.file));
    if (sha256Evidence(loaded.bytes) !== reference.sha256)
      throw new Error(`${reference.file} report digest does not match release manifest`);
    if (reference.schema === "LocalExportEvidenceManifestV2")
      report = LocalExportEvidenceManifestV2.parse(loaded.value);
    else benchmark = assertBenchmarkEvidence(loaded.value);
  }
  if (!report || !benchmark) throw new Error("release evidence is missing a required report");
  assertSameSource(report.source, expectedSource, "runtime report");
  assertSameSource(benchmark.source, expectedSource, "benchmark report");
  if (!sameJson(report.build, benchmark.build))
    throw new Error("runtime and benchmark reports do not bind the same build");
  if (report.verdict === "FAIL" || report.errors.length > 0
      || report.cases.some(item => item.status !== "PASS"))
    throw new Error("runtime report does not contain clean automated evidence");
  if (release.verdict !== report.verdict)
    throw new Error("release verdict does not match the runtime accessibility verdict");

  const releaseArtifacts = new Map(release.artifacts.map(artifact => [artifact.file, artifact]));
  const runtimeArtifacts = report.artifacts.map(artifact => ({
    ...artifact, file: `runtime/${artifact.file}`,
  }));
  if (!sameJson([...releaseArtifacts.keys()].sort(), runtimeArtifacts.map(item => item.file).sort()))
    throw new Error("outer release manifest does not list every runtime artifact exactly once");
  for (const artifact of runtimeArtifacts) {
    const outer = releaseArtifacts.get(artifact.file);
    if (!outer || !sameJson(outer, artifact))
      throw new Error(`${artifact.file} metadata differs between runtime and release manifests`);
    const bytes = await readFile(join(root, artifact.file));
    if (bytes.byteLength !== artifact.bytes || sha256Evidence(bytes) !== artifact.sha256)
      throw new Error(`${artifact.file} artifact bytes or digest do not match release manifest`);
  }

  const allowed = new Set([
    "release.json", ...release.reports.map(item => item.file), ...releaseArtifacts.keys(),
  ]);
  const inventory = await inventoryFiles(root);
  const extras = inventory.filter(file => !allowed.has(file));
  const missing = [...allowed].filter(file => !inventory.includes(file));
  if (extras.length || missing.length)
    throw new Error(`evidence inventory mismatch (extra: ${extras.join(", ") || "none"}; missing: ${missing.join(", ") || "none"})`);
  return { release, report, benchmark, inventory };
}

export async function writeReleaseEvidenceDirectory(directory, reportInput, benchmarkInput) {
  const root = resolve(directory);
  const report = LocalExportEvidenceManifestV2.parse(reportInput);
  const benchmark = assertBenchmarkEvidence(benchmarkInput);
  assertSameSource(benchmark.source, report.source, "benchmark report");
  if (!sameJson(benchmark.build, report.build))
    throw new Error("runtime and benchmark reports do not bind the same build");

  const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  const benchmarkBytes = Buffer.from(`${JSON.stringify(benchmark, null, 2)}\n`);
  const release = ReleaseEvidenceManifestV1.parse({
    schema: "ReleaseEvidenceManifestV1",
    generatedAt: report.generatedAt,
    source: report.source,
    reports: [
      {
        file: "runtime/report.json",
        schema: "LocalExportEvidenceManifestV2",
        sha256: sha256Evidence(reportBytes),
      },
      {
        file: "benchmark.json",
        schema: "BenchmarkEvidenceManifestV1",
        sha256: sha256Evidence(benchmarkBytes),
      },
    ],
    artifacts: report.artifacts.map(artifact => ({
      ...artifact,
      file: `runtime/${artifact.file}`,
    })),
    verdict: report.verdict,
  });
  await mkdir(join(root, "runtime"), { recursive: true });
  await writeFile(join(root, "runtime", "report.json"), reportBytes);
  await writeFile(join(root, "benchmark.json"), benchmarkBytes);
  await writeFile(join(root, "release.json"), `${JSON.stringify(release, null, 2)}\n`);
  return verifyReleaseEvidenceDirectory(root, report.source);
}
