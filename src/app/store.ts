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
	changed: { label: string; changes?: readonly Change[] };
	/** Read-only state or conflicts changed; views refresh their banners. */
	status: undefined;
}

export interface UndoEntry {
	label: string;
	changes: Change[];
}

const UNDO_LIMIT = 50;

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

	/** Runs a command against a transaction and commits it as one write. */
	run<T>(label: string, fn: (tx: Tx) => T, options: RunOptions = {}): Promise<T> {
		return this.queue.run(() => {
			if (this.host.readOnlyState !== null) {
				throw new DomainError("ReadOnly", "The database is read-only until the problem shown in the banner is resolved.");
			}
			const tx = new Tx(this.host.data, this.now());
			const result = fn(tx);
			const { data, ops, changes } = tx.finish();
			if (ops.length > 0) {
				this.host.commit(data, ops);
				if (options.undoable !== false) {
					this.undoStack.push({ label, changes });
					if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
				}
				this.bus.emit("changed", { label, changes });
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
	 * Reverts the newest command. Refuses (UndoConflict) when one of its records changed since, so an
	 * undo never overwrites a later edit. The entry is taken off the stack before the checks, so a
	 * refused undo (conflict, or read-only) does not put it back.
	 */
	undo(): Promise<string | null> {
		return this.queue.run(() => {
			const entry = this.undoStack.pop();
			if (entry === undefined) return null;
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
			if (this.host.readOnlyState !== null) {
				throw new DomainError("ReadOnly", "The database is read-only.");
			}
			this.host.commit(data, ops);
			this.bus.emit("changed", { label: `Undo ${entry.label}`, changes });
			return entry.label;
		});
	}

	/** Undo for a specific command (the "Undo" button on a notice). */
	async undoIfLatest(label: string): Promise<boolean> {
		if (this.undoLabel !== label) {
			throw new DomainError("UndoConflict", `Cannot undo "${label}": other changes were made since.`);
		}
		return (await this.undo()) !== null;
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
			this.bus.emit("changed", { label: "Replace all" });
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
		this.bus.emit("changed", { label: "Reload" });
	}

	notifyStatus(): void {
		this.bus.emit("status", undefined);
	}
}
