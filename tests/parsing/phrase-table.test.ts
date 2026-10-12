import { describe, expect, it } from "vitest";
import { parseQuickAdd } from "../../src/parsing";
import type { DateLocale, ParseResult } from "../../src/parsing/types";
import { BERLIN, NY, TOKYO, at, chipLines, makeCtx, ruleKey } from "./helpers";

// Repeating tasks rule 19 and Tasks and Quick Add rules 24, 25, 37 and 40 (#12): the closed table of repeat phrases
// Quick Add reads. Every row of the table is a case here, in New York, Berlin and Tokyo, in en and en-GB where a date
// is spelt. A phrase outside the table is never applied: it stays title text, or, as an `every …`, shows "Recurrence
// not supported yet". Wednesday 2026-10-07 10:00 in each zone unless a case says otherwise.

const ZONES = [NY, BERLIN, TOKYO] as const;
const LOCALES = ["en", "en-GB"] as const;
const NOTICE = "Recurrence not supported yet";
const WEEKDAYS = "weekly:MO,TU,WE,TH,FR";

function parse(input: string, zone: string, locale: DateLocale = "en", local = "2026-10-07T10:00", manual: ("scheduled" | "recurrence")[] = []): ParseResult {
	return parseQuickAdd(input, makeCtx({ zone, locale, now: at(zone, local), manual }));
}
const spec = (d: ParseResult["fields"]["scheduled"]): string | undefined => (d === undefined ? undefined : d.kind === "date" ? d.date : d.local);
const endOf = (r: ParseResult): string | undefined => {
	const e = r.fields.recurrenceEnd;
	return e === undefined ? undefined : e.kind === "date" ? e.date : e.kind === "count" ? `${e.count}x` : "never";
};
const applied = (r: ParseResult): string[] => r.chips.filter((c) => c.status === "applied").map((c) => `${c.kind}|${c.text}`);

/** A date spelt as the locale reads it: "Oct 12" in en, "12 Oct" in en-GB. */
const spelt = (locale: DateLocale, month: string, day: number): string => (locale === "en" ? `${month} ${day}` : `${day} ${month}`);

interface Row {
	in: string;
	title: string;
	rec?: string;
	s?: string;
	d?: string;
	end?: string;
	/** The chips that block saving, by kind. */
	blocking?: string[];
}

function check(row: Row, zone: string, locale: DateLocale = "en", local?: string): void {
	const r = parse(row.in, zone, locale, local);
	const because = `${JSON.stringify(row.in)} ${locale} ${zone}: ${r.chips.map((c) => `${c.kind}|${c.status}|${c.text}`).join(" ; ")}`;
	expect(r.title, because).toBe(row.title);
	expect(r.fields.recurrence === undefined ? undefined : ruleKey(r.fields.recurrence), because).toBe(row.rec);
	expect(spec(r.fields.scheduled), because).toBe(row.s);
	expect(spec(r.fields.deadline), because).toBe(row.d);
	expect(endOf(r), because).toBe(row.end);
	expect(r.blocking.map((id) => r.chips.find((c) => c.id === id)?.kind), because).toEqual(row.blocking ?? []);
}

/** The phrase is an `every …` Quick Add does not build: one unsupported chip with the notice, and nothing applied. */
function unsupported(input: string, zone: string, phrase = input.replace(/^Gym /u, "")): void {
	const r = parse(input, zone);
	const because = `${JSON.stringify(input)} ${zone}: ${r.chips.map((c) => `${c.kind}|${c.status}|${c.text}`).join(" ; ")}`;
	const repeats = r.chips.filter((c) => c.kind === "recurrence");
	expect(repeats.length, because).toBeGreaterThan(0);
	for (const c of repeats) expect([c.status, c.notice], because).toEqual(["unsupported", NOTICE]);
	expect(repeats[0]!.text, because).toBe(phrase);
	expect(applied(r), because).toEqual([]);
	expect(r.fields, because).toEqual({ tagKeys: [], newTags: [] });
	expect(r.title, because).toBe(input);
	expect(r.blocking, because).toEqual([]);
}

