import { type CompletedScope, completedGroup, inCompletedScope, isKeptUnderParent } from "../domain/completed";
import {
	type DoneOccurrence,
	type GroupTone,
	type ListEntry,
	type QueryContext,
	type TaskFilter,
	type ViewScope,
	arrangeHierarchy,
	categoryEntries,
	completedEntries,
	entryOf,
	filterTasks,
	hasPastDate,
	inViewScope,
	inUpcoming,
	isDueByToday,
	isFilterActive,
	isOverdue,
	keyDate,
	matchesOccurrence,
	matchesText,
	occurrenceDay,
	passesFilter,
	priorityRank,
	sortEntriesByDate,
	sortEntriesByPriority,
	todayEntries,
	upcomingGroups,
	upcomingRange,
} from "../domain/queries";
import { type BoardColumn, dayTitle, toCards } from "../domain/board";
import { type GroupBy, effectiveGroupBy } from "../domain/groupBy";
import { indexOccurrenceRecords } from "../domain/recurrence";
import { sectionsOfList } from "../domain/sections";
import { tagLabel, tagPrefixes } from "../domain/tags";
import { addDays } from "../domain/time";
import { compareTasksBySortKey, isDated, isOpen, isUnscheduled, listsInSidebarOrder } from "../domain/tasks";
import { type Category, type Habit, type ID, INBOX_ID, INBOX_NAME, type LocalDate, type Priority, type Task } from "../domain/types";
import type { DbData } from "../persistence/schema";
import type { NotePort } from "./ports";
import type { TaskIndex } from "./taskIndex";

// View selectors. Pure reads over the store state.

/** A Tasks view: one that lists open tasks (`ViewScope`), Completed or Trash. */
export type TaskView = ViewScope | { kind: "completed" } | { kind: "trash" };

export type { GroupTone };

/**
 * What dropping a row on a group does (list mode). A group with no `drop` refuses a row from another
 * group: Overdue, No date, and every group of a tag grouping.
 */
export type GroupDrop =
	| { kind: "section"; sectionId: ID | null }
	| { kind: "list"; categoryId: ID }
	| { kind: "priority"; priority: Priority }
	| { kind: "date"; date: LocalDate };

export interface ViewGroup {
	/** Stable within a view and a grouping: "all", "overdue", "today", a date, "nodate", "section:<id>", "priority:1", "tag:<key>", "notag", "list:<id>". */
	key: string;
	/** Set where a row can be dropped on this group. */
	drop?: GroupDrop;
	/** A date heading for Upcoming; null for a plain list. */
	date: LocalDate | null;
	/** A text heading ("Overdue", "Today") for a group that is not a date. */
	label?: string;
	/** Heading color: overdue red, today blue, tomorrow orange. */
	tone?: GroupTone;
	/** Inbox and list views: the section this group is; id null is "No section". */
	section?: { id: ID | null; name: string };
	entries: ListEntry[];
}

/** Heading color of a day: overdue red, today blue, tomorrow orange. */
export function dateTone(date: LocalDate, today: LocalDate): GroupTone | undefined {
	if (date < today) return "overdue";
	if (date === today) return "today";
	if (date === addDays(today, 1)) return "tomorrow";
	return undefined;
}

export function sameView(a: TaskView, b: TaskView): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

export function viewTitle(view: TaskView, state: DbData): string {
	switch (view.kind) {
		case "today":
			return "Today";
		case "upcoming":
			return "Upcoming";
		case "inbox":
			return state.categories.get(INBOX_ID)?.name ?? INBOX_NAME;
		case "category":
			return state.categories.get(view.id)?.name ?? INBOX_NAME;
		case "tag":
			return `@${tagLabel(state.tags, view.key)}`;
		case "completed":
			return "Completed";
		case "trash":
			return "Trash";
	}
}

/** Presets for tasks added while a view is shown (category, Today's date, tag). */
export function viewPreset(view: TaskView, ctx: QueryContext): { addCategoryId: ID; addDate: LocalDate | null; addTagKeys: string[] } {
	return {
		addCategoryId: view.kind === "category" ? view.id : INBOX_ID,
		addDate: view.kind === "today" ? ctx.today : null,
		// Every tag view presets its tag, a parent's too (Lists, sections and tags rule 26).
		addTagKeys: view.kind === "tag" ? [view.key] : [],
	};
}

