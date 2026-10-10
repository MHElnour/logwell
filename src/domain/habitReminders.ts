import { type HabitIndex, isClockTime, isLocalDate, isScheduled, progressOn } from "./habits";
import { type Habit, type ID, type Instant, type LocalDate, isRecord } from "./types";
import { compareSortKeys } from "./sortKey";
import { isInstant } from "./time";

// Habit reminders. Pure: the host passes the device's
// wall time in and keeps the returned state in device-local storage.

/** Snooze is 10 minutes. */
export const SNOOZE_MIN = 10;

/** Device-local, per database (`logwell-habit-reminders-<dbId>`); `fired` and `snoozedUntil` reset on a new date. */
export interface ReminderState {
	v: 1;
	date: LocalDate;
	fired: Record<ID, true>;
	snoozedUntil: Record<ID, Instant>;
	/** The reminder time last seen per habit, so a new or changed time already past is armed, not fired. */
	times: Record<ID, string>;
}

export function emptyReminderState(date: LocalDate): ReminderState {
	return { v: 1, date, fired: {}, snoozedUntil: {}, times: {} };
}

function readMap<T>(value: unknown, ok: (x: unknown) => x is T): Record<ID, T> | null {
	if (!isRecord(value)) return null;
	const out: Record<ID, T> = {};
	for (const [k, x] of Object.entries(value)) {
		if (!ok(x)) return null;
		out[k] = x;
	}
	return out;
}

/** Reads a stored state; anything unreadable or of another version is null (the caller starts empty, never deletes). */
export function parseReminderState(raw: unknown): ReminderState | null {
	if (!isRecord(raw) || raw.v !== 1) return null;
	if (!isLocalDate(raw.date)) return null;
	const fired = readMap(raw.fired, (x): x is true => x === true);
	const snoozedUntil = readMap(raw.snoozedUntil, isInstant);
	const times = readMap(raw.times, isClockTime);
	if (fired === null || snoozedUntil === null || times === null) return null;
	return { v: 1, date: raw.date, fired, snoozedUntil, times };
}

export interface ReminderCheck {
	/** Reminders to show now, by time and then list order. */
	due: Habit[];
	/** The state after the check: the date reset and the arming of new times already applied. Same object when unchanged. */
	state: ReminderState;
}

/** Day period: today's goal; week period: the week's goal, or any check-in today. */
function doneForNow(habit: Habit, index: HabitIndex, date: LocalDate): boolean {
	const p = progressOn(habit, index, date);
	if (p === null) return true;
	if (p.met) return true;
	return p.period.version.goal.period === "week" && (index.byDate(habit.id).get(date)?.length ?? 0) > 0;
}

function sameMap(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
	const ka = Object.keys(a);
	return ka.length === Object.keys(b).length && ka.every((k) => k in b && a[k] === b[k]);
}

/**
 * Which reminders are due at `now` (the device's wall date and time, and the instant). The same rule
 * runs on every tick and on open, so a reminder missed while Obsidian was closed catches up the same day.
 * A habit is due when it is not archived, has a reminder, today is scheduled, the time has come, the goal
 * is not met, it has not fired today on this device and it is not snoozed. A reminder time that is new or
 * changed and whose minute has already passed is marked fired for today (no instant fire on creation).
 * Check-ins of value 0 are not in the index, so they never count as done.
 */
export function checkReminders(
	habits: Iterable<Habit>,
	index: HabitIndex,
	state: ReminderState | null,
	now: { date: LocalDate; time: string; instant: Instant },
): ReminderCheck {
	const base = state !== null && state.date === now.date ? state : { ...emptyReminderState(now.date), times: state?.times ?? {} };
	const fired: Record<ID, true> = { ...base.fired };
	const snoozedUntil: Record<ID, Instant> = { ...base.snoozedUntil };
	const times: Record<ID, string> = {};
	const due: Habit[] = [];
	const nowMs = Date.parse(now.instant);
	for (const habit of habits) {
		if (habit.archivedAt !== null || habit.reminder === null || !isClockTime(habit.reminder.time)) continue;
		const id = habit.id;
		const time = habit.reminder.time;
		times[id] = time;
		if (base.times[id] !== time) {
			// New or changed: armed for today when its minute has passed. At its own minute (a time set
			// for the next minute, first seen by the check at that minute) or before, it is evaluated as
			// usual, so it fires at its minute.
			delete snoozedUntil[id];
			if (now.time > time) {
				fired[id] = true;
				continue;
			}
			delete fired[id];
		}
		if (fired[id] === true || now.time < time || !isScheduled(habit, now.date)) continue;
		const until = snoozedUntil[id];
		if (doneForNow(habit, index, now.date)) {
			if (until !== undefined) {
				// A check-in during the snooze clears it for the day.
				delete snoozedUntil[id];
				fired[id] = true;
			}
			continue;
		}
		if (until !== undefined && nowMs < Date.parse(until)) continue;
		due.push(habit);
	}
	due.sort((a, b) => {
		const ta = a.reminder!.time;
		const tb = b.reminder!.time;
		if (ta !== tb) return ta < tb ? -1 : 1;
		return compareSortKeys(a.sortKey, b.sortKey);
	});
	const unchanged =
		state !== null && base === state && sameMap(fired, state.fired) && sameMap(snoozedUntil, state.snoozedUntil) && sameMap(times, state.times);
	return { due, state: unchanged ? state : { v: 1, date: now.date, fired, snoozedUntil, times } };
}

/** The notice was shown (or closed with ×): quiet for the rest of the day. */
export function markFired(state: ReminderState, ids: ID[]): ReminderState {
	const fired = { ...state.fired };
	const snoozedUntil = { ...state.snoozedUntil };
	for (const id of ids) {
		fired[id] = true;
		delete snoozedUntil[id];
	}
	return { ...state, fired, snoozedUntil };
}

/** Snooze: due again at `until` (now + SNOOZE_MIN) if the goal is still not met. */
export function snooze(state: ReminderState, id: ID, until: Instant): ReminderState {
	const fired = { ...state.fired };
	delete fired[id];
	return { ...state, fired, snoozedUntil: { ...state.snoozedUntil, [id]: until } };
}
