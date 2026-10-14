import { pad2 } from "../domain/time";
import { MONTH_LONG, MONTH_SHORT, type RepeatFreq, type Weekday } from "../domain/types";
import type { Span } from "./types";

// Small text helpers shared by the tokenizer and the cursor logic, and the parser's vocabulary. No regex
// lookbehind anywhere in this layer (iOS): boundaries are checked by hand.

const WORD_RE = /^[\p{L}\p{N}\p{M}_]$/u;
const SPACE_RE = /^\s$/u;
const TOKEN_CHAR_RE = /^[\p{L}\p{N}\p{M}_/-]$/u;

/** The code point that ends right before `index` ("" at the start). */
export function charBefore(s: string, index: number): string {
	if (index <= 0) return "";
	const low = s.charCodeAt(index - 1);
	if (index >= 2 && low >= 0xdc00 && low <= 0xdfff) {
		const high = s.charCodeAt(index - 2);
		if (high >= 0xd800 && high <= 0xdbff) return s.slice(index - 2, index);
	}
	return s.charAt(index - 1);
}

/** The code point that starts at `index` ("" at the end). */
export function charAt(s: string, index: number): string {
	if (index >= s.length) return "";
	const cp = s.codePointAt(index);
	return cp === undefined ? "" : String.fromCodePoint(cp);
}

export function isWordChar(ch: string): boolean {
	return ch !== "" && WORD_RE.test(ch);
}

export function isSpaceChar(ch: string): boolean {
	return ch !== "" && SPACE_RE.test(ch);
}

/** Letters, digits, marks, "_", "/" and "-": the characters of a # or @ token. */
export function isTokenChar(ch: string): boolean {
	return ch !== "" && TOKEN_CHAR_RE.test(ch);
}

/** True at the start of the text or after a character that is not part of a word. */
export function wordBoundaryBefore(s: string, index: number): boolean {
	return index <= 0 || !isWordChar(charBefore(s, index));
}

/** A match of the sticky (`y`) pattern `re` that starts exactly at `at`, or null. */
export function sticky(re: RegExp, s: string, at: number): RegExpExecArray | null {
	re.lastIndex = at;
	return re.exec(s);
}

/**
 * Every `for` at a word start from `from` on that `read` turns into a result, left to right: `read(at)` gets the index
 * of the `for` and returns what follows it (or null), `spanOf` gives the text it takes, and a result whose span is
 * `taken` is skipped. The scan resumes after each kept result. The one scanner of "for <duration>" and "for N times".
 */
export function scanFor<T>(
	s: string,
	from: number,
	read: (forAt: number) => T | null,
	spanOf: (found: T) => Span,
	taken: (start: number, end: number) => boolean,
): T[] {
	const out: T[] = [];
	const re = /for/giu;
	re.lastIndex = from;
	let m: RegExpExecArray | null;
	while ((m = re.exec(s)) !== null) {
		if (!wordBoundaryBefore(s, m.index)) continue;
		const found = read(m.index);
		if (found === null) continue;
		const span = spanOf(found);
		if (taken(span.start, span.end)) continue;
		out.push(found);
		re.lastIndex = span.end;
	}
	return out;
}

/**
 * `#`, `@`, `!` and a backslash start a token only at the start of the text or after whitespace, or right after
 * opening parentheses that themselves start there (`(#Work)`, `((#Work))`; not `print(#Work)`).
 */
export function tokenStartAllowed(s: string, index: number): boolean {
	let i = index;
	while (i > 0 && s.charAt(i - 1) === "(") i--;
	return i === 0 || isSpaceChar(charBefore(s, i));
}

/** A comma or a semicolon: beside a removed span it goes with it, even right after a word ("Call mom, tomorrow"). */
export const SEPARATOR_MARKS = ",;";

/** Sentence punctuation: the separators, a period, a colon, an exclamation or a question mark. */
export const SENTENCE_MARKS = `${SEPARATOR_MARKS}.:!?`;

/**
 * The marks a removed span may leave alone in the title, besides the separators: a period, a colon, an exclamation or
 * a question mark, a hyphen or an en dash ("Pay rent - tomorrow"). Not a closing bracket, which pairs with its
 * opening one.
 */
export const LONE_MARKS = ".:!?-\u2013";

/**
 * The marks that end a token without being part of it (`!1.`, `(!2)`, `@urgent!`): sentence punctuation and a closing
 * bracket. Not a hyphen or a dash, which a token name may hold (`#to-do`).
 */
const TRAILING_MARKS = `${SENTENCE_MARKS})]`;

/** Where a run of non-space text from `start` to `end` ends without its trailing marks. */
export function withoutTrailingMarks(s: string, start: number, end: number): number {
	let i = end;
	while (i > start && TRAILING_MARKS.includes(s.charAt(i - 1))) i--;
	return i;
}

