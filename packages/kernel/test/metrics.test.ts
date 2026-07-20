import { describe, it, expect } from "vitest";
import { MetricsCollector, classifyDiffKind } from "../src/metrics";
import type { DebugEvent } from "../src/pipeline";

// Helper: feed a synthetic attempt (the DebugEvent sequence the pipeline emits).
function feed(c: MetricsCollector, evs: DebugEvent[]): void {
  for (const ev of evs) c.onDebug(ev);
}

const intake = (intent: string): DebugEvent => ({
  stage: "intake", intent, registryTables: [], panelCount: 0,
});

describe("classifyDiffKind", () => {
  it("labels common reshape intents", () => {
    expect(classifyDiffKind("add a priority field to tasks")).toBe("add_field");
    expect(classifyDiffKind("show it as a colored badge")).toBe("restyle");
    expect(classifyDiffKind("add a chart of revenue by month")).toBe("chart");
    expect(classifyDiffKind("add a new panel for notes")).toBe("add_panel");
    expect(classifyDiffKind("remove the archive panel")).toBe("remove_panel");
    expect(classifyDiffKind("make everything faster somehow")).toBe("other");
  });
});

describe("MetricsCollector", () => {
  it("counts a clean first-pass preview as first-pass commit", () => {
    const c = new MetricsCollector();
    feed(c, [
      intake("add a priority field to tasks"),
      { stage: "plan", raw: "{}", ok: true },
      { stage: "dry_run", ok: true },
      { stage: "outcome", status: "preview", repaired: false },
    ]);
    const s = c.summary();
    expect(s.attempts).toBe(1);
    expect(s.firstPassCommitRate).toBe(1);
    expect(s.repairRate).toBe(0);
    expect(s.firstPassByDiffKind.add_field.rate).toBe(1);
  });

  it("does not count a repaired attempt as first-pass", () => {
    const c = new MetricsCollector();
    feed(c, [
      intake("add a colored badge"),
      { stage: "plan", raw: "{}", ok: true },
      { stage: "validate", issues: ["V4 [p1]: query does not match any declared query"] },
      { stage: "repair", trigger: "validate", reasons: ["V4"] },
      { stage: "plan", raw: "{}", ok: true },
      { stage: "dry_run", ok: true },
      { stage: "outcome", status: "preview", repaired: true },
    ]);
    const s = c.summary();
    expect(s.firstPassCommitRate).toBe(0);
    expect(s.repairRate).toBe(1);
    expect(s.validatorRejections.V4).toBe(1);
  });

  it("tracks clarify and fail rates and fail stages", () => {
    const c = new MetricsCollector();
    feed(c, [
      intake("do something ambiguous"),
      { stage: "plan", raw: "{}", ok: true },
      { stage: "outcome", status: "clarify", repaired: false },
    ]);
    feed(c, [
      intake("add a field but it breaks"),
      { stage: "plan", raw: "{}", ok: true },
      { stage: "validate", issues: ["V5: migration is not reversible"] },
      { stage: "repair", trigger: "validate", reasons: ["V5"] },
      { stage: "plan", raw: "{}", ok: true },
      { stage: "validate", issues: ["V5: migration is not reversible"] },
      { stage: "outcome", status: "failed@validate", repaired: true },
    ]);
    const s = c.summary();
    expect(s.attempts).toBe(2);
    expect(s.clarifyRate).toBe(0.5);
    expect(s.failRate).toBe(0.5);
    expect(s.failStages.validate).toBe(1);
    expect(s.validatorRejections.V5).toBe(1);
  });

  it("markCommitted promotes the latest preview to committed", () => {
    const c = new MetricsCollector();
    feed(c, [
      intake("add a field"),
      { stage: "plan", raw: "{}", ok: true },
      { stage: "dry_run", ok: true },
      { stage: "outcome", status: "preview", repaired: false },
    ]);
    c.markCommitted();
    expect(c.all()[0].outcome).toBe("committed");
    // still counts as first-pass
    expect(c.summary().firstPassCommitRate).toBe(1);
  });

  it("tees events to a downstream handler without altering them", () => {
    const seen: string[] = [];
    const c = new MetricsCollector((ev) => seen.push(ev.stage));
    feed(c, [
      intake("add a field"),
      { stage: "plan", raw: "{}", ok: true },
      { stage: "outcome", status: "preview", repaired: false },
    ]);
    expect(seen).toEqual(["intake", "plan", "outcome"]);
  });

  it("records intent length only, never the raw intent text", () => {
    const c = new MetricsCollector();
    feed(c, [
      intake("secret private business idea about tacos"),
      { stage: "plan", raw: "{}", ok: true },
      { stage: "outcome", status: "preview", repaired: false },
    ]);
    const r = c.all()[0];
    expect(r.intentLength).toBe("secret private business idea about tacos".length);
    expect(JSON.stringify(r)).not.toContain("tacos");
  });
});