/**
 * Today: an Overdue group (a date before today) and a Today group; empty groups are omitted. A held task (completed a
 * moment ago) stays in the group it was in while open, so its check animation plays in place.
 */
function todayGroups(entries: ListEntry[], ctx: QueryContext, ordered: (e: ListEntry[]) => ListEntry[], held: ReadonlySet<ID>): ViewGroup[] {
	const overdue: ListEntry[] = [];
	const rest: ListEntry[] = [];
	const late = (t: Task) => isOverdue(t, ctx) || (held.has(t.id) && hasPastDate(t, ctx));
	for (const e of entries) (late(e.task) ? overdue : rest).push(e);
	const groups: ViewGroup[] = [];
	// Dropping on Overdue is refused; dropping on Today reschedules to today.
	if (overdue.length > 0) groups.push({ key: "overdue", date: null, label: "Overdue", tone: "overdue", entries: ordered(overdue) });
	if (rest.length > 0) {
		groups.push({ key: "today", date: null, label: "Today", tone: "today", drop: { kind: "date", date: ctx.today }, entries: ordered(rest) });
	}
	return groups;
}

const NO_SECTION = "No section";

/** The section a task is grouped under: one that does not exist counts as none. */
function columnOf(state: DbData, task: Task): ID | null {
	return task.sectionId !== null && state.sections.has(task.sectionId) ? task.sectionId : null;
}

const NO_IDS: ReadonlySet<ID> = new Set();

/** The view's Completed group scope; null where there is no group (Completed, Trash). */
export function completedScope(view: TaskView): CompletedScope | null {
	switch (view.kind) {
		case "today":
		case "upcoming":
		case "inbox":
		case "category":
		case "tag":
			return view;
		case "completed":
		case "trash":
			return null;
	}
}

/** A view's open rows and its Completed group. */
export interface ViewList {
	groups: ViewGroup[];
	/** Newest first; empty where the view has no Completed group or it was not asked for. */
	completed: ListEntry[];
}

/**
 * A view's open rows and its Completed group, from one filtering of the tasks. A completed task stays among the open
 * rows when it is in `held` (completed a moment ago, waiting for its check animation to end) or is a subtask whose
 * open parent's row is shown too; any other completed task the view would have listed is in the Completed group.
 * `completed: false` leaves the group out (it is not shown). With `index`, only the view's candidate tasks are read;
 * without it every task is (the reference the index is tested against). Both give the same result.
 */
export function buildList(
	state: DbData,
	view: TaskView,
	ctx: QueryContext,
	filter: TaskFilter,
	text: string,
	held: ReadonlySet<ID> = NO_IDS,
	options: { groupBy?: GroupBy; completed?: boolean; index?: TaskIndex } = {},
): ViewList {
	const p = prepare(state, view, ctx, filter, text, held, options.index);
	return {
		groups: openGroups(state, view, ctx, filter, text, options.groupBy, p),
		completed: options.completed === false ? [] : completedOf(state, view, ctx, filter, text, held, p),
	};
}

/** What a view's open rows and Completed group both start from. */
interface Prepared {
	/** The tasks that pass the filter and the search text. */
	tasks: Task[];
	/** Whether the view shows an open task's row; null where the view has no Completed group. */
	shown: ((task: Task) => boolean) | null;
	/**
	 * The completed tasks shown among the open rows: held ones, and subtasks whose open parent's row is shown
	 * (App shell and views rule 21). The rows themselves still apply the view's Completed scope to them.
	 */
	keep: (task: Task) => boolean;
	/** The tasks completed a moment ago, still shown for their check animation. */
	held: ReadonlySet<ID>;
	/** `tasks` are in sort order (the index's candidates of Inbox and a list), so the rows need not sort them. */
	sorted: boolean;
}

/**
 * Filters the view's candidates (from `index`), or every task without one. A candidate outside the view is harmless:
 * the rows and the Completed group test each task's own scope. A kept subtask's parent is read from the state, so
 * it need not be a candidate.
 */
