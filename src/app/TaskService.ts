import { DomainError, isDomainError } from "../domain/errors";
import type { IdGenerator } from "../domain/ports";
import { keyAfter, keyBetween, rekeyOrder } from "../domain/sortKey";
import { basenameOf, rewriteNotePath, sanitizeNoteName } from "../domain/notes";
import { assertCanBecomeSubtask, compareTasksBySortKey, isOpen, requireDuration, requireTitle, subtasksOf } from "../domain/tasks";
import { currentOccurrence, isSeriesEnded, occurrenceRecordId, restartedSeries, ruleAt, startRecurrence } from "../domain/recurrence";
import { type WallTimeWarning, dateSpecDate, isValidDateSpec, resolveWallTime, todayIn } from "../domain/time";
import {
	type DateSpec,
	type ID,
	INBOX_ID,
	type LocalDate,
	type OccurrenceRecord,
	type Priority,
	type Recurrence,
	type RepeatEnd,
	type RepeatRule,
	type Task,
	type TrashEntry,
	type WeekStart,
	isPriority,
	syncLinkId,
} from "../domain/types";
import {
	MemoryRenameQueue,
	type NotePort,
	type NoteRename,
	type RenameQueuePort,
	type RenameTimers,
	type SettingsPort,
} from "./ports";
import { COMPLETE_OCCURRENCE_LABEL, RecurrenceService, recordsOfTask, requireRepeatEnd, requireRepeatRule, requireTask } from "./RecurrenceService";
import { storableDbId } from "../persistence/schema";
import { TRASH_RETENTION_DAYS } from "./settings";
import { TagService } from "./CategoryService";
import { ListIndex } from "./listIndex";
import type { AppStore } from "./store";
import type { Tx } from "./tx";

// Task commands: tasks, subtasks, description notes and Trash. Every method runs one
// transaction through the store's command queue.

export interface TaskInput {
	title: string;
	categoryId?: ID | null;
	parentId?: ID | null;
	/** The section in the list; a subtask takes its parent's. Must belong to the task's list. */
	sectionId?: ID | null;
	tagKeys?: string[];
	/** Raw names of tags to create in the same transaction if missing. */
	newTags?: string[];
	scheduled?: DateSpec | null;
	deadline?: DateSpec | null;
	plannedDurationMin?: number | null;
	urgent?: boolean;
	important?: boolean;
	/** Defaults to 0 (none). */
	priority?: Priority;
	notePath?: string | null;
	/**
	 * Create the task repeating, in one write (Quick Add). The anchor is the date of `scheduled`, else
	 * today; `scheduled` is then stored as null. Not with `deadline` or `parentId` (InvalidValue).
	 */
	repeat?: { rule: RepeatRule; end?: RepeatEnd } | null;
}

export interface TaskPatch {
	title?: string;
	categoryId?: ID;
	/** A section of the task's (new) list, or null for "No section". Top-level tasks only. */
	sectionId?: ID | null;
	tagKeys?: string[];
	scheduled?: DateSpec | null;
	deadline?: DateSpec | null;
	plannedDurationMin?: number | null;
	urgent?: boolean;
	important?: boolean;
	/** A drop between priority groups sets it together with the position (`place`). */
	priority?: Priority;
}

export interface TaskResult {
	task: Task;
	/** DST adjustments applied to entered times. */
	warnings: WallTimeWarning[];
	/** `update` only: false when the patch resolved to the current values and nothing (no undo entry) was written. */
	changed?: boolean;
	/**
	 * Set by `update` and `place` when a schedule edit re-anchored a repeating task. `date` is the
	 * series' current occurrence after the write; `endCleared` when its end date lay before the new date
	 * and was removed.
	 */
	reanchored?: { date: LocalDate; endCleared: boolean };
}

export const COMPLETE_TASK_LABEL = "Complete task";

export type CompleteResult =
	| {
			kind: "done";
			completed: number;
			/** The store label: "Complete task", or "Complete occurrence" for a repeating task. */
			label: string;
			/** Completing this occurrence ended its series. */
			seriesEnded?: boolean;
	  }
	| { kind: "needs-confirmation"; openSubtasks: number };

export const DST_WARNING_TEXT: Record<WallTimeWarning, string> = {
	"dst-gap": "Adjusted for daylight saving",
	"dst-ambiguous": "Ambiguous time; using first occurrence",
};

/** Validates a date and resolves DST for timed values. */
function normalizeSpec(spec: DateSpec | null, warnings: WallTimeWarning[]): DateSpec | null {
	if (spec === null) return null;
	if (!isValidDateSpec(spec)) throw new DomainError("InvalidValue", "The date is not valid.");
	if (spec.kind === "date") return { kind: "date", date: spec.date };
	const resolved = resolveWallTime(spec.local, spec.tz);
	if (resolved.warning !== null) warnings.push(resolved.warning);
	return { kind: "datetime", local: resolved.local, tz: spec.tz };
}

function requirePriority(value: unknown): Priority {
	if (!isPriority(value)) throw new DomainError("InvalidValue", "Priority must be none, high, medium or low.");
	return value;
}

function requireTags(tx: Tx, keys: string[]): string[] {
	const unique = [...new Set(keys)];
	for (const k of unique) {
		// Tags are created explicitly; a command never creates one silently.
		if (tx.get("tags", k) === undefined) throw new DomainError("NotFound", `The tag "${k}" does not exist.`);
	}
	return unique;
}

function requireCategory(tx: Tx, id: ID): void {
	if (tx.get("categories", id) === undefined) throw new DomainError("NotFound", "The list no longer exists.");
}

