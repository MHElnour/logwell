import * as chrono from "chrono-node";
import { DateTime } from "luxon";
import type { Component } from "chrono-node";
import { addDays, dateOf, dateSpecDate, dayNum, isValidDateSpec, isValidLocalDate, pad2, resolveWallTime, wallTimeOf, type WallTimeWarning } from "../domain/time";
import type { DateSpec, LocalDate } from "../domain/types";
import { atClockLength, DAY_PART_PATTERN, DURATION_UNIT_PATTERN, isSpaceChar, MASK_CHAR, RANGE_JOIN_PATTERN, tokenStartAllowed, wordBoundaryBefore } from "./text";
import type { DateLocale, Span } from "./types";

// Date and time recognition. chrono finds the spans and reports
// which components it is sure of; this file turns them into wall times in the
// configured zone with Luxon. chrono's own conversion to an instant is never
// used: it only knows fixed offsets, so a date across a DST change would get
// the wrong hour.

const DEFAULT_EVENING_TIME = "20:00";
const TONIGHT_RE = /\btonight\b/iu;
const STOP_LIST = new Set(["may", "sun", "sat", "march", "second", "now"]);
const BARE_DURATION_RE =
	/^(?:at\s+)?\d+(?:\.\d+)?\s*(?:h|hrs?|hours?|m|mins?|minutes?|s|secs?|seconds?|d|days?|w|wks?|weeks?)$/iu;
// "the week", "a day" ("3 times a day"): a period, not a date.
const VAGUE_UNIT_RE = /^(?:the\s+|a\s+)?(?:day|week|month|year)$/iu;
// A day-part word anywhere in a date: the text's own day parts plus the three dates only (noon, midnight, tonight).
const DATE_DAY_PART_RE = new RegExp(`\\b(?:noon|midnight|tonight|${DAY_PART_PATTERN})\\b`, "iu");
const SHIFT_WORD_RE = /\b(?:next|last|past|previous|coming)\b/iu;
// "this friday" also names its week: a range's end with it, or with a shift word, is never moved a week.
const THIS_WORD_RE = /\bthis\b/iu;
// "0H:MM" with a leading-zero two-digit hour (01-09) is written 24-hour style and is certain.
// No lookbehind (iOS): the character before is matched and ignored.
const LEADING_ZERO_TIME_RE = /(?:^|[^\d:.])0[1-9]:[0-5]\d(?!\d)/u;
const PAST_WORD_RE = /^(?:last|past|previous)\b/iu;
// A planned duration without `for` ("2h", "30 min"): no date at all, and no chip.
const DURATION_TEXT_RE = new RegExp(`^\\d+(?:\\.\\d+)?\\s*${DURATION_UNIT_PATTERN}$`, "iu");
// What joins the two times of a time range: "-", an en dash or "to" ("3-4pm", "from 3pm to 5pm").
const TIME_RANGE_JOIN_RE = /\s*(?:\bto\b|[-\u2013])\s*/giu;

export type DateOutcome =
	| { status: "applied" | "suggestion"; date: DateSpec; warning?: WallTimeWarning }
	| { status: "choice"; alternatives: { label: string; value: DateSpec }[] };

/** An applied date offered as a suggestion instead, with its warning; any other outcome as it is. */
function asSuggestion(o: DateOutcome): DateOutcome {
	if (o.status !== "applied") return o;
	return o.warning === undefined ? { status: "suggestion", date: o.date } : { status: "suggestion", date: o.date, warning: o.warning };
}

export interface DateCandidate {
	/** "end": a repeat's end (`until Dec 1`); the parser makes it a deadline when nothing repeats. */
	kind: "scheduled" | "deadline" | "end";
	/** Includes the lead word (LEADS) that directly precedes the date text. */
	span: Span;
	/** Where the date text itself starts (after the lead word). */
	textStart: number;
	/** The lead word counts only when the input repeats (`ending`, `starting` …): without a repeat it is title text. */
	repeatOnly: boolean;
	/** The lead word the span widened over (LEADS), or null. */
	lead: { words: string; kind: LeadKind } | null;
	/** How the date moves past a start it falls before as a repeat's end (`rollEnd`); null when it keeps its reading. */
	rolls: RollKind | null;
	outcome: DateOutcome;
	/** A time range's minutes from its start to its end (`3-4pm`): the date is its start time. */
	durationMin?: number;
	/**
	 * A date range (`Oct 12 to Dec 1`) read as a repeat's start (kind "scheduled") and end (kind "end"), when the input
	 * types a repeat (`DateEnv.repeatRange`) and both sides name a day. `led`: a start word (`starting`, `from` …) leads
	 * it. The parser uses it only next to a typed repeat it keeps: start and end words count only after a repeat.
	 */
	range?: {
		led: boolean;
		start: DateCandidate;
		end: DateCandidate;
		/** A start that is a choice: the end for each of its alternatives, in order (`end` is the first's). */
		endByChoice?: readonly DateOutcome[];
	};
}

