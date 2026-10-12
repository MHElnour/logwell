import type { RepeatFreq } from "../domain/types";
import { findDurations } from "./duration";
import type { Span } from "./types";
import {
	CLOCK_PATTERN,
	DAY_NUMBER_PATTERN,
	LIST_SEP_PATTERN,
	MONTH_PATTERN,
	ORDINAL_PATTERN,
	PLURAL_WEEKDAY_PATTERN,
	BARE_REPEAT_PATTERN,
	DAY_PART_PATTERN,
	PERIOD_UNIT_PATTERN,
	UNIT_PATTERN,
	WEEKDAY_FULL_PATTERN,
	WEEKEND_ABBR_PATTERN,
	unitFreq,
	WEEKDAY_PATTERN,
	charAt,
	isSpaceChar,
	isWordChar,
	tokenRunEnd,
	tokenStartAllowed,
	wordBoundaryBefore,
} from "./text";

// Plugin tokens (step 1 of the pipeline in parse.ts): [[note]], #category, @tag,
// "every …" and "for <duration>". Each finder returns spans only; the parser
// decides what they mean.

export interface NoteToken {
	span: Span;
	/** The text to resolve: the part before "|" and "#", trimmed. */
	linktext: string;
}

export interface WordToken {
	span: Span;
	/** The token text without its trigger. */
	name: string;
}

export interface DurationToken {
	span: Span;
	minutes: number;
}

export interface PriorityToken {
	span: Span;
	priority: 1 | 2 | 3;
}

const PRIORITY_WORDS: Readonly<Record<string, 1 | 2 | 3>> = { "1": 1, "2": 2, "3": 3, high: 1, medium: 2, low: 3 };

type Taken = (start: number, end: number) => boolean;

/** Splits "[[Note#Heading|alias]]" content into the link target. */
function linktextOf(content: string): string {
	const bar = content.indexOf("|");
	const head = bar === -1 ? content : content.slice(0, bar);
	const hash = head.indexOf("#");
	return (hash === -1 ? head : head.slice(0, hash)).trim();
}

export function findNoteTokens(s: string, taken: Taken): NoteToken[] {
	const out: NoteToken[] = [];
	let pos = 0;
	for (;;) {
		const open = s.indexOf("[[", pos);
		if (open === -1) break;
		const close = s.indexOf("]]", open + 2);
		if (close === -1) break;
		const inner = s.indexOf("[[", open + 2);
		const content = s.slice(open + 2, close);
		if ((inner !== -1 && inner < close) || content.includes("\n")) {
			pos = open + 1;
			continue;
		}
		const linktext = linktextOf(content);
		const end = close + 2;
		if (linktext === "" || taken(open, end)) {
			pos = open + 1;
			continue;
		}
		out.push({ span: { start: open, end }, linktext });
		pos = end;
	}
	return out;
}

/** `#name` or `@name` tokens. `accept` can reject a candidate (for example an invalid tag key). */
export function findWordTokens(
	s: string,
	trigger: "#" | "@",
	taken: Taken,
	accept: (name: string) => boolean,
): WordToken[] {
	const out: WordToken[] = [];
	let from = 0;
	for (;;) {
		const i = s.indexOf(trigger, from);
		if (i === -1) break;
		from = i + 1;
		if (!tokenStartAllowed(s, i)) continue;
		const end = tokenRunEnd(s, i + 1);
		if (end === i + 1) continue;
		const name = s.slice(i + 1, end);
		if (taken(i, end) || !accept(name)) continue;
		out.push({ span: { start: i, end }, name });
		from = end;
	}
	return out;
}

// -- repeats ----------------------------------------------------------------------------------

/** The end of a typed repeat that follows it: `(for) N times`, or `for N <periods>` (N periods from the start). */
export interface RepeatCount {
	span: Span;
	count?: number;
	periods?: { n: number; freq: RepeatFreq };
}

export interface RepeatToken {
	span: Span;
	/** A bare word ("daily", "mondays"): a repeat only at the end of the text, after title text (parse.ts decides). */
	bare: boolean;
	/** False for a repeat Quick Add cannot build ("every 3 hours"): it stays text with a notice, never a date. */
	supported: boolean;
	end: RepeatCount | null;
}

