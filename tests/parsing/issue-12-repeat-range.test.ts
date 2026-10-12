import { describe, expect, it } from "vitest";
import { parseQuickAdd } from "../../src/parsing";
import type { DateLocale, ParseResult, SpanDecision } from "../../src/parsing/types";
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
	// A start with its own year in the past: the end counts from the start, not from today.
	["Gym every day starting Sep 28 2026 to Oct 3", "en", "daily", "Gym", "2026-09-28", "2026-10-03", "starting Sep 28 2026", "to Oct 3"],
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

// Two bare weekdays joined as a range under a repeat name the days of the week, not a start and an end: they stay the
// one visible suggestion they always were, unless `starting` or `beginning` leads them. [input, title, the chips]
const WEEKDAY_PAIRS: ReadonlyArray<readonly [string, string, readonly string[]]> = [
	["Standup weekly Mon-Fri", "Standup Mon-Fri", ["recurrence applied weekly", "scheduled suggestion Mon-Fri"]],
	["Standup every week from Monday to Friday", "Standup from Monday to Friday", ["recurrence applied every week", "scheduled suggestion Monday to Friday"]],
	["Run every week from Mon to Fri at 7am", "Run from Mon to Fri at 7am", ["recurrence applied every week", "scheduled suggestion Mon to Fri at 7am"]],
	["Gym daily Mon-Fri", "Gym Mon-Fri", ["recurrence applied daily", "scheduled suggestion Mon-Fri"]],
	["Gym daily Mon to Fri", "Gym Mon to Fri", ["recurrence applied daily", "scheduled suggestion Mon to Fri"]],
	["Shop every weekday from Monday to Friday", "Shop from Monday to Friday", ["recurrence applied every weekday", "scheduled suggestion Monday to Friday"]],
	// The first weekday of the range is not one more repeat word: the repeat keeps its form (Tasks and Quick Add rule 40).
	["Gym every day Mon-Fri", "Gym Mon-Fri", ["recurrence applied every day", "scheduled suggestion Mon-Fri"]],
	["Gym every day Mon\u2013Fri", "Gym Mon\u2013Fri", ["recurrence applied every day", "scheduled suggestion Mon\u2013Fri"]],
	["Gym every day Monday to Friday", "Gym Monday to Friday", ["recurrence applied every day", "scheduled suggestion Monday to Friday"]],
	["Gym every day mon until fri", "Gym mon until fri", ["recurrence applied every day", "scheduled suggestion mon until fri"]],
	["Gym every month Mon-Fri", "Gym Mon-Fri", ["recurrence applied every month", "scheduled suggestion Mon-Fri"]],
	["Gym every weekday Mon-Fri", "Gym Mon-Fri", ["recurrence applied every weekday", "scheduled suggestion Mon-Fri"]],
	["Gym every week mon-fri", "Gym mon-fri", ["recurrence applied every week", "scheduled suggestion mon-fri"]],
	["Gym every week on mon-fri", "Gym on mon-fri", ["recurrence applied every week", "scheduled suggestion on mon-fri"]],
	["Gym every week Mon through Fri", "Gym Mon through Fri", ["recurrence applied every week", "scheduled suggestion Mon through Fri"]],
	["Gym every monday Mon-Fri", "Gym Mon-Fri", ["recurrence applied every monday", "scheduled suggestion Mon-Fri"]],
];

const decide = (r: ParseResult, kind: "scheduled" | "repeatEnd", choose: (c: ParseResult["chips"][number]) => SpanDecision): SpanDecision => choose(r.chips.find((c) => c.kind === kind)!);

