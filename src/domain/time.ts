import { DateTime, IANAZone } from "luxon";
import type { Clock } from "./ports";
import type { DateSpec, Instant, LocalDate, LocalDateTime, WeekStart } from "./types";

// Time rules. Date-only values stay "YYYY-MM-DD" and
// are never turned into instants. Timed values are wall time plus an IANA
// zone; Luxon does every conversion.

const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
/** Luxon format of a LocalDateTime wall time. */
export const LOCAL_FORMAT = "yyyy-MM-dd'T'HH:mm";

// Luxon's IANAZone.isValidZone builds an Intl.DateTimeFormat on every call (187 ms for 50,000 tasks at load).
// A zone name is either known to Intl or not for the life of the process, so the answer is cached.
const ZONE_CACHE_MAX = 2048;
const zoneValidity = new Map<string, boolean>();

export function isValidZone(zone: string): boolean {
	if (zone.length === 0) return false;
	const known = zoneValidity.get(zone);
	if (known !== undefined) return known;
	const valid = IANAZone.isValidZone(zone);
	// Bounded: names come from files and settings, so an endless stream of bad ones must not grow the map.
	if (zoneValidity.size >= ZONE_CACHE_MAX) zoneValidity.clear();
	zoneValidity.set(zone, valid);
	return valid;
}

/**
 * A real "YYYY-MM-DD" day in years 0000 to 9999: the one date-only validator. Plain arithmetic, no
 * Luxon, because a load checks every stored date (20,000 check-ins and more).
 */
export function isValidLocalDate(value: unknown): value is LocalDate {
	return typeof value === "string" && LOCAL_DATE_RE.test(value) && dateOf(dayNum(value)) === value;
}

