// @vitest-environment jsdom
// localStorage is a replace-only presentation cache. Durable app identity,
// selection, metadata, tombstones, and lifecycle live in the DB worker catalog.
import { beforeEach, describe, expect, it } from "vitest";
import * as appsModule from "../src/app/apps";
import {
  currentApp, currentAppId, deriveAppName, listApps, replaceAppCache, shellName,
} from "../src/app/apps";

beforeEach(() => localStorage.clear());

const canonical = [
  { id: `app_${"a".repeat(26)}`, name: "Projects", shellId: "tracker" },
  { id: `app_${"b".repeat(26)}`, name: "Inventory", shellId: "inventory" },
];

describe("worker-owned app projection cache", () => {
  it("starts empty and exposes no local lifecycle mutators", () => {
    expect(listApps()).toEqual([]);
    expect(currentAppId()).toBeNull();
    for (const unsafe of [
      "createApp", "addForkEntry", "renameApp", "removeApp",
      "setCurrentApp", "ensureLegacyAdopted",
    ]) expect(appsModule).not.toHaveProperty(unsafe);
  });

  it("atomically replaces stale presentation state from a canonical worker projection", () => {
    localStorage.setItem("clay_apps", JSON.stringify([
      { id: "default", name: "Stale", shellId: "tracker" },
    ]));
    localStorage.setItem("clay_current_app", "default");

    replaceAppCache(canonical, canonical[1]!.id);

    expect(listApps()).toEqual(canonical);
    expect(currentAppId()).toBe(canonical[1]!.id);
    expect(currentApp()).toEqual(canonical[1]);
  });

  it("rejects an inconsistent projection without replacing the old cache", () => {
    replaceAppCache(canonical, canonical[0]!.id);
    expect(() => replaceAppCache(canonical, `app_${"c".repeat(26)}`))
      .toThrow("does not contain selected app");
    expect(listApps()).toEqual(canonical);
    expect(currentAppId()).toBe(canonical[0]!.id);
  });

  it("treats malformed cached JSON as an empty, non-authoritative hint", () => {
    localStorage.setItem("clay_apps", "not json");
    localStorage.setItem("clay_current_app", "made-up-selection");
    expect(listApps()).toEqual([]);
    expect(currentApp()).toBeNull();
  });

  it("maps shell ids to friendly presentation names", () => {
    expect(shellName("crm")).toBe("Sales CRM");
    expect(shellName("financials")).toBe("Bookkeeping");
    expect(shellName(null)).toBe("My app");
  });
});

describe("deriveAppName (blank apps earn their name from the first build)", () => {
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