function prepare(state: DbData, view: TaskView, ctx: QueryContext, filter: TaskFilter, text: string, held: ReadonlySet<ID>, index?: TaskIndex): Prepared {
	const candidates = index?.candidates(state, view);
	const sorted = candidates !== undefined && index?.candidatesInOrder(view) === true;
	const tasks = filterTasks(candidates ?? state.tasks.values(), filter, text, ctx);
	const scope = completedScope(view);
	if (scope === null) return { tasks, shown: null, keep: (t) => held.has(t.id), held, sorted };
	// An open parent's row is shown when the view lists it and it passes the filter and text. Asked only for
	// the parents of completed subtasks, once per parent.
	const known = new Map<ID, boolean>();
	const shown = (parent: Task): boolean => {
		let s = known.get(parent.id);
		if (s === undefined) {
			s = inViewScope(parent, scope, ctx) && passesFilter(parent, filter, text, ctx);
			known.set(parent.id, s);
		}
		return s;
	};
	return { tasks, shown, keep: (t) => held.has(t.id) || isKeptUnderParent(t, state.tasks, shown), held, sorted };
}

function openGroups(
	state: DbData,
	view: TaskView,
	ctx: QueryContext,
	filter: TaskFilter,
	text: string,
	groupBy: GroupBy | undefined,
	{ tasks, keep, held, sorted }: Prepared,
): ViewGroup[] {
	return viewGroups(state, view, ctx, filter, tasks, keep, groupBy, text, sorted, held);
}

/**
 * The done occurrences of repeating tasks that pass the view's filter and text, for its Completed
 * rows. The series task itself stays open, so the task filters (status included) cannot find them.
 */
function doneOccurrences(state: DbData, ctx: QueryContext, filter: TaskFilter, text: string): DoneOccurrence[] {
	const out: DoneOccurrence[] = [];
	for (const [taskId, records] of indexOccurrenceRecords(state.occurrenceRecords)) {
		const task = state.tasks.get(taskId);
		if (task === undefined || task.recurrence === null || !matchesText(task.title, text)) continue;
		for (const record of records) if (record.status === "done" && matchesOccurrence(task, record, filter, ctx)) out.push({ task, record });
	}
	return out;
}

/**
 * Splits `entries` into buckets by `keyOf` of each top-level row. A nested subtask (depth 1) follows
 * the row before it, so it stays under its parent whatever its own values are.
 */
function bucketize<K>(entries: ListEntry[], keyOf: (t: Task) => K): Map<K, ListEntry[]> {
	const buckets = new Map<K, ListEntry[]>();
	let current: K | undefined;
	let started = false;
	for (const e of entries) {
		if (e.depth === 0 || !started) {
			current = keyOf(e.task);
			started = true;
		}
		const list = buckets.get(current as K);
		if (list === undefined) buckets.set(current as K, [e]);
		else list.push(e);
	}
	return buckets;
}

const PRIORITY_GROUPS: { priority: Priority; label: string }[] = [
	{ priority: 1, label: "High" },
	{ priority: 2, label: "Medium" },
	{ priority: 3, label: "Low" },
	{ priority: 0, label: "None" },
];

