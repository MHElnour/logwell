import { describe, expect, it } from "vitest";
import { weekStartOf } from "../../src/domain/calendar";
import { dateOf, dayNum, weekStartOfDay } from "../../src/domain/time";
import type { WeekStart } from "../../src/domain/types";

// One week-start computation: the calendar's date-string version is the day-number owner (`weekStartOfDay`) in date form (#34).

const STARTS: WeekStart[] = ["MO", "SU", "SA"];

function dates(from: string, days: number): string[] {
	const first = dayNum(from);
	return Array.from({ length: days }, (_, i) => dateOf(first + i));
}

describe("weekStartOf agrees with weekStartOfDay", () => {
	const ranges: [string, number][] = [
		["0000-01-08", 800], // year 0 (the first days of 0000 start a week before the range), its leap day
		["1999-12-20", 40], // a century boundary
		["2023-12-25", 20], // a year boundary
		["2024-02-20", 20], // a leap day
		["2026-10-01", 21], // every weekday as a start, every week start
		["9999-12-01", 31], // the end of the supported range
	];

	for (const [from, days] of ranges) {
		it(`${from} for ${days} days, for each week start`, () => {
			for (const date of dates(from, days)) {
				for (const ws of STARTS) {
					expect(weekStartOf(date, ws), `${date} ${ws}`).toBe(dateOf(weekStartOfDay(dayNum(date), ws)));
				}
			}
		});
	}

	it("a week start day is its own week start, and the day before belongs to the week before", () => {
		for (const [date, ws] of [["2026-09-28", "MO"], ["2026-09-27", "SU"], ["2026-09-26", "SA"]] as const) {
			expect(weekStartOf(date, ws)).toBe(date);
			expect(weekStartOf(dateOf(dayNum(date) - 1), ws)).toBe(dateOf(dayNum(date) - 7));
		}
	});
});
