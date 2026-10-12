import { describe, expect, it } from "vitest";
import { addDays } from "../../src/domain/time";
import type { Weekday } from "../../src/domain/types";
import { parseQuickAdd } from "../../src/parsing";
import type { Chip, ParseResult } from "../../src/parsing/types";
import { NY, TOKYO, at, makeCtx, ruleKey } from "./helpers";

// Repeating tasks rule 19 and Tasks and Quick Add rule 40 (#12): where a typed repeat phrase ends and what may follow it.
// A generated grid, titles × repeat forms × separators × followers, in two environments. The repeat chip's text is the
// form itself (plus an `at <time>` typed right after it), whatever follows: a date, a weekday, a time, a range, an end,
// title text, with or without a comma or a lead word between them is read by the date reader and the end logic. An
// `every …` is unsupported only when its own words form a repeat Quick Add cannot build: no form fits (`every 3 hours`),
// or a list word (`,`, `and`, `&`) joins more repeat words to a form (`every 2nd and 4th tuesday`, `every monday & 2
// others`). A bare repeat word counts only at the end, after title text; `last friday of the month` counts anywhere.

interface Form {
	text: string;
	kind: "supported" | "bare" | "unsupported";
	/** The rule of a kept form, as `ruleKey` spells it; `days`: the weekday list a bare full weekday right after it joins. */
	key?: string;
	days?: Weekday[];
	interval?: number;
	/** `every (N|other) week(s)`: a weekday right after it, or after "on", names the days (`every 2 weeks on tuesday`). */
	weekOn?: boolean;
	/** `every (N) month(s)`: "on <N>" right after it is the day of the month (`every month on 15`). */
	monthOn?: boolean;
	/** `every (N) year(s)`: "on" before a date right after it leads into the start (decision 15). */
	yearOn?: boolean;
	/** The form has its own time; `choice`: a bare hour, so the chip is a two-way choice. */
	time?: boolean;
	choice?: boolean;
	/** `every year on`: the date right after it is the start (decision 15). */
	onDate?: boolean;
	/** Counts anywhere, not only at the end (`last friday of the month`). */
	anywhere?: boolean;
	/** An unsupported phrase whose chip stops before its last words (`others` is not a repeat word). */
	phrase?: string;
}