/** The phrase is plain title text: no repeat, nothing applied, the title whole. */
function titleText(input: string, zone: string): void {
	const r = parse(input, zone);
	const because = `${JSON.stringify(input)} ${zone}: ${r.chips.map((c) => `${c.kind}|${c.status}|${c.text}`).join(" ; ")}`;
	expect(r.chips.some((c) => c.kind === "recurrence" || c.kind === "repeatEnd"), because).toBe(false);
	expect(applied(r), because).toEqual([]);
	expect(r.fields, because).toEqual({ tagKeys: [], newTags: [] });
	expect(r.title, because).toBe(input);
}

describe.each(ZONES)("1. Repeat forms in %s", (zone) => {
	const rows: Row[] = [
		{ in: "Gym every day", title: "Gym", rec: "daily" },
		{ in: "Gym daily", title: "Gym", rec: "daily" },
		{ in: "Gym every morning", title: "Gym", rec: "daily" },
		{ in: "Gym every afternoon", title: "Gym", rec: "daily" },
		{ in: "Gym every evening", title: "Gym", rec: "daily" },
		{ in: "Gym every night", title: "Gym", rec: "daily" },
		{ in: "Gym every 3 days", title: "Gym", rec: "daily/3" },
		{ in: "Gym every other day", title: "Gym", rec: "daily/2" },
		{ in: "Gym every weekday", title: "Gym", rec: WEEKDAYS },
		{ in: "Gym every workday", title: "Gym", rec: WEEKDAYS },
		{ in: "Gym weekdays", title: "Gym", rec: WEEKDAYS },
		{ in: "Gym workdays", title: "Gym", rec: WEEKDAYS },
		{ in: "Gym every weekend", title: "Gym", rec: "weekly:SA,SU" },
		{ in: "Gym weekends", title: "Gym", rec: "weekly:SA,SU" },
		{ in: "Gym every week", title: "Gym", rec: "weekly" },
		{ in: "Gym weekly", title: "Gym", rec: "weekly" },
		{ in: "Gym every 2 weeks", title: "Gym", rec: "weekly/2" },
		{ in: "Gym every other week", title: "Gym", rec: "weekly/2" },
		{ in: "Gym fortnightly", title: "Gym", rec: "weekly/2" },
		{ in: "Gym every monday", title: "Gym", rec: "weekly:MO" },
		{ in: "Gym every mon", title: "Gym", rec: "weekly:MO" },
		{ in: "Gym mondays", title: "Gym", rec: "weekly:MO" },
		{ in: "Gym every other monday", title: "Gym", rec: "weekly/2:MO" },
		{ in: "Gym every mon, wed, fri", title: "Gym", rec: "weekly:MO,WE,FR" },
		{ in: "Gym every mon wed fri", title: "Gym", rec: "weekly:MO,WE,FR" },
		{ in: "Gym every mon and fri", title: "Gym", rec: "weekly:MO,FR" },
		{ in: "Gym every mon & fri", title: "Gym", rec: "weekly:MO,FR" },
		{ in: "Gym weekly on mon, fri", title: "Gym", rec: "weekly:MO,FR" },
		{ in: "Gym weekly mon, fri", title: "Gym", rec: "weekly:MO,FR" },
		{ in: "Gym every week on mon, fri", title: "Gym", rec: "weekly:MO,FR" },
		{ in: "Gym mondays and fridays", title: "Gym", rec: "weekly:MO,FR" },
		{ in: "Gym every mon-fri", title: "Gym", rec: WEEKDAYS },
		{ in: "Gym every monday to friday", title: "Gym", rec: WEEKDAYS },
		{ in: "Gym every tue-thu", title: "Gym", rec: "weekly:TU,WE,TH" },
		{ in: "Gym every week on mon-fri", title: "Gym", rec: WEEKDAYS },
		{ in: "Gym weekly mon-fri", title: "Gym", rec: WEEKDAYS },
		{ in: "Gym weekly on mon-fri", title: "Gym", rec: WEEKDAYS },
		{ in: "Gym every fri-mon", title: "Gym", rec: "weekly:MO,FR,SA,SU" },
		{ in: "Gym every 2 weeks on mon, fri", title: "Gym", rec: "weekly/2:MO,FR" },
		{ in: "Gym every 2 weeks tuesday", title: "Gym", rec: "weekly/2:TU" },
		{ in: "Gym every other week on tue", title: "Gym", rec: "weekly/2:TU" },
		{ in: "Pay every month", title: "Pay", rec: "monthly" },
		{ in: "Pay monthly", title: "Pay", rec: "monthly" },
		{ in: "Pay every 3 months", title: "Pay", rec: "monthly/3" },
		{ in: "Pay every other month", title: "Pay", rec: "monthly/2" },
		{ in: "Pay quarterly", title: "Pay", rec: "monthly/3" },
		{ in: "Pay every quarter", title: "Pay", rec: "monthly/3" },
		{ in: "Pay every 15th", title: "Pay", rec: "monthly:d15" },
		{ in: "Pay every month on the 15th", title: "Pay", rec: "monthly:d15" },
		{ in: "Pay every month on 15", title: "Pay", rec: "monthly:d15" },
		{ in: "Pay monthly on the 15th", title: "Pay", rec: "monthly:d15" },
		{ in: "Pay monthly on day 15", title: "Pay", rec: "monthly:d15" },
		{ in: "Pay on the 15th of every month", title: "Pay", rec: "monthly:d15" },
		{ in: "Pay the 15th of each month", title: "Pay", rec: "monthly:d15" },
		{ in: "Pay rent monthly on the 1st", title: "Pay rent", rec: "monthly:d1" },
		{ in: "Pay every last day of the month", title: "Pay", rec: "monthly:last" },
		{ in: "Pay monthly on the last day", title: "Pay", rec: "monthly:last" },
		{ in: "Pay last day of the month", title: "Pay", rec: "monthly:last" },
		{ in: "Pay last day of every month", title: "Pay", rec: "monthly:last" },
		{ in: "Gym every first friday", title: "Gym", rec: "monthly:FR#1" },
		{ in: "Gym every second friday", title: "Gym", rec: "monthly:FR#2" },
		{ in: "Gym every third friday", title: "Gym", rec: "monthly:FR#3" },
		{ in: "Gym every fourth friday", title: "Gym", rec: "monthly:FR#4" },
		{ in: "Gym every last friday", title: "Gym", rec: "monthly:FR#-1" },
		{ in: "Gym every 1st friday", title: "Gym", rec: "monthly:FR#1" },
		{ in: "Gym every 2nd friday", title: "Gym", rec: "monthly:FR#2" },
		{ in: "Gym every 3rd friday", title: "Gym", rec: "monthly:FR#3" },
		{ in: "Gym every 4th friday", title: "Gym", rec: "monthly:FR#4" },
		{ in: "Gym every 2nd friday of the month", title: "Gym", rec: "monthly:FR#2" },
		{ in: "Gym last friday of the month", title: "Gym", rec: "monthly:FR#-1" },
		{ in: "Gym every year", title: "Gym", rec: "yearly" },
		{ in: "Gym yearly", title: "Gym", rec: "yearly" },
		{ in: "Gym annually", title: "Gym", rec: "yearly" },
		{ in: "Gym every 2 years", title: "Gym", rec: "yearly/2" },
		{ in: "Gym every other year", title: "Gym", rec: "yearly/2" },
		{ in: "Gym every 999 days", title: "Gym", rec: "daily/999" },
	];
	it.each(rows)("#12: $in", (row) => check(row, zone));

	it("#12: the Nth weekday of each or every month, anywhere in the text; of the month alone stays text", () => {
		const days = { monday: "MO", tuesday: "TU", friday: "FR", sunday: "SU" } as const;
		const nth = { "1st": 1, first: 1, "2nd": 2, second: 2, "3rd": 3, third: 3, "4th": 4, fourth: 4, last: -1 } as const;
		for (const [ord, n] of Object.entries(nth)) {
			for (const [day, code] of Object.entries(days)) {
				for (const each of ["each", "every"]) check({ in: `Report the ${ord} ${day} of ${each} month`, title: "Report", rec: `monthly:${code}#${n}` }, zone);
				if (ord === "last") continue;
				const input = `Report the ${ord} ${day} of the month review`;
				const r = parse(input, zone);
				expect(r.chips.some((c) => c.kind === "recurrence"), input).toBe(false);
				expect(r.title, input).toContain(`the ${ord}`);
			}
		}
	});

	it.each(LOCALES)("#12: %s: every year on <date>, yearly on <date>, annually on <date> start on that date", (locale) => {
		const may5 = spelt(locale, "May", 5);
		for (const form of ["every year on", "yearly on", "annually on"]) {
			check({ in: `Bday ${form} ${may5}`, title: "Bday", rec: "yearly", s: "2027-05-05" }, zone, locale);
		}
		check({ in: `Bday every year on ${spelt(locale, "Feb", 29)}`, title: "Bday", rec: "yearly", s: "2028-02-29" }, zone, locale);
	});

	it("#12: N is 1 to 999 in digits; number words are not read", () => {
		unsupported("Gym every 0 days", zone);
		unsupported("Gym every 1000 days", zone);
		unsupported("Gym every two weeks", zone);
	});

	it("#12: a bare word counts only when its phrase ends the text", () => {
		titleText("Daily standup", zone);
		titleText("Weekly review", zone);
		titleText("Gym daily with Ann", zone);
		titleText("Mondays are hard", zone);
		check({ in: "Stretch daily", title: "Stretch", rec: "daily" }, zone);
		check({ in: "Stretch daily at 7am", title: "Stretch", rec: "daily@07:00" }, zone);
		check({ in: "Pills daily until Dec 1", title: "Pills", rec: "daily", end: "2026-12-01" }, zone);
		check({ in: "Pills daily starting Oct 12", title: "Pills", rec: "daily", s: "2026-10-12" }, zone);
	});
});

