import { describe, expect, it } from "vitest";
import { parseQuickAdd } from "../../src/parsing";
import type { ParseResult } from "../../src/parsing/types";
import { BERLIN, NY, TOKYO, at, chipLines, makeCtx, ruleKey } from "./helpers";

// Repeating tasks rule 19 and Tasks and Quick Add rule 40 (#12): Quick Add reads repeats the way people type
// them. Every case runs in three zones at the same local time, Wednesday 2026-10-07 10:00.

const ZONES = [NY, BERLIN, TOKYO] as const;
const REC = "Recurrence not supported yet";

function parse(input: string, zone: string): ParseResult {
	return parseQuickAdd(input, makeCtx({ zone, now: at(zone, "2026-10-07T10:00") }));
}

interface Case {
	in: string;
	title: string;
	/** ruleKey of fields.recurrence; absent means no repeat. */
	rec?: string;
	/** Scheduled date (date only). */
	s?: string;
	chips?: string[];
}

function check(c: Case, zone: string): void {
	const r = parse(c.in, zone);
	expect(r.title).toBe(c.title);
	expect(r.fields.recurrence === undefined ? undefined : ruleKey(r.fields.recurrence)).toBe(c.rec);
	const s = r.fields.scheduled;
	expect(s === undefined ? undefined : s.kind === "date" ? s.date : s.local).toBe(c.s);
	expect(r.fields.deadline).toBeUndefined();
	if (c.chips !== undefined) expect(chipLines(r)).toEqual(c.chips);
	for (const chip of r.chips) expect(chip.text).toBe(c.in.slice(chip.span.start, chip.span.end));
}

