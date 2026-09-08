import {
  parseStoredDateValue,
  storedDateEpoch,
  type StoredDateTimeParts as DateTimeParts,
} from "./stored-date";

export const DAILY_TIME_ZONE_SETTING = "daily_time_zone_v1";

export type ResolvedLocalDateTime = Readonly<{
  instant: string;
  localDateTime: string;
  offsetMinutes: number;
  adjusted: boolean;
}>;

export type ParsedDailyTemporal = Readonly<{
  kind: "date" | "instant" | "wall_time";
  localDate: string;
  instant: string | null;
  adjusted: boolean;
}>;

const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MINUTE_MS = 60_000;
const SEARCH_BEFORE_MINUTES = 16 * 60;
const SEARCH_AFTER_MINUTES = 40 * 60;
const MAX_FORMATTERS = 64;
const MAX_OFFSET_ZONES = 64;
const MAX_OFFSETS_PER_ZONE = 64;
const MAX_OFFSET_DAYS = 4_096;
const MAX_RESOLUTIONS = 4_096;
const MAX_TEMPORALS = 4_096;
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();
const OFFSET_ZONES = new Map<string, readonly number[]>();
const OFFSET_DAYS = new Map<string, readonly number[]>();
const RESOLUTIONS = new Map<string, ResolvedLocalDateTime>();
const TEMPORALS = new Map<string, ParsedDailyTemporal | null>();

function remember<K, V>(cache: Map<K, V>, key: K, value: V, max: number): V {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > max) cache.delete(cache.keys().next().value!);
  return value;
}

function recalled<K, V>(cache: Map<K, V>, key: K): V | undefined {
  const value = cache.get(key);
  if (value === undefined) return undefined;
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function assertSupportedTimeZone(timeZone: string): void {
  if (timeZone.startsWith("+") || timeZone.startsWith("-"))
    throw new Error("invalid app timezone");
  try {
    formatter(timeZone);
  } catch {
    throw new Error("invalid app timezone");
  }
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  const cached = FORMATTERS.get(timeZone);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    calendar: "gregory",
    numberingSystem: "latn",
    hourCycle: "h23",
    era: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  });
  return remember(FORMATTERS, timeZone, created, MAX_FORMATTERS);
}

function zonedParts(epochMs: number, timeZone: string): DateTimeParts {
  const parts = formatter(timeZone).formatToParts(new Date(epochMs));
  const value = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find(candidate => candidate.type === type)?.value;
    if (part === undefined) throw new Error(`timezone formatter omitted ${type}`);
    return Number(part);
  };
  const era = parts.find(candidate => candidate.type === "era")?.value;
  const displayedYear = value("year");
  const year = era === "BC" ? 1 - displayedYear : displayedYear;
  return {
    year,
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
    millisecond: value("fractionalSecond"),
  };
}

function wallEpoch(parts: DateTimeParts): number {
  return storedDateEpoch(parts);
}