describe.each(ZONES)("2. Time in %s", (zone) => {
	it.each([
		{ in: "Gym every monday at 9am", title: "Gym", rec: "weekly:MO@09:00" },
		{ in: "Gym every monday at 7:30pm", title: "Gym", rec: "weekly:MO@19:30" },
		{ in: "Gym every day at noon", title: "Gym", rec: "daily@12:00" },
		{ in: "Gym every day at 17:00", title: "Gym", rec: "daily@17:00" },
		{ in: "Pay monthly on the 1st at 9am", title: "Pay", rec: "monthly:d1@09:00" },
		{ in: "Gym mondays at 6pm", title: "Gym", rec: "weekly:MO@18:00" },
	])("#12: $in", (row) => check(row, zone));

	it("#12: an unclear hour is a choice; nothing applies until it is chosen, and saving waits for it", () => {
		const r = parse("Gym every day at 7", zone);
		expect(r.chips.map((c) => `${c.kind}|${c.status}|${c.text}`)).toEqual(["recurrence|choice|every day at 7"]);
		expect(r.chips[0]!.alternatives!.map((a) => a.label)).toEqual(["07:00", "19:00"]);
		expect(r.fields.recurrence).toBeUndefined();
		expect(r.blocking).toEqual([r.chips[0]!.id]);
	});

	it("#12: a repeat picked by hand wins: the typed hour's choice is a replacement and never blocks saving", () => {
		const r = parse("Gym every day at 7", zone, "en", undefined, ["recurrence"]);
		expect(r.chips[0]).toMatchObject({ kind: "recurrence", status: "choice", notice: "Replace repeat?" });
		expect(r.blocking).toEqual([]);
	});
});

