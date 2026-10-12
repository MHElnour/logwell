import { describe, expect, it } from "vitest";
import type { Category, Tag } from "../../src/domain/types";
import { parseQuickAdd } from "../../src/parsing";
import type { ParseResult } from "../../src/parsing/types";
import { chipLabel } from "../../src/ui/quickadd/chipLabels";
import { BERLIN, NY, TOKYO, at, chipLines, makeCtx, ruleKey } from "./helpers";

// Repeating tasks rule 19 (#12): an end is `until <date>`, `ending (on) <date>`, `ends on <date>`, `(for) N times` or
// `for N <periods>`; an end before the start is refused. A repeat end is never a one-off date. Without a repeat,
// `until <date>` is a deadline. Wednesday 2026-10-07 10:00 in each zone.

const ZONES = [NY, BERLIN, TOKYO] as const;

function parse(input: string, zone: string, local = "2026-10-07T10:00"): ParseResult {
	return parseQuickAdd(input, makeCtx({ zone, now: at(zone, local) }));
}

interface Case {
	in: string;
	title: string;
	rec?: string;
	s?: string;
	/** "2026-12-01" (a date end) or "5x" (a count end); absent means no end. */
	end?: string;
	chips?: string[];
}

function endKey(r: ParseResult): string | undefined {
	const e = r.fields.recurrenceEnd;
	if (e === undefined) return undefined;
	return e.kind === "date" ? e.date : e.kind === "count" ? `${e.count}x` : "never";
}

const CASES: Case[] = [
	// an end date (audit 123, probes)
	{ in: "Pills every day until Dec 1", title: "Pills", rec: "daily", end: "2026-12-01", chips: ["applied|recurrence|every day|r=daily", "applied|repeatEnd|until Dec 1"] },
	{ in: "Pills every day until friday", title: "Pills", rec: "daily", end: "2026-10-09" },
	{ in: "Pills every day till Dec 1", title: "Pills", rec: "daily", end: "2026-12-01" },
	{ in: "Pills every day ending Dec 1", title: "Pills", rec: "daily", end: "2026-12-01" },
	{ in: "Pills every day ending on Dec 1", title: "Pills", rec: "daily", end: "2026-12-01" },
	{ in: "Pills every day ends on Dec 1", title: "Pills", rec: "daily", end: "2026-12-01" },
	{ in: "Until Dec 1 take pills every day", title: "take pills", rec: "daily", end: "2026-12-01" },
	{ in: "Pills daily until Dec 1", title: "Pills", rec: "daily", end: "2026-12-01" },
	{ in: "Gym every Monday until Nov 30 starting Oct 12", title: "Gym", rec: "weekly:MO", s: "2026-10-12", end: "2026-11-30" },
	// a count (audit 124)
	{ in: "Pills every day for 5 times", title: "Pills", rec: "daily", end: "5x", chips: ["applied|recurrence|every day|r=daily", "applied|repeatEnd|for 5 times"] },
	{ in: "Pills every day 5 times", title: "Pills", rec: "daily", end: "5x" },
	{ in: "Gym every monday at 7am for 1 time", title: "Gym", rec: "weekly:MO@07:00", end: "1x" },
	// N periods after the start: the day before the Nth period from the start (decision 10)
	{ in: "Gym every day for 2 weeks", title: "Gym", rec: "daily", end: "2026-10-20" },
	{ in: "Gym every Monday for 3 weeks", title: "Gym", rec: "weekly:MO", end: "2026-10-27" },
	{ in: "Gym every Monday for 3 Mondays", title: "Gym", rec: "weekly:MO", end: "2026-10-27" },
	{ in: "Rent every month for 6 months", title: "Rent", rec: "monthly", end: "2027-04-06" },
	{ in: "Gym every day for 10 days starting Oct 10", title: "Gym", rec: "daily", s: "2026-10-10", end: "2026-10-19" },
	// elsewhere `for` stays a duration
	{ in: "Gym every day for 45m", title: "Gym", rec: "daily" },
	// an end before the start is refused: the chip is invalid and the text stays
	{
		in: "Pills every day until Dec 1 starting Dec 10",
		title: "Pills until Dec 1",
		rec: "daily",
		s: "2026-12-10",
		chips: ["applied|recurrence|every day|r=daily", "invalid|repeatEnd|until Dec 1|n=The end date is before the first date.", "applied|scheduled|starting Dec 10"],
	},
	{ in: "Pills every day for 0 times", title: "Pills for 0 times", rec: "daily", chips: ["applied|recurrence|every day|r=daily", "invalid|repeatEnd|for 0 times|n=End after 1 or more times."] },
];

