import { DomainError } from "../domain/errors";
import { type Clock, nowInstant } from "../domain/ports";
import type { BackupInfo, SnapshotKind } from "../persistence/backups";
import type { ReadOnlyState } from "../persistence/CpbaseStore";
import type { JournalOp } from "../persistence/journal";
import type { DbCollections, DbData } from "../persistence/schema";
import { CommandQueue, EventBus } from "./events";
import { type Change, Tx } from "./tx";

/** What the app store needs from persistence; CpbaseStore implements it. */
export interface StateHost {
	readonly data: DbData;
	readonly readOnlyState: ReadOnlyState | null;
	/** Changes not yet in the file; stays true after a flush whose write failed. */
	readonly isDirty: boolean;
	commit(next: DbData, ops: readonly JournalOp[]): void;
	/**
	 * `check` runs inside the host's own write queue, against the state about to
	 * be replaced; throwing cancels the replacement.
	 */
	replaceAll(collections: DbCollections, backupKind: SnapshotKind | null, check?: (current: DbData) => void): Promise<void>;
	/** Writes a snapshot of the current state; refuses while read-only. */
	snapshot(kind: SnapshotKind): Promise<void>;
	serialize(): string;
	flush(): Promise<void>;
	listSnapshots(): Promise<BackupInfo[]>;
	listConflicts(): Promise<BackupInfo[]>;
	restoreSnapshot(path: string): Promise<void>;
	restoreRecovered(): Promise<void>;
	keepMine(path: string): Promise<void>;
	keepTheirs(path: string): Promise<void>;
}

export interface AppEvents {
	/**
	 * The state changed (local command, undo, external reload). `changes` lists the records a command or an undo
	 * wrote, before and after; a reload or a replacement of all records has none, which means "anything may differ".
	 */
	changed: {
		label: string;
		changes?: readonly Change[];
		/** The state the command or undo started from, with `changes`: the `before` of each change is its record. */
		base?: DbData;
	};
	/** Read-only state or conflicts changed; views refresh their banners. */
	status: undefined;
}

export interface UndoEntry {
	/** Unique and increasing; a notice's Undo names its entry by it (`undoFor`). */
	id: number;
	label: string;
	changes: Change[];
}

/** The labels of a "changed" event that is not a command: the state was reloaded from outside, or replaced (import, restore). */
export const RELOAD_LABEL = "Reload";
export const REPLACE_ALL_LABEL = "Replace all";

const UNDO_LIMIT = 50;
/** How many change events `changesSince` reaches back over. */
export const FEED_LIMIT = 64;
const NO_CHANGES: readonly Change[] = [];
const READ_ONLY_MESSAGE = "The database is read-only until the problem shown in the banner is resolved.";

export interface RunOptions {
	/** Rename tracking and maintenance are not user actions; they skip the undo stack. */
	undoable?: boolean;
}

/**
 * In-memory state + serialized command queue + undo (architecture.md, A change). Every
 * mutation goes through `run`; views never write storage directly.
 */
export class AppStore {
	readonly bus = new EventBus<AppEvents>();
	private readonly queue = new CommandQueue();
	private undoStack: UndoEntry[] = [];
	/** The id of the newest entry ever pushed; never reset, so a cleared history never reuses an id. */
	private lastUndoId = 0;
	/**
	 * The newest pushes, oldest first, kept when entries leave the stack (undo, clear): `undoFor` counts the pushes
	 * under a label since a mark, including ones already undone.
	 */
	private readonly pushed: { id: number; label: string }[] = [];
	/** The changes of the newest change events, oldest first; `changes` undefined for a reload or a replacement. */
	private readonly feed: (readonly Change[] | undefined)[] = [];
	private feedVersion = 0;

	constructor(
		readonly host: StateHost,
		readonly clock: Clock,
	) {}

	get state(): DbData {
		return this.host.data;
	}

	get readOnlyState(): ReadOnlyState | null {
		return this.host.readOnlyState;
	}