/** Rows of `view` where `keepTask` decides which completed tasks show among the open ones, grouped as `groupBy` says. */
function viewGroups(
	state: DbData,
	view: TaskView,
	ctx: QueryContext,
	filter: TaskFilter,
	tasks: Task[],
	keepTask: (t: Task) => boolean,
	groupBy?: GroupBy,
	/** The view's search text; only the Completed view needs it (done occurrences). */
	text = "",
	/** `tasks` are in sort order: Inbox and list rows then skip their sort (`arrangeHierarchy` `presorted`). */
	sorted = false,
	/** The tasks completed a moment ago; Today keeps them in their group. */
	held: ReadonlySet<ID> = NO_IDS,
): ViewGroup[] {
	const byId = state.tasks;
	const scope = completedScope(view);
	const keep = (t: Task): boolean => scope !== null && keepTask(t) && inCompletedScope(t, scope, ctx);
	const ordered = (entries: ListEntry[]): ListEntry[] =>
		filter.sort === "priority" ? sortEntriesByPriority(entries) : filter.sort === "date" ? sortEntriesByDate(entries, ctx.zone) : entries;
	const plain = (entries: ListEntry[]): ViewGroup[] => [{ key: "all", date: null, entries: ordered(entries) }];
	// "No section" first, then each section by sortKey, empty ones included.
	const sectioned = (categoryId: ID, entries: ListEntry[]): ViewGroup[] => {
		const sections = sectionsOfList(state.sections.values(), categoryId);
		const known = new Set(sections.map((s) => s.id));
		// A section that is missing (not expected after repair) shows as No section.
		const bucket = bucketize(entries, (t) => (t.sectionId !== null && known.has(t.sectionId) ? t.sectionId : null));
		return [
			{ id: null, name: NO_SECTION },
			...sections.map((s) => ({ id: s.id, name: s.name })),
		].map((section) => ({
			key: `section:${section.id ?? "none"}`,
			drop: { kind: "section" as const, sectionId: section.id },
			date: null,
			section,
			entries: ordered(bucket.get(section.id) ?? []),
		}));
	};
	/** The open rows of the view before grouping: flat in Today and Upcoming, nested in Inbox, lists and tags. */
	const rows = (): ListEntry[] => {
		switch (view.kind) {
			case "today":
				return todayEntries(tasks, byId, ctx, keep);
			case "upcoming":
				return upcomingGroups(tasks, byId, ctx, keep)
					.flatMap((g) => g.entries)
					.sort((a, b) => compareTasksBySortKey(a.task, b.task));
			case "inbox":
				return categoryEntries(tasks, byId, ctx, INBOX_ID, keep, sorted);
			case "category":
				return categoryEntries(tasks, byId, ctx, view.id, keep, sorted);
			case "tag":
				return arrangeHierarchy(tasks.filter((t) => (isOpen(t) || keep(t)) && inViewScope(t, view, ctx)), byId, ctx);
			case "completed":
				return completedEntries(tasks, byId, ctx, doneOccurrences(state, ctx, filter, text));
			case "trash":
				return [];
		}
	};
	if (view.kind === "trash") return [];
	const by = effectiveGroupBy(view.kind, groupBy);
	switch (by) {
		case "none":
			return plain(rows());
		case "section":
			return sectioned(view.kind === "category" ? view.id : INBOX_ID, rows());
		case "date": {
			if (view.kind === "today") return todayGroups(rows(), ctx, ordered, held);
			if (view.kind === "upcoming") {
				return upcomingGroups(tasks, byId, ctx, keep).map((g) => ({
					key: g.date,
					date: g.date,
					tone: dateTone(g.date, ctx.today),
					drop: { kind: "date" as const, date: g.date },
					entries: ordered(g.entries),
				}));
			}
			// A list: one heading per date (past dates too, in red), then No date. A drop on "No date" is refused.
			const buckets = bucketize(rows(), (t) => keyDate(t, ctx));
			const dates = [...buckets.keys()].filter((d): d is LocalDate => d !== null).sort();
			const groups: ViewGroup[] = dates.map((d) => ({
				key: d,
				date: d,
				tone: dateTone(d, ctx.today),
				drop: { kind: "date", date: d },
				entries: ordered(buckets.get(d)!),
			}));
			const none = buckets.get(null);
			if (none !== undefined) groups.push({ key: "nodate", date: null, label: "No date", entries: ordered(none) });
			return groups;
		}
		case "priority": {
			const buckets = bucketize(rows(), (t) => t.priority);
			return PRIORITY_GROUPS.filter((g) => buckets.has(g.priority)).map((g) => ({
				key: `priority:${g.priority}`,
				date: null,
				label: g.label,
				drop: { kind: "priority" as const, priority: g.priority },
				entries: ordered(buckets.get(g.priority)!),
			}));
		}
		case "tag": {
			// A task is listed once, under the first tag of its own tag order; no drop between tag groups.
			const buckets = bucketize(rows(), (t) => t.tagKeys[0] ?? null);
			const name = (key: string) => tagLabel(state.tags, key);
			const keys = [...buckets.keys()].filter((k): k is string => k !== null).sort((a, b) => name(a).localeCompare(name(b)));
			const groups: ViewGroup[] = keys.map((k) => ({ key: `tag:${k}`, date: null, label: `@${name(k)}`, entries: ordered(buckets.get(k)!) }));
			const none = buckets.get(null);
			if (none !== undefined) groups.push({ key: "notag", date: null, label: "No tag", entries: ordered(none) });
			return groups;
		}
		case "list": {
			const buckets = bucketize(rows(), (t) => t.categoryId);
			const known = listsInSidebarOrder(state.categories.values());
			const seen = new Set(known.map((c) => c.id));
			// A list that is missing (not expected after repair) still shows its tasks, last.
			const lists = [
				...known.map((c) => ({ id: c.id, name: c.name })),
				...[...buckets.keys()].filter((id) => !seen.has(id)).map((id) => ({ id, name: INBOX_NAME })),
			];
			return lists
				.filter((c) => buckets.has(c.id))
				.map((c) => ({
					key: `list:${c.id}`,
					date: null,
					label: c.name,
					drop: { kind: "list" as const, categoryId: c.id },
					entries: ordered(buckets.get(c.id)!),
				}));
		}
	}
}