/** What a lead word directly before a date makes of it: a deadline, a joined time, a repeat end or the start. */
type LeadKind = "deadline" | "time" | "end" | "schedule";

interface Lead {
	words: string;
	kind: LeadKind;
	/** Only next to a repeat: these are also everyday words ("the movie ending", "the starting lineup"). */
	repeatOnly?: true;
	/** Written right before the date, with no space, at a token start: `@` before a clock time ("@4pm", "@noon"). */
	attached?: true;
}

/**
 * The lead words before a date (`by` for a deadline, `at` joining a time, and a repeat's start and end words), lower
 * case, single spaces.
 * The span widens over the lead word; "time" joins only a date whose hour is certain. Without a repeat, `until`
 * makes a deadline (the parser turns the "end" into one) and the words marked `repeatOnly` lead nothing.
 */
const LEADS: readonly Lead[] = [
	{ words: "by", kind: "deadline" },
	{ words: "at", kind: "time" },
	{ words: "@", kind: "time", attached: true },
	{ words: "until", kind: "end" },
	{ words: "till", kind: "end", repeatOnly: true },
	{ words: "ending on", kind: "end", repeatOnly: true },
	{ words: "ending", kind: "end", repeatOnly: true },
	{ words: "ends on", kind: "end", repeatOnly: true },
	{ words: "starting on", kind: "schedule", repeatOnly: true },
	{ words: "starting", kind: "schedule", repeatOnly: true },
	{ words: "starts on", kind: "schedule", repeatOnly: true },
	{ words: "beginning", kind: "schedule", repeatOnly: true },
	{ words: "from", kind: "schedule", repeatOnly: true },
	{ words: "on", kind: "schedule", repeatOnly: true },
];

/** The lead words that make two bare weekdays a start and an end (`starting Monday to Friday`); `from` and `on` do not. */
const PAIRS_WEEKDAYS: ReadonlySet<string> = new Set(["starting", "starting on", "starts on", "beginning"]);

interface LeadFound {
	start: number;
	words: string;
	kind: LeadKind;
	repeatOnly: boolean;
}

/** The lead word that ends right before `index` (over spaces), the longest when several fit; null when none does. */
function leadBefore(s: string, index: number): LeadFound | null {
	let best: LeadFound | null = null;
	for (const lead of LEADS) {
		let at = index;
		if (lead.attached === true) at = s.startsWith(lead.words, index - lead.words.length) && tokenStartAllowed(s, index - lead.words.length) && atClockLength(s, index) > 0 ? index - lead.words.length : -1;
		const words = lead.attached === true ? [] : lead.words.split(" ");
		for (let w = words.length - 1; w >= 0 && at !== -1; w--) at = wordBefore(s, at, words[w]!);
		if (at !== -1 && (best === null || at < best.start)) best = { start: at, words: lead.words, kind: lead.kind, repeatOnly: lead.repeatOnly === true };
	}
	return best;
}

/** The first real date with this month and day ("MM-DD") on or after `from`, in its year or the 8 years after it (the next Feb 29). */
function monthDayOnOrAfter(monthDay: string, from: LocalDate): LocalDate | null {
	const firstYear = Number(from.slice(0, 4));
	for (let year = firstYear; year <= firstYear + 8; year++) {
		const date = `${String(year).padStart(4, "0")}-${monthDay}`;
		if (isValidLocalDate(date) && date >= from) return date;
	}
	return null;
}

/** A repeat's end that rolled to more than a year after its start is a suggestion ("Use as end date?"), not applied. */
export function rollsPastYear(from: LocalDate, to: LocalDate): boolean {
	return dayNum(to) - dayNum(from) > 366;
}

/** How an end typed without its year moves past a start: a bare weekday by weeks, a month and day by years. */
export type RollKind = "week" | "year";

/**
 * The first date on or after `from` that reads as `end` does: the same weekday (`by` "week") or the same month and
 * day (`by` "year", the next real one: Feb 29 waits for a leap year). The one rule for an end before its start, in a
 * typed range (`splitRange`) and for a separate end (`bindEnds`); null when no such date exists.
 */
export function rollEnd(end: LocalDate, from: LocalDate, by: RollKind): LocalDate | null {
	if (end >= from) return end;
	if (by === "week") return dateOf(dayNum(end) + 7 * Math.ceil((dayNum(from) - dayNum(end)) / 7));
	return monthDayOnOrAfter(end.slice(5), from);
}