const CASES: Case[] = [
	// weekday lists with plain spaces (audit 128, probes)
	{ in: "Gym every mon wed fri", title: "Gym", rec: "weekly:MO,WE,FR", chips: ["applied|recurrence|every mon wed fri|r=weekly:MO,WE,FR"] },
	{ in: "Gym every mon wed and fri", title: "Gym", rec: "weekly:MO,WE,FR" },
	{ in: "Gym every Monday Wednesday", title: "Gym", rec: "weekly:MO,WE" },
	{ in: "Gym every monday friday", title: "Gym", rec: "weekly:MO,FR" },
	{ in: "Gym every sat sun", title: "Gym", rec: "weekly:SA,SU" },
	{ in: "Gym every mon wed fri at 7am", title: "Gym", rec: "weekly:MO,WE,FR@07:00" },
	{ in: "Gym every week on Monday", title: "Gym", rec: "weekly:MO" },
	{ in: "Gym every 2 weeks on mon, fri", title: "Gym", rec: "weekly/2:MO,FR" },
	{ in: "Gym every other week on tue thu", title: "Gym", rec: "weekly/2:TU,TH" },
	// yearly (audit 122, 146)
	{ in: "Taxes every year", title: "Taxes", rec: "yearly", chips: ["applied|recurrence|every year|r=yearly"] },
	{ in: "Taxes every 2 years", title: "Taxes", rec: "yearly/2" },
	{ in: "Taxes every other year", title: "Taxes", rec: "yearly/2" },
	{ in: "Bday every year on May 5", title: "Bday", rec: "yearly", s: "2027-05-05" },
	// a day of the month (audit 137, 138)
	{ in: "Pay every 15th", title: "Pay", rec: "monthly:d15" },
	{ in: "Pay every 1st of the month", title: "Pay", rec: "monthly:d1" },
	{ in: "Pay every 22nd of each month", title: "Pay", rec: "monthly:d22" },
	{ in: "Pay every 32nd", title: "Pay every 32nd", chips: [`unsupported|recurrence|every 32nd|n=${REC}`] },
	// the Nth weekday of the month, with or without `every` (audit 132)
	{ in: "Report last Friday of the month", title: "Report", rec: "monthly:FR#-1", chips: ["applied|recurrence|last Friday of the month|r=monthly:FR#-1"] },
	{ in: "Report the 2nd Tuesday of every month", title: "Report", rec: "monthly:TU#2" },
	{ in: "Last Friday of the month report", title: "report", rec: "monthly:FR#-1" },
	{ in: "Report every first monday of each month", title: "Report", rec: "monthly:MO#1" },
	// day parts: a plain daily repeat, no time (decision 13, audit 135)
	{ in: "Yoga every morning", title: "Yoga", rec: "daily", chips: ["applied|recurrence|every morning|r=daily"] },
	{ in: "Yoga every afternoon", title: "Yoga", rec: "daily" },
	{ in: "Read every evening", title: "Read", rec: "daily" },
	{ in: "Brush teeth every night", title: "Brush teeth", rec: "daily" },
	// bare repeat words at the end of the text, after title text (audit 115, 126, 127, 133, 134)
	{ in: "Stretch daily", title: "Stretch", rec: "daily", chips: ["applied|recurrence|daily|r=daily"] },
	{ in: "Sync weekly", title: "Sync", rec: "weekly" },
	{ in: "Clean fortnightly", title: "Clean", rec: "weekly/2" },
	{ in: "Bills monthly", title: "Bills", rec: "monthly" },
	{ in: "Taxes yearly", title: "Taxes", rec: "yearly" },
	{ in: "Taxes annually", title: "Taxes", rec: "yearly" },
	{ in: "Standup weekdays", title: "Standup", rec: "weekly:MO,TU,WE,TH,FR" },
	{ in: "Hike weekends", title: "Hike", rec: "weekly:SA,SU" },
	{ in: "Gym mondays", title: "Gym", rec: "weekly:MO" },
	{ in: "Gym Mondays and Fridays", title: "Gym", rec: "weekly:MO,FR" },
	{ in: "Sync weekly #Study", title: "Sync", rec: "weekly" },
	{ in: "Stretch daily tomorrow", title: "Stretch", rec: "daily", s: "2026-10-08" },
	// `starting` before a date sets the start (audit 139)
	{ in: "Gym every Monday starting next week", title: "Gym", rec: "weekly:MO", s: "2026-10-14" },
	{ in: "Gym every day starting on Oct 10", title: "Gym", rec: "daily", s: "2026-10-10" },
	// not supported yet: a notice, never a date (rule 40, audit 136, probes)
	{ in: "Call every 3 hours", title: "Call every 3 hours", chips: [`unsupported|recurrence|every 3 hours|n=${REC}`] },
	{ in: "Pills every 8 hours", title: "Pills every 8 hours", chips: [`unsupported|recurrence|every 8 hours|n=${REC}`] },
	{ in: "Stretch every 30 minutes", title: "Stretch every 30 minutes", chips: [`unsupported|recurrence|every 30 minutes|n=${REC}`] },
	{ in: "Gym every 2nd and 4th Tuesday", title: "Gym every 2nd and 4th Tuesday", chips: [`unsupported|recurrence|every 2nd and 4th Tuesday|n=${REC}`] },
	{ in: "Rent every month on the 15th and 30th", title: "Rent every month on the 15th and 30th", chips: [`unsupported|recurrence|every month on the 15th and 30th|n=${REC}`] },
	{ in: "Gym every 2nd day", title: "Gym every 2nd day", chips: [`unsupported|recurrence|every 2nd day|n=${REC}`] },
	{ in: "Taxes every May", title: "Taxes every May", chips: [`unsupported|recurrence|every May|n=${REC}`] },
	{ in: "Gym every third", title: "Gym every third", chips: [`unsupported|recurrence|every third|n=${REC}`] },
	// guards: text that only looks like a repeat stays text
	{ in: "Daily standup", title: "Daily standup", chips: [] },
	{ in: "Weekly review", title: "Weekly review", chips: [] },
	{ in: "Read every chapter", title: "Read every chapter", chips: [] },
	{ in: "Do it every time", title: "Do it every time", chips: [] },
	{ in: "Mondays are hard", title: "Mondays are hard", chips: [] },
	{ in: "Monthly report draft", title: "Monthly report draft", chips: [] },
	{ in: "#Study daily", title: "daily" },
	{ in: "Shop for 5 apples", title: "Shop for 5 apples", chips: [] },
	{ in: "Read every day 20 pages", title: "Read 20 pages", rec: "daily" },
];

describe("Quick Add repeat phrasing (#12)", () => {
	for (const zone of ZONES) {
		it.each(CASES.map((c) => [c.in, c] as const))(`${zone}: %s`, (_name, c) => check(c, zone));
	}

	it("a bare word is a repeat only at the end: \"Daily standup\" keeps its title and its date", () => {
		const r = parse("Daily standup tomorrow", NY);
		expect(r.title).toBe("Daily standup");
		expect(r.fields.recurrence).toBeUndefined();
		expect(r.fields.scheduled).toEqual({ kind: "date", date: "2026-10-08" });
	});

	it("an unsupported repeat masks its words from the date reader", () => {
		for (const input of ["Call every 3 hours", "Gym every 2nd and 4th Tuesday", "Taxes every May 5"]) {
			const r = parse(input, NY);
			expect(r.fields.scheduled, input).toBeUndefined();
			expect(r.chips.every((c) => c.kind === "recurrence" && c.status === "unsupported"), input).toBe(true);
		}
	});
});
