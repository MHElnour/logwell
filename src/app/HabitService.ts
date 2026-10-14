import { DomainError, invalidValue } from "../domain/errors";
import {
	type HabitIndex,
	type HabitInput,
	MAX_HABIT_VALUE,
	hasAtMostSixDecimals,
	indexCheckins,
	nextVersion,
	sameRule,
	validateHabitInput,
	versionAt,
} from "../domain/habits";
import type { Clock, IdGenerator } from "../domain/ports";
import { compareSortKeys, keyAfter } from "../domain/sortKey";
import { requireColor, requireIconName } from "../domain/tasks";
import { normalizedText } from "../domain/text";
import { isValidLocalDate, todayIn } from "../domain/time";
import type { Checkin, Habit, HabitGoal, HabitSchedule, ID, LocalDate } from "../domain/types";
import { GOAL_TYPES, TIMES_OF_DAY, WEEKDAYS } from "../domain/types";
import type { SettingsPort } from "./ports";
import type { AppStore } from "./store";
import type { Tx } from "./tx";
import type { WriteResult } from "./writes";

export type { WriteResult } from "./writes";

// Habits and check-ins. The only writer of
// both collections. Every method runs through store.run and resolves the label it used, so the Undo
// notice can carry the exact store label.

export const CHECKIN_LABEL = "Check in";
export const UNCHECK_LABEL = "Remove check-in";
export const EDIT_CHECKIN_LABEL = "Edit check-in";
export const DELETE_CHECKIN_LABEL = "Delete check-in";
export const NEW_HABIT_LABEL = "New habit";
export const EDIT_HABIT_LABEL = "Edit habit";
export const ARCHIVE_LABEL = "Archive habit";
export const RESTORE_LABEL = "Restore habit";
export const DELETE_HABIT_LABEL = "Delete habit";

/** Trims and fills the dialog's values the way they are stored. */
function normalize(input: HabitInput): HabitInput {
	const g = input.goal;
	if (!(GOAL_TYPES as readonly unknown[]).includes(g.type) || (g.period !== "day" && g.period !== "week")) invalidValue("That goal is not available.");
	const goal: HabitGoal = {
		type: g.type,
		// A daily "Done or not" goal is once a day; the dialog hides its target.
		target: g.type === "binary" && g.period === "day" ? 1 : g.target,
		unit: g.type === "binary" ? null : g.unit?.trim() || null,
		period: g.period,
	};
	const s = input.schedule;
	let schedule: HabitSchedule;
	if (s.kind === "weekdays") schedule = { kind: "weekdays", days: WEEKDAYS.filter((d) => s.days.includes(d)) };
	else if (s.kind === "daily" || s.kind === "weekly") schedule = { kind: s.kind };
	else invalidValue("That schedule is not available.");
	return {
		name: normalizedText(input.name),
		icon: input.icon?.trim() || null,
		color: input.color,
		timeOfDay: input.timeOfDay,
		reminder: input.reminder === null ? null : { time: input.reminder.time },
		goal,
		schedule,
	};
}

function requireValid(input: HabitInput, current: Habit | null): void {
	const message = validateHabitInput(input);
	if (message !== null) invalidValue(message);
	requireColor(input.color);
	if (!(TIMES_OF_DAY as readonly string[]).includes(input.timeOfDay)) invalidValue("That time of day is not available.");
	requireIconName(input.icon, current?.icon);
}

/** A check-in value is a finite number above 0, at most 6 decimals and 1,000,000; whole for count. */
function requireValue(habit: Habit, date: LocalDate, value: number): void {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) invalidValue("Enter an amount above 0.");
	if (value > MAX_HABIT_VALUE) invalidValue("An amount can be at most 1,000,000.");
	if (!hasAtMostSixDecimals(value)) invalidValue("Use at most 6 decimals.");
	if (versionAt(habit, date)?.goal.type === "count" && !Number.isInteger(value)) invalidValue("A count is a whole number.");
}

export class HabitService {
	private readonly indexes = new WeakMap<ReadonlyMap<string, Checkin>, HabitIndex>();

	constructor(
		private readonly store: AppStore,
		private readonly clock: Clock,
		private readonly ids: IdGenerator,
		private readonly settings: SettingsPort,
	) {}

	/** Today in the display zone. */
	today(): LocalDate {
		return todayIn(this.settings.zone(), this.clock);
	}

	/** One index per `checkins` map; the same object until a check-in changes. */
	index(): HabitIndex {
		return this.indexOf(this.store.state.checkins);
	}

	/**
	 * The index of a transaction's check-ins. Only an immutable committed map is cached. Once a
	 * transaction writes a check-in, `tx.map("checkins")` is its writable copy, which later puts change and
	 * which then becomes the committed state, so an index cached under it would go stale; that case is
	 * indexed without the cache.
	 */
	private txIndex(tx: Tx): HabitIndex {
		const checkins = tx.map("checkins");
		return checkins === tx.base.checkins ? this.indexOf(checkins) : indexCheckins(checkins);
	}

