import { describe, expect, it } from "vitest";
import { parseQuickAdd } from "../../src/parsing";
import type { DateLocale, ParseResult } from "../../src/parsing/types";
import { BERLIN, NY, TOKYO, at, makeCtx, ruleKey } from "./helpers";

// Repeating tasks rule 19 (#12): under a typed repeat, a date range (`starting Oct 12 to Dec 1`, `from … till …`, or
// the range right after the repeat) is the repeat's start and its end. Only when both sides name a day; a side that
// is only a time (`until 5pm`) and every range without a typed repeat keep their one visible suggestion. The start
// keeps its own year (not the end's); an end without a year that falls before the start moves forward, as chrono's
// own range does (a weekday by a week, a month and day by a year), so `Oct 12 to Oct 1` ends on Oct 1 next year, the
// same as `until Oct 1 starting Oct 12`.
// Wednesday 2026-10-07 10:00 in each zone.

const ZONES = [NY, BERLIN, TOKYO] as const;

function parse(input: string, zone: string, locale: DateLocale = "en"): ParseResult {
	return parseQuickAdd(input, makeCtx({ zone, now: at(zone, "2026-10-07T10:00"), locale }));
}

const day = (r: ParseResult): string | undefined => {
	const s = r.fields.scheduled;
	return s === undefined ? undefined : s.kind === "date" ? s.date : s.local;
};
const end = (r: ParseResult): string | undefined => {
	const e = r.fields.recurrenceEnd;
	return e === undefined ? undefined : e.kind === "date" ? e.date : e.kind;
};
const rule = (r: ParseResult): string | undefined => (r.fields.recurrence === undefined ? undefined : ruleKey(r.fields.recurrence));

// [input, locale, repeat, title, start, end, the start chip's text, the end chip's text]
const SPLITS: ReadonlyArray<readonly [string, DateLocale, string, string, string, string, string, string]> = [
	["Gym every day starting Oct 12 to Dec 1", "en", "daily", "Gym", "2026-10-12", "2026-12-01", "starting Oct 12", "to Dec 1"],
	["Gym every day starting Oct 12 until Dec 1", "en", "daily", "Gym", "2026-10-12", "2026-12-01", "starting Oct 12", "until Dec 1"],
	["Gym every day from Oct 12 till Dec 1", "en", "daily", "Gym", "2026-10-12", "2026-12-01", "from Oct 12", "till Dec 1"],
	["Gym every day Oct 12 to Dec 1", "en", "daily", "Gym", "2026-10-12", "2026-12-01", "Oct 12", "to Dec 1"],
	["Gym every day starting Oct 12 through Dec 1", "en", "daily", "Gym", "2026-10-12", "2026-12-01", "starting Oct 12", "through Dec 1"],
	["Gym every day starting Oct 12 - Dec 1", "en", "daily", "Gym", "2026-10-12", "2026-12-01", "starting Oct 12", "- Dec 1"],
	["Gym every Monday starting Oct 12 till Dec 1", "en", "weekly:MO", "Gym", "2026-10-12", "2026-12-01", "starting Oct 12", "till Dec 1"],
	["Standup every weekday starting Monday until Friday", "en", "weekly:MO,TU,WE,TH,FR", "Standup", "2026-10-12", "2026-10-16", "starting Monday", "until Friday"],
	["Taxes every year starting April 15 until Apr 16 2030", "en", "yearly", "Taxes", "2027-04-15", "2030-04-16", "starting April 15", "until Apr 16 2030"],
	["Taxes every year on April 15 until Apr 16 2030", "en", "yearly", "Taxes", "2027-04-15", "2030-04-16", "April 15", "until Apr 16 2030"],
	["Gym every day from 12/10 to 1/12", "en-GB", "daily", "Gym", "2026-10-12", "2026-12-01", "from 12/10", "to 1/12"],
	["Gym every day starting 12 Oct until 1 Dec", "en-GB", "daily", "Gym", "2026-10-12", "2026-12-01", "starting 12 Oct", "until 1 Dec"],
	// An end without a year before the start moves forward a year; the start keeps its own date.
	["Gym every day starting Dec 20 to Jan 5", "en", "daily", "Gym", "2026-12-20", "2027-01-05", "starting Dec 20", "to Jan 5"],
	["Gym every day starting Oct 12 to Oct 1", "en", "daily", "Gym", "2026-10-12", "2027-10-01", "starting Oct 12", "to Oct 1"],
	// A start with its own year keeps it; the end without one moves to the first such date on or after the start.
	["Gym every day starting Oct 12 2027 to Dec 1", "en", "daily", "Gym", "2027-10-12", "2027-12-01", "starting Oct 12 2027", "to Dec 1"],
	// A weekday end said on that weekday, after the start: the first one on or after the start, never a choice.
	["Gym every day starting Monday until Wednesday", "en", "daily", "Gym", "2026-10-12", "2026-10-14", "starting Monday", "until Wednesday"],
	["Rent every month on the 15th from Nov 15 to Mar 15", "en", "monthly:d15", "Rent", "2026-11-15", "2027-03-15", "from Nov 15", "to Mar 15"],
];