const list = (text: string, days: Weekday[], interval = 1): Form => ({ text, kind: "supported", days, interval });
const FORMS: Form[] = [
	{ text: "every day", kind: "supported", key: "daily" },
	{ text: "every weekday", kind: "supported", key: "weekly:MO,TU,WE,TH,FR" },
	{ text: "every weekend", kind: "supported", key: "weekly:SA,SU" },
	{ text: "every week", kind: "supported", key: "weekly", weekOn: true, days: [], interval: 1 },
	{ text: "every month", kind: "supported", key: "monthly", monthOn: true },
	{ text: "every year", kind: "supported", key: "yearly", yearOn: true },
	{ text: "every 3 days", kind: "supported", key: "daily/3" },
	{ text: "every 2 weeks", kind: "supported", key: "weekly/2", weekOn: true, days: [], interval: 2 },
	{ text: "every 6 months", kind: "supported", key: "monthly/6", monthOn: true },
	{ text: "every 2 years", kind: "supported", key: "yearly/2", yearOn: true },
	{ text: "every other day", kind: "supported", key: "daily/2" },
	{ text: "every other week", kind: "supported", key: "weekly/2", weekOn: true, days: [], interval: 2 },
	list("every other friday", ["FR"], 2),
	list("every monday", ["MO"]),
	list("every mon wed fri", ["MO", "WE", "FR"]),
	list("every mon, wed and fri", ["MO", "WE", "FR"]),
	list("every tuesday & thursday", ["TU", "TH"]),
	list("every week on mon, fri", ["MO", "FR"]),
	list("every 2 weeks on tuesday", ["TU"], 2),
	list("every 2 weeks tuesday", ["TU"], 2),
	{ text: "every 15th", kind: "supported", key: "monthly:d15" },
	{ text: "every 1st of the month", kind: "supported", key: "monthly:d1" },
	{ text: "every month on the 15th", kind: "supported", key: "monthly:d15" },
	{ text: "every 3 months on day 5", kind: "supported", key: "monthly/3:d5" },
	{ text: "every first monday", kind: "supported", key: "monthly:MO#1" },
	{ text: "every last friday of the month", kind: "supported", key: "monthly:FR#-1" },
	{ text: "every last day of the month", kind: "supported", key: "monthly:last" },
	{ text: "every year on May 5", kind: "supported", key: "yearly", onDate: true },
	{ text: "every morning", kind: "supported", key: "daily" },
	{ text: "every night", kind: "supported", key: "daily" },
	{ text: "every monday at 9am", kind: "supported", key: "weekly:MO@09:00", time: true },
	{ text: "every day at 7", kind: "supported", key: "daily@07:00", time: true, choice: true },
	{ text: "daily", kind: "bare", key: "daily" },
	{ text: "weekly", kind: "bare", key: "weekly" },
	{ text: "monthly", kind: "bare", key: "monthly" },
	{ text: "yearly", kind: "bare", key: "yearly" },
	{ text: "mondays", kind: "bare", key: "weekly:MO" },
	{ text: "weekdays", kind: "bare", key: "weekly:MO,TU,WE,TH,FR" },
	{ text: "last friday of the month", kind: "bare", key: "monthly:FR#-1", anywhere: true },
	{ text: "every 3 hours", kind: "unsupported" },
	{ text: "every 30 minutes", kind: "unsupported" },
	{ text: "every 2nd and 4th tuesday", kind: "unsupported" },
	{ text: "every monday & 2 others", kind: "unsupported" },
	{ text: "every May", kind: "unsupported" },
	{ text: "every May 5", kind: "unsupported" },
	{ text: "every third", kind: "unsupported" },
	{ text: "every 2nd day", kind: "unsupported" },
	{ text: "every other weekday", kind: "unsupported" },
	{ text: "every 0 days", kind: "unsupported" },
	{ text: "every month on the 32nd", kind: "unsupported" },
	list("every mon-fri", ["MO", "TU", "WE", "TH", "FR"]),
	list("every tue-thu", ["TU", "WE", "TH"]),
	list("every fri-mon", ["FR", "SA", "SU", "MO"]),
	list("every week on mon-fri", ["MO", "TU", "WE", "TH", "FR"]),
	{ text: "weekly on mon-fri", kind: "bare", key: "weekly:MO,TU,WE,TH,FR" },
];

const TITLES = ["Gym", "Pay the bank", "Plan the May party", "Review for the team", ""];
const SEPARATORS = ["", ",", " on", " from", " starting", " and"] as const;
type FollowerKind = "none" | "date" | "leap" | "weekday" | "time" | "range" | "weekdayRange" | "end" | "periods" | "count" | "text" | "number";
interface Follower {
	text: string;
	kind: FollowerKind;
}

interface Env {
	name: string;
	zone: string;
	locale: "en" | "en-GB";
	now: string;
	today: string;
	/** The follower dates, spelt as the locale reads them (en-GB reads `Oct 12` as a year, #69). */
	date: string;
	leap: string;
	range: string;
	rangeEnd: string;
}

// Wednesday 2026-10-07 in New York, en; Tuesday 2028-02-29 in Tokyo, en-GB.
const ENVS: Env[] = [
	{ name: "New York en 2026-10-07", zone: NY, locale: "en", now: "2026-10-07T10:00", today: "2026-10-07", date: "Oct 12", leap: "Feb 29", range: "Oct 12 to Dec 1", rangeEnd: "to Dec 1" },
	{ name: "Tokyo en-GB 2028-02-29", zone: TOKYO, locale: "en-GB", now: "2028-02-29T21:00", today: "2028-02-29", date: "12 Oct", leap: "29 Feb", range: "12 Oct to 1 Dec", rangeEnd: "to 1 Dec" },
];

const followers = (env: Env): Follower[] => [
	{ text: "", kind: "none" },
	{ text: env.date, kind: "date" },
	{ text: env.leap, kind: "leap" },
	{ text: "Monday", kind: "weekday" },
	{ text: "at 7", kind: "time" },
	{ text: env.range, kind: "range" },
	{ text: "Mon-Fri", kind: "weekdayRange" },
	{ text: "until Dec 1", kind: "end" },
	{ text: "for 2 weeks", kind: "periods" },
	{ text: "for 5 times", kind: "count" },
	{ text: "with Ann", kind: "text" },
	{ text: "20 pages", kind: "number" },
];

