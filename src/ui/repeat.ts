import { DateTime } from "luxon";
import { EVERY_WEEKDAY, describeEnd, describeRule, monthDayText, normalizeRepeatRule, ordinal, repeatRuleProblem, weekdayOf } from "../domain/recurrence";
import { addDays, isValidLocalDate } from "../domain/time";
import {
	type LocalDate,
	type MonthlyOn,
	type Recurrence,
	type RepeatEnd,
	type RepeatFreq,
	type RepeatRule,
	type WeekStart,
	type Weekday,
	WEEKDAYS,
	WEEKDAY_LONG,
	WEEKDAY_SHORT as WEEKDAY_ABBR,
} from "../domain/types";

// What the repeat picker needs, as pure functions: the presets, the custom editor's draft and how a
// draft becomes a RepeatRule. The rule itself is checked and normalized by the domain (repeatRuleProblem,
// normalizeRepeatRule); nothing here decides what a valid rule is.

/** A rule with its end: what the picker returns and what the Quick Add model and the details pane keep. */
export interface RepeatChoice {
	rule: RepeatRule;
	end: RepeatEnd;
}

export const NEVER_END: RepeatEnd = { kind: "never" };

export const WEEKDAY_TWO_LETTER: Readonly<Record<Weekday, string>> = { MO: "Mo", TU: "Tu", WE: "We", TH: "Th", FR: "Fr", SA: "Sa", SU: "Su" };
export { WEEKDAY_LONG };

/** The weekdays in the order of a week that starts on `weekStart`. */
export function weekdaysFrom(weekStart: WeekStart): Weekday[] {
	const first = WEEKDAYS.indexOf(weekStart);
	return [...WEEKDAYS.slice(first), ...WEEKDAYS.slice(0, first)];
}

/** A single-version series for `rule`, so the domain's descriptions (which read the anchor) can be used. */
export function recurrenceOf(choice: RepeatChoice, anchor: LocalDate): Recurrence {
	return { anchor, versions: [{ effectiveFrom: anchor, rule: choice.rule }], end: choice.end, endedAt: null };
}

/** The time of a timed rule is part of what it says: "every Mon at 17:00". */
export function withTime(text: string, rule: Pick<RepeatRule, "time">): string {
	return rule.time === null ? text : `${text} at ${rule.time}`;
}

/**
 * The date a rule's text names. A yearly rule on an existing series follows the series' first date (`seriesAnchor`): a
 * rule change keeps the anchor, so "yearly on Jan 15" is what the engine schedules, whatever date is on screen. Every
 * other rule, and a new series, names `anchor`.
 */
function textAnchor(rule: Pick<RepeatRule, "freq">, anchor: LocalDate, seriesAnchor: LocalDate | undefined): LocalDate {
	return rule.freq === "yearly" && seriesAnchor !== undefined ? seriesAnchor : anchor;
}

/** "every Fri", "every Mon at 17:00": the short rule text of chips and notices. `seriesAnchor`: see textAnchor. */
export function ruleText(choice: RepeatChoice, anchor: LocalDate, seriesAnchor?: LocalDate): string {
	return withTime(describeRule(recurrenceOf(choice, textAnchor(choice.rule, anchor, seriesAnchor))), choice.rule);
}

const LONG_DAY_BY_SHORT: Readonly<Record<string, string>> = Object.fromEntries(WEEKDAYS.map((d) => [WEEKDAY_ABBR[d], WEEKDAY_LONG[d]]));

/**
 * The Repeat line of the picker and the field's value: "every Fri · ends after 10 times", or "Never". `long`
 * spells the weekdays out ("every Friday"), as the custom editor's summary does. `seriesAnchor`: see textAnchor.
 */