/** The end of the run of token characters that starts at `from`. */
export function tokenRunEnd(s: string, from: number): number {
	let i = from;
	while (i < s.length) {
		const ch = charAt(s, i);
		if (!isTokenChar(ch)) break;
		i += ch.length;
	}
	return i;
}

/** The replacement for masked text. U+FFFC is not whitespace, so chrono cannot bridge it. */
export const MASK_CHAR = "\uFFFC";

// -- Parser vocabulary ---------------------------------------------------------------------
// The words the finders (tokens.ts, duration.ts) and the repeat grammar (recurrence.ts) share. Patterns are
// regex source without groups that capture; match them case-insensitively on lower-case or `i` regexes.

/** Every weekday word Quick Add reads, singular, plural and short ("mon", "tues", "thurs"), lower case. */
const WEEKDAY_WORDS: Readonly<Record<string, Weekday>> = {
	monday: "MO",
	mondays: "MO",
	mon: "MO",
	tuesday: "TU",
	tuesdays: "TU",
	tues: "TU",
	tue: "TU",
	wednesday: "WE",
	wednesdays: "WE",
	wed: "WE",
	thursday: "TH",
	thursdays: "TH",
	thurs: "TH",
	thur: "TH",
	thu: "TH",
	friday: "FR",
	fridays: "FR",
	fri: "FR",
	saturday: "SA",
	saturdays: "SA",
	sat: "SA",
	sunday: "SU",
	sundays: "SU",
	sun: "SU",
};

/** Longest first, so an alternation never stops at a prefix ("mon" in "mondays"). */
const alternation = (words: readonly string[]): string => `(?:${[...words].sort((a, b) => b.length - a.length).join("|")})`;

export const WEEKDAY_PATTERN = alternation(Object.keys(WEEKDAY_WORDS));

/** The plural weekdays ("mondays"): a bare repeat at the end of the text. */
export const PLURAL_WEEKDAY_PATTERN = alternation(Object.keys(WEEKDAY_WORDS).filter((w) => w.endsWith("days")));

/** `sat` and `sun` are also everyday words ("sun cream"): a list joined by plain spaces takes them only at the end. */
export const WEEKEND_ABBR_PATTERN = "(?:sat|sun)";

/** The weekday words other than `sat` and `sun`. */
export const WEEKDAY_FULL_PATTERN = alternation(Object.keys(WEEKDAY_WORDS).filter((w) => w !== "sat" && w !== "sun"));

/** The bare words that repeat at the end of the text, and the `every …` form each stands for. */
export const BARE_REPEAT_WORDS: Readonly<Record<string, string>> = {
	daily: "day",
	weekly: "week",
	fortnightly: "other week",
	monthly: "month",
	quarterly: "quarter",
	yearly: "year",
	annually: "year",
	weekdays: "weekday",
	workdays: "weekday",
	weekends: "weekend",
};

export const BARE_REPEAT_PATTERN = alternation(Object.keys(BARE_REPEAT_WORDS));

/** "every morning" and the other day parts: a plain daily repeat. */
export const DAY_PART_PATTERN = "(?:morning|afternoon|evening|night)";

/**
 * The periods `every <period>` repeats by, with the frequency of the ones a repeat can also end after (`for 2 weeks`);
 * null for the periods that are a form of their own (`every weekday`, `every quarter`).
 */
const PERIOD_WORDS: Readonly<Record<string, RepeatFreq | null>> = {
	day: "daily",
	week: "weekly",
	month: "monthly",
	year: "yearly",
	weekday: null,
	workday: null,
	weekend: null,
	quarter: null,
};

/** The other time units a typed repeat may name; Quick Add builds none of them ("every 3 hours"). */
const OTHER_UNIT_WORDS = ["fortnight", "hour", "hr", "minute", "min", "second", "sec"];

/** Every period word, singular: "day", "week", "weekday", "quarter". */
export const PERIOD_PATTERN = alternation(Object.keys(PERIOD_WORDS));

/** Every period or unit word, singular or plural: "days", "hours", "mins". */
export const UNIT_PATTERN = `${alternation([...Object.keys(PERIOD_WORDS), ...OTHER_UNIT_WORDS])}s?`;

/** The periods a repeat can end after: "days", "weeks", "months", "years". */
export const PERIOD_UNIT_PATTERN = `${alternation(Object.keys(PERIOD_WORDS).filter((w) => PERIOD_WORDS[w] !== null))}s?`;

/** The frequency of a period word ("weeks" → weekly), or null. */
export function unitFreq(word: string): RepeatFreq | null {
	const w = word.toLowerCase().replace(/s$/u, "");
	return Object.hasOwn(PERIOD_WORDS, w) ? PERIOD_WORDS[w]! : null;
}

