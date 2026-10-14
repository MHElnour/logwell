import type { RepeatFreq } from "../domain/types";
import { wordBefore } from "./dates";
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
	RANGE_TO_PATTERN,
	DAY_PART_PATTERN,
	NUMBER_WORD_PATTERN,
	PERIOD_PATTERN,
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
	scanFor,
	sticky,
	tokenStartAllowed,
	withoutTrailingMarks,
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

export interface LiteralToken {
	span: Span;
	/** A word, token or phrase after a backslash: the backslash leaves the title. */
	escape: boolean;
}

/** The quote that closes each opening quote: straight and curly double quotes. */
const CLOSING_QUOTE: Readonly<Record<string, string>> = { '"': '"', "\u201c": "\u201d" };

/**
 * Text Quick Add never reads, found before every other token: a phrase in double quotes, straight or curly (kept in the
 * title with its quotes), and what a backslash at a token start escapes (the backslash leaves the title): the token
 * right after it (`\#Work`, `\!1`, `\@home`), or the word or note link right after it with the whole phrase it starts
 * (`\today`, `\[[Note]]`, `\by friday`, `\every monday`). `phraseEnd(from, limit)` is where the reading that starts at
 * `from` ends, before `limit` (the next backslash), or `from` when none starts there. A quote opens at a word start and closes before a word end; an
 * unclosed quote, a quote inside a word (`5" screen`) and single quotes are plain text.
 */
export function findLiteralTokens(s: string, taken: Taken, phraseEnd: (from: number, limit: number) => number): LiteralToken[] {
	const out: LiteralToken[] = [];
	// The next closing quote of each kind found so far, so every quote is looked for once.
	const next = new Map<string, number>();
	for (let i = 0; i < s.length; i++) {
		const ch = s.charAt(i);
		if (ch === "\\") {
			if (!tokenStartAllowed(s, i)) continue;
			const trigger = s.charAt(i + 1);
			const from = trigger === "#" || trigger === "@" || trigger === "!" ? i + 2 : s.startsWith("[[", i + 1) ? i + 3 : i + 1;
			let end = tokenRunEnd(s, from);
			if (end === from && from !== i + 3) continue;
			// A word or a note link may lead a longer phrase; only text after it can make the phrase longer.
			if (from !== i + 2) {
				const slash = s.indexOf("\\", end);
				const limit = slash === -1 ? s.length : slash;
				if (from === i + 3 || s.slice(end, limit).trim() !== "") end = Math.max(end, phraseEnd(i + 1, limit));
			}
			if (taken(i, end)) continue;
			out.push({ span: { start: i, end }, escape: true });
			i = end - 1;
			continue;
		}
		const close = CLOSING_QUOTE[ch];
		if (close === undefined || !wordBoundaryBefore(s, i)) continue;
		let j = next.get(close);
		if (j === undefined || (j !== -1 && j <= i)) {
			j = s.indexOf(close, i + 1);
			next.set(close, j);
		}
		if (j === -1 || isWordChar(charAt(s, j + 1)) || taken(i, j + 1)) continue;
		out.push({ span: { start: i, end: j + 1 }, escape: false });
		i = j;
	}
	return out;
}

/** `#name` or `@name` tokens. `accept` can reject a candidate (for example an invalid tag key), given its name and where its trigger is. */
export function findWordTokens(
	s: string,
	trigger: "#" | "@",
	taken: Taken,
	accept: (name: string, start: number) => boolean,
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
		if (taken(i, end) || !accept(name, i)) continue;
		out.push({ span: { start: i, end }, name });
		from = end;
	}
	return out;
}

// -- repeats ----------------------------------------------------------------------------------

/** The end of a typed repeat that follows it: `for N times`, or `for N <periods>` (N periods from the start). */
export interface RepeatCount {
	span: Span;
	count?: number;
	periods?: { n: number; freq: RepeatFreq };
}

