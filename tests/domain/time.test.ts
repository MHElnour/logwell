import { beforeEach, describe, expect, it, vi } from "vitest";
import { addDays, dateOf, dateSpecDate, dateSpecDisplayLocal, dateSpecSortValue, dayNum, fmtMin, instantDay, instantFromNow, isoWeekdayOf, isoWeekdayOfDay, isValidDateSpec, isValidLocalDate, isValidZone, resetTimeCaches, resolveWallTime, timeCacheSizes, todayIn, wallTimeToDateTime } from "../../src/domain/time";
import { FakeClock } from "../helpers";
import fc from "fast-check";
import { monthStats } from "../../src/domain/habits";
import { occurrencesBetween } from "../../src/domain/recurrence";
import { weekStartOf } from "../../src/domain/calendar";
import { dayLabel, monthGrid, shiftDateByMonths } from "../../src/ui/quickadd/calendar";
import { ci, habit, idx, ver } from "./habit-fixtures";
import { rule, series } from "./recurrence-fixtures";
import { DateTime, IANAZone } from "luxon";
import type { DateSpec } from "../../src/domain/types";

describe("time (TIME-01..03)", () => {
	it("validates date-only and timed specs", () => {
		expect(isValidLocalDate("2026-10-02")).toBe(true);
		expect(isValidLocalDate("2026-02-30")).toBe(false);
		expect(isValidDateSpec({ kind: "date", date: "2026-10-02" })).toBe(true);
		expect(isValidDateSpec({ kind: "datetime", local: "2026-10-02T19:00", tz: "Europe/Berlin" })).toBe(true);
		expect(isValidDateSpec({ kind: "datetime", local: "2026-10-02T19:00", tz: "Mars/Base" })).toBe(false);
		expect(isValidDateSpec({ kind: "date", date: "2026-10-02T10:00" })).toBe(false);
	});

	it("computes today in the display zone", () => {
		const clock = new FakeClock("2026-10-01T23:30:00.000Z");
		expect(todayIn("UTC", clock)).toBe("2026-10-01");
		expect(todayIn("Europe/Berlin", clock)).toBe("2026-10-02");
		expect(todayIn("America/New_York", clock)).toBe("2026-10-01");
	});

	it("gives the instant some time from now, before or after", () => {
		const clock = new FakeClock("2026-10-01T23:30:00.000Z");
		expect(instantFromNow(clock, 10 * 60_000)).toBe("2026-10-01T23:40:00.000Z");
		expect(instantFromNow(clock, -30 * 24 * 3600 * 1000)).toBe("2026-09-01T23:30:00.000Z");
		expect(instantFromNow(clock, 0)).toBe("2026-10-01T23:30:00.000Z");
	});

	it("fmtMin writes minutes from midnight as HH:mm and wraps past a day", () => {
		expect(fmtMin(0)).toBe("00:00");
		expect(fmtMin(59)).toBe("00:59");
		expect(fmtMin(600)).toBe("10:00");
		expect(fmtMin(1439)).toBe("23:59");
		expect(fmtMin(1440)).toBe("00:00");
		expect(fmtMin(-1)).toBe("23:59");
	});

	it("B17: a spring-forward gap time moves to the first valid time with a warning", () => {
		expect(resolveWallTime("2026-03-08T02:30", "America/New_York")).toEqual({
			local: "2026-03-08T03:30",
			warning: "dst-gap",
		});
		expect(resolveWallTime("2026-03-29T02:30", "Europe/Berlin")).toEqual({
			local: "2026-03-29T03:30",
			warning: "dst-gap",
		});
	});

	it("B18: a repeated fall-back time keeps the earlier offset with a warning", () => {
		const r = resolveWallTime("2026-11-01T01:30", "America/New_York");
		expect(r).toEqual({ local: "2026-11-01T01:30", warning: "dst-ambiguous" });
		expect(resolveWallTime("2026-10-25T02:30", "Europe/Berlin").warning).toBe("dst-ambiguous");
	});

	it("leaves ordinary times alone", () => {
		expect(resolveWallTime("2026-10-02T19:00", "Europe/Berlin")).toEqual({ local: "2026-10-02T19:00", warning: null });
	});

	it("B19: date-only values never move; timed values convert to the display zone", () => {
		const dateOnly = { kind: "date" as const, date: "2026-10-02" };
		expect(dateSpecDate(dateOnly, "Pacific/Auckland")).toBe("2026-10-02");
		expect(dateSpecDate(dateOnly, "America/Los_Angeles")).toBe("2026-10-02");
		const timed = { kind: "datetime" as const, local: "2026-10-02T19:00", tz: "Europe/Berlin" };
		expect(dateSpecDisplayLocal(timed, "Europe/Berlin")).toBe("2026-10-02T19:00");
		expect(dateSpecDisplayLocal(timed, "America/New_York")).toBe("2026-10-02T13:00");
		expect(dateSpecDate(timed, "Pacific/Auckland")).toBe("2026-10-03");
	});

	it("adds days across month ends", () => {
		expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
		expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
	});
});

