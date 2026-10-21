import { normalizeTagKey } from "../domain/tags";
import { collapseWhitespace } from "../domain/text";
import { isValidLocalDate } from "../domain/time";
import { PRIORITY_NAME, type LocalDate, type Priority } from "../domain/types";
import type { Quadrant, StatusFilter } from "../domain/queries";

// The source text of a `logwell` code block. One filter per line, `key: value`. Pure: it only
// reads the text. Names (list, section, tag) are not resolved here; the domain matcher does that.

/** A span of days as `YYYY-MM-DD`, both days included; one day has `from` equal to `to`. */
export interface BlockDateRange {
	from: LocalDate;
	to: LocalDate;
}

/** The values `due:` and `scheduled:` accept: a word, or a typed date or range (`DD-MM-YYYY`). */
export type BlockDate = "today" | "overdue" | "this-week" | "next-7-days" | BlockDateRange;

/** The filters a block holds. A key that is absent (or had an error) leaves its field undefined. */
export interface BlockFilters {
	/** `status:`; undefined lists open tasks, as `open` does. */
	status?: StatusFilter;
	/** A list name as typed (trimmed). */
	list?: string;
	/** A section name as typed; only set together with `list`. */
	section?: string;
	/** The tag names as typed, without a leading "@", repeats dropped; a task matches any of them. */
	tags?: string[];
	/** The deadline day. */
	due?: BlockDate;
	/** The schedule day (a repeating task's current occurrence). */
	scheduled?: BlockDate;
	/** One or more priorities (0 none, 1 high, 2 medium, 3 low); a task matches any of them. */
	priorities?: Priority[];
	/** One or more quadrants; a task matches any of them. */
	quadrants?: Quadrant[];
	/** `linked: this note`: the task's description note is the note holding the block. */
	linked?: boolean;
}

export interface BlockParse {
	filters: BlockFilters;
	/** User-facing messages, in source order; empty when the block is valid. */
	errors: string[];
}

const KEYS = ["status", "list", "section", "tag", "due", "scheduled", "priority", "quadrant", "linked"] as const;
type Key = (typeof KEYS)[number];

const DATE_VALUES: Readonly<Record<string, BlockDate>> = {
	today: "today",
	overdue: "overdue",
	"this week": "this-week",
	"next 7 days": "next-7-days",
};

const STATUS_VALUES: Readonly<Record<string, StatusFilter>> = { open: "open", completed: "completed", all: "all" };

const PRIORITY_VALUES: Readonly<Record<string, Priority>> = { high: 1, medium: 2, low: 3, none: 0 };

// The matrix order: 1 is urgent and important, 2 important, 3 urgent, 4 neither (QUADRANT_ORDER).
const QUADRANT_VALUES: Readonly<Record<string, Quadrant>> = {
	"1": "urgent-important",
	"2": "important",
	"3": "urgent",
	"4": "neither",
	"urgent and important": "urgent-important",
	"important not urgent": "important",
	"urgent not important": "urgent",
	neither: "neither",
};

/** A block has to name which tasks to show: at least one of these must be written (`section` needs a `list` anyway). */
const NARROWING_KEYS: readonly Key[] = ["list", "tag", "due", "scheduled", "linked"];
const NARROWING_ERROR = "Add a list, tag, due, scheduled or linked line to choose which tasks to show.";

const own = (table: object, key: string): boolean => Object.prototype.hasOwnProperty.call(table, key);

const DATE_RANGE_ERROR = "Use today, overdue, this week, next 7 days, a date like 20-10-2026, or a range like 01-10-2026 to 15-10-2026.";
// One date or `<date> to <date>`, two-digit day and month; `value` is already collapsed and lowercased.
const TYPED_DATE_RE = /^(\d{2})-(\d{2})-(\d{4})(?: to (\d{2})-(\d{2})-(\d{4}))?$/;

/** The typed day, month and year as a valid `YYYY-MM-DD`, else null. */
function isoOf(day: string, month: string, year: string): LocalDate | null {
	const date = `${year}-${month}-${day}`;
	return isValidLocalDate(date) ? date : null;
}

