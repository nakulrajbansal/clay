// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  currentApp, currentAppId, deriveAppName, listApps, replaceAppCache, shellName,
} from "../src/app/apps";

const app = (letter: string, name: string, shellId: string) => ({
  id: `app_${letter.repeat(26)}`,
  name,
  shellId,
});

beforeEach(() => localStorage.clear());

describe("worker-owned app catalog presentation cache", () => {
  it("starts empty", () => {
    expect(listApps()).toEqual([]);
    expect(currentAppId()).toBeNull();
  });

  it("replaces stale presentation state from one canonical worker projection", () => {
    localStorage.setItem("clay_apps", JSON.stringify([
      { id: "default", name: "Old local name", shellId: "tracker" },
    ]));
    localStorage.setItem("clay_current_app", "default");
    const canonical = [app("a", "Projects", "tracker"), app("b", "Inventory", "inventory")];
    replaceAppCache(canonical, canonical[1]!.id);
    expect(listApps()).toEqual(canonical);
    expect(currentAppId()).toBe(canonical[1]!.id);
    expect(currentApp()).toEqual(canonical[1]);
  });

  it("rejects identities that were not published by durable authority", () => {
    const canonical = [app("a", "Projects", "tracker")];
    expect(() => replaceAppCache(canonical, "default")).toThrow(/valid selected app/);
    expect(() => replaceAppCache([
      ...canonical,
      { id: "shell-minted", name: "Unsafe", shellId: "blank" },
    ], canonical[0]!.id)).toThrow(/valid selected app/);
    expect(listApps()).toEqual([]);
    expect(currentAppId()).toBeNull();
  });

  it("rejects ambiguous and malformed worker projections before writing", () => {
    const canonical = app("a", "Projects", "tracker");
    expect(() => replaceAppCache([canonical, canonical], canonical.id)).toThrow();
    expect(() => replaceAppCache([{ ...canonical, name: " Projects" }], canonical.id)).toThrow();
    expect(listApps()).toEqual([]);
  });

  it("maps starter ids to friendly names", () => {
    expect(shellName("crm")).toBe("Sales CRM");
    expect(shellName("financials")).toBe("Bookkeeping");
    expect(shellName(null)).toBe("My app");
  });
});

describe("deriveAppName", () => {
  it("extracts the head noun phrase from a plan summary", () => {
    expect(deriveAppName("Creates a Portfolio Dashboard with a projects table and a status board."))
      .toBe("Portfolio Dashboard");
    expect(deriveAppName("Builds a customer feedback tracker with a summary strip."))
      .toBe("Customer feedback tracker");
    expect(deriveAppName("Adds an expense approvals app for your team."))
      .toBe("Expense approvals app");
    expect(deriveAppName("")).toBeNull();
  });
});
