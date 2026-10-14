import { describe, expect, it } from "vitest";
import { parseQuickAdd } from "../../src/parsing";
import { NY, at, chipOf, makeCtx, ruleKey } from "./helpers";
import { check, dateOf, gridSample } from "./repeat-grammar-grid";

// #12: where a typed repeat phrase ends and what may follow it.
// A generated grid, titles × repeat forms × separators × followers, in two environments. The repeat chip's text is the
// form itself (plus an `at <time>` typed right after it), whatever follows: a date, a weekday, a time, a range, an end,
// title text, with or without a comma or a lead word between them is read by the date reader and the end logic. An
// `every …` is unsupported only when its own words form a repeat Quick Add cannot build: no form fits (`every 3 hours`),
// or a list word (`,`, `and`, `&`) joins more repeat words to a form (`every 2nd and 4th tuesday`, `every monday & 2
// others`). A bare repeat word counts only at the end, after title text; `last friday of the month` counts anywhere.

describe("the repeat grammar: where a typed repeat ends and what may follow it (#12)", () => {
	// A sample of the grid: every form once (the whole grid: `npm run test:parser-grid`).
	it.each(gridSample().map((c) => [`${c.input} (${c.env.name})`, c] as const))("#12: grid: %s", (_name, c) => {
		check(c.env, c.title, c.form, c.sep, c.follower);
	});

	it.each(["en", "en-GB"] as const)("#12: %s: a range of weekdays opening a list is every weekday from the first to the last", (locale) => {
		const ctx = makeCtx({ zone: NY, locale, now: at(NY, "2026-10-07T10:00") });
		const rows: [string, string, string][] = [
			["Gym every mon-fri", "Gym", "weekly:MO,TU,WE,TH,FR"],
			["Gym every monday to friday", "Gym", "weekly:MO,TU,WE,TH,FR"],
			["Gym every mon through fri", "Gym", "weekly:MO,TU,WE,TH,FR"],
			["Gym every Mon\u2013Fri", "Gym", "weekly:MO,TU,WE,TH,FR"],
			["Gym every tue-thu", "Gym", "weekly:TU,WE,TH"],
			["Shop every fri-mon", "Shop", "weekly:MO,FR,SA,SU"],
			["Gym every mon-fri at 7am", "Gym", "weekly:MO,TU,WE,TH,FR@07:00"],
			["Gym every week on mon-fri", "Gym", "weekly:MO,TU,WE,TH,FR"],
			["Gym every week mon-fri", "Gym", "weekly:MO,TU,WE,TH,FR"],
			["Gym every 2 weeks on tue-thu", "Gym", "weekly/2:TU,WE,TH"],
			["Gym every other mon-wed", "Gym", "weekly/2:MO,TU,WE"],
			["Gym weekly on mon-fri", "Gym", "weekly:MO,TU,WE,TH,FR"],
			["Gym weekly mon-fri", "Gym", "weekly:MO,TU,WE,TH,FR"],
			["Gym weekly tue-thu", "Gym", "weekly:TU,WE,TH"],
			["Shop weekly fri-mon", "Shop", "weekly:MO,FR,SA,SU"],
			["Gym weekly monday to friday", "Gym", "weekly:MO,TU,WE,TH,FR"],
			["Gym weekly mon through fri", "Gym", "weekly:MO,TU,WE,TH,FR"],
			["Gym every mon-wed, fri", "Gym", "weekly:MO,TU,WE,FR"],
		];
		for (const [input, title, key] of rows) {
			const r = parseQuickAdd(input, ctx);
			expect(r.title, input).toBe(title);
			expect(r.fields.recurrence === undefined ? undefined : ruleKey(r.fields.recurrence), input).toBe(key);
			expect(r.fields.scheduled, input).toBeUndefined();
			expect(r.chips.map((c) => c.kind), input).toEqual(["recurrence"]);
		}
		// A time after the bare word is the repeat's, as after every form (`Stretch daily at 7am`).
		for (const input of ["Gym weekly mon-fri at 7am", "Gym weekly on mon-fri at 7am"]) {
			const r = parseQuickAdd(input, ctx);
			expect(ruleKey(r.fields.recurrence!), input).toBe("weekly:MO,TU,WE,TH,FR@07:00");
			expect(r.chips.map((c) => `${c.kind}|${c.status}|${c.text}`), input).toEqual([`recurrence|applied|${input.slice("Gym ".length)}`]);
			expect(r.title, input).toBe("Gym");
		}
		// A range after a form that takes no list is not its days; `until` leads an end, not a range.
		const third = parseQuickAdd("Gym every third Mon-Fri", ctx);
		expect(third.chips.map((c) => `${c.kind}|${c.status}|${c.text}`)).toEqual(["recurrence|unsupported|every third", "scheduled|suggestion|Mon-Fri"]);
		const daily = parseQuickAdd("Gym every day Mon-Fri", ctx);
		expect(daily.chips.map((c) => `${c.kind}|${c.status}|${c.text}`)).toEqual(["recurrence|applied|every day", "scheduled|suggestion|Mon-Fri"]);
		expect(parseQuickAdd("Gym daily Mon-Fri", ctx).chips.map((c) => `${c.kind}|${c.status}|${c.text}`)).toEqual(["recurrence|applied|daily", "scheduled|suggestion|Mon-Fri"]);
		// A bare word counts only at the end, after title text: `Weekly Mon-Fri review` keeps its title, and
		// the weekdays of the dropped phrase are read on their own, the one suggestion a weekday range always is.
		const review = parseQuickAdd("Weekly Mon-Fri review", ctx);
		expect([review.title, review.chips.map((c) => `${c.kind}|${c.status}|${c.text}`)]).toEqual(["Weekly Mon-Fri review", ["scheduled|suggestion|Mon-Fri"]]);
		expect(review.fields.recurrence).toBeUndefined();
		// Dates as the locale reads them (en-GB takes `Nov 30` for a year, #69).
		const [nov30, dec1] = locale === "en" ? ["Nov 30", "Dec 1"] : ["30 Nov", "1 Dec"];
		const until = parseQuickAdd(`Gym every Monday until ${nov30}`, ctx);
		expect(until.chips.map((c) => `${c.kind}|${c.status}|${c.text}`)).toEqual(["recurrence|applied|every Monday", `repeatEnd|applied|until ${nov30}`]);
		const list = parseQuickAdd(`Gym every week on mon, fri until ${dec1}`, ctx);
		expect(list.chips.map((c) => `${c.kind}|${c.status}|${c.text}`)).toEqual(["recurrence|applied|every week on mon, fri", `repeatEnd|applied|until ${dec1}`]);
	});

	it("#12: a plain number after a list word is title text; more repeat words make a compound repeat", () => {
		const ctx = makeCtx({ zone: NY, now: at(NY, "2026-10-07T10:00") });
		for (const [input, title, key] of [
			// The comma stays in the title, as it does on every form today (#69 cleans stray punctuation).
			["Read every day, 20 pages", "Read 20 pages", "daily"],
			["Read every day and 20 pages", "Read and 20 pages", "daily"],
			["Call every monday & 2 clients", "Call & 2 clients", "weekly:MO"],
		] as const) {
			const r = parseQuickAdd(input, ctx);
			expect(r.title, input).toBe(title);
			expect(r.fields.recurrence === undefined ? undefined : ruleKey(r.fields.recurrence), input).toBe(key);
			expect(r.fields.scheduled, input).toBeUndefined();
		}
		const seven = parseQuickAdd("Gym every day at 7 and 9", ctx);
		expect(seven.chips.find((c) => c.kind === "recurrence")).toMatchObject({ status: "choice", text: "every day at 7" });
		expect(seven.fields.scheduled).toBeUndefined();
		for (const [input, text] of [
			["Gym every monday & 2 others", "every monday & 2 others"],
			["Gym every 2nd and 4th tuesday", "every 2nd and 4th tuesday"],
			["Pay every 15th and 30th", "every 15th and 30th"],
			["Gym every day, Monday", "every day, Monday"],
		] as const) {
			const r = parseQuickAdd(input, ctx);
			expect(r.chips.map((c) => `${c.kind}|${c.status}|${c.text}`), input).toEqual([`recurrence|unsupported|${text}`]);
			expect(r.title, input).toBe(input);
		}
	});

	it("#12: a date, a range or a lead word right after an unsupported `every …` is read: the phrase ends at its own words", () => {
		const ctx = makeCtx({ zone: NY, now: at(NY, "2026-10-07T10:00") });
		const rows: [string, string, string[]][] = [
			// Right after it, the date is the phrase's start as typed: offered, never applied (phrase table 5).
			["Call every 3 hours Oct 12", "every 3 hours", ["recurrence|unsupported|every 3 hours", "scheduled|suggestion|Oct 12"]],
			["Call every 3 hours Oct 12 to Dec 1", "every 3 hours", ["recurrence|unsupported|every 3 hours", "scheduled|suggestion|Oct 12 to Dec 1"]],
			["Call every 3 hours Mon-Fri", "every 3 hours", ["recurrence|unsupported|every 3 hours", "scheduled|suggestion|Mon-Fri"]],
			["Call every 3 hours until Dec 1", "every 3 hours", ["recurrence|unsupported|every 3 hours", "repeatEnd|unsupported|until Dec 1"]],
			["Taxes every May 5", "every May 5", ["recurrence|unsupported|every May 5"]],
			["Taxes every May 5 and Dec 25", "every May 5", ["recurrence|unsupported|every May 5", "scheduled|suggestion|Dec 25"]],
			["Gym every 2nd and 4th tuesday of every month", "every 2nd and 4th tuesday of every month", ["recurrence|unsupported|every 2nd and 4th tuesday of every month"]],
			["Gym every 2nd, 4th tuesday", "every 2nd, 4th tuesday", ["recurrence|unsupported|every 2nd, 4th tuesday"]],
		];
		for (const [input, text, chips] of rows) {
			const r = parseQuickAdd(input, ctx);
			expect(r.chips.map((c) => `${c.kind}|${c.status}|${c.text}`), input).toEqual(chips);
			expect(r.title, input).toContain(text);
		}
	});

	it("#12: a form keeps its words before a bare weekday, a day number or a unit that is not joined to it", () => {
		const ctx = makeCtx({ zone: NY, now: at(NY, "2026-10-07T10:00") });
		const rows: [string, string, string | undefined, string | undefined][] = [
			["Gym every 3 days monday", "Gym", "daily/3", "2026-10-12"],
			// Both the bare hour and a weekday said on that weekday are choices: nothing applies, the title keeps the text.
			["Gym every monday at 7 wednesday", "Gym every monday at 7 wednesday", undefined, undefined],
			["Gym every month 15th", "Gym 15th", "monthly", undefined],
			["Read every day 20 pages", "Read 20 pages", "daily", undefined],
			["Run every day first thing", "Run first thing", "daily", undefined],
			["Gym every month day 15", "Gym day 15", "monthly", undefined],
		];
		for (const [input, title, key, date] of rows) {
			const r = parseQuickAdd(input, ctx);
			expect(r.title, input).toBe(title);
			expect(r.fields.recurrence === undefined ? undefined : ruleKey(r.fields.recurrence), input).toBe(key);
			expect(dateOf(chipOf(r, "scheduled", "applied")), input).toBe(date);
		}
		// A bare hour in the repeat is a choice; the weekday after it is still a date (a choice too, said on a Wednesday).
		expect(parseQuickAdd("Gym every monday at 7 wednesday", ctx).chips.map((c) => `${c.kind}|${c.status}`)).toEqual(["recurrence|choice", "scheduled|choice"]);
	});
});
