import { indexCheckins, type HabitIndex } from "../../src/domain/habits";
import type { Checkin, Habit, HabitGoal, HabitSchedule, HabitVersion, LocalDate, WeekStart } from "../../src/domain/types";

// Builders for the habit tests (domain, reminders, property).

export function ver(
	effectiveFrom: LocalDate,
	goal: Partial<HabitGoal> = {},
	schedule: HabitSchedule = { kind: "daily" },
	weekStart: WeekStart = "MO",
): HabitVersion {
	return { effectiveFrom, goal: { type: "binary", target: 1, unit: null, period: "day", ...goal }, schedule, weekStart };
}

export function habit(id: string, versions: HabitVersion[], patch: Partial<Habit> = {}): Habit {
	return {
		id,
		name: `Habit ${id}`,
		icon: null,
		color: null,
		timeOfDay: "anytime",
		reminder: null,
		archivedAt: null,
		sortKey: `a${id}`,
		createdAt: "2026-09-01T07:00:00.000Z",
		modifiedAt: "2026-09-01T07:00:00.000Z",
		versions,
		...patch,
	};
}

let seq = 0;
export function ci(habitId: string, date: LocalDate, value = 1, patch: Partial<Checkin> = {}): Checkin {
	seq++;
	const at = `${date}T20:00:00.000Z`;
	return { id: `c-${seq}`, habitId, date, value, note: null, createdAt: at, modifiedAt: at, deletedAt: null, ...patch };
}

export function idx(...checkins: Checkin[]): HabitIndex {
	return indexCheckins(new Map(checkins.map((c) => [c.id, c])));
}

/** The dates from `from` to `to`, inclusive. */
export function dates(from: LocalDate, to: LocalDate): LocalDate[] {
	const out: LocalDate[] = [];
	for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
		out.push(new Date(t).toISOString().slice(0, 10));
	}
	return out;
}