/**
 * Number words and the ordinals past "fourth": repeat words Quick Add never reads as a count ("every two weeks",
 * "every fifth friday" are not supported), so they are never a date either.
 */
export const NUMBER_WORD_PATTERN = "(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifth|sixth|seventh|eighth|ninth|tenth)";

/** The weekday a word names, or undefined. */
export function weekdayWord(word: string): Weekday | undefined {
	const w = word.toLowerCase();
	return Object.hasOwn(WEEKDAY_WORDS, w) ? WEEKDAY_WORDS[w] : undefined;
}

/** The Nth weekday of a month: 1 to 4, or -1 for the last. */
export const ORDINAL_WORDS: Readonly<Record<string, 1 | 2 | 3 | 4 | -1>> = {
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

export const ORDINAL_PATTERN = alternation(Object.keys(ORDINAL_WORDS));

/** Month names and their short forms ("may", "sept"), from the one English name table. */
export const MONTH_PATTERN = alternation([...new Set([...MONTH_LONG, ...MONTH_SHORT, "sept"].map((m) => m.toLowerCase()))]);

/** What joins the items of a list: a comma (", and"), "and" or "&". Plain spaces are the caller's choice. */
export const LIST_SEP_PATTERN = "(?:\\s*,\\s*(?:and\\s+)?|\\s+and\\s+|\\s*&\\s*)";

/** The joins only a range uses, with the spaces around them: "-", an en dash, "to" or "through" ("Mon-Fri", "Oct 12 to Dec 1"). */
export const RANGE_TO_PATTERN = "\\s*(?:\\b(?:to|through)\\b|[-\\u2013])\\s*";

/**
 * What joins the two sides of a date range, as chrono's range merge does (ENMergeDateRangeRefiner): RANGE_TO_PATTERN
 * plus "until" and "till", which under a typed repeat also lead its end ("every monday until Dec 1").
 */
export const RANGE_JOIN_PATTERN = "\\s*(?:\\b(?:to|until|till|through)\\b|[-\\u2013])\\s*";

/** A day of the month written with its suffix: "1st", "15th", "22nd". */
export const DAY_NUMBER_PATTERN = "\\d{1,2}(?:st|nd|rd|th)";

/** The day of a "15th", "the 15th", "day 15" or "15": 1 to 31, else null. */
export function dayNumber(text: string): number | null {
	const m = /^(?:the\s+|day\s+)?(\d{1,2})(?:st|nd|rd|th)?$/iu.exec(text.trim());
	const n = m === null ? NaN : Number(m[1]);
	return n >= 1 && n <= 31 ? n : null;
}

/** A clock time: "9", "9:30pm", "5 p.m.", "17:00", "noon", "midnight". */
export const CLOCK_PATTERN = "(?:\\d{1,2}(?::\\d{2})?\\s*(?:[ap]\\.?m\\.?)?|noon|midnight)";

// A clock time `@` reads instead of a tag name: an hour with am or pm ("4pm", "4:30pm") or "noon".
const AT_CLOCK_RE = /(?:\d{1,2}(?::\d{2})?[ap]m|noon)(?![\p{L}\p{N}_])/iuy;

/** The length of the clock time `@` reads at `at` ("4pm", "4:30pm", "noon"), or 0 when none starts there. */
export function atClockLength(s: string, at: number): number {
	const m = sticky(AT_CLOCK_RE, s, at);
	return m !== null && readClock(m[0]) !== null ? m[0].length : 0;
}

// `at` and a 24-hour time of four digits, hours 00 to 23 and minutes 00 to 59 ("at 0900", "at 1730"); the end of a
// range after it may be one too ("at 0900-1000", "at 0900 to 1700").
const AT_HHMM_RE = /at\s+([01]\d|2[0-3])([0-5]\d)(?![\p{L}\p{N}_:])/giu;
const HHMM_END_RE = new RegExp(`${RANGE_TO_PATTERN}([01]\\d|2[0-3])([0-5]\\d)(?![\\p{L}\\p{N}_:])`, "iuy");

/** A 24-hour time as the readers read it: "9:00am", "12:30pm", "12:00am". */
const twelveHour = (hour: number, minute: string): string => `${hour % 12 === 0 ? 12 : hour % 12}:${minute}${hour < 12 ? "am" : "pm"}`;

/**
 * The text the repeat and date readers see in place of the input: `@` before a clock time `@` reads (`atClockLength`)
 * is `at ` ("@4pm" reads "at 4pm"), and a four-digit 24-hour time after `at` (and the end of its range) is the same
 * time with am or pm ("at 0900" reads "at 9:00am"). So both read exactly as `at` that time does, after a date, in a
 * repeat and in a range. `free(start, end)` says which input text may be rewritten (not a token found before). The
 * readers' spans come back to the input with `toInput`.
 */
export interface Reading {
	text: string;
	/** The input index of a reading index; inside rewritten text, the start of what it replaced, or its end with `end`. */
	toInput: (index: number, end?: boolean) => number;
	/** The reading index of an input index; inside replaced text, the start of its rewrite, or its end with `end`. */
	toReading: (index: number, end?: boolean) => number;
}

export function readingOf(s: string, free: (start: number, end: number) => boolean): Reading {
	// Each rewrite: the input text [from, to) is `text`. Found left to right, never overlapping.
	const pieces: { from: number; to: number; text: string }[] = [];
	for (let i = s.indexOf("@"); i !== -1; i = s.indexOf("@", i + 1)) {
		const length = tokenStartAllowed(s, i) ? atClockLength(s, i + 1) : 0;
		if (length > 0 && free(i, i + 1 + length)) pieces.push({ from: i, to: i + 1, text: "at " });
	}
	for (const m of s.matchAll(AT_HHMM_RE)) {
		const from = m.index + m[0].length - 4;
		if (!wordBoundaryBefore(s, m.index) || !free(m.index, from + 4)) continue;
		pieces.push({ from, to: from + 4, text: twelveHour(Number(m[1]), m[2]!) });
		const end = sticky(HHMM_END_RE, s, from + 4);
		if (end !== null && free(from + 4, from + 4 + end[0].length)) {
			const to = from + 4 + end[0].length;
			pieces.push({ from: to - 4, to, text: twelveHour(Number(end[1]), end[2]!) });
		}
	}
	if (pieces.length === 0) {
		const same = (index: number): number => index;
		return { text: s, toInput: same, toReading: same };
	}
	pieces.sort((a, b) => a.from - b.from);
	// The reading's index of each piece's start.
	const at: number[] = [];
	let text = "";
	let last = 0;
	for (const p of pieces) {
		text += s.slice(last, p.from);
		at.push(text.length);
		text += p.text;
		last = p.to;
	}
	text += s.slice(last);
	// Maps an index on one side (pieces from `startOf` to `endOf`) to the other (`otherStart` to `otherEnd`), by the last
	// piece that starts at or before it (a binary search).
	const through = (index: number, end: boolean, startOf: (k: number) => number, endOf: (k: number) => number, otherStart: (k: number) => number, otherEnd: (k: number) => number): number => {
		let lo = 0;
		let hi = pieces.length - 1;
		let k = -1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if (startOf(mid) <= index) {
				k = mid;
				lo = mid + 1;
			} else hi = mid - 1;
		}
		if (k === -1) return index;
		if (index === startOf(k)) return otherStart(k);
		if (index < endOf(k)) return end ? otherEnd(k) : otherStart(k);
		return otherEnd(k) + (index - endOf(k));
	};
	const inStart = (k: number): number => pieces[k]!.from;
	const inEnd = (k: number): number => pieces[k]!.to;
	const rdStart = (k: number): number => at[k]!;
	const rdEnd = (k: number): number => at[k]! + pieces[k]!.text.length;
	return {
		text,
		toInput: (index, end = false) => through(index, end, rdStart, rdEnd, inStart, inEnd),
		toReading: (index, end = false) => through(index, end, inStart, inEnd, rdStart, rdEnd),
	};
}

