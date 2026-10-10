import { type CompletedScope, completedGroup, inCompletedScope, isKeptUnderParent } from "../domain/completed";
import {
	type DoneOccurrence,
	type GroupTone,
	type ListEntry,
	type QueryContext,
	type TaskFilter,
	arrangeHierarchy,
	categoryEntries,
	completedEntries,
	entryOf,
	filterTasks,
	inUpcoming,
	isDueByToday,
	isOverdue,
	keyDate,
	matchesOccurrence,
	matchesText,
	occurrenceDay,
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
import { compareSortKeys } from "../domain/sortKey";
import { isUnderTag, tagDisplayPath, tagPrefixes } from "../domain/tags";
import { addDays } from "../domain/time";
import { compareTasksBySortKey, isOpen } from "../domain/tasks";
import { type Category, type Habit, type ID, INBOX_ID, type LocalDate, type Priority, type Task } from "../domain/types";
import type { DbData } from "../persistence/schema";
import type { NotePort } from "./ports";

// View selectors. Pure reads over the store state.

export type TaskView =
	| { kind: "today" }
	| { kind: "upcoming" }
	| { kind: "inbox" }
	| { kind: "category"; id: ID }
	| { kind: "tag"; key: string }
	| { kind: "completed" }
	| { kind: "trash" };

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
			return state.categories.get(INBOX_ID)?.name ?? "Inbox";
		case "category":
			return state.categories.get(view.id)?.name ?? "List";
		case "tag":
			return `@${tagDisplayPath(state.tags, view.key)}`;
		case "completed":
			return "Completed";
		case "trash":
			return "Trash";
	}
}

/** Presets for tasks added while a view is shown (category, Today's date, tag). */
export function viewPreset(view: TaskView, ctx: QueryContext, state?: DbData): { addCategoryId: ID; addDate: LocalDate | null; addTagKeys: string[] } {
	return {
		addCategoryId: view.kind === "category" ? view.id : INBOX_ID,
		addDate: view.kind === "today" ? ctx.today : null,
		// An implicit parent tag has no record to preset, so it presets nothing.
		addTagKeys: view.kind === "tag" && (state === undefined || state.tags.has(view.key)) ? [view.key] : [],
	};
}

