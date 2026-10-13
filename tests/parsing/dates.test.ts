import { DateTime, Settings } from "luxon";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resetTimeCaches } from "../../src/domain/time";
import { parseQuickAdd } from "../../src/parsing";
import type { DateLocale, ParseResult } from "../../src/parsing/types";
import { BERLIN, NY, TOKYO, at, chipLines, dateSpecOf, inZones, makeCtx, parse, parseAt, scheduledOf } from "./helpers";

// "tonight" is today at the evening time setting (default 20:00), a datetime in
// the configured zone; an explicit time wins.


describe("tonight", () => {
	it("is today at 20:00 by default", () => {
		const r = parse("Call mom tonight");
		expect(r.title).toBe("Call mom");
		expect(r.fields.scheduled).toEqual(dateSpecOf("2026-10-01T20:00", NY));
		expect(chipLines(r)).toEqual(["applied|scheduled|tonight"]);
	});

	it("uses the configured evening time, in the configured zone", () => {
		const r = parse("Call mom tonight", { eveningTime: "19:30", zone: BERLIN, now: at(BERLIN, "2026-10-01T12:00") });
		expect(r.fields.scheduled).toEqual(dateSpecOf("2026-10-01T19:30", BERLIN));
	});

	it("is today's date in the zone even when it is already late", () => {
		const r = parse("Call mom tonight", { now: at(NY, "2026-10-01T23:30"), eveningTime: "21:15" });
		expect(r.fields.scheduled).toEqual(dateSpecOf("2026-10-01T21:15", NY));
	});

	it("an explicit time wins over the evening time", () => {
		const r = parse("Call tonight at 9", { eveningTime: "19:30" });
		expect(r.fields.scheduled).toEqual(dateSpecOf("2026-10-01T21:00", NY));
		expect(chipLines(r)).toEqual(["applied|scheduled|tonight at 9"]);
		const r2 = parse("Call tonight at 8:15pm", { eveningTime: "19:30" });
		expect(r2.fields.scheduled).toEqual(dateSpecOf("2026-10-01T20:15", NY));
	});

	it("keeps the existing meridiem choice for an ambiguous bare hour without 'tonight'", () => {
		const r = parse("Call at 9", { eveningTime: "19:30" });
		expect(r.chips[0]!.status).toBe("choice");
	});

	it("an evening time in a spring-forward gap follows the DST rule", () => {
		const r = parse("Call tonight", { now: at(NY, "2026-03-08T01:00"), eveningTime: "02:30" });
		expect(r.fields.scheduled).toEqual(dateSpecOf("2026-03-08T03:30", NY));
		expect(chipLines(r)).toEqual(["applied|scheduled|tonight|w=dst-gap"]);
	});

	it("other day parts still give a date only", () => {
		expect(parse("Call tomorrow morning").fields.scheduled).toEqual({ kind: "date", date: "2026-10-02" });
	});

	it("a dismissed 'tonight' stays in the title", () => {
		const r = parse("Call tonight");
		const chip = r.chips[0]!;
		const dismissed = parse("Call tonight", { decisions: [{ span: chip.span, text: chip.text, kind: "literal" }] });
		expect(dismissed.fields.scheduled).toBeUndefined();
		expect(dismissed.title).toBe("Call tonight");
	});
});

// Tasks and Quick Add rule 25 (#88): today's month and day typed in Quick Add is today in the Logwell zone, at any time
// of day and whatever the computer's zone; a time earlier than now on today's date stays today, in the past, never next
// year. A month and day with no year is the first such date on or after today, by day; yesterday's is next year's.
// Wednesday 2026-10-07 and Tuesday 2028-02-29 in each zone, with the computer's zone (`process.env.TZ`) set to another.

// Hosts from UTC+14 to UTC-11, so the host's date is a day ahead of or behind the task's zone.
const HOSTS = ["Pacific/Kiritimati", "Pacific/Auckland", "UTC", "America/Los_Angeles", "Pacific/Pago_Pago"] as const;
const TIMES = ["00:30", "09:00", "13:30", "16:00", "23:30"] as const;
const LOCALES: DateLocale[] = ["en", "en-GB"];

/** The month and day as the locale writes it: `Oct 7` or `7 Oct`. */
const written = (locale: DateLocale, month: string, day: number): string => (locale === "en" ? `${month} ${day}` : `${day} ${month}`);

/** Runs `check` for each task zone with the computer's zone (`process.env.TZ`) set to each host, then restores it. */
function onEveryHost(check: (host: string, zone: string) => void): void {
	const before = process.env.TZ;
	try {
		for (const host of HOSTS) {
			process.env.TZ = host;
			// The runtime took the zone: a known instant reads as its wall hour there.
			expect(new Date("2026-10-07T14:00:00Z").getHours(), host).toBe(DateTime.fromISO("2026-10-07T14:00:00Z", { zone: host }).hour);
			inZones((zone) => check(host, zone));
		}
	} finally {
		if (before === undefined) delete process.env.TZ;
		else process.env.TZ = before;
	}
}

