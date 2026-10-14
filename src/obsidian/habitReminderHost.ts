import { DateTime } from "luxon";
import type { HabitService } from "../app/HabitService";
import type { ReminderStatePort, SettingsPort } from "../app/ports";
import type { AppStore } from "../app/store";
import {
	SNOOZE_MIN,
	type ReminderState,
	checkReminders,
	markFired,
	parseReminderState,
	snooze,
} from "../domain/habitReminders";
import { type HabitIndex, versionAt } from "../domain/habits";
import type { Clock } from "../domain/ports";
import { clockTimeOf, instantFromNow } from "../domain/time";
import type { Habit, ID, LocalDate } from "../domain/types";
import { progressText } from "../ui/habits/format";
import type { NoticeAction } from "./notices";

// The Obsidian side of habit reminders. No `obsidian` import: notices, the system notification and
// the Habits page come in through `ui`, like FocusHost. One host per plugin, pointed at the open database;
// main.ts ticks it every 30 s and the host only checks when the device minute changes.

export interface ReminderHostUi {
	/** A notice with buttons; `timeout` 0 keeps it until the user acts or closes it. */
	actionNotice(message: string, actions: NoticeAction[], timeout: number): { hide(): void };
	/** A desktop notification; skipped while Obsidian is in front. */
	systemNotify(title: string, body: string): void;
	/** Opens the Habits page; with an id, that habit is selected (and its control focused when asked). */
	openHabits(id: ID | null, focusControl: boolean): void;
	/**
	 * The Undo notice of a check-in. `undo` acts on the database the check-in went to and resolves false
	 * when there is nothing to undo there any more (the caller then says "Nothing to undo.").
	 */
	notifyUndo(message: string, label: string, undo: () => Promise<boolean>): void;
	/** Asks for the system notification permission; only called from a user gesture. */
	requestNotifyPermission(): void;
	error(err: unknown): void;
}

/** The slice of the open database the host uses (main.ts builds it from the session). */
export interface ReminderApp {
	readonly habits: Pick<HabitService, "list" | "index" | "toggle" | "add">;
	readonly settings: Pick<SettingsPort, "zone">;
	readonly store: Pick<AppStore, "undoMark" | "undoFor">;
	/** Where the device-local state is kept (`CheckpointApp.reminders`; one port per session). */
	readonly reminders: ReminderStatePort;
	/** The database's id, read on every check and save: a placeholder can get its real header later. */
	dbId(): string;
}

/** Notices kept for hiding on detach and at midnight; older ones are long gone or closed. */
const KEEP_NOTICES = 20;

interface KeptNotice {
	/** The wall date the notice is about; its buttons act on that day only. */
	date: LocalDate;
	notice: { hide(): void } | null;
}

function hideQuietly(n: KeptNotice): void {
	try {
		n.notice?.hide();
	} catch {
		// Already gone.
	}
}

