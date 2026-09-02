// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LazySurfaceBoundary } from "../src/app/LazySurfaceBoundary";

function BrokenSurface(): React.JSX.Element {
  throw new Error("chunk failed");
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("LazySurfaceBoundary", () => {
  it("contains a rejected lazy surface and leaves a visible recovery action", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const mount = document.createElement("div");
    document.body.append(mount);
    await act(async () => {
      createRoot(mount).render(
        <LazySurfaceBoundary label="views">
          <BrokenSurface />
        </LazySurfaceBoundary>,
      );
    });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Couldn’t open views");
    expect(document.querySelector("button")?.textContent).toBe("Reload Clay");
  });
});
