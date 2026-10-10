import fc from "fast-check";
import { DateTime, IANAZone } from "luxon";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	dateSpecDate,
	dateSpecDisplayLocal,
	dateSpecSortValue,
	instantDay,
	isValidZone,
	resetTimeCaches,
	timeCacheSizes,
	wallTimeToDateTime,
} from "../../src/domain/time";
import type { DateSpec } from "../../src/domain/types";

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