function messageOf(err: unknown): string {
	return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

export class HabitReminderHost {
	private app: ReminderApp | null = null;
	/** The dbId whose stored state `state` was loaded from; null until the first check after attach. */
	private loadedFor: string | null = null;
	/**
	 * The reminder state, authoritative while attached: read from the port once per attach
	 * (and when the dbId changes), then every check and Snooze builds on it. Each change is still saved.
	 */
	private state: ReminderState | null = null;
	/** "YYYY-MM-DD HH:MM" in the display zone of the last check; `tick` waits for it to change. */
	private lastMinute: string | null = null;
	/** The wall date of the last check: a new date hides the notices of earlier days. */
	private lastDate: LocalDate | null = null;
	private notices: KeptNotice[] = [];
	/** Background errors already shown this attach and day, by message. */
	private reported = new Set<string>();
	/** A failing save is logged once per attach. */
	private saveFailed = false;
	private asked = false;

	constructor(
		private readonly ui: ReminderHostUi,
		private readonly clock: Clock,
	) {}

	/** Points the host at an open database and runs one check at once (the catch-up on open). */
	attach(app: ReminderApp): void {
		this.detach();
		this.app = app;
		this.check();
	}

	/** Stops checking and hides this database's open reminder notices (their buttons would act on it). */
	detach(): void {
		this.app = null;
		this.loadedFor = null;
		this.state = null;
		this.lastMinute = null;
		this.lastDate = null;
		this.reported.clear();
		this.saveFailed = false;
		for (const n of this.notices.splice(0)) hideQuietly(n);
	}

	/** The 30 s interval: checks only when the device minute changed since the last check. Never throws. */
	tick(): void {
		const app = this.app;
		if (app === null) return;
		try {
			if (this.wallNow(app).minute === this.lastMinute) return;
		} catch (err) {
			this.report(err);
			return;
		}
		this.check();
	}

	/** Runs the due rule now, whatever the minute (attach, and the e2e spec after moving the clock). Never throws. */
	check(): void {
		const app = this.app;
		if (app === null) return;
		try {
			const now = this.wallNow(app);
			this.lastMinute = now.minute;
			if (this.lastDate !== now.date) {
				if (this.lastDate !== null) this.newDay(now.date);
				this.lastDate = now.date;
			}
			const dbId = app.dbId();
			if (dbId !== this.loadedFor) this.load(app, dbId);
			const prev = this.state;
			const habits = app.habits.list().filter((h) => h.archivedAt === null);
			const index = app.habits.index();
			const result = checkReminders(habits, index, prev, { date: now.date, time: now.time, instant: now.instant });
			const due = result.due;
			// Marked fired (in memory, and saved) before anything shows, so a notice that throws never repeats.
			const next = due.length === 0 ? result.state : markFired(result.state, due.map((h) => h.id));
			this.state = next;
			if (next !== prev) this.save(app, dbId, next);
			if (due.length === 1) this.showOne(app, due[0]!, index, now.date);
			else if (due.length > 1) this.showMany(due, now.date);
		} catch (err) {
			this.report(err);
		}
	}

	/** A user gesture (saving a habit with a reminder on): asks for the notification permission once. */
	gesture(): void {
		if (this.asked) return;
		this.asked = true;
		this.ui.requestNotifyPermission();
	}

	// ---------------------------------------------------------------------

	private wallNow(app: ReminderApp): { date: LocalDate; time: string; minute: string; instant: string } {
		const at = this.clock.now();
		const dt = DateTime.fromJSDate(at, { zone: app.settings.zone() });
		const date = dt.toISODate() ?? "";
		const time = clockTimeOf(dt);
		return { date, time, minute: `${date} ${time}`, instant: at.toISOString() };
	}

	/** A new wall date: yesterday's sticky notices go (their buttons would write to yesterday), errors may show again. */
	private newDay(date: LocalDate): void {
		this.reported.clear();
		this.notices = this.notices.filter((n) => {
			if (n.date === date) return true;
			hideQuietly(n);
			return false;
		});
	}

	/** Reads the stored state of `dbId`; unreadable is null (the due rule arms what is past). */
	private load(app: ReminderApp, dbId: string): void {
		this.loadedFor = dbId;
		this.state = null;
		try {
			this.state = parseReminderState(app.reminders.load(dbId));
		} catch (err) {
			this.report(err);
		}
	}

	/** Never throws: the state in memory stays authoritative, so a failing store cannot re-fire anything. */
	private save(app: ReminderApp, dbId: string, state: ReminderState): void {
		try {
			app.reminders.save(dbId, state);
		} catch (err) {
			if (this.saveFailed) return;
			this.saveFailed = true;
			console.warn("Logwell: could not save the habit reminder state; reminders keep working until Obsidian restarts.", err);
		}
	}

	/** A background error (tick, check): an identical message shows once per attach and day. */
	private report(err: unknown): void {
		const key = messageOf(err);
		if (this.reported.has(key)) return;
		this.reported.add(key);
		this.ui.error(err);
	}

	private keep(date: LocalDate): KeptNotice {
		const kept: KeptNotice = { date, notice: null };
		this.notices.push(kept);
		if (this.notices.length > KEEP_NOTICES) this.notices.splice(0, this.notices.length - KEEP_NOTICES);
		return kept;
	}

	private showOne(app: ReminderApp, habit: Habit, index: HabitIndex, date: LocalDate): void {
		const progress = progressText(habit, index, date);
		const kept = this.keep(date);
		const actions: NoticeAction[] = [
			{ label: "Check in", run: () => this.checkIn(app, habit, kept) },
			{ label: "Snooze 10 min", run: () => this.snooze(app, habit.id, kept) },
		];
		kept.notice = this.ui.actionNotice(`Time for ${habit.name} · ${progress}`, actions, 0);
		this.ui.systemNotify(`Time for ${habit.name}`, progress);
	}

	private showMany(habits: Habit[], date: LocalDate): void {
		const names = habits.map((h) => h.name).join(", ");
		const kept = this.keep(date);
		const actions: NoticeAction[] = [{ label: "Open habits", run: () => this.ui.openHabits(null, false) }];
		kept.notice = this.ui.actionNotice(`Habit reminders: ${names}`, actions, 0);
		this.ui.systemNotify("Habit reminders", names);
	}

	/**
	 * Whether a notice button may act: the host still points at the database the notice came from, and the
	 * notice is about today (read from the wall clock at click time). A notice of an earlier day is hidden
	 * and does nothing (a sticky notice clicked after midnight must not write to yesterday).
	 */
	private current(app: ReminderApp, kept: KeptNotice): boolean {
		if (this.app !== app) return false;
		if (this.wallNow(app).date === kept.date) return true;
		hideQuietly(kept);
		this.notices = this.notices.filter((n) => n !== kept);
		return false;
	}

	/**
	 * Check in for the day the reminder was about: binary checks in (never off: a check-in synced from
	 * another device stays), count adds 1, quantity opens the page with the amount field focused.
	 */
	private async checkIn(app: ReminderApp, fired: Habit, kept: KeptNotice): Promise<void> {
		try {
			if (!this.current(app, kept)) return;
			const date = kept.date;
			const habit = app.habits.list().find((h) => h.id === fired.id) ?? fired;
			const type = (versionAt(habit, date) ?? fired.versions[fired.versions.length - 1]!).goal.type;
			if (type === "quantity") {
				this.ui.openHabits(habit.id, true);
				return;
			}
			const mark = app.store.undoMark();
			const result = type === "binary" ? await app.habits.toggle(habit.id, date, true) : await app.habits.add(habit.id, date, 1);
			// The database may have closed or switched during the write; its Undo would be stale.
			if (!result.wrote || this.app !== app) return;
			const label = result.label;
			// The Undo acts on the database written to, and only while the host still points at it.
			const undoWrite = app.store.undoFor(mark, label);
			const undo = (): Promise<boolean> => (this.app === app ? undoWrite() : Promise.resolve(false));
			this.ui.notifyUndo(`Checked in ${habit.name}.`, label, undo);
		} catch (err) {
			this.ui.error(err);
		}
	}

	/** Due again after SNOOZE_MIN; builds on the state in memory, so it works whatever the store does. */
	private snooze(app: ReminderApp, id: ID, kept: KeptNotice): void {
		try {
			if (!this.current(app, kept)) return;
			// The dbId is read at every save too: a changed one is loaded first, like a check does.
			const dbId = app.dbId();
			if (dbId !== this.loadedFor) this.load(app, dbId);
			const current = this.state;
			if (current === null) return;
			const until = instantFromNow(this.clock, SNOOZE_MIN * 60_000);
			const next = snooze(current, id, until);
			this.state = next;
			this.save(app, dbId, next);
		} catch (err) {
			this.ui.error(err);
		}
	}
}