interface RepeatToken {
	span: Span;
	/** A bare word ("daily", "mondays"): a repeat only at the end of the text, after title text (parse.ts decides). */
	bare: boolean;
	/** False for a repeat Quick Add cannot build ("every 3 hours"): it stays text with a notice, never a date. */
	supported: boolean;
	/** `each …` ("each monday"): repeat words Quick Add never reads; they stay title text with no chip, never a date. */
	silent: boolean;
	end: RepeatCount | null;
	/** "every year on …": the span ends with an "on" that leads into the start date, which must follow. */
	onDate: boolean;
	/** The end of a time range right after the repeat's time (`-6pm` in "every monday at 5pm-6pm"): title text, never read. */
	timeEnd: Span | null;
}

/**
 * `for N <periods>` or `for N times` from `from` on (the end of the first typed repeat): a repeat's end, never part
 * of a date ("every day starting Friday for 2 weeks"). Before a repeat it is title text ("Plan meals for 7 days every
 * sunday"); the parser keeps one only after a repeat it keeps. A comma before it goes with it.
 */
export function findRepeatCounts(s: string, from: number, taken: Taken): RepeatCount[] {
	return scanFor(
		s,
		from,
		(forAt) => {
			let at = forAt;
			while (at > from && isSpaceChar(charAt(s, at - 1))) at--;
			if (at > from && s[at - 1] === ",") {
				at--;
				while (at > from && isSpaceChar(charAt(s, at - 1))) at--;
			} else at = forAt;
			return repeatCountAt(s, at);
		},
		(found) => found.span,
		taken,
	);
}

const NOT_WORD_AFTER = "(?![\\p{L}\\p{N}])";

// -- the repeat grammar: the closed table of repeat phrases Quick Add reads; outside it nothing applies ------------
// A typed repeat is `every` + a form Quick Add builds (EVERY_RE) + an optional `at <time>`; a bare word (BARE_RE) is the
// same form without `every`. The phrase ends there: whatever follows (a comma, a date, a range, a time, a lead word,
// title text) is read by the date reader and the end logic. Two things make an `every …` unsupported, never a date: no
// form fits (the phrase is the run of repeat words after `every`: `every 3 hours`, `every May 5`, `every two weeks`), or
// a list word or `except` joins more repeat words to a form (a compound repeat: `every 2nd and 4th tuesday`, `every
// monday at 9 and friday at 5`, `every day except sunday`; a plain number alone is title text: `every day, 20 pages`).
// `repeatPhraseAt` is the one owner of that boundary.

const RANGE_DAY = `(?:${DAY_NUMBER_PATTERN}|\\d{1,2})`;
// A date the date reader reads: a month name ("Oct", "Oct 12") or a day and month ("12 Oct", "12th of Oct").
const DATE_START = `(?:${MONTH_PATTERN}|${RANGE_DAY}\\s+(?:of\\s+)?${MONTH_PATTERN})${NOT_WORD_AFTER}`;
// The first side of a date range ("Mon-Fri", "Oct 12 to Dec 1", "12 Oct - 1 Dec"): a range is never part of a repeat.
// Only the joins a range alone uses count: "until" and "till" lead a repeat's end ("every monday until Dec 1").
const RANGE_START =
	`(?:${WEEKDAY_PATTERN}|${MONTH_PATTERN}(?:\\s+${RANGE_DAY})?|${RANGE_DAY}(?:\\s+(?:of\\s+)?${MONTH_PATTERN})?)${NOT_WORD_AFTER}` +
	`${RANGE_TO_PATTERN}(?:${WEEKDAY_PATTERN}|${MONTH_PATTERN}|\\d)`;
