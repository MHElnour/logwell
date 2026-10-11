import {
	type DoneOccurrence,
	type ListEntry,
	type QueryContext,
	completedRows,
	hasPastDate,
	inUpcoming,
	inUpcomingRange,
	isDueByToday,
	occurrenceDay,
	scheduleOf,
} from "./queries";
import { isUnderTag } from "./tags";
import { compareTasksBySortKey, isOpen } from "./tasks";
import { dateSpecDate, instantDay } from "./time";
import type { ID, LocalDate, OccurrenceRecord, Task } from "./types";
import { INBOX_ID } from "./types";

// Which completed tasks a view's Completed group holds. Pure.

export type CompletedScope =
	| { kind: "today" }
	| { kind: "upcoming" }
	| { kind: "inbox" }
	| { kind: "category"; id: ID }
	| { kind: "tag"; key: string };

/** The day a task was completed, in the display zone; null when it was never completed. */
function completedDate(task: Task, zone: string): LocalDate | null {
	if (task.completedAt === null) return null;
	return instantDay(task.completedAt, zone);
}

/**
 * True when the view would have shown this task while it was open:
 * - Today: its date is today, or it was overdue and was completed today;
 * - Upcoming: its key date is in the range and it is not due by today (Today owns those);
 * - Inbox, a list or a tag: it belongs there.
 */
export function inCompletedScope(task: Task, scope: CompletedScope, ctx: QueryContext): boolean {
	if (isOpen(task)) return false;
	if (scope.kind !== "today") return inViewScope(task, scope, ctx);
	if (!isDueByToday(task, ctx)) return false;
	if (!hasPastDate(task, ctx)) return true;
	// A past date may still sit beside a date of today (a deadline today, a schedule earlier).
	return datesInclude(task, ctx.today, ctx) || completedDate(task, ctx.zone) === ctx.today;
}

/**
 * True when the view lists this task among its open rows, whatever its status (the caller checks it):
 * - Today: it is due by today (overdue or today);
 * - Upcoming: its key date is in the range and it is not due by today (Today owns those);
 * - Inbox, a list or a tag: it belongs there.
 * The tests of the view's open rows (`todayEntries`, `upcomingGroups`, `categoryEntries`, the tag rows).
 */
export function inViewScope(task: Task, scope: CompletedScope, ctx: QueryContext): boolean {
	switch (scope.kind) {
		case "today":
			return isDueByToday(task, ctx);
		case "upcoming":
			return inUpcoming(task, ctx);
		default:
			return inListScope(task, scope);
	}
}

/** Inbox, a list or a tag: the task belongs there. False for the date scopes. */
function inListScope(task: Task, scope: CompletedScope): boolean {
	switch (scope.kind) {
		case "inbox":
			return task.categoryId === INBOX_ID;
		case "category":
			return task.categoryId === scope.id;
		case "tag":
			return task.tagKeys.some((k) => isUnderTag(k, scope.key));
		default:
			return false;
	}
}

function datesInclude(task: Task, date: LocalDate, ctx: QueryContext): boolean {
	return [scheduleOf(task, ctx), task.deadline].some((spec) => spec !== null && dateSpecDate(spec, ctx.zone) === date);
}

/** The local day a done occurrence was completed: `completedOn`, else the day of `resolvedAt` in the display zone. */
function resolvedDay(record: OccurrenceRecord, zone: string): LocalDate | null {
	if (record.completedOn !== null) return record.completedOn;
	return instantDay(record.resolvedAt, zone);
}

/**
 * True when a view's Completed group shows this done occurrence (the series itself stays open):
 * - Today: its day is today, or it was due earlier and was completed today (as a task would);
 * - Upcoming: its day is in the range (done ahead of time);
 * - Inbox, a list or a tag: its task belongs there.
 */
function occurrenceInScope(task: Task, record: OccurrenceRecord, scope: CompletedScope, ctx: QueryContext): boolean {
	if (record.status !== "done") return false;
	const day = occurrenceDay(task, record.occurrenceDate, ctx.zone);
	switch (scope.kind) {
		case "today":
			return day === ctx.today || (day < ctx.today && resolvedDay(record, ctx.zone) === ctx.today);
		case "upcoming":
			return inUpcomingRange(day, ctx);
		default:
			return inListScope(task, scope);
	}
}

/** The open rows a view shows: their IDs, or a test of an open task. */
export type ShownRows = ReadonlySet<ID> | ((task: Task) => boolean);

/**
 * A completed subtask of an open parent stays under its parent instead of moving to the group, but
 * only when the parent's row is shown in the view (`shown`). Without `shown`, any open parent counts.
 */
export function isKeptUnderParent(task: Task, byId: ReadonlyMap<ID, Task>, shown?: ShownRows): boolean {
	if (isOpen(task) || task.parentId === null) return false;
	const parent = byId.get(task.parentId);
	if (parent === undefined || !isOpen(parent)) return false;
	return shown === undefined || (typeof shown === "function" ? shown(parent) : shown.has(parent.id));
}

/**
 * The Completed group of a view: newest `completedAt` first (done occurrences of repeating tasks by `resolvedAt`). `held` are tasks completed a moment ago
 * that still show among the open rows until their check animation ends. `shown` are the view's open
 * rows: a completed subtask leaves for the group unless its parent is one of them.
 */
export function completedGroup(
	tasks: Iterable<Task>,
	byId: ReadonlyMap<ID, Task>,
	scope: CompletedScope,
	ctx: QueryContext,
	held: ReadonlySet<ID> = new Set(),
	shown?: ShownRows,
	occurrences: readonly DoneOccurrence[] = [],
): ListEntry[] {
	const done: Task[] = [];
	for (const t of tasks) {
		if (inCompletedScope(t, scope, ctx) && !held.has(t.id) && !isKeptUnderParent(t, byId, shown)) done.push(t);
	}
	// The caller (views) passes the done occurrences that passed the view's filter; the scope is applied here.
	const rows = occurrences.filter((o) => occurrenceInScope(o.task, o.record, scope, ctx));
	return completedRows(done, rows, byId, ctx);
}

/** Newest `completedAt` first; ties by sort key. */
export function compareNewestFirst(a: Task, b: Task): number {
	const ca = a.completedAt ?? "";
	const cb = b.completedAt ?? "";
	if (ca !== cb) return ca < cb ? 1 : -1;
	return compareTasksBySortKey(a, b);
}