/** `DD-MM-YYYY` or `<DD-MM-YYYY> to <DD-MM-YYYY>` (the end not before the start), else null. */
function readTypedDates(value: string): BlockDateRange | null {
	const m = TYPED_DATE_RE.exec(value);
	if (m === null) return null;
	const from = isoOf(m[1]!, m[2]!, m[3]!);
	const to = m[4] === undefined ? from : isoOf(m[4], m[5]!, m[6]!);
	return from === null || to === null || to < from ? null : { from, to };
}

/** A day as typed in a block: `YYYY-MM-DD` to `DD-MM-YYYY`. */
function typedDay(date: LocalDate): string {
	return `${date.slice(8)}-${date.slice(5, 7)}-${date.slice(0, 4)}`;
}

/** Lowercased with runs of whitespace collapsed to one space, for matching a keyword value. */
function keyword(value: string): string {
	return collapseWhitespace(value.toLowerCase());
}

/** A comma list: items trimmed, lowercased and collapsed; an empty item is reported by the caller. */
function splitList(value: string): string[] {
	return value.split(",").map(keyword);
}

function isKey(key: string): key is Key {
	return (KEYS as readonly string[]).includes(key);
}

/**
 * Reads a comma list through `table`. Returns the mapped values (duplicates dropped, typed order kept) or
 * the messages for the values the table does not know.
 */
function readList<T>(value: string, table: Readonly<Record<string, T>>, noun: string, allowed: string): { values: T[]; errors: string[] } {
	const values: T[] = [];
	const errors: string[] = [];
	const originals = value.split(",").map((v) => v.trim());
	splitList(value).forEach((item, i) => {
		if (!own(table, item)) {
			errors.push(`Unknown ${noun} \u201c${originals[i]}\u201d. Use ${allowed}.`);
			return;
		}
		const mapped = table[item] as T;
		if (!values.includes(mapped)) values.push(mapped);
	});
	return { values, errors };
}

/**
 * Reads the `tag:` list: items trimmed, a leading "@" dropped, a repeat (the same tag key) dropped with the first typing
 * kept. Returns null when an item is empty.
 */
function readTags(value: string): string[] | null {
	const tags: string[] = [];
	for (const raw of value.split(",")) {
		const name = raw.replace(/^\s*@/, "").trim();
		if (name === "") return null;
		if (!tags.some((t) => normalizeTagKey(t) === normalizeTagKey(name))) tags.push(name);
	}
	return tags;
}

/**
 * Parses the source of a `logwell` block. Keys are case-insensitive; blank lines are ignored. Every
 * problem (unknown or duplicate key, bad value, `section` without `list`, no `list`, `tag`, `due`, `scheduled`
 * or `linked` line) adds one message and the offending line is left out of `filters`.
 */