describe("a month and day on a computer in another zone", () => {
	it("#88: today's month and day at any hour is today, yesterday's is next year's, tomorrow's is tomorrow", () => {
		onEveryHost((host, zone) => {
			for (const locale of LOCALES) {
				for (const time of TIMES) {
					const on = `${host} ${zone} ${locale} ${time}`;
					const read = (input: string): ParseResult => parseAt(input, zone, { locale, local: `2026-10-07T${time}` });
					expect(scheduledOf(read(`Pay ${written(locale, "Oct", 7)}`)), on).toBe("2026-10-07");
					expect(scheduledOf(read(`Pay ${written(locale, "October", 7)}`)), on).toBe("2026-10-07");
					expect(scheduledOf(read(`Pay ${written(locale, "Oct", 7)} 9am`)), on).toBe("2026-10-07T09:00");
					expect(scheduledOf(read(`Pay ${written(locale, "Oct", 7)} at 11pm`)), on).toBe("2026-10-07T23:00");
					expect(scheduledOf(read(`Pay ${written(locale, "Oct", 6)}`)), on).toBe("2027-10-06");
					expect(scheduledOf(read(`Pay ${written(locale, "Oct", 8)}`)), on).toBe("2026-10-08");
					expect(scheduledOf(read(locale === "en" ? "Pay 10/07" : "Pay 07/10")), on).toBe("2026-10-07");
				}
			}
		});
	});

	it("#88: Feb 29 said on a Feb 29 at any hour is that day", () => {
		onEveryHost((host, zone) => {
			for (const locale of LOCALES) {
				for (const time of TIMES) {
					const on = `${host} ${zone} ${locale} ${time}`;
					const read = (input: string): ParseResult => parseAt(input, zone, { locale, local: `2028-02-29T${time}` });
					expect(scheduledOf(read(`Party ${written(locale, "Feb", 29)}`)), on).toBe("2028-02-29");
					expect(scheduledOf(read(locale === "en" ? "Party 02/29" : "Party 29/02")), on).toBe("2028-02-29");
					expect(scheduledOf(read(`Party ${written(locale, "Feb", 28)}`)), on).toBe("2029-02-28");
				}
			}
		});
	});

	it("#88: weekdays and relative words count from today in the task's zone, never the computer's", () => {
		onEveryHost((host, zone) => {
			// Wednesday 2026-10-07 10:00 and 23:30 in the zone.
			for (const time of ["10:00", "23:30"] as const) {
				const on = `${host} ${zone} ${time}`;
				const read = (input: string): ParseResult => parseAt(input, zone, { local: `2026-10-07T${time}` });
				expect(scheduledOf(read("Meet wed")), on).toBeUndefined(); // said on a Wednesday: a choice, never last week
				expect(read("Meet wed").chips[0]?.alternatives?.map((a) => (a.value?.kind === "date" ? a.value.date : "")), on).toEqual(["2026-10-07", "2026-10-14"]);
				expect(scheduledOf(read("Meet thu")), on).toBe("2026-10-08");
				expect(scheduledOf(read("Meet next friday")), on).toBe("2026-10-16");
				expect(scheduledOf(read("Dinner tomorrow")), on).toBe("2026-10-08");
				expect(scheduledOf(read("Dinner the day after tomorrow")), on).toBe("2026-10-09");
				expect(scheduledOf(read("Call in 3 days")), on).toBe("2026-10-10");
				expect(scheduledOf(read("Call today")), on).toBe("2026-10-07");
				expect(scheduledOf(read("Pay Oct 7"))?.slice(0, 10), on).toBe("2026-10-07");
			}
		});
	});

	it("#88: a repeat's typed start on today's date is today, and its end counts from it", () => {
		onEveryHost((host, zone) => {
			const r = parseAt("Pills every day starting Oct 7 for 2 weeks", zone, { local: "2026-10-07T16:00" });
			expect(scheduledOf(r), `${host} ${zone}`).toBe("2026-10-07");
			expect(r.fields.recurrenceEnd, `${host} ${zone}`).toEqual({ kind: "date", date: "2026-10-20" });
		});
	});
});

