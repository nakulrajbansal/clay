// relTime for the History timeline: human-friendly "when" per version.
import { describe, expect, it, vi, afterEach } from "vitest";
import { relTime } from "../src/app/HistoryView";

afterEach(() => vi.useRealTimers());

describe("relTime", () => {
  const now = new Date("2026-07-14T12:00:00Z").getTime();
  const at = (ms: number): string => new Date(now - ms).toISOString();

  it("buckets recent times", () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    expect(relTime(at(10_000))).toBe("just now");        // 10s
    expect(relTime(at(5 * 60_000))).toBe("5m ago");      // 5m
    expect(relTime(at(3 * 3600_000))).toBe("3h ago");    // 3h
  });

  it("falls back to a date for older entries", () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const older = relTime(at(4 * 86_400_000));           // 4 days
    expect(older).not.toMatch(/ago|just now/);
    expect(older.length).toBeGreaterThan(0);
  });

  it("is safe on a bad timestamp", () => {
    expect(relTime("not-a-date")).toBe("");
  });
});