// A two-digit number after a comma is never a year ("Jun 3, 25 people" is June 3 and "25 people"): the date ends
// before the comma and its year is implied again, for `impliedYear` to set.
const SHORT_YEAR_RE = /,\s*(\d{1,2})$/u;
const KEPT_COMPONENTS: readonly Component[] = ["month", "day", "weekday", "hour", "minute", "second", "millisecond", "meridiem", "timezoneOffset"];
const shortYear: chrono.Refiner = {
	refine(context, results) {
		for (const r of results) {
			const m = SHORT_YEAR_RE.exec(r.text);
			if (m === null || r.end != null || !r.start.isCertain("year") || (r.start.get("year") ?? 0) % 100 !== Number(m[1])) continue;
			const known: Partial<Record<Component, number>> = {};
			for (const k of KEPT_COMPONENTS) if (r.start.isCertain(k)) known[k] = r.start.get(k) ?? 0;
			r.start = context.createParsingComponents(known);
			r.text = r.text.slice(0, m.index);
		}
		return results;
	},
};

/** The options the date readers get: chrono's, plus today's date on the parse clock, for `impliedYear`. */
interface ReaderOption extends chrono.ParsingOption {
	today: LocalDate;
}

/**
 * The year of a month and day typed without one (#88, #12): the first year, from today's on, in which that date exists
 * and is on or after today on the parse clock. So today's month and day is today at any hour of the day, yesterday's
 * is next year's, and Feb 29 is the next leap day (at most 8 years on). chrono's own forward step compares instants, an
 * implied noon that has passed against a reference the host zone shifts, and would move today's date to next year or
 * drop a leap day as impossible. Runs after that step, right before chrono's filter of impossible dates; the year stays
 * implied, so a typed year is still the one certain year, and chrono's range merge after the filter still moves an end
 * before its start a year on, as it always did.
 */
const impliedYear: chrono.Refiner = {
	refine(context, results) {
		// Called with chrono's plain options (tests), today is chrono's own reference day.
		const ref = context.createParsingComponents();
		const today = (context.option as Partial<ReaderOption>).today ?? `${String(ref.get("year") ?? 0).padStart(4, "0")}-${pad2(ref.get("month") ?? 0)}-${pad2(ref.get("day") ?? 0)}`;
		for (const r of results) {
			for (const c of r.end == null ? [r.start] : [r.start, r.end]) {
				if (!c.isCertain("month") || !c.isCertain("day") || c.isCertain("year")) continue;
				const date = monthDayOnOrAfter(`${pad2(c.get("month") ?? 0)}-${pad2(c.get("day") ?? 0)}`, today);
				if (date !== null) c.imply("year", Number(date.slice(0, 4)));
			}
		}
		return results;
	},
};

/** A reading of one time with no day of its own ("from 12", "at 5"); not a time range, which chrono keeps as it is. */
const timeOnly = (r: chrono.ParsedResult): boolean => r.end == null && r.start.isCertain("hour") && !r.start.isCertain("day") && !r.start.isCertain("weekday") && !r.start.isCertain("month");

/**
 * Of two readings over the same text, a date wins over a bare time, whatever their lengths: en-GB reads "from 12 Oct"
 * as the time "from 12" and the date "12 Oct", and chrono's own overlap removal would keep the longer time. Runs first.
 */
const dateOverTime: chrono.Refiner = {
	refine(_context, results) {
		return results.filter((r, i) => !(timeOnly(r) && results.some((o, j) => j !== i && dayCertainOf(o.start) && o.index < r.index + r.text.length && r.index < o.index + o.text.length)));
	},
};

// Four digits after `at` are a 24-hour time, hours 00 to 23 and minutes 00 to 59 ("at 0900", "at 1730"), read with the
// `at`. Without `at` ("Call 0900") they stay text.
const AT_24_HOUR_RE = /\bat\s+([01]\d|2[0-3])([0-5]\d)(?![\p{L}\p{N}])/iu;
const at24Hour: chrono.Parser = {
	pattern: () => AT_24_HOUR_RE,
	extract: (_context, match) => {
		const hour = Number(match[1]);
		return { hour, minute: Number(match[2]), meridiem: hour < 12 ? 0 : 1 };
	},
};

/**
 * chrono's casual English and en-GB readers with `dateOverTime` first, `shortYear` and `impliedYear` right before the
 * filter of impossible dates (the one refiner with a `strictMode` field), and the `at 0900` reader. en-GB reads a month
 * name before a two-digit day as that day ("Oct 15", "Feb 29"), as English does: its month-name-first reader is replaced
 * by a copy that does not skip a day that looks like a year (the one parser with a `shouldSkipYearLikeDate` field).
 * chrono's date range merge stays as it is. Clones: chrono's shared instances stay as they are.
 */
