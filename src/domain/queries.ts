import { occurrenceSpec } from "./recurrence";
import { addDays, dateSpecDate, dateSpecSortValue } from "./time";
import { compareSortKeys } from "./sortKey";
import { isUnderTag } from "./tags";
import { compareTasksBySortKey, isOpen } from "./tasks";
import { type DateSpec, type ID, INBOX_ID, type LocalDate, type OccurrenceRecord, type Priority, type Task, type WeekStart } from "./types";

// List and filter queries. Pure functions
// over task records; the app layer feeds them the current state.

export interface QueryContext {
	today: LocalDate;
	/** Display zone. */
	zone: string;
	upcomingDays: number;
	/** The "Week starts on" setting; weekly repeats with an interval count weeks from it. */
	weekStart: WeekStart;
	/**
	 * The one reader of "when is it due" (the engine's effectiveSchedule): the current occurrence of
	 * a repeating task, `task.scheduled` otherwise. CheckpointApp.queryContext() supplies it; a context
	 * without it (domain tests, plain data) reads `task.scheduled`.
	 */
	schedule?: (task: Task) => DateSpec | null;
}

export interface ListEntry {
	task: Task;
	/** 1 when shown nested under its parent in the same list. */
	depth: 0 | 1;
	/** Set when a subtask is shown without its parent ("Parent ›"). */
	parentTitle: string | null;
	/**
	 * The effective schedule of the row: `task.scheduled` for a plain task, the current occurrence
	 * for a repeating one, null when the series ended (or the task has no date).
	 */
	schedule: DateSpec | null;
	/** Set only on a Completed-history row that stands for one done occurrence record. */
	occurrence: { date: LocalDate; status: "done" } | null;
}

/** Heading color of a day or group: overdue red, today blue, tomorrow orange. */
export type GroupTone = "overdue" | "today" | "tomorrow";

export interface DateGroup {
	date: LocalDate;
	entries: ListEntry[];
}

export type DateFilter = "any" | "overdue" | "today" | "next7" | "none" | "range";
export type StatusFilter = "open" | "completed" | "all";
export type Quadrant = "urgent-important" | "important" | "urgent" | "neither";

/** "manual" keeps each view's own order. */
export type TaskSort = "manual" | "date" | "priority";

export interface TaskFilter {
	categoryIds: ID[];
	tagKeys: string[];
	tagMode: "any" | "all";
	date: DateFilter;
	from: LocalDate | null;
	to: LocalDate | null;
	status: StatusFilter;
	hasNote: "any" | "yes" | "no";
	quadrants: Quadrant[];
	/** Show only tasks with one of these priorities (0 = none); empty means all. */
	priorities: Priority[];
	/**
	 * How list views order their rows. It lives with the filter so the one view state
	 * carries both; it is not a filter, so it never counts as an active filter.
	 */
	sort: TaskSort;
}

export function emptyFilter(status: StatusFilter = "all"): TaskFilter {
	return {
		categoryIds: [],
		tagKeys: [],
		tagMode: "any",
		date: "any",
		from: null,
		to: null,
		status,
		hasNote: "any",
		quadrants: [],
		priorities: [],
		sort: "manual",
	};
}

export function isFilterActive(f: TaskFilter, defaultStatus: StatusFilter): boolean {
	return (
		f.categoryIds.length > 0 ||
		f.tagKeys.length > 0 ||
		f.date !== "any" ||
		f.status !== defaultStatus ||
		f.hasNote !== "any" ||
		f.quadrants.length > 0 ||
		f.priorities.length > 0
	);
}

export function quadrantOf(task: Task): Quadrant {
	if (task.urgent && task.important) return "urgent-important";
	if (task.important) return "important";
	if (task.urgent) return "urgent";
	return "neither";
}

function specDate(spec: DateSpec | null, zone: string): LocalDate | null {
	return spec === null ? null : dateSpecDate(spec, zone);
}

/** When the task is due: its current occurrence if it repeats, else its schedule. The single reader of "scheduled". */
export function scheduleOf(task: Task, ctx: QueryContext): DateSpec | null {
	// A raw read on purpose: the fallback of a context without a resolver (a plain task has no other source).
	return ctx.schedule === undefined ? task.scheduled : ctx.schedule(task);
}

