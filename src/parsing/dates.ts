import * as chrono from "chrono-node";
import { DateTime } from "luxon";
import type { Component } from "chrono-node";
import { monthDayText, ordinal, weekdayOf } from "../domain/recurrence";
import { addDays, dateOf, dateSpecDate, dayNum, dayNumOf, isoWeekdayOf, isValidDateSpec, isValidLocalDate, monthLength, pad2, resolveWallTime, shiftMonth, wallTimeOf, yearMonthOf, type WallTimeWarning } from "../domain/time";
import { WEEKDAY_LONG, WEEKDAY_SHORT, WEEKDAYS, type DateSpec, type LocalDate } from "../domain/types";
import { DAY_NUMBER_PATTERN, DAY_PART_PATTERN, DURATION_UNIT_PATTERN, dayNumber, isSpaceChar, MASK_CHAR, MONTH_PATTERN, RANGE_JOIN_PATTERN, WEEKDAY_PATTERN, weekdayWord, wordBoundaryBefore } from "./text";
import type { DateLocale, Span } from "./types";

// Date and time recognition. chrono finds the spans and reports
// which components it is sure of; this file turns them into wall times in the
// configured zone with Luxon. chrono's own conversion to an instant is never
// used: it only knows fixed offsets, so a date across a DST change would get
// the wrong hour.

const DEFAULT_EVENING_TIME = "20:00";
const TONIGHT_RE = /\btonight\b/iu;
const STOP_LIST = new Set(["may", "sun", "sat", "march", "second", "now"]);
// An amount of time without `for`: a planned duration's units ("2h", "30 min"), or seconds, days or weeks ("3 days"),
// after an optional `at`.
const BARE_DURATION_RE = new RegExp(`^(at\\s+)?\\d+(?:\\.\\d+)?\\s*(?:(${DURATION_UNIT_PATTERN})|s|secs?|seconds?|d|days?|w|wks?|weeks?)$`, "iu");
// "the week", "a day" ("3 times a day"): a period, not a date.
const VAGUE_UNIT_RE = /^(?:the\s+|a\s+)?(?:day|week|month|year)$/iu;
// A day-part word anywhere in a date: the text's own day parts plus the three dates only (noon, midnight, tonight).
const DATE_DAY_PART_RE = new RegExp(`\\b(?:noon|midnight|tonight|${DAY_PART_PATTERN})\\b`, "iu");
const SHIFT_WORDS = "(?:next|last|past|previous|coming)";
const SHIFT_WORD_RE = new RegExp(`\\b${SHIFT_WORDS}\\b`, "iu");
// "this friday" also names its week: a range's end with it, or with a shift word, is never moved a week.
const THIS_WORD_RE = /\bthis\b/iu;
// "0H:MM" with a leading-zero two-digit hour (01-09) is written 24-hour style and is certain.
// No lookbehind (iOS): the character before is matched and ignored.
const LEADING_ZERO_TIME_RE = /(?:^|[^\d:.])0[1-9]:[0-5]\d(?!\d)/u;
const PAST_WORD_RE = /^(?:last|past|previous)\b/iu;

export type DateOutcome =
	| { status: "applied" | "suggestion"; date: DateSpec; warning?: WallTimeWarning }
	/** `notice`: a weekday that is not the day's (`Friday 15th`); such a choice blocks saving until one is chosen. */
	| { status: "choice"; alternatives: { label: string; value: DateSpec }[]; notice?: string };

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
	/** A certain hour: "alone" for one time with no day of its own ("at 5pm"), "dated" for any other; absent without one. */
	time?: "alone" | "dated";
	/**
	 * A date range (`Oct 12 to Dec 1`) read as two dates, when both sides name a day. When the input types a repeat
	 * (`DateEnv.repeatRange`) they are its start (kind "scheduled") and end (kind "end"), and `led` says a start word
	 * (`starting`, `from` …) leads it: the parser uses it only next to a typed repeat it keeps, as start and end words
	 * count only after a repeat. Without one they are the task's schedule and deadline (end kind "deadline").
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
}

/**
 * The lead words before a date (`by` and the other deadline words, `at` joining a time, `scheduled for` and `scheduled
 * on`, read as a bare date is, and a repeat's start and end words), lower case, single spaces.
 * The span widens over the lead word; "time" joins only a date whose hour is certain. Without a repeat, `until`
 * makes a deadline (the parser turns the "end" into one) and the words marked `repeatOnly` lead nothing.
 */
