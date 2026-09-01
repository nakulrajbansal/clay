// Production bundle guard. The limits deliberately sit just above the
// current verified baseline so any unreviewed growth becomes a release failure.
import { gzipSync } from "node:zlib";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const assets = fileURLToPath(new URL("../packages/shell/dist/assets/", import.meta.url));
const names = await readdir(assets);

async function measure(pattern, label, rawLimit, gzipLimit) {
  const matches = names.filter(name => pattern.test(name));
  if (matches.length !== 1) {
    throw new Error(`${label}: expected one matching asset, found ${matches.length}`);
  }
  const name = matches[0];
  const path = join(assets, name);
  const raw = (await stat(path)).size;
  const gzip = gzipSync(await readFile(path)).byteLength;
  if (raw > rawLimit || gzip > gzipLimit) {
    throw new Error(`${label}: ${raw} B raw / ${gzip} B gzip exceeds ${rawLimit} B / ${gzipLimit} B`);
  }
  console.log(`PASS ${label}: ${raw} B raw / ${gzip} B gzip`);
}

await measure(/^index-[^.]+\.js$/, "main application", 850_000, 250_000);
await measure(/^db-worker-[^.]+\.js$/, "database worker", 650_000, 190_000);
await measure(/^index-[^.]+\.css$/, "application styles", 50_000, 10_000);
console.log("BUNDLE BUDGET GREEN");