/** The section must exist and belong to the list `categoryId`. */
function requireSectionIn(tx: Tx, sectionId: ID, categoryId: ID): void {
	const section = tx.get("sections", sectionId);
	if (section === undefined) throw new DomainError("NotFound", "The section no longer exists.");
	if (section.categoryId !== categoryId) throw new DomainError("InvalidValue", "That section belongs to another list.");
}

const NO_DEADLINE = "A repeating task has no deadline.";

/**
 * A schedule edit of a repeating task edits the series. Null stops it repeating (a plain
 * undated task; its records are kept). A date re-anchors it: the series starts again on that date, in
 * force from it with the rule of that date, whose time and zone follow the spec (a date-only spec makes
 * it all-day). Versions after the new anchor stay; `scheduled` stays null. The move is stamped
 * (`anchoredAt`), so after completion counts from the picked date, not from records resolved before it:
 * moving earlier or later both make the picked date the next one until the next record. A move does not
 * restart a count end (only `countFrom` does). Picking the date and time the series is already due on
 * changes nothing, whatever its anchor. `due` is the current occurrence. When the moved series would
 * have no occurrence left before its end (a date or count), the end is removed in the same write;
 * otherwise the hourly sweep would complete it with no Undo.
 */
function rescheduledSeries(
	rec: Recurrence,
	spec: DateSpec | null,
	zone: string,
	now: string,
	due: LocalDate | null,
	records: readonly OccurrenceRecord[],
	weekStart: WeekStart,
): Recurrence | null {
	if (spec === null) return null;
	const anchor = spec.kind === "datetime" ? spec.local.slice(0, 10) : dateSpecDate(spec, zone);
	if (due === anchor) {
		const dueRule = ruleAt(rec, due);
		const sameTime = spec.kind === "datetime" ? dueRule.time === spec.local.slice(11, 16) && dueRule.tz === spec.tz : dueRule.time === null;
		if (sameTime) return rec;
	}
	const base = ruleAt(rec, anchor);
	const rule =
		spec.kind === "datetime" ? { ...base, time: spec.local.slice(11, 16), tz: spec.tz } : { ...base, time: null, tz: null };
	const versions = [{ effectiveFrom: anchor, rule }, ...rec.versions.filter((v) => v.effectiveFrom > anchor)];
	const moved: Recurrence = { ...rec, anchor, versions, anchoredAt: now };
	if (moved.end.kind !== "never" && isSeriesEnded({ ...moved, endedAt: null }, records, weekStart)) return { ...moved, end: { kind: "never" } };
	return moved;
}

/**
 * Purging tasks for good removes their occurrence records too (a task that stopped repeating keeps
 * its history until then). A live task with the same id keeps them: only a hand-edited file has both.
 */
function removeRecordsOf(tx: Tx, tasks: readonly Task[]): void {
	const ids = new Set(tasks.filter((t) => tx.get("tasks", t.id) === undefined).map((t) => t.id));
	if (ids.size === 0) return;
	for (const r of tx.all("occurrenceRecords")) {
		if (ids.has(r.taskId)) tx.remove("occurrenceRecords", occurrenceRecordId(r.taskId, r.occurrenceDate));
	}
}

/**
 * A purged task that is linked to TickTick keeps its link, marked `pendingDelete`, so the next
 * sync deletes the TickTick copy. Written in the purge's own command; the sync removes the link.
 */
function markPurgedLinks(tx: Tx, tasks: readonly Task[]): void {
	for (const t of tasks) {
		if (tx.get("tasks", t.id) !== undefined) continue;
		const link = tx.get("syncLinks", syncLinkId("task", t.id));
		if (link === undefined || link.pendingDelete === true) continue;
		tx.put("syncLinks", { ...link, pendingDelete: true, modifiedAt: tx.now });
	}
}

/** What a purge does to the tasks it removes for good: their occurrence records go, a TickTick link is marked for deletion. */
function forgetTasks(tx: Tx, tasks: readonly Task[]): void {
	removeRecordsOf(tx, tasks);
	markPurgedLinks(tx, tasks);
}

/**
 * The user linked another note, or unlinked the one TickTick sync created. The sync stops writing that note
 * (`noteBySync` false) and makes no new one (`noteBase` stays, emptied, as the mark). In the same command, so an Undo
 * restores both.
 */
function detachSyncNote(tx: Tx, taskId: ID): void {
	const link = tx.get("syncLinks", syncLinkId("task", taskId));
	if (link === undefined || !link.noteBySync) return;
	const { noteItems: _items, ...rest } = link;
	tx.put("syncLinks", { ...rest, noteBySync: false, noteBase: "", modifiedAt: tx.now });
}

/** A queued rename and, while its caller still waits, how to report its count. */
interface QueuedRename extends NoteRename {
	settle?: { resolve(count: number): void; reject(err: unknown): void };
}

/**
 * Minimum time between two writes of the waiting renames to local storage.
 * A folder rename sends one event per child; without this every event rewrote
 * the whole list.
 */
const RENAME_SAVE_COOLDOWN_MS = 200;

/**
 * Window timers in Obsidian (popout-safe). Without a window (unit tests) there
 * is no throttle window: the writes of one synchronous burst are still coalesced.
 */
const defaultTimers: RenameTimers = {
	set: (fn, ms) => {
		if (typeof window === "undefined") {
			queueMicrotask(fn);
			return "microtask";
		}
		return window.setTimeout(fn, ms);
	},
	clear: (handle) => {
		if (typeof window !== "undefined" && typeof handle === "number") window.clearTimeout(handle);
	},
};

