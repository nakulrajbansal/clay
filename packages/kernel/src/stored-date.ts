export type StoredDateTimeParts = Readonly<{
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}>;

export type StoredDateValue =
  | Readonly<{ kind: "date"; localDate: string; parts: StoredDateTimeParts }>
  | Readonly<{ kind: "wall_time"; localDate: string; parts: StoredDateTimeParts }>
  | Readonly<{ kind: "instant"; localDate: string; parts: StoredDateTimeParts; instant: string }>;

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?$/;
const DAY_MS = 86_400_000;

export function storedDateEpoch(parts: StoredDateTimeParts): number {
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCHours(parts.hour, parts.minute, parts.second, parts.millisecond);
  return date.getTime();
}

function localDate(parts: StoredDateTimeParts): string {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function dateParts(value: string): StoredDateTimeParts | null {
  const match = LOCAL_DATE.exec(value);
  if (!match) return null;
  const parts: StoredDateTimeParts = {
    year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
    hour: 0, minute: 0, second: 0, millisecond: 0,
  };
  const epoch = storedDateEpoch(parts);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString().slice(0, 10) !== value) return null;
  return parts;
}

function normalizedClock(
  date: StoredDateTimeParts,
  hour: number,
  minute: number,
  second: number,
  millisecond: number,
): StoredDateTimeParts | null {
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || !Number.isInteger(second)
      || !Number.isInteger(millisecond) || minute < 0 || minute > 59
      || second < 0 || second > 59 || millisecond < 0 || millisecond > 999
      || hour < 0 || hour > 24) return null;
  if (hour < 24) return { ...date, hour, minute, second, millisecond };
  if (minute !== 0 || second !== 0 || millisecond !== 0) return null;
  const next = new Date(storedDateEpoch(date) + DAY_MS);
  const iso = next.toISOString();
  if (!/^\d{4}-/.test(iso)) return null;
  return {
    year: Number(iso.slice(0, 4)), month: Number(iso.slice(5, 7)), day: Number(iso.slice(8, 10)),
    hour: 0, minute: 0, second: 0, millisecond: 0,
  };
}

export function parseStoredDateValue(value: unknown): StoredDateValue | null {
  if (typeof value !== "string") return null;
  const bare = dateParts(value);
  if (bare) return Object.freeze({ kind: "date", localDate: value, parts: Object.freeze(bare) });
  const match = DATE_TIME.exec(value);
  if (!match) return null;
  const date = dateParts(match[1]!);
  if (!date) return null;
  const millisecond = Number((match[5] ?? "").padEnd(3, "0") || "0");
  const parts = normalizedClock(
    date, Number(match[2]), Number(match[3]), Number(match[4] ?? "0"), millisecond,
  );
  if (!parts) return null;
  const normalizedDate = localDate(parts);
  const zone = match[6];
  if (zone === undefined) {
    return Object.freeze({
      kind: "wall_time", localDate: normalizedDate, parts: Object.freeze(parts),
    });
  }
  if (zone !== "Z") {
    const zoneHour = Number(zone.slice(1, 3));
    const zoneMinute = Number(zone.slice(4, 6));
    if (zoneHour > 23 || zoneMinute > 59) return null;
  }
  const normalized = `${normalizedDate}T${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}:${String(parts.second).padStart(2, "0")}.${String(parts.millisecond).padStart(3, "0")}${zone}`;
  const instant = new Date(normalized);
  if (!Number.isFinite(instant.getTime())) return null;
  return Object.freeze({
    kind: "instant",
    localDate: normalizedDate,
    parts: Object.freeze(parts),
    instant: instant.toISOString(),
  });
}

export function isStoredDateValue(value: unknown): value is string {
  return parseStoredDateValue(value) !== null;
}
