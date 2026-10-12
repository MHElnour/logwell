import { describe, expect, it } from "vitest";
import { occurrencesBetween, seriesAnchor, startRecurrence } from "../../src/domain/recurrence";
import type { RepeatRule } from "../../src/domain/types";
import { parseQuickAdd } from "../../src/parsing";
import type { ParseResult } from "../../src/parsing/types";
import { BERLIN, NY, TOKYO, at, makeCtx } from "./helpers";

// Repeating tasks rules 11 and 19 (#12): a weekly repeat with picked weekdays starts on its first such weekday on or
// after its start date (today, or the typed date), so `every 2 weeks on Monday` typed on a Wednesday first falls on the
// coming Monday, not the one two weeks later. Wednesday 2026-10-07.

const ZONES = [NY, BERLIN, TOKYO] as const;
const rule = (interval: number, weekdays: RepeatRule["weekdays"]): RepeatRule => ({ freq: "weekly", interval, weekdays, monthly: null, afterCompletion: false, time: null, tz: null });
const firstOf = (r: ReturnType<typeof startRecurrence>): string | undefined => occurrencesBetween(r.recurrence, r.recurrence.anchor, "2027-12-31", "MO")[0];

describe("the anchor of a new series", () => {
	it("is the first picked weekday on or after the start for a weekly rule with weekdays, else the start", () => {
		expect(seriesAnchor("2026-10-07", rule(2, ["MO"]))).toBe("2026-10-12");
		expect(seriesAnchor("2026-10-07", rule(1, ["WE"]))).toBe("2026-10-07");
		expect(seriesAnchor("2026-10-07", rule(2, ["TU", "TH"]))).toBe("2026-10-08");
		expect(seriesAnchor("2026-10-07", rule(2, null))).toBe("2026-10-07");
		expect(seriesAnchor("2026-10-07", { ...rule(1, null), freq: "daily" })).toBe("2026-10-07");
		expect(seriesAnchor("2026-10-07", { ...rule(1, null), freq: "monthly", monthly: { kind: "day", day: 5 } })).toBe("2026-10-07");
	});

	it("startRecurrence uses it, so the first occurrence is the coming weekday", () => {
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
	])("%s first falls on %s", (input, date) => {
		expect(first(parse(input))).toBe(date);
	});

	it("an end right after the first weekday is valid, as the series starts there", () => {
		const r = parse("Pay the bank every 2 weeks on Monday until Oct 14");
		expect(r.chips.find((c) => c.kind === "repeatEnd")).toMatchObject({ status: "applied", end: { kind: "date", date: "2026-10-14" } });
		expect(r.blocking).toEqual([]);
		const before = parse("Pay the bank every 2 weeks on Monday until Oct 11");
		expect(before.chips.find((c) => c.kind === "repeatEnd")?.status).toBe("invalid");
	});

	it("a typed start moves the anchor to the first weekday on or after it", () => {
		const r = parse("Pay the bank every 2 weeks on Monday starting Oct 14");
		expect(first(r)).toBe("2026-10-19");
		expect(first(parse("Pay the bank every 2 weeks on Monday"), "2026-10-20")).toBe("2026-10-26");
	});
});