export class TaskService {
	/**
	 * Every rename, in the order the vault sent them. Each is applied
	 * in its own transaction; while read-only they wait here and are replayed
	 * once writable. Renames that cannot be applied are mirrored to `renameQueue`
	 * so a reload does not lose them; renames that apply at once never touch it.
	 */
	private pendingRenames: QueuedRename[] = [];
	private draining = false;
	private readonly drainWaiters: (() => void)[] = [];
	/** The database id whose saved renames were loaded into `pendingRenames` (null: none yet). */
	private loadedFor: string | null = null;
	/** Whether `renameQueue` currently holds a non-empty list for this database. */
	private persisted = false;
	/** The list `renameQueue` holds for this database, serialized; null when unknown. A repeat write of it is skipped. */
	private storedKey: string | null = null;
	/** Set while writes are cooling down; a save requested meanwhile waits for the timer. */
	private saveTimer: unknown = null;
	/** Bumped when the timer is cancelled, so a callback that already fired for it does nothing. */
	private saveTimerGen = 0;
	private saveWanted = false;
	/** The tasks and open-task counts per list (the TickTick sync reads it, and the synced-list cap checks it). */
	readonly lists: ListIndex;

	constructor(
		private readonly store: AppStore,
		private readonly ids: IdGenerator,
		private readonly settings: SettingsPort,
		private readonly notes: NotePort,
		private readonly renameQueue: RenameQueuePort = new MemoryRenameQueue(),
		private readonly timers: RenameTimers = defaultTimers,
		/** Completing a repeating task completes its occurrence. */
		readonly recurrence: RecurrenceService = new RecurrenceService(store, settings),
	) {
		this.lists = new ListIndex(store);
		// "status" fires when the store becomes writable again; "changed" covers reloads.
		const replay = () => void this.drainRenames();
		store.bus.on("status", replay);
		store.bus.on("changed", replay);
	}

	private nextSortKey(tx: Tx, categoryId: ID, parentId: ID | null): string {
		const keys: string[] = [];
		for (const t of tx.all("tasks")) if (t.categoryId === categoryId && t.parentId === parentId) keys.push(t.sortKey);
		return keyAfter(keys);
	}

	/** A title alone creates a task in Inbox. No file is created. */
	create(input: TaskInput): Promise<TaskResult> {
		return this.runCapped("Create task", (tx) => this.createIn(tx, input));
	}

	/**
	 * A command that may add open tasks to a list: refused when that list is synced with TickTick and would pass 999
	 * open tasks. The `*In` methods are not checked: the sync writes through them, and a pull is never
	 * refused (TickTick enforces its own limit).
	 */
	private runCapped<T>(label: string, fn: (tx: Tx) => T): Promise<T> {
		return this.store.run(label, (tx) => {
			const result = fn(tx);
			this.lists.assertSyncedRoom(tx);
			return result;
		});
	}

	/**
	 * `create` inside the caller's transaction (the TickTick sync writes many tasks as one command).
	 * `sortKey` replaces the end-of-list key, for callers that place many tasks at once.
	 */
	createIn(tx: Tx, input: TaskInput, sortKey?: string): TaskResult {
		const warnings: WallTimeWarning[] = [];
		const title = requireTitle(input.title);
		let categoryId = input.categoryId ?? INBOX_ID;
		const parentId = input.parentId ?? null;
		let sectionId: ID | null = input.sectionId ?? null;
		if (parentId !== null) {
			const parent = requireTask(tx, parentId);
			if (parent.parentId !== null) {
				throw new DomainError("SubtaskDepth", "Only one subtask level is supported.");
			}
			// A subtask always shares its parent's category.
			categoryId = parent.categoryId;
			// And its section.
			sectionId = parent.sectionId;
		}
		requireCategory(tx, categoryId);
		if (sectionId !== null) requireSectionIn(tx, sectionId, categoryId);
		const tagKeys = [...(input.tagKeys ?? [])];
		for (const raw of input.newTags ?? []) tagKeys.push(TagService.createIn(tx, raw).key);
		let scheduled = normalizeSpec(input.scheduled ?? null, warnings);
		const deadline = normalizeSpec(input.deadline ?? null, warnings);
		let recurrence: Recurrence | null = null;
		if (input.repeat !== undefined && input.repeat !== null) {
			// Quick Add creates a repeating task in one write; its date becomes the anchor.
			if (parentId !== null) throw new DomainError("InvalidValue", "A subtask cannot repeat.");
			if (deadline !== null) throw new DomainError("InvalidValue", NO_DEADLINE);
			const rule = requireRepeatRule(input.repeat.rule, this.settings.weekStart());
			const end = input.repeat.end === undefined ? undefined : requireRepeatEnd(input.repeat.end);
			const zone = this.settings.zone();
			recurrence = startRecurrence(scheduled, rule, end, todayIn(zone, this.store.clock), zone, this.settings.weekStart()).recurrence;
			scheduled = null;
		}
		const task: Task = {
			id: this.ids(),
			title,
			descriptionNote: input.notePath ? { path: input.notePath, linkedAt: tx.now } : null,
			categoryId,
			tagKeys: requireTags(tx, tagKeys),
			parentId,
			sectionId,
			scheduled,
			deadline,
			plannedDurationMin: requireDuration(input.plannedDurationMin ?? null),
			urgent: input.urgent ?? false,
			important: input.important ?? false,
			priority: requirePriority(input.priority ?? 0),
			status: "open",
			completedAt: null,
			recurrence,
			sortKey: sortKey ?? this.nextSortKey(tx, categoryId, parentId),
			createdAt: tx.now,
			modifiedAt: tx.now,
		};
		tx.put("tasks", task);
		return { task, warnings };
	}