function sameParts(left: DateTimeParts, right: DateTimeParts): boolean {
  return left.year === right.year
    && left.month === right.month
    && left.day === right.day
    && left.hour === right.hour
    && left.minute === right.minute
    && left.second === right.second
    && left.millisecond === right.millisecond;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

function localDate(parts: DateTimeParts): string {
  if (!Number.isInteger(parts.year) || parts.year < 0 || parts.year > 9_999)
    throw new Error("local date is outside the supported range");
  return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}`;
}

function localDateTime(parts: DateTimeParts): string {
  return `${localDate(parts)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}.${pad(parts.millisecond, 3)}`;
}

function parseWall(value: string): DateTimeParts | null {
  const parsed = parseStoredDateValue(value);
  return parsed?.kind === "wall_time" ? parsed.parts : null;
}

function resolved(
  epochMs: number,
  timeZone: string,
  adjusted: boolean,
  knownLocal?: DateTimeParts,
): ResolvedLocalDateTime {
  const local = knownLocal ?? zonedParts(epochMs, timeZone);
  const offsetMinutes = (wallEpoch(local) - epochMs) / MINUTE_MS;
  return Object.freeze({
    instant: new Date(epochMs).toISOString(),
    localDateTime: localDateTime(local),
    offsetMinutes,
    adjusted,
  });
}

function resolveParsedLocalDateTime(
  wanted: DateTimeParts,
  timeZone: string,
): ResolvedLocalDateTime {
  const resolutionKey = `${timeZone}\u0000${localDateTime(wanted)}`;
  const cached = recalled(RESOLUTIONS, resolutionKey);
  if (cached) return cached;
  const wantedEpoch = wallEpoch(wanted);
  const dayKey = `${timeZone}\u0000${localDate(wanted)}`;
  let zoneOffsets = recalled(OFFSET_ZONES, timeZone) ?? Object.freeze([] as number[]);
  type Candidate = Readonly<{ epoch: number; wall: number }>;
  const candidatesFor = (offsets: readonly number[]): Candidate[] => offsets.map(offset => {
    const epoch = wantedEpoch - offset;
    return { epoch, wall: wallEpoch(zonedParts(epoch, timeZone)) };
  });
  const exactMatches = (candidates: readonly Candidate[]): number[] => candidates
    .filter(candidate => candidate.wall === wantedEpoch
      && sameParts(zonedParts(candidate.epoch, timeZone), wanted))
    .map(candidate => candidate.epoch);
  let candidates = candidatesFor(zoneOffsets);
  let matches = exactMatches(candidates);
  if (matches.length > 0)
    return remember(RESOLUTIONS, resolutionKey,
      resolved(Math.min(...matches), timeZone, false, wanted), MAX_RESOLUTIONS);

  let dayOffsets = recalled(OFFSET_DAYS, dayKey);
  if (!dayOffsets) {
    const offsets = new Set<number>(zoneOffsets);
    const probes = [-72, -24, -6, 0, 6, 24, 72];
    for (const hours of probes) {
      let probe = wantedEpoch + hours * 60 * MINUTE_MS;
      for (let iteration = 0; iteration < 4; iteration++) {
        const offset = wallEpoch(zonedParts(probe, timeZone)) - probe;
        offsets.add(offset);
        const next = wantedEpoch - offset;
        if (next === probe) break;
        probe = next;
      }
    }
    dayOffsets = remember(OFFSET_DAYS, dayKey, Object.freeze([...offsets]), MAX_OFFSET_DAYS);
    zoneOffsets = remember(OFFSET_ZONES, timeZone,
      Object.freeze([...offsets].sort((left, right) => left - right)
        .slice(-MAX_OFFSETS_PER_ZONE)), MAX_OFFSET_ZONES);
  }
  candidates = candidatesFor(dayOffsets);
  matches = exactMatches(candidates);
  if (matches.length > 0)
    return remember(RESOLUTIONS, resolutionKey,
      resolved(Math.min(...matches), timeZone, false, wanted), MAX_RESOLUTIONS);

  let bracket: Readonly<{ lower: number; upper: number }> | null = null;
  for (const lower of candidates.filter(candidate => candidate.wall < wantedEpoch)) {
    for (const upper of candidates.filter(candidate => candidate.wall > wantedEpoch)) {
      if (lower.epoch >= upper.epoch) continue;
      if (bracket === null || upper.epoch - lower.epoch < bracket.upper - bracket.lower)
        bracket = { lower: lower.epoch, upper: upper.epoch };
    }
  }
  if (bracket !== null) {
    let lower = bracket.lower;
    let upper = bracket.upper;
    while (upper - lower > 1) {
      const candidate = lower + Math.floor((upper - lower) / 2);
      if (wallEpoch(zonedParts(candidate, timeZone)) >= wantedEpoch) upper = candidate;
      else lower = candidate;
    }
    return remember(RESOLUTIONS, resolutionKey,
      resolved(upper, timeZone, true), MAX_RESOLUTIONS);
  }

  let firstEpoch: number | null = null;
  let firstWallEpoch = Number.POSITIVE_INFINITY;
  const minuteStart = wantedEpoch - wanted.second * 1_000 - wanted.millisecond;
  for (let delta = -SEARCH_BEFORE_MINUTES; delta <= SEARCH_AFTER_MINUTES; delta++) {
    const candidate = minuteStart + delta * MINUTE_MS;
    const candidateWall = wallEpoch(zonedParts(candidate, timeZone));
    if (candidateWall < wantedEpoch || candidateWall > firstWallEpoch) continue;
    if (candidateWall < firstWallEpoch || firstEpoch === null || candidate < firstEpoch) {
      firstWallEpoch = candidateWall;
      firstEpoch = candidate;
    }
  }
  if (firstEpoch === null) throw new Error("local date-time has no bounded timezone resolution");
  const priorMinute = firstEpoch - MINUTE_MS;
  if (wallEpoch(zonedParts(priorMinute, timeZone)) < wantedEpoch) {
    let lower = priorMinute;
    let upper = firstEpoch;
    while (upper - lower > 1) {
      const candidate = lower + Math.floor((upper - lower) / 2);
      if (wallEpoch(zonedParts(candidate, timeZone)) >= wantedEpoch) upper = candidate;
      else lower = candidate;
    }
    firstEpoch = upper;
  }
  return remember(RESOLUTIONS, resolutionKey, resolved(firstEpoch, timeZone, true), MAX_RESOLUTIONS);
}

export function resolveLocalDateTime(value: string, timeZone: string): ResolvedLocalDateTime {
  assertSupportedTimeZone(timeZone);
  const wanted = parseWall(value);
  if (!wanted) throw new Error("invalid local date-time");
  return resolveParsedLocalDateTime(wanted, timeZone);
}

export function parseDailyTemporal(value: string, timeZone: string): ParsedDailyTemporal | null {
  assertSupportedTimeZone(timeZone);
  const temporalKey = `${timeZone}\u0000${value}`;
  const cached = TEMPORALS.get(temporalKey);
  if (cached !== undefined || TEMPORALS.has(temporalKey)) return cached ?? null;
  const rememberTemporal = (result: ParsedDailyTemporal | null): ParsedDailyTemporal | null =>
    remember(TEMPORALS, temporalKey, result, MAX_TEMPORALS);
  const parsed = parseStoredDateValue(value);
  if (!parsed) return rememberTemporal(null);
  if (parsed.kind === "date") {
    return rememberTemporal(Object.freeze({
      kind: "date", localDate: parsed.localDate, instant: null, adjusted: false,
    }));
  }
  if (parsed.kind === "instant") {
    const instant = new Date(parsed.instant);
    const canonical = instant.toISOString();
    const local = zonedParts(instant.getTime(), timeZone);
    if (local.year < 0 || local.year > 9_999) return rememberTemporal(null);
    return rememberTemporal(Object.freeze({
      kind: "instant",
      localDate: localDate(local),
      instant: canonical,
      adjusted: false,
    }));
  }
  const result = resolveParsedLocalDateTime(parsed.parts, timeZone);
  return rememberTemporal(Object.freeze({
    kind: "wall_time",
    localDate: result.localDateTime.slice(0, 10),
    instant: result.instant,
    adjusted: result.adjusted,
  }));
}

export function resolveDailyRelativeDate(
  value: string,
  nowInstant: string,
  timeZone: string,
): string {
  const normalized = value.trim().toLocaleLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    const parsed = parseStoredDateValue(normalized);
    if (!parsed || parsed.kind !== "date") throw new Error("invalid calendar date");
    return normalized;
  }
  let days: number | null = normalized === "today" ? 0 : normalized === "tomorrow" ? 1 : null;
  const relative = /^in ([0-9]{1,4}) days?$/.exec(normalized);
  if (relative) days = Number(relative[1]);
  if (days === null || days > 3_660)
    throw new Error('Use YYYY-MM-DD, today, tomorrow, or “in N days”.');
  const base = localCalendarContext(nowInstant, timeZone).localDate;
  const [year, month, day] = base.split("-").map(Number) as [number, number, number];
  const result = new Date(Date.UTC(year, month - 1, day + days));
  if (!Number.isFinite(result.getTime())) throw new Error("relative date is out of range");
  return result.toISOString().slice(0, 10);
}

export function localCalendarContext(
  nowInstant: string,
  timeZone: string,
): Readonly<{ localDate: string; nextLocalMidnight: string }> {
  assertSupportedTimeZone(timeZone);
  if (!UTC_INSTANT.test(nowInstant)) throw new Error("canonical UTC instant required");
  const now = new Date(nowInstant);
  if (!Number.isFinite(now.getTime()) || now.toISOString() !== nowInstant)
    throw new Error("canonical UTC instant required");
  const today = localDate(zonedParts(now.getTime(), timeZone));
  const todayParts = parseWall(`${today}T00:00`);
  if (!todayParts) throw new Error("local date is invalid");
  const tomorrow = new Date(wallEpoch(todayParts) + 86_400_000).toISOString().slice(0, 10);
  const next = resolveLocalDateTime(`${tomorrow}T00:00`, timeZone);
  return Object.freeze({ localDate: today, nextLocalMidnight: next.instant });
}
