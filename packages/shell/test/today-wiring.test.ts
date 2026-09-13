import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DB_WORKER_ROUTE_CENSUS } from "../src/worker/mutation-route-census";

const root = path.resolve(import.meta.dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

// Inventory guards only. Source text is not executable user-journey proof.
describe("Today development wiring inventory", () => {
  it("uses paired authority projections and enables the connected Daily surface", () => {
    expect(DB_WORKER_ROUTE_CENSUS.dailyPresentation).toEqual({ enforcement: "read", mutates: "none" });
    expect(read("src/worker/db-worker.ts")).toContain('case "dailyPresentation"');
    expect(read("src/app/TodayView.tsx")).toContain("props.worker.dailyPresentation()");
    expect(read("src/app/App.tsx")).toContain("dailyHomeMutationsAvailable");
    expect(read("src/app/App.tsx")).not.toContain("dailyHomeMutationsAvailable={false}");
  });
  it("routes every exposed Daily writer to authority", () => {
    for (const name of ["dailyHomeSourceCompareAndSet", "dailyHomeNavigationCompareAndSet", "dailyHomeInitializeTimeZone",
      "dailyHomeQuickCapture", "dailyHomeUndoCapture", "dailyInboxAction", "dailyInboxUndo"] as const)
      expect(DB_WORKER_ROUTE_CENSUS[name]).toEqual({ enforcement: "authority", mutates: "live" });
  });
  it("initializes the durable calendar and retains immutable CAS values", () => {
    const client = read("src/app/worker-client.ts");
    expect(client).toContain("ensureDailyHomeTimeZone");
    expect(read("src/app/daily-intent.ts")).toContain("beginPresentationIntent");
    expect(client).not.toContain("toggleDailyFavorite(");
    expect(client).not.toContain("rememberDailyRecordOpened(");
  });
  it("defers incidental navigation and scheduled writes during original-source Undo", () => {
    expect(read("src/app/RecordDetail.tsx")).toContain("mayRecordPresentationSideEffects");
    expect(read("src/app/automation-tick.ts")).toContain('"captureUndo"');
    expect(read("src/app/automation-tick.ts")).toContain('"dailyInboxUndo"');
    expect(read("src/app/App.tsx")).toContain("automationMutationsAvailable={automationStorageAvailable}");
  });
});