	/** Applies `patch` to the task `id` in `tx` (subtasks follow a category move) and returns the new record, not yet put. */
	private patched(
		tx: Tx,
		id: ID,
		patch: TaskPatch,
		warnings: WallTimeWarning[],
	): { current: Task; next: Task; reanchored?: TaskResult["reanchored"] } {
		const current = requireTask(tx, id);
		const next: Task = { ...current };
		let reanchored: TaskResult["reanchored"];
		if (patch.title !== undefined) next.title = requireTitle(patch.title);
		if (patch.tagKeys !== undefined) next.tagKeys = requireTags(tx, patch.tagKeys);
		if (patch.scheduled !== undefined) {
			const spec = normalizeSpec(patch.scheduled, warnings);
			// The schedule of a repeating task is its series.
			if (current.recurrence !== null) {
				const zone = this.settings.zone();
				const records = recordsOfTask(tx, id);
				const ws = this.settings.weekStart();
				const today = todayIn(zone, this.store.clock);
				const due = currentOccurrence(current, records, today, ws);
				next.recurrence = rescheduledSeries(current.recurrence, spec, zone, tx.now, due, records, ws);
				if (next.recurrence !== null && next.recurrence !== current.recurrence) {
					const after = currentOccurrence(next, records, today, ws);
					reanchored = {
						date: after ?? next.recurrence.anchor,
						endCleared: current.recurrence.end.kind !== "never" && next.recurrence.end.kind === "never",
					};
				}
			} else next.scheduled = spec;
		}
		if (patch.deadline !== undefined) {
			next.deadline = normalizeSpec(patch.deadline, warnings);
			if (next.deadline !== null && next.recurrence !== null) throw new DomainError("InvalidValue", NO_DEADLINE);
		}
		if (patch.plannedDurationMin !== undefined) next.plannedDurationMin = requireDuration(patch.plannedDurationMin);
		if (patch.urgent !== undefined) next.urgent = patch.urgent;
		if (patch.important !== undefined) next.important = patch.important;
		if (patch.priority !== undefined) next.priority = requirePriority(patch.priority);
		if (patch.categoryId !== undefined && patch.categoryId !== current.categoryId) {
			if (current.parentId !== null) {
				throw new DomainError("SubtaskCategory", "A subtask always stays in its parent's list.");
			}
			requireCategory(tx, patch.categoryId);
			next.categoryId = patch.categoryId;
			next.sortKey = this.nextSortKey(tx, patch.categoryId, null);
			// A move to another list clears the section (a section given in the same patch is applied below).
			next.sectionId = null;
		}
		if (patch.sectionId !== undefined && patch.sectionId !== next.sectionId) {
			if (current.parentId !== null) {
				throw new DomainError("InvalidValue", "A subtask always stays in its parent's section.");
			}
			if (patch.sectionId !== null) requireSectionIn(tx, patch.sectionId, next.categoryId);
			next.sectionId = patch.sectionId;
		}
		if (current.parentId === null && (next.categoryId !== current.categoryId || next.sectionId !== current.sectionId)) {
			// Subtasks follow their parent's list and section in the same write.
			for (const sub of subtasksOf(tx.all("tasks"), id)) {
				tx.put("tasks", { ...sub, categoryId: next.categoryId, sectionId: next.sectionId, modifiedAt: tx.now });
			}
		}
		return reanchored === undefined ? { current, next } : { current, next, reanchored };
	}

	/** A parent's category move takes its subtasks along in the same write. */
	update(id: ID, patch: TaskPatch): Promise<TaskResult> {
		return this.runCapped("Edit task", (tx) => this.updateIn(tx, id, patch));
	}

	/** `update` inside the caller's transaction. */
	updateIn(tx: Tx, id: ID, patch: TaskPatch): TaskResult {
		const warnings: WallTimeWarning[] = [];
		const { current, next, reanchored } = this.patched(tx, id, patch, warnings);
		if (JSON.stringify(next) === JSON.stringify(current)) return { task: current, warnings, changed: false };
		next.modifiedAt = tx.now;
		tx.put("tasks", next);
		return reanchored === undefined ? { task: next, warnings, changed: true } : { task: next, warnings, changed: true, reanchored };
	}