describe("relative times on a computer in a DST gap", () => {
	// Tasks and Quick Add rule 25 (#88): relative times count from the task's own clock, whatever the computer's zone. The
	// computer is in New York; the task's zone is Tokyo, where nothing changes. Around the computer's spring-forward (02:00
	// on 2026-03-08 does not exist there), chrono's reading of "in 1 hour" moved an hour on the computer's clock.

	const HOST = "America/New_York";
	let before: string | undefined;

	beforeAll(() => {
		before = process.env.TZ;
		process.env.TZ = HOST;
		// The premise: the computer has no 02:30 on 2026-03-08.
		expect(DateTime.fromObject({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, { zone: "system" }).hour).toBe(3);
	});

	afterAll(() => {
		if (before === undefined) delete process.env.TZ;
		else process.env.TZ = before;
	});

	const parseOn = (input: string, local: string): ParseResult => parseAt(input, TOKYO, { local });
	const local = (r: ParseResult): string | undefined => (r.fields.scheduled?.kind === "datetime" ? r.fields.scheduled.local : undefined);

	describe("relative times on a computer in a DST gap (#88)", () => {
		it("#88: count from the task's clock when the task's wall time does not exist on the computer", () => {
			expect(local(parseOn("Call in 1 hour", "2026-03-08T02:30"))).toBe("2026-03-08T03:30");
			expect(local(parseOn("Call in 30 minutes", "2026-03-08T02:30"))).toBe("2026-03-08T03:00");
			expect(local(parseOn("Call in 2 hours", "2026-03-08T02:30"))).toBe("2026-03-08T04:30");
		});

		it("#88: count from the task's clock when the computer changes its clock within the span", () => {
			// A span that lands in the computer's missing hour itself ("in 1 hour" at 01:30) stays an hour off (rule 38).
			expect(local(parseOn("Call in 3 hours", "2026-03-08T00:30"))).toBe("2026-03-08T03:30");
			expect(local(parseOn("Call in 4 hours", "2026-03-08T01:30"))).toBe("2026-03-08T05:30");
		});

		it("#88: a plain time and a date are unaffected", () => {
			const r = parseOn("Call tomorrow at 5pm", "2026-03-08T02:30");
			expect(local(r)).toBe("2026-03-09T17:00");
			expect(parseOn("Call Oct 12", "2026-03-08T02:30").fields.scheduled).toEqual({ kind: "date", date: "2026-10-12" });
			expect(local(parseOn("Call in 1 hour", "2026-06-10T10:00"))).toBe("2026-06-10T11:00");
		});
	});
});

describe("a device whose language writes other digits", () => {
	// Arabic (Egypt) writes numbers with its own digits by default; Quick Add's dates and its clock keep 0 to 9.

	const original = Settings.defaultLocale;
	afterEach(() => {
		Settings.defaultLocale = original;
		resetTimeCaches();
	});
	const parseOn = (input: string, now: string): ParseResult => {
		Settings.defaultLocale = "ar-EG";
		resetTimeCaches();
		return parseQuickAdd(input, makeCtx({ zone: NY, now: at(NY, now) }));
	};

	it("#100: a time is read with the digits 0 to 9 and no daylight saving warning", () => {
		const r = parseOn("Call mom tomorrow at 5pm", "2026-10-01T06:00");
		expect(r.fields.scheduled).toEqual({ kind: "datetime", local: "2026-10-02T17:00", tz: NY });
		expect(chipLines(r)).toEqual(["applied|scheduled|tomorrow at 5pm"]);
	});

	it("#100: \"at 5\" offers the next 05:00 and 17:00 on the parse clock", () => {
		const r = parseOn("Call at 5", "2026-10-01T06:00");
		const values = r.chips[0]?.alternatives?.map((a) => (a.value?.kind === "datetime" ? a.value.local : ""));
		expect(values).toEqual(["2026-10-02T05:00", "2026-10-01T17:00"]);
	});
});

// A month and day without a year, said on that very day: today (#88), whatever the hour. Tuesday 2028-02-29 21:00 in
// Tokyo, late enough that chrono's own forward step would have moved it to the next leap day on any host clock.
// [input, locale, the scheduled value]
const LEAP_DAYS: ReadonlyArray<readonly [string, DateLocale, string | undefined]> = [
	["Feb 29 party", "en", "2028-02-29"],
	["Feb 29 9am party", "en", "2028-02-29T09:00"],
	["29 Feb party", "en", "2028-02-29"],
	["02/29 party", "en", "2028-02-29"],
	["29/02 party", "en", "2028-02-29"],
	["the 29th of February party", "en", "2028-02-29"],
	["29 Feb party", "en-GB", "2028-02-29"],
	["02/29 party", "en-GB", "2028-02-29"],
	["29/02 party", "en-GB", "2028-02-29"],
	["the 29th of February party", "en-GB", "2028-02-29"],
];

// Known defect (#69), not the intended reading: in en-GB, a month name before a leap day reads no date or the day
// after it. Each row is expected to fail until #69 is fixed; the fix makes them plain cases.
// [input, the intended scheduled value, what the parser reads today]
const LEAP_DAY_DEFECTS: ReadonlyArray<readonly [string, string, string | undefined]> = [
	["Feb 29 party", "2028-02-29", undefined],
	["Feb 29 9am party", "2028-02-29T09:00", "2028-03-01T09:00"],
];

describe("a leap day without a year or a repeat", () => {
	it.each(LEAP_DAYS)("#88: %s (%s) is that day", (input, locale, expected) => {
		const r = parseAt(input, TOKYO, { local: "2028-02-29T21:00", locale });
		expect(scheduledOf(r)).toBe(expected);
	});

	it.fails.each(LEAP_DAY_DEFECTS)("#69: %s (en-GB) is that day, %s", (input, intended) => {
		const r = parseAt(input, TOKYO, { local: "2028-02-29T21:00", locale: "en-GB" });
		expect(scheduledOf(r)).toBe(intended);
	});
});
