import { DomainError } from "../domain/errors";
import * as machine from "../domain/focus";
import type { ActiveTimer, FocusMoment, FocusSetConfig, Step } from "../domain/focus";
import { type Clock, type IdGenerator, nowInstant } from "../domain/ports";
import type { FocusSession, GapResolution, ID } from "../domain/types";
import { EventBus } from "./events";
import type { ActiveTimerPort, FocusSettingsPort } from "./ports";
import { FOCUS_RANGES } from "./settings";
import type { AppStore } from "./store";

// Focus sets: the only writer of focus sessions. Finalizing a round writes
// the record, flushes the file, and only then moves the device-local timer.

export type StartResult = { kind: "started" } | { kind: "busy"; sameTask: boolean };

/** What `open` found: nothing, a timer to resume, a pending prompt, or a round the file already holds. */
export type OpenResult = "none" | "restored" | "recovery" | "already-saved";

export interface FocusEvents {
	focus: undefined;
	moment: FocusMoment;
	"set-done": { rounds: number; focusedSec: number };
	"recovery-needed": undefined;
	"short-discarded": { sessionId: ID };
}

/** The store labels of the history edits; the Undo notices of the UI carry the same ones. */
export const EDIT_LABEL = "Edit focus record";
export const ASSIGN_LABEL = "Assign focus record";
export const DELETE_LABEL = "Delete focus record";

/** A heartbeat reaches the port at most this often. */
const HEARTBEAT_SAVE_MS = 15_000;
/** A focus that ends by Stop or Finish with less than this is not saved. */
const SHORT_FOCUS_SEC = 60;

export class FocusService {
	/** Reads a stored timer; exposed so the e2e spec can check the timer it ages by hand. */
	static readonly parseTimer = machine.parseActiveTimer;
	readonly bus = new EventBus<FocusEvents>();
	private active: ActiveTimer | null = null;
	private summary: { rounds: number; focusedSec: number } | null = null;
	private dbId: string | null = null;
	/** Commands run one at a time, pause and resume included, so a failed write always restores the right timer. */
	private tail: Promise<unknown> = Promise.resolve();
	/** While a record is being written the port is not touched, so the timer never moves ahead of the file. */
	private finalizing = 0;
	private lastPersistMs = 0;
	/** Short rounds that were not saved, by session id, each with its own Undo. */
	private readonly shortDiscarded = new Map<ID, FocusSession>();
	private discardedTimer: ActiveTimer | null = null;
	private tickPending: Promise<void> | null = null;
	private closed = false;
	/** Commands started and not yet settled; `close` only waits when there are some. */
	private running = 0;

	constructor(
		private readonly store: AppStore,
		private readonly clock: Clock,
		private readonly ids: IdGenerator,
		private readonly port: ActiveTimerPort,
		private readonly settings: FocusSettingsPort,
	) {}

	timer(): ActiveTimer | null {
		return this.active;
	}

	lastSummary(): { rounds: number; focusedSec: number } | null {
		return this.summary;
	}

	/**
	 * The session this service belongs to is closing: new ticks do nothing from now on. Returns a promise that
	 * resolves when the commands already running or queued have finished, so the caller can close the store after
	 * it, or `null` when nothing is running. The caller must then close the store without awaiting first: an
	 * extra await lets a plugin reload open the same file while this store is still open.
	 */
	close(): Promise<void> | null {
		this.closed = true;
		return this.running === 0 ? null : this.tail.then(() => undefined);
	}

	private serial<T>(fn: () => Promise<T>): Promise<T> {
		this.running++;
		const result = this.tail.then(fn, fn);
		const settled = result.then(
			() => void this.running--,
			() => void this.running--,
		);
		this.tail = settled;
		return result;
	}

	private now(): string {
		return nowInstant(this.clock);
	}

	/** Loads the timer: first a round the file already holds, then a timer that was running. */
	open(dbId: string): Promise<OpenResult> {
		return this.serial(() => {
			this.dbId = dbId;
			this.summary = null;
			this.shortDiscarded.clear();
			this.discardedTimer = null;
			const timer = machine.parseActiveTimer(this.port.load(dbId));
			if (timer === null) {
				this.active = null;
				this.bus.emit("focus", undefined);
				return Promise.resolve<OpenResult>("none");
			}
			if (timer.sessionId !== null && this.store.state.focusSessions.has(timer.sessionId)) {
				// The round was written before the crash; the set ends and nothing is written.
				this.active = null;
				this.port.save(dbId, null);
				this.bus.emit("focus", undefined);
				return Promise.resolve<OpenResult>("already-saved");
			}
			if (timer.state === "running") {
				this.active = machine.recoverOnLoad(timer, this.now()).timer;
				this.persist();
			} else {
				this.active = timer;
			}
			this.bus.emit("focus", undefined);
			if (this.active?.needsRecovery === true) {
				this.bus.emit("recovery-needed", undefined);
				return Promise.resolve<OpenResult>("recovery");
			}
			return Promise.resolve<OpenResult>("restored");
		});
	}