/** The units of a planned duration: "h", "hrs", "hours", "m", "mins", "minutes". */
export const DURATION_UNIT_PATTERN = "(?:hours?|hrs?|h|minutes?|mins?|m)";

/** A clock time as "HH:mm", and whether its hour could be either half of the day (1 to 12 without am or pm). */
export function readClock(text: string): { time: string; ambiguous: boolean } | null {
	const t = text.trim().toLowerCase();
	if (t === "noon") return { time: "12:00", ambiguous: false };
	if (t === "midnight") return { time: "00:00", ambiguous: false };
	const m = /^(\d{1,2})(?::(\d{2}))?\s*(?:([ap])\.?m\.?)?$/u.exec(t);
	if (m === null) return null;
	const hour = Number(m[1]);
	const minute = m[2] === undefined ? 0 : Number(m[2]);
	if (minute > 59) return null;
	if (m[3] !== undefined) {
		if (hour < 1 || hour > 12) return null;
		return { time: `${pad2((hour % 12) + (m[3] === "p" ? 12 : 0))}:${pad2(minute)}`, ambiguous: false };
	}
	if (hour > 23) return null;
	// 0, 13\u201323 and "09:30" (a leading zero with minutes) are 24-hour writing; 1\u201312 could be either half of the day.
	const certain = hour === 0 || hour >= 13 || /^0\d:/u.test(t);
	return { time: `${pad2(hour)}:${pad2(minute)}`, ambiguous: !certain };
}