function buildChrono(base: chrono.Chrono): chrono.Chrono {
	const reader = base.clone();
	const filter = reader.refiners.findIndex((r) => Object.hasOwn(r, "strictMode"));
	reader.refiners.splice(filter === -1 ? reader.refiners.length : filter, 0, shortYear, impliedYear);
	reader.refiners.unshift(dateOverTime);
	reader.parsers = reader.parsers.map((p) => (Object.hasOwn(p, "shouldSkipYearLikeDate") ? Object.assign(Object.create(Object.getPrototypeOf(p) as object) as chrono.Parser, p, { shouldSkipYearLikeDate: false }) : p));
	reader.parsers.push(at24Hour);
	return reader;
}

/** The one date reader per locale, built once at load. */
export const DATE_READERS: Readonly<Record<DateLocale, chrono.Chrono>> = { en: buildChrono(chrono.en.casual), "en-GB": buildChrono(chrono.en.GB) };

export interface DateEnv {
	now: Date;
	zone: string;
	locale: DateLocale;
	/** What "tonight" means, "HH:mm" local time. */
	eveningTime?: string;
	/** The input types a repeat: a date range may be its start and end (`DateCandidate.range`). */
	repeatRange?: boolean;
}

export interface Resolved {
	value: DateSpec;
	warning?: WallTimeWarning;
}

/** Applies the DST rules to a value. Null for a value that is not a real date or time. */
export function resolveDateSpec(spec: DateSpec): Resolved | null {
	if (!isValidDateSpec(spec)) return null;
	if (spec.kind === "date") return { value: { kind: "date", date: spec.date } };
	try {
		const r = resolveWallTime(spec.local, spec.tz);
		const value: DateSpec = { kind: "datetime", local: r.local, tz: spec.tz };
		return r.warning ? { value, warning: r.warning } : { value };
	} catch {
		return null;
	}
}

function isoDate(dt: DateTime): LocalDate | null {
	const d = dt.toISODate();
	return d !== null && isValidLocalDate(d) ? d : null;
}

/** The reference time in the parse zone; throws for an invalid time or zone. The one reader of it. */
export function zoneNowOf(now: Date, zone: string): DateTime {
	const zoneNow = DateTime.fromJSDate(now, { zone });
	if (!zoneNow.isValid) throw new RangeError(`Invalid reference time or zone ${zone}`);
	return zoneNow;
}

/** Today's date on the parse clock (`zoneNow` is the reference time in the parse zone). The one reader of it. */
export function todayOf(zoneNow: DateTime): LocalDate {
	const today = isoDate(zoneNow);
	if (today === null) throw new RangeError("Invalid reference date");
	return today;
}

function isWeakText(text: string): boolean {
	const t = text.trim();
	return STOP_LIST.has(t.toLowerCase()) || /^\d+$/u.test(t) || BARE_DURATION_RE.test(t) || VAGUE_UNIT_RE.test(t);
}

/**
 * Where the word `word` (lower case) directly before `index` starts, over at least one space, or -1: the one lookback
 * for a lead word (leadBefore; tokens.ts for the "on" of "on mondays").
 */
export function wordBefore(s: string, index: number, word: string): number {
	let j = index;
	while (j > 0 && isSpaceChar(s.charAt(j - 1))) j--;
	if (j === index) return -1;
	const start = j - word.length;
	if (start < 0 || s.slice(start, j).toLowerCase() !== word) return -1;
	return wordBoundaryBefore(s, start) ? start : -1;
}

/** The parse clock, read once per input. */
interface Clock {
	env: DateEnv;
	/** The instant chrono gets: its wall time on the computer's clock is the parse zone's (#88). */
	ref: Date;
	/** The wall times of `ref` on the computer's clock and of the reference time in the parse zone, as UTC, for spans. */
	refWall: DateTime;
	zoneNowWall: DateTime;
	today: LocalDate;
	nowLocal: string;
	/** 0 = Sunday, chrono's numbering. */
	todayWeekday: number;
}

/** What every parse call hands the reader: a forward reading, and today for `impliedYear`. */
const optionOf = (clock: Clock): ReaderOption => ({ forwardDate: true, today: clock.today });

/** chrono's own tag on a result it counted from the reference instant with a time ("in 1 hour", "30 minutes ago"). */
const RELATIVE_TIME_TAG = "result/relativeDateAndTime";

/** A wall time as UTC, so spans between wall times are plain arithmetic and no zone moves a reading. */
const wallOf = (dt: DateTime): DateTime => DateTime.utc(dt.year, dt.month, dt.day, dt.hour, dt.minute);

