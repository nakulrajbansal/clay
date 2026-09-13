import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative as relativePath, resolve } from "node:path";

const sha = value => createHash("sha256").update(value).digest("hex");
export const fingerprint = files => sha(JSON.stringify(files));
const generated = new Set(["node_modules", "dist", "coverage", "test-results", ".vite", ".git"]);
async function fileSha(path) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}
export async function snapshotBuildInputs(root) {
  const files = {};
  const dependencyDirectories = new Set(["node_modules"]);
  async function walk(relative) {
    const entries = await readdir(join(root, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "node_modules") dependencyDirectories.add(`${relative}/node_modules`);
      if (generated.has(entry.name)) continue;
      // Never read dotenv values. Vite can consume these implicitly, so a gate
      // without an explicit environment manifest must refuse them altogether.
      if (/^\.env(?:\.(?:local|production|production\.local))?$/.test(entry.name))
        throw new Error("source-bound build refuses an implicit environment file");
      if (entry.name.startsWith(".env") || entry.name === ".npmrc") continue;
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`unbound build input symlink: ${path}`);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files[path] = sha(await readFile(join(root, path)));
    }
  }
  for (const directory of ["packages", "scripts", "specs"]) await walk(directory);
  // A lockfile alone cannot attest to installed or locally modified compiler
  // bytes. Hash physical dependencies plus their workspace-local link bindings;
  // do not follow links (pnpm has cycles), download anything, or read npm config.
  async function dependencies(relative) {
    let entries;
    try { entries = await readdir(join(root, relative), { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".cache" || entry.name === ".vite" || entry.name === ".npmrc"
          || entry.name.startsWith(".env")) continue;
      const path = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        const target = relativePath(resolve(root), await realpath(join(root, path))).replaceAll("\\", "/");
        if (target === ".." || target.startsWith("../") || isAbsolute(target))
          throw new Error("source-bound build refuses dependencies outside the review workspace");
        files[path] = sha(`workspace-link:${target}`);
      } else if (entry.isDirectory()) await dependencies(path);
      else if (entry.isFile()) files[path] = await fileSha(join(root, path));
    }
  }
  for (const directory of dependencyDirectories) await dependencies(directory);
  files["@toolchain/node-executable"] = await fileSha(process.execPath);
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isFile() && (entry.name === "package.json" || entry.name === "pnpm-lock.yaml"
        || entry.name === "pnpm-workspace.yaml" || /^tsconfig.*\.json$/.test(entry.name)))
      files[entry.name] = sha(await readFile(join(root, entry.name)));
    if (/^\.env(?:\.(?:local|production|production\.local))?$/.test(entry.name))
      throw new Error("source-bound build refuses an implicit environment file");
  }
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}

export async function buildP0Candidate(root, logPath) {
  if (Object.keys(process.env).some(key => key.startsWith("VITE_")) || process.env.NODE_OPTIONS)
    throw new Error("source-bound build refuses implicit VITE or Node loader environment inputs");
  const inputs = await snapshotBuildInputs(root);
  const identity = fingerprint(inputs);
  let log = `Reviewed build-input SHA-256: ${identity}\n`;
  for (const name of ["panel-runtime", "shell"]) {
    const cwd = join(root, "packages", name);
    log += `\nnode packages/${name}/node_modules/vite/bin/vite.js build\n`;
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(cwd, "node_modules", "vite", "bin", "vite.js"), "build"], {
        cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, NODE_ENV: "production", CLAY_SOURCE_TREE: "unbound", CLAY_SOURCE_FINGERPRINT: identity },
      });
      child.stdout.on("data", bytes => { log += bytes; process.stdout.write(bytes); });
      child.stderr.on("data", bytes => { log += bytes; process.stderr.write(bytes); });
      child.on("error", reject); child.on("close", resolve);
    });
    await writeFile(logPath, log);
    if (exitCode !== 0) throw new Error(`source-bound ${name} build exited ${exitCode}; see build.log`);
  }
  if (fingerprint(await snapshotBuildInputs(root)) !== identity) throw new Error("build inputs changed during production build");
  const html = await readFile(join(root, "packages/shell/dist/index.html"), "utf8");
  if (!html.includes(`name="clay-source-fingerprint" content="${identity}"`))
    throw new Error("production artifact lacks the exact reviewed input identity");
  return inputs;
}
