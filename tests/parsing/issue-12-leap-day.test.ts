import * as chrono from "chrono-node";
import { describe, expect, it } from "vitest";
import { DATE_READERS } from "../../src/parsing/dates";
import { parseQuickAdd } from "../../src/parsing";
import type { DateLocale, ParsedField, ParseResult, SpanDecision } from "../../src/parsing/types";
import { BERLIN, NY, TOKYO, at, makeCtx, ruleKey } from "./helpers";

// Repeating tasks rule 19 (#12): Feb 29 is read by the one date reader. A month and day with no year is the first such
// date on or after today (#88), so a Feb 29 that the current year lacks is the next leap day.
// Wednesday 2026-10-07 10:00 in each zone.

const ZONES = [NY, BERLIN, TOKYO] as const;

function parse(input: string, zone: string, extra: { locale?: DateLocale; manual?: ParsedField[]; decisions?: SpanDecision[] } = {}): ParseResult {
	return parseQuickAdd(input, makeCtx({ zone, now: at(zone, "2026-10-07T10:00"), locale: extra.locale ?? "en", manual: extra.manual ?? [], decisions: extra.decisions ?? [] }));
}

const sched = (r: ParseResult): string | undefined => {
	const s = r.fields.scheduled;
	return s === undefined ? undefined : s.kind === "date" ? s.date : s.local;
};

describe("the date reader instances", () => {
	it("are clones with the short-year and implied-year refiners after chrono's forward step and right before the filter of impossible dates; the shared chrono instances untouched", () => {
		for (const [reader, base] of [
			[DATE_READERS.en, chrono.en.casual],
			[DATE_READERS["en-GB"], chrono.en.GB],
		] as const) {
			expect(reader).not.toBe(base);
			expect(reader.refiners.length).toBe(base.refiners.length + 2);
			const added = reader.refiners.filter((r) => !base.refiners.includes(r));
			// Only the two refiners are added; chrono's own refiners, the range merge included, are kept.
			expect(added.length).toBe(2);
			const names = reader.refiners.map((r) => (r === added[0] ? "shortYear" : r === added[1] ? "impliedYear" : r.constructor.name));
			const filter = names.indexOf("UnlikelyFormatFilter");
			expect(names.slice(filter - 2, filter)).toEqual(["shortYear", "impliedYear"]);
			expect(names.indexOf("ForwardDateRefiner")).toBeLessThan(filter - 2);
			expect(added.some((r) => base.refiners.includes(r))).toBe(false);
		}
	});
});

// Clocks from Mar 1 to Dec 31 of a leap year: this year's Feb 29 is past and next year has none, so it is the next
// leap day (2032).
describe.each(ZONES)("Feb 29 said after Feb 29 of a leap year in %s", (zone) => {
	it.each(["2028-03-01", "2028-05-01", "2028-08-15", "2028-09-01"])("on %s it is 2032-02-29, never dropped", (today) => {
		const cases: [string, DateLocale, string][] = [
			["Pay Feb 29", "en", "Pay"],
			["Pay 02/29", "en", "Pay"],
			["Pay 29/02", "en-GB", "Pay"],
			["Birthday every year on Feb 29", "en", "Birthday"],
		];
		for (const [input, locale, title] of cases) {
			const r = parseQuickAdd(input, makeCtx({ zone, now: at(zone, `${today}T10:00`), locale }));
			expect(r.title, `${today} ${input}`).toBe(title);
			expect(sched(r), `${today} ${input}`).toBe("2032-02-29");
		}
	});
});

describe.each(ZONES)("Feb 29 in %s", (zone) => {
	it("a yearly repeat on Feb 29 starts on the next Feb 29, or the year typed", () => {
		const cases: [string, DateLocale, string][] = [
			["Birthday every year on Feb 29", "en", "2028-02-29"],
			["Birthday every year on Feb 29 2032", "en", "2032-02-29"],
			["Birthday every year on 02/29", "en", "2028-02-29"],
			["Birthday every year on 29/02", "en-GB", "2028-02-29"],
			["Birthday every year on the 29th of February", "en", "2028-02-29"],
		];
		for (const [input, locale, date] of cases) {
			const r = parse(input, zone, { locale });
			expect(r.title, input).toBe("Birthday");
			expect(r.fields.recurrence === undefined ? undefined : ruleKey(r.fields.recurrence), input).toBe("yearly");
			expect(sched(r), input).toBe(date);
		}
	});

	it("a bare hour on Feb 29 is one choice on 2028-02-29", () => {
		const r = parse("Birthday every year on Feb 29 at 9", zone);
		const dates = r.chips.filter((c) => c.kind === "scheduled");
		expect(dates).toHaveLength(1);
		expect(dates[0]!.status).toBe("choice");
		expect(dates[0]!.alternatives?.map((a) => [a.label, a.value?.kind === "datetime" ? a.value.local : ""])).toEqual([
			["09:00", "2028-02-29T09:00"],
			["21:00", "2028-02-29T21:00"],
		]);
	});

	it("a plain date Feb 29 is the next Feb 29", () => {
		const r = parse("Party Feb 29", zone);
		expect(r.title).toBe("Party");
		expect(sched(r)).toBe("2028-02-29");
	});

	it("without a readable date after `every year on` the repeat is unsupported and its text stays", () => {
		const first = parse("Birthday every year on Feb 29", zone);
		const date = first.chips.find((c) => c.kind === "scheduled")!;
		const dismissed = parse("Birthday every year on Feb 29", zone, { decisions: [{ span: date.span, text: date.text, kind: "literal" }] });
		for (const r of [dismissed, parse("Birthday every year on Feb 29 2027", zone), parse("Birthday every year on Feb 30", zone)]) {
			expect(r.fields.recurrence, r.input).toBeUndefined();
			expect(r.fields.scheduled, r.input).toBeUndefined();
			expect(r.chips.find((c) => c.kind === "recurrence")?.status, r.input).toBe("unsupported");
			expect(r.title, r.input).toBe(r.input);
		}
	});

	it("with a date picked by hand the yearly repeat applies and the typed date is a suggestion", () => {
		const r = parse("Birthday every year on May 5", zone, { manual: ["scheduled"] });
		expect(r.fields.recurrence === undefined ? undefined : ruleKey(r.fields.recurrence)).toBe("yearly");
		expect(r.fields.scheduled).toBeUndefined();
		expect(r.chips.find((c) => c.kind === "scheduled")).toMatchObject({ status: "suggestion", notice: "Replace date?" });
		// The typed date stays text until it is used, like every suggestion.
		expect(r.title).toBe("Birthday May 5");
	});

	it("an end before a Feb 29 start is refused", () => {
		const r = parse("Birthday every year on Feb 29 ending Feb 28 2028", zone);
		expect(r.chips.find((c) => c.kind === "repeatEnd")).toMatchObject({ status: "invalid", notice: "The repeat ends before its first date." });
	});
});
