import { describe, expect, it } from "vitest";
import { normalizeRepeatRule, repeatRuleProblem } from "../../src/domain/recurrence";
import { parseQuickAdd } from "../../src/parsing";
import type { SpanDecision } from "../../src/parsing/types";
import { NY, TOKYO, BERLIN, at, chipLines, makeCtx } from "./helpers";

// One block per parser requirement.

const parse = (input: string, opts: Parameters<typeof makeCtx>[0] = {}) => parseQuickAdd(input, makeCtx(opts));

describe("A1 pipeline order", () => {
	it("masks for <duration> so chrono does not read it as now + 45 minutes", () => {
		const r = parse("Study tomorrow at 7pm for 45m");
		expect(r.fields.scheduled).toEqual({ kind: "datetime", local: "2026-10-02T19:00", tz: NY });
		expect(r.fields.plannedDurationMin).toBe(45);
	});

	it("masks every ... so chrono does not read the weekday", () => {
		const r = parse("Gym every monday");
		expect(r.fields.scheduled).toBeUndefined();
		expect(r.chips.map((c) => c.kind)).toEqual(["recurrence"]);
	});

	it("masks tokens so chrono cannot merge across them", () => {
		const r = parse("tomorrow #Study at 7pm");
		const dates = r.chips.filter((c) => c.kind === "scheduled");
		expect(dates.map((c) => c.text)).toEqual(["tomorrow", "at 7pm"]);
		expect(r.chips.find((c) => c.kind === "category")?.text).toBe("#Study");
	});

	it("does not let chrono read inside a note link", () => {
		const r = parse("Read [[Meeting tomorrow at 5pm]]");
		expect(r.fields.scheduled).toBeUndefined();
		expect(chipLines(r)).toEqual(["missing|note|[[Meeting tomorrow at 5pm]]|n=No note named Meeting tomorrow at 5pm"]);
	});

	it("does not let chrono read inside a category token", () => {
		const r = parse("Read #friday");
		expect(r.fields.scheduled).toBeUndefined();
		expect(r.chips.map((c) => c.kind)).toEqual(["category"]);
	});

	it("a by directly before a chrono span makes it a deadline and the chip starts at by", () => {
		const input = "Report by Friday";
		const r = parse(input);
		expect(r.chips).toHaveLength(1);
		expect(r.chips[0]?.kind).toBe("deadline");
		expect(r.chips[0]?.span).toEqual({ start: input.indexOf("by"), end: input.length });
		expect(r.fields.scheduled).toBeUndefined();
	});

	it("by inside a word is not a deadline marker", () => {
		const r = parse("Standby Friday");
		expect(r.chips.map((c) => c.kind)).toEqual(["scheduled"]);
	});

	it("without by the span is scheduled", () => {
		expect(parse("Report Friday").chips[0]?.kind).toBe("scheduled");
	});

	it("by next to a token is not a deadline marker across the token", () => {
		const r = parse("Report by #Study Friday");
		expect(r.chips.map((c) => `${c.kind}:${c.text}`)).toEqual(["category:#Study", "scheduled:Friday"]);
	});
});

