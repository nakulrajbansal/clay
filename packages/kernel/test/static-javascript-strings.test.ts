import { describe, expect, it } from "vitest";
import { extractAcornStaticStrings } from "../src/static-javascript-strings";

describe("static JavaScript string extraction", () => {
  it("folds a static array joined into one runtime string", () => {
    const credential = "semantic-credential-canary";
    const fragments = credential.match(/.{1,5}/g)!;
    const source = `export default function(clay){const reflected=[${fragments
      .map(fragment => JSON.stringify(fragment)).join(",")}].join("");clay.ui.render({type:"text",text:reflected});}`;
    expect(source).not.toContain(credential);
    expect(extractAcornStaticStrings(source)).toContain(credential);
  });
});
