/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from "vitest";
import {
  readWorkspaceMode, readWorkspaceModeForEntry, workspaceModeStorageKey, writeWorkspaceMode,
} from "../src/app/workspace-mode";

describe("workspace mode preference", () => {
  beforeEach(() => localStorage.clear());

  it("defaults every app to Work", () => {
    expect(readWorkspaceMode("app-a")).toBe("work");
    expect(readWorkspaceMode(null)).toBe("work");
  });

  it("opens an incomplete first-success journey in Work even when an old Customize preference exists", () => {
    writeWorkspaceMode("app-a", "customize");
    expect(readWorkspaceModeForEntry("app-a", false)).toBe("work");
    expect(readWorkspaceModeForEntry("app-a", true)).toBe("customize");
  });

  it("stores Customize as isolated per-app presentation state", () => {
    writeWorkspaceMode("app-a", "customize");
    expect(readWorkspaceMode("app-a")).toBe("customize");
    expect(readWorkspaceMode("app-b")).toBe("work");
  });

  it("fails safely to Work for malformed cached values", () => {
    localStorage.setItem(workspaceModeStorageKey("app-a"), "builder");
    expect(readWorkspaceMode("app-a")).toBe("work");
  });
});