describe.each(ZONES)("3. Start in %s", (zone) => {
	it.each(LOCALES)("#12: %s: starting, from, beginning, on and a bare date after the form", (locale) => {
		const oct12 = spelt(locale, "Oct", 12);
		const oct15 = spelt(locale, "Oct", 15);
		check({ in: `Gym every day starting ${oct12}`, title: "Gym", rec: "daily", s: "2026-10-12" }, zone, locale);
		check({ in: `Gym every day from ${oct12}`, title: "Gym", rec: "daily", s: "2026-10-12" }, zone, locale);
		check({ in: `Gym every day beginning ${oct12}`, title: "Gym", rec: "daily", s: "2026-10-12" }, zone, locale);
		check({ in: `Pay every month on ${oct15}`, title: "Pay", rec: "monthly", s: "2026-10-15" }, zone, locale);
		check({ in: `Gym every day ${oct12}`, title: "Gym", rec: "daily", s: "2026-10-12" }, zone, locale);
		check({ in: `Gym every day, ${oct12}`, title: "Gym", rec: "daily", s: "2026-10-12" }, zone, locale);
		check({ in: `Pay every month ${oct15}`, title: "Pay", rec: "monthly", s: "2026-10-15" }, zone, locale);
		check({ in: "Gym every day starting monday", title: "Gym", rec: "daily", s: "2026-10-12" }, zone, locale);
		check({ in: "Gym every day on monday", title: "Gym", rec: "daily", s: "2026-10-12" }, zone, locale);
	});

	it("#12: a number after a comma stays in the title, with no stray comma", () => {
		check({ in: "Read every day, 20 pages", title: "Read 20 pages", rec: "daily" }, zone);
	});
});

