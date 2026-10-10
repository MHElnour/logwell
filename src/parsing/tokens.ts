import { findDurations } from "./duration";
import type { Span } from "./types";
import { charAt, isSpaceChar, tokenRunEnd, tokenStartAllowed, wordBoundaryBefore } from "./text";

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

const WEEKDAY =
	"(?:mondays?|mon|tuesdays?|tues|tue|wednesdays?|wed|thursdays?|thurs|thur|thu|fridays?|fri|saturdays?|sat|sundays?|sun)";
const SEP = "(?:\\s*,\\s*(?:and\\s+)?|\\s+and\\s+|\\s*&\\s*)";
const PERIOD = "(?:weekday|weekend|week|month|year|day)";
const ORDINAL = "(?:first|second|third|fourth|last|1st|2nd|3rd|4th)";
// "on the 15th", "on day 15", "on 15": the day of the month of a monthly repeat.
const MONTH_ON = "(?:\\s+on\\s+(?:the\\s+|day\\s+)?\\d{1,2}(?:st|nd|rd|th)?)?";
const EVERY_RE = new RegExp(
	"every\\s+(?:" +
		// The monthly forms come before the generic periods, which would stop at "month".
		`last\\s+day\\s+of\\s+(?:the\\s+)?month` +
		`|${ORDINAL}\\s+${WEEKDAY}(?:\\s+of\\s+the\\s+month)?` +
		`|(?:(?:other\\s+)?month|\\d+\\s*months?)${MONTH_ON}` +
		`|other\\s+(?:${PERIOD}|${WEEKDAY})` +
		`|\\d+\\s*${PERIOD}s?` +
		`|${WEEKDAY}(?:${SEP}${WEEKDAY})*` +
		`|${PERIOD}` +
		")(?![\\p{L}\\p{N}])",
	"iyu",
);
// A time that belongs to the recurrence ("every monday at 9") stays in its chip.
const EVERY_TIME_RE = /\s+at\s+(?:\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?|noon|midnight)(?![\p{L}\p{N}])/iyu;

export function findRecurrence(s: string, taken: Taken): Span[] {
	const out: Span[] = [];
	const re = /every/giu;
	let m: RegExpExecArray | null;
	while ((m = re.exec(s)) !== null) {
		const start = m.index;
		if (!wordBoundaryBefore(s, start)) continue;
		EVERY_RE.lastIndex = start;
		const main = EVERY_RE.exec(s);
		if (!main) continue;
		let end = start + main[0].length;
		EVERY_TIME_RE.lastIndex = end;
		const time = EVERY_TIME_RE.exec(s);
		if (time) end += time[0].length;
		if (taken(start, end)) continue;
		out.push({ start, end });
		re.lastIndex = end;
	}
	return out;
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
