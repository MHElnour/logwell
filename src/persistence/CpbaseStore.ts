import { DomainError } from "../domain/errors";
import { type Clock, type IdGenerator, nowInstant } from "../domain/ports";
import type { Task } from "../domain/types";
import { BackupStore, SNAPSHOT_INTERVAL_MS, type BackupInfo, type SnapshotKind } from "./backups";
import type { DbFile, WriteResult } from "./gateway";
import { type JournalEntry, type JournalOp, replayJournal } from "./journal";
import { type Migration, MIGRATIONS, planMigration, runMigrations } from "./migrations";
import {
	CURRENT_SCHEMA_VERSION,
	type DbCollections,
	type DbData,
	type DbMeta,
	HISTORY_LIMIT,
	collectionsOf,
	createEmptyDb,
	isSafeId,
	PLACEHOLDER_DB_ID,
} from "./schema";
import { type ParseFailure, RecordLineCache, parseDbText, readHeader, revisionOf, serializeDb } from "./serializer";
import { CollectionError, validateDb } from "./validate";

// The single-file store (architecture.md, Saving, backups and recovery): load, debounced saves, self-write
// detection, external-change handling, recovery and conflict copies.

export const SAVE_DEBOUNCE_MS = 300;
export const SAVE_MAX_DELAY_MS = 2000;
export const SAVE_RETRY_MS = 5000;
/** Compare-and-swap failures in a row before the store reports them and backs off. */
const CAS_FAILURE_LIMIT = 3;

export interface Scheduler {
	set(fn: () => void, ms: number): number;
	clear(handle: number): void;
}

/** Device-local state (App.saveLocalStorage in Obsidian). */
export interface StoreLocalState {
	getLastWritten(dbId: string): string | null;
	setLastWritten(dbId: string, revision: string): void;
	/** The dbId last seen at this file path, for recovering a file whose header is destroyed. */
	getKnownDbId(): string | null;
	setKnownDbId(dbId: string): void;
}

/** `recoveredFrom` value when the damage arrived while open and the open state is the recovery. */
const RECOVERED_IN_MEMORY = "in-memory";

/** Why database text could not be loaded. */
type LoadFailure = ParseFailure | "invalid" | "unsupported";

export type ReadOnlyState =
	| {
			reason: "damaged";
			failure: LoadFailure;
			detail: string;
			/** The snapshot path, RECOVERED_IN_MEMORY, or null when there is nothing to restore. */
			recoveredFrom: string | null;
	  }
	| { reason: "newer-schema"; version: number };

export type StoreEvent =
	| { type: "loaded"; cause: "open" | "external" | "replace" }
	| { type: "read-only"; state: ReadOnlyState }
	| { type: "writable" }
	| { type: "conflict"; path: string }
	/** close() could not save pending changes; they were kept as the conflict copy at `path`. */
	| { type: "pending-saved-as-conflict"; path: string }
	/**
	 * close() could neither save pending changes nor keep them as a conflict copy: they are
	 * gone. `message` is the reason. The store is closed, so nothing is retried.
	 */
	| { type: "edits-lost"; message: string }
	| { type: "lost-revision"; revision: string; path: string | null }
	| { type: "repaired"; issues: string[] }
	/** Problems found on open and left as they are (nothing is written for them). */
	| { type: "noticed"; notes: string[] }
	| { type: "migrated"; from: number; to: number }
	| { type: "saved"; revision: string }
	| { type: "save-error"; message: string };

export interface StoreDeps {
	file: DbFile;
	backupsFor(dbId: string): BackupStore;
	clock: Clock;
	ids: IdGenerator;
	deviceId: string;
	local: StoreLocalState;
	scheduler: Scheduler;
	onEvent(event: StoreEvent): void;
	migrations?: readonly Migration[];
}

export type LoadResult =
	| { kind: "ok"; data: DbData; issues: string[]; notes: string[]; migratedFrom: number | null }
	| { kind: "newer"; version: number; data: DbData | null }
	| { kind: "failed"; failure: LoadFailure; detail: string };

/** Parses, migrates and validates database text. Pure apart from the clock value. */
export function loadText(text: string, now: string, migrations: readonly Migration[] = MIGRATIONS): LoadResult {
	const parsed = parseDbText(text);
	if (!parsed.ok) return { kind: "failed", failure: parsed.reason, detail: parsed.detail };
	const version = parsed.raw.schemaVersion as number;
	const plan = planMigration(version, migrations);
	try {
		switch (plan.kind) {
			case "unsupported":
				return { kind: "failed", failure: "unsupported", detail: plan.detail };
			case "newer": {
				// Show what can be read, never write.
				let data: DbData | null = null;
				try {
					const v = validateDb({ ...parsed.raw, schemaVersion: CURRENT_SCHEMA_VERSION }, now).data;
					data = { ...v, meta: { ...v.meta, schemaVersion: version } };
				} catch {
					data = null;
				}
				return { kind: "newer", version, data };
			}
			case "current": {
				const v = validateDb(parsed.raw, now);
				return { kind: "ok", data: v.data, issues: v.issues, notes: v.notes, migratedFrom: null };
			}
			case "migrate": {
				const v = validateDb(runMigrations(parsed.raw, plan.steps), now);
				return { kind: "ok", data: v.data, issues: v.issues, notes: v.notes, migratedFrom: plan.from };
			}
		}
	} catch (err) {
		if (err instanceof CollectionError) return { kind: "failed", failure: "invalid", detail: err.message };
		throw err;
	}
}

