import { DomainError } from "./errors";
import { compareSortKeys } from "./sortKey";
import { type Category, type ID, TAG_COLORS, type Task } from "./types";

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

/** The list whose name matches `name` as `categoryNameKey` compares (the first in map order), or undefined. */
export function findListByName(categories: ReadonlyMap<ID, Category>, name: string): Category | undefined {
	const key = categoryNameKey(name);
	for (const c of categories.values()) if (c.nameKey === key) return c;
	return undefined;
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

/**
 * `subtaskCounts` for the given parents only: one pass that reads each task's parent and nothing else, and allocates
 * only for a parent in `parents`. A dashboard block shows a few parents out of tens of thousands of tasks.
 */
export function subtaskCountsFor(parents: ReadonlySet<ID>, tasks: Iterable<Task>): Map<ID, SubtaskCount> {
	const counts = new Map<ID, SubtaskCount>();
	if (parents.size === 0) return counts;
	for (const t of tasks) {
		if (t.parentId === null || !parents.has(t.parentId)) continue;
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