const DATE_START_RE = new RegExp(DATE_START, "iyu");
const RANGE_START_RE = new RegExp(RANGE_START, "iyu");
// One day of a repeat's weekday list: a weekday that does not start a range (`every day Mon-Fri` is every day).
const DAY = `(?!${RANGE_START})${WEEKDAY_PATTERN}${NOT_WORD_AFTER}`;
// A range of weekdays opens a list ("every mon-fri", "every week on tue-thu"): every weekday from the first to the last.
const WEEKDAY_RANGE = `${WEEKDAY_PATTERN}${RANGE_TO_PATTERN}${WEEKDAY_PATTERN}${NOT_WORD_AFTER}`;
const DAY_FULL = `(?!${RANGE_START})${WEEKDAY_FULL_PATTERN}${NOT_WORD_AFTER}`;
const DAY_ABBR = `(?!${RANGE_START})${WEEKEND_ABBR_PATTERN}${NOT_WORD_AFTER}`;
const SEP = `(?:${LIST_SEP_PATTERN}|\\s+)`;
// Joined by plain spaces, `sat` and `sun` continue a list only when nothing but more weekdays, a time and punctuation
// follows ("every mon wed sat", not "every monday sun cream"); joined by a comma, "and" or "&", they always do.
const LIST_ENDS_HERE = `(?=(?:${SEP}${WEEKDAY_PATTERN})*(?:\\s+at\\s+${CLOCK_PATTERN})?[\\s\\p{P}]*$)`;
const WEEKDAY_LIST = `(?:${WEEKDAY_RANGE}|${DAY})(?:${LIST_SEP_PATTERN}${DAY}|\\s+${DAY_FULL}|\\s+${DAY_ABBR}${LIST_ENDS_HERE})*`;
const OF_MONTH = "\\s+of\\s+(?:the|each|every)\\s+month";
// "on the 15th", "on day 15", "on 15", "on the last day": the day of a monthly repeat; a bare number before a month
// name ("on 15 Oct") is a start date instead.
const MONTH_ON = `(?:\\s+on\\s+(?:(?:the\\s+|day\\s+)\\d{1,2}(?:st|nd|rd|th)?|${DAY_NUMBER_PATTERN}|\\d{1,2}(?!\\s+${MONTH_PATTERN}${NOT_WORD_AFTER})|the\\s+last\\s+day))?`;
// "every year on May 5", "yearly on May 5": the date after "on" is the start, read by the date reader.
const YEAR_ON = `(?:\\s+on(?:\\s+the)?(?=\\s+(?:${MONTH_PATTERN}|\\d)))?`;
// The day of the month, "15th of each month" or "15th"; not an ordinal before a unit or weekday ("every 2nd day" is an
// ordinal, "every 5th friday" a fifth weekday: neither fits a form; a range of weekdays after it is a range).
const DAY_OF_MONTH = `${DAY_NUMBER_PATTERN}(?:${OF_MONTH}|(?!\\s+(?:${UNIT_PATTERN}|${DAY})))`;
/** The forms Quick Add builds, in the order they are tried (the monthly forms before the periods, which stop at "month"). */
const EVERY_RE = new RegExp(
	"every\\s+(?:" +
		"last\\s+day\\s+of\\s+(?:the\\s+|each\\s+|every\\s+)?month" +
		`|${ORDINAL_PATTERN}\\s+${DAY}(?:${OF_MONTH})?` +
		`|${DAY_OF_MONTH}` +
		`|(?:(?:other\\s+)?month|\\d+\\s*months?)${MONTH_ON}` +
		`|(?:(?:other\\s+)?year|\\d+\\s*years?)${YEAR_ON}` +
		`|(?:(?:other\\s+)?week|\\d+\\s*weeks?)\\s+(?:on\\s+)?${WEEKDAY_LIST}` +
		`|other\\s+(?:${PERIOD_PATTERN}${NOT_WORD_AFTER}|${WEEKDAY_LIST})` +
		`|\\d+\\s*${PERIOD_PATTERN}s?` +
		`|${WEEKDAY_LIST}` +
		`|${DAY_PART_PATTERN}` +
		`|${PERIOD_PATTERN}` +
		`)${NOT_WORD_AFTER}`,
	"iyu",
);
// A time typed right after the form ("every monday at 9", "daily at 7") belongs to the repeat.
const EVERY_TIME_RE = new RegExp(`\\s+at\\s+${CLOCK_PATTERN}${NOT_WORD_AFTER}`, "iyu");
// The end of a time range after that time: the repeat takes the start, and the end stays title text ("every monday at
// 5pm-6pm", "every monday at 6pm to 7pm").
const TIME_END_RE = new RegExp(`${RANGE_TO_PATTERN}${CLOCK_PATTERN}${NOT_WORD_AFTER}`, "iyu");
// The same time as one word of a run of repeat words, where a list word may have taken the space before it.
const RUN_TIME_RE = new RegExp(`\\s*at\\s+${CLOCK_PATTERN}${NOT_WORD_AFTER}`, "iyu");
// `every <month> [<day>]` is a yearly repeat Quick Add does not build (write `every year on May 5`): the one phrase that
// starts with a month name. Elsewhere a month name is a date, never a repeat word.
const EVERY_MONTH_RE = new RegExp(`every\\s+(?!${RANGE_START})${MONTH_PATTERN}(?:\\s+${RANGE_DAY})?${NOT_WORD_AFTER}`, "iyu");
// A list word or "except" after a form: what joins a compound repeat ("every 2nd and 4th tuesday", "every monday & 2
// others", "every day except sunday").
const JOIN_RE = new RegExp(`${LIST_SEP_PATTERN}|\\s+except\\s+`, "iyu");
// The words of a repeat: a number, number word or ordinal, a weekday, a period or unit, a day part, "others"
// ("& 2 others").
const REPEAT_WORD_RE = new RegExp(`^(?:\\d+(?:st|nd|rd|th)?|${NUMBER_WORD_PATTERN}|${ORDINAL_PATTERN}|${WEEKDAY_PATTERN}|${UNIT_PATTERN}|${DAY_PART_PATTERN}s?|others)$`, "iu");
// A run of plain numbers and glue after a list word is title text, not a compound repeat ("every day, 20 pages").
const NUMBERS_ONLY_RE = new RegExp(`^(?:\\d+|${NUMBER_WORD_PATTERN}|and|of|the|each|every|other|[\\s,&])*$`, "iu");
// The small words between repeat words ("every 2nd and 4th tuesday of every month"); "other" and "every" may also lead
// the run ("every other 2nd tuesday", "every day and every week"). Not "on": it leads a date ("every 3 hours on Monday").
const GLUE: ReadonlySet<string> = new Set(["and", "&", ",", "of", "the", "each", "every", "other"]);
const GLUE_LEAD: ReadonlySet<string> = new Set(["other", "every"]);
// Without "every", anywhere in the text: the Nth weekday, the day or the last day of each or every month, and the last
// weekday or the last day of the month. Any other "… of the month" ("the 1st of the month") is title text.
const OF_EACH_MONTH =
	`(?:${ORDINAL_PATTERN}\\s+${WEEKDAY_PATTERN}|${DAY_NUMBER_PATTERN}|last\\s+day)\\s+of\\s+(?:each|every)\\s+month` +
	`|last\\s+(?:${WEEKDAY_PATTERN}|day)\\s+of\\s+the\\s+month`;