export function repeatLine(choice: RepeatChoice | null, given: LocalDate, today: LocalDate, long = false, seriesAnchor?: LocalDate): string {
	if (choice === null) return "Never";
	const anchor = textAnchor(choice.rule, given, seriesAnchor);
	const rec = recurrenceOf(choice, anchor);
	const end = describeEnd(rec, today);
	let text = describeRule(rec);
	if (long) {
		text = text.replace(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/gu, (d) => LONG_DAY_BY_SHORT[d] ?? d);
		// The chip says "monthly on the 31st"; the summary also spells out the month-end fallback.
		const r = choice.rule;
		const day = r.freq !== "monthly" || r.afterCompletion ? 0 : r.monthly === null ? Number(anchor.slice(8, 10)) : r.monthly.kind === "day" ? r.monthly.day : 0;
		if (day >= 29) text = text.replace(/on the \d+(st|nd|rd|th)/u, (m) => `${m} (or the month's last day)`);
		// A yearly Feb 29 falls on Feb 28 in other years.
		if (r.freq === "yearly" && !r.afterCompletion && anchor.slice(5) === "02-29") text = `${text} (or Feb 28)`;
	}
	text = withTime(text, choice.rule);
	return end === null ? text : `${text} · ${end}`;
}

// -- presets ------------------------------------------------------------------------

export type PresetId = "never" | "daily" | "weekday" | "weekly" | "monthly" | "yearly" | "custom";

export const PRESET_IDS: readonly PresetId[] = ["never", "daily", "weekday", "weekly", "monthly", "yearly", "custom"];

const sameDays = (a: readonly Weekday[], b: readonly Weekday[]) => a.length === b.length && a.every((d) => b.includes(d));

/** Which preset a value is, or "custom" when none is exactly it. Time, zone and the end do not matter. */
export function presetOf(choice: RepeatChoice | null, anchor: LocalDate): PresetId {
	if (choice === null) return "never";
	const r = choice.rule;
	if (r.afterCompletion || r.interval !== 1) return "custom";
	if (r.freq === "daily") return "daily";
	if (r.freq === "weekly") {
		if (r.weekdays === null) return "weekly";
		if (sameDays(r.weekdays, EVERY_WEEKDAY)) return "weekday";
		return r.weekdays.length === 1 && r.weekdays[0] === weekdayOf(anchor) ? "weekly" : "custom";
	}
	if (r.freq === "yearly") return "yearly";
	const m = r.monthly;
	if (m === null) return "monthly";
	return m.kind === "day" && m.day === Number(anchor.slice(8, 10)) ? "monthly" : "custom";
}

/** The small text of a preset: "Mon–Fri", "on Friday", "on the 9th", "on Oct 9". `seriesAnchor`: see textAnchor. */
export function presetHint(id: PresetId, anchor: LocalDate, seriesAnchor?: LocalDate): string | null {
	if (id === "weekday") return "Mon–Fri";
	if (id === "weekly") return `on ${WEEKDAY_LONG[weekdayOf(anchor)]}`;
	if (id === "monthly") return `on the ${ordinal(Number(anchor.slice(8, 10)))}`;
	if (id === "yearly") return `on ${monthDayText(textAnchor({ freq: "yearly" }, anchor, seriesAnchor))}`;
	return null;
}

export const PRESET_LABEL: Readonly<Record<PresetId, string>> = {
	never: "Never",
	daily: "Daily",
	weekday: "Every weekday",
	weekly: "Weekly",
	monthly: "Monthly",
	yearly: "Yearly",
	custom: "Custom…",
};

/**
 * The value of a preset (null = Never). It keeps the time and zone of `current`, and its end. Weekly and Monthly
 * follow the anchor ("the anchor's weekday or day") unless `explicitFor` is given: then they name that date's
 * weekday and day, so the hint the picker shows and the rule it stores agree (the details pane, whose anchor is
 * the current occurrence and not the series' own first date).
 */