function completedOf(
	state: DbData,
	view: TaskView,
	ctx: QueryContext,
	filter: TaskFilter,
	text: string,
	held: ReadonlySet<ID>,
	{ tasks, shown }: Prepared,
): ListEntry[] {
	const scope = completedScope(view);
	if (scope === null || shown === null) return [];
	return completedGroup(tasks, state.tasks, scope, ctx, held, shown, doneOccurrences(state, ctx, filter, text));
}

/**
 * The board of a view: Today (Overdue, hidden when empty, then Today), Upcoming (one column per day
 * from tomorrow, empty days included), Inbox or a list ("No section", then one column per section). Other views have
 * no board. Each column's Completed group uses the view's Completed group rules with the column's day as its scope: the
 * Today column holds the whole Today group (a task that was overdue and completed today included);
 * Overdue has none.
 */
export function buildBoard(
	state: DbData,
	view: TaskView,
	ctx: QueryContext,
	filter: TaskFilter,
	text: string,
	held: ReadonlySet<ID> = NO_IDS,
	/** Reads only the view's candidate tasks, as `buildList` does. */
	index?: TaskIndex,
): BoardColumn[] {
	// A column's open rows and Completed group start from the same filtered tasks and shown rows: made once.
	const openOf = (p: Prepared, groupBy?: GroupBy): ViewGroup[] => openGroups(state, view, ctx, filter, text, groupBy, p);
	const doneOf = (p: Prepared): ListEntry[] => completedOf(state, view, ctx, filter, text, held, p);
	switch (view.kind) {
		case "today": {
			const p = prepare(state, view, ctx, filter, text, held, index);
			const groups = openOf(p);
			const overdue = groups.find((g) => g.key === "overdue")?.entries ?? [];
			const today = groups.find((g) => g.key === "today")?.entries ?? [];
			const columns: BoardColumn[] = [];
			if (overdue.length > 0) {
				columns.push({ id: "overdue", title: "Overdue", tone: "overdue", date: null, acceptsDrop: false, cards: toCards(overdue), completed: [] });
			}
			columns.push({
				id: "today",
				title: "Today",
				tone: "today",
				date: ctx.today,
				acceptsDrop: true,
				cards: toCards(today),
				completed: doneOf(p),
			});
			return columns;
		}
		case "upcoming": {
			const p = prepare(state, view, ctx, filter, text, held, index);
			const byDate = new Map<LocalDate, ListEntry[]>();
			for (const g of openOf(p)) if (g.date !== null) byDate.set(g.date, g.entries);
			const done = new Map<LocalDate, ListEntry[]>();
			for (const e of doneOf(p)) {
				// A done occurrence is listed under its own day, not the series' next one.
				const d = e.occurrence === null ? keyDate(e.task, ctx) : occurrenceDay(e.task, e.occurrence.date, ctx.zone);
				if (d !== null) done.set(d, [...(done.get(d) ?? []), e]);
			}
			const { start, end } = upcomingRange(ctx);
			const columns: BoardColumn[] = [];
			for (let d = start; d <= end; d = addDays(d, 1)) {
				columns.push({
					id: d,
					title: dayTitle(d, ctx),
					tone: dateTone(d, ctx.today),
					date: d,
					acceptsDrop: true,
					cards: toCards(byDate.get(d) ?? []),
					completed: done.get(d) ?? [],
				});
			}
			return columns;
		}
		case "inbox":
		case "category": {
			// "No section", then one column per section; each column has its own Completed group.
			const p = prepare(state, view, ctx, filter, text, held, index);
			const completed = doneOf(p);
			return openOf(p, "section").map((g) => {
				const id = g.section?.id ?? null;
				return {
					id: id ?? "none",
					title: g.section?.name ?? NO_SECTION,
					date: null,
					sectionId: id,
					acceptsDrop: true,
					cards: toCards(g.entries),
					completed: completed.filter((e) => columnOf(state, e.task) === id),
				};
			});
		}
		case "tag":
		case "completed":
		case "trash":
			return [];
	}
}