/** The date, hour and minute of chrono's components, as a wall time (`wallOf`). Invalid for an impossible date. */
function componentsIn(c: chrono.ParsedComponents, zone: "utc"): DateTime {
	return DateTime.fromObject({ year: c.get("year") ?? 0, month: c.get("month") ?? 0, day: c.get("day") ?? 0, hour: c.get("hour") ?? 0, minute: c.get("minute") ?? 0 }, { zone });
}

/**
 * One chrono result as a value: its date (on the parse clock) and what Quick Add makes of it. Null when unusable.
 * `fixed`: the day to use instead of chrono's, a certain one (a range's end moved past its start).
 */
function readResult(r: chrono.ParsedResult, clock: Clock, fixed?: LocalDate, timeRange = false): { date: LocalDate; dayCertain: boolean; hourCertain: boolean; outcome: DateOutcome } | null {
	const { env, today, nowLocal, todayWeekday } = clock;
	const start = r.start;
	const dayKnown = fixed !== undefined || start.isCertain("day");
	const dayCertain = dayKnown || start.isCertain("weekday");
	const hourCertain = start.isCertain("hour");
	// The wall time chrono read, as UTC: its fields are the date, hour and minute, whatever the zone.
	let wall = componentsIn(start, "utc");
	if (hourCertain && fixed === undefined && start.tags().has(RELATIVE_TIME_TAG)) {
		// "in 1 hour": chrono counted it on the computer's wall clock from `clock.ref`, whose wall time there stands for the
		// task's clock. When the computer has no such wall time (a DST gap), the clock it counted from is an hour on, so
		// the reading is too: the wall-clock span it counted is taken from the task's own clock instead (#88).
		wall = clock.zoneNowWall.plus(wall.toMillis() - clock.refWall.toMillis());
	}
	let date = fixed ?? (wall.isValid ? isoDate(wall) : null);
	if (date === null) return null;
	const hour = wall.isValid ? wall.hour : 0;
	const minute = wall.isValid ? wall.minute : 0;
	const weekday = start.get("weekday");

	// chrono's forwardDate puts "last friday" in the future; take the most recent past one.
	let looksBack = false;
	if (PAST_WORD_RE.test(r.text) && start.isCertain("weekday") && !dayKnown && weekday !== null) {
		date = addDays(today, -(((todayWeekday - weekday + 7) % 7) || 7));
		looksBack = true;
	}

	const mkTime = (d: LocalDate, h: number): DateSpec => ({
		kind: "datetime",
		local: `${d}T${pad2(h)}:${pad2(minute)}`,
		tz: env.zone,
	});
	// "tonight" without a time of its own is today at the evening setting.
	const tonight = !hourCertain && TONIGHT_RE.test(r.text);
	const mkValue = (d: LocalDate): DateSpec =>
		hourCertain
			? mkTime(d, hour)
			: tonight
				? { kind: "datetime", local: `${d}T${env.eveningTime ?? DEFAULT_EVENING_TIME}`, tz: env.zone }
				: { kind: "date", date: d };

	let outcome: DateOutcome | null = null;
	// A time range (`timeRange`, "3-4pm") is read by its start, whose half of the day follows the end's.
	const lowConfidence = (r.end != null && !timeRange) || isWeakText(r.text) || (!dayCertain && !hourCertain) || looksBack;
	const meridiemKnown = start.isCertain("meridiem") || (timeRange && r.end?.isCertain("meridiem") === true) || DATE_DAY_PART_RE.test(r.text) || LEADING_ZERO_TIME_RE.test(r.text);
	if (lowConfidence) {
		const res = resolveDateSpec(mkValue(date));
		if (!res) return null;
		outcome = res.warning
			? { status: "suggestion", date: res.value, warning: res.warning }
			: { status: "suggestion", date: res.value };
	} else if (hourCertain && hour >= 1 && hour <= 12 && !meridiemKnown) {
		// "at 5": 05:00 or 17:00. Without a certain day, each alternative is the next such time.
		const alt = (h: number): { label: string; value: DateSpec } => {
			let d = date;
			if (!dayCertain) {
				d = today;
				if (`${d}T${pad2(h)}:${pad2(minute)}` <= nowLocal) d = addDays(today, 1);
			}
			return { label: `${pad2(h)}:${pad2(minute)}`, value: mkTime(d, h) };
		};
		// Hour 12 lists noon before midnight, so the preselected option is 12:00.
		outcome = { status: "choice", alternatives: hour === 12 ? [alt(12), alt(0)] : [alt(hour), alt(hour + 12)] };
	} else if (
		!hourCertain &&
		start.isCertain("weekday") &&
		!dayKnown &&
		!SHIFT_WORD_RE.test(r.text) &&
		weekday === todayWeekday
	) {
		// A weekday said on that weekday. chrono answers today or next week depending on the time of
		// day (it implies noon), so the answer is never trusted: the user chooses.
		outcome = {
			status: "choice",
			alternatives: [
				{ label: "Today", value: { kind: "date", date: today } },
				{ label: "Next week", value: { kind: "date", date: addDays(today, 7) } },
			],
		};
	} else {
		const res = resolveDateSpec(mkValue(date));
		if (!res) return null;
		outcome = res.warning
			? { status: "applied", date: res.value, warning: res.warning }
			: { status: "applied", date: res.value };
	}
	return { date, dayCertain, hourCertain, outcome };
}

