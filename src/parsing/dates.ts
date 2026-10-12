import * as chrono from "chrono-node";
import { DateTime } from "luxon";
import type { Component } from "chrono-node";
import { LOCAL_FORMAT, addDays, dateOf, dateSpecDate, dayNum, isValidDateSpec, isValidLocalDate, pad2, resolveWallTime, type WallTimeWarning } from "../domain/time";
import type { DateSpec, LocalDate } from "../domain/types";
import { DAY_PART_PATTERN, isSpaceChar, MASK_CHAR, RANGE_JOIN_PATTERN, wordBoundaryBefore } from "./text";
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
const VAGUE_UNIT_RE = /^(?:the\s+)?(?:day|week|month|year)$/iu;
// A day-part word anywhere in a date: the text's own day parts plus the three dates only (noon, midnight, tonight).
const DATE_DAY_PART_RE = new RegExp(`\\b(?:noon|midnight|tonight|${DAY_PART_PATTERN})\\b`, "iu");
const SHIFT_WORD_RE = /\b(?:next|last|past|previous|coming)\b/iu;
// "this friday" also names its week: a range's end with it, or with a shift word, is never moved a week.
const THIS_WORD_RE = /\bthis\b/iu;
// "0H:MM" with a leading-zero two-digit hour (01-09) is written 24-hour style and is certain.
// No lookbehind (iOS): the character before is matched and ignored.
const LEADING_ZERO_TIME_RE = /(?:^|[^\d:.])0[1-9]:[0-5]\d(?!\d)/u;
const PAST_WORD_RE = /^(?:last|past|previous)\b/iu;

export type DateOutcome =
	| { status: "applied" | "suggestion"; date: DateSpec; warning?: WallTimeWarning }
	| { status: "choice"; alternatives: { label: string; value: DateSpec }[] };

export interface DateCandidate {
	/** "end": a repeat's end (`until Dec 1`); the parser makes it a deadline when nothing repeats. */
	kind: "scheduled" | "deadline" | "end";
	/** Includes the lead word (LEADS) that directly precedes the date text. */
	span: Span;
	/** Where the date text itself starts (after the lead word). */
	textStart: number;
	/** The lead word counts only when the input repeats (`ending`, `starting` …): without a repeat it is title text. */
	repeatOnly: boolean;
	/** A month and day with no typed year: as a repeat's end before the start it rolls to the next such date. */
	monthDay: boolean;
	outcome: DateOutcome;
	/**
	 * A date range (`Oct 12 to Dec 1`) read as a repeat's start (kind "scheduled") and end (kind "end"), when the input
	 * types a repeat (`DateEnv.repeatRange`) and both sides name a day. `led`: a start word (`starting`, `from` …) leads
	 * it. The parser uses it only next to a typed repeat it keeps (Repeating tasks rule 19).
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
export type LeadKind = "deadline" | "time" | "end" | "schedule";

interface Lead {
	words: string;
	kind: LeadKind;
	/** Only next to a repeat: these are also everyday words ("the movie ending", "the starting lineup"). */
	repeatOnly?: true;
}

/**
 * The lead words before a date (Tasks and Quick Add rule 28, Repeating tasks rule 19), lower case, single spaces.
 * The span widens over the lead word; "time" joins only a date whose hour is certain. Without a repeat, `until`
 * makes a deadline (the parser turns the "end" into one) and the words marked `repeatOnly` lead nothing.
 */
export const LEADS: readonly Lead[] = [
	{ words: "by", kind: "deadline" },
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
];

/** The lead word that ends right before `index` (over spaces), the longest when several fit; null when none does. */
export function leadBefore(s: string, index: number): { start: number; kind: LeadKind; repeatOnly: boolean } | null {
	let best: { start: number; kind: LeadKind; repeatOnly: boolean } | null = null;
	for (const lead of LEADS) {
		let at = index;
		const words = lead.words.split(" ");
		for (let w = words.length - 1; w >= 0 && at !== -1; w--) at = wordBefore(s, at, words[w]!);
		if (at !== -1 && (best === null || at < best.start)) best = { start: at, kind: lead.kind, repeatOnly: lead.repeatOnly === true };
	}
	return best;
}

/** The first real date with this month and day ("MM-DD") on or after `from`, in its year or the 8 years after it (the next Feb 29). */
export function monthDayOnOrAfter(monthDay: string, from: LocalDate): LocalDate | null {
	const firstYear = Number(from.slice(0, 4));
	for (let year = firstYear; year <= firstYear + 8; year++) {
		const date = `${String(year).padStart(4, "0")}-${monthDay}`;
		if (isValidLocalDate(date) && date >= from) return date;
	}
	return null;
}

