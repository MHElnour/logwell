import { collapseWhitespace } from "../domain/text";
import { PRIORITY_NAME, type Priority } from "../domain/types";
import type { Quadrant } from "../domain/queries";

// The source text of a `logwell` code block. One filter per line, `key: value`. Pure: it only
// reads the text. Names (list, section, tag) are not resolved here; the domain matcher does that.

/** The values `due:` and `scheduled:` accept. */
export type BlockDate = "today" | "overdue" | "this-week" | "next-7-days";

/** The filters a block holds. A key that is absent (or had an error) leaves its field undefined. */
export interface BlockFilters {
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

const KEYS = ["list", "section", "tag", "due", "scheduled", "priority", "quadrant", "linked"] as const;
type Key = (typeof KEYS)[number];

const DATE_VALUES: Readonly<Record<string, BlockDate>> = {
	today: "today",
	overdue: "overdue",
	"this week": "this-week",
	"next 7 days": "next-7-days",
};

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

const own = (table: object, key: string): boolean => Object.prototype.hasOwnProperty.call(table, key);

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
 * Reads the `tag:` list: items trimmed, a leading "@" dropped, a repeat (ignoring case) dropped with the first typing
 * kept. Returns null when an item is empty.
 */
function readTags(value: string): string[] | null {
	const tags: string[] = [];
	for (const raw of value.split(",")) {
		const name = raw.replace(/^\s*@/, "").trim();
		if (name === "") return null;
		if (!tags.some((t) => t.toLowerCase() === name.toLowerCase())) tags.push(name);
	}
	return tags;
}

/**
 * Parses the source of a `logwell` block. Keys are case-insensitive; blank lines are ignored. Every
 * problem (unknown or duplicate key, bad value, `section` without `list`) adds one message and the
 * offending line is left out of `filters`.
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
				const date = own(DATE_VALUES, keyword(value)) ? DATE_VALUES[keyword(value)] : undefined;
				if (date !== undefined) filters[key] = date;
				else errors.push(`Unknown ${key} value \u201c${value}\u201d. Use today, overdue, this week or next 7 days.`);
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
	}
	return { filters, errors };
}

const DATE_TEXT: Readonly<Record<BlockDate, string>> = { today: "today", overdue: "overdue", "this-week": "this week", "next-7-days": "next 7 days" };
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
	if (filters.list !== undefined) chips.push(`list: ${filters.list}`);
	if (filters.section !== undefined) chips.push(`section: ${filters.section}`);
	if (filters.tags !== undefined) chips.push(`tag: ${filters.tags.join(", ")}`);
	if (filters.due !== undefined) chips.push(`due: ${DATE_TEXT[filters.due]}`);
	if (filters.scheduled !== undefined) chips.push(`scheduled: ${DATE_TEXT[filters.scheduled]}`);
	if (filters.priorities !== undefined) chips.push(`priority: ${filters.priorities.map((p) => PRIORITY_NAME[p]).join(", ")}`);
	if (filters.quadrants !== undefined) chips.push(`quadrant: ${filters.quadrants.map((q) => QUADRANT_TEXT[q]).join(", ")}`);
	if (filters.linked === true) chips.push("linked: this note");
	return chips;
}
