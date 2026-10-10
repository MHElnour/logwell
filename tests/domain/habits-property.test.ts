import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isScheduled, nextVersion, streaks, total } from "../../src/domain/habits";
import type { Checkin, Habit, Weekday } from "../../src/domain/types";
import { WEEKDAYS } from "../../src/domain/types";
import { ci, dates, habit, idx, ver } from "./habit-fixtures";

// Property tests: streaks are invariant under unscheduled days; totals equal
// the sum of the active check-ins.

const TODAY = "2026-10-14";
const DAYS = dates("2026-07-01", TODAY);

const weekdaySet = fc.subarray([...WEEKDAYS], { minLength: 1, maxLength: 6 });
/** A day-period habit with a goal of 1 to 3 on some weekdays. */
const dayHabit = fc.record({ days: weekdaySet, type: fc.constantFrom("binary" as const, "count" as const), target: fc.integer({ min: 1, max: 3 }) }).map(
	({ days, type, target }) =>
		habit("h", [ver("2026-07-01", { type, target: type === "binary" ? 1 : target }, { kind: "weekdays", days: days })]),
);
/** Per day of the range: how many check-ins it holds (mostly 0 to 3). */
const perDay = fc.array(fc.integer({ min: 0, max: 3 }), { minLength: DAYS.length, maxLength: DAYS.length });

function checkinsOf(h: Habit, counts: number[], keep: (date: string) => boolean): Checkin[] {
	const out: Checkin[] = [];
	counts.forEach((n, i) => {
		const date = DAYS[i]!;
		if (!keep(date)) return;
		for (let k = 0; k < n; k++) out.push(ci(h.id, date));
	});
	return out;
}

describe("D6 properties", () => {
	it("(1) check-ins on unscheduled days never change the current streak", () => {
		fc.assert(
			fc.property(dayHabit, perDay, perDay, (h, counts, extra) => {
				// Adding check-ins on unscheduled days changes neither streak.
				const scheduled = checkinsOf(h, counts, (d) => isScheduled(h, d));
				const noise = checkinsOf(h, extra, (d) => !isScheduled(h, d));
				expect(streaks(h, idx(...scheduled, ...noise), TODAY)).toEqual(streaks(h, idx(...scheduled), TODAY));
				// Removing the unscheduled ones from a random mix changes nothing either.
				const mixed = checkinsOf(h, extra, () => true);
				expect(streaks(h, idx(...mixed.filter((c) => isScheduled(h, c.date))), TODAY)).toEqual(streaks(h, idx(...mixed), TODAY));
			}),
			{ numRuns: 150 },
		);
	});

	it("(1) turning an unscheduled weekday on in a new version from tomorrow never changes today's streak", () => {
		fc.assert(
			fc.property(dayHabit, perDay, fc.nat(6), (h, counts, pick) => {
				const v = h.versions[0]!;
				if (v.schedule.kind !== "weekdays") return;
				const off = WEEKDAYS.filter((d) => !(v.schedule as { days: Weekday[] }).days.includes(d));
				const added = off[pick % off.length]!;
				const index = idx(...checkinsOf(h, counts, () => true));
				const before = streaks(h, index, TODAY).current;
				const tomorrow = "2026-10-15";
				const versions = nextVersion(h, v.goal, { kind: "weekdays", days: [...v.schedule.days, added] }, "MO", tomorrow);
				expect(versions.at(-1)?.effectiveFrom).toBe(tomorrow);
				expect(streaks({ ...h, versions }, index, TODAY).current).toBe(before);
			}),
			{ numRuns: 150 },
		);
	});

	it("(2) a habit's total is the sum of its non-deleted check-ins, whatever the deleted ones hold", () => {
		const entry = fc.record({
			day: fc.nat(DAYS.length - 1),
			value: fc.integer({ min: 1, max: 1_000_000 }).map((n) => n / 1000),
			deleted: fc.boolean(),
		});
		fc.assert(
			fc.property(fc.constantFrom("count" as const, "quantity" as const), fc.array(entry, { maxLength: 80 }), (type, entries) => {
				const h = habit("h", [ver("2026-07-01", { type, target: 5, unit: type === "quantity" ? "km" : null })]);
				const list = entries.map((e) => ci("h", DAYS[e.day]!, e.value, e.deleted ? { deletedAt: "2026-10-14T10:00:00.000Z" } : {}));
				const expected = list.filter((c) => c.deletedAt === null).reduce((s, c) => s + c.value, 0);
				expect(total(h, idx(...list))).toBeCloseTo(expected, 6);
			}),
			{ numRuns: 200 },
		);
	});
});
