import { DomainError } from "./errors";
import { compareSortKeys } from "./sortKey";
import { type Category, type ID, INBOX_ID, TAG_COLORS, type Task } from "./types";

// Pure task and category rules.

const MAX_TITLE_LENGTH = 500;
/** The longest estimate a task may have, in minutes (a day). */
export const MAX_DURATION_MIN = 1440;

/** The title is required and nonempty after trimming. */
export function requireTitle(raw: string): string {
	const title = raw.normalize("NFC").trim();
	if (title.length === 0) {
		throw new DomainError("TitleRequired", "A task needs a title.");
	}
	return title.slice(0, MAX_TITLE_LENGTH);
}

export function categoryNameKey(name: string): string {
	return name.normalize("NFC").trim().toLowerCase();
}

/** The order of the lists after the Inbox: by sort key, then by ID (lists can share a key after a merge import). */
export function compareCategories(a: Category, b: Category): number {
	return compareSortKeys(a.sortKey, b.sortKey) || compareSortKeys(a.id, b.id);
}

/** The lists in sidebar order, the order every list picker shows: Inbox first, then the others by `compareCategories`. */
export function listsInSidebarOrder(categories: Iterable<Category>): Category[] {
	let inbox: Category | undefined;
	const rest: Category[] = [];
	for (const c of categories) {
		if (c.id === INBOX_ID) inbox = c;
		else rest.push(c);
	}
	rest.sort(compareCategories);
	return inbox === undefined ? rest : [inbox, ...rest];
}

/** A Lucide icon name (lists, habits). */
const ICON_NAME_RE = /^[a-z0-9-]{1,40}$/;

/** An icon is a Lucide name; the icon already stored (`current`) is accepted unchanged, so a legacy emoji can be kept. */
export function requireIconName(icon: string | null, current: string | null | undefined): void {
	if (icon !== null && icon !== current && !ICON_NAME_RE.test(icon)) {
		throw new DomainError("InvalidValue", "An icon name uses lowercase letters, digits and hyphens (up to 40).");
	}
}

/** A list or habit color is one of the palette, or null for the default. Returns the color it was given. */
export function requireColor<T extends string | null>(color: T): T {
	if (color !== null && !(TAG_COLORS as readonly string[]).includes(color)) {
		throw new DomainError("InvalidValue", "That color is not available.");
	}
	return color;
}

/** A list name with case, spaces, "-" and "_" ignored (NFC): the looser half of `resolveListName`. */
function looseListKey(name: string): string {
	return name.normalize("NFC").toLowerCase().replace(/[\s_-]+/gu, "");
}

/** What a typed list name stands for: one list, none, or several that it cannot tell apart. */
export type ListNameMatch<T> = { kind: "one"; list: T } | { kind: "none" } | { kind: "several"; lists: T[] };

/**
 * The one rule for a list typed by hand (Quick Add `#list`, the `list:` filter of a task block): the exact name
 * ignoring case first (`categoryNameKey`), else ignoring case, spaces, "-" and "_". Several lists that match only
 * the loose way are `several`, in the order given; a name of only those characters never matches loosely.
 */
export function resolveListName<T extends { readonly name: string }>(lists: Iterable<T>, typed: string): ListNameMatch<T> {
	const all = [...lists];
	const exactKey = categoryNameKey(typed);
	const exact = all.find((c) => categoryNameKey(c.name) === exactKey);
	if (exact !== undefined) return { kind: "one", list: exact };
	const looseKey = looseListKey(typed);
	if (looseKey === "") return { kind: "none" };
	const loose = all.filter((c) => looseListKey(c.name) === looseKey);
	if (loose.length === 0) return { kind: "none" };
	return loose.length === 1 ? { kind: "one", list: loose[0] as T } : { kind: "several", lists: loose };
}

export function requireCategoryName(raw: string): string {
	const name = raw.normalize("NFC").trim();
	if (name.length === 0) {
		throw new DomainError("CategoryNameRequired", "A list needs a name.");
	}
	return name;
}

/** Names are unique, compared case-insensitively. */
export function assertUniqueCategoryName(
	categories: Iterable<Category>,
	name: string,
	exceptId: ID | null,
): void {
	const key = categoryNameKey(name);
	for (const c of categories) {
		if (c.id !== exceptId && c.nameKey === key) {
			throw new DomainError("DuplicateCategoryName", `A list named "${c.name}" already exists.`);
		}
	}
}

export function isOpen(task: Task): boolean {
	return task.status === "open";
}

/**
 * Has a date a view can place: a schedule, a deadline, or a repeat rule (its occurrences). Only these tasks can be in
 * Today, Upcoming or on the calendar.
 */
export function isDated(task: Task): boolean {
	return task.scheduled !== null || task.deadline !== null || task.recurrence !== null;
}

/**
 * An open task the calendar's Unscheduled drawer lists: no schedule and no repeat rule; a deadline is allowed (Calendar
 * rule 14). A repeating task has no schedule of its own (its dates are the series), so it is never unscheduled.
 */
export function isUnscheduled(task: Task): boolean {
	return isOpen(task) && task.scheduled === null && task.recurrence === null;
}

export function subtasksOf(tasks: Iterable<Task>, parentId: ID): Task[] {
	const result: Task[] = [];
	for (const t of tasks) if (t.parentId === parentId) result.push(t);
	return result.sort(compareTasksBySortKey);
}

export interface SubtaskCount {
	total: number;
	done: number;
}

/** Subtask totals per parent in one pass, so a list renders in O(n). */
export function subtaskCounts(tasks: Iterable<Task>): Map<ID, SubtaskCount> {
	const counts = new Map<ID, SubtaskCount>();
	for (const t of tasks) {
		if (t.parentId === null) continue;
		let c = counts.get(t.parentId);
		if (c === undefined) {
			c = { total: 0, done: 0 };
			counts.set(t.parentId, c);
		}
		c.total++;
		if (t.status === "completed") c.done++;
	}
	return counts;
}

export function compareTasksBySortKey(a: Task, b: Task): number {
	if (a.sortKey !== b.sortKey) return a.sortKey < b.sortKey ? -1 : 1;
	if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
	return compareSortKeys(a.id, b.id);
}

/**
 * One subtask level. A subtask cannot have subtasks, and a task
 * that has subtasks cannot become a subtask.
 */
export function assertCanBecomeSubtask(task: Task, parent: Task, tasks: Iterable<Task>): void {
	if (task.id === parent.id) {
		throw new DomainError("SubtaskDepth", "A task cannot be its own subtask.");
	}
	if (parent.parentId !== null) {
		throw new DomainError("SubtaskDepth", "Only one subtask level is supported.");
	}
	for (const t of tasks) {
		if (t.parentId === task.id) {
			throw new DomainError("SubtaskDepth", "Only one subtask level is supported.");
		}
	}
}

/** A planned duration is a whole number of minutes from 1 to MAX_DURATION_MIN. */
export const isDurationMinutes = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= MAX_DURATION_MIN;

export const DURATION_RANGE_MESSAGE = `Duration must be between 1 and ${MAX_DURATION_MIN} minutes.`;

export function requireDuration(value: number | null): number | null {
	if (value === null) return null;
	if (!isDurationMinutes(value)) throw new DomainError("InvalidValue", DURATION_RANGE_MESSAGE);
	return value;
}
