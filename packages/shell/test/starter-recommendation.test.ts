import { describe, expect, it } from "vitest";
import {
  DEFAULT_STARTER_GOAL, STARTER_GOALS, recommendStarter,
} from "../src/app/starter-recommendation";
import { STARTER_SHELLS } from "../src/shells/seed";

describe("starter recommendation", () => {
  it("uses Tracker as the safe first-run default", () => {
    expect(DEFAULT_STARTER_GOAL).toBe("tasks");
    expect(recommendStarter(DEFAULT_STARTER_GOAL)).toMatchObject({
      goal: "tasks", shellId: "tracker", name: "Tracker",
    });
  });

  it("maps every explicit goal to exactly one existing non-blank starter", () => {
    const shellIds = new Set(STARTER_SHELLS.map(shell => shell.id));
    const recommendations = STARTER_GOALS.map(goal => recommendStarter(goal.id));
    expect(recommendations).toHaveLength(15);
    expect(recommendations.map(item => item.shellId)).toEqual([
      "tracker", "log", "dashboard", "small_business", "crm", "financials", "staff",
      "habits", "inventory", "approvals", "jobs", "content", "okrs", "events", "library",
    ]);
    for (const recommendation of recommendations) {
      expect(shellIds.has(recommendation.shellId)).toBe(true);
      expect(recommendation.shellId).not.toBe("blank");
      expect(recommendation.rationale.length).toBeGreaterThan(0);
    }
  });

  it("is deterministic and rejects unrecognized goals without inspecting data", () => {
    expect(recommendStarter("money")).toEqual(recommendStarter("money"));
    expect(() => recommendStarter("record contents" as never)).toThrow(/goal/i);
  });
});