const inputOf = (title: string, form: string, sep: string, follower: string): string => `${title} ${form}${sep} ${follower}`.replace(/\s+/g, " ").trim();
const dateOf = (c: Chip | undefined): string | undefined => (c?.date === undefined ? undefined : c.date.kind === "date" ? c.date.date : c.date.local.slice(0, 10));
const chip = (r: ParseResult, kind: Chip["kind"], status?: Chip["status"]): Chip | undefined => r.chips.find((c) => c.kind === kind && (status === undefined || c.status === status));
const DATE_WORDS = /\b(?:Oct|Dec|Feb|until|for|with|Fri)\b/u;
const WEEK: Weekday[] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

/** The weekdays of a list form after `Monday` joined it (the rule keeps them in week order). */
const keyWith = (f: Form, day: Weekday | null): string => {
	if (f.days === undefined) return f.key!;
	const days = day !== null && !f.days.includes(day) ? [...f.days, day] : f.days;
	if (days.length === 0) return f.key!;
	return `weekly${f.interval === 1 ? "" : `/${f.interval}`}:${WEEK.filter((d) => days.includes(d)).join(",")}`;
};

function check(env: Env, title: string, f: Form, sep: string, w: Follower): void {
	const input = inputOf(title, f.text, sep, w.text);
	const r = parseQuickAdd(input, makeCtx({ zone: env.zone, locale: env.locale, now: at(env.zone, env.now) }));
	const rec = chip(r, "recurrence");
	const because = `${JSON.stringify(input)} in ${env.name}: ${r.chips.map((c) => `${c.kind}|${c.status}|${c.text}`).join(" ; ")}`;
	// `from 12 Oct`: the date reader takes "from 12" as a time (a pre-existing en-GB reading, not the repeat's).
	const fromGB = sep === " from" && env.locale === "en-GB";
	// A weekday list takes a weekday after a list word or a plain space; `every (N) week(s)` after a space or "on".
	const listJoin = f.weekOn === true ? sep === "" || sep === " on" : sep === "" || sep === "," || sep === " and";
	// `,`, `and` and `&` join more repeat words to an `every …` form: a compound repeat (a bare weekday right after them;
	// a plain number is title text). A bare word (`daily`) has no list words.
	const compound = f.kind === "supported" && f.onDate !== true && (sep === "," || sep === " and") && w.kind === "weekday";

	if (f.kind === "unsupported") {
		// An ordinal alone completed by a weekday (`every third Monday`) is a form, a month name by a day (`every May 12`):
		// no claim.
		if (sep === "" && (w.kind === "weekday" || (/May$/u.test(f.text) && /^\d/u.test(w.text)))) return;
		expect(rec?.status, because).toBe("unsupported");
		expect(rec!.text.startsWith(f.phrase ?? f.text), because).toBe(true);
		// The phrase never swallows a date, a range, an end or title words (a time typed right after a form that fits no
		// rule, `every other weekday at 7`, stays with it).
		expect(rec!.text.slice((f.phrase ?? f.text).length), because).not.toMatch(DATE_WORDS);
		if (w.kind === "time" && sep !== "") expect(chip(r, "scheduled", "choice"), because).toBeDefined();
		expect(r.fields.recurrence, because).toBeUndefined();
		expect(r.title, because).toContain(f.text);
		if ((w.kind === "date" || w.kind === "leap") && !fromGB) expect(chip(r, "scheduled", "applied")?.text.endsWith(w.text), because).toBe(true);
		if (w.kind === "end") expect(chip(r, "repeatEnd")?.status, because).toBe("unsupported");
		if ((w.kind === "periods" || w.kind === "count") && sep !== " and") expect(chip(r, "repeatEnd")?.status, because).toBe("unsupported");
		if (w.kind === "weekday" && (sep === " on" || sep === " from" || sep === " starting")) expect(chip(r, "scheduled", "applied"), because).toBeDefined();
		return;
	}

	// A bare word is a repeat only at the end of the text, after title text: a comma, chips and punctuation may follow it,
	// title words may not (`on` and `from` are title words unless the date reader takes them: no claim here).
	if (f.kind === "bare" && !f.anywhere) {
		if (sep === " on" || sep === " from") return;
		const after = (sep === "" || sep === ",") && w.kind !== "text" && w.kind !== "number";
		const led = sep === " starting" && ["date", "leap", "weekday", "time", "range", "weekdayRange"].includes(w.kind);
		const kept = title !== "" && (after || led);
		if (!kept) {
			expect(rec, because).toBeUndefined();
			expect(r.fields.recurrence, because).toBeUndefined();
			return;
		}
	}

	// A kept form: the chip is the form's text, plus a time typed right after it, plus a full weekday a list takes,
	// plus "on <N>" after a month form and the "on" that leads a year form into its start date.
	const joinsTime = sep === "" && w.kind === "time" && f.kind === "supported" && !f.time && f.onDate !== true;
	const joinsDay = w.kind === "weekday" && f.days !== undefined && listJoin;
	// `every week Mon-Fri`, `every 2 weeks on Mon-Fri`: a range opens the week form's list (Q3); after a complete list
	// (`every monday Mon-Fri`) it stays a suggestion.
	const joinsRange = w.kind === "weekdayRange" && f.weekOn === true && (sep === "" || sep === " on");
	// `every month on 12 Oct`: "on 12" is the day of the month, as `on 15` is (the month name is left to the date reader).
	const joinsMonthDay = f.monthOn === true && sep === " on" && /^\d/u.test(w.text);
	const dayOn = joinsMonthDay ? w.text.split(" ")[0]! : "";
	const onDate = f.onDate === true || (f.yearOn === true && sep === " on" && ["date", "leap", "range", "number"].includes(w.kind));
	if (compound && !joinsDay && !joinsMonthDay) {
		expect(rec?.status, because).toBe("unsupported");
		expect(rec!.text, because).toBe(`${f.text}${sep} ${w.text.split(" ")[0]}`);
		expect(r.fields.recurrence, because).toBeUndefined();
		return;
	}
	const text = joinsTime ? `${f.text} ${w.text}` : joinsDay || joinsRange ? `${f.text}${sep} ${w.text}` : joinsMonthDay ? `${f.text} on ${dayOn}` : f.onDate === true ? "every year on" : onDate ? `${f.text} on` : f.text;
	expect(rec?.text, because).toBe(text);
	const later = ["date", "leap", "weekday", "range"].includes(w.kind) || (w.kind === "weekdayRange" && sep === " starting");
	if (f.onDate === true && later) {
		// Another applied date after `every year on <date>` supersedes the start: the repeat is not supported (decision
		// 15); a range that stays a suggestion leaves the start alone.
		expect(["unsupported", "applied"], because).toContain(rec!.status);
		return;
	} else if (onDate && w.kind === "number" && f.onDate !== true) {
		// `every year on 20 pages`: no date is read after "on", so the repeat is not supported (decision 15).
		expect(rec!.status, because).toBe("unsupported");
		return;
	} else if (f.choice === true || joinsTime) {
		expect(rec!.status, because).toBe("choice");
		expect(r.fields.recurrence, because).toBeUndefined();
	} else {
		expect(rec!.status, because).toBe("applied");
		expect(ruleKey(r.fields.recurrence!), because).toBe(joinsRange ? `weekly${f.interval === 1 ? "" : `/${f.interval}`}:MO,TU,WE,TH,FR` : joinsDay ? keyWith(f, "MO") : joinsMonthDay ? `${f.key}:d${Number(dayOn)}` : f.days !== undefined ? keyWith(f, null) : f.key);
	}
	if (joinsMonthDay) return;
	const waits = rec!.status === "choice";
	const endStatuses = waits ? ["suggestion"] : ["applied", "invalid"];

	// The follower is read by the date reader and the end logic, never by the repeat.
	switch (w.kind) {
		case "date":
			if (!fromGB) expect(dateOf(chip(r, "scheduled", "applied"))?.slice(5), because).toBe("10-12");
			break;
		case "leap":
			if (!fromGB) expect(dateOf(chip(r, "scheduled", "applied"))?.slice(5), because).toBe("02-29");
			break;
		case "weekday":
			if (!joinsDay) expect(chip(r, "scheduled", "applied")?.text.endsWith("Monday"), because).toBe(true);
			break;
		case "time":
			if (!joinsTime) expect(chip(r, "scheduled", "choice"), because).toBeDefined();
			break;
		case "range": {
			if (f.onDate === true || fromGB) break;
			// After "on", chrono's own text decides whether the range sits right after the repeat (en-GB keeps "on 12 Oct").
			const split = chip(r, "repeatEnd") !== undefined;
			if ((sep === " on" && !split) || sep === " and") {
				expect(chip(r, "scheduled", "suggestion")?.text.endsWith(env.range), because).toBe(true);
				expect(chip(r, "repeatEnd"), because).toBeUndefined();
			} else {
				expect(dateOf(chip(r, "scheduled", "applied"))?.slice(5), because).toBe("10-12");
				const end = chip(r, "repeatEnd");
				expect(end?.text, because).toBe(env.rangeEnd);
				expect(endStatuses, because).toContain(end!.status);
				if (end!.status === "applied") expect(end!.end, because).toEqual({ kind: "date", date: `${env.today.slice(0, 4)}-12-01` });
			}
			break;
		}
		case "weekdayRange":
			if (joinsRange) break;
			if (sep === " starting") {
				expect(chip(r, "scheduled", "applied")?.text, because).toBe("starting Mon");
				expect(endStatuses, because).toContain(chip(r, "repeatEnd")?.status);
			} else {
				expect(chip(r, "scheduled", "suggestion")?.text.endsWith("Mon-Fri"), because).toBe(true);
				expect(chip(r, "repeatEnd"), because).toBeUndefined();
			}
			break;
		case "end": {
			const end = chip(r, "repeatEnd");
			expect(end?.text, because).toBe("until Dec 1");
			expect(endStatuses, because).toContain(end!.status);
			// Merged by the date reader into a range with a start that has its own year, the end counts from that start.
			expect(end!.end?.kind === "date" && end!.end.date.endsWith("-12-01"), because).toBe(true);
			break;
		}
		case "periods": {
			const end = chip(r, "repeatEnd");
			expect(end?.text.endsWith("for 2 weeks"), because).toBe(true);
			expect(endStatuses, because).toContain(end!.status);
			// N periods from the start: the applied typed date, else today.
			const anchor = dateOf(chip(r, "scheduled", "applied")) ?? env.today;
			expect(end!.end, because).toEqual({ kind: "date", date: addDays(anchor, 13) });
			break;
		}
		case "count": {
			const end = chip(r, "repeatEnd");
			expect(end?.text.endsWith("for 5 times"), because).toBe(true);
			expect(endStatuses, because).toContain(end!.status);
			expect(end!.end, because).toEqual({ kind: "count", count: 5 });
			break;
		}
		case "text":
			expect(r.title, because).toContain(w.text);
			break;
		case "number":
			// "from 20" is a time and "May 5 20" a dated year to the date reader (pre-existing readings, not the repeat's);
			// `every month on 20` is a day of the month.
			if (sep !== " from" && !joinsMonthDay && f.onDate !== true) expect(r.title, because).toContain(w.text);
			break;
		case "none":
			break;
	}
}