describe.each(ZONES)("range sides under a repeat in %s", (zone) => {
	describe.each(["en", "en-GB"] as const)("%s", (locale) => {
		it.each(WEEKDAY_PAIRS)("%s stays one suggestion", (input, title, chips) => {
			const r = parse(input, zone, locale);
			expect(r.title).toBe(title);
			expect(r.chips.map((c) => `${c.kind} ${c.status} ${c.text}`)).toEqual(chips);
			expect(r.fields.scheduled).toBeUndefined();
			expect(r.fields.recurrenceEnd).toBeUndefined();
			expect(r.blocking).toEqual([]);
		});
	});

	it("a repeat's time that is a choice keeps its form before two weekdays", () => {
		const r = parse("Gym every day at 7 Mon-Fri", zone);
		expect(r.chips.map((c) => `${c.kind} ${c.status} ${c.text}`)).toEqual(["recurrence choice every day at 7", "scheduled suggestion Mon-Fri"]);
		expect([r.fields.scheduled, r.blocking]).toEqual([undefined, []]);
	});

	it("a date range after a comma is not more repeat words: the repeat keeps its form", () => {
		for (const [input, start, until] of [
			["Pills every day, Oct 12 to Dec 1", "Oct 12", "to Dec 1"],
			["Pills every day, 12 Oct - 1 Dec", "12 Oct", "- 1 Dec"],
		] as const) {
			const r = parse(input, zone);
			expect([rule(r), day(r), end(r), r.blocking], input).toEqual(["daily", "2026-10-12", "2026-12-01", []]);
			expect(r.chips.map((c) => `${c.kind} ${c.status} ${c.text}`), input).toEqual(["recurrence applied every day", `scheduled applied ${start}`, `repeatEnd applied ${until}`]);
		}
	});

	it("a start with its own year whose hour is a choice: the end counts from that date, not today", () => {
		for (const [input, until] of [
			["Gym every day starting Sep 28 2026 at 5 to Oct 3", "2026-10-03"],
			["Gym every day starting 2026-10-01 at 5 until Oct 5", "2026-10-05"],
			["Gym every day starting Oct 1 2026 at 12 until Oct 5", "2026-10-05"],
		] as const) {
			const r = parse(input, zone);
			expect(r.chips.find((c) => c.kind === "scheduled")?.status, input).toBe("choice");
			expect(r.chips.find((c) => c.kind === "repeatEnd"), input).toMatchObject({ status: "applied", end: { kind: "date", date: until } });
			expect([end(r), r.blocking], input).toEqual([until, []]);
		}
	});

	it("two weekdays led by starting are still the start and the end", () => {
		const r = parse("Standup every day starting Monday until Friday", zone);
		expect([rule(r), r.title, day(r), end(r), r.blocking]).toEqual(["daily", "Standup", "2026-10-12", "2026-10-16", []]);
	});

	it("an end with a past word keeps its reading: a suggestion before the start, invalid once used", () => {
		const input = "Gym every day starting Monday until last friday";
		const r = parse(input, zone);
		expect(day(r)).toBe("2026-10-12");
		expect(r.chips.find((c) => c.kind === "repeatEnd")).toMatchObject({ status: "suggestion", text: "until last friday", end: { kind: "date", date: "2026-10-02" } });
		expect(r.fields.recurrenceEnd).toBeUndefined();
		expect(r.blocking).toEqual([]);
		const accepted = parseQuickAdd(input, makeCtx({ zone, now: at(zone, "2026-10-07T10:00"), decisions: [decide(r, "repeatEnd", (c) => ({ span: c.span, text: c.text, kind: "accept" }))] }));
		const chip = accepted.chips.find((c) => c.kind === "repeatEnd");
		expect(chip).toMatchObject({ status: "invalid", notice: "The repeat ends before its first date." });
		expect(accepted.blocking).toEqual([chip!.id]);
	});

	it.each([
		["Gym every day starting Oct 20 until this friday", "until this friday"],
		["Gym every day starting Oct 20 until tomorrow", "until tomorrow"],
	])("%s: an end that names its own day before the start is invalid", (input, text) => {
		const r = parse(input, zone);
		expect(day(r)).toBe("2026-10-20");
		const chip = r.chips.find((c) => c.kind === "repeatEnd");
		expect(chip).toMatchObject({ status: "invalid", text, notice: "The repeat ends before its first date." });
		expect(r.blocking).toEqual([chip!.id]);
		expect(r.fields.recurrenceEnd).toBeUndefined();
	});

	it("a Feb 29 end after a start with its own year is the next Feb 29 on or after the start", () => {
		const r = parse("Gym every day starting Oct 12 2028 to Feb 29", zone);
		expect([day(r), end(r), r.blocking]).toEqual(["2028-10-12", "2032-02-29", []]);
	});

	it("the end follows the chosen start: Next week ends on the Friday after it", () => {
		const input = "Gym every day starting Wednesday until Friday";
		const r = parse(input, zone);
		const choose = (label: string) => (c: ParseResult["chips"][number]): SpanDecision => ({ span: c.span, text: c.text, kind: "date", value: c.alternatives!.find((a) => a.label === label)!.value! });
		const reread = (label: string): ParseResult =>
			parseQuickAdd(input, makeCtx({ zone, now: at(zone, "2026-10-07T10:00"), decisions: [decide(r, "scheduled", choose(label))] }));
		const next = reread("Next week");
		expect([day(next), end(next), next.blocking, next.title]).toEqual(["2026-10-14", "2026-10-16", [], "Gym"]);
		const today = reread("Today");
		expect([day(today), end(today), today.blocking, today.title]).toEqual(["2026-10-07", "2026-10-09", [], "Gym"]);
	});

	it("a month and day end that fits the first choice keeps its reading for Next week: invalid, it blocks saving", () => {
		const input = "Gym every day starting Wednesday until Oct 10";
		const r = parse(input, zone);
		expect(end(r)).toBe("2026-10-10");
		const choose = (c: ParseResult["chips"][number]): SpanDecision => ({ span: c.span, text: c.text, kind: "date", value: c.alternatives!.find((a) => a.label === "Next week")!.value! });
		const next = parseQuickAdd(input, makeCtx({ zone, now: at(zone, "2026-10-07T10:00"), decisions: [decide(r, "scheduled", choose)] }));
		expect(day(next)).toBe("2026-10-14");
		const chip = next.chips.find((c) => c.kind === "repeatEnd");
		expect(chip).toMatchObject({ status: "invalid", text: "until Oct 10", notice: "The repeat ends before its first date." });
		expect(next.blocking).toEqual([chip!.id]);
		expect(next.fields.recurrenceEnd).toBeUndefined();
	});
});