	/**
	 * Puts `id` at its place in `order`, the full ordered list of its siblings after a drop
	 * (all with the same parent); `id` must be in it. One run ("Move task"), so one undo entry. `id`
	 * gets a key strictly between its neighbours. When the other keys in `order` are not strictly
	 * ascending (equal keys from different lists), every task in `order` gets a new ascending key in
	 * the same run, inside the open interval between the nearest other task keys below and above `order`. `patch` (e.g. a new `scheduled`) is applied in the same run.
	 * `changed` is false when nothing was written.
	 */
	place(id: ID, order: ID[], patch: TaskPatch = {}): Promise<TaskResult> {
		return this.runCapped("Move task", (tx) => {
			if (!order.includes(id)) throw new DomainError("InvalidValue", "The task is not in the order.");
			if (new Set(order).size !== order.length) throw new DomainError("InvalidValue", "The order lists a task twice.");
			const tasks = order.map((oid) => requireTask(tx, oid));
			const parentId = tasks[0]!.parentId;
			if (tasks.some((t) => t.parentId !== parentId)) {
				throw new DomainError("InvalidValue", "Only siblings with the same parent can be reordered together.");
			}
			const warnings: WallTimeWarning[] = [];
			const { current, next, reanchored } = this.patched(tx, id, patch, warnings);
			const i = order.indexOf(id);
			const sorted = tasks.every((t, n) => n === 0 || compareTasksBySortKey(tasks[n - 1]!, t) <= 0);
			const rewritten = new Map<ID, string>();
			// A category move of a lone task keeps the end-of-category key that `patched` gave it.
			const movedAlone = order.length === 1 && next.categoryId !== current.categoryId;
			if (!movedAlone && (!sorted || next.sortKey !== current.sortKey)) {
				// Rebalancing stays inside (lo, hi): lo is the largest task key below the order's smallest key, hi the
				// smallest above its largest, so the tasks keep their place relative to every other task in every view.
				const inOrder = new Set(order);
				const placed = rekeyOrder(tasks.map((t) => t.sortKey), i, tx.map("tasks").values(), (t) => inOrder.has(t.id));
				order.forEach((oid, n) => rewritten.set(oid, placed[n]!));
			}
			let result: Task = current;
			let changed = false;
			for (const t of tasks) {
				const base = t.id === id ? next : t;
				const sortKey = rewritten.get(t.id) ?? base.sortKey;
				const record: Task = { ...base, sortKey };
				if (JSON.stringify(record) === JSON.stringify(t)) continue;
				record.modifiedAt = tx.now;
				tx.put("tasks", record);
				changed = true;
				if (t.id === id) result = record;
			}
			return reanchored === undefined ? { task: result, warnings, changed } : { task: result, warnings, changed, reanchored };
		});
	}

	/** Changes only `priority` (and modifiedAt); urgent and important are never touched. */
	setPriority(id: ID, priority: Priority): Promise<Task> {
		return this.store.run("Set priority", (tx) => {
			const current = requireTask(tx, id);
			const next = requirePriority(priority);
			if (current.priority === next) return current;
			const task: Task = { ...current, priority: next, modifiedAt: tx.now };
			tx.put("tasks", task);
			return task;
		});
	}

	/**
	 * With open subtasks the caller must confirm first;
	 * completing a subtask never completes the parent.
	 */
	complete(id: ID, options: { includeSubtasks?: boolean } = {}): Promise<CompleteResult> {
		// A repeating task completes its occurrence (one entry point for the UI); its subtasks come back
		// unchecked, so there is nothing to confirm. Decided before the run, because the run's label is.
		const seen = this.store.state.tasks.get(id);
		if (seen?.recurrence != null && seen.recurrence.endedAt === null && seen.status === "open") {
			return this.store.run(COMPLETE_OCCURRENCE_LABEL, (tx): CompleteResult => {
				const r = this.recurrence.completeIn(tx, id);
				return { kind: "done", completed: 1, label: r.label, seriesEnded: r.seriesEnded };
			});
		}
		return this.store.run(COMPLETE_TASK_LABEL, (tx): CompleteResult => {
			const task = requireTask(tx, id);
			// A repeat set by a write queued before this one; completing the whole task would end the
			// series without its records. The caller completes the occurrence instead.
			// A series already ended (`endedAt`) but left open by a hand edit or sync completes as a plain task.
			if (task.recurrence !== null && task.recurrence.endedAt === null && isOpen(task)) {
				throw new DomainError("InvalidValue", "This task repeats now; complete it again.");
			}
			const openSubs = subtasksOf(tx.all("tasks"), id).filter(isOpen);
			if (openSubs.length > 0 && options.includeSubtasks !== true) {
				return { kind: "needs-confirmation", openSubtasks: openSubs.length };
			}
			let completed = 0;
			for (const t of [task, ...openSubs]) {
				if (!isOpen(t)) continue;
				this.completeOneIn(tx, t.id);
				completed++;
			}
			return { kind: "done", completed, label: COMPLETE_TASK_LABEL };
		});
	}

	/** Completes one plain task, its subtasks left as they are (each synced task has its own status). */
	completeOneIn(tx: Tx, id: ID): Task {
		const task = requireTask(tx, id);
		if (!isOpen(task)) return task;
		const next: Task = { ...task, status: "completed", completedAt: tx.now, modifiedAt: tx.now };
		tx.put("tasks", next);
		return next;
	}

	/** Reopening clears status and completedAt; subtasks stay as they are. */
	reopen(id: ID): Promise<Task> {
		return this.runCapped("Reopen task", (tx) => this.reopenIn(tx, id));
	}

	/** `reopen` inside the caller's transaction. */
	reopenIn(tx: Tx, id: ID): Task {
		const task = requireTask(tx, id);
		if (isOpen(task)) return task;
		const next: Task = { ...task, status: "open", completedAt: null, modifiedAt: tx.now };
		if (task.recurrence !== null) {
			// Reopening an ended series makes it repeat again. When its end is still reached (count or
			// date) the end becomes "never", or the series would have no occurrence to show.
			let rec: Recurrence = { ...task.recurrence, endedAt: null };
			if (isSeriesEnded(rec, recordsOfTask(tx, id), this.settings.weekStart())) rec = { ...rec, end: { kind: "never" } };
			next.recurrence = rec;
		}
		tx.put("tasks", next);
		return next;
	}

	/** Make a task a subtask of `parentId`, or top-level with null. */
	setParent(id: ID, parentId: ID | null): Promise<Task> {
		return this.runCapped("Move task", (tx) => this.setParentIn(tx, id, parentId));
	}