const NOT_WORD_AFTER = "(?![\\p{L}\\p{N}])";
const SEP = `(?:${LIST_SEP_PATTERN}|\\s+)`;
// Joined by plain spaces, `sat` and `sun` continue a list only when nothing but more weekdays, a time and punctuation
// follows ("every mon wed sat", not "every monday sun cream"); joined by a comma, "and" or "&", they always do.
const LIST_ENDS_HERE = `(?=(?:${SEP}${WEEKDAY_PATTERN})*(?:\\s+at\\s+${CLOCK_PATTERN})?[\\s\\p{P}]*$)`;
const WEEKDAY_LIST =
	`${WEEKDAY_PATTERN}(?:${LIST_SEP_PATTERN}${WEEKDAY_PATTERN}${NOT_WORD_AFTER}` +
	`|\\s+${WEEKDAY_FULL_PATTERN}${NOT_WORD_AFTER}|\\s+${WEEKEND_ABBR_PATTERN}${NOT_WORD_AFTER}${LIST_ENDS_HERE})*`;
const PERIOD = "(?:weekday|weekend|week|month|year|day)";
const OF_MONTH = "\\s+of\\s+(?:the|each|every)\\s+month";
// "on the 15th", "on day 15", "on 15": the day of the month of a monthly repeat.
const MONTH_ON = "(?:\\s+on\\s+(?:the\\s+|day\\s+)?\\d{1,2}(?:st|nd|rd|th)?)?";
const EVERY_RE = new RegExp(
	"every\\s+(?:" +
		// The monthly forms come before the generic periods, which would stop at "month".
		"last\\s+day\\s+of\\s+(?:the\\s+|each\\s+|every\\s+)?month" +
		`|${ORDINAL_PATTERN}\\s+${WEEKDAY_PATTERN}(?:${OF_MONTH})?` +
		`|${DAY_NUMBER_PATTERN}(?:${OF_MONTH})?` +
		`|(?:(?:other\\s+)?month|\\d+\\s*months?)${MONTH_ON}` +
		// "every year on May 5": the date after "on" is the start, read by the date reader.
		`|(?:(?:other\\s+)?year|\\d+\\s*years?)(?:\\s+on(?=\\s+(?:${MONTH_PATTERN}|\\d)))?` +
		`|(?:(?:other\\s+)?week|\\d+\\s*weeks?)\\s+(?:on\\s+)?${WEEKDAY_LIST}` +
		`|other\\s+(?:${PERIOD}${NOT_WORD_AFTER}|${WEEKDAY_LIST})` +
		`|\\d+\\s*${PERIOD}s?` +
		`|${WEEKDAY_LIST}` +
		`|${DAY_PART_PATTERN}` +
		`|${PERIOD}` +
		`)${NOT_WORD_AFTER}`,
	"iyu",
);
// A time that belongs to the recurrence ("every monday at 9") stays in its chip.
const EVERY_TIME_RE = new RegExp(`\\s+at\\s+${CLOCK_PATTERN}${NOT_WORD_AFTER}`, "iyu");
// "on mondays", "on the last friday of the month": the "on" goes with the repeat.
const ON_BEFORE_RE = /(?:^|[^\p{L}\p{N}_])(on\s+)$/iu;
const EVERY_BEFORE_RE = /(?:^|[^\p{L}\p{N}_])every\s+$/iu;
// Without "every": the Nth weekday of the month counts anywhere, the bare words only at the end (parse.ts).
const NTH_OF_MONTH_RE = new RegExp(`(?:the\\s+)?${ORDINAL_PATTERN}\\s+${WEEKDAY_PATTERN}${OF_MONTH}${NOT_WORD_AFTER}`, "giu");
const BARE_RE = new RegExp(`(?:${BARE_REPEAT_PATTERN}|${PLURAL_WEEKDAY_PATTERN}(?:${SEP}${PLURAL_WEEKDAY_PATTERN})*)${NOT_WORD_AFTER}`, "giu");
// An end right after the repeat; a comma before it goes with it ("daily, for 10 times").
const COUNT_RE = new RegExp(`(\\s*,)?\\s+((?:for\\s+)?(\\d+)\\s+times?)${NOT_WORD_AFTER}`, "iyu");
const PERIODS_RE = new RegExp(`(\\s*,)?\\s+(for\\s+(\\d+)\\s+(${PERIOD_UNIT_PATTERN}|${WEEKDAY_PATTERN}))${NOT_WORD_AFTER}`, "iyu");