describe("years 0000 to 9999", () => {
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

		// Boundary days checked on every run, beside the random ones: the range ends, leap days of years
		// 0, 4, 100 and 400, the 0099/0100 turn and the epoch.
		const BOUNDARY_DAYS = [FIRST, FIRST + 58, FIRST + 59, FIRST + 60, dayNum("0004-02-29"), dayNum("0099-12-31"), dayNum("0100-03-01"), dayNum("0400-02-29"), -1, 0, LAST];

		it("round-trips every day and agrees with the JavaScript calendar on the weekday", () => {
			const check = (n: number): void => {
				const date = dateOf(n);
				expect(dayNum(date)).toBe(n);
				const y = Number(date.slice(0, 4));
				const m = Number(date.slice(5, 7));
				const d = Number(date.slice(8, 10));
				const ref = new Date(0);
				ref.setUTCFullYear(y, m - 1, d);
				expect([ref.getUTCFullYear(), ref.getUTCMonth() + 1, ref.getUTCDate()]).toEqual([y, m, d]);
				expect(isoWeekdayOfDay(n)).toBe(ref.getUTCDay() === 0 ? 7 : ref.getUTCDay());
				expect(isoWeekdayOf(date)).toBe(isoWeekdayOfDay(n));
			};
			for (const n of BOUNDARY_DAYS) check(n);
			fc.assert(
				fc.property(fc.integer({ min: FIRST, max: LAST }), (n) => check(n)),
				{ numRuns: 5000, examples: BOUNDARY_DAYS.map((n) => [n]) },
			);
		});

		it("0000-02-29 is a Tuesday, and its week starts on the Monday before", () => {
			expect(dateOf(FIRST + 59)).toBe("0000-02-29");
			expect(isoWeekdayOfDay(dayNum("0000-02-29"))).toBe(2);
			expect(isoWeekdayOf("0000-02-29")).toBe(2);
			expect(weekStartOf("0000-02-29", "MO")).toBe("0000-02-28");
			expect(weekStartOf("0000-02-29", "SU")).toBe("0000-02-27");
			expect(dayLabel("0000-02-29")).toBe("Tuesday, February 29");
		});

		it("keeps the weekday of normal dates", () => {
			expect(isoWeekdayOf("2026-10-10")).toBe(6);
			expect(isoWeekdayOf("2026-10-11")).toBe(7);
			expect(isoWeekdayOf("1970-01-01")).toBe(4);
			expect(weekStartOf("2026-10-10", "MO")).toBe("2026-10-05");
			expect(weekStartOf("2026-10-10", "SU")).toBe("2026-10-04");
			expect(weekStartOf("2026-10-10", "SA")).toBe("2026-10-10");
			expect(dayLabel("2026-10-01")).toBe("Thursday, October 1");
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
});

describe("fast paths and caches", () => {
	// dateSpecDate / dateSpecDisplayLocal skip Luxon when the stored zone is the display
	// zone and the wall time is not near an offset change, and memoize the other conversions. The reference here is
	// the previous implementation, kept verbatim: every answer of the fast path and of the caches must equal it.

	type Timed = Extract<DateSpec, { kind: "datetime" }>;

	const FORMAT = "yyyy-MM-dd'T'HH:mm";
	const referenceDate = (spec: Timed, display: string): string =>
		wallTimeToDateTime(spec.local, spec.tz).setZone(display).toISODate() ?? spec.local.slice(0, 10);
	const referenceLocal = (spec: Timed, display: string): string => wallTimeToDateTime(spec.local, spec.tz).setZone(display).toFormat(FORMAT);

	const ZONES = ["Europe/Berlin", "America/New_York", "America/Santiago", "Australia/Lord_Howe", "Asia/Kolkata", "Pacific/Chatham", "UTC"];

	const pad = (n: number): string => String(n).padStart(2, "0");
	const timed = (date: string, minutes: number, tz: string): Timed => ({
		kind: "datetime",
		local: `${date}T${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`,
		tz,
	});
	const DAY = 86_400_000;
	const dateOfDay = (n: number): string => new Date(n * DAY).toISOString().slice(0, 10);

	/** Every day from 2018 to 2032 on which the zone's offset changes (and the day after), found from the offsets Luxon reports. */
	function transitionDays(zone: string): string[] {
		const z = IANAZone.create(zone);
		const days: string[] = [];
		const start = Date.UTC(2018, 0, 1) / DAY;
		const end = Date.UTC(2032, 11, 31) / DAY;
		for (let n = start; n < end; n++) {
			if (z.offset(n * DAY) !== z.offset((n + 1) * DAY)) days.push(dateOfDay(n), dateOfDay(n + 1));
		}
		return [...new Set(days)];
	}

	beforeEach(() => resetTimeCaches());

	describe("same-zone fast path equals the Luxon path", () => {
		it.each(ZONES)("%s: every quarter hour of every offset-change day and its neighbours, gap and fold included", (zone) => {
			const transitions = transitionDays(zone);
			const noDst = zone === "UTC" || zone === "Asia/Kolkata";
			if (!noDst) expect(transitions.length).toBeGreaterThan(0);
			// A zone without offset changes still gets a few ordinary days.
			const days = noDst ? ["2020-01-01", "2026-06-15", "2026-12-31"] : transitions;
			let gaps = 0;
			for (const day of days) {
				const n = Date.parse(`${day}T00:00:00Z`) / DAY;
				for (const date of [dateOfDay(n - 1), day, dateOfDay(n + 1)]) {
					for (let minutes = 0; minutes < 24 * 60; minutes += 15) {
						const spec = timed(date, minutes, zone);
						if (referenceLocal(spec, zone) !== spec.local) gaps++;
						expect(dateSpecDate(spec, zone), `${spec.local} ${zone}`).toBe(referenceDate(spec, zone));
						expect(dateSpecDisplayLocal(spec, zone), `${spec.local} ${zone}`).toBe(referenceLocal(spec, zone));
					}
				}
			}
			// The sweep really contains spring-forward gaps, whose local time Luxon moves; the fast path must not echo them.
			if (!noDst) expect(gaps).toBeGreaterThan(0);
		});

		it("a spring-forward gap time shows the moved time, not the stored one", () => {
			const spec: DateSpec = { kind: "datetime", local: "2026-03-08T02:30", tz: "America/New_York" };
			expect(dateSpecDisplayLocal(spec, "America/New_York")).toBe("2026-03-08T03:30");
			const lordHowe: DateSpec = { kind: "datetime", local: "2026-10-04T02:15", tz: "Australia/Lord_Howe" };
			expect(dateSpecDisplayLocal(lordHowe, "Australia/Lord_Howe")).toBe("2026-10-04T02:45");
		});

		it("random wall times in random zones, across 1990-2060", () => {
			const day = fc.integer({ min: Date.UTC(1990, 0, 1) / DAY, max: Date.UTC(2060, 11, 31) / DAY }).map(dateOfDay);
			fc.assert(
				fc.property(day, fc.integer({ min: 0, max: 1439 }), fc.constantFrom(...ZONES), (date, minutes, zone) => {
					const spec = timed(date, minutes, zone);
					expect(dateSpecDate(spec, zone)).toBe(referenceDate(spec, zone));
					expect(dateSpecDisplayLocal(spec, zone)).toBe(referenceLocal(spec, zone));
					expect(dateSpecSortValue(spec, zone)).toBe(referenceLocal(spec, zone));
				}),
				{ numRuns: 3000 },
			);
		});

		it("random wall times between two different zones (memoized path), asked twice", () => {
			const day = fc.integer({ min: Date.UTC(2000, 0, 1) / DAY, max: Date.UTC(2050, 11, 31) / DAY }).map(dateOfDay);
			fc.assert(
				fc.property(day, fc.integer({ min: 0, max: 1439 }), fc.constantFrom(...ZONES), fc.constantFrom(...ZONES), (date, minutes, tz, display) => {
					const spec = timed(date, minutes, tz);
					for (let pass = 0; pass < 2; pass++) {
						expect(dateSpecDate(spec, display)).toBe(referenceDate(spec, display));
						expect(dateSpecDisplayLocal(spec, display)).toBe(referenceLocal(spec, display));
					}
				}),
				{ numRuns: 3000 },
			);
		});

		it("a date-only spec is returned as is and has no display wall time", () => {
			const spec: DateSpec = { kind: "date", date: "2026-10-02" };
			expect(dateSpecDate(spec, "Europe/Berlin")).toBe("2026-10-02");
			expect(dateSpecDisplayLocal(spec, "Europe/Berlin")).toBeNull();
		});

		it("year edges: a conversion that crosses into year 10000 or before year 0 matches Luxon", () => {
			for (const [local, tz, display] of [
				["9999-12-31T23:30", "UTC", "Asia/Kolkata"],
				["0000-01-01T00:10", "UTC", "America/New_York"],
				["9999-12-31T23:30", "Asia/Kolkata", "Asia/Kolkata"],
				["0000-01-01T00:10", "Europe/Berlin", "Europe/Berlin"],
			] as const) {
				const spec: Timed = { kind: "datetime", local, tz };
				expect(dateSpecDate(spec, display)).toBe(referenceDate(spec, display));
				expect(dateSpecDisplayLocal(spec, display)).toBe(referenceLocal(spec, display));
			}
		});

		it("an unknown display zone behaves as before (no fast path, nothing cached)", () => {
			const spec: Timed = { kind: "datetime", local: "2026-10-02T19:00", tz: "Mars/Base" };
			expect(dateSpecDate(spec, "Mars/Base")).toBe(referenceDate(spec, "Mars/Base"));
			expect(dateSpecDisplayLocal(spec, "Mars/Base")).toBe(referenceLocal(spec, "Mars/Base"));
			const ok: Timed = { kind: "datetime", local: "2026-10-02T19:00", tz: "Europe/Berlin" };
			expect(dateSpecDate(ok, "Mars/Base")).toBe(referenceDate(ok, "Mars/Base"));
			expect(timeCacheSizes().conversions).toBe(0);
		});
	});

	describe("zone and conversion caches", () => {
		it("a repeated cross-zone conversion returns identical values and is computed once", () => {
			const spec: DateSpec = { kind: "datetime", local: "2026-10-02T19:00", tz: "Europe/Berlin" };
			const first = [dateSpecDate(spec, "America/New_York"), dateSpecDisplayLocal(spec, "America/New_York")];
			expect(first).toEqual(["2026-10-02", "2026-10-02T13:00"]);
			expect(timeCacheSizes().conversions).toBe(1);
			const second = [dateSpecDate(spec, "America/New_York"), dateSpecDisplayLocal(spec, "America/New_York")];
			expect(second).toEqual(first);
			expect(timeCacheSizes().conversions).toBe(1);
			// A different display zone is a different answer.
			expect(dateSpecDate(spec, "Pacific/Auckland")).toBe("2026-10-03");
			expect(timeCacheSizes().conversions).toBe(2);
		});

		it("the same-zone path caches by day, not by task", () => {
			for (let minutes = 0; minutes < 24 * 60; minutes += 5) dateSpecDate(timed("2026-10-02", minutes, "Europe/Berlin"), "Europe/Berlin");
			expect(timeCacheSizes().conversions).toBe(0);
			expect(timeCacheSizes().days).toBe(1);
		});

		it("the caches stay bounded and still answer correctly after they fill", () => {
			const display = "America/New_York";
			for (let n = 0; n < 70_000; n++) dateSpecDisplayLocal(timed(dateOfDay(10_000 + n), 600, "Europe/Berlin"), display);
			const { conversions } = timeCacheSizes();
			expect(conversions).toBeGreaterThan(0);
			expect(conversions).toBeLessThanOrEqual(65_536);
			const s = timed(dateOfDay(10_003), 600, "Europe/Berlin");
			expect(dateSpecDisplayLocal(s, display)).toBe(referenceLocal(s, display));
		});

		it("the instant-day cache is reported, clears when it fills, and still answers correctly", () => {
			const zone = "America/New_York";
			const MAX = 65_536;
			const instantAt = (n: number): string => new Date(Date.UTC(2020, 0, 1) + n * 60_000).toISOString();
			const reference = (instant: string): string | null => DateTime.fromISO(instant, { zone }).toISODate();
			expect(timeCacheSizes().instantDays).toBe(0);
			for (let n = 0; n < MAX; n++) instantDay(instantAt(n), zone);
			expect(timeCacheSizes().instantDays).toBe(MAX);
			// A repeated instant is a hit: the cache does not grow.
			instantDay(instantAt(5), zone);
			expect(timeCacheSizes().instantDays).toBe(MAX);
			// One more distinct instant at the limit empties the cache, then holds only that entry.
			instantDay(instantAt(MAX), zone);
			expect(timeCacheSizes().instantDays).toBe(1);
			for (let n = MAX + 1; n < MAX + 5000; n++) instantDay(instantAt(n), zone);
			expect(timeCacheSizes().instantDays).toBeLessThanOrEqual(MAX);
			for (const n of [0, 5, MAX - 1, MAX, MAX + 4999]) expect(instantDay(instantAt(n), zone)).toBe(reference(instantAt(n)));
			// An instant that does not parse is cached as null and stays null after a clear.
			expect(instantDay("not an instant", zone)).toBeNull();
			expect(instantDay("not an instant", zone)).toBeNull();
		});

		it("isValidZone answers as Luxon does, answers the same twice, and stays bounded", () => {
			for (const zone of [...ZONES, "Mars/Base", "", "Europe/Berlin", "utc", "UTC+3", "not a zone"]) {
				const expected = zone.length > 0 && IANAZone.isValidZone(zone);
				expect(isValidZone(zone)).toBe(expected);
				expect(isValidZone(zone)).toBe(expected);
			}
			for (let n = 0; n < 3000; n++) expect(isValidZone(`Nope/Zone${n}`)).toBe(false);
			expect(timeCacheSizes().zones).toBeLessThanOrEqual(2048);
			expect(isValidZone("Europe/Berlin")).toBe(true);
		});

		it("isValidZone does not call Luxon again for a zone it has seen", () => {
			isValidZone("Asia/Kolkata");
			const spy = vi.spyOn(IANAZone, "isValidZone");
			try {
				for (let n = 0; n < 100; n++) expect(isValidZone("Asia/Kolkata")).toBe(true);
				expect(spy).not.toHaveBeenCalled();
			} finally {
				spy.mockRestore();
			}
		});

		it("the Luxon reference is what the tests compare against", () => {
			expect(DateTime.fromISO("2026-03-08T02:30", { zone: "America/New_York" }).toFormat(FORMAT)).toBe("2026-03-08T03:30");
		});
	});
});