const ANYWHERE_RE = new RegExp(`(?:the\\s+)?(?:${OF_EACH_MONTH})${NOT_WORD_AFTER}`, "giu");
// The "every" of "the 2nd tuesday of every month" belongs to that phrase, not to an `every month` of its own.
const ANYWHERE_TAIL_RE = new RegExp(`(?:^|[^\\p{L}\\p{N}_])(?:${ORDINAL_PATTERN}\\s+${WEEKDAY_PATTERN}|${DAY_NUMBER_PATTERN}|last\\s+day)\\s+of\\s+$`, "iu");
// Without "every", at the end of the text (parse.ts): the bare words, each with what its `every …` form takes after it
// ("weekly on mon, fri", "weekly mon-fri", "monthly on the 15th", "yearly on <date>"), and the plural weekdays.
const BARE_RE = new RegExp(
	"(?:" +
		`weekly\\s+(?:on\\s+)?${WEEKDAY_LIST}` +
		`|monthly${MONTH_ON}` +
		`|(?:yearly|annually)${YEAR_ON}` +
		`|${BARE_REPEAT_PATTERN}` +
		`|${PLURAL_WEEKDAY_PATTERN}(?:${SEP}${PLURAL_WEEKDAY_PATTERN})*` +
		`)${NOT_WORD_AFTER}`,
	"giu",
);
// A form that ends with the "on" leading into its start date.
const ON_DATE_TAIL_RE = /\son(?:\sthe)?$/iu;
// An end right after the repeat; a comma before it goes with it ("daily, for 10 times").
const COUNT_RE = new RegExp(`(\\s*,)?\\s*(for\\s+(\\d+)\\s+times?)${NOT_WORD_AFTER}`, "iyu");
const PERIODS_RE = new RegExp(`(\\s*,)?\\s*(for\\s+(\\d+)\\s+(${PERIOD_UNIT_PATTERN}|${WEEKDAY_PATTERN}))${NOT_WORD_AFTER}`, "iyu");

