import { describe, expect, it } from "vitest";
import { parseQuickAdd } from "../../src/parsing";
import type { ParseResult, SpanDecision } from "../../src/parsing/types";
import { NY, at, chipOf, endOf, inZones, makeCtx, parseAt, scheduledOf } from "./helpers";

// #12: under a typed repeat, a date range is the repeat's start and its end. What each range
// reads as is a row of phrase-table.test.ts ("4b. Date ranges"); this file checks what a row cannot: an end's value
// while it is only offered, and choosing a start or accepting an end, then reading again.
// Wednesday 2026-10-07 10:00 in each zone.

type ChipOf = ParseResult["chips"][number];
const decide = (r: ParseResult, kind: "scheduled" | "repeatEnd", choose: (c: ChipOf) => SpanDecision): SpanDecision => choose(chipOf(r, kind)!);
/** Picks the alternative of a choice by its label. */
const pick = (label: string) => (c: ChipOf): SpanDecision => ({ span: c.span, text: c.text, kind: "date", value: c.alternatives!.find((a) => a.label === label)!.value! });

describe("range sides under a repeat", () => {
	it("#12: an end with a past word keeps its reading: a suggestion before the start, invalid once used", () => {
		inZones((zone) => {
			const input = "Gym every day starting Monday until last friday";
			const r = parseAt(input, zone);
			expect(scheduledOf(r), zone).toBe("2026-10-12");
			expect(chipOf(r, "repeatEnd"), zone).toMatchObject({ status: "suggestion", text: "until last friday", end: { kind: "date", date: "2026-10-02" } });
			expect(r.fields.recurrenceEnd, zone).toBeUndefined();
			expect(r.blocking, zone).toEqual([]);
			const accepted = parseAt(input, zone, { decisions: [decide(r, "repeatEnd", (c) => ({ span: c.span, text: c.text, kind: "accept" }))] });
			const chip = chipOf(accepted, "repeatEnd");
			expect(chip, zone).toMatchObject({ status: "invalid", notice: "The repeat ends before its first date." });
			expect(accepted.blocking, zone).toEqual([chip!.id]);
		});
	});

	it("#12: a Feb 29 end after a start with its own year is the next Feb 29 on or after the start: more than a year on, a suggestion", () => {
		inZones((zone) => {
			const r = parseAt("Gym every day starting Oct 12 2028 to Feb 29", zone);
			expect([scheduledOf(r), endOf(r), r.blocking], zone).toEqual(["2028-10-12", undefined, []]);
			expect(chipOf(r, "repeatEnd"), zone).toMatchObject({ status: "suggestion", notice: "Use as end date?", end: { kind: "date", date: "2032-02-29" } });
		});
	});

	it("#12: the end follows the chosen start: Next week ends on the Friday after it", () => {
		inZones((zone) => {
			const input = "Gym every day starting Wednesday until Friday";
			const r = parseAt(input, zone);
			const reread = (label: string): ParseResult => parseAt(input, zone, { decisions: [decide(r, "scheduled", pick(label))] });
			const next = reread("Next week");
			expect([scheduledOf(next), endOf(next), next.blocking, next.title], zone).toEqual(["2026-10-14", "2026-10-16", [], "Gym"]);
			const today = reread("Today");
			expect([scheduledOf(today), endOf(today), today.blocking, today.title], zone).toEqual(["2026-10-07", "2026-10-09", [], "Gym"]);
		});
	});

	it("#12: a month and day end that fits the first choice keeps its reading for Next week: invalid, it blocks saving", () => {
		inZones((zone) => {
			const input = "Gym every day starting Wednesday until Oct 10";
			const r = parseAt(input, zone);
			expect(endOf(r), zone).toBe("2026-10-10");
			const next = parseAt(input, zone, { decisions: [decide(r, "scheduled", pick("Next week"))] });
			expect(scheduledOf(next), zone).toBe("2026-10-14");
			const chip = chipOf(next, "repeatEnd");
			expect(chip, zone).toMatchObject({ status: "invalid", text: "until Oct 10", notice: "The repeat ends before its first date." });
			expect(next.blocking, zone).toEqual([chip!.id]);
			expect(next.fields.recurrenceEnd, zone).toBeUndefined();
		});
	});
});

describe("parse time of ranges under a repeat", () => {
	it("#12: reads ten ranges with a far-off start in 1,000 characters in reasonable time", () => {
		const unit = "starting Oct 12 9999 until Friday and bring water and towels and snacks for the whole group please ";
		const input = ("Gym every day " + unit.repeat(10)).slice(0, 1000);
		const ctx = makeCtx({ zone: NY, now: at(NY, "2026-10-07T10:00") });
		const started = performance.now();
		const r = parseQuickAdd(input, ctx);
		expect(performance.now() - started).toBeLessThan(2000);
		expect(r.chips.length).toBeGreaterThan(10);
	});
});
