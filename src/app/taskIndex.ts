import { DomainError } from "../domain/errors";
import { isUnderTag, tagPrefixes } from "../domain/tags";
import { isOpen } from "../domain/tasks";
import { type ID, INBOX_ID, type Task, syncLinkId } from "../domain/types";
import type { DbData } from "../persistence/schema";
import type { AppStore } from "./store";
import type { Change, Tx } from "./tx";
import type { TaskView } from "./views";

type Tasks = DbData["tasks"];

/** The most open tasks a list synced with TickTick holds (TickTick's per-list limit). */
export const SYNCED_LIST_OPEN_MAX = 999;

/** What the index holds. Every part is a function of the task records alone. */
interface Parts {
	/** Task ids per list, any status. */
	byList: Map<ID, Set<ID>>;
	/** Open tasks per list. */
	open: Map<ID, number>;
	/** Tasks with a schedule, a deadline or a repeat rule, any status: the only ones Today and Upcoming can list. */
	dated: Set<ID>;
	/** Task ids per exact tag key, any status. */
	byTag: Map<string, Set<ID>>;
	/** Tasks that are not open. */
	completed: Set<ID>;
	/** Open tasks per tag key and every path prefix above it, a task once per key (the sidebar's tag counts). */
	tagOpen: Map<string, number>;
	/** How many tasks the parts hold. */
	size: number;
}

function emptyParts(): Parts {
	return { byList: new Map(), open: new Map(), dated: new Set(), byTag: new Map(), completed: new Set(), tagOpen: new Map(), size: 0 };
}

function addId<K>(map: Map<K, Set<ID>>, key: K, id: ID): void {
	const ids = map.get(key);
	if (ids === undefined) map.set(key, new Set([id]));
	else ids.add(id);
}

/** A set that becomes empty leaves the map, so a maintained index equals a rebuilt one. */
function deleteId<K>(map: Map<K, Set<ID>>, key: K, id: ID): void {
	const ids = map.get(key);
	if (ids === undefined) return;
	ids.delete(id);
	if (ids.size === 0) map.delete(key);
}

/** A count that reaches 0 leaves the map, so a maintained index equals a rebuilt one. */
function bump<K>(map: Map<K, number>, key: K, delta: number): void {
	const n = (map.get(key) ?? 0) + delta;
	if (n === 0) map.delete(key);
	else map.set(key, n);
}

/** Each tag key of a task and every path prefix above them, once. */
function tagCountKeys(task: Task): Set<string> {
	const keys = new Set<string>();
	for (const k of task.tagKeys) for (const prefix of tagPrefixes(k)) keys.add(prefix);
	return keys;
}

/** Has a date a view can read: a schedule, a deadline, or a repeat rule (its current occurrence). */
function isDated(t: Task): boolean {
	return t.scheduled !== null || t.deadline !== null || t.recurrence !== null;
}

/** Puts one task in every part. */
function add(p: Parts, t: Task): void {
	addId(p.byList, t.categoryId, t.id);
	for (const k of t.tagKeys) addId(p.byTag, k, t.id);
	if (isDated(t)) p.dated.add(t.id);
	if (isOpen(t)) {
		bump(p.open, t.categoryId, 1);
		for (const k of tagCountKeys(t)) bump(p.tagOpen, k, 1);
	} else {
		p.completed.add(t.id);
	}
	p.size++;
}

/**
 * Takes one task out of every part. A set the task is about to be put back in (`next`, the record after the change)
 * keeps it, so an edit leaves the task where it was in its list's set (the order `tasksOf` returns).
 */
function remove(p: Parts, t: Task, next: Task | undefined): void {
	if (next?.categoryId !== t.categoryId) deleteId(p.byList, t.categoryId, t.id);
	for (const k of t.tagKeys) if (next?.tagKeys.includes(k) !== true) deleteId(p.byTag, k, t.id);
	if (isDated(t) && (next === undefined || !isDated(next))) p.dated.delete(t.id);
	if (isOpen(t)) {
		bump(p.open, t.categoryId, -1);
		for (const k of tagCountKeys(t)) bump(p.tagOpen, k, -1);
	} else if (next === undefined || isOpen(next)) {
		p.completed.delete(t.id);
	}
	p.size--;
}

function build(state: DbData): Parts {
	const p = emptyParts();
	for (const t of state.tasks.values()) add(p, t);
	return p;
}