/** A year that was typed, not assumed by chrono or chosen by `impliedYear`. */
const hasTypedYear = (c: chrono.ParsedComponents): boolean => c.isCertain("year");
const dayCertainOf = (c: chrono.ParsedComponents): boolean => c.isCertain("day") || c.isCertain("weekday");
/** A weekday with no day of the month (`Friday`, `next friday`). */
const weekdayOnly = (c: chrono.ParsedComponents): boolean => c.isCertain("weekday") && !c.isCertain("day");

/**
 * How a date typed as `text` moves past a start it falls before, as a repeat's end: a bare weekday by weeks (`until
 * friday`; one with `this`, `next`, `last` … names its week and keeps its reading), a month and day with no typed year
 * by years (`until Oct 1`); null when it keeps its reading.
 */
function rollKindOf(c: chrono.ParsedComponents, text: string): RollKind | null {
	if (hasTypedYear(c)) return null;
	if (weekdayOnly(c)) return SHIFT_WORD_RE.test(text) || THIS_WORD_RE.test(text) ? null : "week";
	return c.isCertain("month") && c.isCertain("day") ? "year" : null;
}

/** A lead word chrono itself put in a date's text (en-GB: "on 1 Dec", "from 12 Oct"). */
const OWN_LEAD_RE = /^(?:on|from)\s+/iu;

/** The words chrono's range merge joins two dates with, each a possible split point. */
const RANGE_JOIN_RE = new RegExp(RANGE_JOIN_PATTERN, "giu");

interface RangeSplit {
	start: { text: string; outcome: DateOutcome };
	joinAt: number;
	end: { at: number; text: string; outcome: DateOutcome };
	/** A start that is a choice: the end for each of its alternatives (`end.outcome` is the first's). */
	endByChoice?: DateOutcome[];
}

/**
 * chrono's merged range (`Oct 12 to Dec 1`) as two dates, each read again on its own, so the start keeps its own year
 * (the merge copies the end's onto it). An end with no typed year before the start moves forward as the merge moves it,
 * to the first such date on or after the start (`rollEnd`: a bare weekday by weeks, a month and day by years). A start
 * that is a choice (`Wednesday` said on a Wednesday) gets an end for each of its alternatives. Null unless both sides
 * name a day and the text splits at a join word into two whole dates; two bare weekdays (`Mon-Fri`: days of the week)
 * only with a start word (`startWord`: `starting`, `beginning`).
 */
function splitRange(r: chrono.ParsedResult, parser: chrono.Chrono, clock: Clock, startWord: boolean): RangeSplit | null {
	if (r.end == null || !dayCertainOf(r.start) || !dayCertainOf(r.end)) return null;
	const whole = (text: string): chrono.ParsedResult | null => {
		const found = parser.parse(text, clock.ref, optionOf(clock));
		const one = found.length === 1 ? found[0] : undefined;
		return one !== undefined && one.index === 0 && one.text.trimEnd() === text && one.end == null && dayCertainOf(one.start) ? one : null;
	};
	const text = r.text.trimEnd();
	for (const m of text.matchAll(RANGE_JOIN_RE)) {
		const left = text.slice(0, m.index);
		const at = m.index + m[0].length;
		const right = text.slice(at);
		if (left === "" || right === "") continue;
		const first = whole(left);
		const to = first === null ? null : whole(right);
		if (first === null || to === null) continue;
		if (!startWord && weekdayOnly(first.start) && weekdayOnly(to.start)) return null;
		const start = readResult(first, clock);
		const end = readResult(to, clock);
		if (start === null || end === null) return null;
		const by = rollKindOf(to.start, to.text);
		// A start with its own year: a month and day end counts from the start, not from today.
		const fromStart = by === "year" && hasTypedYear(first.start);
		// The end for one start date (`end.outcome` itself when it stays); null when it cannot move.
		const endFrom = (from: LocalDate): DateOutcome | null => {
			if (by === null) return end.outcome;
			const moved = fromStart ? monthDayOnOrAfter(end.date.slice(5), from) : rollEnd(end.date, from, by);
			if (moved === null) return null;
			// The moved end is that day: a weekday is never the "today or next week" choice of a weekday said today. An end
			// more than a year past the start (`Feb 20 to Feb 29` said in 2027) is a suggestion, not applied.
			const outcome = moved === end.date ? end.outcome : (readResult(to, clock, moved)?.outcome ?? null);
			if (outcome === null || outcome.status !== "applied" || !rollsPastYear(from, moved)) return outcome;
			return asSuggestion(outcome);
		};
		const o = start.outcome;
		const froms = o.status === "choice" ? o.alternatives.map((a) => dateSpecDate(a.value, clock.env.zone)) : [start.date];
		const ends: DateOutcome[] = [];
		for (const from of froms) {
			// A month and day end moves a year for a later choice only when it moved for the first; otherwise it keeps
			// its reading, as with a start edited by hand (an end before the start is invalid).
			const e = ends.length === 0 || by === "week" || ends[0] !== end.outcome ? endFrom(from) : end.outcome;
			if (e === null) return null;
			ends.push(e);
		}
		return {
			start: { text: left, outcome: o },
			joinAt: m.index + (m[0].length - m[0].trimStart().length),
			end: { at, text: right, outcome: ends[0]! },
			...(o.status === "choice" ? { endByChoice: ends } : {}),
		};
	}
	return null;
}

