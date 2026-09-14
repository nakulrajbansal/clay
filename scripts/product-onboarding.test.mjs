import assert from "node:assert/strict";
import test from "node:test";
import { chooseProductStarter, productChromiumOptions } from "./product-onboarding.mjs";

// The gate must perform the public choice, never seed a cache/namespace or skip
// onboarding. A small accessibility driver makes selector drift deterministic.
function onboarding() {
  const calls = [];
  let gallery = false;
  const page = {
    getByRole(role, { name }) {
      return {
        async waitFor() { assert.equal(role, "heading"); calls.push("heading"); },
        async click() {
          assert.equal(role, "button");
          if (name.test("See all templates Choose a different ready-made starter.")) {
            gallery = true; calls.push("gallery");
          } else if (name.test("Use a recommended starter Tracker. Keep track of work. Open")) {
            calls.push("recommended");
          } else throw new Error("Not a visible onboarding control");
        },
      };
    },
    locator(selector) {
      assert.equal(selector, "#starter-gallery");
      return { getByRole(role, { name }) { return { async click() {
        assert.ok(gallery, "gallery must be opened before selecting its template");
        assert.equal(role, "button");
        assert.ok(name.test("Sales CRM Keep your pipeline moving."));
        assert.ok(!name.test("Sales CRMs An unrelated template"));
        calls.push("Sales CRM");
      } }; } };
    },
  };
  return { page, calls };
}

test("recommended journey uses the current primary action", async () => {
  const { page, calls } = onboarding();
  await chooseProductStarter(page);
  assert.deepEqual(calls, ["heading", "recommended"]);
});
test("specific starter is chosen from the accessible template gallery", async () => {
  const { page, calls } = onboarding();
  await chooseProductStarter(page, "Sales CRM");
  assert.deepEqual(calls, ["heading", "gallery", "Sales CRM"]);
});

test("owned browser finder permits explicit installed channels, never a sandbox bypass", () => {
  assert.deepEqual(productChromiumOptions({}), { chromiumSandbox: true });
  assert.deepEqual(productChromiumOptions({ CLAY_TEST_CHROMIUM_CHANNEL: "chrome" }),
    { chromiumSandbox: true, channel: "chrome" });
  assert.throws(() => productChromiumOptions({ CLAY_TEST_CHROMIUM_CHANNEL: "--no-sandbox" }));
  assert.throws(() => productChromiumOptions({ PLAYWRIGHT_CDP_URL: "http://127.0.0.1:9222" }));
});
