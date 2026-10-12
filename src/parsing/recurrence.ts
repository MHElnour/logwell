import { EVERY_WEEKDAY, MAX_INTERVAL, normalizeRepeatRule, repeatRuleProblem } from "../domain/recurrence";
import { collapseWhitespace } from "../domain/text";
import { pad2 } from "../domain/time";
import type { MonthlyOn, RepeatRule, Weekday } from "../domain/types";
import { BARE_REPEAT_WORDS, DAY_PART_PATTERN, LIST_SEP_PATTERN, ORDINAL_WORDS, dayNumber, readClock, weekdayWord } from "./text";

// Quick Add repeats. The tokenizer (tokens.ts) finds the span; this file turns its text into a RepeatRule.
// Pure; no chrono, no clock.
//
// Conventions (the engine and the picker rely on them):
// - `weekly` with `weekdays: null` ("every week") means the anchor's weekday; `monthly: null` ("every
//   month") means the anchor's day of month; `yearly` always takes the anchor's month and day. The engine reads
//   them that way, so the parser needs no anchor.
// - "every <weekday>" names its weekdays ("every friday" is `["FR"]`, whatever the anchor is).
// - "At <time>" sets `time` ("HH:mm") and `tz` (the parse zone). A bare hour 1–12 without am/pm is
//   ambiguous (09:00 or 21:00): `rule` has the first reading and `other` the second, and Quick Add offers both
//   as a choice, like "at 5" in a date.
// - A bare word ("daily", "mondays", "last friday of the month") reads like its `every …` form.
// - The end of a series is its own token (tokens.ts repeatCountAt, dates.ts LEADS); after completion is picker-only.

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

const LIST_SPLIT_RE = new RegExp(`${LIST_SEP_PATTERN}|\\s+`, "u");

