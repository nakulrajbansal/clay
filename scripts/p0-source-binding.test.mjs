import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotBuildInputs, fingerprint } from "./p0-source-binding.mjs";

test("build identity covers transitive workspace/config/spec inputs and ignores generated artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "clay-p0-binding-test-"));
  for (const dir of ["packages/shell/src", "packages/shell/dist", "scripts", "specs"]) await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, "package.json"), "{}");
  await writeFile(join(root, "packages/shell/src/main.ts"), "export const version = 1;");
  const first = fingerprint(await snapshotBuildInputs(root));
  await writeFile(join(root, "packages/shell/dist/index.html"), "unrelated prior artifact");
  assert.equal(fingerprint(await snapshotBuildInputs(root)), first);
  await writeFile(join(root, "packages/shell/vite.config.ts"), "export default {};");
  assert.notEqual(fingerprint(await snapshotBuildInputs(root)), first);
  await writeFile(join(root, "packages/shell/.env.production"), "DISPOSABLE_TEST_VALUE=not-a-secret");
  await assert.rejects(() => snapshotBuildInputs(root), /environment file/);
});

test("installed dependency bytes are build inputs even when the lockfile is unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "clay-p0-dependency-test-"));
  for (const dir of ["packages", "scripts", "specs", "node_modules/.pnpm/tool/node_modules/tool"])
    await mkdir(join(root, dir), { recursive: true });
  const dependency = join(root, "node_modules/.pnpm/tool/node_modules/tool/index.js");
  await writeFile(dependency, "export const tool = 1;");
  const first = fingerprint(await snapshotBuildInputs(root));
  await writeFile(dependency, "export const tool = 2;");
  assert.notEqual(fingerprint(await snapshotBuildInputs(root)), first);
});
