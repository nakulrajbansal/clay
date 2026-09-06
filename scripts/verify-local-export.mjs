// Authoritative Release F local-export certificate entrypoint.
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertExactCleanSource,
  createCertificateEnvironment,
  deriveCleanHeadSource,
  prepareEvidenceOutput,
} from "./local-export-evidence-lib.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FORBIDDEN_PREVIEW_PORTS = new Set([4173, 4174, 4175]);
const corepack = process.platform === "win32" ? "corepack.cmd" : "corepack";

function git(directory, ...args) {
  return execFileSync("git", args, {
    cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function isInside(parent, candidate) {
  const path = relative(resolve(parent), resolve(candidate));
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

export function resolveEvidenceOutput(value, sourceRoot, commit) {
  const output = value === undefined
    ? join(tmpdir(), "clay-local-export-evidence", commit)
    : value;
  if (!isAbsolute(output))
    throw new Error("local-export evidence output must be an absolute path outside the source checkout");
  const resolved = resolve(output);
  if (isInside(sourceRoot, resolved))
    throw new Error("local-export evidence output must be outside the source checkout");
  return resolved;
}

function parseArguments(args) {
  let output;
  let manualScreenReader;
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    const value = args[index + 1];
    if ((name !== "--output" && name !== "--manual-screen-reader") || value === undefined)
      throw new Error(`unsupported or incomplete local-export option ${name ?? ""}`.trim());
    if (!isAbsolute(value)) throw new Error(`${name} must be an absolute external path`);
    if (name === "--output") output = value;
    else manualScreenReader = value;
    index++;
  }
  return { output, manualScreenReader };
}

function run(directory, command, args, env) {
  execFileSync(command, args, {
    cwd: directory,
    env,
    stdio: "inherit",
    shell: process.platform === "win32" && command.endsWith(".cmd"),
  });
}

async function checkedPhase(checkout, source, label, operation) {
  assertExactCleanSource(checkout, source, `${label} before`);
  try {
    return await operation();
  } finally {
    assertExactCleanSource(checkout, source, `${label} after`);
  }
}

async function reservePreviewPort() {
  for (;;) {
    const server = createServer();
    const port = await new Promise((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => accept(server.address().port));
    });
    await new Promise((accept, reject) => server.close(error => error ? reject(error) : accept()));
    if (!FORBIDDEN_PREVIEW_PORTS.has(port)) return port;
  }
}

async function waitForPreview(child, url, logs) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`strict preview exited before readiness: ${logs.join("")}`);
    try {
      const response = await fetch(url, { redirect: "error" });
      if (response.ok) return;
    } catch { /* bounded readiness retry */ }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error(`strict preview did not become ready at ${url}`);
}

async function stopPreview(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = new Promise(resolveExit => child.once("exit", resolveExit));
  await Promise.race([exited, new Promise(resolveWait => setTimeout(resolveWait, 3_000))]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await new Promise(resolveExit => child.once("exit", resolveExit));
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const source = deriveCleanHeadSource(repoRoot);
  const outputRoot = resolveEvidenceOutput(options.output, repoRoot, source.commit);
  if (options.manualScreenReader && isInside(repoRoot, options.manualScreenReader))
    throw new Error("manual screen-reader evidence must be external to the authoritative source");
  if (options.manualScreenReader && isInside(outputRoot, options.manualScreenReader))
    throw new Error("manual screen-reader evidence cannot be inside the replaceable output directory");
  await prepareEvidenceOutput(outputRoot);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "clay-local-export-checkout-"));
  const checkout = join(temporaryRoot, "source");
  let worktreeAdded = false;
  let preview;
  try {
    git(repoRoot, "worktree", "add", "--detach", checkout, source.commit);
    worktreeAdded = true;
    assertExactCleanSource(checkout, source, "materialized checkout");
    if (isInside(checkout, outputRoot))
      throw new Error("local-export evidence output must be outside the isolated checkout");
    const env = createCertificateEnvironment({
      source, outputRoot, manualScreenReader: options.manualScreenReader,
    });

    await checkedPhase(checkout, source, "cached offline dependency install", () =>
      run(checkout, corepack, ["pnpm", "install", "--offline", "--frozen-lockfile"], env));
    await checkedPhase(checkout, source, "production build", () =>
      run(checkout, corepack, ["pnpm", "build"], env));

    const port = await reservePreviewPort();
    const url = `http://127.0.0.1:${port}`;
    env.URL = url;
    const logs = [];
    assertExactCleanSource(checkout, source, "strict preview before");
    const viteBin = join(checkout, "packages", "shell", "node_modules", "vite", "bin", "vite.js");
    preview = spawn(process.execPath, [viteBin, "preview", "--host", "127.0.0.1",
      "--port", String(port), "--strictPort"], {
      cwd: join(checkout, "packages", "shell"), env, stdio: ["ignore", "pipe", "pipe"],
    });
    preview.stdout.on("data", chunk => { logs.push(String(chunk)); process.stdout.write(chunk); });
    preview.stderr.on("data", chunk => { logs.push(String(chunk)); process.stderr.write(chunk); });
    await waitForPreview(preview, url, logs);
    assertExactCleanSource(checkout, source, "strict preview ready");

    await checkedPhase(checkout, source, "browser benchmark", () =>
      run(checkout, process.execPath, ["scripts/local-export-browser-benchmark-evidence.mjs",
        join(outputRoot, "benchmark.json")], env));
    await checkedPhase(checkout, source, "browser evidence", () =>
      run(checkout, process.execPath, ["scripts/local-export-evidence.mjs",
        join(outputRoot, "runtime"), join(outputRoot, "benchmark.json")], env));
  } finally {
    const cleanupFailures = [];
    const cleanup = async (label, operation) => {
      try { await operation(); }
      catch (error) { cleanupFailures.push(new Error(`${label}: ${String(error)}`)); }
    };
    if (preview) await cleanup("stop strict preview", () => stopPreview(preview));
    if (worktreeAdded) {
      await cleanup("verify strict preview source", () =>
        assertExactCleanSource(checkout, source, "strict preview after"));
      await cleanup("remove isolated worktree", () =>
        git(repoRoot, "worktree", "remove", "--force", checkout));
    }
    await cleanup("remove isolated temporary directory", () =>
      rm(temporaryRoot, { recursive: true, force: true }));
    await cleanup("prune isolated worktree metadata", () =>
      git(repoRoot, "worktree", "prune"));
    await cleanup("verify authoritative source", () =>
      assertExactCleanSource(repoRoot, source, "authoritative source after certificate"));
    if (cleanupFailures.length > 0)
      throw new AggregateError(cleanupFailures, "local-export certificate cleanup failed");
  }
}

await main();
