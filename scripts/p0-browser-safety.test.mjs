import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestOrigin, rejectExternalBrowser, markOwnedContext, assertOwnedPage } from "./p0-browser-safety.mjs";

test("only the exact owned loopback P0 origin is accepted", () => {
  assert.equal(assertTestOrigin("http://127.0.0.1:4181"), "http://127.0.0.1:4181");
  for (const url of ["https://clay.example", "http://localhost:4180", "http://127.0.0.1:4181.evil.test", "http://user@127.0.0.1:4181", "http://127.0.0.1:4181/path", "http://127.0.0.2:4181"])
    assert.throws(() => assertTestOrigin(url), /owned loopback/);
});
test("external CDP is refused before any connection or storage operation", () => {
  rejectExternalBrowser({});
  assert.throws(() => rejectExternalBrowser({ PLAYWRIGHT_CDP_URL: "http://127.0.0.1:9333" }), /external CDP/);
  assert.throws(() => rejectExternalBrowser({ URL: "http://127.0.0.1:4181" }), /external preview/);
});
test("an unowned page or missing/mismatched disposable marker fails closed", async () => {
  const context = { addInitScript: async () => {} };
  const page = { context: () => context, url: () => "http://127.0.0.1:4181/", evaluate: async () => "wrong" };
  await assert.rejects(() => assertOwnedPage(page), /owned disposable/);
  const marker = await markOwnedContext(context);
  await assert.rejects(() => assertOwnedPage(page), /disposable marker/);
  page.evaluate = async () => marker;
  await assertOwnedPage(page);
  page.url = () => "http://127.0.0.1:4180/";
  await assert.rejects(() => assertOwnedPage(page), /owned loopback/);
});