	start(config: FocusSetConfig, taskId: ID | null): Promise<StartResult> {
		return this.serial(async () => {
			this.requireWritable();
			if (this.active !== null) {
				return { kind: "busy", sameTask: taskId === null || taskId === this.active.taskId } as const;
			}
			validateConfig(config);
			const task = this.taskRef(taskId);
			this.summary = null;
			this.discardedTimer = null;
			await this.commit(null, machine.startSet(config, task, this.now(), this.ids), "always");
			return { kind: "started" } as const;
		});
	}

	/** A null task continues the second part with no task (the "Focus on" picker set to none). */
	split(taskId: ID | null): Promise<void> {
		return this.serial(async () => {
			this.requireWritable();
			const t = this.active;
			if (t === null || t.phase !== "focus") throw new DomainError("InvalidValue", "There is no focus round to split.");
			if (t.needsRecovery) throw new DomainError("InvalidValue", "Answer the recovery prompt first.");
			const task = this.taskRef(taskId);
			await this.commit(t, machine.split(t, task, this.now(), this.settings.deviceId(), this.ids), "always");
		});
	}

	/** Also the "Focus on" picker during a break. */
	reassign(taskId: ID | null): Promise<void> {
		return this.serial(async () => {
			// No record is written, so this also works while the file is read-only.
			const t = this.active;
			if (t === null) return;
			await this.commit(t, machine.reassign(t, this.taskRef(taskId)), "always");
		});
	}

	pause(): Promise<void> {
		return this.serial(() => {
			const t = this.active;
			if (t === null) return Promise.resolve();
			this.active = machine.pause(t, this.now()).timer;
			this.persist();
			this.bus.emit("focus", undefined);
			return Promise.resolve();
		});
	}

	resume(): Promise<void> {
		return this.serial(() => {
			const t = this.active;
			if (t === null) return Promise.resolve();
			this.active = machine.resume(t, this.now()).timer;
			this.persist();
			this.bus.emit("focus", undefined);
			return Promise.resolve();
		});
	}

	skip(): Promise<void> {
		return this.serial(async () => {
			const t = this.active;
			if (t === null) return;
			await this.commit(t, machine.skip(t, this.now(), this.settings.deviceId(), this.ids), "always");
		});
	}

	/**
	 * Ends the focus round now as completed, with its real seconds, and moves the set on as a natural end does.
	 * The tick logic runs first: a stale heartbeat opens the recovery prompt and a planned end that already passed
	 * is a natural end, so Finish only acts on a round that is still open.
	 */
	finish(): Promise<void> {
		return this.serial(async () => {
			const before = this.active;
			if (before === null || before.phase !== "focus") return;
			await this.tickStep();
			const t = this.active;
			if (t === null || t.phase !== "focus" || t.needsRecovery || t.sessionId !== before.sessionId) return;
			await this.commit(t, machine.finish(t, this.now(), this.settings.deviceId(), this.ids), "always");
		});
	}

	stop(): Promise<void> {
		return this.serial(async () => {
			const t = this.active;
			if (t === null) return;
			await this.commit(t, machine.stop(t, this.now(), this.settings.deviceId()), "always");
		});
	}

	/**
	 * Called every second by the host; saves lastHeartbeat every 15 s. It does nothing without a running timer or
	 * after `close`, and a tick that arrives while one is queued or running joins it.
	 */
	tick(): Promise<void> {
		if (this.closed || this.active === null || this.active.state !== "running") return Promise.resolve();
		if (this.tickPending !== null) return this.tickPending;
		const p: Promise<void> = this.serial(() => this.tickStep()).finally(() => {
			if (this.tickPending === p) this.tickPending = null;
		});
		this.tickPending = p;
		return p;
	}

