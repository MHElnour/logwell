import * as chrono from "chrono-node";
import { describe, expect, it } from "vitest";
import { DATE_READERS } from "../../src/parsing/dates";
import { parseQuickAdd } from "../../src/parsing";
import type { DateLocale, ParsedField, ParseResult, SpanDecision } from "../../src/parsing/types";
import { BERLIN, NY, TOKYO, at, makeCtx, ruleKey } from "./helpers";

// Repeating tasks rule 19 (#12): Feb 29 is read by the one date reader. A month and day with no year that does not
// exist in the year the reader assumes (Feb 29 in 2027) rolls over to the next year where it exists, from today on.
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
	it("are clones with one more refiner, the shared chrono instances untouched", () => {
		expect(DATE_READERS.en.refiners.length).toBe(chrono.en.casual.refiners.length + 1);
		expect(DATE_READERS["en-GB"].refiners.length).toBe(chrono.en.GB.refiners.length + 1);
		expect(DATE_READERS.en).not.toBe(chrono.en.casual);
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