describe("A2 instants from components in the zone", () => {
	it("keeps the wall time across a DST change between the reference date and the target date", () => {
		// Reference in July (EDT), target in December (EST): a fixed offset would shift the hour.
		const r = parse("Meet Dec 1 at 9am", { now: at(NY, "2026-07-10T12:00") });
		expect(r.fields.scheduled).toEqual({ kind: "datetime", local: "2026-12-01T09:00", tz: NY });
	});

	it("keeps the wall time in the opposite direction (EST to EDT)", () => {
		const r = parse("Meet Jul 20 at 9am", { now: at(NY, "2026-01-10T12:00") });
		expect(r.fields.scheduled).toEqual({ kind: "datetime", local: "2026-07-20T09:00", tz: NY });
	});

	it("uses the zone date when it differs from the UTC date", () => {
		const now = new Date("2026-10-01T20:00:00Z");
		expect(now.getUTCDate()).toBe(1);
		const r = parse("Meet today", { zone: TOKYO, now });
		expect(r.fields.scheduled).toEqual({ kind: "date", date: "2026-10-02" });
	});

	it("uses the zone date when the UTC date is ahead of it", () => {
		const now = new Date("2026-10-02T02:00:00Z"); // Oct 1 22:00 in New York
		const r = parse("Meet today", { zone: NY, now });
		expect(r.fields.scheduled).toEqual({ kind: "date", date: "2026-10-01" });
		expect(parse("Meet tomorrow", { zone: NY, now }).fields.scheduled).toEqual({ kind: "date", date: "2026-10-02" });
	});

	it("datetimes carry the configured zone", () => {
		const r = parse("Meet tomorrow at 7pm", { zone: BERLIN, now: at(BERLIN, "2026-10-01T12:00") });
		expect(r.fields.scheduled).toEqual({ kind: "datetime", local: "2026-10-02T19:00", tz: BERLIN });
	});

	it("date-only results stay dates", () => {
		expect(parse("Meet tomorrow").fields.scheduled).toEqual({ kind: "date", date: "2026-10-02" });
	});

	it("ignores an invalid reference instant instead of throwing", () => {
		expect(() => parse("Meet tomorrow", { now: new Date(Number.NaN) })).not.toThrow();
	});
});

describe("A3 meridiem ambiguity", () => {
	it("gives a choice with both alternatives and applies neither", () => {
		const r = parse("Run at 5");
		const chip = r.chips[0];
		expect(chip?.status).toBe("choice");
		expect(chip?.alternatives).toEqual([
			{ label: "05:00", value: { kind: "datetime", local: "2026-10-02T05:00", tz: NY } },
			{ label: "17:00", value: { kind: "datetime", local: "2026-10-01T17:00", tz: NY } },
		]);
		expect(r.fields.scheduled).toBeUndefined();
		expect(r.title).toBe("Run at 5");
	});

	it("a certain meridiem is not ambiguous", () => {
		for (const t of ["at 5pm", "at 5am", "at 17:00", "at noon", "at midnight", "at 7:30pm"]) {
			expect(parse(`Run ${t}`).chips[0]?.status, t).toBe("applied");
		}
	});

	it("hour 0 and hours above 12 are not ambiguous", () => {
		expect(parse("Run at 0:30").chips[0]?.status).toBe("applied");
		expect(parse("Run at 13").chips[0]?.status).toBe("applied");
	});

	it("L1: a leading-zero hour (0H:MM) is certain 24-hour and applies", () => {
		for (const t of ["at 02:30", "at 09:00", "at 01:15", "09:00"]) {
			const r = parse(`Run ${t}`);
			expect(r.chips[0]?.status, t).toBe("applied");
			expect(r.fields.scheduled?.kind, t).toBe("datetime");
		}
		const r = parse("Run tomorrow at 09:05");
		expect(r.fields.scheduled).toEqual({ kind: "datetime", local: "2026-10-02T09:05", tz: NY });
	});

	it("L1: hours without a leading zero stay a choice (10:00, 11:30, 5:30, at 5)", () => {
		for (const t of ["at 10:00", "at 11:30", "at 5:30", "at 5", "at 12:00"]) {
			expect(parse(`Run ${t}`).chips[0]?.status, t).toBe("choice");
		}
	});

	it("L1: hour 12 without a meridiem lists noon first", () => {
		const alts = parse("Run tomorrow at 12").chips[0]?.alternatives?.map((a) => a.label);
		expect(alts).toEqual(["12:00", "00:00"]);
	});

	it("keeps the day of the date for both alternatives", () => {
		const alts = parse("Run tomorrow at 5").chips[0]?.alternatives?.map((a) => (a.value?.kind === "datetime" ? a.value.local : ""));
		expect(alts).toEqual(["2026-10-02T05:00", "2026-10-02T17:00"]);
	});
});