export function newRevision(ids: IdGenerator): string {
	return `r-${ids().replace(/-/g, "").slice(0, 12)}`;
}

/**
 * How `target` relates to a file's lineage, judged from the header alone.
 * `targetHistory` is target's own history (its ancestors), or [] if unknown.
 *
 * `history` is a sliding window of the file's last HISTORY_LIMIT ancestors, so
 * "target is not in history" is not by itself evidence of a fork:
 * - target is in the window (or is the file's revision): the file descends from it.
 * - the window is shorter than the cap: it is the file's whole lineage, so
 *   target is not an ancestor. Proven fork.
 * - the window holds one of target's own ancestors but not target: if target
 *   were an ancestor of the file, it would lie between that shared ancestor and
 *   the file's revision, which is inside the window (the window is a contiguous
 *   run of the lineage). Proven fork.
 * - otherwise (a full window that shares nothing with target's history) target
 *   may have scrolled out after more than HISTORY_LIMIT saves elsewhere, or the
 *   fork may be older than the window. The header cannot tell these apart, and
 *   nothing else we hold is reliable evidence (clocks differ between devices),
 *   so the answer is "unknown" and callers do not claim a fork.
 */
function lineageRelation(
	file: { revision: string; history: readonly string[] },
	target: string,
	targetHistory: readonly string[],
): "descendant" | "fork" | "unknown" {
	const window = new Set([...file.history, file.revision]);
	if (window.has(target)) return "descendant";
	if (file.history.length < HISTORY_LIMIT) return "fork";
	if (targetHistory.some((r) => window.has(r))) return "fork";
	return "unknown";
}

/** What the store last read from or wrote to the database file (the compare-and-swap base). */
type DiskState = { revision: string } | { text: string };

function diskStateOf(text: string): DiskState {
	const revision = revisionOf(text);
	return revision === null ? { text } : { revision };
}

export class CpbaseStore {
	private current: DbData | null = null;
	private readOnly: ReadOnlyState | null = null;
	private backups: BackupStore | null = null;
	private backupsDbId: string | null = null;
	private cache = new RecordLineCache();
	private pendingOps: JournalOp[] = [];
	private needsFullWrite = false;
	/** The journal chain no longer leads to the file's revision; the next save starts from a snapshot. */
	private journalStale = false;
	private disk: DiskState | null = null;
	/** Counts commits, so an async step can tell whether one happened meanwhile. */
	private commits = 0;
	/** Compare-and-swap failures since the last successful write. */
	private casFailures = 0;
	private debounceHandle: number | null = null;
	private maxDelayHandle: number | null = null;
	private retryHandle: number | null = null;
	private io: Promise<unknown> = Promise.resolve();
	/**
	 * The revisions of the write attempts since the last successful write. A
	 * write that threw may still have landed (a torn file whose header survived),
	 * and a retry can run before its modify event is handled, so each counts as our
	 * own write. A revision written successfully earlier does not: it is a
	 * deliberate rollback. Cleared on success and on an external reload.
	 */
	private readonly attempted = new Set<string>();
	/**
	 * The header of the newest write attempt that threw. It may have landed and
	 * been synced, so the retry continues from it and keeps it in history.
	 * Cleared with `attempted`.
	 */
	private thrownMeta: DbMeta | null = null;
	private lastSnapshotAt: number | null = null;
	private closed = false;
	/**
	 * The conflict copy holding edits that were pending when the file turned
	 * damaged or newer-schema. They reached no file, so the next valid file is a
	 * fork, not a fast-forward. Cleared once that conflict is announced, or when
	 * Restore backup writes them.
	 */
	private unsavedCopy: string | null = null;

	constructor(private readonly deps: StoreDeps) {}

	// -- state ---------------------------------------------------------------

	get data(): DbData {
		if (this.current === null) throw new Error("Database is not loaded");
		return this.current;
	}

	/** False until `open` has loaded a database (or a placeholder); `data` throws until then. */
	get isLoaded(): boolean {
		return this.current !== null;
	}

	get readOnlyState(): ReadOnlyState | null {
		return this.readOnly;
	}

	get isDirty(): boolean {
		return this.pendingOps.length > 0 || this.needsFullWrite;
	}

	get backupStore(): BackupStore | null {
		return this.backups;
	}

