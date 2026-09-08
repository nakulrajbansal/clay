import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const config = JSON.parse(await readFile(new URL("vercel.json", root), "utf8"));

test("hosted F1 routes ciphertext API separately from the recipient SPA", () => {
  const rewrites = new Map(config.rewrites.map(rule => [rule.source, rule.destination]));
  assert.equal(rewrites.get("/shares/:path*"), "/api");
  assert.equal(rewrites.get("/share/:path*"), "/index.html");
  assert.equal([...rewrites.keys()].indexOf("/shares/:path*")
    < [...rewrites.keys()].indexOf("/share/:path*"), true);
});
