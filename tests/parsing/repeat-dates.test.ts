import * as chrono from "chrono-node";
import { describe, expect, it } from "vitest";
import { occurrencesBetween, seriesAnchor, startRecurrence } from "../../src/domain/recurrence";
import type { RepeatRule } from "../../src/domain/types";
import { parseQuickAdd } from "../../src/parsing";
import { DATE_READERS } from "../../src/parsing/dates";
import type { DateLocale, ParseResult, ParsedField, SpanDecision } from "../../src/parsing/types";
import { BERLIN, NY, TOKYO, at, makeCtx, ruleKey } from "./helpers";

// Repeating tasks rules 11 and 19 (#12): a weekly repeat with picked weekdays starts on its first such weekday on or
// after its start date (today, or the typed date), so `every 2 weeks on Monday` typed on a Wednesday first falls on the
// coming Monday, not the one two weeks later. Wednesday 2026-10-07.

const ZONES = [NY, BERLIN, TOKYO] as const;
const rule = (interval: number, weekdays: RepeatRule["weekdays"]): RepeatRule => ({ freq: "weekly", interval, weekdays, monthly: null, afterCompletion: false, time: null, tz: null });
const firstOf = (r: ReturnType<typeof startRecurrence>): string | undefined => occurrencesBetween(r.recurrence, r.recurrence.anchor, "2027-12-31", "MO")[0];

describe("the anchor of a new series", () => {
	it("#12: is the first picked weekday on or after the start for a weekly rule with weekdays, else the start", () => {
		expect(seriesAnchor("2026-10-07", rule(2, ["MO"]))).toBe("2026-10-12");
		expect(seriesAnchor("2026-10-07", rule(1, ["WE"]))).toBe("2026-10-07");
		expect(seriesAnchor("2026-10-07", rule(2, ["TU", "TH"]))).toBe("2026-10-08");
		expect(seriesAnchor("2026-10-07", rule(2, null))).toBe("2026-10-07");
		expect(seriesAnchor("2026-10-07", { ...rule(1, null), freq: "daily" })).toBe("2026-10-07");
		expect(seriesAnchor("2026-10-07", { ...rule(1, null), freq: "monthly", monthly: { kind: "day", day: 5 } })).toBe("2026-10-07");
	});

	it("#12: startRecurrence uses it, so the first occurrence is the coming weekday", () => {
		const started = startRecurrence(null, rule(2, ["MO"]), undefined, "2026-10-07", BERLIN, "MO");
		expect(started.recurrence.anchor).toBe("2026-10-12");
		expect(firstOf(started)).toBe("2026-10-12");
		const timed = startRecurrence({ kind: "datetime", local: "2026-10-07T09:00", tz: BERLIN }, rule(2, ["MO"]), undefined, "2026-10-07", BERLIN, "MO");
		expect(timed.recurrence.anchor).toBe("2026-10-12");
		expect(timed.recurrence.versions[0]!.rule.time).toBe("09:00");
		expect(startRecurrence(null, rule(3, ["TU", "TH"]), undefined, "2026-10-07", BERLIN, "MO").recurrence.anchor).toBe("2026-10-08");
	});
});

describe.each(ZONES)("typed weekly repeats with weekdays in %s", (zone) => {
	const parse = (input: string, startDate?: string): ParseResult => {
		const ctx = makeCtx({ zone, now: at(zone, "2026-10-07T10:00") });
		return parseQuickAdd(input, startDate === undefined ? ctx : { ...ctx, startDate });
	};
	const first = (r: ParseResult, start = "2026-10-07"): string | undefined => {
		const s = r.fields.scheduled;
		const started = startRecurrence(s ?? null, r.fields.recurrence!, r.fields.recurrenceEnd, start, zone, "MO");
		return firstOf(started);
	};

	it.each([
		["Pay the bank every 2 weeks on Monday", "2026-10-12"],
		["Pay the bank every other monday", "2026-10-12"],
		["Pay the bank every 2 weeks monday", "2026-10-12"],
		["Cleaners every other week on friday", "2026-10-09"],
		["Review every 2 weeks on tue, thu", "2026-10-08"],
		["Gym every 3 weeks on mon-wed", "2026-10-07"],
		["Gym every monday", "2026-10-12"],
		["Gym every week on monday", "2026-10-12"],
	])("#12: %s first falls on %s", (input, date) => {
		expect(first(parse(input))).toBe(date);
	});

	it("#12: an end right after the first weekday is valid, as the series starts there", () => {
		const r = parse("Pay the bank every 2 weeks on Monday until Oct 14");
		expect(r.chips.find((c) => c.kind === "repeatEnd")).toMatchObject({ status: "applied", end: { kind: "date", date: "2026-10-14" } });
		expect(r.blocking).toEqual([]);
		const before = parse("Pay the bank every 2 weeks on Monday until Oct 11");
		expect(before.chips.find((c) => c.kind === "repeatEnd")?.status).toBe("invalid");
	});

	it("#12: a typed start moves the anchor to the first weekday on or after it", () => {
		const r = parse("Pay the bank every 2 weeks on Monday starting Oct 14");
		expect(first(r)).toBe("2026-10-19");
		expect(first(parse("Pay the bank every 2 weeks on Monday"), "2026-10-20")).toBe("2026-10-26");
	});
});