	/** The cached index of an immutable `checkins` map (a committed state). */
	private indexOf(checkins: ReadonlyMap<string, Checkin>): HabitIndex {
		let index = this.indexes.get(checkins);
		if (index === undefined) {
			index = indexCheckins(checkins);
			this.indexes.set(checkins, index);
		}
		return index;
	}

	/** All habits, archived ones included, in list order. */
	list(): Habit[] {
		return [...this.store.state.habits.values()].sort((a, b) => compareSortKeys(a.sortKey, b.sortKey));
	}

	/** Active check-ins of a habit, by habit (Delete asks with this count). */
	checkinCount(id: ID): number {
		return this.index().active(id).length;
	}

	/** The first version starts today, with the current week start setting. */
	create(input: HabitInput): Promise<Habit> {
		return this.store.run(NEW_HABIT_LABEL, (tx) => {
			const n = normalize(input);
			requireValid(n, null);
			const habit: Habit = {
				id: this.ids(),
				name: n.name,
				icon: n.icon,
				color: n.color,
				timeOfDay: n.timeOfDay,
				reminder: n.reminder,
				archivedAt: null,
				sortKey: keyAfter(tx.all("habits").map((h) => h.sortKey)),
				createdAt: tx.now,
				modifiedAt: tx.now,
				versions: [{ effectiveFrom: this.today(), goal: n.goal, schedule: n.schedule, weekStart: this.settings.weekStart() }],
			};
			tx.put("habits", habit);
			return habit;
		});
	}

	/** Name, icon, color, time of day and reminder change in place; a goal or schedule change adds a version. */
	update(id: ID, input: HabitInput): Promise<WriteResult> {
		return this.write(EDIT_HABIT_LABEL, (tx) => {
			const current = this.habit(tx, id);
			const n = normalize(input);
			requireValid(n, current);
			const last = current.versions[current.versions.length - 1]!;
			const versions = sameRule(last, n.goal, n.schedule)
				? current.versions
				: nextVersion(current, n.goal, n.schedule, this.settings.weekStart(), this.today());
			const unchanged =
				n.name === current.name &&
				n.icon === current.icon &&
				n.color === current.color &&
				n.timeOfDay === current.timeOfDay &&
				(n.reminder?.time ?? null) === (current.reminder?.time ?? null) &&
				versions === current.versions;
			if (unchanged) return false;
			tx.put("habits", {
				...current,
				name: n.name,
				icon: n.icon,
				color: n.color,
				timeOfDay: n.timeOfDay,
				// The stored object when the time is the same, so a newer build's extra fields survive.
				reminder: n.reminder !== null && current.reminder !== null && n.reminder.time === current.reminder.time ? current.reminder : n.reminder,
				versions,
				modifiedAt: tx.now,
			});
			return true;
		});
	}

	/** Hidden from Today, the strip, the groups and the reminders; the history stays. */
	archive(id: ID): Promise<WriteResult> {
		return this.write(ARCHIVE_LABEL, (tx) => {
			const current = this.habit(tx, id);
			if (current.archivedAt !== null) return false;
			tx.put("habits", { ...current, archivedAt: tx.now, modifiedAt: tx.now });
			return true;
		});
	}

	restore(id: ID): Promise<WriteResult> {
		return this.write(RESTORE_LABEL, (tx) => {
			const current = this.habit(tx, id);
			if (current.archivedAt === null) return false;
			tx.put("habits", { ...current, archivedAt: null, modifiedAt: tx.now });
			return true;
		});
	}

	/** The habit and every check-in of it (deleted ones included) in one undoable write. */
	delete(id: ID): Promise<WriteResult> {
		return this.write(DELETE_HABIT_LABEL, (tx) => {
			this.habit(tx, id);
			// Every record of the habit, deleted and value-0 ones included (no scan of the store).
			for (const c of this.txIndex(tx).records(id)) tx.remove("checkins", c.id);
			tx.remove("habits", id);
			return true;
		});
	}

	/**
	 * A binary check-in for `date`. Without `on` it flips; `on: true` only checks in and
	 * `on: false` only removes, so a reminder's Check in never turns a check-in made elsewhere off.
	 * At most one active binary check-in per habit and date: checking in when one exists writes nothing.
	 */
	async toggle(habitId: ID, date: LocalDate, on?: boolean): Promise<WriteResult> {
		if (on !== undefined) return this.setChecked(habitId, date, on, false);
		// A flip is decided inside the queue: when a command queued before this one changed the day
		// in between, the first run writes nothing and the flip runs once more under the other label.
		const first = !this.index().byDate(habitId).has(date);
		const r = await this.setChecked(habitId, date, first, true);
		return r === "retry" ? this.setChecked(habitId, date, !first, false) : r;
	}