describe("the repeat grammar: where a typed repeat ends and what may follow it (#12)", () => {
	for (const env of ENVS) {
		describe(env.name, () => {
			it.each(FORMS.map((f) => [f.text, f] as const))("%s", (_text, f) => {
				for (const title of TITLES) for (const sep of SEPARATORS) for (const w of followers(env)) check(env, title, f, sep, w);
			});
		});
	}

	it.each(["en", "en-GB"] as const)("%s: a range of weekdays opening a list is every weekday from the first to the last", (locale) => {
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
			["Gym every mon-wed, fri", "Gym", "weekly:MO,TU,WE,FR"],
		];
		for (const [input, title, key] of rows) {
			const r = parseQuickAdd(input, ctx);
			expect(r.title, input).toBe(title);
			expect(r.fields.recurrence === undefined ? undefined : ruleKey(r.fields.recurrence), input).toBe(key);
			expect(r.fields.scheduled, input).toBeUndefined();
			expect(r.chips.map((c) => c.kind), input).toEqual(["recurrence"]);
		}
		// A range after a form that takes no list is not its days; `until` leads an end, not a range.
		const third = parseQuickAdd("Gym every third Mon-Fri", ctx);
		expect(third.chips.map((c) => `${c.kind}|${c.status}|${c.text}`)).toEqual(["recurrence|unsupported|every third", "scheduled|suggestion|Mon-Fri"]);
		const daily = parseQuickAdd("Gym every day Mon-Fri", ctx);
		expect(daily.chips.map((c) => `${c.kind}|${c.status}|${c.text}`)).toEqual(["recurrence|applied|every day", "scheduled|suggestion|Mon-Fri"]);
		// Dates as the locale reads them (en-GB takes `Nov 30` for a year, #69).
		const [nov30, dec1] = locale === "en" ? ["Nov 30", "Dec 1"] : ["30 Nov", "1 Dec"];
		const until = parseQuickAdd(`Gym every Monday until ${nov30}`, ctx);
		expect(until.chips.map((c) => `${c.kind}|${c.status}|${c.text}`)).toEqual(["recurrence|applied|every Monday", `repeatEnd|applied|until ${nov30}`]);
		const list = parseQuickAdd(`Gym every week on mon, fri until ${dec1}`, ctx);
		expect(list.chips.map((c) => `${c.kind}|${c.status}|${c.text}`)).toEqual(["recurrence|applied|every week on mon, fri", `repeatEnd|applied|until ${dec1}`]);
	});

	it("a plain number after a list word is title text; more repeat words make a compound repeat", () => {
		const ctx = makeCtx({ zone: NY, now: at(NY, "2026-10-07T10:00") });
		for (const [input, title, key] of [
			// The comma stays in the title, as it does on every form today (#69 cleans stray punctuation).
			["Read every day, 20 pages", "Read , 20 pages", "daily"],
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

	it("a date, a range or a lead word right after an unsupported `every …` is read: the phrase ends at its own words", () => {
		const ctx = makeCtx({ zone: NY, now: at(NY, "2026-10-07T10:00") });
		const rows: [string, string, string[]][] = [
			["Call every 3 hours Oct 12", "every 3 hours", ["recurrence|unsupported|every 3 hours", "scheduled|applied|Oct 12"]],
			["Call every 3 hours Oct 12 to Dec 1", "every 3 hours", ["recurrence|unsupported|every 3 hours", "scheduled|applied|Oct 12", "repeatEnd|unsupported|to Dec 1"]],
			["Call every 3 hours Mon-Fri", "every 3 hours", ["recurrence|unsupported|every 3 hours", "scheduled|suggestion|Mon-Fri"]],
			["Call every 3 hours until Dec 1", "every 3 hours", ["recurrence|unsupported|every 3 hours", "repeatEnd|unsupported|until Dec 1"]],
			["Taxes every May 5", "every May 5", ["recurrence|unsupported|every May 5"]],
			["Taxes every May 5 and Dec 25", "every May 5", ["recurrence|unsupported|every May 5", "scheduled|applied|Dec 25"]],
			["Gym every 2nd and 4th tuesday of every month", "every 2nd and 4th tuesday of every month", ["recurrence|unsupported|every 2nd and 4th tuesday of every month"]],
			["Gym every 2nd, 4th tuesday", "every 2nd, 4th tuesday", ["recurrence|unsupported|every 2nd, 4th tuesday"]],
		];
		for (const [input, text, chips] of rows) {
			const r = parseQuickAdd(input, ctx);
			expect(r.chips.map((c) => `${c.kind}|${c.status}|${c.text}`), input).toEqual(chips);
			expect(r.title, input).toContain(text);
		}
	});

	it("a form keeps its words before a bare weekday, a day number or a unit that is not joined to it", () => {
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
			expect(dateOf(chip(r, "scheduled", "applied")), input).toBe(date);
		}
		// A bare hour in the repeat is a choice; the weekday after it is still a date (a choice too, said on a Wednesday).
		expect(parseQuickAdd("Gym every monday at 7 wednesday", ctx).chips.map((c) => `${c.kind}|${c.status}`)).toEqual(["recurrence|choice", "scheduled|choice"]);
	});
});
