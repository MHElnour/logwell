import { EventBus } from "../app/events";
import type { TickTickDevicePort, TickTickSecretPort } from "../app/ports";
import { TICKTICK_PULL_RANGE } from "../app/settings";
import type { AppEvents, AppStore } from "../app/store";
import { type PendingTrash, type SyncFailure, type SyncResult, SYNC_OWN_LABELS } from "../app/SyncService";
import { isListSynced } from "../app/syncMarks";
import type { Change } from "../app/tx";

// When the TickTick sync runs on this device. A pull every `tickTickPullMinutes` (5 to 60)
// and once when the database opens, a push 5 s after the last edit that touches a linked list, and "Sync with
// TickTick now". Nothing runs, and no request is made, unless the device switch is on, a token is set, the database
// is writable and a list is linked. A failure is reported and never retried in a loop: the next attempt is the next
// pull or the next edit, and after HTTP 429 no background sync starts before its Retry-After. One sync at a time: a
// trigger while one runs runs once after it. Timers are the host's (the main window's); `dispose` stops them, and no
// sync starts after it.

/** A push waits this long after the last edit. */
export const PUSH_DELAY_MS = 5_000;
/** The notice for HTTP 429. */
export const RATE_LIMITED_TEXT = "TickTick: too many requests. Sync will try again at the next pull.";

interface SchedulerTimers {
	set(fn: () => void, ms: number): number;
	clear(handle: number): void;
}

export interface TickTickSchedulerDeps {
	store: AppStore;
	sync: { sync(): Promise<SyncResult> };
	device: Pick<TickTickDevicePort, "isEnabled">;
	secret: Pick<TickTickSecretPort, "get">;
	/** `tickTickPullMinutes`, brought into 5 to 60. Read at every scheduling. */
	pullMinutes(): number;
	timers: SchedulerTimers;
	/** Milliseconds since the epoch. */
	now(): number;
	notify(message: string): void;
	/**
	 * A failure notice with the failure behind it, so the host can add an action (Open settings after a refused
	 * token, Sync now after the free plan's list limit). When absent, `notify` gets the text.
	 */
	notifyFailure?(failure: SyncFailure, text: string): void;
	error(err: unknown): void;
}

/** What the settings and the list header show about this device's sync. */
export interface SyncStatus {
	/** Milliseconds since the epoch of the last sync that ended without a failure; null before the first one. */
	lastSyncAt: number | null;
	/** The first failure of the latest sync, as its notice reads; null when it had none. */
	error: string | null;
}

interface SchedulerEvents {
	/** Tasks missing from TickTick that wait for Move to Trash or Keep, from the latest sync. */
	confirmations: readonly PendingTrash[];
	/** A sync ended: `status()` has changed. */
	status: SyncStatus;
}

/** The notice text of one failure: the list and the reason. */
export function failureText(f: SyncFailure): string {
	if (f.kind === "rate-limited") return RATE_LIMITED_TEXT;
	if (f.listName === null || f.message.includes(`"${f.listName}"`)) return f.message;
	return `TickTick sync stopped in "${f.listName}": ${f.message.replace(/^TickTick: /u, "")}`;
}

/** The first failure of each distinct notice text. */
function uniqueByText(failures: readonly SyncFailure[]): SyncFailure[] {
	const seen = new Set<string>();
	return failures.filter((f) => {
		const t = failureText(f);
		if (seen.has(t)) return false;
		seen.add(t);
		return true;
	});
}

export class TickTickScheduler {
	readonly events = new EventBus<SchedulerEvents>();
	private pullTimer: number | null = null;
	private pushTimer: number | null = null;
	/** When the next pull interval counts from: the start, the end of the last sync, or the last inactive check. */
	private anchor = 0;
	/** No background sync before this time (Retry-After). */
	private notBefore = 0;
	private flight: Promise<SyncResult | null> | null = null;
	/** Triggers that came during the running sync: one more run after it; "Sync now" waits for that run's result. */
	private queued: { manual: boolean; waiters: ((result: SyncResult | null) => void)[] } | null = null;
	/** The failure notice last shown by a background sync, so a repeat of it is not shown again. */
	private lastFailure: string | null = null;
	private pending: readonly PendingTrash[] = [];
	/** Warnings already shown in this session: each distinct one once, not on every sync. */
	private readonly warned = new Set<string>();
	private lastSyncAt: number | null = null;
	private lastError: string | null = null;
	private unsubscribe: (() => void) | null = null;
	private started = false;
	private disposed = false;