/** Overdue or due today: scheduled on or before today, or deadline on or before today. */
export function isDueByToday(task: Task, ctx: QueryContext): boolean {
	const s = specDate(scheduleOf(task, ctx), ctx.zone);
	const d = specDate(task.deadline, ctx.zone);
	return (s !== null && s <= ctx.today) || (d !== null && d <= ctx.today);
}

/** A date before today, whatever the status. A completed task "was overdue" when it was ticked late. */
export function hasPastDate(task: Task, ctx: QueryContext): boolean {
	const s = specDate(scheduleOf(task, ctx), ctx.zone);
	const d = specDate(task.deadline, ctx.zone);
	return (s !== null && s < ctx.today) || (d !== null && d < ctx.today);
}

export function isOverdue(task: Task, ctx: QueryContext): boolean {
	return isOpen(task) && hasPastDate(task, ctx);
}

/** The deadline has passed and the task is still open. */
export function isDeadlineMissed(task: Task, ctx: QueryContext): boolean {
	const d = specDate(task.deadline, ctx.zone);
	return isOpen(task) && d !== null && d < ctx.today;
}

/** The date a task is listed under: its schedule, else its deadline. */
export function keyDate(task: Task, ctx: QueryContext): LocalDate | null {
	return specDate(scheduleOf(task, ctx), ctx.zone) ?? specDate(task.deadline, ctx.zone);
}

/** The sort value of a row: its effective schedule, else its deadline, else last. */
function dateSortValue(entry: Pick<ListEntry, "task" | "schedule">, zone: string): string {
	const spec = entry.schedule ?? entry.task.deadline;
	return spec === null ? "9999" : dateSpecSortValue(spec, zone);
}

/** A row for `task`: nested or not, with its effective schedule and no occurrence. */
export function entryOf(task: Task, byId: ReadonlyMap<ID, Task>, ctx: QueryContext, depth: 0 | 1 = 0): ListEntry {
	return {
		task,
		depth,
		parentTitle: depth === 1 || task.parentId === null ? null : (byId.get(task.parentId)?.title ?? null),
		schedule: scheduleOf(task, ctx),
		occurrence: null,
	};
}

export function flatEntries(tasks: Task[], byId: ReadonlyMap<ID, Task>, ctx: QueryContext): ListEntry[] {
	return tasks.map((task) => entryOf(task, byId, ctx));
}

/**
 * Orders tasks by sort key with subtasks nested under their parent when the
 * parent is in the same list; other subtasks get a "Parent ›" prefix.
 */
export function arrangeHierarchy(tasks: Task[], byId: ReadonlyMap<ID, Task>, ctx: QueryContext): ListEntry[] {
	const included = new Set(tasks.map((t) => t.id));
	const children = new Map<ID, Task[]>();
	const roots: Task[] = [];
	for (const t of tasks) {
		if (t.parentId !== null && included.has(t.parentId)) {
			const list = children.get(t.parentId) ?? [];
			list.push(t);
			children.set(t.parentId, list);
		} else {
			roots.push(t);
		}
	}
	roots.sort(compareTasksBySortKey);
	const result: ListEntry[] = [];
	for (const root of roots) {
		result.push(entryOf(root, byId, ctx));
		for (const child of (children.get(root.id) ?? []).sort(compareTasksBySortKey)) {
			result.push(entryOf(child, byId, ctx, 1));
		}
	}
	return result;
}

/**
 * A completed task a view still shows among its open rows: a subtask under an open parent, or a
 * task that was just completed and is waiting for its check animation to end.
 */
export type KeepPredicate = (task: Task) => boolean;

/** A view that lists open tasks by a rule of its own (not Completed or Trash). */
export type ViewScope = { kind: "today" } | { kind: "upcoming" } | { kind: "inbox" } | { kind: "category"; id: ID } | { kind: "tag"; key: string };

const TODAY_SCOPE: ViewScope = { kind: "today" };
const UPCOMING_SCOPE: ViewScope = { kind: "upcoming" };

