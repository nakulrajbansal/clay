import { describe, expect, it } from "vitest";
import { parseDailyTemporal } from "../src/daily-calendar";

function minuteValue(index: number): string {
  const hour = Math.floor((index % 1_440) / 60);
  const minute = index % 60;
  return `2026-09-06T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function distinctDayValue(index: number): string {
  const date = new Date(Date.UTC(2000, 0, 1) + index * 86_400_000)
    .toISOString().slice(0, 10);
  return `${date}T12:34:${String(index % 60).padStart(2, "0")}.${String(index % 1_000).padStart(3, "0")}`;
}

describe("Daily Home calendar performance", () => {
  it("classifies 50,000 cache-hot wall values within the 4x CPU budget", () => {
    const values = Array.from({ length: 50_000 }, (_, index) => minuteValue(index));
    const historicalAndDstValues = [
      "2026-03-08T02:30",
      "2026-11-01T01:30",
      "0001-01-01T00:00",
      "1880-01-01T00:00",
    ];
    for (const value of new Set(values)) parseDailyTemporal(value, "America/Detroit");
    for (const value of historicalAndDstValues)
      parseDailyTemporal(value, "America/New_York");
    const samples: number[] = [];
    let invalid = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const started = performance.now();
      for (const value of values) {
        if (parseDailyTemporal(value, "America/Detroit") === null) invalid += 1;
      }
      for (const value of historicalAndDstValues) {
        if (parseDailyTemporal(value, "America/New_York") === null) invalid += 1;
      }
      samples.push(performance.now() - started);
    }
    const simulatedFourTimesCpuMs = Math.min(...samples) * 4;
    expect(invalid).toBe(0);
    expect(simulatedFourTimesCpuMs).toBeLessThan(500);
  });

  it("classifies cache-churning wall dates and DST gaps within the 4x projection budget", () => {
    const wallValues = Array.from({ length: 5_000 }, (_, index) => distinctDayValue(index));
    const gapValues = Array.from({ length: 64 }, (_, index) =>
      `2024-03-10T02:30:00.${String(index).padStart(3, "0")}`);
    const started = performance.now();
    let invalid = 0;
    for (const value of wallValues) {
      if (parseDailyTemporal(value, "America/New_York") === null) invalid += 1;
    }
    for (const value of gapValues) {
      if (parseDailyTemporal(value, "America/New_York") === null) invalid += 1;
    }
    const simulatedFourTimesCpuMs = (performance.now() - started) * 4;
    expect(invalid).toBe(0);
    expect(simulatedFourTimesCpuMs).toBeLessThan(2_000);
  });
});