/** Today: an Overdue group (a date before today) and a Today group; empty groups are omitted. */
function todayGroups(entries: ListEntry[], ctx: QueryContext, ordered: (e: ListEntry[]) => ListEntry[]): ViewGroup[] {
	const overdue: ListEntry[] = [];
	const rest: ListEntry[] = [];
	for (const e of entries) (isOverdue(e.task, ctx) ? overdue : rest).push(e);
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

/**
 * The open rows of a view. A completed task stays among them when it is in `held` (completed a moment
 * ago, waiting for its check animation to end) or is a subtask whose open parent's row is shown too;
 * any other completed subtask is in the Completed group.
 */
export function buildView(
	state: DbData,
	view: TaskView,
	ctx: QueryContext,
	filter: TaskFilter,
	text: string,
	held: ReadonlySet<ID> = NO_IDS,
	groupBy?: GroupBy,
): ViewGroup[] {
	return openGroups(state, view, ctx, filter, text, held, groupBy, prepare(state, view, ctx, filter, text, held));
}

/** What a view's open rows and Completed group both start from: the filtered tasks and the open rows shown. */
interface Prepared {
	tasks: Task[];
	/** The IDs of the open rows shown (held tasks included), or null where the view has no Completed group. */
	rows: Set<ID> | null;
}

function prepare(state: DbData, view: TaskView, ctx: QueryContext, filter: TaskFilter, text: string, held: ReadonlySet<ID>): Prepared {
	const tasks = filterTasks(state.tasks.values(), filter, text, ctx);
	return { tasks, rows: shownRowIds(state, view, ctx, filter, tasks, held) };
}

function openGroups(
	state: DbData,
	view: TaskView,
	ctx: QueryContext,
	filter: TaskFilter,
	text: string,
	held: ReadonlySet<ID>,
	groupBy: GroupBy | undefined,
	{ tasks, rows }: Prepared,
): ViewGroup[] {
	const shown = rows === null ? null : shownParents(state, tasks, rows);
	return viewGroups(state, view, ctx, filter, tasks, (t) => held.has(t.id) || (shown?.has(t.id) ?? false), groupBy, text);
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

/** The lists in sidebar order: Inbox first, then the others by their sort key. */
function listsInSidebarOrder(state: DbData): Category[] {
	const all = [...state.categories.values()].filter((c) => c.id !== INBOX_ID).sort((a, b) => compareSortKeys(a.sortKey, b.sortKey));
	const inbox = state.categories.get(INBOX_ID);
	return inbox === undefined ? all : [inbox, ...all];
}

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
				return categoryEntries(tasks, byId, ctx, INBOX_ID, keep);
			case "category":
				return categoryEntries(tasks, byId, ctx, view.id, keep);
			case "tag":
				return arrangeHierarchy(tasks.filter((t) => (isOpen(t) || keep(t)) && t.tagKeys.some((k) => isUnderTag(k, view.key))), byId, ctx);
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
			if (view.kind === "today") return todayGroups(rows(), ctx, ordered);
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
			const name = (key: string) => state.tags.get(key)?.displayName ?? key;
			const keys = [...buckets.keys()].filter((k): k is string => k !== null).sort((a, b) => name(a).localeCompare(name(b)));
			const groups: ViewGroup[] = keys.map((k) => ({ key: `tag:${k}`, date: null, label: `@${name(k)}`, entries: ordered(buckets.get(k)!) }));
			const none = buckets.get(null);
			if (none !== undefined) groups.push({ key: "notag", date: null, label: "No tag", entries: ordered(none) });
			return groups;
		}
		case "list": {
			const buckets = bucketize(rows(), (t) => t.categoryId);
			const known = listsInSidebarOrder(state);
			const seen = new Set(known.map((c) => c.id));
			// A list that is missing (not expected after repair) still shows its tasks, last.
			const lists = [
				...known.map((c) => ({ id: c.id, name: c.name })),
				...[...buckets.keys()].filter((id) => !seen.has(id)).map((id) => ({ id, name: "Unknown list" })),
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

/**
 * The IDs of the open rows of the view (held tasks included), or null where the view has no group.
 * A completed subtask is only kept under a parent that is one of them.
 */
function shownRowIds(
	state: DbData,
	view: TaskView,
	ctx: QueryContext,
	filter: TaskFilter,
	tasks: Task[],
	held: ReadonlySet<ID>,
): Set<ID> | null {
	if (completedScope(view) === null) return null;
	const ids = new Set<ID>();
	// The rows are the same whatever the grouping, so the plain one will do.
	for (const g of viewGroups(state, view, ctx, filter, tasks, (t) => held.has(t.id), "none")) for (const e of g.entries) ids.add(e.task.id);
	return ids;
}

/** IDs of the completed subtasks the view keeps among its open rows: their open parent's row is shown. */
function shownParents(state: DbData, tasks: Task[], rows: ReadonlySet<ID>): Set<ID> {
	const kept = new Set<ID>();
	for (const t of tasks) if (isKeptUnderParent(t, state.tasks, rows)) kept.add(t.id);
	return kept;
}

/** The view's Completed group, newest first. Empty where the view has none. */
export function buildCompleted(
	state: DbData,
	view: TaskView,
	ctx: QueryContext,
	filter: TaskFilter,
	text: string,
	held: ReadonlySet<ID> = NO_IDS,
): ListEntry[] {
	if (completedScope(view) === null) return [];
	return completedOf(state, view, ctx, filter, text, held, prepare(state, view, ctx, filter, text, held));
}

function completedOf(
	state: DbData,
	view: TaskView,
	ctx: QueryContext,
	filter: TaskFilter,
	text: string,
	held: ReadonlySet<ID>,
	{ tasks, rows }: Prepared,
): ListEntry[] {
	const scope = completedScope(view);
	if (scope === null) return [];
	return completedGroup(tasks, state.tasks, scope, ctx, held, rows ?? undefined, doneOccurrences(state, ctx, filter, text));
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
): BoardColumn[] {
	// A column's open rows and Completed group start from the same filtered tasks and shown rows: made once.
	const openOf = (p: Prepared, groupBy?: GroupBy): ViewGroup[] => openGroups(state, view, ctx, filter, text, held, groupBy, p);
	const doneOf = (p: Prepared): ListEntry[] => completedOf(state, view, ctx, filter, text, held, p);
	switch (view.kind) {
		case "today": {
			const p = prepare(state, view, ctx, filter, text, held);
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
			const p = prepare(state, view, ctx, filter, text, held);
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
			const p = prepare(state, view, ctx, filter, text, held);
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

/** Open-task counts for the sidebar. */
export function sidebarCounts(state: DbData, ctx: QueryContext): SidebarCounts {
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

/**
 * "Also search description notes": reads each linked note with the host's
 * cached read and returns matching task IDs. Note text is never stored.
 */
export async function searchNoteContent(state: DbData, query: string, notes: NotePort): Promise<Set<ID>> {
	const q = query.trim().toLocaleLowerCase();
	const result = new Set<ID>();
	if (q.length === 0) return result;
	const byPath = new Map<string, ID[]>();
	for (const t of state.tasks.values()) {
		if (t.descriptionNote === null) continue;
		const list = byPath.get(t.descriptionNote.path) ?? [];
		list.push(t.id);
		byPath.set(t.descriptionNote.path, list);
	}
	for (const [path, ids] of byPath) {
		const text = await notes.read(path);
		if (text !== null && text.toLocaleLowerCase().includes(q)) for (const id of ids) result.add(id);
	}
	return result;
}