	private now(): string {
		return nowInstant(this.deps.clock);
	}

	/** Reads database text with this store's clock and migrations. */
	private load(text: string): LoadResult {
		return loadText(text, this.now(), this.deps.migrations);
	}

	private emit(event: StoreEvent): void {
		this.deps.onEvent(event);
	}

	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.io.then(fn, fn);
		this.io = run.catch(() => undefined);
		return run;
	}

	private setReadOnly(state: ReadOnlyState): void {
		this.readOnly = state;
		this.clearTimers();
		this.emit({ type: "read-only", state });
	}

	private attachBackups(dbId: string): void {
		if (this.backupsDbId !== dbId) {
			this.backups = this.deps.backupsFor(dbId);
			this.backupsDbId = dbId;
		}
		this.deps.local.setKnownDbId(dbId);
	}

	private replaceData(data: DbData): void {
		this.current = data;
		// The line cache is keyed by record identity, so a reload starts fresh.
		this.cache = new RecordLineCache();
	}

	// -- open ------------------------------------------------------------------

	open(): Promise<void> {
		return this.enqueue(() => this.openNow());
	}

	private async openNow(): Promise<void> {
		const text = await this.deps.file.read();
		if (text === null) throw new Error("The database file could not be read.");
		const result = this.load(text);
		switch (result.kind) {
			case "ok": {
				this.attachBackups(result.data.meta.dbId);
				this.replaceData(result.data);
				this.disk = diskStateOf(text);
				this.readOnly = null;
				await this.backupBeforeRewrite(result, text);
				if (result.migratedFrom !== null) {
					this.needsFullWrite = true;
					this.emit({ type: "migrated", from: result.migratedFrom, to: CURRENT_SCHEMA_VERSION });
				}
				if (result.issues.length > 0) {
					this.needsFullWrite = true;
					this.emit({ type: "repaired", issues: result.issues });
				}
				if (result.notes.length > 0) this.emit({ type: "noticed", notes: result.notes });
				await this.checkLostRevision();
				if (this.needsFullWrite) await this.saveNow();
				// The session-start snapshot is not forced: it is skipped when unchanged.
				else await this.snapshotIfDue(this.serialize(), false);
				break;
			}
			case "newer": {
				const header = readHeader(text);
				this.disk = diskStateOf(text);
				this.replaceData(result.data ?? this.placeholderDb(header?.dbId ?? PLACEHOLDER_DB_ID));
				this.setReadOnly({ reason: "newer-schema", version: result.version });
				break;
			}
			case "failed":
				await this.enterDamaged(text, result.failure, result.detail);
				break;
		}
		this.emit({ type: "loaded", cause: "open" });
	}

	/** Keep the original text before a migrated or repaired version is written. */
	private async backupBeforeRewrite(result: { migratedFrom: number | null; issues: string[] }, text: string): Promise<void> {
		if (result.migratedFrom !== null) await this.requireBackups().writeSnapshot("pre-migration", text);
		else if (result.issues.length > 0) await this.requireBackups().writeSnapshot("pre-repair", text);
	}

	private placeholderDb(dbId: string): DbData {
		return createEmptyDb({ dbId, revision: "r-none", deviceId: this.deps.deviceId, now: this.now() });
	}

	/** Load the newest valid backup, keep a copy of the damaged file, go read-only. */
	private async enterDamaged(text: string, failure: LoadFailure, detail: string): Promise<void> {
		// A dbId names the backup folder, so only a safe one is used.
		const safe = (id: string | null | undefined): string | null => (id != null && isSafeId(id) ? id : null);
		const dbId = safe(readHeader(text)?.dbId) ?? safe(this.deps.local.getKnownDbId());
		this.disk = { text };
		let recoveredFrom: string | null = null;
		if (dbId !== null) {
			this.attachBackups(dbId);
			await this.requireBackups().writeConflict(text, "damaged");
			const recovered = await this.recoverLatest();
			if (recovered !== null) {
				this.replaceData(recovered.data);
				recoveredFrom = recovered.from;
			}
		}
		if (recoveredFrom === null) this.replaceData(this.placeholderDb(dbId ?? PLACEHOLDER_DB_ID));
		this.setReadOnly({ reason: "damaged", failure, detail, recoveredFrom });
	}

	private requireBackups(): BackupStore {
		if (this.backups === null) throw new Error("Backups are not attached");
		return this.backups;
	}

	// -- recovery --------------------------------------------------------------

	/**
	 * The snapshot this device wrote last (by its own clock) that is valid,
	 * plus journal replay. Snapshots stamped in the future rank last; one of
	 * them is taken only when it is the only one whose replay reaches the revision
	 * this device last wrote, so a backward clock correction loses nothing.
	 */
	async recoverLatest(): Promise<{ data: DbData; from: string } | null> {
		const backups = this.requireBackups();
		const journal = await backups.readJournal();
		const last = this.backupsDbId === null ? null : this.deps.local.getLastWritten(this.backupsDbId);
		const reaches = (data: DbData): boolean => last !== null && lineageRelation(data.meta, last, []) === "descendant";
		let best: { data: DbData; from: string } | null = null;
		// Newest first, future-stamped ones last. Only the first valid snapshot is
		// a candidate unless it is a non-future one that misses the last write; then
		// only future-stamped ones are worth loading, to find one that reaches it.
		for (const snap of await backups.listSnapshots()) {
			const future = backups.isFutureStamp(snap.stamp);
			if (best !== null && !future) continue;
			const text = await backups.read(snap.path);
			if (text === null) continue;
			const data = this.replaySnapshot(text, journal);
			if (data === null) continue;
			if (best === null) {
				best = { data, from: snap.path };
				if (future || last === null || reaches(data)) return best;
			} else if (reaches(data)) {
				return { data, from: snap.path };
			}
		}
		return best;
	}

	/** A snapshot's content with the journal replayed on top (up to `untilRevision`), or null when it cannot be loaded. */
	private replaySnapshot(text: string, journal: readonly JournalEntry[], untilRevision: string | null = null): DbData | null {
		const loaded = this.load(text);
		if (loaded.kind !== "ok") return null;
		const replay = replayJournal(loaded.data, journal, loaded.data.meta.revision, untilRevision);
		return { ...replay.data, meta: this.replayedMeta(loaded.data.meta, replay.revisions) };
	}

	/**
	 * The header after replaying `revisions` on top of `base`. Every replayed
	 * revision goes into history: lineageRelation relies on history being a
	 * contiguous run of the lineage.
	 */
	private replayedMeta(base: DbMeta, revisions: readonly string[]): DbMeta {
		const revision = revisions[revisions.length - 1];
		if (revision === undefined) return base;
		const ancestors = [...base.history, base.revision, ...revisions.slice(0, -1)];
		return {
			...base,
			revision,
			baseRevision: ancestors[ancestors.length - 1] ?? null,
			history: ancestors.slice(-HISTORY_LIMIT),
		};
	}

	/** The content of a specific revision from snapshots and the journal, if still available. */
	async recoverRevision(target: string): Promise<string | null> {
		const backups = this.requireBackups();
		const journal = await backups.readJournal();
		for (const snap of await backups.listSnapshots()) {
			const text = await backups.read(snap.path);
			if (text === null) continue;
			if (snap.revision === target) return text;
			const data = this.replaySnapshot(text, journal, target);
			// The replayed header's revision is the revision the replay reached.
			if (data?.meta.revision === target) return serializeDb(data);
		}
		return null;
	}

	/**
	 * Our last write is missing from the file's lineage. Only a proven loss
	 * is reported: our last revision may simply have scrolled out of
	 * the capped history after many saves on another device. The recovered
	 * content's own history is the evidence for a proven fork; see lineageRelation.
	 */
	private async checkLostRevision(): Promise<void> {
		const meta = this.data.meta;
		const last = this.deps.local.getLastWritten(meta.dbId);
		if (last === null || lineageRelation(meta, last, []) === "descendant") return;
		const content = await this.recoverRevision(last);
		const lastHistory = content === null ? [] : (readHeader(content)?.history ?? []);
		const lost = lineageRelation(meta, last, lastHistory) === "fork";
		const path = lost && content !== null ? await this.requireBackups().writeConflict(content, last) : null;
		// Record the current state as known so the check (and the notice) happens once.
		this.deps.local.setLastWritten(meta.dbId, meta.revision);
		if (lost) this.emit({ type: "lost-revision", revision: last, path });
	}

	// -- writes ----------------------------------------------------------------

	private assertWritable(): void {
		if (this.closed) {
			// A change after close would be silently lost.
			throw new DomainError("ReadOnly", "This database was closed. Open it again and retry.");
		}
		if (this.readOnly !== null) {
			throw new DomainError("ReadOnly", "The database is read-only until the problem shown in the banner is resolved.");
		}
	}

	/** Applies a new in-memory state and schedules a save. */
	commit(next: DbData, ops: readonly JournalOp[]): void {
		this.assertWritable();
		this.current = next;
		this.commits++;
		if (ops.length === 0) return;
		this.pendingOps.push(...ops);
		this.scheduleSave();
	}

	private scheduleSave(): void {
		if (this.closed) return;
		const { scheduler } = this.deps;
		if (this.debounceHandle !== null) scheduler.clear(this.debounceHandle);
		this.debounceHandle = scheduler.set(() => void this.flush(), SAVE_DEBOUNCE_MS);
		if (this.maxDelayHandle === null) {
			this.maxDelayHandle = scheduler.set(() => void this.flush(), SAVE_MAX_DELAY_MS);
		}
	}

	private scheduleRetry(): void {
		if (this.closed) return;
		if (this.retryHandle !== null) this.deps.scheduler.clear(this.retryHandle);
		this.retryHandle = this.deps.scheduler.set(() => void this.flush(), SAVE_RETRY_MS);
	}

	private clearTimers(): void {
		const { scheduler } = this.deps;
		for (const h of [this.debounceHandle, this.maxDelayHandle, this.retryHandle]) if (h !== null) scheduler.clear(h);
		this.debounceHandle = null;
		this.maxDelayHandle = null;
		this.retryHandle = null;
	}

	/** Writes pending changes now (called on blur, visibility change and unload). */
	flush(): Promise<void> {
		this.clearTimers();
		return this.enqueue(() => this.saveNow());
	}

	private nextMeta(prev: DbMeta): DbMeta {
		return {
			...prev,
			schemaVersion: CURRENT_SCHEMA_VERSION,
			revision: newRevision(this.deps.ids),
			baseRevision: prev.revision,
			history: [...prev.history, prev.revision].slice(-HISTORY_LIMIT),
			writtenBy: this.deps.deviceId,
			writtenAt: this.now(),
		};
	}

	/** The compare-and-swap check: the file still holds what we last read or wrote. */
	private isOnDisk(text: string): boolean {
		const disk = this.disk;
		if (disk === null) return false;
		if ("text" in disk) return text === disk.text;
		const revision = revisionOf(text);
		// Our newest attempt is our own write, for example a torn one whose header survived.
		return revision !== null && (revision === disk.revision || this.attempted.has(revision));
	}

	private async saveNow(): Promise<void> {
		if (this.current === null || this.readOnly !== null || !this.isDirty) return;
		const backups = this.requireBackups();
		const ops = this.pendingOps;
		const full = this.needsFullWrite;
		// A full write, or a journal whose chain no longer leads to the file, starts from a snapshot.
		const snapshotFirst = full || this.journalStale;
		// After an external reload it is a "reload" snapshot with its own
		// retention, so a run of git pulls never evicts the hourly ones.
		const snapshotKind: SnapshotKind = this.journalStale ? "reload" : "hourly";
		this.pendingOps = [];
		this.needsFullWrite = false;

		const prev = this.thrownMeta ?? this.current.meta;
		const meta = this.nextMeta(prev);
		const content = serializeDb({ ...this.current, meta }, this.cache);
		let journalOk = true;
		try {
			if (snapshotFirst) {
				await backups.writeSnapshot(snapshotKind, content);
				if (snapshotKind === "hourly") this.lastSnapshotAt = this.deps.clock.now().getTime();
			} else {
				await backups.appendJournal({ rev: meta.revision, base: prev.revision, at: meta.writtenAt, ops });
			}
		} catch {
			journalOk = false;
		}
		const requeue = (): void => {
			this.pendingOps = [...ops, ...this.pendingOps];
			this.needsFullWrite = this.needsFullWrite || full;
			if (!journalOk) this.journalStale = true;
		};
		let result: WriteResult;
		try {
			this.attempted.add(meta.revision);
			result = await this.deps.file.write(content, (text) => this.isOnDisk(text));
		} catch (err) {
			requeue();
			this.thrownMeta = meta;
			this.emit({ type: "save-error", message: err instanceof Error ? err.message : String(err) });
			this.scheduleRetry();
			return;
		}
		if (!result.written) {
			requeue();
			// The file is gone. No retry; the plugin's delete or rename
			// handling decides and tells the user.
			if (result.current === null) return;
			this.casFailures++;
			// The file changed after our last read and its modify event is
			// still on its way. Handle it now; with our changes pending, it is a fork.
			await this.applyExternal(result.current);
			// Our changes are still pending only when the file held one of our
			// own revisions, which is now the compare-and-swap base: try again. A
			// save must never stall silently, so repeated failures are reported once
			// and retried on a timer.
			if (this.readOnly !== null || !this.isDirty) return;
			if (this.casFailures < CAS_FAILURE_LIMIT) {
				await this.saveNow();
				return;
			}
			if (this.casFailures === CAS_FAILURE_LIMIT) {
				this.emit({ type: "save-error", message: "The database file changed before every save attempt. Your changes are kept in memory." });
			}
			this.scheduleRetry();
			return;
		}
		this.casFailures = 0;
		this.attempted.clear();
		this.thrownMeta = null;
		this.current = { ...this.current, meta };
		this.disk = { revision: meta.revision };
		if (snapshotFirst && journalOk) this.journalStale = false;
		if (!journalOk) this.journalStale = true;
		this.deps.local.setLastWritten(meta.dbId, meta.revision);
		this.emit({ type: "saved", revision: meta.revision });
		await this.snapshotIfDue(content, !journalOk);
	}

	private async snapshotIfDue(content: string, force: boolean): Promise<void> {
		const backups = this.requireBackups();
		const now = this.deps.clock.now();
		try {
			// A negative interval means the clock went back: do not wait for the old time.
			const elapsed = this.lastSnapshotAt === null ? null : now.getTime() - this.lastSnapshotAt;
			const due = force || elapsed === null || elapsed < 0 || elapsed >= SNAPSHOT_INTERVAL_MS;
			if (due) {
				const newest = (await backups.listSnapshots()).find((s) => s.kind === "hourly");
				const revision = revisionOf(content) ?? "";
				// Never a duplicate of the newest hourly snapshot (on open too).
				// Other kinds have their own retention, so they do
				// not stand in for an hourly one.
				if (newest === undefined || newest.revision !== revision) {
					await backups.writeSnapshot("hourly", content);
					// The journal is truncated at a snapshot, but only when the
					// snapshot covers its newest readable entry: that entry's revision
					// is the snapshot's or one of its ancestors. An entry whose write
					// never reached the file survives until then.
					const header = readHeader(content);
					const last = (await backups.readJournal()).at(-1);
					if (header !== null && last !== undefined && lineageRelation(header, last.rev, []) === "descendant") await backups.resetJournal();
				}
				this.lastSnapshotAt = now.getTime();
			}
			if (!(await backups.hasDailySnapshot(now))) await backups.writeSnapshot("daily", content);
			await backups.prune();
		} catch (err) {
			this.emit({ type: "save-error", message: `Backup failed: ${err instanceof Error ? err.message : String(err)}` });
		}
	}

	// -- external changes ------------------------------------------------------

	/** Handles a `modify` event for the database file. */
	handleExternalChange(): Promise<void> {
		return this.enqueue(() => this.handleExternalNow());
	}

	private async handleExternalNow(): Promise<void> {
		if (this.current === null || this.closed) return;
		const text = await this.deps.file.read();
		if (text === null) return;
		await this.applyExternal(text);
	}

	/** Handles text found in the file that this store did not write (a modify event, or a failed compare-and-swap). */
	private async applyExternal(text: string): Promise<void> {
		if (this.current === null) return;
		const damaged = this.readOnly?.reason === "damaged" ? this.readOnly : null;
		// The damaged text we already handled.
		if (damaged !== null && this.disk !== null && "text" in this.disk && this.disk.text === text) return;
		// Self-write detection by header. An equal revision is a
		// no-op too, for example a CRLF checkout of our own write.
		// While read-only, a valid file is always loaded, even if it is ours. Only
		// the revision we just wrote or hold is a self-write: an older own revision
		// means the file was deliberately rolled back.
		const revision = revisionOf(text);
		if (this.readOnly === null && revision !== null && (this.attempted.has(revision) || revision === this.current.meta.revision)) {
			// The file holds the revision we know, so it is the compare-and-swap
			// base from now on (for example `git checkout --ours` of a merge conflict
			// followed by "Restore backup"). Without this every later save would fail.
			this.disk = diskStateOf(text);
			return;
		}
		const result = this.load(text);
		if (this.readOnly?.reason === "newer-schema" && result.kind !== "ok") {
			// Never write; just show the newer content if it can be read. A file that
			// is valid again is loaded below and makes the store writable.
			if (result.kind === "newer" && result.data !== null) this.replaceData(result.data);
			this.disk = diskStateOf(text);
			this.emit({ type: "loaded", cause: "external" });
			return;
		}
		if (result.kind !== "ok") {
			// Keep the in-memory state (the newest valid one) and stop writing. The
			// pending edits are kept as a copy, announced when a valid file returns.
			if (this.isDirty) this.unsavedCopy = await this.writeConflictCopy();
			this.pendingOps = [];
			this.needsFullWrite = false;
			this.disk = diskStateOf(text);
			if (result.kind === "newer") {
				if (result.data !== null) this.replaceData(result.data);
				this.setReadOnly({ reason: "newer-schema", version: result.version });
				this.emit({ type: "loaded", cause: "external" });
			} else {
				await this.requireBackups().writeConflict(text, "damaged");
				// Damage while open: the state that was open is the newest
				// valid one, so it is what "Restore backup" writes (pending edits included).
				const recoveredFrom = damaged !== null ? damaged.recoveredFrom : RECOVERED_IN_MEMORY;
				this.setReadOnly({ reason: "damaged", failure: result.failure, detail: result.detail, recoveredFrom });
			}
			return;
		}

		const ours = this.current.meta;
		const incoming = result.data;
		// A placeholder (damaged on open, nothing recovered) has nothing worth keeping,
		// and neither has the read-only view of a newer-schema file.
		const placeholder = (damaged !== null && damaged.recoveredFrom === null) || this.readOnly?.reason === "newer-schema";
		// A file rolled back to one of our ancestors loses nothing while we are clean;
		// with pending edits it is handled as a fork.
		const rollback = ours.history.includes(incoming.meta.revision);
		const fastForward =
			this.unsavedCopy === null &&
			(placeholder ||
				(incoming.meta.dbId === ours.dbId &&
					!this.isDirty &&
					(rollback || lineageRelation(incoming.meta, ours.revision, ours.history) !== "fork")));
		let conflictPath: string | null = null;
		// Edits kept when the file turned unreadable are already in their copy (and
		// a newer-schema memory is not ours to copy).
		if (!fastForward) conflictPath = this.unsavedCopy ?? (await this.writeConflictCopy());
		// An older file cannot hold sections (before v3), repeating
		// tasks (before v4), TickTick links (before v5) or yearly repeats (before v6), so replacing newer memory
		// with it would silently drop them.
		// Keep them as a conflict copy first.
		else if (result.migratedFrom !== null && result.migratedFrom < ours.schemaVersion && this.holdsDataNewerThan(result.migratedFrom)) {
			conflictPath = await this.writeConflictCopy();
		}
		// No await from the decision to the replacement, so no command can slip in
		// between and be lost.
		this.clearTimers();
		this.pendingOps = [];
		this.needsFullWrite = result.issues.length > 0 || result.migratedFrom !== null;
		// The journal chain ends at our last revision, not at the loaded one.
		this.journalStale = true;
		this.attachBackups(incoming.meta.dbId);
		this.replaceData(incoming);
		this.disk = diskStateOf(text);
		this.attempted.clear();
		this.thrownMeta = null;
		this.unsavedCopy = null;
		// Our version is kept as the conflict copy, so the loaded one is this
		// device's base from now on: the next open does not report ours as lost.
		if (!fastForward) this.deps.local.setLastWritten(incoming.meta.dbId, incoming.meta.revision);
		if (this.readOnly !== null) {
			this.readOnly = null;
			this.emit({ type: "writable" });
		}
		// The conflict copy is announced before anything that redraws the views, and
		// a repaired file is saved even when a handler of the reload throws.
		if (conflictPath !== null) this.emit({ type: "conflict", path: conflictPath });
		if (result.migratedFrom !== null) this.emit({ type: "migrated", from: result.migratedFrom, to: CURRENT_SCHEMA_VERSION });
		if (result.issues.length > 0) this.emit({ type: "repaired", issues: result.issues });
		try {
			this.emit({ type: "loaded", cause: "external" });
		} finally {
			if (this.needsFullWrite) {
				await this.backupBeforeRewrite(result, text);
				await this.saveNow();
			}
		}
	}

	/**
	 * True when memory holds data a file of schema `version` cannot have kept: a section or a task (live
	 * or trashed) in a section before v3; a repeating task or an occurrence record before v4; a TickTick
	 * link before v5; a yearly repeat before v6.
	 */
	private holdsDataNewerThan(version: number): boolean {
		const data = this.data;
		const all = (pred: (t: Task) => boolean): boolean => {
			for (const t of data.tasks.values()) if (pred(t)) return true;
			for (const e of data.trash.values()) for (const t of e.tasks) if (pred(t)) return true;
			return false;
		};
		if (version < 3 && (data.sections.size > 0 || all((t) => t.sectionId !== null))) return true;
		if (version < 4 && (data.occurrenceRecords.size > 0 || all((t) => t.recurrence !== null))) return true;
		if (version < 5 && data.syncLinks.size > 0) return true;
		if (version < 6 && all((t) => t.recurrence !== null && t.recurrence.versions.some((v) => v.rule.freq === "yearly"))) return true;
		return false;
	}

	/**
	 * Saves the in-memory version (with pending edits) as a conflict copy. A
	 * command committed while the copy is written is added to it.
	 */
	private async writeConflictCopy(): Promise<string> {
		const backups = this.requireBackups();
		let dirtyMeta: DbMeta | null = null;
		let path: string | undefined;
		let pathRevision: string | null = null;
		for (;;) {
			const seen = this.commits;
			const data = this.data;
			const meta = this.isDirty ? (dirtyMeta ??= this.nextMeta(data.meta)) : data.meta;
			// The name carries the revision. A commit that made the copy a new
			// revision gets a new name; the older copy (a subset) is removed.
			const written = await backups.writeConflict(
				serializeDb({ ...data, meta }),
				meta.revision,
				meta.revision === pathRevision ? path : undefined,
			);
			if (path !== undefined && written !== path) await backups.removeConflict(path);
			path = written;
			pathRevision = meta.revision;
			if (this.commits === seen) return path;
		}
	}

	// -- explicit replacement --------------------------------------------------

	/**
	 * Replaces all records and writes immediately, taking a snapshot of the
	 * current state first when `backupKind` is given (import, restore). `check`
	 * may throw to cancel; it runs first, so a refused replacement writes nothing.
	 */
	replaceAll(collections: DbCollections, backupKind: SnapshotKind | null, check?: (current: DbData) => void): Promise<void> {
		return this.enqueue(async () => {
			this.assertWritable();
			// An external change queued ahead of this job has been applied by now,
			// so the caller's stale-state check sees what is really being replaced.
			check?.(this.data);
			if (backupKind !== null) {
				// A command committed while the backup is written is taken into a new
				// backup, so the replacement never drops it unseen. From the last check
				// to the replacement there is no await, so none can slip in.
				for (;;) {
					const seen = this.commits;
					await this.requireBackups().writeSnapshot(backupKind, this.serialize());
					if (this.commits === seen) break;
				}
			}
			this.replaceData({ ...collections, meta: this.data.meta });
			this.pendingOps = [];
			this.needsFullWrite = true;
			await this.saveNow();
			this.emit({ type: "loaded", cause: "replace" });
		});
	}

	/** A snapshot of the current state, taken before an action that writes much at once (`pre-sync`: the first TickTick sync). */
	snapshot(kind: SnapshotKind): Promise<void> {
		return this.enqueue(async () => {
			this.assertWritable();
			await this.requireBackups().writeSnapshot(kind, this.serialize());
		});
	}

	/** "Restore backup" from the damaged banner: write the recovered state as a new revision. */
	restoreRecovered(): Promise<void> {
		return this.enqueue(async () => {
			if (this.readOnly?.reason !== "damaged" || this.readOnly.recoveredFrom === null) {
				throw new DomainError("InvalidValue", "No recovered backup is available.");
			}
			this.readOnly = null;
			this.needsFullWrite = true;
			// The compare-and-swap base is the damaged text, so a file that changed
			// again meanwhile is handled as an external change instead.
			await this.saveNow();
			if (this.readOnly === null) {
				// The edits kept when the file turned unreadable are in the file now.
				this.unsavedCopy = null;
				this.emit({ type: "writable" });
			}
			this.emit({ type: "loaded", cause: "replace" });
		});
	}

	/** The records in the text of a backup file or conflict copy (`what` names it in the error). */
	private backupCollections(text: string | null, what: "backup file" | "conflict copy"): DbCollections {
		if (text === null) throw new DomainError("NotFound", `The ${what} no longer exists.`);
		const loaded = this.load(text);
		if (loaded.kind !== "ok") throw new DomainError("InvalidValue", `The ${what} cannot be read.`);
		return collectionsOf(loaded.data);
	}

	/** Restores a snapshot file (Data section). The current state is backed up first. */
	async restoreSnapshot(path: string): Promise<void> {
		const text = await this.requireBackups().read(path);
		await this.replaceAll(this.backupCollections(text, "backup file"), "pre-restore");
	}

	/** "Keep mine": write the conflict copy's records on top of the current revision. */
	async keepMine(conflictPath: string): Promise<void> {
		const backups = this.requireBackups();
		const text = await backups.read(conflictPath);
		await this.replaceAll(this.backupCollections(text, "conflict copy"), "pre-restore");
		await backups.resolveConflict(conflictPath);
	}

	/** "Keep theirs": the current version stays; the copy moves to resolved. */
	async keepTheirs(conflictPath: string): Promise<void> {
		await this.requireBackups().resolveConflict(conflictPath);
	}

	async listSnapshots(): Promise<BackupInfo[]> {
		return this.backups === null ? [] : this.backups.listSnapshots();
	}

	async listConflicts(): Promise<BackupInfo[]> {
		return this.backups === null ? [] : this.backups.listConflicts();
	}

	/** The current content as written to disk (used for export). */
	serialize(): string {
		return serializeDb(this.data, this.cache);
	}

	/** Writes what is pending; from now on commits throw. */
	async close(): Promise<void> {
		this.closed = true;
		this.clearTimers();
		await this.enqueue(async () => {
			try {
				await this.saveNow();
			} catch (err) {
				// For example the conflict copy of a concurrent external change could not be written.
				this.emit({ type: "save-error", message: `Saving failed: ${err instanceof Error ? err.message : String(err)}` });
			}
			// Changes are still pending: the file was deleted (a save never recreates
			// a missing file) or could not be written. Keep them as a conflict copy
			// rather than dropping them when the session ends. This does not depend on
			// what the file holds now: a sync tool may have recreated it right after
			// the failed save.
			if (this.unsavedCopy !== null) {
				// Edits kept when the file turned unreadable never reached a file: say where they are.
				this.emit({ type: "pending-saved-as-conflict", path: this.unsavedCopy });
			} else if (this.current !== null && this.isDirty && this.backups !== null) {
				try {
					const path = await this.writeConflictCopy();
					this.emit({ type: "pending-saved-as-conflict", path });
				} catch (err) {
					// close() must never reject: a session switch waits for it. Say
					// plainly that the edits are gone instead. Not a save error: a closed
					// store makes no further attempt.
					this.emit({ type: "edits-lost", message: err instanceof Error ? err.message : String(err) });
				}
			}
		});
	}
}
