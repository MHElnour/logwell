import * as chrono from "chrono-node";
import { describe, expect, it } from "vitest";
import type { Category, Tag } from "../../src/domain/types";
import { DATE_READERS } from "../../src/parsing/dates";
import { chipLabel } from "../../src/ui/quickadd/chipLabels";
import { NY, at, chipOf, endOf, inZones, parseAt, scheduledOf } from "./helpers";

// #12: an end is `until <date>`, `ending (on) <date>`, `ends on <date>`, `for N times` or
// `for N <periods>`; an end before the start is refused. What typed text reads as (rule, start, end, blocking) is a
// row of phrase-table.test.ts; this file checks what a row cannot: the chip's label, an end's value while it is only
// offered, choosing a repeat's time, and the date readers. Wednesday 2026-10-07 10:00 in each zone.

describe("Quick Add repeat ends (#12)", () => {
	it("#12: the chip names the end", () => {
		const env = { zone: NY, today: "2026-10-07", categories: [] as Category[], tags: new Map<string, Tag>() };
		const label = (input: string): string => chipLabel(chipOf(parseAt(input, NY), "repeatEnd")!, env);
		expect(label("Pills every day until Dec 1")).toBe("Repeat: ends Dec 1");
		expect(label("Pills every day until Jan 5")).toBe("Repeat: ends Jan 5, 2027");
		expect(label("Pills every day for 5 times")).toBe("Repeat: ends after 5 times");
		expect(label("Gym every day for 2 weeks")).toBe("Repeat: ends Oct 20");
	});

	it("#12: an end that rolls more than a year past the start is a suggestion, not applied", () => {
		// A repeat's end typed as a month and day with no year that falls before the start is the next such date after the
		// start; one that rolls more than a year past the start is a visible suggestion.
		inZones((zone) => {
			for (const input of ["Gym every day from Feb 20 to Feb 29", "Gym every day starting Feb 20 until Feb 29", "Gym every day starting Feb 20, until Feb 29"]) {
				const r = parseAt(input, zone, { local: "2027-02-10T10:00" });
				const because = `${input} ${zone}`;
				expect(scheduledOf(r), because).toBe("2027-02-20");
				expect(chipOf(r, "repeatEnd"), because).toMatchObject({ status: "suggestion", notice: "Use as end date?", end: { kind: "date", date: "2028-02-29" } });
				expect(r.fields.recurrenceEnd, because).toBeUndefined();
				expect(r.blocking, because).toEqual([]);
			}
			// Within a year it applies, as before; `until Oct 1 starting Oct 3` rolls like the range `starting Oct 3 to Oct 1`.
			expect(chipOf(parseAt("Gym every day starting Dec 20 to Jan 5", zone), "repeatEnd"), zone).toMatchObject({ status: "applied", end: { kind: "date", date: "2027-01-05" } });
			expect(chipOf(parseAt("Pills every day until Oct 1 starting Oct 3", zone), "repeatEnd"), zone).toMatchObject({ status: "applied", end: { kind: "date", date: "2028-10-01" } });
		});
	});

	it("#12: an end waits, unapplied, while its repeat's time is still a choice", () => {
		inZones((zone) => {
			const input = "Gym every Monday at 7 until dec 1";
			const r = parseAt(input, zone);
			const end = chipOf(r, "repeatEnd")!;
			expect(end.status, zone).toBe("suggestion");
			expect(r.title, zone).toBe(input);
			expect(r.fields.recurrenceEnd, zone).toBeUndefined();
			const repeat = chipOf(r, "recurrence")!;
			const chosen = parseAt(input, zone, { decisions: [{ span: repeat.span, text: repeat.text, kind: "rule", rule: repeat.alternatives![0]!.rule! }] });
			expect(chosen.title, zone).toBe("Gym");
			expect(endOf(chosen), zone).toBe("2026-12-01");
		});
	});
});

describe("the date readers and the range words", () => {
	// A guard for chrono upgrades: the readers Quick Add clones keep chrono's own range merge.
	it("#12: merge `until`, `till` and `to` ranges exactly like chrono's own readers", () => {
		const ref = { instant: at(NY, "2026-10-07T10:00"), timezone: -240 };
		const own = { en: chrono.en.casual, "en-GB": chrono.en.GB };
		for (const locale of ["en", "en-GB"] as const) {
			for (const input of ["Oct 12 until Dec 1", "Oct 12 till Dec 1", "Oct 12 to Dec 1", "tomorrow until 5pm"]) {
				const mine = DATE_READERS[locale].parse(input, ref, { forwardDate: true }).map((r) => [r.index, r.text, r.end === null]);
				const theirs = own[locale].parse(input, ref, { forwardDate: true }).map((r) => [r.index, r.text, r.end === null]);
				expect(mine, `${locale} ${input}`).toEqual(theirs);
			}
			const range = DATE_READERS[locale].parse("Oct 12 until Dec 1", ref, { forwardDate: true });
			expect(range).toHaveLength(1);
			expect(range[0]?.end).not.toBeNull();
		}
	});
});
