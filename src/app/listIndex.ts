import { DomainError } from "../domain/errors";
import { type ID, type Task, syncLinkId } from "../domain/types";
import type { AppStore } from "./store";
import type { Change, Tx } from "./tx";

/** The most open tasks a list synced with TickTick holds (TickTick's per-list limit). */
export const SYNCED_LIST_OPEN_MAX = 999;

/**
 * The task ids and the number of open tasks of each list, kept up to date from the store's change events, so the
 * sync reads the tasks of the linked lists and the cap is checked without a pass over all tasks. Computed in
 * one pass on first use and again after a reload or a replacement of all records (a change event without `changes`).
 */
export class ListIndex {
	private byList: Map<ID, Set<ID>> | null = null;
	/** Open tasks per list; read only through `index()`. */
	private open = new Map<ID, number>();

	constructor(private readonly store: AppStore) {
		store.bus.on("changed", (e) => this.onChanged(e.changes));
	}

	private onChanged(changes: readonly Change[] | undefined): void {
		if (changes === undefined) {
			this.byList = null;
			return;
		}
		if (this.byList === null) return;
		for (const ch of changes) {
			if (ch.c !== "tasks") continue;
			const before = ch.before as Task | undefined;
			const after = ch.after as Task | undefined;
			if (before !== undefined && before.categoryId !== after?.categoryId) this.byList.get(before.categoryId)?.delete(ch.id);
			if (before?.status === "open") this.count(before.categoryId, -1);
			if (after !== undefined) {
				let ids = this.byList.get(after.categoryId);
				if (ids === undefined) this.byList.set(after.categoryId, (ids = new Set()));
				ids.add(ch.id);
				if (after.status === "open") this.count(after.categoryId, 1);
			}
		}
	}

	private count(listId: ID, delta: number): void {
		this.open.set(listId, (this.open.get(listId) ?? 0) + delta);
	}

	private index(): Map<ID, Set<ID>> {
		if (this.byList === null) {
			const byList = new Map<ID, Set<ID>>();
			this.open = new Map();
			for (const t of this.store.state.tasks.values()) {
				let ids = byList.get(t.categoryId);
				if (ids === undefined) byList.set(t.categoryId, (ids = new Set()));
				ids.add(t.id);
				if (t.status === "open") this.count(t.categoryId, 1);
			}
			this.byList = byList;
		}
		return this.byList;
	}

	/** The tasks of one list, read through `get` (from the state, or from a transaction over it). */
	tasksOf(get: (id: ID) => Task | undefined, listId: ID): Task[] {
		const out: Task[] = [];
		for (const id of this.index().get(listId) ?? []) {
			const t = get(id);
			if (t !== undefined && t.categoryId === listId) out.push(t);
		}
		return out;
	}

	/** The open tasks of a list in the store's state (completed ones do not count). */
	openCount(listId: ID): number {
		this.index();
		return this.open.get(listId) ?? 0;
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