	constructor(private readonly deps: TickTickSchedulerDeps) {}

	/** The device switch is on, a token is set, the database is writable and at least one list is linked. */
	isActive(): boolean {
		const { store, device, secret } = this.deps;
		if (this.disposed || store.readOnlyState !== null || !device.isEnabled() || secret.get() === null) return false;
		const state = store.state;
		// Lists are few; the links of their tasks may be many.
		for (const id of state.categories.keys()) if (isListSynced(state.syncLinks, id)) return true;
		return false;
	}

	/** When this device last synced without a failure, and what the latest sync failed with. */
	status(): SyncStatus {
		return { lastSyncAt: this.lastSyncAt, error: this.lastError };
	}

	private recordStatus(result: SyncResult, now: number): void {
		const failure = result.failures[0];
		if (failure === undefined) this.lastSyncAt = now;
		this.lastError = failure === undefined ? null : failureText(failure);
		this.events.emit("status", this.status());
	}

	/** A problem that did not stop a sync (TickTick's tags could not be read) is told once per session. */
	private warn(r: SyncResult): void {
		for (const w of r.warnings) {
			if (this.warned.has(w)) continue;
			this.warned.add(w);
			this.deps.notify(w);
		}
	}

	/** A sync that did not run here (the first sync of a list, from its dialog) counts as this device's latest sync. */
	recordSync(result: SyncResult): void {
		if (this.disposed) return;
		this.recordStatus(result, this.deps.now());
		this.warn(result);
	}

	/** The tasks missing from TickTick that wait for confirmation, from the latest sync. */
	pendingConfirmations(): readonly PendingTrash[] {
		return this.pending;
	}

	/** Once the database is open: listens for edits and runs the pull "when Obsidian opens". */
	start(): void {
		if (this.started || this.disposed) return;
		this.started = true;
		this.anchor = this.deps.now();
		this.unsubscribe = this.deps.store.bus.on("changed", (e) => this.onChanged(e));
		if (this.isActive()) void this.begin(false);
		else this.schedulePull();
	}

	/** A setting, the device switch or the token changed: timers follow at once. */
	refresh(): void {
		if (!this.started || this.disposed) return;
		// Inactive: no push; the pull timer still checks again at the next interval, so a token set meanwhile is seen.
		if (!this.isActive()) this.clearPush();
		this.schedulePull();
		// What the screens show (sync on for this device, a token set) may have changed with it.
		this.events.emit("status", this.status());
	}

	/**
	 * "Sync with TickTick now": a full pull and push, whatever Retry-After asked. During a sync it waits for a
	 * run that starts after it. Its result is always reported.
	 */
	syncNow(): Promise<SyncResult | null> {
		if (this.disposed || !this.isActive()) return Promise.resolve(null);
		return this.trigger(true);
	}

	/**
	 * A description note the sync keeps in step was edited (the session asks the sync engine which notes):
	 * pushed like a task edit, 5 s after the last one.
	 */
	noteEdited(): void {
		if (this.disposed || !this.started || !this.isActive()) return;
		this.armPush(this.deps.now() + PUSH_DELAY_MS);
	}

	/** Stops every timer; no sync starts after this. One already running finishes (the session waits for it). */
	dispose(): void {
		this.disposed = true;
		this.clearPull();
		this.clearPush();
		this.unsubscribe?.();
		this.unsubscribe = null;
		const queued = this.queued;
		this.queued = null;
		for (const w of queued?.waiters ?? []) w(null);
		this.events.clear();
	}

	// -- triggers ------------------------------------------------------------------------------------------------

	private onChanged(e: AppEvents["changed"]): void {
		if (this.disposed || SYNC_OWN_LABELS.has(e.label) || !this.touchesSync(e.changes) || !this.isActive()) return;
		this.armPush(this.deps.now() + PUSH_DELAY_MS);
	}

	/** Whether a command touched a linked list: its tasks, sections or links. A reload or replacement may have. */
	private touchesSync(changes: readonly Change[] | undefined): boolean {
		if (changes === undefined) return true;
		const links = this.deps.store.state.syncLinks;
		const linked = (listId: unknown): boolean => typeof listId === "string" && isListSynced(links, listId);
		for (const ch of changes) {
			if (ch.c === "syncLinks") return true;
			if (ch.c === "categories" && linked(ch.id)) return true;
			if (ch.c !== "tasks" && ch.c !== "sections") continue;
			const before = ch.before as { categoryId: string } | undefined;
			const after = ch.after as { categoryId: string } | undefined;
			if (linked(before?.categoryId) || linked(after?.categoryId)) return true;
		}
		return false;
	}

