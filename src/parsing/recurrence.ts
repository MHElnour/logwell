import { EVERY_WEEKDAY, MAX_INTERVAL, normalizeRepeatRule, repeatRuleProblem } from "../domain/recurrence";
import { collapseWhitespace } from "../domain/text";
import { pad2 } from "../domain/time";
import type { MonthlyOn, RepeatRule, Weekday } from "../domain/types";

// Quick Add `every …`. The tokenizer (tokens.ts) finds the
// span; this file turns its text into a RepeatRule. Pure; no chrono, no clock.
//
// Conventions (the engine and the picker rely on them):
// - `weekly` with `weekdays: null` ("every week") means the anchor's weekday; `monthly: null` ("every
//   month") means the anchor's day of month. The engine reads both that way, so the parser needs no anchor.
// - "every <weekday>" names its weekdays ("every friday" is `["FR"]`, whatever the anchor is).
// - "At <time>" sets `time` ("HH:mm") and `tz` (the parse zone). A bare hour 1–12 without am/pm is
//   ambiguous (09:00 or 21:00): `rule` has the first reading and `other` the second, and Quick Add offers both
//   as a choice, like "at 5" in a date.
// - After completion and the end of a series are picker-only.

const DAY_OF: Readonly<Record<string, Weekday>> = {
	mon: "MO",
	monday: "MO",
	mondays: "MO",
	tue: "TU",
	tues: "TU",
	tuesday: "TU",
	tuesdays: "TU",
	wed: "WE",
	wednesday: "WE",
	wednesdays: "WE",
	thu: "TH",
	thur: "TH",
	thurs: "TH",
	thursday: "TH",
	thursdays: "TH",
	fri: "FR",
	friday: "FR",
	fridays: "FR",
	sat: "SA",
	saturday: "SA",
	saturdays: "SA",
	sun: "SU",
	sunday: "SU",
	sundays: "SU",
};

const NTH_OF: Readonly<Record<string, 1 | 2 | 3 | 4 | -1>> = {
	first: 1,
	"1st": 1,
	second: 2,
	"2nd": 2,
	third: 3,
	"3rd": 3,
	fourth: 4,
	"4th": 4,
	last: -1,
};

export interface ParsedRepeat {
	rule: RepeatRule;
	/**
	 * The second reading of a bare hour 1–12 without am/pm (`rule` is the first): `rule` is 09:00 for "9",
	 * 12:00 for "12"; this is 21:00 and 00:00. Null when the time is certain or absent.
	 */
	other: RepeatRule | null;
}

interface Body {
	freq: RepeatRule["freq"];
	interval: number;
	weekdays: Weekday[] | null;
	monthly: MonthlyOn | null;
}

function weekdayOf(word: string): Weekday | undefined {
	return Object.hasOwn(DAY_OF, word) ? DAY_OF[word] : undefined;
}

/** "mon, wed and fri" → ["MO", "WE", "FR"]; null when a word is not a weekday. */
function weekdayList(text: string): Weekday[] | null {
	const out: Weekday[] = [];
	for (const word of text.split(/\s*,\s*(?:and\s+)?|\s+and\s+|\s*&\s*/u)) {
		const day = weekdayOf(word.trim());
		if (day === undefined) return null;
		if (!out.includes(day)) out.push(day);
	}
	return out.length === 0 ? null : out;
}

function interval(text: string): number | null {
	if (!/^\d+$/u.test(text)) return null;
	const n = Number(text);
	return n >= 1 && n <= MAX_INTERVAL ? n : null;
}

function dayOfMonth(text: string): number | null {
	const m = /^(?:the\s+|day\s+)?(\d{1,2})(?:st|nd|rd|th)?$/u.exec(text);
	const n = m === null ? NaN : Number(m[1]);
	return n >= 1 && n <= 31 ? n : null;
}