	now(): string {
		return nowInstant(this.clock);
	}

	/** Counts the `changed` events: one more for each, a command, an undo, a reload or a replacement of all records. */
	get version(): number {
		return this.feedVersion;
	}

	/**
	 * The changes written since `version`, oldest first: the `changes` of every `changed` event after it, the records
	 * themselves, not copies. Undefined, never a partial list, when one of those events had no `changes` (a reload, a
	 * replacement of all records, a restore) or when `version` is older than the last 64 events: the caller then reads
	 * the whole state. Empty when nothing changed since.
	 */
	changesSince(version: number): readonly Change[] | undefined {
		if (version === this.feedVersion) return NO_CHANGES;
		const first = this.feed.length - (this.feedVersion - version);
		if (version > this.feedVersion || first < 0) return undefined;
		if (first === this.feed.length - 1) return this.feed[first];
		const out: Change[] = [];
		for (let i = first; i < this.feed.length; i++) {
			const changes = this.feed[i];
			if (changes === undefined) return undefined;
			for (const ch of changes) out.push(ch);
		}
		return out;
	}

	/** Records the event in the feed, then tells the listeners, so a listener's `changesSince` already sees it. */
	private emitChanged(event: AppEvents["changed"]): void {
		this.feedVersion++;
		this.feed.push(event.changes);
		if (this.feed.length > FEED_LIMIT) this.feed.shift();
		this.bus.emit("changed", event);
	}

	/** Runs a command against a transaction and commits it as one write. */
	run<T>(label: string, fn: (tx: Tx) => T, options: RunOptions = {}): Promise<T> {
		return this.queue.run(() => {
			if (this.host.readOnlyState !== null) {
				throw new DomainError("ReadOnly", READ_ONLY_MESSAGE);
			}
			const tx = new Tx(this.host.data, this.now());
			const result = fn(tx);
			const { data, ops, changes } = tx.finish();
			if (ops.length > 0) {
				this.host.commit(data, ops);
				if (options.undoable !== false) {
					const id = ++this.lastUndoId;
					this.undoStack.push({ id, label, changes });
					if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
					this.pushed.push({ id, label });
					if (this.pushed.length > UNDO_LIMIT) this.pushed.shift();
				}
				this.emitChanged({ label, changes, base: tx.base });
			}
			return result;
		});
	}

	get canUndo(): boolean {
		return this.undoStack.length > 0;
	}

	get undoLabel(): string | null {
		return this.undoStack[this.undoStack.length - 1]?.label ?? null;
	}

	/**
	 * Reverts the newest command (the global Undo command and Cmd/Ctrl+Z); null when there is nothing to undo.
	 * While read-only it refuses before taking the entry, so the entry stays. It refuses (UndoConflict) when one of
	 * the command's records changed since, so an undo never overwrites a later edit; that entry is dropped, since the
	 * record can never match again, and the next undo takes the one before it.
	 */
	undo(): Promise<string | null> {
		return this.queue.run(() => this.revertNewest());
	}

	/** Taken right before a write whose notice offers Undo; `undoFor` then finds the entry that write pushed. */
	undoMark(): number {
		return this.lastUndoId;
	}

	/**
	 * The Undo button of a notice, bound when the notice shows, right after its write: it targets the one entry pushed
	 * under `label` since `mark`. Entries under other labels pushed in between do not matter. When none or more than
	 * one entry under `label` was pushed since, nothing is bound and the Undo refuses. The Undo reverts its entry only
	 * while that entry is the newest, checked inside the queue; otherwise it refuses (UndoConflict) and changes nothing:
	 * "other changes were made since" while the entry is still in the history under newer ones, "can no longer be
	 * undone here" when nothing is bound or the entry has left the history.
	 */
	undoFor(mark: number, label: string): () => Promise<boolean> {
		// The log must reach back to the mark, or an entry under `label` may have been pushed unseen.
		const covered = this.lastUndoId - this.pushed.length <= mark;
		const since = covered ? this.pushed.filter((p) => p.id > mark && p.label === label) : [];
		const id = since.length === 1 ? since[0]!.id : null;
		return () =>
			this.queue.run(() => {
				// Not bound, or its entry already left the history (undone, or cleared by a reload): nothing to say about later changes.
				if (id === null || !this.undoStack.some((e) => e.id === id)) {
					throw new DomainError("UndoConflict", `Cannot undo "${label}": this change can no longer be undone here.`);
				}
				if (this.undoStack[this.undoStack.length - 1]!.id !== id) {
					throw new DomainError("UndoConflict", `Cannot undo "${label}": other changes were made since.`);
				}
				return this.revertNewest() !== null;
			});
	}

