import { describe, expect, it } from "vitest";
import { indexCheckins, streaks } from "../../src/domain/habits";
import type { Checkin, Habit } from "../../src/domain/types";
import { perfLog, timeBoth } from "./measure";

// One HabitIndex per state. Building it over 20,000 check-ins and computing the streaks of 20 habits (the target-scale
// seed of tests/perf/persistence.test.ts) grows with the number of check-ins: four times the check-ins (1,000 days
// instead of the last 250) take about four times as long, not sixteen.

const HABITS = 20;
const CHECKINS = 20000;
const DAYS = CHECKINS / HABITS;
const GROWTH = 8;
// A flat allowance for timer noise on a fast small run.
const NOISE_MS = 2;
const TODAY = "2027-09-27";

const uuid = (prefix: number, n: number) => `${prefix.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const day = (n: number) => new Date(Date.UTC(2025, 0, 1) + n * 86400000).toISOString().slice(0, 10);

/** The persistence seed's habits and check-ins: 20 habits, 1,000 days of check-ins each, or the last `days` of them. */
function seed(days = DAYS): { habits: Habit[]; checkins: Map<string, Checkin> } {
	const habits: Habit[] = [];
	for (let h = 0; h < HABITS; h++) {
		const id = uuid(2, h);
		habits.push({
			id,
			name: `Habit ${h}`,
			icon: null,
			color: null,
			timeOfDay: "anytime",
			reminder: null,
			archivedAt: null,
			sortKey: `a${h}`,
			createdAt: "2025-01-01T07:00:00.000Z",
			modifiedAt: "2025-01-01T07:00:00.000Z",
			versions: [
				{
					effectiveFrom: "2025-01-01",
					// Half of them met every day (the longest walks), half a weekly habit.
					goal: h % 2 === 0 ? { type: "quantity", target: 20, unit: "min", period: "day" } : { type: "count", target: 3, unit: null, period: "week" },
					schedule: h % 2 === 0 ? { kind: "weekdays", days: ["MO", "TU", "WE", "TH", "FR"] } : { kind: "weekly" },
					weekStart: "MO",
				},
			],
		});
	}
	const checkins = new Map<string, Checkin>();
	for (let c = (DAYS - days) * HABITS; c < CHECKINS; c++) {
		const id = uuid(3, c);
		const date = day(Math.floor(c / HABITS));
		const at = `${date}T20:15:00.000Z`;
		checkins.set(id, { id, habitId: uuid(2, c % HABITS), date, value: 20, note: null, createdAt: at, modifiedAt: at, deletedAt: null });
	}
	return { habits, checkins };
}

const evaluate = ({ habits, checkins }: ReturnType<typeof seed>) => {
	const index = indexCheckins(checkins);
	return habits.map((h) => streaks(h, index, TODAY));
};

describe("habit evaluation at target scale (D18)", () => {
	it("indexes 20,000 check-ins and computes 20 habits' streaks in time that grows with the check-ins", () => {
		const full = seed();
		const quarter = seed(DAYS / 4);
		expect(quarter.checkins.size).toBe(CHECKINS / 4);
		// Every weekday of the 1,000 seeded days is met: the streak is their number.
		let weekdays = 0;
		for (let n = 0; n < DAYS; n++) if (![0, 6].includes(new Date(Date.UTC(2025, 0, 1) + n * 86400000).getUTCDay())) weekdays++;
		const result = evaluate(full);
		expect(result[0]).toEqual({ current: weekdays, best: weekdays, unit: "days" });
		expect(result[1]!.unit).toBe("weeks");
		const { small, large } = timeBoth(() => evaluate(quarter), () => evaluate(full));
		const report = `${small.toFixed(1)} ms for ${CHECKINS / 4} check-ins, ${large.toFixed(1)} ms for ${CHECKINS}`;
		perfLog(`habits: index + streaks ${report}`);
		expect(large, report).toBeLessThan(small * GROWTH + NOISE_MS);
	});
});
