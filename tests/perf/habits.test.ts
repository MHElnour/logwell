import { describe, expect, it } from "vitest";
import { indexCheckins, streaks } from "../../src/domain/habits";
import type { Checkin, Habit } from "../../src/domain/types";

// One HabitIndex per state. Building it over 20,000 check-ins and computing the streaks of
// 20 habits (the target-scale seed of tests/perf/persistence.test.ts) stays within the
// query budget of the UI performance test.

const HABITS = 20;
const CHECKINS = 20000;
// Same allowance as the other perf tests: CI runners are two to three times slower.
const CI_SLACK = process.env.CI ? 4 : 1;
const BUDGET_MS = 25 * CI_SLACK;
const TODAY = "2027-09-27";

const uuid = (prefix: number, n: number) => `${prefix.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const day = (n: number) => new Date(Date.UTC(2025, 0, 1) + n * 86400000).toISOString().slice(0, 10);

/** The persistence seed's habits and check-ins: 20 habits, 1,000 days of check-ins each. */
function seed(): { habits: Habit[]; checkins: Map<string, Checkin> } {
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
	for (let c = 0; c < CHECKINS; c++) {
		const id = uuid(3, c);
		const date = day(Math.floor(c / HABITS));
		const at = `${date}T20:15:00.000Z`;
		checkins.set(id, { id, habitId: uuid(2, c % HABITS), date, value: 20, note: null, createdAt: at, modifiedAt: at, deletedAt: null });
	}
	return { habits, checkins };
}

describe("habit evaluation at target scale (D18)", () => {
	it(`indexes 20,000 check-ins and computes 20 habits' streaks under ${BUDGET_MS} ms`, () => {
		const { habits, checkins } = seed();
		const run = () => {
			const start = performance.now();
			const index = indexCheckins(checkins);
			const result = habits.map((h) => streaks(h, index, TODAY));
			return { ms: performance.now() - start, result };
		};
		run(); // warm up the JIT
		const times: number[] = [];
		let last = run();
		for (let i = 0; i < 5; i++) {
			last = run();
			times.push(last.ms);
		}
		times.sort((a, b) => a - b);
		const median = times[2]!;
		// Every weekday of the 1,000 seeded days is met: the streak is their number.
		let weekdays = 0;
		for (let n = 0; n < CHECKINS / HABITS; n++) if (![0, 6].includes(new Date(Date.UTC(2025, 0, 1) + n * 86400000).getUTCDay())) weekdays++;
		expect(last.result[0]).toEqual({ current: weekdays, best: weekdays, unit: "days" });
		expect(last.result[1]!.unit).toBe("weeks");
		if (process.env.CHECKPOINT_PERF_LOG) process.stderr.write(`habits: index + streaks ${times.map((x) => x.toFixed(1)).join("/")} ms\n`);
		expect(median, times.join("/")).toBeLessThan(BUDGET_MS);
	});
});
