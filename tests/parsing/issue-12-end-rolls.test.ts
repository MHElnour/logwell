import { describe, expect, it } from "vitest";
import { parseQuickAdd } from "../../src/parsing";
import type { DateLocale, ParseResult } from "../../src/parsing/types";
import { BERLIN, NY, TOKYO, at, makeCtx } from "./helpers";

// Repeating tasks rule 19 and Tasks and Quick Add rule 25 (#12): a repeat's end typed as a month and day with no year
// that falls before the start is the next such date after the start, with `until` as in a range (`May 5 until Dec 1`
// and `May 5, until Dec 1` agree); an end that rolls more than a year past the start is a visible suggestion; and a
// two-digit number after a comma is never a year (`Jun 3, 25 people`).

const ZONES = [NY, BERLIN, TOKYO] as const;

function parse(input: string, zone: string, now = "2026-10-07T10:00", locale: DateLocale = "en"): ParseResult {
	return parseQuickAdd(input, makeCtx({ zone, locale, now: at(zone, now) }));
}
const sched = (r: ParseResult): string | undefined => (r.fields.scheduled === undefined ? undefined : r.fields.scheduled.kind === "date" ? r.fields.scheduled.date : r.fields.scheduled.local);
const endChip = (r: ParseResult) => r.chips.find((c) => c.kind === "repeatEnd");

describe.each(ZONES)("a repeat end before its start in %s", (zone) => {
	it("`until` after a comma agrees with the merged range: the end is the next such date after the start", () => {
		const plain = parse("Birthday every year on May 5 until Dec 1", zone);
		const comma = parse("Birthday every year on May 5, until Dec 1", zone);
		for (const r of [plain, comma]) {
			expect(sched(r), r.input).toBe("2027-05-05");
			expect(endChip(r), r.input).toMatchObject({ status: "applied", end: { kind: "date", date: "2027-12-01" } });
			expect(r.blocking, r.input).toEqual([]);
		}
		expect(comma.title).toBe("Birthday ,");
	});

	it("an end with its own year, or naming its own day, stays where it is: invalid before the start", () => {
		for (const input of ["Birthday every year on May 5, until Dec 1 2026", "Gym every day starting Oct 20 until tomorrow"]) {
			const r = parse(input, zone);
			expect(endChip(r)?.status, input).toBe("invalid");
			expect(r.blocking, input).toEqual([endChip(r)!.id]);
		}
		// So does an end before a start picked by hand: only a typed start moves a yearless end.
		const picked = parseQuickAdd("Stretch daily until Oct 15", { ...makeCtx({ zone, now: at(zone, "2026-10-07T10:00") }), startDate: "2026-10-20" });
		expect(endChip(picked)?.status).toBe("invalid");
	});

	it("an end that rolls more than a year past the start is a suggestion, not applied", () => {
		for (const input of ["Gym every day from Feb 20 to Feb 29", "Gym every day starting Feb 20 until Feb 29", "Gym every day starting Feb 20, until Feb 29"]) {
			const r = parse(input, zone, "2027-02-10T10:00");
			expect(sched(r), input).toBe("2027-02-20");
			expect(endChip(r), input).toMatchObject({ status: "suggestion", notice: "Use as end date?", end: { kind: "date", date: "2028-02-29" } });
			expect(r.fields.recurrenceEnd, input).toBeUndefined();
			expect(r.blocking, input).toEqual([]);
		}
		// Within a year it applies, as before; `until Oct 1 starting Oct 3` rolls like the range `starting Oct 3 to Oct 1`.
		const r = parse("Gym every day starting Dec 20 to Jan 5", zone);
		expect(endChip(r)).toMatchObject({ status: "applied", end: { kind: "date", date: "2027-01-05" } });
		expect(endChip(parse("Pills every day until Oct 1 starting Oct 3", zone))).toMatchObject({ status: "applied", end: { kind: "date", date: "2028-10-01" } });
	});
});

describe.each(ZONES)("a two-digit number after a comma in %s", (zone) => {
	it.each(["en", "en-GB"] as const)("%s: is never a year, with or without a repeat", (locale) => {
		const [jun3, may5] = locale === "en" ? ["Jun 3", "May 5"] : ["3 Jun", "5 May"];
		const yearly = parse(`Birthday every year on ${jun3}, 25 people`, zone, "2026-10-07T10:00", locale);
		expect(yearly.fields.recurrence?.freq).toBe("yearly");
		expect(sched(yearly)).toBe("2027-06-03");
		expect(yearly.title).toBe("Birthday , 25 people");
		const guests = parse(`Party ${may5}, 20 guests`, zone, "2026-10-07T10:00", locale);
		expect(sched(guests)).toBe("2027-05-05");
		expect(guests.title).toBe("Party , 20 guests");
		expect(guests.chips.map((c) => c.text)).toEqual([may5]);
		// Four digits are a year.
		expect(sched(parse(`Party ${jun3}, 2025 people`, zone, "2026-10-07T10:00", locale))).toBe("2025-06-03");
	});
});