/**
 * The end of the run of repeat words at `from` (over spaces), with the glue words between them and none at its end;
 * `from` when no repeat word comes first ("every time", "every chapter"; "other" and "every" may each lead once, so the
 * run after each `every` of "every every …" stops within two words). An `at <time>` after a repeat word is one more
 * ("every monday at 9 and friday at 5"). A date or a date range stops the run: the date reader reads them.
 */
function repeatWordsEnd(s: string, from: number, after = false): number {
	let i = from;
	let end = from;
	const leads = new Set<string>();
	for (;;) {
		// A time is one more word of the run only after a repeat word ("friday at 5", `after`: one came before `from`);
		// alone after a list word it is a time read on its own ("every day, at 7").
		const time = end > from || after ? sticky(RUN_TIME_RE, s, i) : null;
		if (time !== null) {
			i = end = i + time[0].length;
			continue;
		}
		let j = i;
		while (j < s.length && isSpaceChar(charAt(s, j))) j++;
		let k = j;
		if (s[j] === "," || s[j] === "&") k = j + 1;
		else while (k < s.length && isWordChar(charAt(s, k))) k += charAt(s, k).length;
		if (k === j || sticky(RANGE_START_RE, s, j) !== null || sticky(DATE_START_RE, s, j) !== null) break;
		const word = s.slice(j, k).toLowerCase();
		if (REPEAT_WORD_RE.test(word)) end = k;
		else if (end === from ? !GLUE_LEAD.has(word) || leads.has(word) : !GLUE.has(word)) break;
		else if (end === from) leads.add(word);
		i = k;
	}
	return end;
}

interface RepeatPhrase {
	end: number;
	supported: boolean;
	silent: boolean;
	/** "every year on …": the span ends with the "on" that leads into the start date. */
	onDate: boolean;
	/** The span ends with the repeat's time ("every monday at 9"). */
	timed: boolean;
}

/**
 * The typed repeat phrase whose `every` (or `each`) starts at `start`: where it ends and whether Quick Add builds it
 * (the grammar above). Null when the word leads no repeat word. `each …` is never built: its words are only taken.
 */
function repeatPhraseAt(s: string, start: number, word: string): RepeatPhrase | null {
	const body = start + word.length;
	if (!isSpaceChar(charAt(s, body))) return null;
	const phrase = (end: number, supported: boolean, onDate = false, timed = false): RepeatPhrase => ({ end, supported, silent: false, onDate, timed });
	if (word.toLowerCase() === "each") {
		const end = repeatWordsEnd(s, body);
		return end === body ? null : { end, supported: false, silent: true, onDate: false, timed: false };
	}
	const form = sticky(EVERY_RE, s, start);
	if (form === null) {
		const month = sticky(EVERY_MONTH_RE, s, start);
		const from = month === null ? body : start + month[0].length;
		const end = Math.max(from, repeatWordsEnd(s, from, month !== null));
		return end === body ? null : phrase(end, false);
	}
	let end = start + form[0].length;
	if (ON_DATE_TAIL_RE.test(form[0])) return phrase(end, true, true);
	const time = sticky(EVERY_TIME_RE, s, end);
	if (time !== null) end += time[0].length;
	const join = sticky(JOIN_RE, s, end);
	const joined = join === null ? end : end + join[0].length;
	const more = join === null ? end : repeatWordsEnd(s, joined);
	const compound = more > joined && !NUMBERS_ONLY_RE.test(s.slice(joined, more));
	return compound ? phrase(more, false) : phrase(end, true, false, time !== null);
}

/**
 * The end typed right after a repeat that ends at `from`: `for N times` (a count) or `for N days|weeks|months|years|
 * <weekdays>` (N periods from the start; a weekday counts as a week). Null when none follows.
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

/**
 * Typed repeats: `every …` (a form Quick Add builds, or any other run of repeat words, unsupported), `each …` (taken,
 * never read), the Nth weekday, the day or the last day of each month anywhere, and the bare words, each with its
 * time and the end typed right after it.
 */