const LEADS: readonly Lead[] = [
	{ words: "by", kind: "deadline" },
	{ words: "due", kind: "deadline" },
	{ words: "due by", kind: "deadline" },
	{ words: "due on", kind: "deadline" },
	{ words: "deadline", kind: "deadline" },
	{ words: "deadline:", kind: "deadline" },
	{ words: "before", kind: "deadline" },
	{ words: "at", kind: "time" },
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
	{ words: "scheduled for", kind: "schedule" },
	{ words: "scheduled on", kind: "schedule" },
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
		const words = lead.words.split(" ");
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

/** The first date on or after `from` whose day of the month is `day` (1 to 31): this month's, else a later month's. */
function dayOnOrAfter(day: number, from: LocalDate): LocalDate | null {
	const month = yearMonthOf(from);
	for (let k = 0; k <= 2; k++) {
		const { year, month: m } = shiftMonth(month, k);
		if (day > monthLength(year, m)) continue;
		const date = dateOf(dayNumOf(year, m, day));
		if (date >= from) return date;
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

/** The options the date readers get: chrono's, plus today's date on the parse clock, for `impliedYear` and `OWN_PARSERS`. */
interface ReaderOption extends chrono.ParsingOption {
	today: LocalDate;
}

/** Today on the parse clock (`ReaderOption.today`); called with chrono's plain options (tests), chrono's own reference day. */
function readerToday(context: chrono.ParsingContext): LocalDate {
	const ref = context.createParsingComponents();
	return (context.option as Partial<ReaderOption>).today ?? `${String(ref.get("year") ?? 0).padStart(4, "0")}-${pad2(ref.get("month") ?? 0)}-${pad2(ref.get("day") ?? 0)}`;
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
		const today = readerToday(context);
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

/** chrono's weekday reader takes a closing bracket after the weekday (`(by Friday)`): a date ends before one it did not open. */
const closingBracket: chrono.Refiner = {
	refine(_context, results) {
		for (const r of results) {
			const m = /\s*[)）]$/u.exec(r.text);
			if (m !== null && !/[(（]/u.test(r.text)) r.text = r.text.slice(0, m.index);
		}
		return results;
	},
};

// The readers' own parsers, ahead of chrono's: of two readings of the same text and length the first is kept. Each reads
// a day on the parse clock (`readerToday`), certain, with its month and year implied.

/** A word boundary before a pattern, as group 1: no lookbehind (iOS), so the character is matched and left out. */
const BOUNDARY = "(^|[^\\p{L}\\p{N}_])";
const WORD_END = "(?![\\p{L}\\p{N}_])";
/** A month after the day (`Friday 15th October`, `on the 20th of May`) is chrono's date, not a day alone. */
const NO_MONTH_AFTER = `(?!\\s+(?:of\\s+)?${MONTH_PATTERN}${WORD_END})`;
/** What a bare day number after a weekday (`Fri 16`) comes before: nothing, a token, punctuation that starts no time, or a time. */
const BARE_DAY_END = `(?=\\s*(?:$|${MASK_CHAR}|[.,;:!?)\\]](?!\\d))|\\s+(?:at\\s|noon${WORD_END}|midnight${WORD_END}|\\d{1,2}(?::\\d{2})?\\s*[ap]\\.?m${WORD_END}|\\d{1,2}:\\d{2}))`;
const WEEKDAY_DAY_RE = new RegExp(`${BOUNDARY}(${WEEKDAY_PATTERN})\\s+((?:the\\s+)?${DAY_NUMBER_PATTERN}|\\d{1,2}${BARE_DAY_END})${WORD_END}${NO_MONTH_AFTER}`, "iu");
const ON_THE_DAY_RE = new RegExp(`${BOUNDARY}(on\\s+(the\\s+${DAY_NUMBER_PATTERN}))${WORD_END}${NO_MONTH_AFTER}`, "iu");
const END_OF_PERIOD = "(?:eod|end\\s+of\\s+(?:day|week|month|year))";
const END_OF_PERIOD_RE = new RegExp(`${BOUNDARY}(${END_OF_PERIOD})${WORD_END}`, "iu");
const NEXT_WEEKDAY_RE = new RegExp(`${BOUNDARY}(next\\s+weekday)${WORD_END}`, "iu");
const THIS_DAY_PART_RE = new RegExp(`${BOUNDARY}(this\\s+(morning|afternoon))${WORD_END}`, "iu");
/** A weekday after `this`, `next` … is chrono's (`next Friday 16th` stays `next Friday`). */
const SHIFTED_BEFORE_RE = new RegExp(`\\b(?:this|${SHIFT_WORDS})\\s+$`, "iu");
/** A date's own text that makes a deadline: chrono's `by …` and `within 3 days`, or the end of a period. */
const OWN_DEADLINE_RE = new RegExp(`^(?:(?:by|within)\\s|${END_OF_PERIOD}${WORD_END})`, "iu");

/**
 * An own parser's result: the match without its boundary (group 1), on `date` with the day certain (and the `known`
 * components), its month and year implied; with `vague`, nothing certain.
 */
function ownResult(context: chrono.ParsingContext, m: RegExpMatchArray, date: LocalDate, known: Partial<Record<Component, number>> = {}, vague = false): chrono.ParsingResult {
	const skip = (m[1] ?? "").length;
	const c = context.createParsingComponents(vague ? undefined : { day: Number(date.slice(8, 10)), ...known });
	if (vague) for (const [k, v] of Object.entries(known) as [Component, number][]) c.imply(k, v);
	c.imply("day", Number(date.slice(8, 10)));
	c.imply("month", Number(date.slice(5, 7)));
	c.imply("year", Number(date.slice(0, 4)));
	return context.createParsingResult((m.index ?? 0) + skip, m[0].slice(skip), c);
}

const ownParser = (re: RegExp, extract: (context: chrono.ParsingContext, m: RegExpMatchArray, today: LocalDate) => chrono.ParsingResult | null): chrono.Parser => ({
	pattern: () => re,
	extract: (context, m) => extract(context, m, readerToday(context)),
});

/** chrono's numbering of a weekday: 0 = Sunday. */
const chronoWeekday = (date: LocalDate): number => isoWeekdayOf(date) % 7;

const OWN_PARSERS: readonly chrono.Parser[] = [
	// `Friday 16th`, `Fri the 16th`, `Fri 16`: that weekday and the first such day on or after today; whether they agree
	// is `readResult`'s. A day number no month has (`Monday 32nd`) is that weekday with nothing certain, only offered.
	ownParser(WEEKDAY_DAY_RE, (context, m, today) => {
		const word = m[2] ?? "";
		const weekday = weekdayWord(word);
		if (weekday === undefined || /days$/iu.test(word) || SHIFTED_BEFORE_RE.test(context.text.slice(0, (m.index ?? 0) + (m[1] ?? "").length))) return null;
		const typed = (WEEKDAYS.indexOf(weekday) + 1) % 7;
		const dayText = m[3] ?? "";
		const day = dayNumber(dayText);
		if (day === null) return /\d$/u.test(dayText) ? null : ownResult(context, m, addDays(today, (typed - chronoWeekday(today) + 7) % 7), { weekday: typed }, true);
		const date = dayOnOrAfter(day, today);
		return date === null ? null : ownResult(context, m, date, { weekday: typed });
	}),
	// `on the 20th`: the first 20th on or after today. The date's text holds its `on`, as en-GB's `on 1 Dec` does
	// (`OWN_LEAD_RE`): a day alone needs it.
	ownParser(ON_THE_DAY_RE, (context, m, today) => {
		const day = dayNumber(m[3] ?? "");
		const date = day === null ? null : dayOnOrAfter(day, today);
		return date === null ? null : ownResult(context, m, date);
	}),
	// The end of a period (a deadline, `OWN_DEADLINE_RE`): today, this week's Friday (the next one on a weekend), the
	// month's last day, December 31.
	ownParser(END_OF_PERIOD_RE, (context, m, today) => {
		const unit = (m[2] ?? "").toLowerCase();
		const { year, month } = yearMonthOf(today);
		const date = unit.endsWith("week")
			? addDays(today, (5 - isoWeekdayOf(today) + 7) % 7)
			: unit.endsWith("month")
				? dateOf(dayNumOf(year, month, monthLength(year, month)))
				: unit.endsWith("year")
					? dateOf(dayNumOf(year, 12, 31))
					: today;
		return ownResult(context, m, date);
	}),
	// `next weekday`: the next Monday to Friday after today.
	ownParser(NEXT_WEEKDAY_RE, (context, m, today) => {
		let date = addDays(today, 1);
		while (isoWeekdayOf(date) > 5) date = addDays(date, 1);
		return ownResult(context, m, date);
	}),
	// `this morning`, `this afternoon`: today, with the half of the day a time after it takes (chrono's merge reads the tag).
	ownParser(THIS_DAY_PART_RE, (context, m, today) => {
		const part = (m[3] ?? "").toLowerCase();
		const r = ownResult(context, m, today);
		r.start.imply("meridiem", part === "morning" ? 0 : 1);
		r.start.addTag(`casualReference/${part}`);
		return r;
	}),
];

/**
 * chrono's casual English and en-GB readers with `OWN_PARSERS` ahead of chrono's parsers, and the refiners
 * `dateOverTime` first, `shortYear` and `impliedYear` right before the filter of impossible dates (the one refiner with
 * a `strictMode` field) and `closingBracket` last. en-GB reads a month
 * name before a two-digit day as that day ("Oct 15", "Feb 29"), as English does: its month-name-first reader is replaced
 * by a copy that does not skip a day that looks like a year (the one parser with a `shouldSkipYearLikeDate` field).
 * chrono's date range merge stays as it is. Clones: chrono's shared instances stay as they are.
 */
function buildChrono(base: chrono.Chrono): chrono.Chrono {
	const reader = base.clone();
	const filter = reader.refiners.findIndex((r) => Object.hasOwn(r, "strictMode"));
	reader.refiners.splice(filter === -1 ? reader.refiners.length : filter, 0, shortYear, impliedYear);
	reader.refiners.unshift(dateOverTime);
	reader.refiners.push(closingBracket);
	reader.parsers.unshift(...OWN_PARSERS);
	reader.parsers = reader.parsers.map((p) => (Object.hasOwn(p, "shouldSkipYearLikeDate") ? Object.assign(Object.create(Object.getPrototypeOf(p) as object) as chrono.Parser, p, { shouldSkipYearLikeDate: false }) : p));
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

/**
 * The one reader of an amount of time typed without `for`: "planned" for a planned duration alone ("Gym 2h": no date
 * at all, and no chip), "other" for any other ("3 days", "at 2h": a weak date), else null.
 */
function bareDuration(text: string): "planned" | "other" | null {
	const m = BARE_DURATION_RE.exec(text.trim());
	if (m === null) return null;
	return m[1] === undefined && m[2] !== undefined ? "planned" : "other";
}

function isWeakText(text: string): boolean {
	const t = text.trim();
	return STOP_LIST.has(t.toLowerCase()) || /^\d+$/u.test(t) || bareDuration(t) !== null || VAGUE_UNIT_RE.test(t);
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

/** Whether a reading's hour is the half of the day it says: am or pm, a day-part word, or a leading zero ("09:30"). */
const meridiemKnownOf = (r: chrono.ParsedResult): boolean => r.start.isCertain("meridiem") || DATE_DAY_PART_RE.test(r.text) || LEADING_ZERO_TIME_RE.test(r.text);

/**
 * One chrono result as a value: its date (on the parse clock) and what Quick Add makes of it. Null when unusable.
 * `fixed`: the day to use instead of chrono's, a certain one (a range's end moved past its start).
 */
function readResult(r: chrono.ParsedResult, clock: Clock, fixed?: LocalDate): { date: LocalDate; dayCertain: boolean; hourCertain: boolean; outcome: DateOutcome } | null {
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
	const lowConfidence = r.end != null || isWeakText(r.text) || (!dayCertain && !hourCertain) || looksBack;
	// A weekday typed with a day number (`Friday 15th`, OWN_PARSERS): its day and weekday are certain, its month is not.
	const typedWeekday = fixed === undefined && weekday !== null && start.isCertain("weekday") && start.isCertain("day") && !start.isCertain("month") ? weekday : null;
	if (lowConfidence) {
		const res = resolveDateSpec(mkValue(date));
		if (!res) return null;
		outcome = res.warning
			? { status: "suggestion", date: res.value, warning: res.warning }
			: { status: "suggestion", date: res.value };
	} else if (typedWeekday !== null && typedWeekday !== chronoWeekday(date)) {
		// The day is another weekday: the user chooses that day or the nearest such weekday (at most 3 days away).
		const nearest = addDays(date, ((typedWeekday - chronoWeekday(date) + 10) % 7) - 3);
		const alternatives: { label: string; value: DateSpec }[] = [];
		for (const d of [date, nearest]) {
			const res = resolveDateSpec(mkValue(d));
			if (!res) return null;
			alternatives.push({ label: `${WEEKDAY_SHORT[weekdayOf(d)]}, ${monthDayText(d)}`, value: res.value });
		}
		outcome = { status: "choice", alternatives, notice: `The ${ordinal(Number(date.slice(8, 10)))} is a ${WEEKDAY_LONG[weekdayOf(date)]}` };
	} else if (hourCertain && hour >= 1 && hour <= 12 && !meridiemKnownOf(r)) {
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

const TIME_COMPONENTS: ReadonlySet<Component> = new Set(["hour", "minute", "second", "millisecond", "meridiem"]);

/** A copy of a reading with its own fields replaced; chrono's objects stay as they are. */
const readingWith = <T extends object>(base: T, fields: Partial<T>): T => Object.assign(Object.create(base) as T, fields);

/** A reading whose time components are `certain` and `get`'s, the rest its own. */
function withTime(r: chrono.ParsedResult, certain: (k: Component) => boolean, get: (k: Component) => number | null): chrono.ParsedResult {
	const own = r.start;
	const start = readingWith(own, {
		isCertain: (k: Component) => (TIME_COMPONENTS.has(k) ? certain(k) : own.isCertain(k)),
		get: (k: Component) => (TIME_COMPONENTS.has(k) ? get(k) : own.get(k)),
	});
	return readingWith(r, { start });
}

/** A range's start with the time typed after its end (`Oct 20 to Oct 25 at 9am`), and the end with no time. */
function timeToStart(first: chrono.ParsedResult, to: chrono.ParsedResult): [chrono.ParsedResult, chrono.ParsedResult] {
	const meridiem = meridiemKnownOf(to);
	return [
		withTime(first, (k) => (k === "meridiem" ? meridiem : to.start.isCertain(k)), (k) => to.start.get(k)),
		withTime(to, () => false, () => null),
	];
}

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
 * For a task (`task`: no typed repeat; the end is a deadline) two bare weekdays pair unless a dash joins them, a month
 * written once (`Oct 20-25`) gives the end its month, a start with a time of its own is no split, a time after the end
 * is the start's (`Oct 20 to Oct 25 at 9am`), and only a weekday end moves: a month and day end before the start is
 * never guessed (null).
 */
function splitRange(r: chrono.ParsedResult, parser: chrono.Chrono, clock: Clock, startWord: boolean, task: boolean): RangeSplit | null {
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
		const dash = /^[-–]$/u.test(m[0].trim());
		const first = whole(left);
		let to = first === null ? null : whole(right);
		if (task && to === null && first?.start.isCertain("month") === true && dash && m[0].length === 1 && /^\d{1,2}$/u.test(right)) {
			// The day after the dash, in the start's month, as chrono's range read it; its text is the range's, as a bare
			// number alone is a weak date.
			to = readingWith(r, { index: r.index + at, start: r.end, end: undefined });
		}
		if (first === null || to === null) continue;
		if ((task ? dash : !startWord) && weekdayOnly(first.start) && weekdayOnly(to.start)) return null;
		// A task's range from a date and time (`Oct 8 3pm - Oct 9 4pm`) stays one suggestion.
		if (task && first.start.isCertain("hour")) return null;
		const [startRead, endRead] = task && to.start.isCertain("hour") ? timeToStart(first, to) : [first, to];
		const start = readResult(startRead, clock);
		const end = readResult(endRead, clock);
		if (start === null || end === null) return null;
		const rolls = rollKindOf(to.start, to.text);
		const by = task && rolls === "year" ? null : rolls;
		// A start with its own year: a month and day end counts from the start, not from today.
		const fromStart = by === "year" && hasTypedYear(first.start);
		// The end for one start date (`end.outcome` itself when it stays); null when it cannot move.
		const endFrom = (from: LocalDate): DateOutcome | null => {
			if (by === null) return task && end.date < from ? null : end.outcome;
			const moved = fromStart ? monthDayOnOrAfter(end.date.slice(5), from) : rollEnd(end.date, from, by);
			if (moved === null) return null;
			// The moved end is that day: a weekday is never the "today or next week" choice of a weekday said today. An end
			// more than a year past the start (`Feb 20 to Feb 29` said in 2027) is a suggestion, not applied.
			const outcome = moved === end.date ? end.outcome : (readResult(endRead, clock, moved)?.outcome ?? null);
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

export function findDates(masked: string, env: DateEnv): DateCandidate[] {
	const zoneNow = zoneNowOf(env.now, env.zone);
	const parser = DATE_READERS[env.locale];
	// chrono reckons in the computer's zone, so it gets an instant whose wall time there is the parse zone's: every
	// relative word, weekday and month and day then counts from the task's own clock, whatever the computer's zone (#88).
	const ref = zoneNow.setZone("system", { keepLocalTime: true }).toJSDate();
	const clock: Clock = { env, ref, refWall: wallOf(DateTime.fromJSDate(ref)), zoneNowWall: wallOf(zoneNow), today: todayOf(zoneNow), nowLocal: wallTimeOf(zoneNow), todayWeekday: zoneNow.weekday % 7 };
	const results = parser.parse(masked, ref, optionOf(clock));

	const out: DateCandidate[] = [];
	for (const r of results) {
		// A span that reaches into a mask, one introduced by "for" ("for 2 days" is not a date), or a duration without
		// `for` ("Gym 2h").
		if (r.text.includes(MASK_CHAR) || /^for\s/iu.test(r.text) || bareDuration(r.text) === "planned") continue;
		// A range with a side that is only a time: its start as typed alone, still only a suggestion (a choice keeps chrono's reading).
		const alone = startAlone(r, masked, parser, clock);
		const aloneRead = alone === null ? null : readResult(alone, clock);
		const fromAlone = alone !== null && !alone.text.includes(MASK_CHAR) && aloneRead !== null && aloneRead.outcome.status !== "choice" ? { head: alone, read: aloneRead } : null;
		const read = fromAlone?.read ?? readResult(r, clock);
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
		} else if (OWN_DEADLINE_RE.test(head.text)) {
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
			...(hourCertain ? { time: timeOnly(r) ? ("alone" as const) : ("dated" as const) } : {}),
		};

		// Under a typed repeat, a range led by a start word (`starting`, `from` …) or by none may be the repeat's start
		// and end; the parser decides by where the repeat is. Without one, a range led by none, `from`, or a word read as
		// a bare date is (`scheduled for`) is the task's schedule and deadline.
		const task = env.repeatRange !== true;
		const pairs = lead === null || (lead.kind === "schedule" && (!task || lead.words === "from" || !lead.repeatOnly));
		const split = pairs ? splitRange(r, parser, clock, !task && lead !== null && PAIRS_WEEKDAYS.has(lead.words), task) : null;
		if (split !== null) {
			candidate.range = {
				led: lead !== null,
				start: { kind: "scheduled", span: { start: spanStart, end: r.index + split.start.text.length }, textStart: r.index, repeatOnly: !task, lead: candidate.lead, rolls, outcome: split.start.outcome },
				// The end already moved past the start.
				end: { kind: task ? "deadline" : "end", span: { start: r.index + split.joinAt, end: r.index + split.end.at + split.end.text.length }, textStart: r.index + split.end.at, repeatOnly: !task, lead: null, rolls: null, outcome: split.end.outcome },
				...(split.endByChoice !== undefined ? { endByChoice: split.endByChoice } : {}),
			};
		}
		out.push(candidate);
	}
	return out;
}
