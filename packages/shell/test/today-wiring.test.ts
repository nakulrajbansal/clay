import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DB_WORKER_ROUTE_CENSUS } from "../src/worker/mutation-route-census";

const shellRoot = path.resolve(import.meta.dirname, "..");
const read = (relative: string): string => fs.readFileSync(path.join(shellRoot, relative), "utf8");

describe("Today production wiring", () => {
  it("routes one trusted worker projection into the default Work surface", () => {
    const worker = read("src/worker/db-worker.ts");
    const app = read("src/app/App.tsx");

    expect(DB_WORKER_ROUTE_CENSUS.dailyHome).toEqual({ enforcement: "read", mutates: "none" });
    expect(worker).toContain('case "dailyHome"');
    expect(worker).toContain("projectDailyHome(mustStore()");
    expect(worker).toContain("mustAuthority().bootInfo()");
    expect(app).toContain('import("./TodayView")');
    expect(app).toContain('workspaceMode === "work"');
    expect(app).toContain("<TodayView");
    expect(app).toContain("openCommandPalette(true)");
    expect(app).toContain("store={dataStoreRef.current}");
    expect(app).toContain("captureMode={quickCaptureMode}");
    expect(app).toContain("onOpenSavedView={id => openData(undefined, undefined, id)}");
    expect(app).toContain("initialSavedViewId={dataSavedView}");
    expect(app).toContain('onCreateRecurring={() => openAutomations("recurring_record")}');
    expect(app).toContain("initialRecipe={automationRecipe}");
  });

  it("keeps every uncertified Daily Home writer and production control fail-closed", () => {
    const worker = read("src/worker/db-worker.ts");
    const client = read("src/app/worker-client.ts");
    const app = read("src/app/App.tsx");
    const expected = [
      "dailyHomeSourceCompareAndSet",
      "dailyHomeNavigationCompareAndSet",
      "dailyHomeInitializeTimeZone",
      "dailyHomeQuickCapture",
      "dailyHomeUndoCapture",
    ] as const;

    for (const route of expected) {
      expect(DB_WORKER_ROUTE_CENSUS[route]).toEqual({ enforcement: "unavailable", mutates: "live" });
      expect(worker).toContain(`case "${route}"`);
    }
    expect(worker).not.toContain('runAuthorityMutation("dailyHome');
    expect(client).not.toContain("ensureDailyHomeTimeZone");
    expect(app).toContain("dailyHomeMutationsAvailable={false}");
    expect(app).not.toContain("onRecordOpened={recordDailyOpen}");
    expect(app).not.toContain("toggleDailyFavorite(client()");
  });

  it("uses a read-time runtime calendar without initializing durable Daily Home state", () => {
    const worker = read("src/worker/db-worker.ts");
    const client = read("src/app/worker-client.ts");
    const palette = read("src/app/CommandPalette.tsx");
    const projection = read("../kernel/src/daily-home-projection.ts");

    expect(client).toContain("dailyHomeRuntimeTimeZone");
    expect(client).not.toContain("ensureDailyHomeTimeZone");
    expect(client).toContain('this.call("dailyHomeResolveDate"');
    expect(worker).toContain('case "dailyHomeResolveDate"');
    expect(worker).toContain('typeof p.timeZone === "string" ? p.timeZone : null');
    expect(palette).toContain("await props.worker.resolveDailyHomeDate(value)");
    expect(projection).toContain("localCalendarContext(context.now, context.timeZone)");
    expect(projection).toContain("timeZone: context.timeZone");
    expect(projection).not.toContain("DAILY_TIME_ZONE_SETTING");
  });

  it("does not persist recent-work navigation while Daily Home writes are uncertified", () => {
    const app = read("src/app/App.tsx");
    const dataView = read("src/app/DataView.tsx");

    expect(app).not.toContain("const recordDailyOpen =");
    expect(app).not.toContain("onRecordOpened={recordDailyOpen}");
    expect(dataView).toContain("const openRecordDetail =");
    expect(dataView).toContain("props.onRecordOpened?.(table, id)");
    expect(dataView).not.toContain("onClick={() => setDetailStack");
    expect(dataView).toContain("onNavigate={(nextTable, id) => openRecordDetail(nextTable, id, true)}");
  });
});