/**
 * True when the view lists this task among its open rows, whatever its status (the caller checks it). The one
 * test of the view's open rows (`todayEntries`, `upcomingGroups`, `categoryEntries`, the tag rows) and of its
 * Completed scope outside Today:
 * - Today: it is due by today (overdue or today);
 * - Upcoming: its key date is in the range and it is not due by today (Today owns those);
 * - Inbox, a list or a tag: it belongs there (a tag's view includes its child tags).
 */
export function inViewScope(task: Task, scope: ViewScope, ctx: QueryContext): boolean {
	switch (scope.kind) {
		case "today":
			return isDueByToday(task, ctx);
		case "upcoming":
			return inUpcoming(task, ctx);
		case "inbox":
			return task.categoryId === INBOX_ID;
		case "category":
			return task.categoryId === scope.id;
		case "tag":
			return task.tagKeys.some((k) => isUnderTag(k, scope.key));
	}
}

/** Today = overdue + today, open tasks and the completed ones `keep` holds, in sort-key order. Subtasks are prefixed. */
export function todayEntries(tasks: Task[], byId: ReadonlyMap<ID, Task>, ctx: QueryContext, keep?: KeepPredicate): ListEntry[] {
	const due = tasks.filter((t) => (isOpen(t) || keep?.(t) === true) && inViewScope(t, TODAY_SCOPE, ctx)).sort(compareTasksBySortKey);
	return flatEntries(due, byId, ctx);
}

let rangeCache: { today: LocalDate; days: number; range: { start: LocalDate; end: LocalDate } } | null = null;

/**
 * Upcoming runs from tomorrow to today + `upcomingDays`; today and overdue belong to Today. Cached
 * for the last (today, days) pair: the list queries ask once per task and addDays is a calendar computation.
 */
export function upcomingRange(ctx: QueryContext): { start: LocalDate; end: LocalDate } {
	const c = rangeCache;
	if (c !== null && c.today === ctx.today && c.days === ctx.upcomingDays) return c.range;
	const range = { start: addDays(ctx.today, 1), end: addDays(ctx.today, ctx.upcomingDays) };
	rangeCache = { today: ctx.today, days: ctx.upcomingDays, range };
	return range;
}

export function inUpcomingRange(date: LocalDate | null, ctx: QueryContext): boolean {
	if (date === null) return false;
	const { start, end } = upcomingRange(ctx);
	return date >= start && date <= end;
}

/**
 * A task Upcoming shows: its key date is in the range and it is not due by today (Today owns those).
 * A caller that already knows `isDueByToday` passes it, so it is not read twice.
 */
export function inUpcoming(task: Task, ctx: QueryContext, dueByToday?: boolean): boolean {
	return inUpcomingRange(keyDate(task, ctx), ctx) && !(dueByToday ?? isDueByToday(task, ctx));
}

/** Upcoming: open tasks whose key date falls from tomorrow through the next N days, grouped by date, each in sort-key order. */
export function upcomingGroups(tasks: Task[], byId: ReadonlyMap<ID, Task>, ctx: QueryContext, keep?: KeepPredicate): DateGroup[] {
	const groups = new Map<LocalDate, Task[]>();
	for (const t of tasks) {
		if (!isOpen(t) && keep?.(t) !== true) continue;
		const d = keyDate(t, ctx);
		if (d === null || !inViewScope(t, UPCOMING_SCOPE, ctx)) continue;
		const list = groups.get(d) ?? [];
		list.push(t);
		groups.set(d, list);
	}
	return [...groups.entries()]
		.sort(([a], [b]) => (a < b ? -1 : 1))
		.map(([date, list]) => ({ date, entries: flatEntries(list.sort(compareTasksBySortKey), byId, ctx) }));
}

export function categoryEntries(tasks: Task[], byId: ReadonlyMap<ID, Task>, ctx: QueryContext, categoryId: ID, keep?: KeepPredicate): ListEntry[] {
	const scope: ViewScope = { kind: "category", id: categoryId };
	return arrangeHierarchy(
		tasks.filter((t) => (isOpen(t) || keep?.(t) === true) && inViewScope(t, scope, ctx)),
		byId,
		ctx,
	);
}