describe.each(ZONES)("a date range under a typed repeat in %s", (zone) => {
	it.each(SPLITS)("%s (%s) gives the repeat's start and end", (input, locale, repeat, title, start, until, startText, endText) => {
		const r = parse(input, zone, locale);
		expect(rule(r)).toBe(repeat);
		expect(r.title).toBe(title);
		expect(day(r)).toBe(start);
		expect(end(r)).toBe(until);
		expect(r.fields.deadline).toBeUndefined();
		expect(r.blocking).toEqual([]);
		expect(r.chips.find((c) => c.kind === "scheduled")).toMatchObject({ status: "applied", text: startText });
		expect(r.chips.find((c) => c.kind === "repeatEnd")).toMatchObject({ status: "applied", text: endText });
	});

	it("reads the same start and end as the end typed before the start", () => {
		for (const [range, reversed] of [
			["Gym every day starting Oct 12 until Dec 1", "Gym every day until Dec 1 starting Oct 12"],
			["Gym every day starting Oct 12 until Oct 1", "Gym every day until Oct 1 starting Oct 12"],
		] as const) {
			const a = parse(range, zone);
			const b = parse(reversed, zone);
			expect([day(a), end(a), a.title], range).toEqual([day(b), end(b), b.title]);
		}
	});

	it("an end with its own year before the start is invalid and blocks saving", () => {
		const r = parse("Gym every day starting Oct 12 2026 to Oct 1 2026", zone);
		expect(day(r)).toBe("2026-10-12");
		const chip = r.chips.find((c) => c.kind === "repeatEnd");
		expect(chip).toMatchObject({ status: "invalid", notice: "The repeat ends before its first date.", text: "to Oct 1 2026" });
		expect(r.blocking).toEqual([chip!.id]);
		expect(r.fields.recurrenceEnd).toBeUndefined();
	});

	it("a start said on its weekday stays the today-or-next-week choice; the end counts from today", () => {
		const r = parse("Gym every day starting Wednesday until Friday", zone);
		expect(r.chips.find((c) => c.kind === "scheduled")).toMatchObject({ status: "choice", text: "starting Wednesday" });
		expect(r.fields.scheduled).toBeUndefined();
		expect(end(r)).toBe("2026-10-09");
	});

	it("a range that is not right after the repeat and has no start word stays one suggestion", () => {
		const r = parse("Gym every day with Ann Oct 12 to Dec 1", zone);
		expect(rule(r)).toBe("daily");
		expect(r.fields.scheduled).toBeUndefined();
		expect(r.fields.recurrenceEnd).toBeUndefined();
		expect(r.chips.find((c) => c.kind === "scheduled")).toMatchObject({ status: "suggestion", text: "Oct 12 to Dec 1" });
		expect(r.title).toBe("Gym with Ann Oct 12 to Dec 1");
	});
});