	/** `setParent` inside the caller's transaction. */
	setParentIn(tx: Tx, id: ID, parentId: ID | null): Task {
		const task = requireTask(tx, id);
		if (task.parentId === parentId) return task;
		let next: Task;
		if (parentId === null) {
			next = { ...task, parentId: null, sortKey: this.nextSortKey(tx, task.categoryId, null), modifiedAt: tx.now };
		} else {
			const parent = requireTask(tx, parentId);
			assertCanBecomeSubtask(task, parent, tx.all("tasks"));
			if (task.recurrence !== null) throw new DomainError("InvalidValue", "A repeating task cannot be a subtask.");
			next = {
				...task,
				parentId,
				categoryId: parent.categoryId,
				sectionId: parent.sectionId,
				sortKey: this.nextSortKey(tx, parent.categoryId, parentId),
				modifiedAt: tx.now,
			};
		}
		tx.put("tasks", next);
		return next;
	}

	/** New IDs for the copy and its subtasks; fields and note reference are copied. */
	duplicate(id: ID): Promise<Task> {
		return this.runCapped("Duplicate task", (tx) => {
			const source = requireTask(tx, id);
			// The copy goes right after its source: between it and the next sibling key, if any.
			let nextKey: string | null = null;
			for (const t of tx.map("tasks").values()) {
				if (t.categoryId !== source.categoryId || t.parentId !== source.parentId || t.sortKey <= source.sortKey) continue;
				if (nextKey === null || t.sortKey < nextKey) nextKey = t.sortKey;
			}
			const copy = (t: Task, patch: Partial<Task>): Task => ({
				...t,
				id: this.ids(),
				status: "open",
				completedAt: null,
				tagKeys: [...t.tagKeys],
				descriptionNote: t.descriptionNote === null ? null : { path: t.descriptionNote.path, linkedAt: tx.now },
				createdAt: tx.now,
				modifiedAt: tx.now,
				...patch,
			});
			// A copy of a repeating task starts at the source's current or next occurrence, never
			// overdue, with only the rule in force then, no history and not ended.
			const recurrence = source.recurrence === null ? null : this.copiedSeries(tx, source as Task & { recurrence: Recurrence });
			const top = copy(source, { sortKey: keyBetween(source.sortKey, nextKey), recurrence });
			tx.put("tasks", top);
			if (source.parentId === null) {
				for (const sub of subtasksOf(tx.all("tasks"), source.id)) tx.put("tasks", copy(sub, { parentId: top.id }));
			}
			return top;
		});
	}

	private copiedSeries(tx: Tx, source: Task & { recurrence: Recurrence }): Recurrence {
		const today = todayIn(this.settings.zone(), this.store.clock);
		return restartedSeries(source, recordsOfTask(tx, source.id), today, this.settings.weekStart());
	}

	/** Subtask count (open and completed), for the delete and complete prompts. */
	subtaskCount(id: ID): number {
		let n = 0;
		for (const t of this.store.state.tasks.values()) if (t.parentId === id) n++;
		return n;
	}

	/** The task and its subtasks move to Trash as one batch. The note is untouched. */
	delete(id: ID): Promise<TrashEntry> {
		return this.store.run("Delete task", (tx) => this.deleteIn(tx, id));
	}

	/** `delete` inside the caller's transaction (TickTick deletions go to Trash). */
	deleteIn(tx: Tx, id: ID): TrashEntry {
		const task = requireTask(tx, id);
		const subs = subtasksOf(tx.all("tasks"), id);
		const entry: TrashEntry = { batchId: this.ids(), deletedAt: tx.now, tasks: [task, ...subs] };
		for (const t of entry.tasks) tx.remove("tasks", t.id);
		tx.put("trash", entry);
		return entry;
	}

	/** Restores a batch. A missing parent or category falls back to top-level / Inbox. */
	restore(batchId: ID): Promise<number> {
		return this.runCapped("Restore from trash", (tx) => {
			const entry = tx.get("trash", batchId);
			if (entry === undefined) throw new DomainError("NotFound", "The trash entry no longer exists.");
			const restoredIds = new Set(entry.tasks.map((t) => t.id));
			for (const t of entry.tasks) {
				let next: Task = t;
				if (tx.get("tasks", t.id) !== undefined) next = { ...next, id: this.ids() };
				if (next.parentId !== null && !restoredIds.has(next.parentId)) {
					const parent = tx.get("tasks", next.parentId);
					if (parent === undefined || parent.parentId !== null) next = { ...next, parentId: null };
					else next = { ...next, categoryId: parent.categoryId, sectionId: parent.sectionId };
				}
				if (tx.get("categories", next.categoryId) === undefined) next = { ...next, categoryId: INBOX_ID };
				// A section deleted since, or not in the list the task returns to, becomes No section.
				if (next.sectionId !== null && tx.get("sections", next.sectionId)?.categoryId !== next.categoryId) {
					next = { ...next, sectionId: null };
				}
				// A tag deleted since (or never known here) is dropped, never recreated.
				const tagKeys = next.tagKeys.filter((k) => tx.get("tags", k) !== undefined);
				if (tagKeys.length !== next.tagKeys.length) next = { ...next, tagKeys };
				tx.put("tasks", next);
			}
			tx.remove("trash", batchId);
			return entry.tasks.length;
		});
	}