describe.each(ZONES)("4. End in %s", (zone) => {
	it.each(LOCALES)("#12: %s: until, till, ending, ending on, ends on", (locale) => {
		const dec1 = spelt(locale, "Dec", 1);
		for (const lead of ["until", "till", "ending", "ending on", "ends on"]) {
			check({ in: `Pills every day ${lead} ${dec1}`, title: "Pills", rec: "daily", end: "2026-12-01" }, zone, locale);
		}
	});

	it.each([
		{ in: "Pills every day for 5 times", title: "Pills", rec: "daily", end: "5x" },
		{ in: "Pills every day for 5 days", title: "Pills", rec: "daily", end: "2026-10-11" },
		{ in: "Gym every day for 2 weeks", title: "Gym", rec: "daily", end: "2026-10-20" },
		{ in: "Pay every month for 6 months", title: "Pay", rec: "monthly", end: "2027-04-06" },
		{ in: "Pay every year for 2 years", title: "Pay", rec: "yearly", end: "2028-10-06" },
		{ in: "Gym every monday for 3 mondays", title: "Gym", rec: "weekly:MO", end: "2026-10-27" },
		{ in: "Pills every day until friday", title: "Pills", rec: "daily", end: "2026-10-09" },
	])("#12: $in", (row) => check(row, zone));

	it.each(LOCALES)("#12: %s: a first and a last date", (locale) => {
		const oct12 = spelt(locale, "Oct", 12);
		const dec1 = spelt(locale, "Dec", 1);
		const both: Row = { in: "", title: "Gym", rec: "daily", s: "2026-10-12", end: "2026-12-01" };
		for (const range of [`from ${oct12} until ${dec1}`, `from ${oct12} to ${dec1}`, `starting ${oct12} until ${dec1}`, `starting ${oct12} to ${dec1}`, `starting ${oct12} ending ${dec1}`, `${oct12} to ${dec1}`]) {
			check({ ...both, in: `Gym every day ${range}` }, zone, locale);
		}
		// Two bare weekdays: neither a start and end nor the repeat's days, unless `starting` or `beginning` leads them.
		for (const input of ["Gym every day Mon-Fri", "Gym daily Mon-Fri", "Gym every day from Monday to Friday"]) {
			const r = parse(input, zone, locale);
			expect(ruleKey(r.fields.recurrence!), input).toBe("daily");
			expect([r.fields.scheduled, r.fields.recurrenceEnd], input).toEqual([undefined, undefined]);
			expect(r.chips.find((c) => c.kind === "scheduled")?.status, input).toBe("suggestion");
		}
		check({ in: "Gym every day starting Monday until Friday", title: "Gym", rec: "daily", s: "2026-10-12", end: "2026-10-16" }, zone, locale);
		check({ in: "Gym every day starting monday ending friday", title: "Gym", rec: "daily", s: "2026-10-12", end: "2026-10-16" }, zone, locale);
		check({ in: "Gym every day beginning Monday to Friday", title: "Gym", rec: "daily", s: "2026-10-12", end: "2026-10-16" }, zone, locale);
	});

	it("#12: start and end parts come in any order after the form and its time", () => {
		check({ in: "Gym every day at 7am until Dec 1 starting Oct 12", title: "Gym", rec: "daily@07:00", s: "2026-10-12", end: "2026-12-01" }, zone);
		check({ in: "Gym every day starting Oct 12 at 7am", title: "Gym", rec: "daily", s: "2026-10-12T07:00" }, zone);
	});

	it("#12: an end must be a date: `until <time>` after a repeat is a visible suggestion, never applied", () => {
		for (const [input, rec] of [
			["Pills every day until 5pm", "daily"],
			["Gym every monday until 5pm", "weekly:MO"],
		] as const) {
			check({ in: input, title: input.replace(/ every \w+/u, ""), rec }, zone);
			const r = parse(input, zone);
			expect(r.chips.find((c) => c.kind === "scheduled"), input).toMatchObject({ status: "suggestion", text: "until 5pm", notice: "Use as date?" });
		}
		const choice = parse("Gym every day until 5", zone);
		expect(choice.fields.recurrenceEnd).toBeUndefined();
		expect(choice.chips.map((c) => `${c.kind}|${c.status}|${c.text}`)).toEqual(["recurrence|applied|every day"]);
		expect(choice.title).toBe("Gym until 5");
	});

	it("#12: an end that leaves no date blocks saving", () => {
		check({ in: "Gym every friday until Oct 8", title: "Gym until Oct 8", rec: "weekly:FR", blocking: ["repeatEnd"] }, zone);
	});

	it("#12: an end that rolls more than a year past the start is a suggestion", () => {
		const r = parse("Gym every day starting Mar 1 until Feb 29", zone, "en", "2028-02-29T10:00");
		expect(spec(r.fields.scheduled)).toBe("2028-03-01");
		expect(r.fields.recurrenceEnd).toBeUndefined();
		expect(r.chips.find((c) => c.kind === "repeatEnd")).toMatchObject({ status: "suggestion", notice: "Use as end date?", end: { kind: "date", date: "2032-02-29" } });
	});

	it("#12: `for N …` counts only after the repeat", () => {
		const r = parse("Plan meals for 7 days every sunday", zone);
		expect(r.title).toBe("Plan meals for 7 days");
		expect(ruleKey(r.fields.recurrence!)).toBe("weekly:SU");
		expect(r.fields.recurrenceEnd).toBeUndefined();
		expect(r.fields.plannedDurationMin).toBeUndefined();
	});
});