/** "mon, wed and fri", "mon wed fri" → ["MO", "WE", "FR"]; null when a word is not a weekday. */
function weekdayList(text: string): Weekday[] | null {
	const out: Weekday[] = [];
	for (const word of text.split(LIST_SPLIT_RE)) {
		const day = weekdayWord(word.trim());
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

/** The interval of "other", "3" or nothing (1), or null for a number out of range. */
function every(other: string | undefined, count: string | undefined): number | null {
	return other !== undefined ? 2 : count !== undefined ? interval(count) : 1;
}

const plain = (freq: RepeatRule["freq"], n: number): Body => ({ freq, interval: n, weekdays: null, monthly: null });

const DAY_PART_RE = new RegExp(`^${DAY_PART_PATTERN}$`, "u");

/** The part after "every ", lower case, single spaces, without the time. */
function parseBody(body: string): Body | null {
	if (body === "day" || DAY_PART_RE.test(body)) return plain("daily", 1);
	if (body === "weekday") return { freq: "weekly", interval: 1, weekdays: [...EVERY_WEEKDAY], monthly: null };
	if (body === "weekend") return { freq: "weekly", interval: 1, weekdays: ["SA", "SU"], monthly: null };
	if (body === "week") return plain("weekly", 1);
	if (/^last day of (?:the |each |every )?month$/u.test(body)) {
		return { freq: "monthly", interval: 1, weekdays: null, monthly: { kind: "lastDay" } };
	}

	// "month", "other month", "3 months", each with an optional "on the 15th".
	const month = /^(?:(other)\s+|(\d+)\s*)?(months?)(?:\s+on\s+(.+))?$/u.exec(body);
	if (month !== null) {
		const prefixed = month[1] !== undefined || month[2] !== undefined;
		if (!prefixed && month[3] === "months") return null;
		const n = every(month[1], month[2]);
		if (n === null) return null;
		let monthly: MonthlyOn | null = null;
		if (month[4] !== undefined) {
			const day = dayNumber(month[4]);
			if (day === null) return null;
			monthly = { kind: "day", day };
		}
		return { freq: "monthly", interval: n, weekdays: null, monthly };
	}

	// "year", "other year", "3 years"; a trailing "on" leads into the typed date ("every year on May 5").
	const year = /^(?:(other)\s+|(\d+)\s*)?(years?)(?: on(?: the)?)?$/u.exec(body);
	if (year !== null) {
		if (year[1] === undefined && year[2] === undefined && year[3] === "years") return null;
		const n = every(year[1], year[2]);
		return n === null ? null : plain("yearly", n);
	}

	// "week on mon, fri", "2 weeks on tue thu", "other week on monday", "2 weeks tuesday".
	const weekOn = /^(?:(other)\s+|(\d+)\s*)?(weeks?)\s+(?:on\s+)?(.+)$/u.exec(body);
	if (weekOn !== null) {
		if (weekOn[1] === undefined && weekOn[2] === undefined && weekOn[3] === "weeks") return null;
		const n = every(weekOn[1], weekOn[2]);
		const days = weekdayList(weekOn[4]!);
		return n === null || days === null ? null : { freq: "weekly", interval: n, weekdays: days, monthly: null };
	}

	// "other day|week", "other <weekdays>" (every second week on those days).
	const other = /^other\s+(.+)$/u.exec(body);
	if (other !== null) {
		if (other[1] === "day") return plain("daily", 2);
		if (other[1] === "week") return plain("weekly", 2);
		const days = weekdayList(other[1]!);
		return days === null ? null : { freq: "weekly", interval: 2, weekdays: days, monthly: null };
	}

	// "3 days", "2 weeks" ("N weekdays" and "N weekends" are not supported).
	const count = /^(\d+)\s*(days?|weeks?)$/u.exec(body);
	if (count !== null) {
		const n = interval(count[1]!);
		if (n === null) return null;
		return plain(count[2]!.startsWith("day") ? "daily" : "weekly", n);
	}

	// "last friday", "first monday", "2nd tuesday", with an optional "of the/each/every month".
	const nth = /^(\S+)\s+(\S+?)(?:\s+of\s+(?:the|each|every)\s+month)?$/u.exec(body);
	if (nth !== null && Object.hasOwn(ORDINAL_WORDS, nth[1]!)) {
		const day = weekdayWord(nth[2]!);
		return day === undefined ? null : { freq: "monthly", interval: 1, weekdays: null, monthly: { kind: "nth", n: ORDINAL_WORDS[nth[1]!]!, weekday: day } };
	}

	// "15th", "1st of the month": that day of every month.
	const dayOf = /^(\d{1,2}(?:st|nd|rd|th))(?:\s+of\s+(?:the|each|every)\s+month)?$/u.exec(body);
	if (dayOf !== null) {
		const day = dayNumber(dayOf[1]!);
		return day === null ? null : { freq: "monthly", interval: 1, weekdays: null, monthly: { kind: "day", day } };
	}

	const days = weekdayList(body);
	return days === null ? null : { freq: "weekly", interval: 1, weekdays: days, monthly: null };
}

/** The `every …` body of a typed span: the text after "every", or what a bare form stands for. */
function bodyOf(text: string): string {
	if (text.startsWith("every ")) return text.slice("every ".length);
	// "mondays and fridays", "the 2nd tuesday of the month", "on mondays": the "on" goes with the repeat.
	const bare = text.replace(/^on (?:the )?|^the /u, "");
	return Object.hasOwn(BARE_REPEAT_WORDS, bare) ? BARE_REPEAT_WORDS[bare]! : bare;
}

/**
 * The rule of a typed repeat span (`every …`, or a bare form tokens.ts found), or null when the text is a form
 * Quick Add does not build ("every other weekday", a time that is not one). `zone` is the parse zone: the zone
 * of an `at` time.
 */
export function parseRepeatText(text: string, zone: string): ParsedRepeat | null {
	let body = bodyOf(collapseWhitespace(text.toLowerCase()));
	let time: string | null = null;
	let ambiguous = false;
	const at = /^(.*?) at (.+)$/u.exec(body);
	if (at !== null) {
		const clock = readClock(at[2]!);
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
