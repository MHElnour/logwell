import { isDomainError } from "../domain/errors";
import { rewriteNotePath } from "../domain/notes";
import type { Task } from "../domain/types";
import { storableDbId } from "../persistence/schema";
import { MemoryRenameQueue, type NoteRename, type RenameQueuePort, type RenameTimers } from "./ports";
import type { AppStore } from "./store";

// Following note renames: each rename or move of a note inside Obsidian rewrites the description note paths of live
// and trashed tasks, one rename per command, in the order the vault sent them. While the database is read-only the
// renames wait, are saved on this device and are replayed once it is writable or reloaded.

/** A rename that failed with no caller to tell, worded for the user. */
function renameFailure({ oldPath, newPath }: NoteRename, err: unknown): Error {
	const reason = err instanceof Error ? err.message : String(err);
	return new Error(`Could not follow the note rename from ${oldPath} to ${newPath}: ${reason} Tasks linked to that note may need to be relinked.`, { cause: err });
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

export class NoteRenameTracker {
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
	constructor(
		private readonly store: AppStore,
		private readonly renameQueue: RenameQueuePort = new MemoryRenameQueue(),
		private readonly timers: RenameTimers = defaultTimers,
	) {
		// "status" fires when the store becomes writable again; "changed" covers reloads.
		const replay = () => void this.drainRenames();
		store.bus.on("status", replay);
		store.bus.on("changed", replay);
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
				else if (next.settle !== undefined) next.settle.reject(failure.err);
				// A rename reloaded from this device has no caller waiting: the session's error channel says it.
				else this.store.bus.onListenerError(renameFailure(next, failure.err));
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
}