describe("A4 low confidence", () => {
	it("a stop-list token is a suggestion with a value, not applied", () => {
		for (const t of ["sun", "sat", "march", "now"]) {
			const r = parse(`x ${t}`);
			expect(r.chips[0]?.status, t).toBe("suggestion");
			expect(r.chips[0]?.date, t).toBeDefined();
			expect(r.chips[0]?.notice, t).toBe("Use as date?");
			expect(r.fields.scheduled, t).toBeUndefined();
			expect(r.title, t).toBe(`x ${t}`);
		}
	});

	it("may is a suggestion only where chrono reads it as a month (a bare may is not a date)", () => {
		expect(parse("Pay may").chips).toEqual([]);
		const r = parse("Pay in may");
		expect(r.chips.map((c) => `${c.status}:${c.text}`)).toEqual(["suggestion:may"]);
		expect(r.fields.scheduled).toBeUndefined();
	});

	it("stop-list matching ignores case, and a longer weekday name is not on the list", () => {
		expect(parse("x SUN").chips[0]?.status).toBe("suggestion");
		expect(parse("x Sunday").chips[0]?.status).toBe("applied");
		expect(parse("x Saturday").chips[0]?.status).toBe("applied");
	});

	it("a result without a certain day is a suggestion", () => {
		expect(parse("x next month").chips[0]?.status).toBe("suggestion");
		expect(parse("x next year").chips[0]?.status).toBe("suggestion");
	});

	it("a weekday applies (its weekday component is certain)", () => {
		const r = parse("Gym friday");
		expect(r.chips[0]?.status).toBe("applied");
		expect(r.fields.scheduled).toEqual({ kind: "date", date: "2026-10-02" });
	});

	it("a time without a day applies as a datetime (measured: chrono implies the day)", () => {
		const r = parse("Call at 7pm");
		expect(r.fields.scheduled).toEqual({ kind: "datetime", local: "2026-10-01T19:00", tz: NY });
	});

	it("a bare duration word is not applied as a time", () => {
		expect(parse("Gym 1h").chips[0]?.status).toBe("suggestion");
		expect(parse("Gym 45m").chips[0]?.status).toBe("suggestion");
	});

	it("a range is not applied", () => {
		expect(parse("Trip Oct 5 - Oct 9").chips[0]?.status).toBe("suggestion");
	});

	it("a suggestion on a deadline keeps the by in the span", () => {
		const r = parse("Finish by sat");
		expect(r.chips[0]).toMatchObject({ kind: "deadline", status: "suggestion", text: "by sat" });
		expect(r.fields.deadline).toBeUndefined();
		expect(r.title).toBe("Finish by sat");
	});

	it("an accept decision applies the suggestion", () => {
		const d: SpanDecision = { span: { start: 0, end: 3 }, text: "Sun", kind: "accept" };
		const r = parse("Sun cream", { decisions: [d] });
		expect(r.fields.scheduled).toEqual({ kind: "date", date: "2026-10-04" });
		expect(r.title).toBe("cream");
	});
});

describe("A5 a weekday said on that weekday", () => {
	it("gives Today and Next week alternatives and applies neither", () => {
		const r = parse("Meet friday", { zone: TOKYO, now: at(TOKYO, "2026-10-02T05:00") });
		const chip = r.chips[0];
		expect(chip?.status).toBe("choice");
		expect(chip?.alternatives).toEqual([
			{ label: "Today", value: { kind: "date", date: "2026-10-02" } },
			{ label: "Next week", value: { kind: "date", date: "2026-10-09" } },
		]);
		expect(r.fields.scheduled).toBeUndefined();
	});

	it("a deadline gets the same choice", () => {
		const r = parse("Report by friday", { zone: TOKYO, now: at(TOKYO, "2026-10-02T05:00") });
		expect(r.chips[0]).toMatchObject({ kind: "deadline", status: "choice" });
	});

	it("a different weekday is applied directly", () => {
		expect(parse("Meet saturday", { zone: TOKYO, now: at(TOKYO, "2026-10-02T05:00") }).fields.scheduled).toEqual({
			kind: "date",
			date: "2026-10-03",
		});
	});

	it("next friday on a Friday is next week without a choice", () => {
		const r = parse("Meet next friday", { zone: TOKYO, now: at(TOKYO, "2026-10-02T05:00") });
		expect(r.fields.scheduled).toEqual({ kind: "date", date: "2026-10-09" });
	});

	it("choosing an alternative applies it through a date decision", () => {
		const input = "Meet friday";
		const d: SpanDecision = { span: { start: 5, end: 11 }, text: "friday", kind: "date", value: { kind: "date", date: "2026-10-02" } };
		const r = parse(input, { zone: TOKYO, now: at(TOKYO, "2026-10-02T05:00"), decisions: [d] });
		expect(r.fields.scheduled).toEqual({ kind: "date", date: "2026-10-02" });
		expect(r.title).toBe("Meet");
	});
});

