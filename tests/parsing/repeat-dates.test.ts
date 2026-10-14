import { describe, expect, it } from "vitest";
import type { DateLocale } from "../../src/parsing/types";
import { chipOf, inZones, parseAt, scheduledOf } from "./helpers";

// #12: a repeat's start date. What typed text reads as is a row of
// phrase-table.test.ts; the anchor of a new series is tests/domain/recurrence.test.ts's. This file checks what a row
// cannot: choosing a start that is a choice, a dismissed date, and clocks around a leap day.
// Wednesday 2026-10-07 10:00 in each zone.

describe("a start that is a choice", () => {
	// `every year on <date>` starts on that date. While the date is still a choice (a bare hour), the repeat applies but
	// saving is blocked until the hour is chosen, so the series is never anchored on today.

	it.each(["Birthday every year on May 5 at 7", "Birthday every year on Feb 29 at 9", "Dentist every 2 years on May 5 at 7"])("#12: %s: the repeat applies, the start blocks saving until chosen", (input) => {
		inZones((zone) => {
			const because = `${input} ${zone}`;
			const r = parseAt(input, zone);
			const start = chipOf(r, "scheduled")!;
			expect(start.status, because).toBe("choice");
			expect(r.fields.recurrence?.freq, because).toBe("yearly");
			expect(r.fields.scheduled, because).toBeUndefined();
			expect(r.blocking, because).toEqual([start.id]);
			// Chosen, the start applies, the repeat keeps its rule and nothing blocks.
			const chosen = parseAt(input, zone, { decisions: [{ span: start.span, text: start.text, kind: "date", value: start.alternatives![0]!.value! }] });
			expect(chosen.blocking, because).toEqual([]);
			expect(chosen.fields.scheduled, because).toEqual(start.alternatives![0]!.value);
			expect(chosen.fields.recurrence?.freq, because).toBe("yearly");
			expect(chosen.title, because).toBe(input.split(" every")[0]);
		});
	});

	it("#12: a repeat's time that is a choice blocks and its end waits; a start date that is a choice does not block", () => {
		inZones((zone) => {
			const r = parseAt("Gym every monday at 7 until Dec 1", zone);
			expect(r.blocking.map((id) => r.chips.find((c) => c.id === id)?.kind), zone).toEqual(["recurrence"]);
			expect(chipOf(r, "repeatEnd"), zone).toMatchObject({ status: "suggestion", notice: "Applies once the repeat's time is chosen" });
			const choice = parseAt("Gym every day starting Wednesday", zone);
			expect(chipOf(choice, "scheduled")?.status, zone).toBe("choice");
			expect(choice.blocking, zone).toEqual([]);
		});
	});
});

describe("Feb 29", () => {
	// Feb 29 is read by the one date reader. A month and day with no year is the first such date on or after today (#88),
	// so a Feb 29 that the current year lacks is the next leap day.

	it("#12: said after Feb 29 of a leap year it is 2032-02-29, never dropped", () => {
		// Clocks from Mar 1 to Dec 31 of a leap year: this year's Feb 29 is past and next year has none, so it is the next
		// leap day (2032).
		const cases: [string, DateLocale, string][] = [
			["Pay Feb 29", "en", "Pay"],
			["Pay 02/29", "en", "Pay"],
			["Pay 29/02", "en-GB", "Pay"],
			["Birthday every year on Feb 29", "en", "Birthday"],
		];
		inZones((zone) => {
			for (const today of ["2028-03-01", "2028-05-01", "2028-08-15", "2028-09-01"]) {
				for (const [input, locale, title] of cases) {
					const r = parseAt(input, zone, { locale, local: `${today}T10:00` });
					const because = `${today} ${input} ${zone}`;
					expect(r.title, because).toBe(title);
					expect(scheduledOf(r), because).toBe("2032-02-29");
				}
			}
		});
	});

	it("#12: a bare hour on Feb 29 is one choice on 2028-02-29", () => {
		inZones((zone) => {
			const r = parseAt("Birthday every year on Feb 29 at 9", zone);
			const dates = r.chips.filter((c) => c.kind === "scheduled");
			expect(dates, zone).toHaveLength(1);
			expect(dates[0]!.status, zone).toBe("choice");
			expect(dates[0]!.alternatives?.map((a) => [a.label, a.value?.kind === "datetime" ? a.value.local : ""]), zone).toEqual([
				["09:00", "2028-02-29T09:00"],
				["21:00", "2028-02-29T21:00"],
			]);
		});
	});

	it("#12: a plain date Feb 29 is the next Feb 29", () => {
		inZones((zone) => {
			const r = parseAt("Party Feb 29", zone);
			expect(r.title, zone).toBe("Party");
			expect(scheduledOf(r), zone).toBe("2028-02-29");
		});
	});

	it("#12: with its date dismissed, `every year on` is unsupported and its text stays", () => {
		// Feb 29 2027 and Feb 30, which name no date, are rows of phrase-table.test.ts.
		inZones((zone) => {
			const input = "Birthday every year on Feb 29";
			const date = chipOf(parseAt(input, zone), "scheduled")!;
			const r = parseAt(input, zone, { decisions: [{ span: date.span, text: date.text, kind: "literal" }] });
			expect(r.fields.recurrence, zone).toBeUndefined();
			expect(r.fields.scheduled, zone).toBeUndefined();
			expect(chipOf(r, "recurrence")?.status, zone).toBe("unsupported");
			expect(r.title, zone).toBe(input);
		});
	});
});