export interface SidebarCounts {
	today: number;
	upcoming: number;
	categories: Map<ID, number>;
	tags: Map<string, number>;
	completed: number;
	trash: number;
}

/**
 * Open-task counts for the sidebar. With `index`, the list, tag and completed counts are the index's and Today and
 * Upcoming are counted over the dated tasks only; without it every task is read (the reference the index is tested
 * against). Both give the same counts.
 */
export function sidebarCounts(state: DbData, ctx: QueryContext, index?: TaskIndex): SidebarCounts {
	const fromIndex = index?.counts(state);
	if (fromIndex !== undefined) {
		let today = 0;
		let upcoming = 0;
		for (const t of fromIndex.dated) {
			if (!isOpen(t)) continue;
			const due = isDueByToday(t, ctx);
			if (due) today++;
			if (inUpcoming(t, ctx, due)) upcoming++;
		}
		return { today, upcoming, categories: fromIndex.lists, tags: fromIndex.tags, completed: fromIndex.completed, trash: state.trash.size };
	}
	const counts: SidebarCounts = {
		today: 0,
		upcoming: 0,
		categories: new Map(),
		tags: new Map(),
		completed: 0,
		trash: state.trash.size,
	};
	for (const t of state.tasks.values()) {
		if (!isOpen(t)) {
			counts.completed++;
			continue;
		}
		const due = isDueByToday(t, ctx);
		if (due) counts.today++;
		if (inUpcoming(t, ctx, due)) counts.upcoming++;
		counts.categories.set(t.categoryId, (counts.categories.get(t.categoryId) ?? 0) + 1);
		// A tag counts for itself and every path prefix above it; a task counts once per key.
		const keys = new Set<string>();
		for (const k of t.tagKeys) for (const prefix of tagPrefixes(k)) keys.add(prefix);
		for (const k of keys) counts.tags.set(k, (counts.tags.get(k) ?? 0) + 1);
	}
	return counts;
}

/** A part of the tasks a view reads: the dated ones (`isDated`) or the open ones. */
export type TaskSubset = "dated" | "open";

/**
 * The tasks that pass a view menu's filter (`passesFilter`, no search text), and with `within` are also dated or open:
 * what the calendar and the matrix show. With `index`, only the index's candidates for the filter are read; without
 * it every task is (the reference the index is tested against). Both give the same tasks, in no set order: callers
 * sort them.
 */
export function menuTasks(state: DbData, ctx: QueryContext, filter: TaskFilter, options: { within?: TaskSubset; index?: TaskIndex } = {}): Task[] {
	const { within, index } = options;
	const tasks = filterTasks(index?.filterCandidates(state, filter, within) ?? state.tasks.values(), filter, "", ctx);
	if (within === undefined) return tasks;
	return tasks.filter(within === "dated" ? isDated : isOpen);
}

export interface CalendarTasks {
	/** The tasks the week and month place: dated ones through the view menu. */
	dated: Task[];
	/** How many tasks the Unscheduled drawer lists (`unscheduledTasks`); undefined when not asked for. */
	unscheduledCount: number | undefined;
}

/**
 * What the calendar shows on every change: the tasks it places and the Unscheduled count. With `index`, the dated
 * tasks are the index's; a view menu that asks for nothing but a status other than "completed" lets every open task
 * through, so the count is then the index's open tasks less the open ones with a schedule or a repeat rule (all of
 * them dated) and no task is read for it. Otherwise the count reads the drawer's tasks. `count: false` leaves the
 * count out (an open drawer counts its rows).
 */