describe("A6 one value per field", () => {
	it("the later of two scheduled spans wins and the earlier is superseded", () => {
		const r = parse("a Oct 5 b Oct 6");
		expect(r.fields.scheduled).toEqual({ kind: "date", date: "2026-10-06" });
		expect(r.chips.map((c) => c.status)).toEqual(["superseded", "applied"]);
		expect(r.chips[0]?.notice).toBe("Replaced by a later value");
		expect(r.title).toBe("a Oct 5 b");
	});

	it("scheduled and deadline are separate fields", () => {
		const r = parse("x tomorrow by Oct 9");
		expect(r.chips.map((c) => c.status)).toEqual(["applied", "applied"]);
	});

	it("tags are a set and all apply", () => {
		const r = parse("x @home @learning @fresh");
		expect(r.fields.tagKeys).toEqual(["home", "learning"]);
		expect(r.fields.newTags).toEqual(["fresh"]); // typed name (lowercase here)
		expect(r.chips.every((c) => c.status === "applied")).toBe(true);
	});

	it("a suggestion does not supersede an applied value", () => {
		const r = parse("x Oct 5 sun");
		expect(r.fields.scheduled).toEqual({ kind: "date", date: "2026-10-05" });
		expect(r.chips.map((c) => c.status)).toEqual(["applied", "suggestion"]);
	});
});

describe("A7 DST", () => {
	it("moves a spring-forward gap time forward with dst-gap", () => {
		const r = parse("x Mar 8 2:30am", { now: at(NY, "2026-03-01T12:00") });
		expect(r.fields.scheduled).toEqual({ kind: "datetime", local: "2026-03-08T03:30", tz: NY });
		expect(r.chips[0]?.warning).toBe("dst-gap");
	});

	it("keeps a repeated fall-back time and warns", () => {
		const r = parse("x Nov 1 1:30am", { now: at(NY, "2026-10-25T12:00") });
		expect(r.fields.scheduled).toEqual({ kind: "datetime", local: "2026-11-01T01:30", tz: NY });
		expect(r.chips[0]?.warning).toBe("dst-ambiguous");
	});

	it("applies the same rules to a chosen meridiem alternative", () => {
		const d: SpanDecision = {
			span: { start: 2, end: 15 },
			text: "Mar 8 at 2:30",
			kind: "date",
			value: { kind: "datetime", local: "2026-03-08T02:30", tz: NY },
		};
		const r = parse("x Mar 8 at 2:30", { now: at(NY, "2026-03-01T12:00"), decisions: [d] });
		expect(r.fields.scheduled).toEqual({ kind: "datetime", local: "2026-03-08T03:30", tz: NY });
		expect(r.chips[0]).toMatchObject({ status: "applied", warning: "dst-gap" });
	});

	it("a time with no warning carries none", () => {
		expect(parse("x Mar 8 at 3:30am", { now: at(NY, "2026-03-01T12:00") }).chips[0]?.warning).toBeUndefined();
	});
});