export function presetChoice(id: Exclude<PresetId, "custom">, current: RepeatChoice | null, explicitFor?: LocalDate): RepeatChoice | null {
	if (id === "never") return null;
	const base = { interval: 1, afterCompletion: false, time: current?.rule.time ?? null, tz: current?.rule.tz ?? null };
	const end = current?.end ?? NEVER_END;
	if (id === "daily") return { rule: { ...base, freq: "daily", weekdays: null, monthly: null }, end };
	if (id === "weekday") return { rule: { ...base, freq: "weekly", weekdays: [...EVERY_WEEKDAY], monthly: null }, end };
	if (id === "weekly") return { rule: { ...base, freq: "weekly", weekdays: explicitFor === undefined ? null : [weekdayOf(explicitFor)], monthly: null }, end };
	// Yearly has no explicit form: it always follows the anchor's month and day.
	if (id === "yearly") return { rule: { ...base, freq: "yearly", weekdays: null, monthly: null }, end };
	const monthly = explicitFor === undefined ? null : ({ kind: "day", day: Number(explicitFor.slice(8, 10)) } as const);
	return { rule: { ...base, freq: "monthly", weekdays: null, monthly }, end };
}

// -- the custom editor's draft --------------------------------------------------------

export type MonthKind = MonthlyOn["kind"];
export type NthValue = 1 | 2 | 3 | 4 | -1;

export const NTH_OPTIONS: readonly { n: NthValue; label: string }[] = [
	{ n: 1, label: "first" },
	{ n: 2, label: "second" },
	{ n: 3, label: "third" },
	{ n: 4, label: "fourth" },
	{ n: -1, label: "last" },
];

export interface RepeatDraft {
	/** Text, so a half-typed number is kept; it is read when the rule is built. */
	interval: string;
	freq: RepeatFreq;
	/** Picked weekdays (weekly). Empty means the anchor's weekday. */
	days: Weekday[];
	monthKind: MonthKind;
	/** The day of month of "Day N". */
	monthDay: number;
	nthN: NthValue;
	nthWeekday: Weekday;
	after: boolean;
	endKind: RepeatEnd["kind"];
	endDate: string;
	endCount: string;
	/** Kept from the value being edited: the picker does not change them. */
	time: string | null;
	tz: string | null;
}

/** The nth of the anchor's weekday in its month (the 5th becomes "last"). */
function nthOfMonth(anchor: LocalDate): NthValue {
	const n = Math.ceil(Number(anchor.slice(8, 10)) / 7);
	return n >= 5 ? -1 : (n as NthValue);
}

/** The editor's starting point: the value being edited, or every week on the picked date. */
export function draftOf(value: RepeatChoice | null, anchor: LocalDate): RepeatDraft {
	const day = Number(anchor.slice(8, 10));
	const draft: RepeatDraft = {
		interval: "1",
		freq: "weekly",
		days: [],
		monthKind: "day",
		monthDay: day,
		nthN: nthOfMonth(anchor),
		nthWeekday: weekdayOf(anchor),
		after: false,
		endKind: "never",
		endDate: "",
		endCount: "10",
		time: null,
		tz: null,
	};
	if (value === null) return draft;
	const r = value.rule;
	draft.interval = String(r.interval);
	draft.freq = r.freq;
	draft.days = r.freq === "weekly" && r.weekdays !== null ? [...r.weekdays] : [];
	if (r.freq === "monthly" && r.monthly !== null) {
		draft.monthKind = r.monthly.kind;
		if (r.monthly.kind === "day") draft.monthDay = r.monthly.day;
		else if (r.monthly.kind === "nth") {
			draft.nthN = r.monthly.n;
			draft.nthWeekday = r.monthly.weekday;
		}
	}
	draft.after = r.afterCompletion;
	draft.time = r.time;
	draft.tz = r.tz;
	draft.endKind = value.end.kind;
	if (value.end.kind === "date") draft.endDate = value.end.date;
	if (value.end.kind === "count") draft.endCount = String(value.end.count);
	return draft;
}

/** Why "Count from when I complete it" is off, or null when it can be on. */
export function afterCompletionBlock(d: RepeatDraft): string | null {
	if (d.freq === "weekly" && d.days.length > 0) return "Not with picked weekdays: the days are fixed.";
	if (d.freq === "monthly" && d.monthKind !== "day") return "Not with this day of the month: the day is fixed.";
	return null;
}

/** `date` plus `n` days, weeks, months or years (a month end clamps: Jan 31 + 1 month is Feb 28, Feb 29 + 1 year is Feb 28). */
function plusUnits(date: LocalDate, freq: RepeatFreq, n: number): LocalDate {
	if (freq === "daily") return addDays(date, n);
	if (freq === "weekly") return addDays(date, 7 * n);
	return DateTime.fromISO(date, { zone: "UTC" }).plus({ months: freq === "yearly" ? 12 * n : n }).toISODate() ?? date;
}

