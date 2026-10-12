import { expect } from "vitest";
import { addDays } from "../../src/domain/time";
import type { Weekday } from "../../src/domain/types";
import { parseQuickAdd } from "../../src/parsing";
import type { Chip, ParseResult } from "../../src/parsing/types";
import { NY, TOKYO, at, makeCtx, ruleKey } from "./helpers";

// The repeat grammar grid (#12), shared by the unit sample in `repeat-grammar.test.ts` and the on-demand run of the
// whole grid (`npm run test:parser-grid`, `scripts/parser-oracle.mjs`).

// Repeating tasks rule 19 and Tasks and Quick Add rule 40 (#12): where a typed repeat phrase ends and what may follow it.
// A generated grid, titles × repeat forms × separators × followers, in two environments. The repeat chip's text is the
// form itself (plus an `at <time>` typed right after it), whatever follows: a date, a weekday, a time, a range, an end,
// title text, with or without a comma or a lead word between them is read by the date reader and the end logic. An
// `every …` is unsupported only when its own words form a repeat Quick Add cannot build: no form fits (`every 3 hours`),
// or a list word (`,`, `and`, `&`) joins more repeat words to a form (`every 2nd and 4th tuesday`, `every monday & 2
// others`). A bare repeat word counts only at the end, after title text; `last friday of the month` counts anywhere.