/**
 * The start of a range with a side that is only a time (`Friday until midnight`), as that start reads typed alone. chrono
 * dates that time today, then moves a later weekday start back a week (or swaps the two) to keep the range in order, and can
 * read a day of the month as an hour (`Dec 1 until 5pm`). Null when the range is not one, the start alone is not one
 * whole date ending at the join word, or it reads the same day as chrono's start.
 */
function startAlone(r: chrono.ParsedResult, masked: string, parser: chrono.Chrono, clock: Clock): chrono.ParsedResult | null {
	if (r.end == null || (dayCertainOf(r.start) && dayCertainOf(r.end))) return null;
	const join = new RegExp(RANGE_JOIN_PATTERN, "iu").exec(r.text);
	if (join === null || join.index === 0) return null;
	const before = masked.slice(0, r.index + join.index);
	const last = parser.parse(before, clock.ref, optionOf(clock)).at(-1);
	if (last === undefined || last.end != null || !dayCertainOf(last.start) || last.index > r.index) return null;
	if (last.index + last.text.trimEnd().length !== before.trimEnd().length) return null;
	const chronoDay = componentsIn(r.start, "utc");
	const aloneDay = componentsIn(last.start, "utc");
	return chronoDay.isValid && aloneDay.isValid && isoDate(chronoDay) === isoDate(aloneDay) ? null : last;
}

/**
 * A range of two times on one day joined by "-", an en dash or "to" ("3-4pm", "10am-11am", "from 3pm to 5pm", "2-3pm
 * tomorrow"): the minutes from its start to its end; when the end is not after the start ("4-3pm"), the end read alone,
 * placed where it is in the text. Null for any other reading, a date range or `until` included.
 */
function timeRangeOf(r: chrono.ParsedResult, parser: chrono.Chrono, clock: Clock): { minutes: number } | { end: chrono.ParsedResult } | null {
	const end = r.end;
	if (end == null || !r.start.isCertain("hour") || !end.isCertain("hour")) return null;
	if (dayCertainOf(end) || end.isCertain("month")) {
		const startDay = componentsIn(r.start, "utc");
		const endDay = componentsIn(end, "utc");
		if (!startDay.isValid || !endDay.isValid || isoDate(startDay) !== isoDate(endDay)) return null;
	}
	const text = r.text.trimEnd();
	for (const m of text.matchAll(TIME_RANGE_JOIN_RE)) {
		const at = m.index + m[0].length;
		const right = text.slice(at);
		if (m.index === 0 || right === "") continue;
		const found = parser.parse(right, clock.ref, optionOf(clock));
		const alone = found.length === 1 ? found[0] : undefined;
		if (alone === undefined || alone.index !== 0 || alone.text.trimEnd() !== right || alone.end != null) continue;
		if (alone.start.get("hour") !== end.get("hour") || alone.start.get("minute") !== end.get("minute")) continue;
		const minutes = (end.get("hour") ?? 0) * 60 + (end.get("minute") ?? 0) - ((r.start.get("hour") ?? 0) * 60 + (r.start.get("minute") ?? 0));
		if (minutes > 0) return { minutes };
		return { end: Object.assign(alone, { index: r.index + at }) };
	}
	return null;
}

