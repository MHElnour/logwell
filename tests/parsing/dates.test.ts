import { DateTime } from "luxon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseQuickAdd } from "../../src/parsing";
import type { DateLocale, ParseResult } from "../../src/parsing/types";
import { BERLIN, NY, TOKYO, at, chipLines, dateSpecOf, makeCtx } from "./helpers";

// "tonight" is today at the evening time setting (default 20:00), a datetime in
// the configured zone; an explicit time wins.

const parse = (input: string, o: Parameters<typeof makeCtx>[0] = {}) => parseQuickAdd(input, makeCtx(o));

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
const ZONES = [NY, BERLIN, TOKYO] as const;
const TIMES = ["00:30", "09:00", "13:30", "16:00", "23:30"] as const;
const LOCALES: DateLocale[] = ["en", "en-GB"];

const sched = (r: ParseResult): string | undefined => {
	const s = r.fields.scheduled;
	return s === undefined ? undefined : s.kind === "date" ? s.date : s.local;
};

/** The month and day as the locale writes it: `Oct 7` or `7 Oct`. */
const written = (locale: DateLocale, month: string, day: number): string => (locale === "en" ? `${month} ${day}` : `${day} ${month}`);

describe.each(HOSTS)("with the computer in %s", (host) => {
	const before = process.env.TZ;
	beforeAll(() => {
		process.env.TZ = host;
		// The runtime took the zone: a known instant reads as its wall hour there.
		expect(new Date("2026-10-07T14:00:00Z").getHours()).toBe(DateTime.fromISO("2026-10-07T14:00:00Z", { zone: host }).hour);
	});
	afterAll(() => {
		if (before === undefined) delete process.env.TZ;
		else process.env.TZ = before;
	});

	describe.each(ZONES)("a task in %s", (zone) => {
		for (const locale of LOCALES) {
			it.each(TIMES)(`#88: ${locale}: today's month and day at %s is today, yesterday's is next year's, tomorrow's is tomorrow`, (time) => {
				const parse = (input: string): ParseResult => parseQuickAdd(input, makeCtx({ zone, locale, now: at(zone, `2026-10-07T${time}`) }));
				expect(sched(parse(`Pay ${written(locale, "Oct", 7)}`)), time).toBe("2026-10-07");
				expect(sched(parse(`Pay ${written(locale, "October", 7)}`)), time).toBe("2026-10-07");
				expect(sched(parse(`Pay ${written(locale, "Oct", 7)} 9am`)), time).toBe("2026-10-07T09:00");
				expect(sched(parse(`Pay ${written(locale, "Oct", 7)} at 11pm`)), time).toBe("2026-10-07T23:00");
				expect(sched(parse(`Pay ${written(locale, "Oct", 6)}`)), time).toBe("2027-10-06");
				expect(sched(parse(`Pay ${written(locale, "Oct", 8)}`)), time).toBe("2026-10-08");
				expect(sched(parse(locale === "en" ? "Pay 10/07" : "Pay 07/10")), time).toBe("2026-10-07");
			});

			it.each(TIMES)(`#88: ${locale}: Feb 29 said on a Feb 29 at %s is that day`, (time) => {
				const parse = (input: string): ParseResult => parseQuickAdd(input, makeCtx({ zone, locale, now: at(zone, `2028-02-29T${time}`) }));
				expect(sched(parse(`Party ${written(locale, "Feb", 29)}`)), time).toBe("2028-02-29");
				expect(sched(parse(locale === "en" ? "Party 02/29" : "Party 29/02")), time).toBe("2028-02-29");
				expect(sched(parse(`Party ${written(locale, "Feb", 28)}`)), time).toBe("2029-02-28");
			});
		}

		it("#88: weekdays and relative words count from today in the task's zone, never the computer's", () => {
			// Wednesday 2026-10-07 10:00 and 23:30 in the zone.
			for (const time of ["10:00", "23:30"] as const) {
				const parse = (input: string): ParseResult => parseQuickAdd(input, makeCtx({ zone, now: at(zone, `2026-10-07T${time}`) }));
				expect(sched(parse("Meet wed")), time).toBeUndefined(); // said on a Wednesday: a choice, never last week
				expect(parse("Meet wed").chips[0]?.alternatives?.map((a) => (a.value?.kind === "date" ? a.value.date : "")), time).toEqual(["2026-10-07", "2026-10-14"]);
				expect(sched(parse("Meet thu")), time).toBe("2026-10-08");
				expect(sched(parse("Meet next friday")), time).toBe("2026-10-16");
				expect(sched(parse("Dinner tomorrow")), time).toBe("2026-10-08");
				expect(sched(parse("Dinner the day after tomorrow")), time).toBe("2026-10-09");
				expect(sched(parse("Call in 3 days")), time).toBe("2026-10-10");
				expect(sched(parse("Call today")), time).toBe("2026-10-07");
				expect(sched(parse("Pay Oct 7"))?.slice(0, 10), time).toBe("2026-10-07");
			}
		});

		it("#88: a repeat's typed start on today's date is today, and its end counts from it", () => {
			const r = parseQuickAdd("Pills every day starting Oct 7 for 2 weeks", makeCtx({ zone, now: at(zone, "2026-10-07T16:00") }));
			expect(sched(r)).toBe("2026-10-07");
			expect(r.fields.recurrenceEnd).toEqual({ kind: "date", date: "2026-10-20" });
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

	const parse = (input: string, local: string): ParseResult => parseQuickAdd(input, makeCtx({ zone: TOKYO, now: at(TOKYO, local) }));
	const local = (r: ParseResult): string | undefined => (r.fields.scheduled?.kind === "datetime" ? r.fields.scheduled.local : undefined);

	describe("relative times on a computer in a DST gap (#88)", () => {
		it("#88: count from the task's clock when the task's wall time does not exist on the computer", () => {
			expect(local(parse("Call in 1 hour", "2026-03-08T02:30"))).toBe("2026-03-08T03:30");
			expect(local(parse("Call in 30 minutes", "2026-03-08T02:30"))).toBe("2026-03-08T03:00");
			expect(local(parse("Call in 2 hours", "2026-03-08T02:30"))).toBe("2026-03-08T04:30");
		});

		it("#88: count from the task's clock when the computer changes its clock within the span", () => {
			// A span that lands in the computer's missing hour itself ("in 1 hour" at 01:30) stays an hour off (rule 38).
			expect(local(parse("Call in 3 hours", "2026-03-08T00:30"))).toBe("2026-03-08T03:30");
			expect(local(parse("Call in 4 hours", "2026-03-08T01:30"))).toBe("2026-03-08T05:30");
		});

		it("#88: a plain time and a date are unaffected", () => {
			const r = parse("Call tomorrow at 5pm", "2026-03-08T02:30");
			expect(local(r)).toBe("2026-03-09T17:00");
			expect(parse("Call Oct 12", "2026-03-08T02:30").fields.scheduled).toEqual({ kind: "date", date: "2026-10-12" });
			expect(local(parse("Call in 1 hour", "2026-06-10T10:00"))).toBe("2026-06-10T11:00");
		});
	});
});

const day = (r: ParseResult): string | undefined => {
	const s = r.fields.scheduled;
	return s === undefined ? undefined : s.kind === "date" ? s.date : s.local;
};

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
		const r = parseQuickAdd(input, makeCtx({ zone: TOKYO, now: at(TOKYO, "2028-02-29T21:00"), locale }));
		expect(day(r)).toBe(expected);
	});

	it.fails.each(LEAP_DAY_DEFECTS)("#69: %s (en-GB) is that day, %s", (input, intended) => {
		const r = parseQuickAdd(input, makeCtx({ zone: TOKYO, now: at(TOKYO, "2028-02-29T21:00"), locale: "en-GB" }));
		expect(day(r)).toBe(intended);
	});
});
