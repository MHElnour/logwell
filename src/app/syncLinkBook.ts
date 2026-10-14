import { type ID, type Instant, syncLinkId } from "../domain/types";
import type { DbData } from "../persistence/schema";
import type { TickTickPending, TickTickPendingPort } from "./ports";
import type { AppStore } from "./store";
import { markGoneTaskLink } from "./tickTickLink";
import type { Change } from "./tx";
import { type AnsweredCreate, draftContext, LAST_PULLED_REFRESH_MS, type LinkDraft, type ListPull, putDraft, readPending, TICKTICK_LINKS_LABEL, trashedIds } from "./syncModel";

// The sync's bookkeeping outside the pull's own commands: the links written after a push, the `pendingDelete` marks of
// linked tasks a change removed, and the Logwell tasks created in TickTick that wait to be linked (kept on this device).

export class LinkBook {
	/**
	 * Logwell tasks created in TickTick but not linked, per list, so a later pull links them instead of
	 * importing a duplicate. Two cases: `createTask` failed in a way that may have created the task anyway
	 * (`maybePartial`: the answer and the new id were lost; value null), matched by title on the next sync only;
	 * or TickTick answered but writing the link failed (the store turned read-only; value: TickTick's id and the
	 * hashes that were sent), matched by that id whatever the copy's status, and looked up by id if the pull does
	 * not see it. The hashes sent are the base, so later edits on either side merge as usual. Kept on this device per
	 * database (`pendingPort`), so a restart does not lose it, and an entry is forgotten only once the command that
	 * links its task has committed (or once its copy is gone).
	 */
	creates = new Map<ID, Map<ID, AnsweredCreate | null>>();
	/** The database id `creates` was loaded for: null for none that may be stored under, undefined before a load. */
	private pendingOf: string | null | undefined = undefined;
	/** Links being marked `pendingDelete` after a change removed their task (see `onChanged`); a sync waits for it. */
	private marking: Promise<unknown> = Promise.resolve();
	/** Tasks whose `pendingDelete` marking failed: tried again at the start of the next sync. */
	private readonly unmarked = new Set<ID>();

	constructor(
		private readonly store: AppStore,
		/** Where `creates` is kept on this device. */
		private readonly pendingPort: TickTickPendingPort,
	) {
		store.bus.on("changed", (e) => this.onChanged(e.changes));
	}

	/** See `creates`: what TickTick answered (the link write failed), or null when the answer was lost. */
	remember(listId: ID, logwellId: ID, answer: AnsweredCreate | null): void {
		const pending = this.creates.get(listId) ?? new Map<ID, AnsweredCreate | null>();
		pending.set(logwellId, answer);
		this.creates.set(listId, pending);
		this.save();
	}

	/** Forgets entries of `creates` (list, task) and saves what is left. */
	forget(entries: readonly (readonly [ID, ID])[]): void {
		if (entries.length === 0) return;
		for (const [listId, logwellId] of entries) this.creates.get(listId)?.delete(logwellId);
		this.save();
	}

	/** Loads `creates` from this device when the open database is another one than it was loaded for. */
	load(): void {
		const dbId = this.store.storableDbId();
		if (dbId === this.pendingOf) return;
		this.pendingOf = dbId;
		this.creates = readPending(dbId === null ? null : this.pendingPort.load(dbId));
	}

	/** Saves `creates` under the database it was loaded for. A storage that fails keeps it in memory only. */
	save(): void {
		const dbId = this.pendingOf;
		if (dbId === null || dbId === undefined) return;
		const lists: TickTickPending["lists"] = {};
		for (const [listId, pending] of this.creates) {
			if (pending.size === 0) this.creates.delete(listId);
			else lists[listId] = Object.fromEntries(pending);
		}
		try {
			this.pendingPort.save(dbId, Object.keys(lists).length === 0 ? null : { v: 1, lists });
		} catch (err) {
			console.warn("Logwell: could not save the TickTick tasks waiting to be linked.", err);
		}
	}