export function findDates(masked: string, env: DateEnv): DateCandidate[] {
	const zoneNow = zoneNowOf(env.now, env.zone);
	const parser = DATE_READERS[env.locale];
	// chrono reckons in the computer's zone, so it gets an instant whose wall time there is the parse zone's: every
	// relative word, weekday and month and day then counts from the task's own clock, whatever the computer's zone (#88).
	const ref = zoneNow.setZone("system", { keepLocalTime: true }).toJSDate();
	const clock: Clock = { env, ref, refWall: wallOf(DateTime.fromJSDate(ref)), zoneNowWall: wallOf(zoneNow), today: todayOf(zoneNow), nowLocal: wallTimeOf(zoneNow), todayWeekday: zoneNow.weekday % 7 };
	const results = parser.parse(masked, ref, optionOf(clock));

	const out: DateCandidate[] = [];
	for (const result of results) {
		// A span that reaches into a mask, one introduced by "for" ("for 2 days" is not a date), or a duration without
		// `for` ("Gym 2h").
		if (result.text.includes(MASK_CHAR) || /^for\s/iu.test(result.text) || DURATION_TEXT_RE.test(result.text.trim())) continue;
		// A time range is its start time and a duration, or its end time alone when the end is not after the start.
		const range = timeRangeOf(result, parser, clock);
		const r = range !== null && "end" in range ? range.end : result;
		const timeRange = range !== null && "minutes" in range;
		// A range with a side that is only a time: its start as typed alone, still only a suggestion (a choice keeps chrono's reading).
		const alone = range === null ? startAlone(r, masked, parser, clock) : null;
		const aloneRead = alone === null ? null : readResult(alone, clock);
		const fromAlone = alone !== null && !alone.text.includes(MASK_CHAR) && aloneRead !== null && aloneRead.outcome.status !== "choice" ? { head: alone, read: aloneRead } : null;
		const read = fromAlone?.read ?? readResult(r, clock, undefined, timeRange);
		if (read === null) continue;
		const { dayCertain, hourCertain } = read;
		const outcome = fromAlone === null ? read.outcome : asSuggestion(read.outcome);
		// Where the date's own text starts: the start read alone can begin before chrono's range (`Dec 1 until 5pm`).
		const head = fromAlone?.head ?? r;

		// The span: chrono's text, widened over a directly preceding lead word (LEADS). A time joins only a date whose hour
		// is certain; an end must be a date: an end word before a time alone (`until 5pm`) widens the span only next to a
		// repeat (repeatOnly), where the parser offers the two as a suggestion; without one the time is read on its own.
		let spanStart = head.index;
		let kind: DateCandidate["kind"] = "scheduled";
		let repeatOnly = false;
		// en-GB reads "on 1 Dec" with its "on": the lead words are looked for before the date itself, and chrono's own word
		// stays part of the date (the lead found at `head.index` is that word).
		const own = OWN_LEAD_RE.exec(head.text);
		const found = leadBefore(masked, head.index + (own === null ? 0 : own[0].length));
		const lead = found !== null && (found.kind === "time" ? hourCertain : found.kind === "end" ? dayCertain : true) ? found : null;
		const timeEnd = lead === null && found?.kind === "end";
		const widened = lead ?? (timeEnd ? found : null);
		if (widened !== null) {
			spanStart = Math.min(widened.start, head.index);
			repeatOnly = timeEnd || (widened.repeatOnly && widened.start < head.index);
			if (lead?.kind === "deadline" || lead?.kind === "end") kind = lead.kind;
		} else if (/^by\s/iu.test(masked.slice(spanStart, spanStart + 3))) {
			kind = "deadline";
		}
		// chrono's text can end in spaces ("April 15, " before "for 3 times"); the span stops at the date.
		const rolls = rollKindOf(r.start, r.text);
		const candidate: DateCandidate = {
			kind,
			span: { start: spanStart, end: r.index + r.text.trimEnd().length },
			textStart: head.index,
			repeatOnly,
			lead: widened === null ? null : { words: widened.words, kind: widened.kind },
			rolls,
			outcome,
			...(timeRange ? { durationMin: range.minutes } : {}),
		};

		// Under a typed repeat, a range led by a start word (`starting`, `from` …) or by none may be the repeat's start
		// and end; the parser decides by where the repeat is.
		const split = env.repeatRange === true && (lead === null || lead.kind === "schedule") ? splitRange(r, parser, clock, lead !== null && PAIRS_WEEKDAYS.has(lead.words)) : null;
		if (split !== null) {
			candidate.range = {
				led: lead !== null,
				start: { kind: "scheduled", span: { start: spanStart, end: r.index + split.start.text.length }, textStart: r.index, repeatOnly: true, lead: candidate.lead, rolls, outcome: split.start.outcome },
				// The end already moved past the start.
				end: { kind: "end", span: { start: r.index + split.joinAt, end: r.index + split.end.at + split.end.text.length }, textStart: r.index + split.end.at, repeatOnly: true, lead: null, rolls: null, outcome: split.end.outcome },
				...(split.endByChoice !== undefined ? { endByChoice: split.endByChoice } : {}),
			};
		}
		out.push(candidate);
	}
	return out;
}
