import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectReviewFiles, scanReviewSource } from "./p0-review-evidence.mjs";

test("review binds generated logs and browser evidence even when Git ignores them", async () => {
  const root = await mkdtemp(join(tmpdir(), "clay-p0-review-test-"));
  await mkdir(join(root, "evidence/p0-verification"), { recursive: true });
  const log = "evidence/p0-verification/suite-kernel.log";
  await writeFile(join(root, log), "real gate output");
  await writeFile(join(root, "evidence/p0-verification/review.json"), "prior self manifest");
  const first = await collectReviewFiles(root, []);
  assert.deepEqual(Object.keys(first), [log]);
  await writeFile(join(root, log), "altered gate output");
  assert.notEqual((await collectReviewFiles(root, []))[log], first[log]);
  await assert.rejects(() => collectReviewFiles(root, ["../outside.txt"]), /review path/);
});

test("security scan distinguishes SQLite exec from executable shell interpolation", () => {
  assert.deepEqual(scanReviewSource("db.ts", 'driver.exec(`SELECT * FROM "row_history"`);'), []);
  assert.equal(scanReviewSource("run.mjs", 'import { exec } from "node:child_process";\nexec(`tool ${input}`);')[0].reason,
    "shell interpolation");
  assert.equal(scanReviewSource("panel.ts", 'element.innerHTML = userOutput;')[0].reason, "unsafe HTML sink");
  assert.equal(scanReviewSource("panel.ts", 'eval(userOutput);')[0].reason, "executable evaluation");
  assert.deepEqual(scanReviewSource("fixture.ts", 'const sample = "eval(userOutput); element.innerHTML = value";'), []);
});
