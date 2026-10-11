import type { BlockFilters } from "../parsing/blockQuery";
import { type ListEntry, type QueryContext, type TaskFilter, type ViewScope, arrangeHierarchy, inViewScope, matchesTaskDate, quadrantOf } from "./queries";
import { sectionsOfList } from "./sections";
import { categoryNameKey, isOpen, resolveListName } from "./tasks";
import { isUnderTag, resolveTagName, tagNamesOf } from "./tags";
import { dateOf, dayNum, weekStartOfDay } from "./time";
import type { Category, ID, Section, Tag, Task } from "./types";

// The matcher behind a `logwell` block. Pure: it reads the state it is given and never writes.

/** The part of the database the matcher reads. `DbData` satisfies it. */
export interface BlockQueryState {
	readonly tasks: ReadonlyMap<ID, Task>;
	readonly categories: ReadonlyMap<ID, Category>;
	readonly sections: ReadonlyMap<ID, Section>;
	readonly tags: ReadonlyMap<string, Tag>;
}

export type BlockQueryResult =
	/** A reference does not resolve (list, section or tag); `message` is shown in place of the list. */
	| { kind: "error"; message: string }
	/** The rows to draw, in the list's default order. May be empty ("No tasks found"). */
	| { kind: "ok"; entries: ListEntry[] };

/** A note path as the app stores it: forward slashes, no empty segments, no leading or trailing slash. */
function normalizeNotePath(path: string): string {
	return path
		.replace(/\\/g, "/")
		.split("/")
		.filter((segment) => segment !== "")
		.join("/");
}

/**
 * `due:` and `scheduled:` as the app's date filter (`TaskFilter.date`): today, overdue and next 7 days are its own criteria,
 * "this week" is its range from the first to the last day of the week that holds today.
 */
function dateCriterion(value: NonNullable<BlockFilters["due"]>, ctx: QueryContext): Pick<TaskFilter, "date" | "from" | "to"> {
	switch (value) {
		case "today":
			return { date: "today", from: null, to: null };
		case "overdue":
			return { date: "overdue", from: null, to: null };
		case "next-7-days":
			return { date: "next7", from: null, to: null };
		case "this-week": {
			const start = weekStartOfDay(dayNum(ctx.today), ctx.weekStart);
			return { date: "range", from: dateOf(start), to: dateOf(start + 6) };
		}
	}
}

/** The filters resolved against a state, as a test for one task. */
export type BlockMatcher =
	| { kind: "error"; message: string }
	/** `matches` is true for an open task that every filter accepts, whatever the other tasks are. */
	| { kind: "ok"; matches: (task: Task) => boolean };

/**
 * Runs `filters` over `state`. All filters combine with AND; only open tasks match. `notePath` is the path
 * of the note that holds the block (for `linked: this note`). `ctx` is `CheckpointApp.queryContext()`.
 *
 * Every task is tested on its own, as in the app's filtered views; the matches are then arranged like a
 * list (sort-key order, a matching subtask nested under its matching parent, any other subtask alone with
 * its parent's title). A `section` without a `list` is ignored (the parser reports it).
 */
export function runBlockQuery(filters: BlockFilters, state: BlockQueryState, ctx: QueryContext, notePath: string): BlockQueryResult {
	const matcher = compileBlockQuery(filters, state, ctx, notePath);
	if (matcher.kind === "error") return matcher;
	const matched: Task[] = [];
	for (const task of state.tasks.values()) if (matcher.matches(task)) matched.push(task);
	return { kind: "ok", entries: arrangeHierarchy(matched, state.tasks, ctx) };
}

/**
 * The same filters as a test for one task, so a caller can ask whether a changed record could enter or leave the
 * result without running the query. References (list, section, tag) resolve against `state`; a wrong one is an error.
 */
export function compileBlockQuery(filters: BlockFilters, state: BlockQueryState, ctx: QueryContext, notePath: string): BlockMatcher {
	// -- resolve the references first: a wrong name is an error even when no task would match --
	let listId: ID | null = null;
	let sectionId: ID | null = null;
	if (filters.list !== undefined) {
		const match = resolveListName(state.categories.values(), filters.list);
		if (match.kind === "none") return { kind: "error", message: `No list named \u201c${filters.list}\u201d.` };
		if (match.kind === "several") {
			const names = match.lists.map((l) => l.name).join(", ");
			return { kind: "error", message: `\u201c${filters.list}\u201d matches several lists: ${names}. Use the exact name.` };
		}
		const list = match.list;
		listId = list.id;
		if (filters.section !== undefined) {
			const sectionKey = categoryNameKey(filters.section);
			const found = sectionsOfList(state.sections.values(), list.id).find((s) => s.nameKey === sectionKey);
			if (found === undefined) return { kind: "error", message: `No section named \u201c${filters.section}\u201d in ${list.name}.` };
			sectionId = found.id;
		}
	}
	const tagKeys: string[] | null = filters.tags === undefined ? null : [];
	if (filters.tags !== undefined && tagKeys !== null) {
		// Each tag by its full key, its own name, or as the parent of tags (the filter then includes the children).
		const names = tagNamesOf(state.tags);
		for (const typed of filters.tags) {
			const key = resolveTagName(names, typed);
			if (key === null) return { kind: "error", message: `No tag named \u201c${typed}\u201d.` };
			if (!tagKeys.includes(key)) tagKeys.push(key);
		}
	}

	// -- compile the rest into plain lookups --
	const listScope: ViewScope | null = listId === null ? null : { kind: "category", id: listId };
	const priorities = filters.priorities === undefined ? null : new Set(filters.priorities);
	const quadrants = filters.quadrants === undefined ? null : new Set(filters.quadrants);
	const note = filters.linked === true ? normalizeNotePath(notePath) : null;
	const due = filters.due === undefined ? null : dateCriterion(filters.due, ctx);
	const scheduled = filters.scheduled === undefined ? null : dateCriterion(filters.scheduled, ctx);
	const underTag = new Map<string, boolean>();
	/** Whether a task's tag is one of the selected tags or under one. Cached per tag: a few hundred keys serve every task. */
	const inTag = (taskKey: string, selected: readonly string[]): boolean => {
		let hit = underTag.get(taskKey);
		if (hit === undefined) {
			hit = selected.some((parent) => isUnderTag(taskKey, parent));
			underTag.set(taskKey, hit);
		}
		return hit;
	};

	const matches = (task: Task): boolean => {
		if (!isOpen(task)) return false;
		if (listScope !== null && !inViewScope(task, listScope, ctx)) return false;
		if (sectionId !== null && task.sectionId !== sectionId) return false;
		if (priorities !== null && !priorities.has(task.priority)) return false;
		if (quadrants !== null && !quadrants.has(quadrantOf(task))) return false;
		if (note !== null && (task.descriptionNote === null || normalizeNotePath(task.descriptionNote.path) !== note)) return false;
		if (tagKeys !== null && !task.tagKeys.some((k) => inTag(k, tagKeys))) return false;
		// The app's own date rule on one date: the deadline for `due`, the effective schedule (a repeating task's current occurrence) for `scheduled`.
		if (due !== null && !matchesTaskDate(task, due, ctx, "deadline")) return false;
		if (scheduled !== null && !matchesTaskDate(task, scheduled, ctx, "schedule")) return false;
		return true;
	};
	return { kind: "ok", matches };
}
