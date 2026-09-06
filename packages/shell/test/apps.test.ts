// @vitest-environment jsdom
// The multi-app registry (G4): create/switch/remove semantics over
// localStorage, including the legacy-adoption path for existing single-app
// users and the "first app uses the default id" rule (preserves /user.db).
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cachePublishedApp, createApp, currentApp, currentAppId, ensureLegacyAdopted, listApps,
  removeApp, renameApp, setCurrentApp, shellName,
} from "../src/app/apps";

beforeEach(() => localStorage.clear());

describe("app registry", () => {
  it("starts empty", () => {
    expect(listApps()).toEqual([]);
    expect(currentAppId()).toBeNull();
  });

  it("the first app uses the legacy 'default' id; more get unique ids", () => {
    const a = createApp("Tracker", "tracker");
    expect(a.id).toBe("default");
    expect(currentAppId()).toBe("default");
    const b = createApp("Sales CRM", "crm");
    expect(b.id).not.toBe("default");
    expect(listApps().map(x => x.name)).toEqual(["Tracker", "Sales CRM"]);
    expect(currentApp()?.id).toBe(b.id);   // new app becomes current
  });

  it("caches the exact worker-published app idempotently and rejects rebinding", () => {
    const published = { id: "default", name: "Imported data", shellId: "blank" };
    expect(cachePublishedApp(published)).toEqual(published);
    expect(cachePublishedApp(published)).toEqual(published);
    expect(listApps()).toEqual([published]);
    expect(currentAppId()).toBe("default");

    expect(() => cachePublishedApp({ ...published, shellId: "tracker" }))
      .toThrow(/binding/i);
    expect(listApps()).toEqual([published]);
  });

  it("rolls the presentation cache back when either localStorage write fails", () => {
    const existing = createApp("Tracker", "tracker");
    const beforeApps = localStorage.getItem("clay_apps");
    const beforeCurrent = localStorage.getItem("clay_current_app");
    const native = Storage.prototype.setItem;
    let writes = 0;
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage, key, value,
    ) {
      writes++;
      if (writes === 2) throw new Error("injected cache failure");
      native.call(this, key, value);
    });
    try {
      expect(() => cachePublishedApp({ id: "published-app", name: "CRM", shellId: "crm" }))
        .toThrow("injected cache failure");
    } finally {
      spy.mockRestore();
    }
    expect(localStorage.getItem("clay_apps")).toBe(beforeApps);
    expect(localStorage.getItem("clay_current_app")).toBe(beforeCurrent);
    expect(currentAppId()).toBe(existing.id);
  });

  it("switch + rename", () => {
    createApp("Tracker", "tracker");
    const b = createApp("CRM", "crm");
    setCurrentApp("default");
    expect(currentApp()?.name).toBe("Tracker");
    renameApp(b.id, "Pipeline");
    setCurrentApp(b.id);
    expect(currentApp()?.name).toBe("Pipeline");
  });

  it("removing the current app switches to another; removing the last clears current", () => {
    createApp("Tracker", "tracker");       // default
    const b = createApp("CRM", "crm");      // current
    const next = removeApp(b.id);
    expect(next).toBe("default");
    expect(currentAppId()).toBe("default");
    expect(listApps().map(a => a.id)).toEqual(["default"]);
    const none = removeApp("default");
    expect(none).toBeNull();
    expect(currentAppId()).toBeNull();
    expect(listApps()).toEqual([]);
  });

  it("removing a non-current app leaves current unchanged", () => {
    createApp("Tracker", "tracker");        // default, current
    const b = createApp("CRM", "crm");      // current now b
    setCurrentApp("default");
    const stay = removeApp(b.id);
    expect(stay).toBe("default");
    expect(currentAppId()).toBe("default");
  });

  it("ensureLegacyAdopted adopts existing data as 'default' only when the registry is empty", () => {
    ensureLegacyAdopted(true, "small_business");
    expect(listApps()).toEqual([{ id: "default", name: "Small Business", shellId: "small_business" }]);
    expect(currentAppId()).toBe("default");
    // idempotent — does not duplicate
    ensureLegacyAdopted(true, "crm");
    expect(listApps()).toHaveLength(1);
  });

  it("ensureLegacyAdopted does nothing when unseeded", () => {
    ensureLegacyAdopted(false, null);
    expect(listApps()).toEqual([]);
  });

  it("shellName maps ids to friendly names", () => {
    expect(shellName("crm")).toBe("Sales CRM");
    expect(shellName("financials")).toBe("Bookkeeping");
    expect(shellName(null)).toBe("My app");
  });
});

describe("deriveAppName (blank apps earn their name from the first build)", () => {
  it("extracts the head noun phrase from a plan summary", async () => {
    const { deriveAppName } = await import("../src/app/apps");
    expect(deriveAppName("Creates a Portfolio Dashboard with a projects table and a status board."))
      .toBe("Portfolio Dashboard");
    expect(deriveAppName("Builds a customer feedback tracker with a summary strip."))
      .toBe("Customer feedback tracker");
    expect(deriveAppName("Adds an expense approvals app for your team."))
      .toBe("Expense approvals app");
    expect(deriveAppName("")).toBeNull();
  });
});