/** One done occurrence of a repeating task, before it becomes a Completed-history row. */
export interface DoneOccurrence {
	task: Task;
	record: OccurrenceRecord;
}

/**
 * Completed rows, newest first: completed tasks by `completedAt` and done occurrences by `resolvedAt`,
 * in one order. Ties: tasks before occurrences, tasks by sort key, occurrences by date (latest first) then
 * task id. An occurrence row's `schedule` is that occurrence's own date (and time), not the series' next one.
 */
export function completedRows(done: readonly Task[], occurrences: readonly DoneOccurrence[], byId: ReadonlyMap<ID, Task>, ctx: QueryContext): ListEntry[] {
	interface Item {
		time: string;
		task: Task;
		record: OccurrenceRecord | null;
	}
	const items: Item[] = [
		...done.map((task) => ({ time: task.completedAt ?? "", task, record: null })),
		...occurrences.map(({ task, record }) => ({ time: record.resolvedAt, task, record })),
	];
	items.sort((a, b) => {
		if (a.time !== b.time) return a.time < b.time ? 1 : -1;
		if (a.record === null || b.record === null) return a.record === b.record ? compareTasksBySortKey(a.task, b.task) : a.record === null ? -1 : 1;
		if (a.record.occurrenceDate !== b.record.occurrenceDate) return a.record.occurrenceDate < b.record.occurrenceDate ? 1 : -1;
		return compareSortKeys(a.task.id, b.task.id);
	});
	return items.map(({ task, record }) => {
		const entry = entryOf(task, byId, ctx);
		if (record === null || task.recurrence === null) return entry;
		return { ...entry, schedule: occurrenceSpec(task.recurrence, record.occurrenceDate), occurrence: { date: record.occurrenceDate, status: "done" } };
	});
}

/** Completed, newest first; `occurrences` are the done occurrences of repeating tasks. */
export function completedEntries(tasks: Task[], byId: ReadonlyMap<ID, Task>, ctx: QueryContext, occurrences: readonly DoneOccurrence[] = []): ListEntry[] {
	return completedRows(
		tasks.filter((t) => t.status === "completed"),
		occurrences,
		byId,
		ctx,
	);
}

/** Splits rows into blocks: a row and the subtasks (depth 1) nested under it. */
function parentBlocks(entries: ListEntry[]): ListEntry[][] {
	const blocks: ListEntry[][] = [];
	for (const e of entries) {
		const last = blocks.at(-1);
		if (e.depth === 1 && last !== undefined) last.push(e);
		else blocks.push([e]);
	}
	return blocks;
}

/** Date sort: earliest key date first, undated last; ties keep the view's order. Subtasks move with their parent. */
export function sortEntriesByDate(entries: ListEntry[], zone: string): ListEntry[] {
	const ranked = parentBlocks(entries).map((b, i) => ({ b, i, v: dateSortValue(b[0]!, zone) }));
	ranked.sort((x, y) => (x.v === y.v ? x.i - y.i : x.v < y.v ? -1 : 1));
	return ranked.flatMap((x) => x.b);
}

/** Case-insensitive substring match on titles. */
export function matchesText(title: string, query: string): boolean {
	const q = query.trim().toLocaleLowerCase();
	return q.length === 0 || title.toLocaleLowerCase().includes(q);
}

/** The last day of "Next 7 days": today and the next six days. The filter, task blocks and the matrix all end here. */
export function nextSevenDaysEnd(ctx: QueryContext): LocalDate {
	return addDays(ctx.today, 6);
}

/** The date criterion on a schedule day `s` and a deadline day `d`; `overdue` is only asked for the "overdue" criterion. */
function matchesDate(f: Pick<TaskFilter, "date" | "from" | "to">, ctx: QueryContext, s: LocalDate | null, d: LocalDate | null, overdue: () => boolean): boolean {
	switch (f.date) {
		case "any":
			return true;
		case "none":
			return s === null && d === null;
		case "overdue":
			return overdue();
		case "today":
			return s === ctx.today || d === ctx.today;
		case "next7": {
			const end = nextSevenDaysEnd(ctx);
			return [s, d].some((x) => x !== null && x >= ctx.today && x <= end);
		}
		case "range":
			return [s, d].some(
				(x) => x !== null && (f.from === null || x >= f.from) && (f.to === null || x <= f.to),
			);
	}
}