describe.each(ZONES)("5. Not supported in %s", (zone) => {
	it("#12: hourly or minute repeats", () => {
		unsupported("Gym every 3 hours", zone);
		unsupported("Gym every 30 minutes", zone);
	});

	it("#12: several times or several patterns", () => {
		unsupported("Gym every monday at 9 and friday at 5", zone);
		unsupported("Gym every 2nd and 4th tuesday", zone);
		unsupported("Gym every day and every week", zone);
		unsupported("Gym every day every week", zone, "every day");
		unsupported("Gym every day, every week", zone);
	});

	it("#12: exceptions", () => {
		unsupported("Gym every day except sunday", zone);
	});

	it("#12: frequencies per period stay title text and are never an end", () => {
		check({ in: "Pills every day 3 times a day", title: "Pills 3 times a day", rec: "daily" }, zone);
		check({ in: "Gym every week twice a week", title: "Gym twice a week", rec: "weekly" }, zone);
		check({ in: "Gym every week 2 times a week", title: "Gym 2 times a week", rec: "weekly" }, zone);
		check({ in: "Pay every month twice a month", title: "Pay twice a month", rec: "monthly" }, zone);
		check({ in: "Pills every day 3 times", title: "Pills 3 times", rec: "daily" }, zone);
		titleText("Drink water 3 times a day", zone);
		titleText("Gym twice a week", zone);
	});

	it("#12: several days of the month", () => {
		unsupported("Pay every month on the 1st and 15th", zone, "every month on the 1st and 15th");
	});

	it("#12: a fifth weekday", () => {
		unsupported("Gym every 5th friday", zone);
		unsupported("Gym every fifth friday", zone);
	});

	it("#12: biweekly and bimonthly stay title text", () => {
		titleText("Gym biweekly", zone);
		titleText("Gym bimonthly", zone);
	});

	it("#12: each monday and each day stay title text", () => {
		titleText("Call each monday", zone);
		titleText("Call each day", zone);
	});

	it("#12: a day part after a weekday stays text", () => {
		const r = parse("Gym every sunday evening", zone);
		expect(ruleKey(r.fields.recurrence!)).toBe("weekly:SU");
		expect(r.title).toBe("Gym evening");
		expect(applied(r)).toEqual(["recurrence|every sunday"]);
	});

	it("#12: a time without `at` is read on its own", () => {
		check({ in: "Gym every monday 9am", title: "Gym", rec: "weekly:MO", s: "2026-10-08T09:00" }, zone);
	});

	it("#12: the 1st of the month without each or every stays title text", () => {
		check({ in: "Visit the 1st of the month market Saturday", title: "Visit the 1st of the month market", s: "2026-10-10" }, zone);
		check({ in: "Report the 2nd tuesday of the month", title: "Report the 2nd of the month", s: "2026-10-13" }, zone);
	});

	it("#12: a date after a weekly form with `on` stays text: no start", () => {
		for (const input of ["Gym every week on Oct 12", "Gym every 2 weeks on Oct 12", "Gym every monday on Oct 12", "Gym weekly on Oct 12"]) {
			const r = parse(input, zone);
			const because = `${input}: ${r.chips.map((c) => `${c.kind}|${c.status}|${c.text}`).join(" ; ")}`;
			expect(r.fields.recurrence, because).toBeDefined();
			expect(r.fields.scheduled, because).toBeUndefined();
			expect(r.title, because).toBe(`Gym on Oct 12`);
		}
		check({ in: "Gym every week starting Oct 12", title: "Gym", rec: "weekly", s: "2026-10-12" }, zone);
	});

	it("#12: start or end words before the repeat are not its parts: they read as without a repeat", () => {
		check({ in: "Wait until Friday then call the bank every monday", title: "Wait then call the bank", rec: "weekly:MO", d: "2026-10-09" }, zone);
		check({ in: "Stay until Dec 1 and water plants every day", title: "Stay and water plants", rec: "daily", d: "2026-12-01" }, zone);
		check({ in: "Starting Monday run every day", title: "Starting run", rec: "daily", s: "2026-10-12" }, zone);
		check({ in: "Trip ending Dec 1 then stretch daily", title: "Trip ending then stretch", s: "2026-12-01", rec: "daily" }, zone);
		check({ in: "Call from Oct 12 to Dec 1 then every monday", title: "Call from Oct 12 to Dec 1 then", rec: "weekly:MO" }, zone);
	});

	it("#12: a start or end part after a repeat Quick Add cannot build applies nothing", () => {
		unsupported("Take pills every 8 hours starting tomorrow", zone, "every 8 hours");
		unsupported("Take pills every 8 hours on Monday", zone, "every 8 hours");
		unsupported("Take pills every 8 hours from Oct 12 to Dec 1", zone, "every 8 hours");
		unsupported("Take pills every 8 hours until Friday", zone, "every 8 hours");
		unsupported("Take pills every 8 hours until 5pm", zone, "every 8 hours");
		unsupported("Gym every day every week starting Monday", zone, "every day");
		// A date right after it, with no lead word, applies nothing either: at most a visible suggestion.
		for (const input of ["Take pills every 8 hours tomorrow", "Take pills every 8 hours, Oct 12", "Take pills every 8 hours next week"]) {
			unsupported(input, zone, "every 8 hours");
			expect(parse(input, zone).chips.find((c) => c.kind === "scheduled")?.status, input).toBe("suggestion");
		}
	});

	it("#12: a date joined by and, & or a comma after a repeat Quick Add cannot build applies nothing", () => {
		for (const [input, phrase] of [
			["Gym every May 5 and Dec 25", "every May 5"],
			["Gym every May 5, Dec 25", "every May 5"],
			["Gym every May 5 & Dec 25", "every May 5"],
			["Gym every May 5, and Dec 25", "every May 5"],
			["Take pills every 8 hours and tomorrow", "every 8 hours"],
			["Take pills every 8 hours & Oct 12", "every 8 hours"],
		] as const) {
			unsupported(input, zone, phrase);
			expect(parse(input, zone).chips.find((c) => c.kind === "scheduled")?.status, input).toBe("suggestion");
		}
		// Title words between the repeat and the date: the date is read on its own, as without a repeat.
		const r = parse("Take pills every 8 hours and call the bank tomorrow", zone);
		expect(r.chips.find((c) => c.kind === "recurrence")).toMatchObject({ status: "unsupported", notice: NOTICE });
		expect(r.fields.scheduled).toEqual({ kind: "date", date: "2026-10-08" });
	});

	it("#12: a repeat with two starts", () => {
		for (const input of ["Bday every year on May 5 from Oct 12", "Bday every year on May 5 from Oct 12 to Dec 1", "Bday every year on May 5 starting Oct 12"]) {
			const r = parse(input, zone);
			const because = `${input}: ${r.chips.map((c) => `${c.kind}|${c.status}|${c.text}`).join(" ; ")}`;
			expect(r.chips.find((c) => c.kind === "recurrence"), because).toMatchObject({ status: "unsupported", notice: NOTICE });
			expect(applied(r), because).toEqual([]);
			expect(r.fields, because).toEqual({ tagKeys: [], newTags: [] });
			expect(r.title, because).toBe(input);
			expect(r.blocking, because).toEqual([]);
		}
	});
});