	private async setChecked(habitId: ID, date: LocalDate, on: boolean, flip: true): Promise<WriteResult | "retry">;
	private async setChecked(habitId: ID, date: LocalDate, on: boolean, flip: false): Promise<WriteResult>;
	private async setChecked(habitId: ID, date: LocalDate, on: boolean, flip: boolean): Promise<WriteResult | "retry"> {
		const label = on ? CHECKIN_LABEL : UNCHECK_LABEL;
		const outcome = await this.store.run(label, (tx): boolean | "retry" => {
			const habit = this.writableHabit(tx, habitId, date);
			if (versionAt(habit, date)?.goal.type !== "binary") invalidValue("This habit is not done-or-not; add an amount instead.");
			// The index of the queue's current state decides (value-0 check-ins are not "on"); turning
			// off soft-deletes every active record of the habit on that date, value-0
			// ones included, from the habit's own records rather than a scan of the store.
			const index = this.txIndex(tx);
			const isOn = index.byDate(habitId).has(date);
			if (flip && isOn === on) return "retry";
			if (on) {
				if (isOn) return false;
				tx.put("checkins", this.newCheckin(tx, habitId, date, 1));
				return true;
			}
			if (!isOn) return false;
			for (const c of index.records(habitId)) {
				if (c.date === date && c.deletedAt === null) tx.put("checkins", { ...c, deletedAt: tx.now, modifiedAt: tx.now });
			}
			return true;
		});
		return outcome === "retry" ? "retry" : { wrote: outcome, label };
	}

	/** Count (+1) and quantity (an amount); a past date is a backfill. */
	add(habitId: ID, date: LocalDate, value: number): Promise<WriteResult> {
		return this.write(CHECKIN_LABEL, (tx) => {
			const habit = this.writableHabit(tx, habitId, date);
			if (versionAt(habit, date)?.goal.type === "binary") invalidValue("This habit is done-or-not; check it in instead.");
			requireValue(habit, date, value);
			tx.put("checkins", this.newCheckin(tx, habitId, date, value));
			return true;
		});
	}

	/** The value and note change in place; the date never does. A binary value stays 1. */
	editCheckin(id: ID, patch: { value?: number; note?: string | null }): Promise<WriteResult> {
		return this.write(EDIT_CHECKIN_LABEL, (tx) => {
			const current = tx.get("checkins", id);
			if (current === undefined || current.deletedAt !== null) throw new DomainError("NotFound", "The check-in no longer exists.");
			const habit = this.writableHabit(tx, current.habitId, current.date);
			const value = patch.value ?? current.value;
			if (value !== current.value) {
				if (versionAt(habit, current.date)?.goal.type === "binary") invalidValue("A done-or-not check-in has no amount to change.");
				requireValue(habit, current.date, value);
			}
			const note = patch.note === undefined ? current.note : patch.note?.trim() || null;
			if (value === current.value && note === current.note) return false;
			tx.put("checkins", { ...current, value, note, modifiedAt: tx.now });
			return true;
		});
	}

	/** Soft delete; Undo restores it. */
	deleteCheckin(id: ID): Promise<WriteResult> {
		return this.write(DELETE_CHECKIN_LABEL, (tx) => {
			const current = tx.get("checkins", id);
			if (current === undefined) throw new DomainError("NotFound", "The check-in no longer exists.");
			if (current.deletedAt !== null) return false;
			const habit = tx.get("habits", current.habitId);
			if (habit === undefined) throw new DomainError("NotFound", "The habit no longer exists.");
			if (habit.archivedAt !== null) invalidValue("Restore the habit to change its check-ins.");
			tx.put("checkins", { ...current, deletedAt: tx.now, modifiedAt: tx.now });
			return true;
		});
	}

	private async write(label: string, fn: (tx: Tx) => boolean): Promise<WriteResult> {
		const wrote = await this.store.run(label, fn);
		return { wrote, label };
	}

	private habit(tx: Tx, id: ID): Habit {
		const habit = tx.get("habits", id);
		if (habit === undefined) throw new DomainError("NotFound", "The habit no longer exists.");
		return habit;
	}

	/** No check-in writes on a date that is not a real day, on an archived habit, after today, or before the habit's first version. */
	private writableHabit(tx: Tx, id: ID, date: LocalDate): Habit {
		if (!isValidLocalDate(date)) invalidValue("That date is not valid.");
		const habit = this.habit(tx, id);
		if (habit.archivedAt !== null) invalidValue("Restore the habit to change its check-ins.");
		if (date > this.today()) invalidValue("A check-in cannot be in the future.");
		if (versionAt(habit, date) === null) invalidValue("The habit did not exist on that day.");
		return habit;
	}

	private newCheckin(tx: Tx, habitId: ID, date: LocalDate, value: number): Checkin {
		return { id: this.ids(), habitId, date, value, note: null, createdAt: tx.now, modifiedAt: tx.now, deletedAt: null };
	}
}