export function findRecurrence(s: string, taken: Taken): RepeatToken[] {
	const out: RepeatToken[] = [];
	// The characters a token found so far (or the end typed after it) covers: each check reads only its own span.
	const covered = new Uint8Array(s.length);
	const free = (start: number, end: number): boolean => {
		if (taken(start, end)) return false;
		for (let i = start; i < end; i++) if (covered[i] === 1) return false;
		return true;
	};
	const push = (span: Span, bare: boolean, phrase: Pick<RepeatPhrase, "supported" | "silent" | "onDate" | "timed">): number => {
		const found = phrase.onDate || phrase.silent ? null : repeatCountAt(s, span.end);
		const end = found !== null && !taken(found.span.start, found.span.end) ? found : null;
		const range = end === null && phrase.timed ? sticky(TIME_END_RE, s, span.end) : null;
		const timeEnd = range !== null && free(span.end, span.end + range[0].length) ? { start: span.end, end: span.end + range[0].length } : null;
		out.push({ span, bare, supported: phrase.supported, silent: phrase.silent, end, onDate: phrase.onDate, timeEnd });
		covered.fill(1, span.start, timeEnd?.end ?? span.end);
		if (end !== null) covered.fill(1, end.span.start, end.span.end);
		return end?.span.end ?? timeEnd?.end ?? span.end;
	};
	const pushOn = (found: RegExpExecArray, bare: boolean): void => {
		let end = found.index + found[0].length;
		if (!wordBoundaryBefore(s, found.index)) return;
		const onDate = ON_DATE_TAIL_RE.test(found[0]);
		const time = onDate ? null : sticky(EVERY_TIME_RE, s, end);
		if (time !== null) end += time[0].length;
		if (!free(found.index, end)) return;
		// "on mondays", "on weekends", "on the last friday of the month": the "on" goes with the repeat; not "on daily".
		const on = bare && !/s$/iu.test(found[0]) ? -1 : wordBefore(s, found.index, "on");
		const start = on === -1 ? found.index : on;
		push({ start: free(start, end) ? start : found.index, end }, bare, { supported: true, silent: false, onDate, timed: time !== null });
	};

	// The `every` phrases first, so "every 2nd and 4th tuesday of every month" is one unsupported phrase; the "every" of
	// "the 2nd tuesday of every month" is left to that form below.
	const re = /every|each/giu;
	let m: RegExpExecArray | null;
	while ((m = re.exec(s)) !== null) {
		const start = m.index;
		if (!wordBoundaryBefore(s, start) || ANYWHERE_TAIL_RE.test(s.slice(Math.max(0, start - 40), start))) continue;
		const phrase = repeatPhraseAt(s, start, m[0]);
		if (phrase === null || !free(start, phrase.end)) continue;
		re.lastIndex = push({ start, end: phrase.end }, false, phrase);
	}

	for (const found of s.matchAll(ANYWHERE_RE)) pushOn(found, false);
	for (const found of s.matchAll(BARE_RE)) pushOn(found, true);
	return out.sort((a, b) => a.span.start - b.span.start);
}

export function findDurationTokens(s: string, taken: Taken): DurationToken[] {
	return findDurations(s, taken).map((d) => ({ span: { start: d.start, end: d.end }, minutes: d.minutes }));
}

/**
 * `!1 !2 !3 !high !medium !low` (case-insensitive) at the start of the text, after whitespace or after `(`, ending at
 * whitespace or the end of the text, without the marks that may follow it (`!1.`, `(!2)`). `Wow!`, `!important`,
 * `!4`, `a!1`, `!!1` and `!1x` are not priorities.
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
		end = withoutTrailingMarks(s, i + 1, end);
		const word = s.slice(i + 1, end).toLowerCase();
		const priority = Object.hasOwn(PRIORITY_WORDS, word) ? PRIORITY_WORDS[word] : undefined;
		if (priority === undefined || taken(i, end)) continue;
		out.push({ span: { start: i, end }, priority });
		from = end;
	}
	return out;
}