	/** Runs inside the queue and stays synchronous from the first check to the commit. */
	private revertNewest(): string | null {
		const entry = this.undoStack[this.undoStack.length - 1];
		if (entry === undefined) return null;
		if (this.host.readOnlyState !== null) {
			throw new DomainError("ReadOnly", READ_ONLY_MESSAGE);
		}
		this.undoStack.pop();
		const tx = new Tx(this.host.data, this.now());
		for (const ch of entry.changes) {
			const current = tx.get(ch.c, ch.id);
			if (current !== ch.after) {
				throw new DomainError("UndoConflict", `Cannot undo "${entry.label}": the item changed since.`);
			}
		}
		for (const ch of entry.changes) {
			if (ch.before === undefined) tx.remove(ch.c, ch.id);
			else tx.put(ch.c, ch.before as never);
		}
		const { data, ops, changes } = tx.finish();
		this.host.commit(data, ops);
		this.emitChanged({ label: `Undo ${entry.label}`, changes, base: tx.base });
		return entry.label;
	}

	/**
	 * Replaces all records (import, restore). Clears undo history. `check` runs
	 * inside the host's write queue, right before the replacement and against the
	 * state it replaces, and cancels the replacement by throwing. Checking here
	 * instead would miss an external change already queued in the host.
	 */
	replaceAll(collections: DbCollections, backupKind: SnapshotKind | null, check?: (current: DbData) => void): Promise<void> {
		return this.queue.run(async () => {
			await this.host.replaceAll(collections, backupKind, check);
			this.undoStack = [];
			this.emitChanged({ label: REPLACE_ALL_LABEL });
		});
	}

	/**
	 * A snapshot of the current state (before the first TickTick sync), on the command queue, so it holds every
	 * command issued before it.
	 */
	snapshot(kind: SnapshotKind): Promise<void> {
		return this.queue.run(() => this.host.snapshot(kind));
	}

	// The Data section's restore and conflict actions. They write through the
	// host, so they run on the command queue like every other mutation: a command
	// issued meanwhile waits for them instead of racing the replacement.

	/** Restores a snapshot file; the current state is backed up first. */
	restoreSnapshot(path: string): Promise<void> {
		return this.queue.run(async () => {
			await this.host.restoreSnapshot(path);
			this.notifyReloaded();
		});
	}

	/** "Restore backup" from the damaged banner. */
	restoreRecovered(): Promise<void> {
		return this.queue.run(async () => {
			await this.host.restoreRecovered();
			this.notifyReloaded();
			this.notifyStatus();
		});
	}

	/** "Keep mine" for a conflict copy. */
	keepMine(path: string): Promise<void> {
		return this.queue.run(async () => {
			await this.host.keepMine(path);
			this.notifyReloaded();
			this.notifyStatus();
		});
	}

	/** "Keep theirs" for a conflict copy. */
	keepTheirs(path: string): Promise<void> {
		return this.queue.run(async () => {
			await this.host.keepTheirs(path);
			this.notifyStatus();
		});
	}

	/** Called when persistence reloaded the state from outside. */
	notifyReloaded(): void {
		this.undoStack = [];
		this.emitChanged({ label: RELOAD_LABEL });
	}

	notifyStatus(): void {
		this.bus.emit("status", undefined);
	}
}