export interface Form {
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
export const FORMS: Form[] = [
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
	// `weekly` takes a weekday list after it, as `every week` does (`weekly on mon, fri`, `weekly Monday`).
	{ text: "weekly", kind: "bare", key: "weekly", weekOn: true, days: [], interval: 1 },
	{ text: "monthly", kind: "bare", key: "monthly", monthOn: true },
	{ text: "yearly", kind: "bare", key: "yearly", yearOn: true },
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
	{ text: "weekly on mon-fri", kind: "bare", days: ["MO", "TU", "WE", "TH", "FR"], interval: 1 },
	{ text: "weekly mon-fri", kind: "bare", days: ["MO", "TU", "WE", "TH", "FR"], interval: 1 },
	{ text: "weekly fri-mon", kind: "bare", days: ["FR", "SA", "SU", "MO"], interval: 1 },
];

export const TITLES = ["Gym", "Pay the bank", "Plan the May party", "Review for the team", ""];
export const SEPARATORS = ["", ",", " on", " from", " starting", " and"] as const;
export type FollowerKind = "none" | "date" | "leap" | "weekday" | "time" | "range" | "weekdayRange" | "end" | "periods" | "count" | "text" | "number";
export interface Follower {
	text: string;
	kind: FollowerKind;
}

export interface Env {
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
export const ENVS: Env[] = [
	{ name: "New York en 2026-10-07", zone: NY, locale: "en", now: "2026-10-07T10:00", today: "2026-10-07", date: "Oct 12", leap: "Feb 29", range: "Oct 12 to Dec 1", rangeEnd: "to Dec 1" },
	{ name: "Tokyo en-GB 2028-02-29", zone: TOKYO, locale: "en-GB", now: "2028-02-29T21:00", today: "2028-02-29", date: "12 Oct", leap: "29 Feb", range: "12 Oct to 1 Dec", rangeEnd: "to 1 Dec" },
];

export const followers = (env: Env): Follower[] => [
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

export const inputOf = (title: string, form: string, sep: string, follower: string): string => `${title} ${form}${sep} ${follower}`.replace(/\s+/g, " ").trim();
export const dateOf = (c: Chip | undefined): string | undefined => (c?.date === undefined ? undefined : c.date.kind === "date" ? c.date.date : c.date.local.slice(0, 10));
export const chip = (r: ParseResult, kind: Chip["kind"], status?: Chip["status"]): Chip | undefined => r.chips.find((c) => c.kind === kind && (status === undefined || c.status === status));
const DATE_WORDS = /\b(?:Oct|Dec|Feb|until|for|with|Fri)\b/u;
const WEEK: Weekday[] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

/** The weekdays of a list form after `Monday` joined it (the rule keeps them in week order). */
const keyWith = (f: Form, day: Weekday | null): string => {
	if (f.days === undefined) return f.key!;
	const days = day !== null && !f.days.includes(day) ? [...f.days, day] : f.days;
	if (days.length === 0) return f.key!;
	return `weekly${f.interval === 1 ? "" : `/${f.interval}`}:${WEEK.filter((d) => days.includes(d)).join(",")}`;
};

export function check(env: Env, title: string, f: Form, sep: string, w: Follower): void {
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
	// A start word before the follower: after an `every …` Quick Add cannot build it applies nothing.
	const led = sep === " on" || sep === " from" || sep === " starting";
	// Under a weekly form `on` names days: a date after it is no start, only an offer.
	const onNoStart = (f.days !== undefined || f.key?.startsWith("weekly") === true) && sep === " on";

	// A day number before a weekday fits no form (`every 15th Monday`, like `every 5th friday`): not supported.
	if (f.text === "every 15th" && sep === "" && w.kind === "weekday") {
		expect(rec, because).toMatchObject({ status: "unsupported", text: "every 15th Monday" });
		expect(r.fields.recurrence, because).toBeUndefined();
		expect(chip(r, "scheduled"), because).toBeUndefined();
		return;
	}
	if (f.kind === "unsupported") {
		// An ordinal alone completed by a weekday (`every third Monday`) is a form, a month name by a day (`every May 12`):
		// no claim.
		if (sep === "" && (w.kind === "weekday" || (/May$/u.test(f.text) && /^\d/u.test(w.text)))) return;
		expect(rec?.status, because).toBe("unsupported");
		expect(rec!.text.startsWith(f.phrase ?? f.text), because).toBe(true);
		// The phrase never swallows a date, a range, an end or title words; a time is one more repeat word of a repeat that
		// fits no rule (`every other weekday at 7`, `every 3 hours, at 7`), so it stays with it and is never a date.
		expect(rec!.text.slice((f.phrase ?? f.text).length), because).not.toMatch(DATE_WORDS);
		// A time right after the phrase goes with it; elsewhere it is read on its own, a choice that is never applied.
		if (w.kind === "time" && sep === "") expect(chip(r, "scheduled"), because).toBeUndefined();
		if (w.kind === "time") expect(chip(r, "scheduled", "applied"), because).toBeUndefined();
		expect(r.fields.recurrence, because).toBeUndefined();
		expect(r.title, because).toContain(f.text);
		if ((w.kind === "date" || w.kind === "leap" || w.kind === "range") && !fromGB && led) expect(chip(r, "scheduled")?.status, because).toBe("unsupported");
		// A date right after the phrase (over a comma, `and` or `&` at most) is its start as typed: offered, never applied.
		else if ((w.kind === "date" || w.kind === "leap") && (sep === "" || sep === "," || sep === " and")) expect(chip(r, "scheduled")?.status, because).toBe("suggestion");
		else if ((w.kind === "date" || w.kind === "leap") && !fromGB) expect(chip(r, "scheduled", "applied")?.text.endsWith(w.text), because).toBe(true);
		if (w.kind === "end") expect(chip(r, "repeatEnd")?.status, because).toBe("unsupported");
		if ((w.kind === "periods" || w.kind === "count") && sep !== " and") expect(chip(r, "repeatEnd")?.status, because).toBe("unsupported");
		if (w.kind === "weekday" && led) expect(chip(r, "scheduled")?.status, because).toBe("unsupported");
		return;
	}

	// A bare word is a repeat only at the end of the text, after title text: a comma, chips and punctuation may follow it,
	// title words may not (`on` and `from` are title words unless the date reader takes them: no claim here).
	if (f.kind === "bare" && !f.anywhere) {
		if (sep === " on" || sep === " from") return;
		// A weekday list after the bare word takes "and Monday" too (`weekly mon-fri and Monday`).
		const after = (sep === "" || sep === "," || (sep === " and" && w.kind === "weekday" && f.days !== undefined && f.days.length > 0)) && w.kind !== "text" && w.kind !== "number";
		const led = sep === " starting" && ["date", "leap", "weekday", "time", "range", "weekdayRange"].includes(w.kind);
		const kept = title !== "" && (after || led);
		if (!kept) {
			expect(rec, because).toBeUndefined();
			expect(r.fields.recurrence, because).toBeUndefined();
			return;
		}
	}

	// A kept form: the chip is the form's text, plus a time typed right after it (an `every …` or a bare word alike), plus
	// a full weekday a list takes, plus "on <N>" after a month form and the "on" that leads a year form into its start date.
	const joinsTime = sep === "" && w.kind === "time" && !f.time && f.onDate !== true;
	const joinsDay = w.kind === "weekday" && f.days !== undefined && listJoin;
	// `every week Mon-Fri`, `every 2 weeks on Mon-Fri`: a range opens the week form's list (Q3); after a complete list
	// (`every monday Mon-Fri`) it stays a suggestion.
	const joinsRange = w.kind === "weekdayRange" && f.weekOn === true && (sep === "" || sep === " on");
	// `every month on 20 pages`: "on 20" is the day of the month, as `on 15` is; a bare number before a month name
	// (`every month on 12 Oct`) is the start date instead.
	const joinsMonthDay = f.monthOn === true && sep === " on" && /^\d/u.test(w.text) && !/^\d+ [A-Z]/u.test(w.text);
	const dayOn = joinsMonthDay ? w.text.split(" ")[0]! : "";
	const onDate = f.onDate === true || (f.yearOn === true && sep === " on" && ["date", "leap", "range", "number"].includes(w.kind));
	if (compound && !joinsDay && !joinsMonthDay) {
		expect(rec?.status, because).toBe("unsupported");
		expect(rec!.text, because).toBe(`${f.text}${sep} ${w.text.split(" ")[0]}`);
		expect(r.fields.recurrence, because).toBeUndefined();
		return;
	}
	const text = joinsTime ? `${f.text} ${w.text}` : joinsDay || joinsRange ? `${f.text}${sep} ${w.text}` : joinsMonthDay ? `${f.text} on ${dayOn}` : f.onDate === true ? "every year on" : onDate ? `${f.text} on` : f.text;
	if (f.kind === "bare" && !f.anywhere && (sep === " on" || sep === " from") && w.kind === "weekday") return;
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
		expect(ruleKey(r.fields.recurrence!), because).toBe(joinsRange ? `weekly${f.interval === undefined || f.interval === 1 ? "" : `/${f.interval}`}:MO,TU,WE,TH,FR` : joinsDay ? keyWith(f, "MO") : joinsMonthDay ? `${f.key}:d${Number(dayOn)}` : f.days !== undefined ? keyWith(f, null) : f.key);
	}
	if (joinsMonthDay) return;
	const waits = rec!.status === "choice";
	const endStatuses = waits ? ["suggestion"] : ["applied", "invalid"];

	// The follower is read by the date reader and the end logic, never by the repeat.
	switch (w.kind) {
		case "date":
		case "leap":
		case "weekday":
			if (onNoStart && !joinsDay) {
				expect(chip(r, "scheduled", "applied"), because).toBeUndefined();
				expect(chip(r, "scheduled", "suggestion")?.text, because).toBe(`on ${w.text}`);
			} else if (w.kind === "weekday") {
				if (!joinsDay) expect(chip(r, "scheduled", "applied")?.text.endsWith("Monday"), because).toBe(true);
			} else if (!fromGB) expect(dateOf(chip(r, "scheduled", "applied"))?.slice(5), because).toBe(w.kind === "date" ? "10-12" : "02-29");
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

/** One grid case: an environment, a title, a form, a separator and a follower. */
export interface GridCase {
	env: Env;
	title: string;
	form: Form;
	sep: string;
	follower: Follower;
	input: string;
}

/** Every case of the grid: environments × forms × titles × separators × followers. */
export function* gridCases(): Generator<GridCase> {
	for (const env of ENVS) for (const form of FORMS) for (const title of TITLES) for (const sep of SEPARATORS) for (const follower of followers(env)) {
		yield { env, title, form, sep, follower, input: inputOf(title, form.text, sep, follower.text) };
	}
}

/**
 * The unit suite's sample of the grid: every form once, the environments, titles, separators and followers taken in
 * turn so each of them appears too. The whole grid runs on demand: `npm run test:parser-grid`.
 */
export function gridSample(): GridCase[] {
	return FORMS.map((form, i) => {
		const env = ENVS[i % ENVS.length]!;
		const title = TITLES[i % TITLES.length]!;
		const sep = SEPARATORS[i % SEPARATORS.length]!;
		const follower = followers(env)[(i * 5) % 12]!;
		return { env, title, form, sep, follower, input: inputOf(title, form.text, sep, follower.text) };
	});
}