	/** One tick of the machine, inside the command queue. */
	private async tickStep(): Promise<void> {
		const t = this.active;
		if (this.closed || t === null || t.state !== "running") return;
		const step = machine.tick(t, this.now(), this.settings.deviceId(), this.ids);
		const shapeChanged =
			step.effects.length > 0 ||
			step.timer === null ||
			step.timer.state !== t.state ||
			step.timer.phase !== t.phase ||
			step.timer.round !== t.round;
		try {
			await this.commit(t, step, shapeChanged ? "always" : "throttled");
		} catch (err) {
			// The round could not be finalized. Pause it instead of failing again every second; Resume retries.
			const cur = this.active;
			if (cur !== null && cur.state === "running") {
				this.active = machine.pause(cur, this.now()).timer;
				this.persist();
				this.bus.emit("focus", undefined);
			}
			throw err;
		}
	}

	/** Resolves true when the choice was applied; false when there was no pending prompt (answered elsewhere). */
	resolveRecovery(choice: "resume" | "finish" | "discard"): Promise<boolean> {
		return this.serial(async () => {
			const t = this.active;
			if (t === null || !t.needsRecovery) return false;
			const step = machine.resolveRecovery(t, choice, this.now(), this.settings.deviceId());
			if (choice === "discard") this.discardedTimer = t;
			await this.commit(t, step, "always");
			return true;
		});
	}

	/** Undo of a short round: saves the focus that was not saved. */
	undoShortDiscard(sessionId: ID): Promise<boolean> {
		return this.serial(async () => {
			const session = this.shortDiscarded.get(sessionId);
			if (session === undefined) return false;
			await this.write(session);
			this.shortDiscarded.delete(sessionId);
			return true;
		});
	}

	/** Undo of Discard: puts the discarded timer back (with its recovery prompt). */
	restoreDiscardedTimer(): Promise<boolean> {
		return this.serial(() => {
			const t = this.discardedTimer;
			if (t === null || this.active !== null) return Promise.resolve(false);
			this.discardedTimer = null;
			this.active = t;
			this.persist();
			this.bus.emit("focus", undefined);
			this.bus.emit("recovery-needed", undefined);
			return Promise.resolve(true);
		});
	}

	/** Resolves true only when it wrote; false when the gap already had that resolution. */
	includeGap(sessionId: ID, index: number, included: boolean): Promise<boolean> {
		return this.store.run(EDIT_LABEL, (tx) => {
			const rec = tx.get("focusSessions", sessionId);
			if (rec === undefined) throw new DomainError("NotFound", "The focus record no longer exists.");
			const gap = rec.unobserved[index];
			if (gap === undefined) throw new DomainError("NotFound", "The unobserved time no longer exists.");
			const resolution: GapResolution = included ? "included" : "excluded";
			if (gap.resolution === resolution) return false;
			tx.put("focusSessions", { ...rec, unobserved: rec.unobserved.map((g, i) => (i === index ? { ...g, resolution } : g)), modifiedAt: this.now() });
			return true;
		});
	}

	/** Records are the user's to delete; totals follow. The label is the one the Undo notice carries. */
	async deleteRecord(sessionId: ID): Promise<void> {
		await this.store.run(DELETE_LABEL, (tx) => {
			if (tx.get("focusSessions", sessionId) === undefined) throw new DomainError("NotFound", "The focus record no longer exists.");
			tx.remove("focusSessions", sessionId);
		});
	}

	/** Resolves true only when it wrote; false when the record already had that task. */
	assign(sessionId: ID, taskId: ID | null): Promise<boolean> {
		return this.store.run(ASSIGN_LABEL, (tx) => {
			const rec = tx.get("focusSessions", sessionId);
			if (rec === undefined) throw new DomainError("NotFound", "The focus record no longer exists.");
			let title = rec.taskTitleSnapshot;
			if (taskId !== null) {
				const task = tx.get("tasks", taskId);
				if (task === undefined) throw new DomainError("NotFound", "The task no longer exists.");
				title = task.title;
			}
			if (rec.taskId === taskId && rec.taskTitleSnapshot === title) return false;
			tx.put("focusSessions", { ...rec, taskId, taskTitleSnapshot: title, modifiedAt: this.now() });
			return true;
		});
	}

	// ---------------------------------------------------------------------

	private taskRef(taskId: ID | null): { id: ID; title: string } | null {
		if (taskId === null) return null;
		const task = this.store.state.tasks.get(taskId);
		if (task === undefined) throw new DomainError("NotFound", "The task no longer exists.");
		return { id: task.id, title: task.title };
	}