describe("a start that is a choice", () => {
	// Repeating tasks rule 19 (#12): `every year on <date>` starts on that date. While the date is still a choice (a bare
	// hour), the repeat applies but saving is blocked until the hour is chosen, so the series is never anchored on today.
	// And a range after an `every …` Quick Add cannot build stays one suggestion: only a built repeat splits it.
	// Wednesday 2026-10-07 10:00 in each zone.

	const ZONES = [NY, BERLIN, TOKYO] as const;

	function parse(input: string, zone: string, decisions: SpanDecision[] = []): ParseResult {
		return parseQuickAdd(input, makeCtx({ zone, now: at(zone, "2026-10-07T10:00"), decisions }));
	}

	const chips = (r: ParseResult): string[] => r.chips.map((c) => `${c.kind}|${c.status}|${c.text}`);

	describe.each(ZONES)("a yearly repeat whose start is a choice in %s", (zone) => {
		it.each(["Birthday every year on May 5 at 7", "Birthday every year on Feb 29 at 9", "Dentist every 2 years on May 5 at 7"])("#12: %s: the repeat applies, the start blocks saving until chosen", (input) => {
			const r = parse(input, zone);
			const start = r.chips.find((c) => c.kind === "scheduled")!;
			expect(start.status, input).toBe("choice");
			expect(r.fields.recurrence?.freq, input).toBe("yearly");
			expect(r.fields.scheduled, input).toBeUndefined();
			expect(r.blocking, input).toEqual([start.id]);
			// Chosen, the start applies, the repeat keeps its rule and nothing blocks.
			const chosen = parse(input, zone, [{ span: start.span, text: start.text, kind: "date", value: start.alternatives![0]!.value! }]);
			expect(chosen.blocking, input).toEqual([]);
			expect(chosen.fields.scheduled, input).toEqual(start.alternatives![0]!.value);
			expect(chosen.fields.recurrence?.freq, input).toBe("yearly");
			expect(chosen.title, input).toBe(input.split(" every")[0]);
		});

		it("#12: a repeat's time that is a choice blocks and its end waits; a start date that is a choice does not block", () => {
			const r = parse("Gym every monday at 7 until Dec 1", zone);
			expect(r.blocking.map((id) => r.chips.find((c) => c.id === id)?.kind)).toEqual(["recurrence"]);
			expect(r.chips.find((c) => c.kind === "repeatEnd")).toMatchObject({ status: "suggestion", notice: "Applies once the repeat's time is chosen" });
			const choice = parse("Gym every day starting Wednesday", zone);
			expect(choice.chips.find((c) => c.kind === "scheduled")?.status).toBe("choice");
			expect(choice.blocking).toEqual([]);
		});
	});

	describe.each(ZONES)("a range after an unsupported `every …` in %s", (zone) => {
		it.each([
			["Check server every 3 hours from Oct 12 to Oct 20", "every 3 hours", "unsupported|from Oct 12 to Oct 20"],
			["Standup every 2nd and 4th tuesday from Oct 12 to Dec 1", "every 2nd and 4th tuesday", "unsupported|from Oct 12 to Dec 1"],
			["Call every 3 hours, Oct 12 to Oct 20", "every 3 hours", "suggestion|Oct 12 to Oct 20"],
		])("#12: %s stays one chip that applies nothing, never a start and an end", (input, phrase, range) => {
			const r = parse(input, zone);
			// Led by a start word it is the repeat's part, not supported with it; on its own it is the suggestion a range is.
			expect(chips(r), input).toEqual([`recurrence|unsupported|${phrase}`, `scheduled|${range}`]);
			expect(r.fields.scheduled, input).toBeUndefined();
			expect(r.fields.recurrenceEnd, input).toBeUndefined();
			expect(r.title, input).toBe(input);
		});

		it("#12: a built repeat still splits it, and `until` after an unsupported one is still never a date", () => {
			const built = parse("Gym every day from Oct 12 to Oct 20", zone);
			expect(ruleKey(built.fields.recurrence!)).toBe("daily");
			expect(built.fields.recurrenceEnd).toEqual({ kind: "date", date: "2026-10-20" });
			const end = parse("Call every 3 hours until Dec 1", zone);
			expect(chips(end)).toEqual(["recurrence|unsupported|every 3 hours", "repeatEnd|unsupported|until Dec 1"]);
		});
	});
});