describe("parse time of ranges under a repeat", () => {
	it("reads ten ranges with a far-off start in 1,000 characters in reasonable time", () => {
		const unit = "starting Oct 12 9999 until Friday and bring water and towels and snacks for the whole group please ";
		const input = ("Gym every day " + unit.repeat(10)).slice(0, 1000);
		const ctx = makeCtx({ zone: NY, now: at(NY, "2026-10-07T10:00") });
		const started = performance.now();
		const r = parseQuickAdd(input, ctx);
		expect(performance.now() - started).toBeLessThan(2000);
		expect(r.chips.length).toBeGreaterThan(10);
	});
});

// A month and day without a year, said on that very day: today (#88), whatever the hour. Tuesday 2028-02-29 21:00 in
// Tokyo, late enough that chrono's own forward step would have moved it to the next leap day on any host clock.
// [input, locale, the scheduled value]
const LEAP_DAYS: ReadonlyArray<readonly [string, DateLocale, string | undefined]> = [
	["Feb 29 party", "en", "2028-02-29"],
	["Feb 29 9am party", "en", "2028-02-29T09:00"],
	["29 Feb party", "en", "2028-02-29"],
	["02/29 party", "en", "2028-02-29"],
	["29/02 party", "en", "2028-02-29"],
	["the 29th of February party", "en", "2028-02-29"],
	["29 Feb party", "en-GB", "2028-02-29"],
	["02/29 party", "en-GB", "2028-02-29"],
	["29/02 party", "en-GB", "2028-02-29"],
	["the 29th of February party", "en-GB", "2028-02-29"],
];

// Known defects (#69), not the intended reading: in en-GB, a month name before a leap day reads no date or the day
// after it. Pinned at what the parser gives today, without a repeat, so a change shows up here; a fix of #69 updates
// these rows to that day (2028-02-29), as the en rows read. [input, the scheduled value]
const LEAP_DAY_DEFECTS: ReadonlyArray<readonly [string, string | undefined]> = [
	["Feb 29 party", undefined],
	["Feb 29 9am party", "2028-03-01T09:00"],
];

describe("a leap day without a year or a repeat", () => {
	it.each(LEAP_DAYS)("%s (%s) is that day", (input, locale, expected) => {
		const r = parseQuickAdd(input, makeCtx({ zone: TOKYO, now: at(TOKYO, "2028-02-29T21:00"), locale }));
		expect(day(r)).toBe(expected);
	});

	it.each(LEAP_DAY_DEFECTS)("known defect (#69): %s (en-GB) reads as before, not that day", (input, current) => {
		const r = parseQuickAdd(input, makeCtx({ zone: TOKYO, now: at(TOKYO, "2028-02-29T21:00"), locale: "en-GB" }));
		expect(day(r)).toBe(current);
	});
});