// Inputs the range rule never reads: no typed repeat, or a side that is only a time. Each keeps exactly what it gave
// before: [input, locale, title, the date chips as "kind status text date"].
const GUARDS: ReadonlyArray<readonly [string, DateLocale, string, readonly string[]]> = [
	["Meeting tomorrow until 5pm", "en", "Meeting tomorrow until 5pm", ["scheduled suggestion tomorrow until 5pm"]],
	["Party Friday until midnight", "en", "Party Friday until midnight", ["scheduled suggestion Friday until midnight"]],
	["Meeting Oct 12 until noon", "en", "Meeting Oct 12 until noon", ["scheduled suggestion Oct 12 until noon"]],
	["Meeting 12 Oct until 5pm", "en-GB", "Meeting 12 Oct until 5pm", ["scheduled suggestion 12 Oct until 5pm"]],
	["Trip Oct 12 till Dec 1", "en", "Trip Oct 12 till Dec 1", ["scheduled suggestion Oct 12 till Dec 1"]],
	["Trip tomorrow till Friday", "en", "Trip tomorrow till Friday", ["scheduled suggestion tomorrow till Friday"]],
	["Trip Monday until Friday", "en", "Trip Monday until Friday", ["scheduled suggestion Monday until Friday"]],
	["Trip 20/10 until 12/10", "en-GB", "Trip 20/10 until 12/10", ["scheduled suggestion 20/10 until 12/10"]],
	["Trip Oct 12 to Oct 20", "en", "Trip Oct 12 to Oct 20", ["scheduled suggestion Oct 12 to Oct 20"]],
	["Trip from Oct 12 to Oct 20", "en", "Trip from Oct 12 to Oct 20", ["scheduled suggestion Oct 12 to Oct 20"]],
	["Work from 9 until 5", "en", "Work from 9 until 5", ["scheduled suggestion from 9 until 5"]],
	["Call 2pm until 3pm", "en", "Call 2pm until 3pm", ["scheduled suggestion 2pm until 3pm"]],
	["Gym every day at 9 until 5pm", "en", "Gym every day at 9 until 5pm", ["repeatEnd suggestion until 5pm"]],
	["Gym every day starting Oct 12 until 5pm", "en", "Gym starting Oct 12 until 5pm", ["scheduled suggestion 12 until 5pm"]],
	["Gym every day starting Oct 12 to 15", "en", "Gym starting Oct 12 to 15", ["scheduled suggestion starting Oct 12 to 15"]],
	["Gym every day from Oct 12", "en", "Gym from", ["scheduled applied Oct 12"]],
	["Daily standup from Oct 12 to Dec 1", "en", "Daily standup from Oct 12 to Dec 1", ["scheduled suggestion Oct 12 to Dec 1"]],
];

describe.each(ZONES)("inputs the range rule leaves as they are in %s", (zone) => {
	it.each(GUARDS)("%s (%s)", (input, locale, title, chips) => {
		const r = parse(input, zone, locale);
		expect(r.title).toBe(title);
		const dates = r.chips.filter((c) => c.kind === "scheduled" || c.kind === "deadline" || c.kind === "repeatEnd");
		expect(dates.map((c) => `${c.kind} ${c.status} ${c.text}`)).toEqual(chips);
		expect(r.fields.recurrenceEnd).toBeUndefined();
		expect(r.fields.deadline).toBeUndefined();
	});

	it("a repeat picked by hand never splits a range: it stays one suggestion", () => {
		const daily = { freq: "daily", interval: 1, weekdays: null, monthly: null, afterCompletion: false, time: null, tz: null } as const;
		const ctx = makeCtx({ zone, now: at(zone, "2026-10-07T10:00"), manual: ["recurrence"] });
		const r = parseQuickAdd("Gym starting Oct 12 to Dec 1", { ...ctx, pickedRule: daily });
		expect(r.chips.map((c) => `${c.kind} ${c.status} ${c.text}`)).toEqual(["scheduled suggestion starting Oct 12 to Dec 1"]);
		expect(r.fields.scheduled).toBeUndefined();
		expect(r.fields.recurrenceEnd).toBeUndefined();
	});

	it("the end typed before the start still gives both", () => {
		const r = parse("Gym every day until Dec 1 starting Oct 12", zone);
		expect([rule(r), r.title, day(r), end(r)]).toEqual(["daily", "Gym", "2026-10-12", "2026-12-01"]);
	});
});