describe("Feb 29", () => {
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
		it("#12: are clones with date-over-time first, and the short-year and implied-year refiners after chrono's forward step and right before the filter of impossible dates; the shared chrono instances untouched", () => {
			for (const [reader, base] of [
				[DATE_READERS.en, chrono.en.casual],
				[DATE_READERS["en-GB"], chrono.en.GB],
			] as const) {
				expect(reader).not.toBe(base);
				expect(reader.refiners.length).toBe(base.refiners.length + 3);
				const added = reader.refiners.filter((r) => !base.refiners.includes(r));
				// Only the three refiners are added; chrono's own refiners, the range merge included, are kept.
				expect(added.length).toBe(3);
				const names = reader.refiners.map((r) => (r === added[0] ? "dateOverTime" : r === added[1] ? "shortYear" : r === added[2] ? "impliedYear" : r.constructor.name));
				expect(names[0]).toBe("dateOverTime");
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
		it.each(["2028-03-01", "2028-05-01", "2028-08-15", "2028-09-01"])("#12: on %s it is 2032-02-29, never dropped", (today) => {
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
		it("#12: a yearly repeat on Feb 29 starts on the next Feb 29, or the year typed", () => {
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

		it("#12: a bare hour on Feb 29 is one choice on 2028-02-29", () => {
			const r = parse("Birthday every year on Feb 29 at 9", zone);
			const dates = r.chips.filter((c) => c.kind === "scheduled");
			expect(dates).toHaveLength(1);
			expect(dates[0]!.status).toBe("choice");
			expect(dates[0]!.alternatives?.map((a) => [a.label, a.value?.kind === "datetime" ? a.value.local : ""])).toEqual([
				["09:00", "2028-02-29T09:00"],
				["21:00", "2028-02-29T21:00"],
			]);
		});

		it("#12: a plain date Feb 29 is the next Feb 29", () => {
			const r = parse("Party Feb 29", zone);
			expect(r.title).toBe("Party");
			expect(sched(r)).toBe("2028-02-29");
		});

		it("#12: without a readable date after `every year on` the repeat is unsupported and its text stays", () => {
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

		it("#12: with a date picked by hand the yearly repeat applies and the typed date is a suggestion", () => {
			const r = parse("Birthday every year on May 5", zone, { manual: ["scheduled"] });
			expect(r.fields.recurrence === undefined ? undefined : ruleKey(r.fields.recurrence)).toBe("yearly");
			expect(r.fields.scheduled).toBeUndefined();
			expect(r.chips.find((c) => c.kind === "scheduled")).toMatchObject({ status: "suggestion", notice: "Replace date?" });
			// The typed date stays text until it is used, like every suggestion.
			expect(r.title).toBe("Birthday May 5");
		});

		it("#12: an end before a Feb 29 start is refused", () => {
			const r = parse("Birthday every year on Feb 29 ending Feb 28 2028", zone);
			expect(r.chips.find((c) => c.kind === "repeatEnd")).toMatchObject({ status: "invalid", notice: "The repeat ends before its first date." });
		});
	});
});