/** The open-task counts the sidebar reads, and the tasks its Today and Upcoming counts are taken over. */
export interface IndexCounts {
	/** Open tasks per list; a list with none is left out. */
	lists: Map<ID, number>;
	/** Open tasks per tag key and path prefix; a key with none is left out. */
	tags: Map<string, number>;
	/** Tasks that are not open. */
	completed: number;
	/** Every task with a schedule, a deadline or a repeat rule, any status. */
	dated: Task[];
}

/**
 * Which tasks can be in each Tasks view, and the open-task counts of lists and tags, kept up to date from the
 * store's change events. A Tasks view reads only its candidates, the sidebar counts without a pass over all tasks,
 * the sync reads the tasks of the linked lists, and the synced-list cap is checked. Each task change takes the
 * record out as it was before and puts it in as it is after. A change event without `changes` (a reload, a
 * replacement of all records) drops the index; the next read builds it again in one pass. Every part is a function of
 * the task records alone, so the index is current while the store's task map is the one it describes, whatever else
 * the state holds (a save gives the state a new revision and keeps the task map). A change event whose command did
 * not start from that task map, or that replaced a record other than the one the index holds, drops it too (a write
 * that did not go through the store); so does a read that finds another task map.
 *
 * Candidates are a superset of what a view shows: the view still applies its full test to each one.
 */
export class TaskIndex {
	private parts: Parts = emptyParts();
	/** The task map the parts describe; null when they must be built again. */
	private built: Tasks | null = null;
	/** Tests only: how often the index was built from all tasks. */
	rebuilds = 0;
	/** Tests only: how often a change event found the index out of step with the tasks and dropped it. */
	drops = 0;

	constructor(private readonly store: AppStore) {
		store.bus.on("changed", (e) => this.onChanged(e.changes, e.base));
	}

	private onChanged(changes: readonly Change[] | undefined, base: DbData | undefined): void {
		if (changes === undefined) {
			this.built = null;
			return;
		}
		const built = this.built;
		const now = this.store.state.tasks;
		// Not built, or already built from these tasks by a read made before this listener ran.
		if (built === null || built === now) return;
		const tasks = changes.filter((ch) => ch.c === "tasks");
		// No task written: the task map is unchanged, or was changed by a write the index never saw (a read compares).
		if (tasks.length === 0) return;
		// The command must have started from the tasks the index describes, and replaced the records it holds.
		if ((base !== undefined && base.tasks !== built) || tasks.some((ch) => built.get(ch.id) !== ch.before)) {
			this.drop();
			return;
		}
		const p = this.parts;
		for (const ch of tasks) {
			const before = ch.before as Task | undefined;
			const after = ch.after as Task | undefined;
			if (before !== undefined) remove(p, before, after);
			if (after !== undefined) add(p, after);
		}
		if (p.size === now.size) this.built = now;
		else this.drop();
	}

	/** Out of step with the tasks: build again on the next read. */
	private drop(): void {
		this.built = null;
		this.drops++;
	}

	private index(): Parts {
		const tasks = this.store.state.tasks;
		if (this.built !== tasks) {
			this.parts = build(this.store.state);
			this.built = tasks;
			this.rebuilds++;
		}
		return this.parts;
	}

	/** The tasks of one list, read through `get` (from the state, or from a transaction over it). */
	tasksOf(get: (id: ID) => Task | undefined, listId: ID): Task[] {
		const out: Task[] = [];
		for (const id of this.index().byList.get(listId) ?? []) {
			const t = get(id);
			if (t !== undefined && t.categoryId === listId) out.push(t);
		}
		return out;
	}

	/** The open tasks of a list in the store's state (completed ones do not count). */
	openCount(listId: ID): number {
		return this.index().open.get(listId) ?? 0;
	}

	/**
	 * The tasks that can be in `view`: Inbox and a list their own tasks, Today and Upcoming the dated tasks, a tag
	 * the tasks with it or a tag under it, Completed the completed tasks, Trash none. Any status. Undefined when
	 * `state` does not hold the store's current tasks: the caller then reads every task.
	 */
	candidates(state: DbData, view: TaskView): Task[] | undefined {
		if (state.tasks !== this.store.state.tasks) return undefined;
		const p = this.index();
		const get = (id: ID) => state.tasks.get(id);
		switch (view.kind) {
			case "inbox":
				return this.tasksOf(get, INBOX_ID);
			case "category":
				return this.tasksOf(get, view.id);
			case "today":
			case "upcoming":
				return tasksIn(state, p.dated);
			case "tag": {
				// A task with two keys under the tag is listed once.
				const ids = new Set<ID>();
				for (const [key, withKey] of p.byTag) if (isUnderTag(key, view.key)) for (const id of withKey) ids.add(id);
				return tasksIn(state, ids);
			}
			case "completed":
				return tasksIn(state, p.completed);
			case "trash":
				return [];
		}
	}