// The words of a repeat Quick Add cannot build yet (Tasks and Quick Add rule 40): a number, ordinal, weekday,
// period or unit, day part or month name, and the small words between them.
const REPEAT_WORD_RE = new RegExp(
	`^(?:\\d+(?:st|nd|rd|th)?|${ORDINAL_PATTERN}|${WEEKDAY_PATTERN}|${MONTH_PATTERN}|${UNIT_PATTERN}|${DAY_PART_PATTERN}s?)$`,
	"iu",
);
// More repeat words right after a form make it one Quick Add cannot build: joined ("every 2nd and 4th tuesday") or
// a weekday, day or unit next to it ("every 3 days monday", "every 2nd day", "every month 15th").
const JOINED_RE = new RegExp(LIST_SEP_PATTERN, "iyu");
const MORE_AFTER_RE = new RegExp(`\\s+(?:${UNIT_PATTERN}|${WEEKDAY_FULL_PATTERN}|${DAY_NUMBER_PATTERN})${NOT_WORD_AFTER}`, "iyu");
const CONNECTORS: ReadonlySet<string> = new Set(["and", "&", ",", "of", "the", "each", "every", "on", "other"]);

function sticky(re: RegExp, s: string, at: number): RegExpExecArray | null {
	re.lastIndex = at;
	return re.exec(s);
}

/**
 * The end of the run of repeat words that starts at `from` (after spaces), with the small words between them and
 * none at its end; `from` when no repeat word comes first ("every time", "every chapter"; "other" may lead).
 */
function repeatWordsEnd(s: string, from: number): number {
	let i = from;
	let end = from;
	let first = true;
	for (;;) {
		let j = i;
		while (j < s.length && isSpaceChar(charAt(s, j))) j++;
		if (j >= s.length) break;
		let k = j;
		if (s[j] === "," || s[j] === "&") k = j + 1;
		else while (k < s.length && isWordChar(charAt(s, k))) k += charAt(s, k).length;
		if (k === j) break;
		const word = s.slice(j, k).toLowerCase();
		if (REPEAT_WORD_RE.test(word)) end = k;
		else if (!(end === from ? first && word === "other" : CONNECTORS.has(word))) break;
		first = false;
		i = k;
	}
	return end;
}

/** Whether more repeat words follow at `at`. */
function moreAt(s: string, at: number): boolean {
	return sticky(JOINED_RE, s, at) !== null || sticky(MORE_AFTER_RE, s, at) !== null;
}

/**
 * The end typed right after a repeat that ends at `from`: `(for) N times` (a count) or `for N days|weeks|months|
 * years|<weekdays>` (N periods from the start; a weekday counts as a week). Null when none follows.
 */
export function repeatCountAt(s: string, from: number): RepeatCount | null {
	const count = sticky(COUNT_RE, s, from);
	const periods = count === null ? sticky(PERIODS_RE, s, from) : null;
	const m = count ?? periods;
	if (m === null) return null;
	const end = from + m[0].length;
	// The span starts at the comma when there is one, else at the words.
	const start = m[1] !== undefined ? from + m[0].indexOf(",") : end - m[2]!.length;
	if (count !== null) return { span: { start, end }, count: Number(m[3]) };
	return { span: { start, end }, periods: { n: Number(m[3]), freq: unitFreq(m[4]!) ?? "weekly" } };
}

/** `start`, moved back over an "on" right before it. */
function withOn(s: string, start: number): number {
	const on = ON_BEFORE_RE.exec(s.slice(Math.max(0, start - 20), start));
	return on === null ? start : start - on[1]!.length;
}

