import { describe, expect, it } from "vitest";
import { parseQuickAdd } from "../../src/parsing";
import type { ParsedField, ParseResult, SpanDecision } from "../../src/parsing/types";
import { BERLIN, NY, TOKYO, at, chipLines, makeCtx, ruleKey } from "./helpers";

// Repeating tasks rule 19 and Tasks and Quick Add rule 40 (#12), edge cases: the start a `for N …` end counts from,
// lead words outside a repeat, ends that block saving or wait for their repeat, and lists that are not dates.
// Wednesday 2026-10-07 10:00 in each zone.

const ZONES = [NY, BERLIN, TOKYO] as const;
const REC = "Recurrence not supported yet";

function parse(input: string, zone: string, extra: { startDate?: string; manual?: ParsedField[]; decisions?: SpanDecision[] } = {}): ParseResult {
	const ctx = makeCtx({ zone, now: at(zone, "2026-10-07T10:00"), manual: extra.manual ?? [], decisions: extra.decisions ?? [] });
	return parseQuickAdd(input, extra.startDate === undefined ? ctx : { ...ctx, startDate: extra.startDate });
}

const sched = (r: ParseResult): string | undefined => {
	const s = r.fields.scheduled;
	return s === undefined ? undefined : s.kind === "date" ? s.date : s.local;
};
const endKey = (r: ParseResult): string | undefined => {
	const e = r.fields.recurrenceEnd;
	return e === undefined ? undefined : e.kind === "date" ? e.date : e.kind === "count" ? `${e.count}x` : "never";
};
const rec = (r: ParseResult): string | undefined => (r.fields.recurrence === undefined ? undefined : ruleKey(r.fields.recurrence));