describe("Quick Add repeat ends (#12)", () => {
	for (const zone of ZONES) {
		it.each(CASES.map((c) => [c.in, c] as const))(`${zone}: %s`, (_name, c) => {
			const r = parse(c.in, zone);
			expect(r.title).toBe(c.title);
			expect(r.fields.recurrence === undefined ? undefined : ruleKey(r.fields.recurrence)).toBe(c.rec);
			const s = r.fields.scheduled;
			expect(s === undefined ? undefined : s.kind === "date" ? s.date : s.local).toBe(c.s);
			expect(r.fields.deadline).toBeUndefined();
			expect(endKey(r)).toBe(c.end);
			if (c.chips !== undefined) expect(chipLines(r)).toEqual(c.chips);
			for (const chip of r.chips) expect(chip.text).toBe(c.in.slice(chip.span.start, chip.span.end));
		});
	}

	it("an end weekday said on that weekday takes the later date", () => {
		// Friday 2026-10-09: "until friday" is next Friday, not today.
		const r = parse("Pills every day until friday", NY, "2026-10-09T10:00");
		expect(endKey(r)).toBe("2026-10-16");
	});

	it("an uncertain end date is a suggestion, not applied", () => {
		const r = parse("Pills every day until march", NY);
		expect(r.fields.recurrenceEnd).toBeUndefined();
		const chip = r.chips.find((c) => c.kind === "repeatEnd");
		expect(chip?.status).toBe("suggestion");
		expect(chip?.notice).toBe("Use as end date?");
	});

	it("without a repeat, `until <date>` is a deadline (decision 8)", () => {
		const r = parse("Pay rent until Oct 20", NY);
		expect(r.title).toBe("Pay rent");
		expect(r.fields.deadline).toEqual({ kind: "date", date: "2026-10-20" });
		expect(r.fields.scheduled).toBeUndefined();
		expect(r.fields.recurrenceEnd).toBeUndefined();
	});

	it("a bare word that is not a repeat leaves `until` a deadline", () => {
		const r = parse("Daily standup until friday", NY);
		expect(r.fields.recurrence).toBeUndefined();
		expect(r.fields.deadline).toEqual({ kind: "date", date: "2026-10-09" });
	});

	it("`for N times` and `for 2 weeks` without a repeat stay text", () => {
		for (const input of ["Do it for 5 times", "Wait for 2 days", "Travel for 2 weeks"]) {
			const r = parse(input, NY);
			expect(r.fields.recurrenceEnd, input).toBeUndefined();
			expect(r.chips.some((c) => c.kind === "repeatEnd"), input).toBe(false);
		}
	});

	it("an end of an unsupported repeat is never a date", () => {
		const r = parse("Call every 3 hours until Friday", NY);
		expect(r.fields.scheduled).toBeUndefined();
		expect(r.fields.deadline).toBeUndefined();
		expect(r.fields.recurrenceEnd).toBeUndefined();
		expect(chipLines(r)).toEqual(["unsupported|recurrence|every 3 hours|n=Recurrence not supported yet", "unsupported|repeatEnd|until Friday|n=Recurrence not supported yet"]);
	});

	it("the end applies once a bare-hour choice is made", () => {
		const r = parse("Gym every monday at 9 until Dec 1", NY);
		expect(r.fields.recurrence).toBeUndefined();
		expect(r.fields.recurrenceEnd).toBeUndefined();
		expect(r.chips.find((c) => c.kind === "repeatEnd")?.status).toBe("applied");
	});

	it("under a repeat picked by hand the typed end is a suggestion with the repeat", () => {
		const r = parseQuickAdd("Pills every day until Dec 1", makeCtx({ zone: NY, now: at(NY, "2026-10-07T10:00"), manual: ["recurrence"] }));
		expect(chipLines(r)).toEqual(["suggestion|recurrence|every day|r=daily|n=Replace repeat?", "suggestion|repeatEnd|until Dec 1|n=Replace repeat?"]);
		expect(r.fields.recurrenceEnd).toBeUndefined();
	});

	it("the chip names the end", () => {
		const env = { zone: NY, today: "2026-10-07", categories: [] as Category[], tags: new Map<string, Tag>() };
		const label = (input: string): string => chipLabel(parse(input, NY).chips.find((c) => c.kind === "repeatEnd")!, env);
		expect(label("Pills every day until Dec 1")).toBe("Repeat: ends Dec 1");
		expect(label("Pills every day until Jan 5")).toBe("Repeat: ends Jan 5, 2027");
		expect(label("Pills every day for 5 times")).toBe("Repeat: ends after 5 times");
		expect(label("Gym every day for 2 weeks")).toBe("Repeat: ends Oct 20");
	});
});