/**
 * Typed repeats: `every …` (a form Quick Add builds, or any other run of repeat words, unsupported), the Nth
 * weekday of the month anywhere, and the bare words, each with the end typed right after it.
 */
export function findRecurrence(s: string, taken: Taken): RepeatToken[] {
	const out: RepeatToken[] = [];
	const free = (start: number, end: number): boolean =>
		!taken(start, end) && !out.some((t) => (t.span.start < end && start < t.span.end) || (t.end !== null && t.end.span.start < end && start < t.end.span.end));
	const push = (span: Span, bare: boolean, supported: boolean): number => {
		const found = repeatCountAt(s, span.end);
		const end = found !== null && !taken(found.span.start, found.span.end) ? found : null;
		out.push({ span, bare, supported, end });
		return end === null ? span.end : end.span.end;
	};
	const pushOn = (found: RegExpExecArray, bare: boolean): void => {
		const end = found.index + found[0].length;
		if (!wordBoundaryBefore(s, found.index) || !free(found.index, end)) return;
		// "on mondays", "on weekends", "on the last friday of the month"; not "on daily".
		const start = bare && !/s$/iu.test(found[0]) ? found.index : withOn(s, found.index);
		push({ start: free(start, end) ? start : found.index, end }, bare, true);
	};

	// First, so "the 2nd tuesday of every month" is not read as "every month"; "every 2nd tuesday of the month" is
	// the `every` form below.
	for (const found of s.matchAll(NTH_OF_MONTH_RE)) {
		if (!EVERY_BEFORE_RE.test(s.slice(Math.max(0, found.index - 40), found.index))) pushOn(found, false);
	}

	const re = /every/giu;
	let m: RegExpExecArray | null;
	while ((m = re.exec(s)) !== null) {
		const start = m.index;
		const body = start + "every".length;
		if (!wordBoundaryBefore(s, start) || !isSpaceChar(charAt(s, body))) continue;
		const main = sticky(EVERY_RE, s, start);
		let end: number;
		let supported: boolean;
		if (main === null) {
			end = repeatWordsEnd(s, body);
			supported = false;
			if (end === body) continue;
		} else {
			// A form followed by more repeat words ("every 2nd and 4th tuesday", "every monday at 7 wednesday") is not
			// that form: the whole run is unsupported, never a date.
			end = start + main[0].length;
			let wide = moreAt(s, end) ? repeatWordsEnd(s, body) : end;
			if (wide === end) {
				const time = sticky(EVERY_TIME_RE, s, end);
				if (time !== null) end += time[0].length;
				wide = moreAt(s, end) ? repeatWordsEnd(s, end) : end;
			}
			supported = wide === end;
			end = wide;
		}
		if (!free(start, end)) continue;
		re.lastIndex = push({ start, end }, false, supported);
	}

	for (const found of s.matchAll(BARE_RE)) pushOn(found, true);
	return out.sort((a, b) => a.span.start - b.span.start);
}

export function findDurationTokens(s: string, taken: Taken): DurationToken[] {
	return findDurations(s, taken).map((d) => ({ span: { start: d.start, end: d.end }, minutes: d.minutes }));
}

/**
 * `!1 !2 !3 !high !medium !low` (case-insensitive) at the start of the text or after
 * whitespace, ending at whitespace or the end of the text. `Wow!`, `!important`, `!4`, `a!1`,
 * `!!1` and `!1x` are not priorities.
 */
export function findPriorityTokens(s: string, taken: Taken): PriorityToken[] {
	const out: PriorityToken[] = [];
	let from = 0;
	for (;;) {
		const i = s.indexOf("!", from);
		if (i === -1) break;
		from = i + 1;
		if (!tokenStartAllowed(s, i)) continue;
		let end = i + 1;
		while (end < s.length && !isSpaceChar(charAt(s, end))) end += charAt(s, end).length;
		const word = s.slice(i + 1, end).toLowerCase();
		const priority = Object.hasOwn(PRIORITY_WORDS, word) ? PRIORITY_WORDS[word] : undefined;
		if (priority === undefined || taken(i, end)) continue;
		out.push({ span: { start: i, end }, priority });
		from = end;
	}
	return out;
}
