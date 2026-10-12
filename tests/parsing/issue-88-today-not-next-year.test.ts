import { DateTime } from "luxon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseQuickAdd } from "../../src/parsing";
import type { DateLocale, ParseResult } from "../../src/parsing/types";
import { BERLIN, NY, TOKYO, at, makeCtx } from "./helpers";

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
			it.each(TIMES)(`${locale}: today's month and day at %s is today, yesterday's is next year's, tomorrow's is tomorrow`, (time) => {
				const parse = (input: string): ParseResult => parseQuickAdd(input, makeCtx({ zone, locale, now: at(zone, `2026-10-07T${time}`) }));
				expect(sched(parse(`Pay ${written(locale, "Oct", 7)}`)), time).toBe("2026-10-07");
				expect(sched(parse(`Pay ${written(locale, "October", 7)}`)), time).toBe("2026-10-07");
				expect(sched(parse(`Pay ${written(locale, "Oct", 7)} 9am`)), time).toBe("2026-10-07T09:00");
				expect(sched(parse(`Pay ${written(locale, "Oct", 7)} at 11pm`)), time).toBe("2026-10-07T23:00");
				expect(sched(parse(`Pay ${written(locale, "Oct", 6)}`)), time).toBe("2027-10-06");
				expect(sched(parse(`Pay ${written(locale, "Oct", 8)}`)), time).toBe("2026-10-08");
				expect(sched(parse(locale === "en" ? "Pay 10/07" : "Pay 07/10")), time).toBe("2026-10-07");
			});

			it.each(TIMES)(`${locale}: Feb 29 said on a Feb 29 at %s is that day`, (time) => {
				const parse = (input: string): ParseResult => parseQuickAdd(input, makeCtx({ zone, locale, now: at(zone, `2028-02-29T${time}`) }));
				expect(sched(parse(`Party ${written(locale, "Feb", 29)}`)), time).toBe("2028-02-29");
				expect(sched(parse(locale === "en" ? "Party 02/29" : "Party 29/02")), time).toBe("2028-02-29");
				expect(sched(parse(`Party ${written(locale, "Feb", 28)}`)), time).toBe("2029-02-28");
			});
		}

		it("weekdays and relative words count from today in the task's zone, never the computer's", () => {
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

		it("a repeat's typed start on today's date is today, and its end counts from it", () => {
			const r = parseQuickAdd("Pills every day starting Oct 7 for 2 weeks", makeCtx({ zone, now: at(zone, "2026-10-07T16:00") }));
			expect(sched(r)).toBe("2026-10-07");
			expect(r.fields.recurrenceEnd).toEqual({ kind: "date", date: "2026-10-20" });
		});
	});
});