	/** A background sync at `at`, or at Retry-After when that is later. Replaces a push already armed. */
	private armPush(at: number): void {
		this.clearPush();
		const now = this.deps.now();
		const due = Math.max(at, this.notBefore);
		this.pushTimer = this.deps.timers.set(() => {
			this.pushTimer = null;
			this.background();
		}, Math.max(0, due - now));
	}

	/** A background sync now, unless inactive; before Retry-After it waits for it. */
	private background(): void {
		if (this.disposed || !this.isActive()) return;
		if (this.deps.now() < this.notBefore) {
			this.armPush(this.notBefore);
			return;
		}
		void this.trigger(false);
	}

	private schedulePull(): void {
		this.clearPull();
		if (this.disposed || !this.started) return;
		const raw = this.deps.pullMinutes();
		const { min, max } = TICKTICK_PULL_RANGE;
		const minutes = Number.isFinite(raw) ? Math.min(max, Math.max(min, raw)) : min;
		const now = this.deps.now();
		const due = Math.max(this.anchor + minutes * 60_000, this.notBefore);
		this.pullTimer = this.deps.timers.set(() => {
			this.pullTimer = null;
			if (this.isActive()) {
				this.background();
				return;
			}
			this.anchor = this.deps.now();
			this.schedulePull();
		}, Math.max(0, due - now));
	}

	private trigger(manual: boolean): Promise<SyncResult | null> {
		if (this.flight === null) return this.begin(manual);
		const queued = (this.queued ??= { manual: false, waiters: [] });
		if (!manual) return this.flight;
		queued.manual = true;
		return new Promise((resolve) => queued.waiters.push(resolve));
	}

	private begin(manual: boolean): Promise<SyncResult | null> {
		const flight = this.runOnce(manual).finally(() => {
			this.flight = null;
			this.afterFlight();
		});
		this.flight = flight;
		return flight;
	}

	/** The one run queued during a sync: "Sync now" at once; a background one waits for Retry-After. */
	private afterFlight(): void {
		const queued = this.queued;
		this.queued = null;
		if (queued === null) return;
		if (this.disposed || !this.isActive()) {
			for (const w of queued.waiters) w(null);
			return;
		}
		if (!queued.manual) {
			this.background();
			return;
		}
		const run = this.begin(true);
		for (const w of queued.waiters) void run.then(w);
	}

	private async runOnce(manual: boolean): Promise<SyncResult | null> {
		// A sync pulls and pushes everything: a pending push or pull is part of it. An edit during it arms a new push.
		this.clearPush();
		this.clearPull();
		let result: SyncResult | null = null;
		try {
			result = await this.deps.sync.sync();
		} catch (err) {
			if (!this.disposed) {
				this.deps.error(err);
				this.lastError = err instanceof Error ? err.message : String(err);
				this.events.emit("status", this.status());
			}
		}
		if (this.disposed) return result;
		const now = this.deps.now();
		this.anchor = now;
		if (result !== null) {
			this.recordStatus(result, now);
			for (const f of result.failures) {
				if (f.retryAfterSec !== null) this.notBefore = Math.max(this.notBefore, now + f.retryAfterSec * 1000);
			}
			this.report(result, manual);
		}
		this.schedulePull();
		return result;
	}

	private report(r: SyncResult, manual: boolean): void {
		// A sync that stopped before the pull found nothing to confirm; the earlier list stays.
		if (r.ok || r.needsConfirmation.length > 0) {
			this.pending = r.needsConfirmation;
			this.events.emit("confirmations", this.pending);
		}
		this.warn(r);
		if (r.failures.length === 0) {
			this.lastFailure = null;
			if (manual) this.deps.notify("TickTick: synced.");
			return;
		}
		const unique = uniqueByText(r.failures);
		const key = unique.map(failureText).join("\n");
		if (!manual && key === this.lastFailure) return;
		this.lastFailure = key;
		for (const f of unique) {
			const text = failureText(f);
			if (this.deps.notifyFailure !== undefined) this.deps.notifyFailure(f, text);
			else this.deps.notify(text);
		}
	}

	private clearPull(): void {
		if (this.pullTimer !== null) this.deps.timers.clear(this.pullTimer);
		this.pullTimer = null;
	}

	private clearPush(): void {
		if (this.pushTimer !== null) this.deps.timers.clear(this.pushTimer);
		this.pushTimer = null;
	}
}