export function parseBlockQuery(source: string): BlockParse {
	const filters: BlockFilters = {};
	const errors: string[] = [];
	const seen = new Set<Key>();
	let sectionLine = false;

	for (const raw of source.split(/\r?\n/)) {
		const line = raw.trim();
		if (line === "") continue;
		const colon = line.indexOf(":");
		if (colon < 0) {
			errors.push(`Expected \u201ckey: value\u201d, got \u201c${line}\u201d.`);
			continue;
		}
		const typedKey = line.slice(0, colon).trim();
		const key = typedKey.toLowerCase();
		const value = line.slice(colon + 1).trim();
		if (!isKey(key)) {
			errors.push(`Unknown filter \u201c${typedKey}\u201d.`);
			continue;
		}
		if (seen.has(key)) {
			errors.push(`Duplicate filter \u201c${key}\u201d.`);
			continue;
		}
		seen.add(key);
		const name = key === "tag" ? value.replace(/^@/, "").trim() : value;
		if (name === "") {
			errors.push(`The \u201c${key}\u201d filter needs a value.`);
			continue;
		}
		switch (key) {
			case "status": {
				const word = keyword(value);
				if (own(STATUS_VALUES, word)) filters.status = STATUS_VALUES[word];
				else errors.push(`Unknown status value “${value}”. Use open, completed or all.`);
				break;
			}
			case "list":
				filters.list = value;
				break;
			case "section":
				sectionLine = true;
				filters.section = value;
				break;
			case "tag": {
				const tags = readTags(value);
				if (tags !== null) filters.tags = tags;
				else errors.push(`A tag name is missing in \u201c${value}\u201d.`);
				break;
			}
			case "due":
			case "scheduled": {
				const word = keyword(value);
				const date = own(DATE_VALUES, word) ? DATE_VALUES[word] : readTypedDates(word);
				if (date !== undefined && date !== null) filters[key] = date;
				else errors.push(`Unknown ${key} value \u201c${value}\u201d. ${DATE_RANGE_ERROR}`);
				break;
			}
			case "priority": {
				const r = readList(value, PRIORITY_VALUES, "priority", "high, medium, low or none");
				if (r.errors.length > 0) errors.push(...r.errors);
				else filters.priorities = r.values;
				break;
			}
			case "quadrant": {
				const allowed = "1 to 4, urgent and important, important not urgent, urgent not important or neither";
				const r = readList(value, QUADRANT_VALUES, "quadrant", allowed);
				if (r.errors.length > 0) errors.push(...r.errors);
				else filters.quadrants = r.values;
				break;
			}
			case "linked":
				if (keyword(value) === "this note") filters.linked = true;
				else errors.push(`Unknown linked value \u201c${value}\u201d. Use this note.`);
				break;
		}
	}

	// A section belongs to a list. Checked last so the order of the two lines does not matter.
	if (sectionLine && filters.list === undefined) {
		errors.push("section needs a list filter.");
		delete filters.section;
	} else if (!NARROWING_KEYS.some((key) => seen.has(key))) {
		// A line with a bad value counts: its own message says what to fix. The section message above already covers a lone section.
		errors.push(NARROWING_ERROR);
	}
	return { filters, errors };
}

const DATE_TEXT: Readonly<Record<Exclude<BlockDate, BlockDateRange>, string>> = { today: "today", overdue: "overdue", "this-week": "this week", "next-7-days": "next 7 days" };

/** A date filter as typed: the word, `DD-MM-YYYY`, or `DD-MM-YYYY to DD-MM-YYYY`. */
function dateText(value: BlockDate): string {
	if (typeof value === "string") return DATE_TEXT[value];
	return value.from === value.to ? typedDay(value.from) : `${typedDay(value.from)} to ${typedDay(value.to)}`;
}
const QUADRANT_TEXT: Readonly<Record<Quadrant, string>> = {
	"urgent-important": "urgent and important",
	important: "important not urgent",
	urgent: "urgent not important",
	neither: "neither",
};

/**
 * The header chips of a block: one `key: value` text per filter that parsed, in a fixed order, with the
 * values normalized (so "THIS  WEEK" reads "this week" and quadrant 1 reads "urgent and important").
 * Feeding the chips back through `parseBlockQuery` gives the same filters.
 */
export function describeBlockFilters(filters: BlockFilters): string[] {
	const chips: string[] = [];
	if (filters.status !== undefined) chips.push(`status: ${filters.status}`);
	if (filters.list !== undefined) chips.push(`list: ${filters.list}`);
	if (filters.section !== undefined) chips.push(`section: ${filters.section}`);
	if (filters.tags !== undefined) chips.push(`tag: ${filters.tags.join(", ")}`);
	if (filters.due !== undefined) chips.push(`due: ${dateText(filters.due)}`);
	if (filters.scheduled !== undefined) chips.push(`scheduled: ${dateText(filters.scheduled)}`);
	if (filters.priorities !== undefined) chips.push(`priority: ${filters.priorities.map((p) => PRIORITY_NAME[p]).join(", ")}`);
	if (filters.quadrants !== undefined) chips.push(`quadrant: ${filters.quadrants.map((q) => QUADRANT_TEXT[q]).join(", ")}`);
	if (filters.linked === true) chips.push("linked: this note");
	return chips;
}