/** Every criterion except the status and the dates. */
function matchesFields(task: Task, f: TaskFilter): boolean {
	if (f.categoryIds.length > 0 && !f.categoryIds.includes(task.categoryId)) return false;
	if (f.tagKeys.length > 0) {
		const has = (k: string) => task.tagKeys.includes(k);
		if (f.tagMode === "all" ? !f.tagKeys.every(has) : !f.tagKeys.some(has)) return false;
	}
	if (f.hasNote === "yes" && task.descriptionNote === null) return false;
	if (f.hasNote === "no" && task.descriptionNote !== null) return false;
	if (f.quadrants.length > 0 && !f.quadrants.includes(quadrantOf(task))) return false;
	if (f.priorities.length > 0 && !f.priorities.includes(task.priority)) return false;
	return true;
}

/** All fields combine with AND. Empty fields do not constrain. */
function matchesFilter(task: Task, f: TaskFilter, ctx: QueryContext): boolean {
	if (f.status !== "all" && task.status !== f.status) return false;
	if (!matchesFields(task, f)) return false;
	return matchesTaskDate(task, f, ctx);
}

/**
 * The date criterion of a filter on one task: the effective schedule day and the deadline day, either one
 * (`overdue` is `isOverdue`). Only `date`, `from` and `to` are read. Shared with the dashboard block.
 */
export function matchesTaskDate(task: Task, f: Pick<TaskFilter, "date" | "from" | "to">, ctx: QueryContext): boolean {
	if (f.date === "any") return true;
	return matchesDate(f, ctx, specDate(scheduleOf(task, ctx), ctx.zone), specDate(task.deadline, ctx.zone), () => isOverdue(task, ctx));
}

/** The display-zone day of one occurrence of a repeating task. */
export function occurrenceDay(task: Task, date: LocalDate, zone: string): LocalDate {
	return task.recurrence === null ? date : dateSpecDate(occurrenceSpec(task.recurrence, date), zone);
}

/**
 * Whether a done occurrence of `task` passes the filter (text is the caller's). The status
 * criterion is about the occurrence, not the series: "open" excludes it, "all" and "completed" keep it.
 * The date criteria test the occurrence's own day; it is never overdue.
 */
export function matchesOccurrence(task: Task, record: OccurrenceRecord, f: TaskFilter, ctx: QueryContext): boolean {
	if (f.status === "open" || !matchesFields(task, f)) return false;
	return f.date === "any" || matchesDate(f, ctx, occurrenceDay(task, record.occurrenceDate, ctx.zone), null, () => false);
}

/** Sort rank: high (1), medium (2), low (3), then none (0). */
export function priorityRank(p: Priority): number {
	return p === 0 ? 4 : p;
}

/**
 * Orders rows high, medium, low, none. The sort is stable, so ties keep the view's
 * order. A subtask shown under its parent (depth 1) moves with the parent's block.
 */
export function sortEntriesByPriority(entries: ListEntry[]): ListEntry[] {
	const ranked = parentBlocks(entries).map((b, i) => ({ b, i, r: priorityRank(b[0]!.task.priority) }));
	ranked.sort((x, y) => x.r - y.r || x.i - y.i);
	return ranked.flatMap((x) => x.b);
}

/** Whether one task passes a view's filter and search text: the test `filterTasks` applies to each task. */
export function passesFilter(task: Task, f: TaskFilter, text: string, ctx: QueryContext): boolean {
	return matchesText(task.title, text) && matchesFilter(task, f, ctx);
}

/** Filter first, then build the list, so nesting reflects what is shown. */
export function filterTasks(tasks: Iterable<Task>, f: TaskFilter, text: string, ctx: QueryContext): Task[] {
	const result: Task[] = [];
	for (const t of tasks) if (passesFilter(t, f, text, ctx)) result.push(t);
	return result;
}