	/** Removes the records for good. Notes are never touched. */
	purge(batchId: ID): Promise<void> {
		return this.store.run(
			"Delete permanently",
			(tx) => {
				const entry = tx.get("trash", batchId);
				tx.remove("trash", batchId);
				if (entry !== undefined) forgetTasks(tx, entry.tasks);
			},
			{ undoable: false },
		);
	}

	emptyTrash(): Promise<number> {
		return this.store.run(
			"Empty trash",
			(tx) => {
				const all = tx.all("trash");
				for (const e of all) tx.remove("trash", e.batchId);
				forgetTasks(tx, all.flatMap((e) => e.tasks));
				return all.length;
			},
			{ undoable: false },
		);
	}

	/** Purges trash entries older than 30 days. */
	purgeExpired(): Promise<number> {
		const cutoff = new Date(this.store.clock.now().getTime() - TRASH_RETENTION_DAYS * 24 * 3600 * 1000).toISOString();
		const expired = [...this.store.state.trash.values()].filter((e) => e.deletedAt < cutoff);
		if (expired.length === 0 || this.store.readOnlyState !== null) return Promise.resolve(0);
		return this.store.run(
			"Purge trash",
			(tx) => {
				for (const e of expired) tx.remove("trash", e.batchId);
				forgetTasks(tx, expired.flatMap((e) => e.tasks));
				return expired.length;
			},
			{ undoable: false },
		);
	}

	// -- description notes ---------------------------------------------------

	/** Stores only the path and a link timestamp. A note TickTick sync wrote is no longer written. */
	linkNote(id: ID, path: string): Promise<Task> {
		return this.store.run("Link note", (tx) => {
			detachSyncNote(tx, id);
			return this.linkNoteIn(tx, id, path);
		});
	}

	/** `linkNote` inside a running command: the path and a link timestamp. Also used by TickTick sync. */
	linkNoteIn(tx: Tx, id: ID, path: string): Task {
		const task = requireTask(tx, id);
		const next: Task = { ...task, descriptionNote: { path, linkedAt: tx.now }, modifiedAt: tx.now };
		tx.put("tasks", next);
		return next;
	}

	/** Unlinking never touches the file. TickTick sync stops writing a note it created. */
	unlinkNote(id: ID): Promise<Task> {
		return this.store.run("Unlink note", (tx) => {
			const task = requireTask(tx, id);
			detachSyncNote(tx, id);
			const next: Task = { ...task, descriptionNote: null, modifiedAt: tx.now };
			tx.put("tasks", next);
			return next;
		});
	}

	/**
	 * Explicit action only. Creates an empty note named from the title and links it.
	 * Checks first that the link can be saved, so a read-only database never leaves an orphan note.
	 */
	async createDescriptionNote(id: ID): Promise<string> {
		const task = this.store.state.tasks.get(id);
		if (task === undefined) throw new DomainError("NotFound", "The task no longer exists.");
		if (this.store.readOnlyState !== null) {
			throw new DomainError("ReadOnly", "The database is read-only until the problem shown in the banner is resolved.");
		}
		const path = await this.notes.createNote(this.settings.noteFolder(), sanitizeNoteName(task.title));
		await this.linkNote(id, path);
		return path;
	}

	/**
	 * Rewrite every reference after a rename or move inside Obsidian. Idempotent.
	 * Renames are applied one at a time, in the order the vault sent them, each evaluated
	 * inside its own transaction, so a rename that arrives before the previous one has
	 * committed still sees its result (A → B, then B → Folder/B). While the database is
	 * read-only they wait and are replayed once it is writable, because the vault never
	 * sends the event again. Resolves with the number of rewritten references, or 0 when
	 * the rename is waiting.
	 */
	rewriteNotePaths(oldPath: string, newPath: string, isFolder: boolean): Promise<number> {
		return new Promise((resolve, reject) => {
			this.loadSavedRenames();
			// Not saved here: a rename that applies at once never needs storage. The
			// drain saves what it could not apply (see `settleStorage`).
			this.pendingRenames.push({ oldPath, newPath, isFolder, settle: { resolve, reject } });
			void this.drainRenames();
		});
	}

	/**
	 * Replays the renames an earlier session queued for this database (for example
	 * while its schema was newer than this plugin). Call once the store is open.
	 */
	resumeRenames(): Promise<void> {
		this.loadSavedRenames();
		return this.drainRenames();
	}

	/**
	 * The id renames are stored under, or null while the store only holds a
	 * placeholder (a damaged database that was never known): that id names no
	 * database, so nothing may be saved or loaded under it.
	 */
	private knownDbId(): string | null {
		return storableDbId(this.store.state.meta.dbId, this.store.readOnlyState !== null);
	}

	/**
	 * Loads the renames an earlier session saved for the current database. Runs
	 * once per database id, so a reload that gives the store its real id (a file
	 * repaired outside Obsidian, a restore) picks them up, and a repeat call changes
	 * nothing. Renames already waiting in memory stay queued and now belong to this id.
	 */
	private loadSavedRenames(): void {
		const id = this.knownDbId();
		if (id === null || id === this.loadedFor) return;
		this.loadedFor = id;
		// Saved renames are older than any seen in this session, so they go first.
		const saved = this.renameQueue.load(id);
		this.persisted = saved.length > 0;
		this.storedKey = JSON.stringify(saved);
		this.pendingRenames.unshift(...saved);
	}