describe("A8 durations", () => {
	const dur = (s: string) => parse(`x for ${s}`).fields.plannedDurationMin;
	it.each([
		["45m", 45],
		["1h", 60],
		["1h30m", 90],
		["90 min", 90],
		["1.5 hours", 90],
		["2 hr", 120],
		["3 mins", 3],
		["1 minute", 1],
		["10 minutes", 10],
		["1,5 hours", undefined],
	])("for %s", (s, min) => {
		expect(dur(s)).toBe(min);
	});

	it("rounds a fractional minute count", () => {
		expect(dur("0.5h")).toBe(30);
		expect(dur("1.25 hours")).toBe(75);
	});

	it("rejects 0 and above 1440 minutes with an invalid chip that stays literal", () => {
		for (const s of ["0m", "1441 min", "25h", "99999999999999999999 min"]) {
			const r = parse(`x for ${s}`);
			expect(r.chips[0]?.status, s).toBe("invalid");
			expect(r.chips[0]?.notice, s).toBe("Duration must be 1 to 1440 minutes");
			expect(r.fields.plannedDurationMin, s).toBeUndefined();
			expect(r.title, s).toBe(`x for ${s}`);
		}
	});

	it("an invalid duration is still masked from chrono", () => {
		const r = parse("x for 2000 min");
		expect(r.chips.map((c) => c.kind)).toEqual(["duration"]);
		expect(r.fields.scheduled).toBeUndefined();
	});

	it("requires the word for and a word boundary before it", () => {
		expect(parse("x 45m").chips.some((c) => c.kind === "duration")).toBe(false);
		expect(parse("transfor 45m").chips.some((c) => c.kind === "duration")).toBe(false);
		expect(parse("éfor 45m").chips.some((c) => c.kind === "duration")).toBe(false);
		expect(parse("x for 45mx").chips.some((c) => c.kind === "duration")).toBe(false);
	});

	it("keeps a following word out of the duration span", () => {
		const r = parse("x for 45m please");
		expect(r.chips[0]?.text).toBe("for 45m");
		expect(r.title).toBe("x please");
	});
});

describe("A9 resolution", () => {
	it("a collision lists the candidate paths and stays in the title", () => {
		const r = parse("x [[Plan]]");
		expect(r.chips[0]).toMatchObject({ status: "collision", candidates: ["Projects/Plan.md", "Archive/Plan.md"], notice: "2 matches" });
		expect(r.fields.notePath).toBeUndefined();
		expect(r.title).toBe("x [[Plan]]");
	});

	it("an unresolved category blocks saving", () => {
		const r = parse("x #Nope");
		expect(r.blocking).toEqual([r.chips[0]?.id]);
		expect(r.chips[0]?.status).toBe("unresolved");
	});

	it("only unresolved categories block", () => {
		expect(parse("x [[Nope]] [[Plan]] @new for 5000m").blocking).toEqual([]);
	});

	it("a new tag chip carries newTag and the normalized key", () => {
		const r = parse("x @Fresh/Idea");
		expect(r.chips[0]).toMatchObject({ status: "applied", newTag: true, tagKey: "fresh/idea" });
		expect(r.fields.newTags).toEqual(["Fresh/Idea"]); // as typed
	});

	it("newTags carries the typed names, deduped by key with the first casing winning (TAG-03)", () => {
		const r = parse("x @NewTag @newtag @Other/Sub");
		expect(r.fields.newTags).toEqual(["NewTag", "Other/Sub"]);
		expect(r.chips.map((c) => c.tagKey)).toEqual(["newtag", "newtag", "other/sub"]);
	});

	it("an existing tag resolves to the stored key without newTag", () => {
		const r = parse("x @LEARNING");
		expect(r.chips[0]?.tagKey).toBe("learning");
		expect(r.chips[0]?.newTag).toBeUndefined();
	});

	it("a note link uses the part before | and #", () => {
		expect(parse("x [[Big|alias]]").fields.notePath).toBe("Notes/Big note.md");
		expect(parse("x [[Big#Heading]]").fields.notePath).toBe("Notes/Big note.md");
		expect(parse("x [[Big#^block|alias]]").fields.notePath).toBe("Notes/Big note.md");
	});

	it("a throwing note resolver is treated as no match", () => {
		const ctx = { ...makeCtx(), resolveNote: () => { throw new Error("boom"); } };
		expect(parseQuickAdd("x [[Big]]", ctx).chips[0]?.status).toBe("missing");
	});

	it("tokens need a start or whitespace before the trigger", () => {
		expect(parse("a@b.com").chips).toEqual([]);
		expect(parse("a#Study").chips).toEqual([]);
		expect(parse("(@home)").chips).toEqual([]);
	});

	it("a token of digits only is plain text unless a category or tag of that name exists", () => {
		expect(parse("Fix bug #42").chips).toEqual([]);
		expect(parse("Meet @5").chips).toEqual([]);
		const ctx = {
			...makeCtx(),
			categories: [{ id: "cat-year-0009", name: "2026" }],
			tags: [{ key: "42", displayName: "42" }],
		};
		const r = parseQuickAdd("Plan #2026 @42", ctx);
		expect(r.fields.categoryId).toBe("cat-year-0009");
		expect(r.fields.tagKeys).toEqual(["42"]);
	});

	it("a bound category decision whose category no longer exists is ignored", () => {
		const d: SpanDecision = { span: { start: 2, end: 6 }, text: "#Foo", kind: "category", categoryId: "cat-gone" };
		const r = parse("x #Foo", { decisions: [d] });
		expect(r.chips[0]?.status).toBe("unresolved");
	});
});