/** A stored instant: a non-empty string that Date.parse reads. */
export function isInstant(value: unknown): value is Instant {
	return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function isValidLocalDateTime(value: string): value is LocalDateTime {
	return LOCAL_DATE_TIME_RE.test(value) && DateTime.fromISO(value, { zone: "UTC" }).isValid;
}

export function isValidDateSpec(spec: unknown): spec is DateSpec {
	if (typeof spec !== "object" || spec === null) return false;
	const s = spec as Record<string, unknown>;
	if (s.kind === "date") return typeof s.date === "string" && isValidLocalDate(s.date);
	if (s.kind === "datetime") {
		return (
			typeof s.local === "string" &&
			isValidLocalDateTime(s.local) &&
			typeof s.tz === "string" &&
			isValidZone(s.tz)
		);
	}
	return false;
}

/** Whether two schedule values name the same moment: same kind, same date, or same local time and zone. */
export function sameDateSpec(a: DateSpec | null, b: DateSpec | null): boolean {
	if (a === b) return true;
	if (a === null || b === null || a.kind !== b.kind) return false;
	return a.kind === "date" ? a.date === (b as typeof a).date : a.local === (b as typeof a).local && a.tz === (b as typeof a).tz;
}

/** Today's date in the given zone. */
export function todayIn(zone: string, clock: Clock): LocalDate {
	return DateTime.fromJSDate(clock.now(), { zone }).toISODate() ?? "";
}

/** A number as two digits, "07". */
export function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

export function addDays(date: LocalDate, days: number): LocalDate {
	return DateTime.fromISO(date, { zone: "UTC" }).plus({ days }).toISODate() ?? date;
}

export function daysBetween(from: LocalDate, to: LocalDate): number {
	const a = DateTime.fromISO(from, { zone: "UTC" });
	const b = DateTime.fromISO(to, { zone: "UTC" });
	return Math.round(b.diff(a, "days").days);
}

export type WallTimeWarning = "dst-gap" | "dst-ambiguous";

export interface ResolvedWallTime {
	/** The wall time that will be stored. Differs from the input only in a DST gap. */
	local: LocalDateTime;
	warning: WallTimeWarning | null;
}

/**
 * Resolves a wall time in a zone.
 * - A time inside a spring-forward gap moves to the first valid time.
 * - A repeated fall-back time keeps the earlier offset; Luxon already
 *   picks it, this only adds the warning.
 */
export function resolveWallTime(local: LocalDateTime, tz: string): ResolvedWallTime {
	const dt = DateTime.fromISO(local, { zone: tz });
	if (!dt.isValid) throw new RangeError(`Invalid wall time ${local} in ${tz}`);
	const roundTrip = dt.toFormat(LOCAL_FORMAT);
	if (roundTrip !== local) {
		return { local: roundTrip, warning: "dst-gap" };
	}
	const offsets = dt.getPossibleOffsets();
	return { local, warning: offsets.length > 1 ? "dst-ambiguous" : null };
}

export function wallTimeToDateTime(local: LocalDateTime, tz: string): DateTime {
	return DateTime.fromISO(local, { zone: tz });
}

// Conversions between zones. Luxon's zone math (Intl formatting per call) was 40% of a
// save at 50,000 tasks. Both functions are pure, so:
//  - a stored zone equal to the display zone needs no conversion: the wall time is the answer, unless it lies in a
//    spring-forward gap (Luxon moves it forward). A day on which the zone's offset is constant over the whole window
//    its wall times can map to has no gap and no fold, so there the wall time is exact. That is decided once per
//    (zone, day) and cached; any other day takes the Luxon path;
//  - every other conversion is memoized by (wall time, zone, display zone).
// Only IANA names that Intl accepts are cached or fast-pathed; "local", "system" and fixed offsets follow the device
// and always go through Luxon.

const DAY_CACHE_MAX = 32_768;
const CONVERSION_CACHE_MAX = 65_536;
const HOUR_MS = 3_600_000;

interface Converted {
	date: LocalDate;
	local: LocalDateTime;
}

/** (zone|day) -> the zone's UTC offset is constant from 36 h before the day to 60 h after it (and the day exists). */
const steadyDays = new Map<string, boolean>();
const conversions = new Map<string, Converted>();
/** (zone|instant) -> the instant's local day in the zone, or null when it does not parse. */
const instantDays = new Map<string, LocalDate | null>();

/** Empties the zone, day and conversion caches (tests). */
export function resetTimeCaches(): void {
	zoneValidity.clear();
	steadyDays.clear();
	conversions.clear();
	instantDays.clear();
}

export function timeCacheSizes(): { zones: number; days: number; conversions: number; instantDays: number } {
	return { zones: zoneValidity.size, days: steadyDays.size, conversions: conversions.size, instantDays: instantDays.size };
}

function isSteadyDay(date: string, tz: string): boolean {
	const key = `${tz}|${date}`;
	const known = steadyDays.get(key);
	if (known !== undefined) return known;
	const steady = computeSteadyDay(date, tz);
	if (steadyDays.size >= DAY_CACHE_MAX) steadyDays.clear();
	steadyDays.set(key, steady);
	return steady;
}

function computeSteadyDay(date: string, tz: string): boolean {
	const y = Number(date.slice(0, 4));
	const m = Number(date.slice(5, 7));
	const d = Number(date.slice(8, 10));
	// setUTCFullYear, not Date.UTC: Date.UTC reads years 0-99 as 1900-1999.
	const start = new Date(0);
	start.setUTCFullYear(y, m - 1, d);
	if (start.getUTCFullYear() !== y || start.getUTCMonth() !== m - 1 || start.getUTCDate() !== d) return false;
	const zone = IANAZone.create(tz);
	const first = zone.offset(start.getTime() - 36 * HOUR_MS);
	// Every 12 h up to 60 h after midnight: a wall time of the day maps to an instant at most 36 h from its midnight.
	for (let h = -24; h <= 60; h += 12) if (zone.offset(start.getTime() + h * HOUR_MS) !== first) return false;
	return true;
}

/** True when `local` in `tz` is certainly itself in `tz` (no gap, no fold, a real calendar time). */
function sameZoneIsExact(local: string, tz: string): boolean {
	if (!LOCAL_DATE_TIME_RE.test(local) || !isValidZone(tz)) return false;
	if (Number(local.slice(11, 13)) > 23 || Number(local.slice(14, 16)) > 59) return false;
	return isSteadyDay(local.slice(0, 10), tz);
}

function convert(spec: Extract<DateSpec, { kind: "datetime" }>, displayZone: string): Converted {
	const cacheable = isValidZone(spec.tz) && isValidZone(displayZone);
	const key = cacheable ? `${spec.local}|${spec.tz}|${displayZone}` : "";
	if (cacheable) {
		const known = conversions.get(key);
		if (known !== undefined) return known;
	}
	const dt = wallTimeToDateTime(spec.local, spec.tz).setZone(displayZone);
	const result: Converted = { date: dt.toISODate() ?? spec.local.slice(0, 10), local: dt.toFormat(LOCAL_FORMAT) };
	if (cacheable) {
		if (conversions.size >= CONVERSION_CACHE_MAX) conversions.clear();
		conversions.set(key, result);
	}
	return result;
}

/**
 * The local day an instant falls on in `zone`, or null when the instant does not parse. Memoized for IANA
 * names, like `convert`: the Completed group asks for it once per completed task on every render.
 */
export function instantDay(instant: Instant, zone: string): LocalDate | null {
	const cacheable = isValidZone(zone);
	const key = cacheable ? `${zone}|${instant}` : "";
	if (cacheable) {
		const known = instantDays.get(key);
		if (known !== undefined) return known;
	}
	const dt = DateTime.fromISO(instant, { zone });
	const day = dt.isValid ? dt.toISODate() : null;
	if (cacheable) {
		if (instantDays.size >= CONVERSION_CACHE_MAX) instantDays.clear();
		instantDays.set(key, day);
	}
	return day;
}

/** The calendar date a spec falls on, seen from the display zone. */
export function dateSpecDate(spec: DateSpec, displayZone: string): LocalDate {
	if (spec.kind === "date") return spec.date;
	if (spec.tz === displayZone && sameZoneIsExact(spec.local, spec.tz)) return spec.local.slice(0, 10);
	return convert(spec, displayZone).date;
}

/** The wall time a timed spec shows in the display zone, or null for date-only. */
export function dateSpecDisplayLocal(spec: DateSpec, displayZone: string): LocalDateTime | null {
	if (spec.kind === "date") return null;
	if (spec.tz === displayZone && sameZoneIsExact(spec.local, spec.tz)) return spec.local;
	return convert(spec, displayZone).local;
}

/**
 * A string that orders specs chronologically in the display zone. Date-only
 * values sort before timed values on the same day.
 */
export function dateSpecSortValue(spec: DateSpec, displayZone: string): string {
	return spec.kind === "date" ? spec.date : (dateSpecDisplayLocal(spec, displayZone) ?? spec.local);
}

/** 1 = Monday … 7 = Sunday of a date: the same arithmetic as `isoWeekdayOfDay`, no Luxon. */
export function isoWeekdayOf(date: LocalDate): number {
	return isoWeekdayOfDay(dayNum(date));
}

// Day-number helpers (days since 1970-01-01), shared by the calendar, habit and recurrence engines, which
// avoid Luxon in their hot loops. Proleptic Gregorian calendar, exact for every day of years 0000 to 9999
// (Date.UTC would read years 0-99 as 1900-1999). Divisions use Math.floor, so days before 1970 and before
// year 0 stay exact.

export const DAY_MS = 86_400_000;

/**
 * The day number of year `y`, month `m` (1 = January), day `d`. A month outside 1-12 or a day outside
 * the month rolls over, so `dayNumOf(y, m + 1, 1) - dayNumOf(y, m, 1)` is the length of month `m`.
 */
export function dayNumOf(y: number, m: number, d: number): number {
	if (m < 1 || m > 12) {
		y += Math.floor((m - 1) / 12);
		m -= Math.floor((m - 1) / 12) * 12;
	}
	// Years start on 1 March, so the leap day is the last day of the year.
	if (m <= 2) y -= 1;
	const era = Math.floor(y / 400);
	const yoe = y - era * 400;
	const doy = Math.floor((153 * (m > 2 ? m - 3 : m + 9) + 2) / 5) + d - 1;
	const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
	return era * 146_097 + doe - 719_468;
}

/** The year, month (1 = January) and day of a day number. */
export function civilOf(n: number): { y: number; m: number; d: number } {
	const z = n + 719_468;
	const era = Math.floor(z / 146_097);
	const doe = z - era * 146_097;
	const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
	const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
	const mp = Math.floor((5 * doy + 2) / 153);
	const m = mp < 10 ? mp + 3 : mp - 9;
	return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d: doy - Math.floor((153 * mp + 2) / 5) + 1 };
}

/** The day number of a "YYYY-MM-DD" prefix. Plain arithmetic, no Luxon. */
export function dayNum(date: string): number {
	return dayNumOf(Number(date.slice(0, 4)), Number(date.slice(5, 7)), Number(date.slice(8, 10)));
}

/** The "YYYY-MM-DD" date of a day number (years 0000 to 9999). */
export function dateOf(n: number): LocalDate {
	const { y, m, d } = civilOf(n);
	return `${String(y).padStart(4, "0")}-${m < 10 ? "0" : ""}${m}-${d < 10 ? "0" : ""}${d}`;
}

/** The ISO weekday number (1 = Monday) each week start begins on. */
export const WEEK_START_ISO: Readonly<Record<WeekStart, number>> = { MO: 1, SU: 7, SA: 6 };

/** 1 = Monday … 7 = Sunday of a day number; day 0 (1970-01-01) was a Thursday. */
export function isoWeekdayOfDay(n: number): number {
	return ((((n + 3) % 7) + 7) % 7) + 1;
}

/** The day number of the first day of the week that holds day `n`. */
export function weekStartOfDay(n: number, weekStart: WeekStart): number {
	return n - ((isoWeekdayOfDay(n) - WEEK_START_ISO[weekStart] + 7) % 7);
}