	/** Writes the waiting renames now, or clears the entry when none wait. */
	private saveRenames(): void {
		const id = this.knownDbId();
		// Kept in memory until the real id is known; the drain that follows the reload saves them.
		if (id === null) return;
		this.saveWanted = false;
		const renames = this.pendingRenames.map(({ oldPath, newPath, isFolder }) => ({ oldPath, newPath, isFolder }));
		if (renames.length === 0 && !this.persisted) return;
		const key = JSON.stringify(renames);
		if (key === this.storedKey) return;
		this.renameQueue.save(id, renames);
		this.storedKey = key;
		this.persisted = renames.length > 0;
	}

	/**
	 * Saving the queue is best effort during a drain: if local storage fails
	 * (quota, disabled), the renames stay queued in memory and the drain still
	 * settles its callers. No retry is scheduled: a failing storage must not
	 * spin the cooldown (without a window the cooldown is a microtask). The
	 * next drain, or `flushRenames` on close and quit, tries again.
	 */
	private trySaveRenames(): void {
		try {
			this.saveRenames();
		} catch {
			this.storedKey = null;
		}
	}

	/**
	 * Called when a drain stops. Waiting renames are written at most once per
	 * cooldown (the first at once, later ones coalesced), so a burst costs a
	 * handful of writes instead of one per event. An empty queue clears the entry.
	 */
	private settleStorage(): void {
		if (this.pendingRenames.length === 0) {
			this.trySaveRenames();
			return;
		}
		if (this.saveTimer !== null) {
			this.saveWanted = true;
			return;
		}
		this.trySaveRenames();
		this.startCooldown();
	}

	private startCooldown(): void {
		const gen = this.saveTimerGen;
		this.saveTimer = this.timers.set(() => {
			if (gen !== this.saveTimerGen) return;
			this.saveTimer = null;
			if (!this.saveWanted) return;
			this.trySaveRenames();
			this.startCooldown();
		}, RENAME_SAVE_COOLDOWN_MS);
	}

	/**
	 * Writes every rename not yet applied and stops the timer; for a host that is
	 * shutting down. Renames waiting behind a running drain are included even though
	 * no write was asked for (writable renames are otherwise never stored), so a close
	 * in the middle of a burst loses none; the next open replays them, idempotently.
	 * Nothing is written under the placeholder id (see `saveRenames`).
	 */
	flushRenames(): void {
		if (this.saveTimer !== null) this.timers.clear(this.saveTimer);
		this.saveTimer = null;
		this.saveTimerGen++;
		// Renames an earlier session stored must be merged in before the list is
		// written, or this write would replace them.
		this.loadSavedRenames();
		this.saveRenames();
	}

	/** Applies queued renames in order while writable; resolves when the queue is empty or blocked. */
	private drainRenames(): Promise<void> {
		// A reload may have given the store a different (real) database id.
		this.loadSavedRenames();
		if (this.draining) return new Promise((resolve) => this.drainWaiters.push(resolve));
		return this.runDrain();
	}

	private async runDrain(): Promise<void> {
		this.draining = true;
		try {
			for (let next = this.pendingRenames[0]; next !== undefined; next = this.pendingRenames[0]) {
				if (this.store.readOnlyState !== null) break;
				let count = 0;
				let failure: { err: unknown } | null = null;
				try {
					count = await this.applyRename(next);
				} catch (err) {
					// Read-only since it was queued: it waits for the next writable state.
					if (isDomainError(err, "ReadOnly")) break;
					failure = { err };
				}
				this.pendingRenames.splice(this.pendingRenames.indexOf(next), 1);
				if (failure === null) next.settle?.resolve(count);
				else next.settle?.reject(failure.err);
			}
		} finally {
			this.draining = false;
			this.settleStorage();
			// Callers of renames that now wait for a writable database get 0.
			for (const r of this.pendingRenames) {
				r.settle?.resolve(0);
				delete r.settle;
			}
			for (const resolve of this.drainWaiters.splice(0)) resolve();
		}
	}

	private applyRename({ oldPath, newPath, isFolder }: NoteRename): Promise<number> {
		// No pre-check against the current state: the rename must see the result of
		// every command queued before it. A no-op commits nothing.
		return this.store.run(
			"Track note rename",
			(tx) => {
				let count = 0;
				const rewrite = (t: Task): Task => {
					if (t.descriptionNote === null) return t;
					const path = rewriteNotePath(t.descriptionNote.path, oldPath, newPath, isFolder);
					if (path === null) return t;
					count++;
					// The ID and modifiedAt stay: a rename is not an edit of the task.
					return { ...t, descriptionNote: { ...t.descriptionNote, path } };
				};
				for (const t of tx.all("tasks")) {
					const next = rewrite(t);
					if (next !== t) tx.put("tasks", next);
				}
				for (const e of tx.all("trash")) {
					const tasks = e.tasks.map(rewrite);
					if (tasks.some((t, i) => t !== e.tasks[i])) tx.put("trash", { ...e, tasks });
				}
				return count;
			},
			{ undoable: false },
		);
	}

	/** Other tasks that link the same note. */
	alsoLinkedFrom(id: ID): Task[] {
		const task = this.store.state.tasks.get(id);
		const path = task?.descriptionNote?.path;
		if (path === undefined) return [];
		return [...this.store.state.tasks.values()].filter((t) => t.id !== id && t.descriptionNote?.path === path);
	}

	/** A one-click relink suggestion when exactly one note has the same basename. */
	relinkSuggestion(id: ID): string | null {
		const path = this.store.state.tasks.get(id)?.descriptionNote?.path;
		if (path === undefined) return null;
		const matches = this.notes.findByBasename(basenameOf(path));
		return matches.length === 1 ? (matches[0] ?? null) : null;
	}

	noteExists(path: string): boolean {
		return this.notes.exists(path);
	}
}