/** "Oct 5", or "Oct 5, 2027" with the year (a yearly next date, which would otherwise read as the same day). */
const shortDate = (date: LocalDate, withYear = false): string => (withYear ? `${monthDayText(date)}, ${date.slice(0, 4)}` : monthDayText(date));

/**
 * The small text under the checkbox: an example from today and the draft's interval ("Done on Oct 5 →
 * next Oct 8. Done late on Oct 10 → next Oct 13."), or why the option is off.
 */
export function afterCompletionHint(d: RepeatDraft, today: LocalDate): string {
	const block = afterCompletionBlock(d);
	if (block !== null) return block;
	const n = Number(d.interval);
	const k = Number.isInteger(n) && n >= 1 && n <= 999 ? n : 1;
	const late = addDays(today, 5);
	const yearly = d.freq === "yearly";
	return `Done on ${shortDate(today)} → next ${shortDate(plusUnits(today, d.freq, k), yearly)}. Done late on ${shortDate(late)} → next ${shortDate(plusUnits(late, d.freq, k), yearly)}.`;
}

/** The rule a draft describes, before the domain checks it. */
export function ruleOfDraft(d: RepeatDraft): RepeatRule {
	const after = d.after && afterCompletionBlock(d) === null;
	const monthly: MonthlyOn | null =
		d.freq !== "monthly" || after
			? null
			: d.monthKind === "day"
				? { kind: "day", day: d.monthDay }
				: d.monthKind === "lastDay"
					? { kind: "lastDay" }
					: { kind: "nth", n: d.nthN, weekday: d.nthWeekday };
	return {
		freq: d.freq,
		interval: d.interval.trim() === "" ? Number.NaN : Number(d.interval),
		weekdays: d.freq === "weekly" && d.days.length > 0 ? [...d.days] : null,
		monthly,
		afterCompletion: after,
		time: d.time,
		tz: d.time === null ? null : d.tz,
	};
}

function endOfDraft(d: RepeatDraft): RepeatEnd {
	if (d.endKind === "date") return { kind: "date", date: d.endDate };
	if (d.endKind === "count") return { kind: "count", count: d.endCount.trim() === "" ? Number.NaN : Number(d.endCount) };
	return NEVER_END;
}

/** Why the draft cannot be saved (the domain's message for the rule, or for the end), or null. */
export function draftProblem(d: RepeatDraft, anchor: LocalDate): string | null {
	const rule = ruleOfDraft(d);
	const problem = repeatRuleProblem(rule);
	if (problem !== null) return problem;
	if (d.endKind === "count" && !(Number.isInteger(Number(d.endCount)) && Number(d.endCount) >= 1 && d.endCount.trim() !== "")) {
		return "End after 1 or more times.";
	}
	if (d.endKind === "date") {
		if (!isValidLocalDate(d.endDate)) return "Pick an end date.";
		if (d.endDate < anchor) return "The end date is before the first date.";
	}
	return null;
}

/** The value of a valid draft, in its stored form. */
export function choiceOfDraft(d: RepeatDraft): RepeatChoice {
	return { rule: normalizeRepeatRule(ruleOfDraft(d)), end: endOfDraft(d) };
}

/** Key-order-independent JSON, for comparing values that were built in different places. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const o = value as Record<string, unknown>;
		return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

/**
 * True when the picker handed back what it was given: no edit. The editor builds a rule without the `weekStart` a stored
 * rule may carry, so a missing one is filled from `given` before comparing.
 */
export function sameChoice(returned: RepeatChoice | null, given: RepeatChoice | null): boolean {
	if (returned === null || given === null) return returned === given;
	const rule = returned.rule.weekStart === undefined && given.rule.weekStart !== undefined ? { ...returned.rule, weekStart: given.rule.weekStart } : returned.rule;
	return canonical({ rule, end: returned.end }) === canonical(given);
}