describe("A10 recurrence", () => {
	it("a form Quick Add builds becomes a rule and leaves the title (REC-07, D8)", () => {
		const r = parse("Gym every monday");
		expect(r.chips[0]).toMatchObject({ kind: "recurrence", status: "applied", rule: { freq: "weekly", interval: 1, weekdays: ["MO"], monthly: null, afterCompletion: false, time: null, tz: null } });
		expect(r.title).toBe("Gym");
		expect(r.fields.recurrence).toBe(r.chips[0]?.rule);
	});

	it("a form it does not build stays in the title as unsupported, with no rule", () => {
		const r = parse("Gym every 3 hours");
		expect(r.chips[0]).toMatchObject({ kind: "recurrence", status: "unsupported", notice: "Recurrence not supported yet" });
		expect(r.chips[0]?.rule).toBeUndefined();
		expect(r.title).toBe("Gym every 3 hours");
		expect(Object.keys(r.fields).sort()).toEqual(["newTags", "tagKeys"]);
	});

	it("an `at` time takes the parse zone; an ambiguous hour is a two-way choice until one is picked", () => {
		expect(parse("Gym every day at 7pm", { zone: BERLIN, now: at(BERLIN, "2026-10-01T12:00") }).fields.recurrence).toMatchObject({ time: "19:00", tz: BERLIN });
		const ambiguous = parse("Gym every day at 7");
		expect(ambiguous.chips[0]).toMatchObject({ status: "choice", alternatives: [{ label: "07:00", rule: { time: "07:00" } }, { label: "19:00", rule: { time: "19:00" } }] });
		expect(ambiguous.chips[0]?.rule).toBeUndefined();
		expect(ambiguous.fields.recurrence).toBeUndefined();
		expect(ambiguous.title).toBe("Gym every day at 7");
	});

	it("choosing a reading applies exactly that rule; a rule that was not offered changes nothing", () => {
		const input = "Gym every day at 7";
		const chip = parse(input).chips[0]!;
		const evening = chip.alternatives![1]!.rule!;
		const chosen = parse(input, { decisions: [{ span: chip.span, text: chip.text, kind: "rule", rule: evening }] });
		expect(chosen.chips[0]).toMatchObject({ status: "applied", rule: { time: "19:00" } });
		expect(chosen.chips[0]?.alternatives).toBeUndefined();
		expect(chosen.fields.recurrence).toMatchObject({ time: "19:00" });
		expect(chosen.title).toBe("Gym");
		const stray = parse(input, { decisions: [{ span: chip.span, text: chip.text, kind: "rule", rule: { ...evening, time: "03:00" } }] });
		expect(stray.chips[0]?.status).toBe("choice");
		expect(stray.fields.recurrence).toBeUndefined();
	});

	it("a bare hour in a repeat asks like a date does, and explicit forms never ask", () => {
		const kinds = (text: string): string | undefined => parse(text).chips.find((c) => c.kind === "recurrence")?.status;
		for (const asking of ["every monday at 9", "every day at 9:30", "every week at 12", "every day at 1", "every day at 9:30 "]) expect(kinds(`Gym ${asking}`), asking).toBe("choice");
		for (const explicit of ["at 9am", "at 9pm", "at 9:30pm", "at 21:00", "at 09:00", "at 13", "at 0", "at noon", "at midnight", "at 12am", "at 12pm"]) {
			expect(kinds(`Gym every monday ${explicit}`), explicit).toBe("applied");
		}
	});

	it("each applied rule is storable: it passes the engine's own validation and normal form", () => {
		for (const text of ["every day", "every weekday", "every mon, fri", "every other week", "every 3 months on the 31st", "every last friday", "every last day of the month"]) {
			const rule = parse(`x ${text} at 9pm`).fields.recurrence;
			expect(rule, text).toBeDefined();
			expect(repeatRuleProblem(rule!), text).toBeNull();
			expect(normalizeRepeatRule(rule!), text).toEqual(rule);
		}
	});

	it("does not mask the weekday of a different phrase", () => {
		expect(parse("Gym on monday every now").fields.scheduled).toEqual({ kind: "date", date: "2026-10-05" });
	});
});

