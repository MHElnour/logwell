import type { BlockFilters } from "../parsing/blockQuery";
import { type DoneOccurrence, type ListEntry, type QueryContext, type TaskFilter, type ViewScope, arrangeHierarchy, collectDoneOccurrences, completedRows, inViewScope, matchesOccurrenceDate, matchesTaskDate, quadrantOf } from "./queries";
import { sectionsOfList } from "./sections";
import { categoryNameKey, resolveListName } from "./tasks";
import { isUnderTag, resolveTagNames, tagNamesOf } from "./tags";
import { dateOf, dayNum, weekStartOfDay } from "./time";
import type { Category, ID, OccurrenceRecord, Section, Tag, Task } from "./types";

// The matcher behind a `logwell` block. Pure: it reads the state it is given and never writes.

/** The part of the database the matcher reads. `DbData` satisfies it. */
export interface BlockQueryState {
	readonly tasks: ReadonlyMap<ID, Task>;
	readonly categories: ReadonlyMap<ID, Category>;
	readonly sections: ReadonlyMap<ID, Section>;
	readonly tags: ReadonlyMap<string, Tag>;
	/** The done occurrences of repeating tasks, which a `status: completed` block lists. */
	readonly occurrenceRecords: ReadonlyMap<string, OccurrenceRecord>;
}

export type BlockQueryResult =
	/** A reference does not resolve (list, section or tag); `message` is shown in place of the list. */
	| { kind: "error"; message: string }
	/** The rows to draw: the list's default order, or newest completed first for `status: completed`. May be empty ("No tasks found"). */
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
 * "this week" is its range from the first to the last day of the week that holds today, and a typed date or range is
 * its range too (both days included).
 */
function dateCriterion(value: NonNullable<BlockFilters["due"]>, ctx: QueryContext): Pick<TaskFilter, "date" | "from" | "to"> {
	if (typeof value === "object") return { date: "range", from: value.from, to: value.to };
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
	| {
			kind: "ok";
			/** True for a task with the block's status (open unless `status: completed`) that every filter accepts, whatever the other tasks are. */
			matches: (task: Task) => boolean;
			/**
			 * The done occurrences of repeating tasks that a `status: completed` block lists: the task passes the filters and
			 * the occurrence's own day passes `scheduled`; `due` never matches one. Empty, and no record is read, in any other block.
			 */
			doneOccurrences: () => DoneOccurrence[];
			/** Whether a record could be a row of the block: `matches`, or a repeating task that may have a listed done occurrence. */
			mayShow: (task: Task) => boolean;
	  };

/**
 * Runs `filters` over `state`. All filters combine with AND; only open tasks match, or only completed ones with
 * `status: completed`. `notePath` is the path of the note that holds the block (for `linked: this note`). `ctx` is
 * `CheckpointApp.queryContext()`.
 *
 * Every task is tested on its own, as in the app's filtered views; the matches are then arranged like a
 * list (sort-key order, a matching subtask nested under its matching parent, any other subtask alone with
 * its parent's title). A `status: completed` block lists the Completed view's rows (`completedRows`): the matching
 * completed tasks and done occurrences, newest first and flat. A `section` without a `list` is ignored (the parser
 * reports it).
 */
export function runBlockQuery(filters: BlockFilters, state: BlockQueryState, ctx: QueryContext, notePath: string): BlockQueryResult {
	const matcher = compileBlockQuery(filters, state, ctx, notePath);
	if (matcher.kind === "error") return matcher;
	const matched: Task[] = [];
	for (const task of state.tasks.values()) if (matcher.matches(task)) matched.push(task);
	if (filters.status === "completed") {
		return { kind: "ok", entries: completedRows(matched, matcher.doneOccurrences(), state.tasks, ctx) };
	}
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
	let tagKeys: string[] | null = null;
	if (filters.tags !== undefined) {
		// Each tag by its full key, its own name, or as the parent of tags (the filter then includes the children).
		const r = resolveTagNames(tagNamesOf(state.tags), filters.tags);
		if ("unknown" in r) return { kind: "error", message: `No tag named \u201c${r.unknown}\u201d.` };
		tagKeys = r.keys;
	}
	const selectedTags = tagKeys;

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

	const status = filters.status ?? "open";
	/** Every filter but the status and the dates: the ones a task and its done occurrences share. */
	const fieldsMatch = (task: Task): boolean => {
		if (listScope !== null && !inViewScope(task, listScope, ctx)) return false;
		if (sectionId !== null && task.sectionId !== sectionId) return false;
		if (priorities !== null && !priorities.has(task.priority)) return false;
		if (quadrants !== null && !quadrants.has(quadrantOf(task))) return false;
		if (note !== null && (task.descriptionNote === null || normalizeNotePath(task.descriptionNote.path) !== note)) return false;
		if (selectedTags !== null && !task.tagKeys.some((k) => inTag(k, selectedTags))) return false;
		return true;
	};

	const matches = (task: Task): boolean => {
		if (task.status !== status || !fieldsMatch(task)) return false;
		// The app's own date rule on one date: the deadline for `due`, the effective schedule (a repeating task's current occurrence) for `scheduled`.
		if (due !== null && !matchesTaskDate(task, due, ctx, "deadline")) return false;
		if (scheduled !== null && !matchesTaskDate(task, scheduled, ctx, "schedule")) return false;
		return true;
	};
	// A repeating task's done occurrences are rows of a completed block unless `due` is set: an occurrence has no deadline.
	// The task is tested once; each of its done records then only needs the `scheduled` day.
	const listsOccurrences = status === "completed" && due === null;
	const occurrenceTask = (task: Task): boolean => listsOccurrences && task.recurrence !== null && fieldsMatch(task);
	const doneOccurrences = (): DoneOccurrence[] =>
		listsOccurrences ? collectDoneOccurrences(state, occurrenceTask, (task, record) => scheduled === null || matchesOccurrenceDate(task, record, scheduled, ctx)) : [];
	const mayShow = (task: Task): boolean => matches(task) || occurrenceTask(task);
	return { kind: "ok", matches, doneOccurrences, mayShow };
}