export function calendarTasks(state: DbData, ctx: QueryContext, filter: TaskFilter, index?: TaskIndex, options: { count?: boolean } = {}): CalendarTasks {
	const dated = menuTasks(state, ctx, filter, { within: "dated", index });
	if (options.count === false) return { dated, unscheduledCount: undefined };
	const open = filter.status !== "completed" && !isFilterActive(filter, filter.status) ? index?.openTotal(state) : undefined;
	const unscheduledCount = open === undefined ? unscheduledTasks(state, ctx, filter, index).length : open - dated.filter((t) => isOpen(t) && !isUnscheduled(t)).length;
	return { dated, unscheduledCount };
}

/** The calendar's Unscheduled drawer: the open tasks through the view menu with no schedule and no repeat rule (`isUnscheduled`), unsorted. */
export function unscheduledTasks(state: DbData, ctx: QueryContext, filter: TaskFilter, index?: TaskIndex): Task[] {
	return menuTasks(state, ctx, filter, { within: "open", index }).filter(isUnscheduled);
}

export interface SearchResults {
	tasks: ListEntry[];
	categories: Category[];
	/** Habits by name, archived ones included (after the active ones). */
	habits: Habit[];
}

/** Title search: tasks (open and completed), categories and habits. */
export function globalSearch(
	state: DbData,
	query: string,
	ctx: QueryContext,
	filter: TaskFilter,
	noteMatches: ReadonlySet<ID> = new Set(),
): SearchResults {
	const q = query.trim();
	if (q.length === 0) return { tasks: [], categories: [], habits: [] };
	const tasks = filterTasks(state.tasks.values(), filter, "", ctx).filter((t) => matchesText(t.title, q) || noteMatches.has(t.id));
	const byPriority = filter.sort === "priority";
	tasks.sort((a, b) => {
		if (a.status !== b.status) return a.status === "open" ? -1 : 1;
		if (byPriority && a.priority !== b.priority) return priorityRank(a.priority) - priorityRank(b.priority);
		return a.title.localeCompare(b.title);
	});
	return {
		tasks: tasks.map((task) => entryOf(task, state.tasks, ctx)),
		categories: [...state.categories.values()].filter((c) => matchesText(c.name, q)),
		habits: [...state.habits.values()]
			.filter((h) => matchesText(h.name, q))
			.sort((a, b) => (a.archivedAt === null) !== (b.archivedAt === null) ? (a.archivedAt === null ? -1 : 1) : a.name.localeCompare(b.name)),
	};
}

/** The notes linked to tasks: note path to the IDs of the tasks that link it. Note text is not part of it. */
export type LinkedNotes = ReadonlyMap<string, readonly ID[]>;

/**
 * One pass over the tasks, grouping them by description-note path. When `previous` holds the same paths with
 * the same task IDs, it is returned as is, so a caller can tell by identity that the links did not change.
 */
export function linkedNotes(tasks: DbData["tasks"], previous?: LinkedNotes): LinkedNotes {
	const byPath = new Map<string, ID[]>();
	for (const t of tasks.values()) {
		if (t.descriptionNote === null) continue;
		const list = byPath.get(t.descriptionNote.path);
		if (list === undefined) byPath.set(t.descriptionNote.path, [t.id]);
		else list.push(t.id);
	}
	if (previous === undefined || previous.size !== byPath.size) return byPath;
	for (const [path, ids] of byPath) {
		const before = previous.get(path);
		if (before === undefined || before.length !== ids.length || before.some((id, i) => id !== ids[i])) return byPath;
	}
	return previous;
}

/**
 * "Also search description notes": reads each linked note with the host's cached read and returns the
 * matching task IDs. Note text is never stored. Reading stops once `signal` is aborted (the result is then partial).
 */
export async function searchNoteContent(byPath: LinkedNotes, query: string, notes: NotePort, signal?: AbortSignal): Promise<Set<ID>> {
	const q = query.trim().toLocaleLowerCase();
	const result = new Set<ID>();
	if (q.length === 0) return result;
	for (const [path, ids] of byPath) {
		if (signal?.aborted) break;
		const text = await notes.read(path);
		if (text !== null && text.toLocaleLowerCase().includes(q)) for (const id of ids) result.add(id);
	}
	return result;
}