	/** Waits for the marks being written, then retries those that failed (the start of each sync). */
	async settleMarks(): Promise<void> {
		await this.marking;
		if (this.unmarked.size > 0) await this.markRemoved([...this.unmarked]);
	}

	/**
	 * A command that removes a linked task without moving it to Trash (an undo of its create, duplicate or Quick
	 * Add) leaves no trace for the sync to find. The link is marked `pendingDelete` in a links command of its own
	 * (never undoable), as a purge does, so the next sync deletes the TickTick copy. The store stays generic: it only
	 * reports what changed. An excluded link is marked too: the sync then removes it, deleting the TickTick copy
	 * only when that copy is plain (never a repeating one).
	 */
	private onChanged(changes: readonly Change[] | undefined): void {
		if (changes === undefined) return;
		const removed: ID[] = [];
		for (const ch of changes) {
			if (ch.c === "tasks" && ch.before !== undefined && ch.after === undefined) removed.push(ch.id);
		}
		if (removed.length === 0) return;
		const state = this.store.state;
		const candidates = removed.filter((id) => {
			const link = state.syncLinks.get(syncLinkId("task", id));
			return link !== undefined && link.pendingDelete !== true;
		});
		if (candidates.length > 0) void this.markRemoved(candidates);
	}

	/**
	 * Marks the links of tasks that are gone (and not in Trash) `pendingDelete`. A marking that fails (the store
	 * turned read-only) is kept and tried again at the start of the next sync.
	 */
	private markRemoved(ids: readonly ID[]): Promise<unknown> {
		this.marking = this.marking.then(() =>
			this.store
				.run(
					TICKTICK_LINKS_LABEL,
					(tx) => {
						const trashed = trashedIds(tx);
						for (const id of ids) {
							this.unmarked.delete(id);
							if (!trashed.has(id)) markGoneTaskLink(tx, id);
						}
					},
					{ undoable: false },
				)
				.catch(() => {
					for (const id of ids) this.unmarked.add(id);
				}),
		);
		return this.marking;
	}

	// -- bookkeeping ---------------------------------------------------------------------------------------------

	/**
	 * The links, as their own command that is never undoable. A write that changes nothing is skipped.
	 * `lastPulledAt` is written only when something else was written since `stateAtStart` (by this sync or meanwhile;
	 * the file changes anyway), when this command writes other links, when the list's completed tasks needed more
	 * than one read, or when the stored time is missing or an hour old (`LAST_PULLED_REFRESH_MS`). A sync that found nothing to do therefore runs a command that changes nothing,
	 * which writes, records and emits nothing.
	 */
	async writeLinks(
		drafts: Map<string, LinkDraft>,
		removeLinks: Set<string>,
		exclude: Set<string>,
		pulls: ListPull[],
		pulledAt: Instant,
		stateAtStart: DbData,
	): Promise<void> {
		await this.store.run(
			TICKTICK_LINKS_LABEL,
			(tx) => {
				for (const id of removeLinks) tx.remove("syncLinks", id);
				const ctx = draftContext(tx);
				for (const [id, d] of drafts) if (!removeLinks.has(id)) putDraft(tx, d, ctx);
				for (const id of exclude) {
					const current = tx.get("syncLinks", id);
					// Only a link that syncs becomes excluded; a localOnly one stays as the user chose.
					if (current !== undefined && (current.mode ?? "sync") === "sync") tx.put("syncLinks", { ...current, mode: "excluded", modifiedAt: tx.now });
				}
				const quiet = this.store.state === stateAtStart && tx.finish().ops.length === 0;
				for (const p of pulls) {
					const current = tx.get("syncLinks", syncLinkId("list", p.listId));
					if (current === undefined || current.ttId !== p.projectId) continue;
					const fresh = current.lastPulledAt !== null && Date.parse(pulledAt) - Date.parse(current.lastPulledAt) < LAST_PULLED_REFRESH_MS;
					// A split read moves the window on even when quiet, or each next sync would split it again.
					if (quiet && fresh && !p.splitCompleted) continue;
					tx.put("syncLinks", { ...current, lastPulledAt: pulledAt, modifiedAt: tx.now });
				}
			},
			{ undoable: false },
		);
	}
}
