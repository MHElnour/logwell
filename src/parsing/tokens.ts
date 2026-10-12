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
const WEEKDAY_LIST = `${WEEKDAY_PATTERN}(?:${SEP}${WEEKDAY_PATTERN})*`;
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
		`|(?:(?:other\\s+)?week|\\d+\\s*weeks?)\\s+on\\s+${WEEKDAY_LIST}` +
		`|other\\s+(?:${PERIOD}|${WEEKDAY_PATTERN})` +
		`|\\d+\\s*${PERIOD}s?` +
		`|${WEEKDAY_LIST}` +
		"|morning|afternoon|evening|night" +
		`|${PERIOD}` +
		`)${NOT_WORD_AFTER}`,
	"iyu",
);
// A time that belongs to the recurrence ("every monday at 9") stays in its chip.
const EVERY_TIME_RE = new RegExp(`\\s+at\\s+${CLOCK_PATTERN}${NOT_WORD_AFTER}`, "iyu");
// Without "every": the Nth weekday of the month counts anywhere, the bare words only at the end (parse.ts).
const EVERY_BEFORE_RE = /(?:^|[^\p{L}\p{N}_])every\s+$/iu;
const NTH_OF_MONTH_RE = new RegExp(`(?:the\\s+)?${ORDINAL_PATTERN}\\s+${WEEKDAY_PATTERN}${OF_MONTH}${NOT_WORD_AFTER}`, "giu");
const BARE_RE = new RegExp(
	`(?:daily|weekly|fortnightly|monthly|yearly|annually|weekdays|weekends|${PLURAL_WEEKDAY_PATTERN}(?:${SEP}${PLURAL_WEEKDAY_PATTERN})*)${NOT_WORD_AFTER}`,
	"giu",
);
const COUNT_RE = new RegExp(`(?:\\s*,\\s*|\\s+)((?:for\\s+)?(\\d{1,3})\\s+times?)${NOT_WORD_AFTER}`, "iyu");
const PERIODS_RE = new RegExp(`(?:\\s*,\\s*|\\s+)(for\\s+(\\d{1,3})\\s+(days?|weeks?|months?|years?|${WEEKDAY_PATTERN}))${NOT_WORD_AFTER}`, "iyu");

// The words of a repeat Quick Add cannot build yet (Tasks and Quick Add rule 40): a number, ordinal, weekday,
// period, day part, hour or minute, or month name, and the small words between them.
const REPEAT_WORD_RE = new RegExp(
	`^(?:\\d+(?:st|nd|rd|th)?|${ORDINAL_PATTERN}|${WEEKDAY_PATTERN}|${MONTH_PATTERN}` +
		"|days?|weeks?|weekdays?|weekends?|fortnights?|months?|years?|quarters?|mornings?|afternoons?|evenings?|nights?" +
		"|hours?|hrs?|minutes?|mins?|seconds?|secs?)$",
	"iu",
);
// A period or unit right after a repeat makes it one Quick Add cannot build ("every 2nd day").
const UNIT_AFTER_RE = /\s+(?:days?|weeks?|weekdays?|weekends?|fortnights?|months?|years?|hours?|hrs?|minutes?|mins?|seconds?|secs?)(?![\p{L}\p{N}])/iyu;
const JOINED_RE = new RegExp(LIST_SEP_PATTERN, "iyu");
const CONNECTORS: ReadonlySet<string> = new Set(["and", "&", ",", "of", "the", "each", "every", "on", "other"]);

function sticky(re: RegExp, s: string, at: number): RegExpExecArray | null {
	re.lastIndex = at;
	return re.exec(s);
}

/**
 * The end of the run of repeat words that starts at `from` (after spaces), with the small words between them and
 * none at its end; `from` when the first word is not a repeat word ("every time", "every chapter").
 */
function repeatWordsEnd(s: string, from: number): number {
	let i = from;
	let end = from;
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
		else if (end === from || !CONNECTORS.has(word)) break;
		i = k;
	}
	return end;
}

/**
 * The end typed right after a repeat that ends at `from`: `(for) N times` (a count) or `for N days|weeks|months|
 * years|<weekdays>` (N periods from the start; a weekday counts as a week). Null when none follows.
 */
export function repeatCountAt(s: string, from: number): RepeatCount | null {
	const count = sticky(COUNT_RE, s, from);
	if (count !== null) {
		const end = from + count[0].length;
		return { span: { start: end - count[1]!.length, end }, count: Number(count[2]) };
	}
	const periods = sticky(PERIODS_RE, s, from);
	if (periods === null) return null;
	const unit = periods[3]!.toLowerCase();
	const freq: RepeatFreq = unit.startsWith("day") ? "daily" : unit.startsWith("month") ? "monthly" : unit.startsWith("year") ? "yearly" : "weekly";
	const end = from + periods[0].length;
	return { span: { start: end - periods[1]!.length, end }, periods: { n: Number(periods[2]), freq } };
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

	// First, so "the 2nd tuesday of every month" is not read as "every month"; "every 2nd tuesday of the month" is
	// the `every` form below.
	for (const found of s.matchAll(NTH_OF_MONTH_RE)) {
		const span = { start: found.index, end: found.index + found[0].length };
		if (wordBoundaryBefore(s, span.start) && !EVERY_BEFORE_RE.test(s.slice(Math.max(0, span.start - 40), span.start)) && free(span.start, span.end)) {
			push(span, false, true);
		}
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
			end = start + main[0].length;
			supported = true;
			// A form followed by more repeat words ("every 2nd and 4th tuesday", "every 2nd day") is not that form.
			const more = sticky(JOINED_RE, s, end) !== null || sticky(UNIT_AFTER_RE, s, end) !== null;
			const wide = more ? repeatWordsEnd(s, body) : end;
			if (wide > end) {
				end = wide;
				supported = false;
			} else {
				const time = sticky(EVERY_TIME_RE, s, end);
				if (time !== null) end += time[0].length;
			}
		}
		if (!free(start, end)) continue;
		re.lastIndex = push({ start, end }, false, supported);
	}

	for (const found of s.matchAll(BARE_RE)) {
		const span = { start: found.index, end: found.index + found[0].length };
		if (wordBoundaryBefore(s, span.start) && free(span.start, span.end)) push(span, true, true);
	}
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
