import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createStarterSeedBundle, STARTER_SHELLS } from "../src/shells/seed";
import { createStarterSeedBundle as original, STARTER_SHELLS as originalShells } from "./oracles/seed";
import { canonicalSeedJson } from "../src/worker/pure-compute-contract";
import manifest from "../src/worker/seed-manifest.json";

it("keeps independent old starter sources pinned", () => {
  for (const [file, sha] of Object.entries({
    "seed.ts": "e6214423efb495cb3f3e3074025a31f54474161bc3b4a72f42ab798757d2a821",
    "seed-panels.ts": "8dc2672a0cbcf0cb45d4d17ce62cdc2ad375a58c0870b8c00b77c006723e2ba4",
  })) {
    const source = readFileSync(new URL(`./oracles/${file}`, import.meta.url), "utf8").replaceAll("\r\n", "\n").split("\n").slice(1).join("\n");
    expect(createHash("sha256").update(source).digest("hex")).toBe(sha);
  }
});
it.each(originalShells.map(s => s.id))("retains %s byte/order/canonical identity before and after compaction", id => {
  expect(STARTER_SHELLS.find(s => s.id === id)).toEqual(originalShells.find(s => s.id === id));
  const bundle = createStarterSeedBundle(id), old = original(id);
  expect(JSON.stringify(bundle)).toBe(JSON.stringify(old));
  const bytes = canonicalSeedJson(bundle);
  expect(bytes).toBe(canonicalSeedJson(old));
  expect(Buffer.byteLength(bytes)).toBe(manifest.fragments[id].bytes);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(manifest.fragments[id].sha256);
  expect(createHash("sha256").update(JSON.stringify(old)).digest("hex")).toBe(manifest.fragments[id].wireSha256);
});