describe.each(ZONES)("Quick Add repeat edges (#12) in %s", (zone) => {
	it("`for N …` counts from the start the model has (a date picked by hand or a preset)", () => {
		const r = parse("Stretch daily for 2 weeks", zone, { startDate: "2026-10-20" });
		expect(endKey(r)).toBe("2026-11-02");
		const before = parse("Stretch daily until Oct 15", zone, { startDate: "2026-10-20" });
		expect(chipLines(before)).toEqual(["applied|recurrence|daily|r=daily", "invalid|repeatEnd|until Oct 15|n=The repeat ends before its first date."]);
		// A typed date wins over the model's start, as it does on save.
		expect(endKey(parse("Stretch daily for 2 weeks starting Oct 10", zone, { startDate: "2026-10-20" }))).toBe("2026-10-23");
	});

	it("an end before the first occurrence is invalid, not only one before the start", () => {
		const r = parse("Gym every friday until Oct 8", zone);
		expect(rec(r)).toBe("weekly:FR");
		expect(endKey(r)).toBeUndefined();
		expect(r.chips.find((c) => c.kind === "repeatEnd")).toMatchObject({ status: "invalid", notice: "The repeat ends before its first date." });
	});

	it("an invalid end blocks saving", () => {
		const r = parse("Pills every day until Oct 1 starting Oct 3", zone);
		const end = r.chips.find((c) => c.kind === "repeatEnd")!;
		expect(end.status).toBe("invalid");
		expect(r.blocking).toEqual([end.id]);
		const count = parse("Read daily for 1000 times", zone);
		expect(chipLines(count)).toEqual(["applied|recurrence|daily|r=daily", "invalid|repeatEnd|for 1000 times|n=End after 1 to 999 times."]);
		expect(count.blocking.length).toBe(1);
	});

	it("outside a repeat only `until` leads a date; ending, till, beginning and starting stay title words", () => {
		const cases: [string, string, string][] = [
			["Edit the ending tomorrow", "Edit the ending", "2026-10-08"],
			["Read the beginning tomorrow", "Read the beginning", "2026-10-08"],
			["Fix the movie ending friday", "Fix the movie ending", "2026-10-09"],
			["Watch the starting lineup friday", "Watch the starting lineup", "2026-10-09"],
			["Practice till tomorrow", "Practice till", "2026-10-08"],
		];
		for (const [input, title, date] of cases) {
			const r = parse(input, zone);
			expect(r.title, input).toBe(title);
			expect(sched(r), input).toBe(date);
			expect(r.fields.deadline, input).toBeUndefined();
		}
		const until = parse("Stay until tomorrow", zone);
		expect(until.title).toBe("Stay");
		expect(until.fields.deadline).toEqual({ kind: "date", date: "2026-10-08" });
	});

	it("an end waits, unapplied, while its repeat's time is still a choice", () => {
		const input = "Gym every Monday at 7 until dec 1";
		const r = parse(input, zone);
		const end = r.chips.find((c) => c.kind === "repeatEnd")!;
		expect(end.status).toBe("suggestion");
		expect(r.title).toBe(input);
		expect(r.fields.recurrenceEnd).toBeUndefined();
		const repeat = r.chips.find((c) => c.kind === "recurrence")!;
		const chosen = parse(input, zone, { decisions: [{ span: repeat.span, text: repeat.text, kind: "rule", rule: repeat.alternatives![0]!.rule! }] });
		expect(chosen.title).toBe("Gym");
		expect(endKey(chosen)).toBe("2026-12-01");
	});

	it("with a repeat picked by hand, `until <date>` is its end, not a deadline", () => {
		const r = parse("Pills until Dec 1", zone, { manual: ["recurrence"] });
		expect(r.title).toBe("Pills");
		expect(r.fields.deadline).toBeUndefined();
		expect(endKey(r)).toBe("2026-12-01");
	});

	it("more weekdays after `every other` or `every N weeks` are part of the repeat, never a date", () => {
		const cases: [string, string, string | undefined][] = [
			["Trash every other monday and wednesday", "Trash", "weekly/2:MO,WE"],
			["Trash every other monday wed", "Trash", "weekly/2:MO,WE"],
			["Gym every 2 weeks tuesday", "Gym", "weekly/2:TU"],
			["Gym every week monday", "Gym", "weekly:MO"],
			["Run every day first thing", "Run first thing", "daily"],
		];
		for (const [input, title, key] of cases) {
			const r = parse(input, zone);
			expect(r.title, input).toBe(title);
			expect(rec(r), input).toBe(key);
			expect(sched(r), input).toBeUndefined();
		}
		for (const input of ["Gym every 3 days monday", "Gym every monday at 7 wednesday", "Gym every month 15th", "Gym every other 2nd tuesday"]) {
			const r = parse(input, zone);
			expect(sched(r), input).toBeUndefined();
			expect(r.fields.recurrence, input).toBeUndefined();
			expect(r.chips.map((c) => `${c.kind}|${c.status}|${c.notice ?? ""}`), input).toEqual([`recurrence|unsupported|${REC}`]);
		}
	});

	it("`sat` and `sun` continue a space-joined list only at the end of the text; the full names always do", () => {
		const cases: [string, string, string, string | undefined][] = [
			["Apply every monday sun cream", "Apply sun cream", "weekly:MO", undefined],
			["Gym every monday sat exam prep", "Gym sat exam prep", "weekly:MO", undefined],
			["Gym every mon wed sat", "Gym", "weekly:MO,WE,SA", undefined],
			["Mow lawn every saturday sun", "Mow lawn", "weekly:SA,SU", undefined],
			["Gym every mon sat at 9am", "Gym", "weekly:MO,SA@09:00", undefined],
			["Gym every saturday sunday mornings", "Gym mornings", "weekly:SA,SU", undefined],
			["Gym every mon, sat and stretch", "Gym and stretch", "weekly:MO,SA", undefined],
		];
		for (const [input, title, key] of cases) {
			const r = parse(input, zone);
			expect(r.title, input).toBe(title);
			expect(rec(r), input).toBe(key);
			expect(r.fields.scheduled, input).toBeUndefined();
		}
	});

	it("leaves no stray `on` or comma in the title", () => {
		const cases: [string, string, string, string | undefined][] = [
			["Gym on mondays", "Gym", "weekly:MO", undefined],
			["Party on the last friday of the month", "Party", "monthly:FR#-1", undefined],
			["Practice daily, for 10 times", "Practice", "daily", "10x"],
		];
		for (const [input, title, key, end] of cases) {
			const r = parse(input, zone);
			expect(r.title, input).toBe(title);
			expect(rec(r), input).toBe(key);
			expect(endKey(r), input).toBe(end);
		}
	});

	it("`every year on Feb 29` starts on the next Feb 29", () => {
		const r = parse("Bday every year on Feb 29", zone);
		expect(r.title).toBe("Bday");
		expect(rec(r)).toBe("yearly");
		expect(sched(r)).toBe("2028-02-29");
		expect(parse("Bday every year on 29th February", zone).fields.scheduled).toEqual({ kind: "date", date: "2028-02-29" });
		const before = parse("Bday every year on Feb 29 until Feb 28 2028", zone);
		expect(before.chips.find((c) => c.kind === "repeatEnd")).toMatchObject({ status: "invalid", notice: "The repeat ends before its first date." });
	});

	it("`every year on` followed by no readable date is not supported, never a repeat from today", () => {
		const r = parse("Bday every year on 45", zone);
		expect(r.fields.recurrence).toBeUndefined();
		expect(r.fields.scheduled).toBeUndefined();
		expect(r.chips.find((c) => c.kind === "recurrence")?.status).toBe("unsupported");
	});

	it("`for N <periods>` anywhere after a repeat is its end, never part of a date", () => {
		for (const input of ["Gym every day starting Friday for 2 weeks", "Gym every day for 2 weeks starting Friday", "Gym every day from Friday for 2 weeks"]) {
			const r = parse(input, zone);
			expect(sched(r), input).toBe("2026-10-09");
			expect(endKey(r), input).toBe("2026-10-22");
			expect(rec(r), input).toBe("daily");
		}
		expect(parse("Gym every day starting Friday for 2 weeks", zone).title).toBe("Gym");
		// Without a repeat nothing changes.
		expect(parse("Travel for 2 weeks", zone).chips).toEqual([]);
	});
});