	/** The sidebar's list, tag and completed counts and its dated tasks; undefined when `state` does not hold the store's current tasks. */
	counts(state: DbData): IndexCounts | undefined {
		if (state.tasks !== this.store.state.tasks) return undefined;
		const p = this.index();
		// Copies: a caller cannot change the index through them.
		return { lists: new Map(p.open), tags: new Map(p.tagOpen), completed: p.completed.size, dated: tasksIn(state, p.dated) };
	}

	/**
	 * Tests only: the differences between the index as maintained and one built from `state` (empty when they agree).
	 * Builds nothing when the index was dropped; the next read builds it.
	 */
	verify(state: DbData): string[] {
		const out: string[] = [];
		if (this.built === null) return out;
		if (this.built !== state.tasks) return ["the index describes other tasks"];
		const fresh = build(state);
		const sets = (name: string, a: ReadonlySet<ID>, b: ReadonlySet<ID>) => {
			for (const id of a) if (!b.has(id)) out.push(`${name}: extra ${id}`);
			for (const id of b) if (!a.has(id)) out.push(`${name}: missing ${id}`);
		};
		const setMaps = <K>(name: string, a: Map<K, Set<ID>>, b: Map<K, Set<ID>>) => {
			for (const k of new Set([...a.keys(), ...b.keys()])) sets(`${name} ${String(k)}`, a.get(k) ?? new Set(), b.get(k) ?? new Set());
			for (const k of a.keys()) if (!b.has(k)) out.push(`${name}: empty key ${String(k)}`);
		};
		const counts = <K>(name: string, a: Map<K, number>, b: Map<K, number>) => {
			for (const k of new Set([...a.keys(), ...b.keys()])) if (a.get(k) !== b.get(k)) out.push(`${name} ${String(k)}: ${a.get(k)} ≠ ${b.get(k)}`);
		};
		const p = this.parts;
		setMaps("byList", p.byList, fresh.byList);
		counts("open", p.open, fresh.open);
		sets("dated", p.dated, fresh.dated);
		setMaps("byTag", p.byTag, fresh.byTag);
		sets("completed", p.completed, fresh.completed);
		counts("tagOpen", p.tagOpen, fresh.tagOpen);
		if (p.size !== fresh.size) out.push(`size: ${p.size} ≠ ${fresh.size}`);
		return out;
	}

	/**
	 * Refuses a command that adds open tasks to a list synced with TickTick past 999. Called at the end of a
	 * command, before it commits: it compares what the command wrote with the state it started from, so a command
	 * that adds none (an edit, a completion, a reorder) always passes, even in a list over the cap. Cost: the records
	 * the command wrote.
	 */
	assertSyncedRoom(tx: Tx): void {
		if (tx.base.syncLinks.size === 0) return;
		const added = new Map<ID, number>();
		for (const ch of tx.finish().changes) {
			if (ch.c !== "tasks") continue;
			const before = ch.before as Task | undefined;
			const after = ch.after as Task | undefined;
			if (before?.status === "open") added.set(before.categoryId, (added.get(before.categoryId) ?? 0) - 1);
			if (after?.status === "open") added.set(after.categoryId, (added.get(after.categoryId) ?? 0) + 1);
		}
		for (const [listId, n] of added) {
			if (n <= 0 || tx.get("syncLinks", syncLinkId("list", listId)) === undefined) continue;
			if (this.openCount(listId) + n <= SYNCED_LIST_OPEN_MAX) continue;
			const name = tx.get("categories", listId)?.name ?? "This list";
			throw new DomainError(
				"SyncedListFull",
				`Can't add the task: ${name} is synced with TickTick and already has ${SYNCED_LIST_OPEN_MAX} open tasks.`,
			);
		}
	}
}

/** The tasks of `ids` in `state`. */
function tasksIn(state: DbData, ids: Iterable<ID>): Task[] {
	const out: Task[] = [];
	for (const id of ids) {
		const t = state.tasks.get(id);
		if (t !== undefined) out.push(t);
	}
	return out;
}
