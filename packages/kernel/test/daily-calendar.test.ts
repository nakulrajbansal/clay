import { describe, expect, it } from "vitest";
import {
  localCalendarContext,
  parseDailyTemporal,
  resolveLocalDateTime,
} from "../src/daily-calendar";

describe("Daily Home calendar", () => {
  it("keeps canonical date-only values floating in the selected app timezone", () => {
    expect(parseDailyTemporal("2028-02-29", "Pacific/Auckland")).toEqual({
      kind: "date",
      localDate: "2028-02-29",
      instant: null,
      adjusted: false,
    });
    expect(parseDailyTemporal("2026-02-29", "Pacific/Auckland")).toBeNull();
    expect(parseDailyTemporal("02/03/2026", "America/New_York")).toBeNull();
  });

  it("converts offset-bearing instants to the selected app date", () => {
    expect(parseDailyTemporal("2026-09-07T01:00:00.000Z", "America/New_York")).toEqual({
      kind: "instant",
      localDate: "2026-09-06",
      instant: "2026-09-07T01:00:00.000Z",
      adjusted: false,
    });
    expect(parseDailyTemporal("2026-09-06T21:00:00.000-04:00", "America/New_York")).toEqual({
      kind: "instant",
      localDate: "2026-09-06",
      instant: "2026-09-07T01:00:00.000Z",
      adjusted: false,
    });
  });

  it("normalizes every timestamp precision already accepted by row storage", () => {
    expect(parseDailyTemporal("2026-09-06T09:30Z", "UTC")?.instant)
      .toBe("2026-09-06T09:30:00.000Z");
    expect(parseDailyTemporal("2026-09-06T09:30:00Z", "UTC")?.instant)
      .toBe("2026-09-06T09:30:00.000Z");
    expect(parseDailyTemporal("2026-09-06T09:30:00.1Z", "UTC")?.instant)
      .toBe("2026-09-06T09:30:00.100Z");
    expect(parseDailyTemporal("2026-09-06T09:30:00.12+05:45", "UTC")?.instant)
      .toBe("2026-09-06T03:45:00.120Z");
    expect(parseDailyTemporal("2026-09-06T09:30:00.1", "UTC")).toEqual({
      kind: "wall_time",
      localDate: "2026-09-06",
      instant: "2026-09-06T09:30:00.100Z",
      adjusted: false,
    });
    expect(parseDailyTemporal("2026-09-06T24:00", "UTC")).toEqual({
      kind: "wall_time",
      localDate: "2026-09-07",
      instant: "2026-09-07T00:00:00.000Z",
      adjusted: false,
    });
    expect(parseDailyTemporal("2026-09-06T24:00Z", "UTC")).toEqual({
      kind: "instant",
      localDate: "2026-09-07",
      instant: "2026-09-07T00:00:00.000Z",
      adjusted: false,
    });
    expect(parseDailyTemporal("2026-09-06T24:00:01", "UTC")).toBeNull();
  });

  it("uses proleptic years without JavaScript's 1900 offset", () => {
    for (const year of ["0000", "0001", "0099"]) {
      expect(resolveLocalDateTime(`${year}-01-01T00:00`, "UTC")).toEqual({
        instant: `${year}-01-01T00:00:00.000Z`,
        localDateTime: `${year}-01-01T00:00:00.000`,
        offsetMinutes: 0,
        adjusted: false,
      });
    }
  });

  it("supports historical second-resolution offsets without malformed local dates", () => {
    expect(resolveLocalDateTime("0001-01-01T00:00", "America/New_York")).toEqual({
      instant: "0001-01-01T04:56:02.000Z",
      localDateTime: "0001-01-01T00:00:00.000",
      offsetMinutes: -296.03333333333336,
      adjusted: false,
    });
    expect(resolveLocalDateTime("0000-01-01T00:00", "America/New_York").instant)
      .toBe("0000-01-01T04:56:02.000Z");
    expect(parseDailyTemporal("0000-01-01T00:00Z", "America/New_York")).toBeNull();
  });

  it("treats zone-less date-times as wall time in the app timezone", () => {
    expect(parseDailyTemporal("2026-09-06T09:30", "America/New_York")).toEqual({
      kind: "wall_time",
      localDate: "2026-09-06",
      instant: "2026-09-06T13:30:00.000Z",
      adjusted: false,
    });
  });

  it("moves a nonexistent spring-forward wall time to the first valid instant", () => {
    expect(resolveLocalDateTime("2026-03-08T02:30", "America/New_York")).toEqual({
      instant: "2026-03-08T07:00:00.000Z",
      localDateTime: "2026-03-08T03:00:00.000",
      offsetMinutes: -240,
      adjusted: true,
    });
  });

  it("resolves a repeated autumn wall time once at the earlier offset", () => {
    expect(resolveLocalDateTime("2026-11-01T01:30", "America/New_York")).toEqual({
      instant: "2026-11-01T05:30:00.000Z",
      localDateTime: "2026-11-01T01:30:00.000",
      offsetMinutes: -240,
      adjusted: false,
    });
  });

  it("supports canonical non-hour offsets", () => {
    const expected = {
      instant: "2026-09-06T03:45:00.000Z",
      localDateTime: "2026-09-06T09:30:00.000",
      offsetMinutes: 345,
      adjusted: false,
    };
    expect(resolveLocalDateTime("2026-09-06T09:30", "Asia/Kathmandu")).toEqual(expected);
    expect(resolveLocalDateTime("2026-09-06T09:30", "Asia/Katmandu")).toEqual(expected);
  });

  it("advances an entirely skipped civil day to its first valid instant", () => {
    expect(resolveLocalDateTime("2011-12-30T12:00", "Pacific/Apia")).toEqual({
      instant: "2011-12-30T10:00:00.000Z",
      localDateTime: "2011-12-31T00:00:00.000",
      offsetMinutes: 840,
      adjusted: true,
    });
  });

  it("recovers a historical gap at its exact second boundary", () => {
    expect(resolveLocalDateTime("1906-01-01T00:05", "Asia/Colombo")).toEqual({
      instant: "1905-12-31T18:40:28.000Z",
      localDateTime: "1906-01-01T00:10:28.000",
      offsetMinutes: 330,
      adjusted: true,
    });
  });

  it("derives local date and the next local midnight from an injected instant", () => {
    expect(localCalendarContext("2026-03-08T12:00:00.000Z", "America/New_York")).toEqual({
      localDate: "2026-03-08",
      nextLocalMidnight: "2026-03-09T04:00:00.000Z",
    });
    expect(localCalendarContext("2026-12-31T23:30:00.000Z", "Asia/Tokyo")).toEqual({
      localDate: "2027-01-01",
      nextLocalMidnight: "2027-01-01T15:00:00.000Z",
    });
  });

  it("rejects unsupported timezones and malformed instants", () => {
    expect(() => parseDailyTemporal("2026-09-06", "Mars/Olympus")).toThrow(/timezone/i);
    expect(() => parseDailyTemporal("2026-09-06", "+05:30")).toThrow(/timezone/i);
    expect(() => parseDailyTemporal("2026-09-06", "-04")).toThrow(/timezone/i);
    expect(parseDailyTemporal("2026-09-06", "US/Eastern")?.localDate).toBe("2026-09-06");
    expect(parseDailyTemporal("2026-09-06", "Asia/Katmandu")?.localDate).toBe("2026-09-06");
    expect(() => localCalendarContext("2026-09-06T12:00:00Z", "America/New_York"))
      .toThrow(/instant/i);
    expect(parseDailyTemporal("2026-09-06 09:30", "America/New_York")).toBeNull();
  });
});