/** The part after "every ", lower case, single spaces, without the time. */
function parseBody(body: string): Body | null {
	if (body === "day") return { freq: "daily", interval: 1, weekdays: null, monthly: null };
	if (body === "weekday") return { freq: "weekly", interval: 1, weekdays: [...EVERY_WEEKDAY], monthly: null };
	if (body === "weekend") return { freq: "weekly", interval: 1, weekdays: ["SA", "SU"], monthly: null };
	if (body === "week") return { freq: "weekly", interval: 1, weekdays: null, monthly: null };
	if (body === "last day of month" || body === "last day of the month") {
		return { freq: "monthly", interval: 1, weekdays: null, monthly: { kind: "lastDay" } };
	}

	// "month", "other month", "3 months", each with an optional "on the 15th".
	const month = /^(?:(other)\s+|(\d+)\s*)?(months?)(?:\s+on\s+(.+))?$/u.exec(body);
	if (month !== null) {
		const prefixed = month[1] !== undefined || month[2] !== undefined;
		if (!prefixed && month[3] === "months") return null;
		const every = month[1] !== undefined ? 2 : month[2] !== undefined ? interval(month[2]) : 1;
		if (every === null) return null;
		let monthly: MonthlyOn | null = null;
		if (month[4] !== undefined) {
			const day = dayOfMonth(month[4]);
			if (day === null) return null;
			monthly = { kind: "day", day };
		}
		return { freq: "monthly", interval: every, weekdays: null, monthly };
	}

	// "other day|week", "other <weekday>" (every second week on that day).
	const other = /^other\s+(\S+)$/u.exec(body);
	if (other !== null) {
		if (other[1] === "day") return { freq: "daily", interval: 2, weekdays: null, monthly: null };
		if (other[1] === "week") return { freq: "weekly", interval: 2, weekdays: null, monthly: null };
		const day = weekdayOf(other[1]!);
		return day === undefined ? null : { freq: "weekly", interval: 2, weekdays: [day], monthly: null };
	}

	// "3 days", "2 weeks" ("N weekdays", "N weekends" and "N years" are not supported).
	const count = /^(\d+)\s*(days?|weeks?)$/u.exec(body);
	if (count !== null) {
		const every = interval(count[1]!);
		if (every === null) return null;
		return { freq: count[2]!.startsWith("day") ? "daily" : "weekly", interval: every, weekdays: null, monthly: null };
	}

	// "last friday", "first monday", "2nd tuesday", with an optional "of the month".
	const nth = /^(first|second|third|fourth|last|1st|2nd|3rd|4th)\s+(\S+?)(?:\s+of\s+the\s+month)?$/u.exec(body);
	if (nth !== null) {
		const day = weekdayOf(nth[2]!);
		const n = NTH_OF[nth[1]!];
		return day === undefined || n === undefined ? null : { freq: "monthly", interval: 1, weekdays: null, monthly: { kind: "nth", n, weekday: day } };
	}

	const days = weekdayList(body);
	return days === null ? null : { freq: "weekly", interval: 1, weekdays: days, monthly: null };
}

/** "9", "9:30pm", "5 p.m.", "17:00", "noon", "midnight" → "HH:mm" and whether the hour is ambiguous. */
function parseClock(text: string): { time: string; ambiguous: boolean } | null {
	if (text === "noon") return { time: "12:00", ambiguous: false };
	if (text === "midnight") return { time: "00:00", ambiguous: false };
	const m = /^(\d{1,2})(?::(\d{2}))?\s*(?:([ap])\.?m\.?)?$/u.exec(text);
	if (m === null) return null;
	const hour = Number(m[1]);
	const minute = m[2] === undefined ? 0 : Number(m[2]);
	if (minute > 59) return null;
	if (m[3] !== undefined) {
		if (hour < 1 || hour > 12) return null;
		return { time: `${pad2((hour % 12) + (m[3] === "p" ? 12 : 0))}:${pad2(minute)}`, ambiguous: false };
	}
	if (hour > 23) return null;
	// 0, 13–23 and "09:30" (a leading zero with minutes) are 24-hour writing; 1–12 could be either half of the day.
	const certain = hour === 0 || hour >= 13 || /^0\d:/u.test(text);
	return { time: `${pad2(hour)}:${pad2(minute)}`, ambiguous: !certain };
}

/**
 * The rule of a typed `every …` span, or null when the text is a form Quick Add does not build ("every
 * year", "every other weekday", a time that is not one). `zone` is the parse zone: the zone of an `at` time.
 */
export function parseRepeatText(text: string, zone: string): ParsedRepeat | null {
	const lower = collapseWhitespace(text.toLowerCase());
	if (!lower.startsWith("every ")) return null;
	let body = lower.slice("every ".length);
	let time: string | null = null;
	let ambiguous = false;
	const at = /^(.*?) at (.+)$/u.exec(body);
	if (at !== null) {
		const clock = parseClock(at[2]!);
		if (clock === null) return null;
		body = at[1]!;
		time = clock.time;
		ambiguous = clock.ambiguous;
	}
	const parsed = parseBody(body);
	if (parsed === null) return null;
	const rule = normalizeRepeatRule({ ...parsed, afterCompletion: false, time, tz: time === null ? null : zone });
	if (repeatRuleProblem(rule) !== null) return null;
	let other: RepeatRule | null = null;
	if (ambiguous && time !== null) {
		const hour = Number(time.slice(0, 2));
		const second = `${pad2(hour === 12 ? 0 : hour + 12)}${time.slice(2)}`;
		other = normalizeRepeatRule({ ...rule, time: second });
	}
	return { rule, other };
}