describe.each(ZONES)("6. Rules that always hold in %s", (zone) => {
	it("#12: a value picked by hand wins: the typed start of a yearly repeat is a suggestion and never blocks saving", () => {
		for (const input of ["Bday every year on May 5", "Bday every year on May 5 at 7"]) {
			const r = parse(input, zone, "en", undefined, ["scheduled"]);
			expect(r.blocking, input).toEqual([]);
			expect(ruleKey(r.fields.recurrence!), input).toBe("yearly");
			expect(r.fields.scheduled, input).toBeUndefined();
			expect(r.chips.find((c) => c.kind === "scheduled")?.notice, input).toBe("Replace date?");
		}
	});

	it("#12: a later explicit date wins over a weekday word earlier in the title", () => {
		check({ in: "Call Tuesday team every day, Oct 12", title: "Call Tuesday team", rec: "daily", s: "2026-10-12" }, zone);
	});

	it("#12: without a repeat, until <date> is a deadline and the other lead words stay text", () => {
		check({ in: "Trip until Dec 1", title: "Trip", d: "2026-12-01" }, zone);
		check({ in: "Wait until tomorrow", title: "Wait", d: "2026-10-08" }, zone);
		check({ in: "Trip ending Dec 1", title: "Trip ending", s: "2026-12-01" }, zone);
		check({ in: "Trip starting Dec 1", title: "Trip starting", s: "2026-12-01" }, zone);
		check({ in: "Trip till Dec 1", title: "Trip till", s: "2026-12-01" }, zone);
		check({ in: "Trip beginning Dec 1", title: "Trip beginning", s: "2026-12-01" }, zone);
		check({ in: "Call from Dec 1", title: "Call from", s: "2026-12-01" }, zone);
	});

	it("#12: the title keeps everything not read, with no stray commas or spaces", () => {
		check({ in: "Read every day, 20 pages", title: "Read 20 pages", rec: "daily" }, zone);
		check({ in: "Party May 5, 20 guests", title: "Party 20 guests", s: "2027-05-05" }, zone);
		check({ in: "Pills every day, until Dec 1", title: "Pills", rec: "daily", end: "2026-12-01" }, zone);
		check({ in: "Pay rent, until Oct 20", title: "Pay rent", d: "2026-10-20" }, zone);
		check({ in: "Birthday every year on Jun 3, 25 people", title: "Birthday 25 people", rec: "yearly", s: "2027-06-03" }, zone);
		check({ in: "Buy milk, eggs, tomorrow", title: "Buy milk, eggs", s: "2026-10-08" }, zone);
		check({ in: "Call Bob, Mary every day", title: "Call Bob, Mary", rec: "daily" }, zone);
	});
});

describe("repeat phrasing", () => {
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
			it.each(CASES.map((c) => [c.in, c] as const))(`#12: ${zone}: %s`, (_name, c) => check(c, zone));
		}

		it("#12: a bare word is a repeat only at the end: \"Daily standup\" keeps its title and its date", () => {
			const r = parse("Daily standup tomorrow", NY);
			expect(r.title).toBe("Daily standup");
			expect(r.fields.recurrence).toBeUndefined();
			expect(r.fields.scheduled).toEqual({ kind: "date", date: "2026-10-08" });
		});

		it("#12: an unsupported repeat masks its words from the date reader", () => {
			for (const input of ["Call every 3 hours", "Gym every 2nd and 4th Tuesday", "Taxes every May 5"]) {
				const r = parse(input, NY);
				expect(r.fields.scheduled, input).toBeUndefined();
				expect(r.chips.every((c) => c.kind === "recurrence" && c.status === "unsupported"), input).toBe(true);
			}
		});
	});
});
