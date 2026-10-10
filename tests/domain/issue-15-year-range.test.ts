import fc from "fast-check";
import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { monthStats } from "../../src/domain/habits";
import { occurrencesBetween } from "../../src/domain/recurrence";
import { dateOf, dayNum, isValidDateSpec, isValidLocalDate, isoWeekdayOfDay } from "../../src/domain/time";
import { monthGrid, shiftDateByMonths } from "../../src/ui/quickadd/calendar";
import { ci, habit, idx, ver } from "./habit-fixtures";
import { rule, series } from "./recurrence-fixtures";

// Spec "Data and storage" rule 8: a date-only value is a real day in years 0000 to 9999, and day
// numbers are exact over that range (years 0000 to 0099 are not read as 1900 to 1999).

const FIRST = -719_528; // 0000-01-01
const LAST = 2_932_896; // 9999-12-31

describe("day numbers over years 0000 to 9999 (#15)", () => {
	it("0050-01-01 is its own day, not 1950-01-01", () => {
		expect(dayNum("0050-01-01")).toBe(-701_265);
		expect(dateOf(-701_265)).toBe("0050-01-01");
	});

	it("keeps today's numbers for normal years and the range ends", () => {
		expect(dayNum("1970-01-01")).toBe(0);
		expect(dayNum("2026-10-10")).toBe(20_736);
		expect(dateOf(20_736)).toBe("2026-10-10");
		expect(dayNum("0000-01-01")).toBe(FIRST);
		expect(dayNum("9999-12-31")).toBe(LAST);
		expect(dateOf(FIRST)).toBe("0000-01-01");
		expect(dateOf(LAST)).toBe("9999-12-31");
	});

	it("round-trips every day and agrees with Luxon on the weekday", () => {
		fc.assert(
			fc.property(fc.integer({ min: FIRST, max: LAST }), (n) => {
				const date = dateOf(n);
				expect(dayNum(date)).toBe(n);
				expect(isoWeekdayOfDay(n)).toBe(DateTime.fromISO(date, { zone: "UTC" }).weekday);
				expect(DateTime.fromISO(date, { zone: "UTC" }).toISODate()).toBe(date);
			}),
			{ numRuns: 5000 },
		);
	});
});

describe("isValidLocalDate is the one validator (#15)", () => {
	it.each([
		["0000-01-01", true],
		["0050-01-01", true],
		["0050-02-29", false],
		["0048-02-29", true],
		["0100-02-29", false],
		["1600-02-29", true],
		["1900-02-29", false],
		["2024-02-29", true],
		["2026-02-29", false],
		["2026-13-01", false],
		["2026-00-10", false],
		["2026-04-31", false],
		["2026-04-00", false],
		["9999-12-31", true],
		["10000-01-01", false],
		["2026-1-01", false],
		["", false],
	])("%s → %s", (value, ok) => {
		expect(isValidLocalDate(value)).toBe(ok);
		expect(isValidDateSpec({ kind: "date", date: value })).toBe(ok);
	});

	it("is false for a value that is not a string", () => {
		for (const v of [null, undefined, 20_260_101, {}, ["2026-01-01"]]) expect(isValidLocalDate(v)).toBe(false);
	});
});

describe("engines in years 0000 to 0099 (#15)", () => {
	it("a daily series anchored on 0050-01-01 falls on its own days", () => {
		const rec = series("0050-01-01", rule());
		expect(occurrencesBetween(rec, "0050-01-01", "0050-01-03", "MO")).toEqual(["0050-01-01", "0050-01-02", "0050-01-03"]);
	});

	it("a monthly series in year 0050 falls back to each month's last day", () => {
		const rec = series("0050-01-31", rule({ freq: "monthly" }));
		expect(occurrencesBetween(rec, "0050-01-01", "0050-04-30", "MO")).toEqual(["0050-01-31", "0050-02-28", "0050-03-31", "0050-04-30"]);
		const leap = series("0048-01-31", rule({ freq: "monthly", monthly: { kind: "lastDay" } }));
		expect(occurrencesBetween(leap, "0048-02-01", "0048-02-29", "MO")).toEqual(["0048-02-29"]);
	});

	it("habit month stats count the days of a month in year 0050", () => {
		const h = habit("h", [ver("0050-02-01")]);
		const index = idx(ci("h", "0050-02-01"), ci("h", "0050-02-28"));
		expect(monthStats(h, index, "0050-02", "0050-03-15")).toEqual({ met: 2, of: 28, unit: "days" });
	});

	it("the date popover grid and month shift work in year 0050", () => {
		const days = monthGrid({ year: 50, month: 2 }, "MO").filter((d) => d.inMonth).map((d) => d.date);
		expect(days).toHaveLength(28);
		expect(days[0]).toBe("0050-02-01");
		expect(days[27]).toBe("0050-02-28");
		expect(shiftDateByMonths("0050-01-31", 1)).toBe("0050-02-28");
		expect(shiftDateByMonths("0048-01-31", 1)).toBe("0048-02-29");
	});
});