	private requireWritable(): void {
		if (this.store.readOnlyState !== null) {
			throw new DomainError("ReadOnly", "The database is read-only until the problem shown in the banner is resolved.");
		}
	}

	/** The device-local copy of the timer. Skipped while a record is being written. */
	private persist(): void {
		if (this.dbId === null || this.finalizing > 0) return;
		this.port.save(this.dbId, this.active);
		this.lastPersistMs = this.clock.now().getTime();
	}

	/**
	 * Applies a step. The in-memory timer moves at once; records are written and flushed first, and only then
	 * does the port see the new timer. A failed write puts the old timer back.
	 */
	private async commit(before: ActiveTimer | null, step: Step, persist: "always" | "throttled"): Promise<void> {
		this.active = step.timer;
		const saves = step.effects.flatMap((e) => (e.kind === "save" ? [{ session: e.session, manual: e.manual === true }] : []));
		const discarded: ID[] = [];
		let discardedSec = 0;
		if (saves.length > 0) {
			this.finalizing++;
			try {
				for (const { session, manual } of saves) {
					if (this.isShort(session, manual)) {
						this.shortDiscarded.set(session.id, session);
						discarded.push(session.id);
						discardedSec += machine.focusedSec(session);
					} else {
						await this.write(session);
					}
				}
			} catch (err) {
				if (this.active === step.timer) this.active = before;
				throw err;
			} finally {
				this.finalizing--;
			}
		}
		// A round that was not saved is not part of the set's focused total.
		if (discardedSec > 0 && this.active !== null) {
			this.active = { ...this.active, setFocusedSec: Math.max(0, this.active.setFocusedSec - discardedSec) };
		}
		// A clock that went back counts as due, so the new heartbeat reaches the port.
		const sincePersist = this.clock.now().getTime() - this.lastPersistMs;
		if (persist === "always" || sincePersist < 0 || sincePersist >= HEARTBEAT_SAVE_MS) this.persist();
		for (const e of step.effects) {
			if (e.kind === "moment") this.bus.emit("moment", e.moment);
			else if (e.kind === "recovery-needed") this.bus.emit("recovery-needed", undefined);
			else if (e.kind === "set-done") {
				this.summary = { rounds: e.rounds, focusedSec: Math.max(0, e.focusedSec - discardedSec) };
				this.bus.emit("set-done", this.summary);
			}
		}
		for (const sessionId of discarded) this.bus.emit("short-discarded", { sessionId });
		this.bus.emit("focus", undefined);
	}

	/** The short-round rule for Stop and Skip (`stopped`) and for Finish (`manual`); a natural end is never short. */
	private isShort(session: FocusSession, manual: boolean): boolean {
		return (session.status === "stopped" || (manual && session.status === "completed")) && machine.focusedSec(session) < SHORT_FOCUS_SEC && this.settings.discardShortFocus();
	}

	/** Puts the record and waits until the file holds it. Finalizing is not undoable. */
	private async write(session: FocusSession): Promise<void> {
		const live = session.taskId === null ? undefined : this.store.state.tasks.get(session.taskId);
		const record = live === undefined ? session : { ...session, taskTitleSnapshot: live.title };
		await this.store.run("Finish focus", (tx) => tx.put("focusSessions", record), { undoable: false });
		await this.store.host.flush();
		// `flush` resolves even when the write failed (the store retries later) or the file turned read-only.
		// The timer must not move ahead of a file that does not hold the record.
		this.requireWritable();
		// An unrelated edit can land during the first flush and leave the store dirty; flush once more before giving up.
		if (this.store.host.isDirty) {
			await this.store.host.flush();
			this.requireWritable();
		}
		if (this.store.host.isDirty) {
			throw new Error("The focus record could not be saved to the file yet. It is kept and will be saved when the file can be written.");
		}
	}
}

function validateConfig(c: FocusSetConfig): void {
	const R = FOCUS_RANGES;
	const ok = (v: number, min: number, max: number): boolean => Number.isInteger(v) && v >= min && v <= max;
	if (
		!ok(c.rounds, R.focusRounds.min, R.focusRounds.max) ||
		!ok(c.focusSec, R.focusMin.min * 60, R.focusMin.max * 60) ||
		!ok(c.breakSec, R.breakMin.min * 60, R.breakMin.max * 60) ||
		!ok(c.longBreakSec, R.longBreakMin.min * 60, R.longBreakMin.max * 60)
	) {
		throw new DomainError("InvalidValue", "The focus set values are out of range.");
	}
}