describe("A13 title", () => {
	it("removes applied spans and collapses whitespace", () => {
		expect(parse("  a   tomorrow   b  ").title).toBe("a b");
	});

	it("falls back to the input and flags it when nothing is left", () => {
		const r = parse("tomorrow");
		expect(r.title).toBe("tomorrow");
		expect(r.titleFallback).toBe(true);
	});

	it("does not flag a fallback for a title that was never emptied", () => {
		expect(parse("").titleFallback).toBe(false);
		expect(parse("   ").titleFallback).toBe(false);
		expect(parse("a tomorrow").titleFallback).toBe(false);
	});

	it("leaves unapplied spans in the title", () => {
		expect(parse("x #Nope sun [[Plan]] every 3 hours").title).toBe("x #Nope sun [[Plan]] every 3 hours");
	});
});

describe("A14 robustness", () => {
	it("returns a plain-title result when the context is unusable", () => {
		const ctx = { ...makeCtx(), zone: "Not/AZone" };
		const r = parseQuickAdd("Buy milk tomorrow", ctx);
		expect(r.title).toBe("Buy milk tomorrow");
		expect(r.chips).toEqual([]);
		expect(r.fields).toEqual({ tagKeys: [], newTags: [] });
	});

	it("parses a 5,000 character input in reasonable time", () => {
		const unit = "Buy milk tomorrow at 7pm #Study @home [[Big]] for 45m every monday by Friday ";
		const input = unit.repeat(Math.ceil(5000 / unit.length)).slice(0, 5000);
		const started = performance.now();
		const r = parse(input);
		expect(performance.now() - started).toBeLessThan(2000);
		expect(r.chips.length).toBeGreaterThan(10);
	});

	it("parses a long run of one character in reasonable time", () => {
		for (const ch of ["#", "@", "[", "a", " ", "1", "e"]) {
			const started = performance.now();
			parse(ch.repeat(5000));
			expect(performance.now() - started, ch).toBeLessThan(2000);
		}
	});

	it("parses long repeat lists and runs of lead words in reasonable time (#12)", () => {
		const long = (unit: string): string => unit.repeat(Math.ceil(5000 / unit.length)).slice(0, 5000);
		for (const input of [
			"every " + "mon ".repeat(2000),
			"until ".repeat(800),
			"every 1 ".repeat(800),
			"Gym " + "daily ".repeat(800),
			"every " + "sun ".repeat(2000),
			"every mon " + "sat ".repeat(2000) + "cream",
			"Gym every other " + "mon ".repeat(2000) + "x",
			// The repeat grammar on 5,000 characters: forms with dates, ranges and ends after them, a compound chain, and
			// a list word before a date on every form.
			long("Gym every mon, wed and fri, Oct 12 to Dec 1 until Dec 1 for 2 weeks "),
			long("every 2nd and 4th tuesday and "),
			long("Pay every day, 12 Oct every month on the 15th Mon-Fri "),
			long("every May 5 to May 10 "),
		]) {
			const started = performance.now();
			parse(input);
			expect(performance.now() - started, input.slice(0, 12)).toBeLessThan(2000);
		}
	});

	it("parses long pathological runs of for and every in reasonable time", () => {
		const started = performance.now();
		parse("for 1h ".repeat(700) + "every mon, ".repeat(400));
		expect(performance.now() - started).toBeLessThan(2000);
	});
});

describe("chip ids", () => {
	it("are kind:start:end", () => {
		const r = parse("a tomorrow #Study");
		expect(r.chips.map((c) => c.id)).toEqual(["scheduled:2:10", "category:11:17"]);
	});
});
