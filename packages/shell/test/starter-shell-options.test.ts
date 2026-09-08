import { describe, expect, it } from "vitest";
import { STARTER_SHELLS } from "../src/shells/seed";
import { STARTER_SHELL_OPTIONS } from "../src/shells/starter-shell-options";

describe("starter shell presentation catalog", () => {
  it("keeps the lightweight onboarding choices identical to canonical seed metadata", () => {
    expect(STARTER_SHELL_OPTIONS).toEqual(STARTER_SHELLS.map(shell => ({
      id: shell.id,
      name: shell.name,
      tagline: shell.tagline,
    })));
  });
});