/** A repeat's end that rolled to more than a year after its start is a suggestion, not applied (Repeating tasks rule 19). */
export function rollsPastYear(from: LocalDate, to: LocalDate): boolean {
	return dayNum(to) - dayNum(from) > 366;
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

/**
 * chrono's casual English and en-GB readers with `shortYear` and `impliedYear` right before the filter of impossible
 * dates (the one refiner with a `strictMode` field). chrono's date range merge stays as it is. Clones: chrono's shared
 * instances stay as they are.
 */
function buildChrono(base: chrono.Chrono): chrono.Chrono {
	const reader = base.clone();
	const filter = reader.refiners.findIndex((r) => Object.hasOwn(r, "strictMode"));
	reader.refiners.splice(filter === -1 ? reader.refiners.length : filter, 0, shortYear, impliedYear);
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

/** Looks backwards over whitespace for the word `word` directly before `index`. */
function wordBefore(s: string, index: number, word: string): number {
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
	today: LocalDate;
	nowLocal: string;
	/** 0 = Sunday, chrono's numbering. */
	todayWeekday: number;
}

/** What every parse call hands the reader: a forward reading, and today for `impliedYear`. */
const optionOf = (clock: Clock): ReaderOption => ({ forwardDate: true, today: clock.today });

/**
 * One chrono result as a value: its date (on the parse clock) and what Quick Add makes of it. Null when unusable.
 * `fixed`: the day to use instead of chrono's, a certain one (a range's end moved past its start).
 */
function readResult(r: chrono.ParsedResult, clock: Clock, fixed?: LocalDate): { date: LocalDate; hourCertain: boolean; outcome: DateOutcome } | null {
	const { env, today, nowLocal, todayWeekday } = clock;
	const start = r.start;
	const dayKnown = fixed !== undefined || start.isCertain("day");
	const dayCertain = dayKnown || start.isCertain("weekday");
	const hourCertain = start.isCertain("hour");
	const base = DateTime.fromObject(
		{ year: start.get("year") ?? 0, month: start.get("month") ?? 0, day: start.get("day") ?? 0 },
		{ zone: env.zone },
	);
	let date = fixed ?? (base.isValid ? isoDate(base) : null);
	if (date === null) return null;
	const hour = start.get("hour") ?? 0;
	const minute = start.get("minute") ?? 0;
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
	const meridiemKnown = start.isCertain("meridiem") || DATE_DAY_PART_RE.test(r.text) || LEADING_ZERO_TIME_RE.test(r.text);
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
	return { date, hourCertain, outcome };
}

/** A year that was typed, not assumed by chrono or chosen by `impliedYear`. */
const hasTypedYear = (c: chrono.ParsedComponents): boolean => c.isCertain("year");
const dayCertainOf = (c: chrono.ParsedComponents): boolean => c.isCertain("day") || c.isCertain("weekday");
/** A weekday with no day of the month (`Friday`, `next friday`). */
const weekdayOnly = (c: chrono.ParsedComponents): boolean => c.isCertain("weekday") && !c.isCertain("day");

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
 * to the first such date on or after the start: a bare weekday by weeks (one with `this`, `next`, `last` … keeps its
 * reading), a month and day by years. A start that is a choice (`Wednesday` said on a Wednesday) gets an end for each
 * of its alternatives. Null unless both sides name a day and the text splits at a join word into two whole dates; two
 * bare weekdays (`Mon-Fri`: days of the week) only with a start word (`startWord`: `starting`, `beginning`).
 */
function splitRange(r: chrono.ParsedResult, parser: chrono.Chrono, ref: chrono.ParsingReference, clock: Clock, startWord: boolean): RangeSplit | null {
	if (r.end == null || !dayCertainOf(r.start) || !dayCertainOf(r.end)) return null;
	const whole = (text: string): chrono.ParsedResult | null => {
		const found = parser.parse(text, ref, optionOf(clock));
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
		const typedYear = hasTypedYear(to.start);
		const byWeek = weekdayOnly(to.start);
		const keeps = typedYear || (byWeek && (SHIFT_WORD_RE.test(to.text) || THIS_WORD_RE.test(to.text)));
		// A start with its own year: a month and day end counts from the start, not from today.
		const fromStart = !keeps && !byWeek && hasTypedYear(first.start);
		// The end for one start date (`end.outcome` itself when it stays); null when it cannot move.
		const endFrom = (from: LocalDate): DateOutcome | null => {
			if (keeps) return end.outcome;
			let moved: LocalDate | null = end.date;
			// A weekday: the first one on or after the start, in one step.
			if (byWeek) {
				if (end.date < from) moved = dateOf(dayNum(end.date) + 7 * Math.ceil((dayNum(from) - dayNum(end.date)) / 7));
			} else if (fromStart || end.date < from) moved = monthDayOnOrAfter(end.date.slice(5), from);
				if (moved === null) return null;
				// The moved end is that day: a weekday is never the "today or next week" choice of a weekday said today. An end
				// more than a year past the start (`Feb 20 to Feb 29` said in 2027) is a suggestion, not applied.
				const outcome = moved === end.date ? end.outcome : (readResult(to, clock, moved)?.outcome ?? null);
				if (outcome === null || outcome.status !== "applied" || !rollsPastYear(from, moved)) return outcome;
				return outcome.warning === undefined ? { status: "suggestion", date: outcome.date } : { status: "suggestion", date: outcome.date, warning: outcome.warning };
		};
		const o = start.outcome;
		const froms = o.status === "choice" ? o.alternatives.map((a) => dateSpecDate(a.value, clock.env.zone)) : [start.date];
		const ends: DateOutcome[] = [];
		for (const from of froms) {
			// A month and day end moves a year for a later choice only when it moved for the first; otherwise it keeps
			// its reading, as with a start edited by hand (an end before the start is invalid).
			const e = ends.length === 0 || byWeek || ends[0] !== end.outcome ? endFrom(from) : end.outcome;
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

export function findDates(masked: string, env: DateEnv): DateCandidate[] {
	const zoneNow = DateTime.fromJSDate(env.now, { zone: env.zone });
	if (!zoneNow.isValid) throw new RangeError(`Invalid reference time or zone ${env.zone}`);
	const parser = DATE_READERS[env.locale];
	const ref = { instant: env.now, timezone: zoneNow.offset };
	const clock: Clock = { env, today: todayOf(zoneNow), nowLocal: zoneNow.toFormat(LOCAL_FORMAT), todayWeekday: zoneNow.weekday % 7 };
	const results = parser.parse(masked, ref, optionOf(clock));

	const out: DateCandidate[] = [];
	for (const r of results) {
		// A span that reaches into a mask, or one introduced by "for" ("for 2 days" is not a date).
		if (r.text.includes(MASK_CHAR) || /^for\s/iu.test(r.text)) continue;
		const read = readResult(r, clock);
		if (read === null) continue;
		const { hourCertain, outcome } = read;

		// The span: chrono's text, widened over a directly preceding lead word (LEADS).
		let spanStart = r.index;
		let kind: DateCandidate["kind"] = "scheduled";
		let repeatOnly = false;
		const lead = leadBefore(masked, spanStart);
		if (lead !== null && (lead.kind !== "time" || hourCertain)) {
			spanStart = lead.start;
			repeatOnly = lead.repeatOnly;
			if (lead.kind === "deadline" || lead.kind === "end") kind = lead.kind;
		} else if (/^by\s/iu.test(masked.slice(spanStart, spanStart + 3))) {
			kind = "deadline";
		}
		// chrono's text can end in spaces ("April 15, " before "for 3 times"); the span stops at the date.
			const monthDay = r.start.isCertain("month") && r.start.isCertain("day") && !hasTypedYear(r.start);
		const candidate: DateCandidate = { kind, span: { start: spanStart, end: r.index + r.text.trimEnd().length }, textStart: r.index, repeatOnly, monthDay, outcome };

		// Under a typed repeat, a range led by a start word (`starting`, `from` …) or by none may be the repeat's start
		// and end; the parser decides by where the repeat is.
		const from = lead === null ? wordBefore(masked, r.index, "from") : -1;
		const led = lead?.kind === "schedule" || from !== -1;
		const split = env.repeatRange === true && (lead === null || lead.kind === "schedule") ? splitRange(r, parser, ref, clock, lead !== null) : null;
		if (split !== null) {
			candidate.range = {
				led,
				start: { kind: "scheduled", span: { start: from !== -1 ? from : spanStart, end: r.index + split.start.text.length }, textStart: r.index, repeatOnly: true, monthDay, outcome: split.start.outcome },
					// The end already moved past the start.
				end: { kind: "end", span: { start: r.index + split.joinAt, end: r.index + split.end.at + split.end.text.length }, textStart: r.index + split.end.at, repeatOnly: true, monthDay: false, outcome: split.end.outcome },
				...(split.endByChoice !== undefined ? { endByChoice: split.endByChoice } : {}),
			};
		}
		out.push(candidate);
	}
	return out;
}
