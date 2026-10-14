import { describe, expect, it } from "vitest";
import { occurrencesBetween, plainRule, startRecurrence } from "../../src/domain/recurrence";
import type { RepeatRule } from "../../src/domain/types";
import type { Chip, DateLocale, ParseResult, ParsedField } from "../../src/parsing/types";
import { blockingKinds, briefChips, chipLines, chipOf, dateSpecOf, deadlineOf, endOf, inZones, parseAt, recOf, scheduledOf, type ParseOptions } from "./helpers";

// #12: the closed table of repeat phrases
// Quick Add reads, and the one home for "typed text to rule, start and end". Every row runs in New York, Berlin and
// Tokyo, in en and en-GB where a date is spelt. A phrase outside the table is never applied: it stays title text, or,
// as an `every …`, shows "Recurrence not supported yet". Wednesday 2026-10-07 10:00 in each zone unless a row says
// otherwise.

const LOCALES = ["en", "en-GB"] as const;
const NOTICE = "Recurrence not supported yet";
const ENDS_BEFORE = "The repeat ends before its first date.";
const WEEKDAYS = "weekly:MO,TU,WE,TH,FR";
const DAILY = plainRule("daily");
const FRIDAYS: RepeatRule = { ...plainRule("weekly"), weekdays: ["FR"] };

/** A date spelt as the locale reads it: "Oct 12" in en, "12 Oct" in en-GB. */
const spelt = (locale: DateLocale, month: string, day: number): string => (locale === "en" ? `${month} ${day}` : `${day} ${month}`);
const applied = (r: ParseResult): string[] => r.chips.filter((c) => c.status === "applied").map((c) => `${c.kind}|${c.text}`);
const DATE_KINDS: readonly Chip["kind"][] = ["scheduled", "deadline", "repeatEnd"];

interface Row {
	in: string;
	title: string;
	/** The typed repeat as a ruleKey (see helpers.ts); absent means none. */
	rec?: string;
	s?: string;
	d?: string;
	/** "2026-12-01" (a date end) or "5x" (a count end); absent means no end. */
	end?: string;
	/** The chips that block saving, by kind. */
	blocking?: string[];
	/** Every chip as chipLine prints it, notices included; absent means not checked. */
	chips?: string[];
	/** Every chip as kind|status|text; absent means not checked. */
	brief?: string[];
	/** The date chips (scheduled, deadline, repeat end) as kind|status|text; absent means not checked. */
	dates?: string[];
	/** The first date of the series started from the reading on Wednesday 2026-10-07. */
	first?: string;
	/** "any" reads the row the same in en and en-GB. */
	locale?: DateLocale | "any";
	/** The local wall time of the reference instant. */
	local?: string;
	manual?: ParsedField[];
	/** A start date picked by hand. */
	startDate?: string;
	/** A repeat picked by hand. */
	pickedRule?: RepeatRule;
	/** The planned duration in minutes, the list id, the section id and the priority; null means none, absent means not checked. */
	dur?: number | null;
	cat?: string | null;
	sec?: string | null;
	pri?: 1 | 2 | 3 | null;
	/** The existing tag keys and the new tag names; absent means not checked. */
	tags?: string[];
	nt?: string[];
	/** The vault's lists, sections and tags, in place of the test vault's. */
	vault?: Pick<ParseOptions, "categories" | "sections" | "tags">;
}

function check(row: Row, zone: string, locale: DateLocale = row.locale === "any" || row.locale === undefined ? "en" : row.locale): void {
	const r = parseAt(row.in, zone, { ...row.vault, locale, local: row.local, manual: row.manual, startDate: row.startDate, pickedRule: row.pickedRule });
	const because = `${JSON.stringify(row.in)} ${locale} ${zone}: ${briefChips(r).join(" ; ")}`;
	expect(r.title, because).toBe(row.title);
	expect(recOf(r), because).toBe(row.rec);
	expect(scheduledOf(r), because).toBe(row.s);
	expect(deadlineOf(r), because).toBe(row.d);
	expect(endOf(r), because).toBe(row.end);
	expect(blockingKinds(r), because).toEqual(row.blocking ?? []);
	const absent = <T>(v: T | null | undefined): T | undefined => v ?? undefined;
	if (row.dur !== undefined) expect(r.fields.plannedDurationMin, because).toBe(absent(row.dur));
	if (row.cat !== undefined) expect(r.fields.categoryId, because).toBe(absent(row.cat));
	if (row.sec !== undefined) expect(r.fields.sectionId, because).toBe(absent(row.sec));
	if (row.pri !== undefined) expect(r.fields.priority, because).toBe(absent(row.pri));
	if (row.tags !== undefined) expect(r.fields.tagKeys, because).toEqual(row.tags);
	if (row.nt !== undefined) expect(r.fields.newTags, because).toEqual(row.nt);
	if (row.chips !== undefined) expect(chipLines(r), because).toEqual(row.chips);
	if (row.brief !== undefined) expect(briefChips(r), because).toEqual(row.brief);
	if (row.dates !== undefined) expect(briefChips(r).filter((_, i) => DATE_KINDS.includes(r.chips[i]!.kind)), because).toEqual(row.dates);
	if (row.first !== undefined) {
		const started = startRecurrence(r.fields.scheduled ?? null, r.fields.recurrence!, r.fields.recurrenceEnd, "2026-10-07", zone, "MO");
		expect(occurrencesBetween(started.recurrence, started.recurrence.anchor, "2027-12-31", "MO")[0], because).toBe(row.first);
	}
	for (const chip of r.chips) expect(chip.text, because).toBe(row.in.slice(chip.span.start, chip.span.end));
}

/** Checks a row in every zone, and in both locales for a row read the same in either. */
function checkRow(row: Row): void {
	inZones((zone) => {
		if (row.locale === "any") for (const locale of LOCALES) check(row, zone, locale);
		else check(row, zone);
	});
}

/** The phrase is an `every …` Quick Add does not build: one unsupported chip with the notice, and nothing applied. */
function unsupported(input: string, zone: string, phrase = input.replace(/^Gym /u, "")): void {
	const r = parseAt(input, zone);
	const because = `${JSON.stringify(input)} ${zone}: ${briefChips(r).join(" ; ")}`;
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
	const r = parseAt(input, zone);
	const because = `${JSON.stringify(input)} ${zone}: ${briefChips(r).join(" ; ")}`;
	expect(r.chips.some((c) => c.kind === "recurrence" || c.kind === "repeatEnd"), because).toBe(false);
	expect(applied(r), because).toEqual([]);
	expect(r.fields, because).toEqual({ tagKeys: [], newTags: [] });
	expect(r.title, because).toBe(input);
}

describe("1. Repeat forms", () => {
	// Ranges of weekdays after `every`, `every week (on)` and `weekly (on)` are repeat-grammar.test.ts's.
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
		{ in: "Gym every mon wed fri", title: "Gym", rec: "weekly:MO,WE,FR", chips: ["applied|recurrence|every mon wed fri|r=weekly:MO,WE,FR"] },
		{ in: "Gym every mon and fri", title: "Gym", rec: "weekly:MO,FR" },
		{ in: "Gym every mon & fri", title: "Gym", rec: "weekly:MO,FR" },
		{ in: "Gym weekly on mon, fri", title: "Gym", rec: "weekly:MO,FR" },
		{ in: "Gym weekly mon, fri", title: "Gym", rec: "weekly:MO,FR" },
		{ in: "Gym every week on mon, fri", title: "Gym", rec: "weekly:MO,FR" },
		{ in: "Gym mondays and fridays", title: "Gym", rec: "weekly:MO,FR" },
		{ in: "Gym every 2 weeks on mon, fri", title: "Gym", rec: "weekly/2:MO,FR" },
		{ in: "Gym every 2 weeks tuesday", title: "Gym", rec: "weekly/2:TU" },
		{ in: "Gym every other week on tue", title: "Gym", rec: "weekly/2:TU" },
		// weekday lists with plain spaces
		{ in: "Gym every mon wed and fri", title: "Gym", rec: "weekly:MO,WE,FR" },
		{ in: "Gym every Monday Wednesday", title: "Gym", rec: "weekly:MO,WE" },
		{ in: "Gym every monday friday", title: "Gym", rec: "weekly:MO,FR" },
		{ in: "Gym every sat sun", title: "Gym", rec: "weekly:SA,SU" },
		{ in: "Gym every mon wed fri at 7am", title: "Gym", rec: "weekly:MO,WE,FR@07:00" },
		{ in: "Gym every week on Monday", title: "Gym", rec: "weekly:MO" },
		{ in: "Gym every other week on tue thu", title: "Gym", rec: "weekly/2:TU,TH" },
		// more weekdays after `every other` or `every N weeks` are part of the repeat, never a date
		{ in: "Trash every other monday and wednesday", title: "Trash", rec: "weekly/2:MO,WE" },
		{ in: "Trash every other monday wed", title: "Trash", rec: "weekly/2:MO,WE" },
		{ in: "Gym every week monday", title: "Gym", rec: "weekly:MO" },
		// a range of weekdays is every weekday from the first to the last, round the week
		{ in: "Gym every tuesday to thursday", title: "Gym", rec: "weekly:TU,WE,TH" },
		{ in: "Gym every other fri-mon", title: "Gym", rec: "weekly/2:MO,FR,SA,SU" },
		{ in: "Gym every 2 weeks on mon-wed at 9am", title: "Gym", rec: "weekly/2:MO,TU,WE@09:00" },
		// `sat` and `sun` continue a space-joined list only at the end of the text; the full names always do
		{ in: "Apply every monday sun cream", title: "Apply sun cream", rec: "weekly:MO" },
		{ in: "Gym every monday sat exam prep", title: "Gym sat exam prep", rec: "weekly:MO" },
		{ in: "Gym every mon wed sat", title: "Gym", rec: "weekly:MO,WE,SA" },
		{ in: "Mow lawn every saturday sun", title: "Mow lawn", rec: "weekly:SA,SU" },
		{ in: "Gym every mon sat at 9am", title: "Gym", rec: "weekly:MO,SA@09:00" },
		{ in: "Gym every saturday sunday mornings", title: "Gym mornings", rec: "weekly:SA,SU" },
		{ in: "Gym every mon, sat and stretch", title: "Gym and stretch", rec: "weekly:MO,SA" },
		// no stray `on` or comma in the title
		{ in: "Gym on mondays", title: "Gym", rec: "weekly:MO" },
		{ in: "Party on the last friday of the month", title: "Party", rec: "monthly:FR#-1" },
		{ in: "Practice daily, for 10 times", title: "Practice", rec: "daily", end: "10x" },
		{ in: "Pay every month", title: "Pay", rec: "monthly" },
		{ in: "Pay monthly", title: "Pay", rec: "monthly" },
		{ in: "Pay every 3 months", title: "Pay", rec: "monthly/3" },
		{ in: "Pay every other month", title: "Pay", rec: "monthly/2" },
		{ in: "Pay quarterly", title: "Pay", rec: "monthly/3" },
		{ in: "Pay every quarter", title: "Pay", rec: "monthly/3" },
		{ in: "Pay every 15th", title: "Pay", rec: "monthly:d15" },
		{ in: "Pay every 1st of the month", title: "Pay", rec: "monthly:d1" },
		{ in: "Pay every 22nd of each month", title: "Pay", rec: "monthly:d22" },
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
		// the Nth weekday of the month, with or without `every`
		{ in: "Report last Friday of the month", title: "Report", rec: "monthly:FR#-1", chips: ["applied|recurrence|last Friday of the month|r=monthly:FR#-1"] },
		{ in: "Report the 2nd Tuesday of every month", title: "Report", rec: "monthly:TU#2" },
		{ in: "Last Friday of the month report", title: "report", rec: "monthly:FR#-1" },
		{ in: "Report every first monday of each month", title: "Report", rec: "monthly:MO#1" },
		{ in: "Gym every year", title: "Gym", rec: "yearly" },
		{ in: "Gym yearly", title: "Gym", rec: "yearly" },
		{ in: "Gym annually", title: "Gym", rec: "yearly" },
		{ in: "Gym every 2 years", title: "Gym", rec: "yearly/2" },
		{ in: "Gym every other year", title: "Gym", rec: "yearly/2" },
		{ in: "Taxes every year", title: "Taxes", rec: "yearly", chips: ["applied|recurrence|every year|r=yearly"] },
		{ in: "Gym every 999 days", title: "Gym", rec: "daily/999" },
		// day parts: a plain daily repeat, no time
		{ in: "Yoga every morning", title: "Yoga", rec: "daily", chips: ["applied|recurrence|every morning|r=daily"] },
		{ in: "Brush teeth every night", title: "Brush teeth", rec: "daily" },
		// bare repeat words at the end of the text, after title text
		{ in: "Sync weekly", title: "Sync", rec: "weekly" },
		{ in: "Clean fortnightly", title: "Clean", rec: "weekly/2" },
		{ in: "Bills monthly", title: "Bills", rec: "monthly" },
		{ in: "Taxes annually", title: "Taxes", rec: "yearly" },
		{ in: "Standup weekdays", title: "Standup", rec: WEEKDAYS },
		{ in: "Hike weekends", title: "Hike", rec: "weekly:SA,SU" },
		{ in: "Sync weekly #Study", title: "Sync", rec: "weekly" },
		{ in: "Stretch daily tomorrow", title: "Stretch", rec: "daily", s: "2026-10-08" },
		// text that only looks like a repeat stays text
		{ in: "Read every chapter", title: "Read every chapter", chips: [] },
		{ in: "Do it every time", title: "Do it every time", chips: [] },
		{ in: "Monthly report draft", title: "Monthly report draft", chips: [] },
		{ in: "#Study daily", title: "daily" },
		{ in: "Shop for 5 apples", title: "Shop for 5 apples", chips: [] },
		{ in: "Read every day 20 pages", title: "Read 20 pages", rec: "daily" },
		// yearly on a date: the date is the start, Feb 29 the next leap day or the year typed
		{ in: "Birthday every year on Feb 29 2032", title: "Birthday", rec: "yearly", s: "2032-02-29" },
		{ in: "Birthday every year on 02/29", title: "Birthday", rec: "yearly", s: "2028-02-29" },
		{ in: "Birthday every year on 29/02", locale: "en-GB", title: "Birthday", rec: "yearly", s: "2028-02-29" },
		{ in: "Birthday every year on the 29th of February", title: "Birthday", rec: "yearly", s: "2028-02-29" },
	];
	it.each(rows)("#12: $in", (row) => checkRow(row));

	it("#12: the Nth weekday of each or every month, anywhere in the text; of the month alone stays text", () => {
		const days = { monday: "MO", tuesday: "TU", friday: "FR", sunday: "SU" } as const;
		const nth = { "1st": 1, first: 1, "2nd": 2, second: 2, "3rd": 3, third: 3, "4th": 4, fourth: 4, last: -1 } as const;
		inZones((zone) => {
			for (const [ord, n] of Object.entries(nth)) {
				for (const [day, code] of Object.entries(days)) {
					for (const each of ["each", "every"]) check({ in: `Report the ${ord} ${day} of ${each} month`, title: "Report", rec: `monthly:${code}#${n}` }, zone);
					if (ord === "last") continue;
					const input = `Report the ${ord} ${day} of the month review`;
					const r = parseAt(input, zone);
					expect(r.chips.some((c) => c.kind === "recurrence"), `${input} ${zone}`).toBe(false);
					expect(r.title, `${input} ${zone}`).toContain(`the ${ord}`);
				}
			}
		});
	});

	it("#12: every year on <date>, yearly on <date>, annually on <date> start on that date", () => {
		inZones((zone) => {
			for (const locale of LOCALES) {
				const may5 = spelt(locale, "May", 5);
				for (const form of ["every year on", "yearly on", "annually on"]) {
					check({ in: `Bday ${form} ${may5}`, title: "Bday", rec: "yearly", s: "2027-05-05" }, zone, locale);
				}
				check({ in: `Bday every year on ${spelt(locale, "Feb", 29)}`, title: "Bday", rec: "yearly", s: "2028-02-29" }, zone, locale);
			}
		});
	});

	it("#12: N is 1 to 999 in digits; number words are not read", () => {
		inZones((zone) => {
			unsupported("Gym every 0 days", zone);
			unsupported("Gym every 1000 days", zone);
			unsupported("Gym every two weeks", zone);
		});
	});

	it("#12: a bare word counts only when its phrase ends the text", () => {
		inZones((zone) => {
			titleText("Daily standup", zone);
			titleText("Weekly review", zone);
			titleText("Gym daily with Ann", zone);
			titleText("Mondays are hard", zone);
			check({ in: "Stretch daily", title: "Stretch", rec: "daily", chips: ["applied|recurrence|daily|r=daily"] }, zone);
			check({ in: "Stretch daily at 7am", title: "Stretch", rec: "daily@07:00" }, zone);
			check({ in: "Pills daily until Dec 1", title: "Pills", rec: "daily", end: "2026-12-01" }, zone);
			check({ in: "Pills daily starting Oct 12", title: "Pills", rec: "daily", s: "2026-10-12" }, zone);
		});
		// "Daily standup" keeps its title and its date.
		check({ in: "Daily standup tomorrow", title: "Daily standup", s: "2026-10-08" }, "America/New_York");
	});
});

describe("2. Time", () => {
	it.each([
		{ in: "Gym every monday at 9am", title: "Gym", rec: "weekly:MO@09:00" },
		{ in: "Gym every monday at 7:30pm", title: "Gym", rec: "weekly:MO@19:30" },
		{ in: "Gym every day at noon", title: "Gym", rec: "daily@12:00" },
		{ in: "Gym every day at 17:00", title: "Gym", rec: "daily@17:00" },
		{ in: "Pay monthly on the 1st at 9am", title: "Pay", rec: "monthly:d1@09:00" },
		{ in: "Gym mondays at 6pm", title: "Gym", rec: "weekly:MO@18:00" },
	])("#12: $in", (row) => checkRow(row));

	it("#12: an unclear hour is a choice; nothing applies until it is chosen, and saving waits for it", () => {
		inZones((zone) => {
			const r = parseAt("Gym every day at 7", zone);
			expect(briefChips(r), zone).toEqual(["recurrence|choice|every day at 7"]);
			expect(r.chips[0]!.alternatives!.map((a) => a.label), zone).toEqual(["07:00", "19:00"]);
			expect(r.fields.recurrence, zone).toBeUndefined();
			expect(r.blocking, zone).toEqual([r.chips[0]!.id]);
		});
	});

	it("#12: a repeat picked by hand wins: the typed hour's choice is a replacement and never blocks saving", () => {
		inZones((zone) => {
			const r = parseAt("Gym every day at 7", zone, { manual: ["recurrence"] });
			expect(r.chips[0], zone).toMatchObject({ kind: "recurrence", status: "choice", notice: "Replace repeat?" });
			expect(r.blocking, zone).toEqual([]);
		});
	});
});

describe("3. Start", () => {
	it.each<Row>([
		{ in: "Gym every Monday starting next week", title: "Gym", rec: "weekly:MO", s: "2026-10-14" },
		{ in: "Gym every day starting on Oct 10", title: "Gym", rec: "daily", s: "2026-10-10" },
		// A weekly repeat with picked weekdays starts on its first such weekday on or after its start (today, or the
		// typed date): `every 2 weeks on Monday` typed on a Wednesday first falls on the coming Monday.
		{ in: "Pay the bank every 2 weeks on Monday", title: "Pay the bank", rec: "weekly/2:MO", first: "2026-10-12" },
		{ in: "Pay the bank every other monday", title: "Pay the bank", rec: "weekly/2:MO", first: "2026-10-12" },
		{ in: "Pay the bank every 2 weeks monday", title: "Pay the bank", rec: "weekly/2:MO", first: "2026-10-12" },
		{ in: "Cleaners every other week on friday", title: "Cleaners", rec: "weekly/2:FR", first: "2026-10-09" },
		{ in: "Review every 2 weeks on tue, thu", title: "Review", rec: "weekly/2:TU,TH", first: "2026-10-08" },
		{ in: "Gym every 3 weeks on mon-wed", title: "Gym", rec: "weekly/3:MO,TU,WE", first: "2026-10-07" },
		{ in: "Gym every monday", title: "Gym", rec: "weekly:MO", first: "2026-10-12" },
		{ in: "Gym every week on monday", title: "Gym", rec: "weekly:MO", first: "2026-10-12" },
		{ in: "Pay the bank every 2 weeks on Monday starting Oct 14", title: "Pay the bank", rec: "weekly/2:MO", s: "2026-10-14", first: "2026-10-19" },
	])("#12: $in", (row) => checkRow(row));

	it("#12: starting, from, beginning, on and a bare date after the form", () => {
		inZones((zone) => {
			for (const locale of LOCALES) {
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
			}
		});
	});
});

describe("4. End", () => {
	it.each<Row>([
		{ in: "Pills every day until Dec 1", title: "Pills", rec: "daily", end: "2026-12-01", chips: ["applied|recurrence|every day|r=daily", "applied|repeatEnd|until Dec 1"] },
		{ in: "Pills every day for 5 times", title: "Pills", rec: "daily", end: "5x", chips: ["applied|recurrence|every day|r=daily", "applied|repeatEnd|for 5 times"] },
		// A count needs `for`: a bare "5 times" is title text, as "3 times a day" is.
		{ in: "Pills every day 5 times", title: "Pills 5 times", rec: "daily" },
		{ in: "Gym every monday at 7am for 1 time", title: "Gym", rec: "weekly:MO@07:00", end: "1x" },
		{ in: "Pills every day for 5 days", title: "Pills", rec: "daily", end: "2026-10-11" },
		// N periods after the start: the day before the Nth period from the start
		{ in: "Gym every day for 2 weeks", title: "Gym", rec: "daily", end: "2026-10-20" },
		{ in: "Gym every Monday for 3 weeks", title: "Gym", rec: "weekly:MO", end: "2026-10-27" },
		{ in: "Pay every month for 6 months", title: "Pay", rec: "monthly", end: "2027-04-06" },
		{ in: "Pay every year for 2 years", title: "Pay", rec: "yearly", end: "2028-10-06" },
		{ in: "Gym every monday for 3 mondays", title: "Gym", rec: "weekly:MO", end: "2026-10-27" },
		{ in: "Gym every day for 10 days starting Oct 10", title: "Gym", rec: "daily", s: "2026-10-10", end: "2026-10-19" },
		{ in: "Pills every day until friday", title: "Pills", rec: "daily", end: "2026-10-09" },
		// Said on a Friday, `until friday` is next Friday, not today.
		{ in: "Pills every day until friday", local: "2026-10-09T10:00", title: "Pills", rec: "daily", end: "2026-10-16" },
		{ in: "Gym every Monday until Nov 30 starting Oct 12", title: "Gym", rec: "weekly:MO", s: "2026-10-12", end: "2026-11-30" },
		// elsewhere `for` stays a duration
		{ in: "Gym every day for 45m", title: "Gym", rec: "daily" },
		// An end must name a day: a month alone is no end, and stays the uncertain date it is.
		{ in: "Pills every day until march", title: "Pills until march", rec: "daily", brief: ["recurrence|applied|every day", "scheduled|suggestion|until march"] },
		// An end right after the first weekday is valid, as the series starts there.
		{ in: "Pay the bank every 2 weeks on Monday until Oct 14", title: "Pay the bank", rec: "weekly/2:MO", end: "2026-10-14" },
		{ in: "Pay the bank every 2 weeks on Monday until Oct 11", title: "Pay the bank until Oct 11", rec: "weekly/2:MO", blocking: ["repeatEnd"], dates: ["repeatEnd|invalid|until Oct 11"] },
		// An end that leaves no date, or comes before the first date, blocks saving.
		{ in: "Gym every friday until Oct 8", title: "Gym until Oct 8", rec: "weekly:FR", blocking: ["repeatEnd"], chips: ["applied|recurrence|every friday|r=weekly:FR", `invalid|repeatEnd|until Oct 8|n=${ENDS_BEFORE}`] },
		{ in: "Pills every day for 0 times", title: "Pills for 0 times", rec: "daily", blocking: ["repeatEnd"], chips: ["applied|recurrence|every day|r=daily", "invalid|repeatEnd|for 0 times|n=End after 1 to 999 times."] },
		{ in: "Read daily for 1000 times", title: "Read for 1000 times", rec: "daily", blocking: ["repeatEnd"], chips: ["applied|recurrence|daily|r=daily", "invalid|repeatEnd|for 1000 times|n=End after 1 to 999 times."] },
		{ in: "Birthday every year on Feb 29 ending Feb 28 2028", title: "Birthday ending Feb 28 2028", rec: "yearly", s: "2028-02-29", blocking: ["repeatEnd"], chips: ["applied|recurrence|every year on|r=yearly", "applied|scheduled|Feb 29", `invalid|repeatEnd|ending Feb 28 2028|n=${ENDS_BEFORE}`] },
		// `for N <periods>` anywhere after a repeat is its end, never part of a date; without a repeat nothing changes.
		{ in: "Gym every day starting Friday for 2 weeks", title: "Gym", rec: "daily", s: "2026-10-09", end: "2026-10-22" },
		{ in: "Gym every day for 2 weeks starting Friday", title: "Gym", rec: "daily", s: "2026-10-09", end: "2026-10-22" },
		{ in: "Gym every day from Friday for 2 weeks", title: "Gym", rec: "daily", s: "2026-10-09", end: "2026-10-22" },
		{ in: "Travel for 2 weeks", title: "Travel for 2 weeks", brief: [] },
		{ in: "Do it for 5 times", title: "Do it for 5 times", brief: [] },
		{ in: "Wait for 2 days", title: "Wait for 2 days", brief: [] },
		// `for N …` before the repeat stays title text, and is never read as a date.
		{ in: "Plan meals for 7 days every sunday", title: "Plan meals for 7 days", rec: "weekly:SU", brief: ["recurrence|applied|every sunday"] },
		{ in: "Plan meals for 7 days every sunday.", title: "Plan meals for 7 days", rec: "weekly:SU", brief: ["recurrence|applied|every sunday"] },
		{ in: "Pack for 3 days trip every friday", title: "Pack for 3 days trip", rec: "weekly:FR", brief: ["recurrence|applied|every friday"] },
		{ in: "Pack for 3 days daily", title: "Pack for 3 days", rec: "daily", brief: ["recurrence|applied|daily"] },
		// An end after the typed start date takes its comma and leaves the date text alone.
		{ in: "Taxes every year on April 15, for 3 times", title: "Taxes", rec: "yearly", s: "2027-04-15", end: "3x", brief: ["recurrence|applied|every year on", "scheduled|applied|April 15", "repeatEnd|applied|, for 3 times"] },
		{ in: "Taxes every year on April 15 for 5 years", title: "Taxes", rec: "yearly", s: "2027-04-15", end: "2032-04-14", brief: ["recurrence|applied|every year on", "scheduled|applied|April 15", "repeatEnd|applied|for 5 years"] },
		// The end typed before the start gives both; a yearless end before the typed start is the next such date after it.
		{ in: "Gym every day until Dec 1 starting Oct 12", title: "Gym", rec: "daily", s: "2026-10-12", end: "2026-12-01" },
		{ in: "Gym every day until Oct 1 starting Oct 12", title: "Gym", rec: "daily", s: "2026-10-12", end: "2027-10-01" },
		{ in: "Gym every day starting Oct 12 until Oct 1", title: "Gym", rec: "daily", s: "2026-10-12", end: "2027-10-01" },
		{ in: "Pills every day until Dec 1 starting Dec 10", title: "Pills", rec: "daily", s: "2026-12-10", end: "2027-12-01", chips: ["applied|recurrence|every day|r=daily", "applied|repeatEnd|until Dec 1", "applied|scheduled|starting Dec 10"] },
		// `until` after a comma agrees with the merged range: the end is the next such date after the start.
		{ in: "Birthday every year on May 5 until Dec 1", title: "Birthday", rec: "yearly", s: "2027-05-05", end: "2027-12-01" },
		{ in: "Birthday every year on May 5, until Dec 1", title: "Birthday", rec: "yearly", s: "2027-05-05", end: "2027-12-01" },
		// An end with its own year, or naming its own day, stays where it is: invalid before the start.
		{ in: "Birthday every year on May 5, until Dec 1 2026", title: "Birthday until Dec 1 2026", rec: "yearly", s: "2027-05-05", blocking: ["repeatEnd"], dates: ["scheduled|applied|May 5", "repeatEnd|invalid|until Dec 1 2026"] },
		{ in: "Pills every day until Oct 1 2027 starting Oct 3", title: "Pills until Oct 1 2027", rec: "daily", s: "2027-10-03", blocking: ["repeatEnd"], dates: ["repeatEnd|invalid|until Oct 1 2027", "scheduled|applied|starting Oct 3"] },
		// `for N …` counts from the start the model has (a date picked by hand or a preset); a typed date wins over it,
		// as it does on save, and only a typed start moves a yearless end.
		{ in: "Stretch daily for 2 weeks", startDate: "2026-10-20", title: "Stretch", rec: "daily", end: "2026-11-02" },
		{ in: "Stretch daily until Oct 15", startDate: "2026-10-20", title: "Stretch until Oct 15", rec: "daily", blocking: ["repeatEnd"], chips: ["applied|recurrence|daily|r=daily", `invalid|repeatEnd|until Oct 15|n=${ENDS_BEFORE}`] },
		{ in: "Stretch daily for 2 weeks starting Oct 10", startDate: "2026-10-20", title: "Stretch", rec: "daily", s: "2026-10-10", end: "2026-10-23" },
		// A repeat picked by hand: `until <date>` is its end, not a deadline, checked against that repeat; under a picked
		// repeat with no rule handed in, the typed one is a replacement; `for N …` never ends it and stays text.
		{ in: "Gym until Oct 8", pickedRule: FRIDAYS, title: "Gym until Oct 8", blocking: ["repeatEnd"], chips: [`invalid|repeatEnd|until Oct 8|n=${ENDS_BEFORE}`] },
		{ in: "Gym until Oct 9", pickedRule: FRIDAYS, title: "Gym", end: "2026-10-09", brief: ["repeatEnd|applied|until Oct 9"] },
		{ in: "Pills until Dec 1", manual: ["recurrence"], title: "Pills", end: "2026-12-01" },
		{ in: "Pills every day until Dec 1", manual: ["recurrence"], title: "Pills every day until Dec 1", chips: ["suggestion|recurrence|every day|r=daily|n=Replace repeat?", "suggestion|repeatEnd|until Dec 1|n=Replace repeat?"] },
		{ in: "Daily standup for 2 weeks", manual: ["recurrence"], title: "Daily standup for 2 weeks", brief: [] },
	])("#12: $in", (row) => checkRow(row));

	it("#12: until, till, ending, ending on, ends on", () => {
		inZones((zone) => {
			for (const locale of LOCALES) {
				const dec1 = spelt(locale, "Dec", 1);
				for (const lead of ["until", "till", "ending", "ending on", "ends on"]) {
					check({ in: `Pills every day ${lead} ${dec1}`, title: "Pills", rec: "daily", end: "2026-12-01" }, zone, locale);
				}
			}
		});
	});

	it("#12: a first and a last date", () => {
		inZones((zone) => {
			for (const locale of LOCALES) {
				const oct12 = spelt(locale, "Oct", 12);
				const dec1 = spelt(locale, "Dec", 1);
				const both: Row = { in: "", title: "Gym", rec: "daily", s: "2026-10-12", end: "2026-12-01" };
				for (const range of [`from ${oct12} until ${dec1}`, `from ${oct12} to ${dec1}`, `starting ${oct12} until ${dec1}`, `starting ${oct12} to ${dec1}`, `starting ${oct12} ending ${dec1}`, `${oct12} to ${dec1}`]) {
					check({ ...both, in: `Gym every day ${range}` }, zone, locale);
				}
				// Two bare weekdays: neither a start and end nor the repeat's days, unless `starting` or `beginning` leads them.
				for (const input of ["Gym every day Mon-Fri", "Gym daily Mon-Fri", "Gym every day from Monday to Friday"]) {
					const r = parseAt(input, zone, { locale });
					expect(recOf(r), input).toBe("daily");
					expect([r.fields.scheduled, r.fields.recurrenceEnd], input).toEqual([undefined, undefined]);
					expect(chipOf(r, "scheduled")?.status, input).toBe("suggestion");
				}
				check({ in: "Gym every day starting Monday until Friday", title: "Gym", rec: "daily", s: "2026-10-12", end: "2026-10-16" }, zone, locale);
				check({ in: "Gym every day starting monday ending friday", title: "Gym", rec: "daily", s: "2026-10-12", end: "2026-10-16" }, zone, locale);
				check({ in: "Gym every day beginning Monday to Friday", title: "Gym", rec: "daily", s: "2026-10-12", end: "2026-10-16" }, zone, locale);
			}
		});
	});

	it("#12: start and end parts come in any order after the form and its time", () => {
		inZones((zone) => {
			check({ in: "Gym every day at 7am until Dec 1 starting Oct 12", title: "Gym", rec: "daily@07:00", s: "2026-10-12", end: "2026-12-01" }, zone);
			check({ in: "Gym every day starting Oct 12 at 7am", title: "Gym", rec: "daily", s: "2026-10-12T07:00" }, zone);
		});
	});

	it("#12: an end must be a date: `until <time>` after a repeat is a visible suggestion, never applied", () => {
		inZones((zone) => {
			for (const [input, rec] of [
				["Pills every day until 5pm", "daily"],
				["Gym every monday until 5pm", "weekly:MO"],
			] as const) {
				check({ in: input, title: input.replace(/ every \w+/u, ""), rec }, zone);
				const r = parseAt(input, zone);
				expect(chipOf(r, "scheduled"), `${input} ${zone}`).toMatchObject({ status: "suggestion", text: "until 5pm", notice: "Use as date?" });
			}
			const choice = parseAt("Gym every day until 5", zone);
			expect(choice.fields.recurrenceEnd, zone).toBeUndefined();
			expect(briefChips(choice), zone).toEqual(["recurrence|applied|every day"]);
			expect(choice.title, zone).toBe("Gym until 5");
		});
	});

	it("#12: an end that rolls more than a year past the start is a suggestion", () => {
		inZones((zone) => {
			const r = parseAt("Gym every day starting Mar 1 until Feb 29", zone, { local: "2028-02-29T10:00" });
			expect(scheduledOf(r), zone).toBe("2028-03-01");
			expect(r.fields.recurrenceEnd, zone).toBeUndefined();
			expect(chipOf(r, "repeatEnd"), zone).toMatchObject({ status: "suggestion", notice: "Use as end date?", end: { kind: "date", date: "2032-02-29" } });
		});
	});
});

describe("4b. Date ranges", () => {
	// Under a typed repeat, a date range (`starting Oct 12 to Dec 1`, `from … till …`, or the range right after the
	// repeat) is the repeat's start and end, when both sides name a day. The start keeps its own year; an end without a
	// year before the start moves forward as chrono's own range does (a weekday by a week, a month and day by a year).
	it.each<Row>([
		{ in: "Gym every day starting Oct 12 to Dec 1", title: "Gym", rec: "daily", s: "2026-10-12", end: "2026-12-01", dates: ["scheduled|applied|starting Oct 12", "repeatEnd|applied|to Dec 1"] },
		{ in: "Gym every day starting Oct 12 until Dec 1", title: "Gym", rec: "daily", s: "2026-10-12", end: "2026-12-01", dates: ["scheduled|applied|starting Oct 12", "repeatEnd|applied|until Dec 1"] },
		{ in: "Gym every day from Oct 12 till Dec 1", title: "Gym", rec: "daily", s: "2026-10-12", end: "2026-12-01", dates: ["scheduled|applied|from Oct 12", "repeatEnd|applied|till Dec 1"] },
		{ in: "Gym every day Oct 12 to Dec 1", title: "Gym", rec: "daily", s: "2026-10-12", end: "2026-12-01", dates: ["scheduled|applied|Oct 12", "repeatEnd|applied|to Dec 1"] },
		{ in: "Gym every day starting Oct 12 through Dec 1", title: "Gym", rec: "daily", s: "2026-10-12", end: "2026-12-01", dates: ["scheduled|applied|starting Oct 12", "repeatEnd|applied|through Dec 1"] },
		{ in: "Gym every day starting Oct 12 - Dec 1", title: "Gym", rec: "daily", s: "2026-10-12", end: "2026-12-01", dates: ["scheduled|applied|starting Oct 12", "repeatEnd|applied|- Dec 1"] },
		{ in: "Gym every Monday starting Oct 12 till Dec 1", title: "Gym", rec: "weekly:MO", s: "2026-10-12", end: "2026-12-01", dates: ["scheduled|applied|starting Oct 12", "repeatEnd|applied|till Dec 1"] },
		{ in: "Standup every weekday starting Monday until Friday", title: "Standup", rec: WEEKDAYS, s: "2026-10-12", end: "2026-10-16", dates: ["scheduled|applied|starting Monday", "repeatEnd|applied|until Friday"] },
		{ in: "Standup every day starting Monday until Friday", title: "Standup", rec: "daily", s: "2026-10-12", end: "2026-10-16", dates: ["scheduled|applied|starting Monday", "repeatEnd|applied|until Friday"] },
		{ in: "Taxes every year starting April 15 until Apr 16 2030", title: "Taxes", rec: "yearly", s: "2027-04-15", end: "2030-04-16", dates: ["scheduled|applied|starting April 15", "repeatEnd|applied|until Apr 16 2030"] },
		{ in: "Taxes every year on April 15 until Apr 16 2030", title: "Taxes", rec: "yearly", s: "2027-04-15", end: "2030-04-16", dates: ["scheduled|applied|April 15", "repeatEnd|applied|until Apr 16 2030"] },
		{ in: "Gym every day from 12/10 to 1/12", locale: "en-GB", title: "Gym", rec: "daily", s: "2026-10-12", end: "2026-12-01", dates: ["scheduled|applied|from 12/10", "repeatEnd|applied|to 1/12"] },
		{ in: "Gym every day starting 12 Oct until 1 Dec", locale: "en-GB", title: "Gym", rec: "daily", s: "2026-10-12", end: "2026-12-01", dates: ["scheduled|applied|starting 12 Oct", "repeatEnd|applied|until 1 Dec"] },
		// An end without a year before the start moves forward a year; the start keeps its own date.
		{ in: "Gym every day starting Dec 20 to Jan 5", title: "Gym", rec: "daily", s: "2026-12-20", end: "2027-01-05", dates: ["scheduled|applied|starting Dec 20", "repeatEnd|applied|to Jan 5"] },
		{ in: "Gym every day starting Oct 12 to Oct 1", title: "Gym", rec: "daily", s: "2026-10-12", end: "2027-10-01", dates: ["scheduled|applied|starting Oct 12", "repeatEnd|applied|to Oct 1"] },
		// A start with its own year keeps it; the end without one moves to the first such date on or after the start.
		{ in: "Gym every day starting Oct 12 2027 to Dec 1", title: "Gym", rec: "daily", s: "2027-10-12", end: "2027-12-01", dates: ["scheduled|applied|starting Oct 12 2027", "repeatEnd|applied|to Dec 1"] },
		// A start with its own year in the past: the end counts from the start, not from today.
		{ in: "Gym every day starting Sep 28 2026 to Oct 3", title: "Gym", rec: "daily", s: "2026-09-28", end: "2026-10-03", dates: ["scheduled|applied|starting Sep 28 2026", "repeatEnd|applied|to Oct 3"] },
		// A weekday end said on that weekday, after the start: the first one on or after the start, never a choice.
		{ in: "Gym every day starting Monday until Wednesday", title: "Gym", rec: "daily", s: "2026-10-12", end: "2026-10-14", dates: ["scheduled|applied|starting Monday", "repeatEnd|applied|until Wednesday"] },
		{ in: "Rent every month on the 15th from Nov 15 to Mar 15", title: "Rent", rec: "monthly:d15", s: "2026-11-15", end: "2027-03-15", dates: ["scheduled|applied|from Nov 15", "repeatEnd|applied|to Mar 15"] },
		// A date range after a comma is not more repeat words: the repeat keeps its form.
		{ in: "Pills every day, Oct 12 to Dec 1", title: "Pills", rec: "daily", s: "2026-10-12", end: "2026-12-01", brief: ["recurrence|applied|every day", "scheduled|applied|Oct 12", "repeatEnd|applied|to Dec 1"] },
		{ in: "Pills every day, 12 Oct - 1 Dec", title: "Pills", rec: "daily", s: "2026-10-12", end: "2026-12-01", brief: ["recurrence|applied|every day", "scheduled|applied|12 Oct", "repeatEnd|applied|- 1 Dec"] },
		// An end with its own year before the start, or naming its own day before it, is invalid and blocks saving.
		{ in: "Gym every day starting Oct 12 2026 to Oct 1 2026", title: "Gym to Oct 1 2026", rec: "daily", s: "2026-10-12", blocking: ["repeatEnd"], chips: ["applied|recurrence|every day|r=daily", "applied|scheduled|starting Oct 12 2026", `invalid|repeatEnd|to Oct 1 2026|n=${ENDS_BEFORE}`] },
		{ in: "Gym every day starting Oct 20 until this friday", title: "Gym until this friday", rec: "daily", s: "2026-10-20", blocking: ["repeatEnd"], chips: ["applied|recurrence|every day|r=daily", "applied|scheduled|starting Oct 20", `invalid|repeatEnd|until this friday|n=${ENDS_BEFORE}`] },
		{ in: "Gym every day starting Oct 20 until tomorrow", title: "Gym until tomorrow", rec: "daily", s: "2026-10-20", blocking: ["repeatEnd"], chips: ["applied|recurrence|every day|r=daily", "applied|scheduled|starting Oct 20", `invalid|repeatEnd|until tomorrow|n=${ENDS_BEFORE}`] },
		// A start said on its weekday stays the today-or-next-week choice; the end counts from today.
		{ in: "Gym every day starting Wednesday until Friday", title: "Gym starting Wednesday", rec: "daily", end: "2026-10-09", brief: ["recurrence|applied|every day", "scheduled|choice|starting Wednesday", "repeatEnd|applied|until Friday"] },
		// A start with its own year whose hour is a choice: the end counts from that date, not today.
		{ in: "Gym every day starting Sep 28 2026 at 5 to Oct 3", title: "Gym starting Sep 28 2026 at 5", rec: "daily", end: "2026-10-03", brief: ["recurrence|applied|every day", "scheduled|choice|starting Sep 28 2026 at 5", "repeatEnd|applied|to Oct 3"] },
		{ in: "Gym every day starting 2026-10-01 at 5 until Oct 5", title: "Gym starting 2026-10-01 at 5", rec: "daily", end: "2026-10-05", brief: ["recurrence|applied|every day", "scheduled|choice|starting 2026-10-01 at 5", "repeatEnd|applied|until Oct 5"] },
		{ in: "Gym every day starting Oct 1 2026 at 12 until Oct 5", title: "Gym starting Oct 1 2026 at 12", rec: "daily", end: "2026-10-05", brief: ["recurrence|applied|every day", "scheduled|choice|starting Oct 1 2026 at 12", "repeatEnd|applied|until Oct 5"] },
		// A range that is not right after the repeat and has no start word stays one suggestion.
		{ in: "Gym every day with Ann Oct 12 to Dec 1", title: "Gym with Ann Oct 12 to Dec 1", rec: "daily", brief: ["recurrence|applied|every day", "scheduled|suggestion|Oct 12 to Dec 1"] },
		// A repeat picked by hand never splits a range: it stays one suggestion.
		{ in: "Gym starting Oct 12 to Dec 1", pickedRule: DAILY, title: "Gym starting Oct 12 to Dec 1", brief: ["scheduled|suggestion|starting Oct 12 to Dec 1"] },
		// A repeat's time that is a choice keeps its form before two weekdays.
		{ in: "Gym every day at 7 Mon-Fri", title: "Gym every day at 7 Mon-Fri", blocking: ["recurrence"], brief: ["recurrence|choice|every day at 7", "scheduled|suggestion|Mon-Fri"] },
	])("#12: $in", (row) => checkRow(row));

	// Two bare weekdays joined as a range after a repeat form that is complete name the days of the week, not a start and
	// an end: they stay the one visible suggestion they always were, unless `starting` or `beginning` leads them. The
	// first weekday of the range is not one more repeat word: the repeat keeps its form.
	it.each<Row>([
		{ in: "Standup every week from Monday to Friday", title: "Standup from Monday to Friday", rec: "weekly", brief: ["recurrence|applied|every week", "scheduled|suggestion|from Monday to Friday"] },
		{ in: "Run every week from Mon to Fri at 7am", title: "Run from Mon to Fri at 7am", rec: "weekly", brief: ["recurrence|applied|every week", "scheduled|suggestion|from Mon to Fri at 7am"] },
		{ in: "Gym daily Mon-Fri", title: "Gym Mon-Fri", rec: "daily", brief: ["recurrence|applied|daily", "scheduled|suggestion|Mon-Fri"] },
		{ in: "Gym daily Mon to Fri", title: "Gym Mon to Fri", rec: "daily", brief: ["recurrence|applied|daily", "scheduled|suggestion|Mon to Fri"] },
		{ in: "Shop every weekday from Monday to Friday", title: "Shop from Monday to Friday", rec: WEEKDAYS, brief: ["recurrence|applied|every weekday", "scheduled|suggestion|from Monday to Friday"] },
		{ in: "Gym every day Mon-Fri", title: "Gym Mon-Fri", rec: "daily", brief: ["recurrence|applied|every day", "scheduled|suggestion|Mon-Fri"] },
		{ in: "Gym every day Mon–Fri", title: "Gym Mon–Fri", rec: "daily", brief: ["recurrence|applied|every day", "scheduled|suggestion|Mon–Fri"] },
		{ in: "Gym every day Monday to Friday", title: "Gym Monday to Friday", rec: "daily", brief: ["recurrence|applied|every day", "scheduled|suggestion|Monday to Friday"] },
		{ in: "Gym every day mon until fri", title: "Gym mon until fri", rec: "daily", brief: ["recurrence|applied|every day", "scheduled|suggestion|mon until fri"] },
		{ in: "Gym every month Mon-Fri", title: "Gym Mon-Fri", rec: "monthly", brief: ["recurrence|applied|every month", "scheduled|suggestion|Mon-Fri"] },
		{ in: "Gym every weekday Mon-Fri", title: "Gym Mon-Fri", rec: WEEKDAYS, brief: ["recurrence|applied|every weekday", "scheduled|suggestion|Mon-Fri"] },
		{ in: "Gym every monday Mon-Fri", title: "Gym Mon-Fri", rec: "weekly:MO", brief: ["recurrence|applied|every monday", "scheduled|suggestion|Mon-Fri"] },
	].map((row) => ({ ...row, locale: "any" as const })))("#12: $in stays one suggestion", (row) => checkRow(row));

	// Inputs the range rule never reads: no typed repeat, or a side that is only a time. Without a typed repeat a date
	// range, joined by to, through, -, until or till, stays ONE visible suggestion and nothing is applied silently (no
	// start, no end, no deadline from it); its text stays in the title.
	it.each<Row>([
		{ in: "Meeting tomorrow until 5pm", title: "Meeting tomorrow until 5pm", dates: ["scheduled|suggestion|tomorrow until 5pm"] },
		{ in: "Party Friday until midnight", title: "Party Friday until midnight", dates: ["scheduled|suggestion|Friday until midnight"] },
		{ in: "Meeting Oct 12 until noon", title: "Meeting Oct 12 until noon", dates: ["scheduled|suggestion|Oct 12 until noon"] },
		{ in: "Meeting 12 Oct until 5pm", locale: "en-GB", title: "Meeting 12 Oct until 5pm", dates: ["scheduled|suggestion|12 Oct until 5pm"] },
		{ in: "Trip Oct 12 till Dec 1", title: "Trip Oct 12 till Dec 1", dates: ["scheduled|suggestion|Oct 12 till Dec 1"] },
		{ in: "Trip tomorrow till Friday", title: "Trip tomorrow till Friday", dates: ["scheduled|suggestion|tomorrow till Friday"] },
		{ in: "Trip Monday until Friday", title: "Trip Monday until Friday", dates: ["scheduled|suggestion|Monday until Friday"] },
		{ in: "Trip 20/10 until 12/10", locale: "en-GB", title: "Trip 20/10 until 12/10", dates: ["scheduled|suggestion|20/10 until 12/10"] },
		{ in: "Trip Oct 12 until Oct 20", title: "Trip Oct 12 until Oct 20", dates: ["scheduled|suggestion|Oct 12 until Oct 20"] },
		{ in: "Trip Oct 12 to Oct 20", title: "Trip Oct 12 to Oct 20", dates: ["scheduled|suggestion|Oct 12 to Oct 20"] },
		{ in: "Trip Oct 12 through Oct 20", title: "Trip Oct 12 through Oct 20", dates: ["scheduled|suggestion|Oct 12 through Oct 20"] },
		{ in: "Trip Oct 12 - Oct 20", title: "Trip Oct 12 - Oct 20", dates: ["scheduled|suggestion|Oct 12 - Oct 20"] },
		{ in: "Trip from Oct 12 to Oct 20", title: "Trip from Oct 12 to Oct 20", dates: ["scheduled|suggestion|Oct 12 to Oct 20"] },
		{ in: "Work from 9 until 5", title: "Work from 9 until 5", dates: ["scheduled|suggestion|from 9 until 5"] },
		{ in: "Call 2pm until 3pm", title: "Call 2pm until 3pm", dates: ["scheduled|suggestion|2pm until 3pm"] },
		{ in: "Daily standup from Oct 12 to Dec 1", title: "Daily standup from Oct 12 to Dec 1", dates: ["scheduled|suggestion|Oct 12 to Dec 1"] },
		// A time alone is never an end: after a repeat, `until <time>` is a visible suggestion, never applied.
		{ in: "Gym every day at 9 until 5pm", title: "Gym every day at 9 until 5pm", blocking: ["recurrence"], dates: ["scheduled|suggestion|until 5pm"] },
		{ in: "Gym every day starting Oct 12 until 5pm", title: "Gym starting Oct 12 until 5pm", rec: "daily", dates: ["scheduled|suggestion|starting Oct 12 until 5pm"] },
		{ in: "Gym every day starting Oct 12 to 15", title: "Gym starting Oct 12 to 15", rec: "daily", dates: ["scheduled|suggestion|starting Oct 12 to 15"] },
		{ in: "Gym every day from Oct 12", title: "Gym", rec: "daily", s: "2026-10-12", dates: ["scheduled|applied|from Oct 12"] },
	])("#12: $in is left as it is", (row) => checkRow(row));

	// A range whose end is only a time suggests its start as that start reads typed alone: the date library dates such an
	// end today and moves a later start back a week to keep the range in order, or reads a day of the month as an hour.
	it.each<{ in: string; text: string; value: string }>([
		{ in: "Party Friday until midnight", text: "Friday until midnight", value: "2026-10-09" },
		{ in: "Party Friday till midnight", text: "Friday till midnight", value: "2026-10-09" },
		{ in: "Party Friday to midnight", text: "Friday to midnight", value: "2026-10-09" },
		{ in: "Party Friday 8pm until midnight", text: "Friday 8pm until midnight", value: "2026-10-09T20:00" },
		{ in: "Meeting Tuesday until noon", text: "Tuesday until noon", value: "2026-10-13" },
		{ in: "Meeting this Friday until noon", text: "this Friday until noon", value: "2026-10-09" },
		{ in: "Meeting next Friday until noon", text: "next Friday until noon", value: "2026-10-16" },
		{ in: "Meeting last Friday until noon", text: "last Friday until noon", value: "2026-10-02" },
		{ in: "Meeting Oct 9 until 9am", text: "Oct 9 until 9am", value: "2026-10-09" },
		{ in: "Meeting Dec 1 until 5pm", text: "Dec 1 until 5pm", value: "2026-12-01" },
		{ in: "Meeting tomorrow until 5pm", text: "tomorrow until 5pm", value: "2026-10-08" },
		{ in: "Meeting today until 5pm", text: "today until 5pm", value: "2026-10-07" },
		{ in: "Meeting in 3 days until noon", text: "in 3 days until noon", value: "2026-10-10" },
		{ in: "Meeting Oct 12 until noon", text: "Oct 12 until noon", value: "2026-10-12" },
		{ in: "Meeting Friday 3pm-5pm", text: "Friday 3pm-5pm", value: "2026-10-09T15:00" },
		{ in: "Meeting Friday 3-5pm", text: "Friday 3-5pm", value: "2026-10-09T15:00" },
		{ in: "Meeting Friday from 3pm to 5pm", text: "Friday from 3pm to 5pm", value: "2026-10-09T15:00" },
		{ in: "Meeting Saturday 10am-2pm", text: "Saturday 10am-2pm", value: "2026-10-10T10:00" },
	])("$in suggests its start as typed alone", (row) => {
		inZones((zone) => {
			const r = parseAt(row.in, zone);
			const because = `${JSON.stringify(row.in)} ${zone}: ${briefChips(r).join(" ; ")}`;
			const dates = r.chips.filter((c) => DATE_KINDS.includes(c.kind));
			expect(dates.map((c) => `${c.status}|${c.text}`), because).toEqual([`suggestion|${row.text}`]);
			expect(dates[0]!.date, because).toEqual(dateSpecOf(row.value, zone));
			expect(r.title, because).toBe(row.in);
			expect(r.fields.scheduled, because).toBeUndefined();
		});
	});
});

describe("5. Not supported", () => {
	it.each<Row>([
		{ in: "Call every 3 hours", title: "Call every 3 hours", chips: [`unsupported|recurrence|every 3 hours|n=${NOTICE}`] },
		{ in: "Pills every 8 hours", title: "Pills every 8 hours", chips: [`unsupported|recurrence|every 8 hours|n=${NOTICE}`] },
		{ in: "Stretch every 30 minutes", title: "Stretch every 30 minutes", chips: [`unsupported|recurrence|every 30 minutes|n=${NOTICE}`] },
		{ in: "Gym every 2nd and 4th Tuesday", title: "Gym every 2nd and 4th Tuesday", chips: [`unsupported|recurrence|every 2nd and 4th Tuesday|n=${NOTICE}`] },
		{ in: "Rent every month on the 15th and 30th", title: "Rent every month on the 15th and 30th", chips: [`unsupported|recurrence|every month on the 15th and 30th|n=${NOTICE}`] },
		{ in: "Gym every 2nd day", title: "Gym every 2nd day", chips: [`unsupported|recurrence|every 2nd day|n=${NOTICE}`] },
		{ in: "Taxes every May", title: "Taxes every May", chips: [`unsupported|recurrence|every May|n=${NOTICE}`] },
		{ in: "Pay every 32nd", title: "Pay every 32nd", chips: [`unsupported|recurrence|every 32nd|n=${NOTICE}`] },
		{ in: "Gym every other 2nd tuesday", title: "Gym every other 2nd tuesday", chips: [`unsupported|recurrence|every other 2nd tuesday|n=${NOTICE}`] },
		// An end of an unsupported repeat is never a date.
		{ in: "Call every 3 hours until Friday", title: "Call every 3 hours until Friday", chips: [`unsupported|recurrence|every 3 hours|n=${NOTICE}`, `unsupported|repeatEnd|until Friday|n=${NOTICE}`] },
		// A range after it stays one chip that applies nothing, never a start and an end: led by a start word it is the
		// repeat's part, not supported with it; on its own it is the suggestion a range is.
		{ in: "Check server every 3 hours from Oct 12 to Oct 20", title: "Check server every 3 hours from Oct 12 to Oct 20", brief: ["recurrence|unsupported|every 3 hours", "scheduled|unsupported|from Oct 12 to Oct 20"] },
		{ in: "Standup every 2nd and 4th tuesday from Oct 12 to Dec 1", title: "Standup every 2nd and 4th tuesday from Oct 12 to Dec 1", brief: ["recurrence|unsupported|every 2nd and 4th tuesday", "scheduled|unsupported|from Oct 12 to Dec 1"] },
		{ in: "Call every 3 hours, Oct 12 to Oct 20", title: "Call every 3 hours, Oct 12 to Oct 20", brief: ["recurrence|unsupported|every 3 hours", "scheduled|suggestion|Oct 12 to Oct 20"] },
		// `every year on` followed by no readable date is not supported, never a repeat from today.
		{ in: "Bday every year on 45", title: "Bday every year on 45", brief: ["recurrence|unsupported|every year on"] },
		{ in: "Birthday every year on Feb 29 2027", title: "Birthday every year on Feb 29 2027", brief: ["recurrence|unsupported|every year on"] },
		{ in: "Birthday every year on Feb 30", title: "Birthday every year on Feb 30", brief: ["recurrence|unsupported|every year on"] },
	])("#12: $in", (row) => checkRow(row));

	it("#12: hourly or minute repeats", () => {
		inZones((zone) => {
			unsupported("Gym every 3 hours", zone);
			unsupported("Gym every 30 minutes", zone);
		});
	});

	it("#12: several times or several patterns", () => {
		inZones((zone) => {
			unsupported("Gym every monday at 9 and friday at 5", zone);
			unsupported("Gym every day and every week", zone);
			unsupported("Gym every day every week", zone, "every day");
			unsupported("Gym every day, every week", zone);
		});
	});

	it("#12: exceptions", () => {
		inZones((zone) => unsupported("Gym every day except sunday", zone));
	});

	it("#12: frequencies per period stay title text and are never an end", () => {
		inZones((zone) => {
			check({ in: "Pills every day 3 times a day", title: "Pills 3 times a day", rec: "daily" }, zone);
			check({ in: "Gym every week twice a week", title: "Gym twice a week", rec: "weekly" }, zone);
			check({ in: "Gym every week 2 times a week", title: "Gym 2 times a week", rec: "weekly" }, zone);
			check({ in: "Pay every month twice a month", title: "Pay twice a month", rec: "monthly" }, zone);
			check({ in: "Pills every day 3 times", title: "Pills 3 times", rec: "daily" }, zone);
			titleText("Drink water 3 times a day", zone);
			titleText("Gym twice a week", zone);
		});
	});

	it("#12: several days of the month", () => {
		inZones((zone) => unsupported("Pay every month on the 1st and 15th", zone, "every month on the 1st and 15th"));
	});

	it("#12: a fifth weekday", () => {
		inZones((zone) => {
			unsupported("Gym every 5th friday", zone);
			unsupported("Gym every fifth friday", zone);
		});
	});

	it("#12: biweekly and bimonthly stay title text", () => {
		inZones((zone) => {
			titleText("Gym biweekly", zone);
			titleText("Gym bimonthly", zone);
		});
	});

	it("#12: each monday and each day stay title text", () => {
		inZones((zone) => {
			titleText("Call each monday", zone);
			titleText("Call each day", zone);
		});
	});

	it("#12: a day part after a weekday stays text", () => {
		inZones((zone) => {
			const r = parseAt("Gym every sunday evening", zone);
			expect(recOf(r), zone).toBe("weekly:SU");
			expect(r.title, zone).toBe("Gym evening");
			expect(applied(r), zone).toEqual(["recurrence|every sunday"]);
		});
	});

	it("#12: a time without `at` is read on its own", () => {
		inZones((zone) => check({ in: "Gym every monday 9am", title: "Gym", rec: "weekly:MO", s: "2026-10-08T09:00" }, zone));
	});

	it("#12: the 1st of the month without each or every stays title text", () => {
		inZones((zone) => {
			check({ in: "Visit the 1st of the month market Saturday", title: "Visit the 1st of the month market", s: "2026-10-10" }, zone);
			check({ in: "Report the 2nd tuesday of the month", title: "Report the 2nd of the month", s: "2026-10-13" }, zone);
		});
	});

	it("#12: a date after a weekly form with `on` stays text: no start", () => {
		inZones((zone) => {
			for (const input of ["Gym every week on Oct 12", "Gym every 2 weeks on Oct 12", "Gym every monday on Oct 12", "Gym weekly on Oct 12"]) {
				const r = parseAt(input, zone);
				const because = `${input} ${zone}: ${briefChips(r).join(" ; ")}`;
				expect(r.fields.recurrence, because).toBeDefined();
				expect(r.fields.scheduled, because).toBeUndefined();
				expect(r.title, because).toBe(`Gym on Oct 12`);
			}
			check({ in: "Gym every week starting Oct 12", title: "Gym", rec: "weekly", s: "2026-10-12" }, zone);
		});
	});

	it("#12: start or end words before the repeat are not its parts: they read as without a repeat", () => {
		inZones((zone) => {
			check({ in: "Wait until Friday then call the bank every monday", title: "Wait then call the bank", rec: "weekly:MO", d: "2026-10-09" }, zone);
			check({ in: "Stay until Dec 1 and water plants every day", title: "Stay and water plants", rec: "daily", d: "2026-12-01" }, zone);
			check({ in: "Until Dec 1 take pills every day", title: "take pills", rec: "daily", d: "2026-12-01" }, zone);
			check({ in: "Starting Monday run every day", title: "Starting run", rec: "daily", s: "2026-10-12" }, zone);
			check({ in: "Trip ending Dec 1 then stretch daily", title: "Trip ending then stretch", s: "2026-12-01", rec: "daily" }, zone);
			check({ in: "Call from Oct 12 to Dec 1 then every monday", title: "Call from Oct 12 to Dec 1 then", rec: "weekly:MO" }, zone);
		});
	});

	it("#12: a start or end part after a repeat Quick Add cannot build applies nothing", () => {
		inZones((zone) => {
			unsupported("Take pills every 8 hours starting tomorrow", zone, "every 8 hours");
			unsupported("Take pills every 8 hours on Monday", zone, "every 8 hours");
			unsupported("Take pills every 8 hours from Oct 12 to Dec 1", zone, "every 8 hours");
			unsupported("Take pills every 8 hours until Friday", zone, "every 8 hours");
			unsupported("Take pills every 8 hours until 5pm", zone, "every 8 hours");
			unsupported("Gym every day every week starting Monday", zone, "every day");
			// A date right after it, with no lead word, applies nothing either: at most a visible suggestion.
			for (const input of ["Take pills every 8 hours tomorrow", "Take pills every 8 hours, Oct 12", "Take pills every 8 hours next week"]) {
				unsupported(input, zone, "every 8 hours");
				expect(chipOf(parseAt(input, zone), "scheduled")?.status, `${input} ${zone}`).toBe("suggestion");
			}
		});
	});

	it("#12: a date joined by and, & or a comma after a repeat Quick Add cannot build applies nothing", () => {
		inZones((zone) => {
			for (const [input, phrase] of [
				["Gym every May 5 and Dec 25", "every May 5"],
				["Gym every May 5, Dec 25", "every May 5"],
				["Gym every May 5 & Dec 25", "every May 5"],
				["Gym every May 5, and Dec 25", "every May 5"],
				["Take pills every 8 hours and tomorrow", "every 8 hours"],
				["Take pills every 8 hours & Oct 12", "every 8 hours"],
			] as const) {
				unsupported(input, zone, phrase);
				expect(chipOf(parseAt(input, zone), "scheduled")?.status, `${input} ${zone}`).toBe("suggestion");
			}
			// Title words between the repeat and the date: the date is read on its own, as without a repeat.
			const r = parseAt("Take pills every 8 hours and call the bank tomorrow", zone);
			expect(chipOf(r, "recurrence"), zone).toMatchObject({ status: "unsupported", notice: NOTICE });
			expect(r.fields.scheduled, zone).toEqual({ kind: "date", date: "2026-10-08" });
		});
	});

	it("#12: a repeat with two starts", () => {
		inZones((zone) => {
			for (const input of ["Bday every year on May 5 from Oct 12", "Bday every year on May 5 from Oct 12 to Dec 1", "Bday every year on May 5 starting Oct 12"]) {
				const r = parseAt(input, zone);
				const because = `${input} ${zone}: ${briefChips(r).join(" ; ")}`;
				expect(chipOf(r, "recurrence"), because).toMatchObject({ status: "unsupported", notice: NOTICE });
				expect(applied(r), because).toEqual([]);
				expect(r.fields, because).toEqual({ tagKeys: [], newTags: [] });
				expect(r.title, because).toBe(input);
				expect(r.blocking, because).toEqual([]);
			}
		});
	});

	it("#12: an unsupported repeat masks its words from the date reader", () => {
		for (const input of ["Call every 3 hours", "Gym every 2nd and 4th Tuesday", "Taxes every May 5"]) {
			const r = parseAt(input, "America/New_York");
			expect(r.fields.scheduled, input).toBeUndefined();
			expect(r.chips.every((c) => c.kind === "recurrence" && c.status === "unsupported"), input).toBe(true);
		}
	});
});

describe("6. Rules that always hold", () => {
	it("#12: a value picked by hand wins: the typed start of a yearly repeat is a suggestion and never blocks saving", () => {
		inZones((zone) => {
			for (const input of ["Bday every year on May 5", "Bday every year on May 5 at 7"]) {
				const r = parseAt(input, zone, { manual: ["scheduled"] });
				const because = `${input} ${zone}`;
				expect(r.blocking, because).toEqual([]);
				expect(recOf(r), because).toBe("yearly");
				expect(r.fields.scheduled, because).toBeUndefined();
				expect(chipOf(r, "scheduled")?.notice, because).toBe("Replace date?");
				// The typed date stays text until it is used, like every suggestion.
				expect(r.title, because).toBe(input.replace(" every year on", ""));
			}
		});
	});

	it("#12: a later explicit date wins over a weekday word earlier in the title", () => {
		inZones((zone) => check({ in: "Call Tuesday team every day, Oct 12", title: "Call Tuesday team", rec: "daily", s: "2026-10-12" }, zone));
	});

	it("#12: without a repeat, until <date> is a deadline and the other lead words stay text", () => {
		inZones((zone) => {
			check({ in: "Trip until Dec 1", title: "Trip", d: "2026-12-01" }, zone);
			check({ in: "Wait until tomorrow", title: "Wait", d: "2026-10-08" }, zone);
			check({ in: "Daily standup until friday", title: "Daily standup", d: "2026-10-09" }, zone);
			check({ in: "Trip ending Dec 1", title: "Trip ending", s: "2026-12-01" }, zone);
			check({ in: "Trip starting Dec 1", title: "Trip starting", s: "2026-12-01" }, zone);
			check({ in: "Trip till Dec 1", title: "Trip till", s: "2026-12-01" }, zone);
			check({ in: "Trip beginning Dec 1", title: "Trip beginning", s: "2026-12-01" }, zone);
			check({ in: "Call from Dec 1", title: "Call from", s: "2026-12-01" }, zone);
			check({ in: "Edit the ending tomorrow", title: "Edit the ending", s: "2026-10-08" }, zone);
			check({ in: "Read the beginning tomorrow", title: "Read the beginning", s: "2026-10-08" }, zone);
			check({ in: "Fix the movie ending friday", title: "Fix the movie ending", s: "2026-10-09" }, zone);
			check({ in: "Watch the starting lineup friday", title: "Watch the starting lineup", s: "2026-10-09" }, zone);
			check({ in: "Practice till tomorrow", title: "Practice till", s: "2026-10-08" }, zone);
		});
	});

	it("#12: the title keeps everything not read, with no stray commas or spaces", () => {
		inZones((zone) => {
			check({ in: "Read every day, 20 pages", title: "Read 20 pages", rec: "daily" }, zone);
			check({ in: "Party May 5, 20 guests", title: "Party 20 guests", s: "2027-05-05", brief: ["scheduled|applied|May 5"] }, zone);
			check({ in: "Pills every day, until Dec 1", title: "Pills", rec: "daily", end: "2026-12-01" }, zone);
			check({ in: "Pay rent, until Oct 20", title: "Pay rent", d: "2026-10-20" }, zone);
			check({ in: "Birthday every year on Jun 3, 25 people", title: "Birthday 25 people", rec: "yearly", s: "2027-06-03" }, zone);
			check({ in: "Buy milk, eggs, tomorrow", title: "Buy milk, eggs", s: "2026-10-08" }, zone);
			check({ in: "Call Bob, Mary every day", title: "Call Bob, Mary", rec: "daily" }, zone);
		});
	});

	it("#12: a two-digit number after a comma is never a year, with or without a repeat; four digits are a year", () => {
		inZones((zone) => {
			check({ in: "Birthday every year on 3 Jun, 25 people", locale: "en-GB", title: "Birthday 25 people", rec: "yearly", s: "2027-06-03" }, zone);
			check({ in: "Party 5 May, 20 guests", locale: "en-GB", title: "Party 20 guests", s: "2027-05-05", brief: ["scheduled|applied|5 May"] }, zone);
			for (const locale of LOCALES) {
				const jun3 = spelt(locale, "Jun", 3);
				check({ in: `Party ${jun3}, 2025 people`, locale, title: "Party people", s: "2025-06-03" }, zone);
			}
		});
	});
});

// #69: everyday phrasings Quick Add reads, from the approved table; outside it nothing changes. Wednesday 2026-10-07
// 10:00 in each zone.
describe("7. Everyday phrasings", () => {
	const WORK = "cat-work-0006";
	const ADMIN = "sec-admin-0001";

	describe("times after @", () => {
		it.each<Row>([
			{ in: "Call mom @4pm", title: "Call mom", s: "2026-10-07T16:00", brief: ["scheduled|applied|@4pm"], tags: [], nt: [] },
			{ in: "Call mom @4:30pm", title: "Call mom", s: "2026-10-07T16:30", brief: ["scheduled|applied|@4:30pm"] },
			{ in: "Call mom @noon", title: "Call mom", s: "2026-10-07T12:00", brief: ["scheduled|applied|@noon"], nt: [] },
			// a time with no date is the next such time, as after `at`
			{ in: "Call mom @9am", title: "Call mom", s: "2026-10-08T09:00", brief: ["scheduled|applied|@9am"] },
			// a tag of that name wins
			{ in: "Call mom @4pm", title: "Call mom", tags: ["4pm"], vault: { tags: [{ key: "4pm", displayName: "4pm" }] }, brief: ["tag|applied|@4pm"] },
			// everything else after @ follows the tag rules
			{ in: "Call mom @home", title: "Call mom", tags: ["home"] },
			{ in: "Call mom @0900", title: "Call mom @0900", brief: [] },
			{ in: "File the forms @2024", title: "File the forms @2024", brief: [] },
			{ in: "Call mom @4p", title: "Call mom", nt: ["4p"], brief: ["tag|applied|@4p"] },
			// read exactly as `at` the same time: after a date, after a repeat, before a start
			{ in: "Meet tomorrow @4pm", title: "Meet", s: "2026-10-08T16:00", brief: ["scheduled|applied|tomorrow @4pm"] },
			{ in: "Meet Friday @noon", title: "Meet", s: "2026-10-09T12:00", brief: ["scheduled|applied|Friday @noon"] },
			{ in: "Meet @noon Friday", title: "Meet", s: "2026-10-09T12:00", brief: ["scheduled|applied|@noon Friday"] },
			{ in: "Gym every day @9am", title: "Gym", rec: "daily@09:00", brief: ["recurrence|applied|every day @9am"] },
			{ in: "Gym every monday @4:30pm", title: "Gym", rec: "weekly:MO@16:30" },
			{ in: "Gym every day @9am starting tomorrow", title: "Gym", rec: "daily@09:00", s: "2026-10-08" },
			{ in: "Gym every day @9am", title: "Gym", rec: "daily", tags: ["9am"], vault: { tags: [{ key: "9am", displayName: "9am" }] }, brief: ["recurrence|applied|every day", "tag|applied|@9am"] },
			// a time range after @ reads as after `at`: only a suggestion, never a tag
			{ in: "Call @4pm-5pm", title: "Call @4pm-5pm", dur: null, nt: [], brief: ["scheduled|suggestion|@4pm-5pm"] },
			{ in: "Call @4pm to 5pm", title: "Call @4pm to 5pm", dur: null, nt: [], brief: ["scheduled|suggestion|@4pm to 5pm"] },
			// a tag of that exact name still wins
			{ in: "Call @4pm-5pm", title: "Call", dur: null, tags: ["4pm-5pm"], vault: { tags: [{ key: "4pm-5pm", displayName: "4pm-5pm" }] }, brief: ["tag|applied|@4pm-5pm"] },
			{ in: "Call @4pm to 5pm", title: "Call to", s: "2026-10-07T17:00", dur: null, tags: ["4pm"], vault: { tags: [{ key: "4pm", displayName: "4pm" }] }, brief: ["tag|applied|@4pm", "scheduled|applied|5pm"] },
		])("#69: $in", (row) => checkRow(row));
	});

	describe("24-hour clock after at", () => {
		it.each<Row>([
			{ in: "Call at 0900", title: "Call", s: "2026-10-08T09:00", brief: ["scheduled|applied|at 0900"] },
			{ in: "Call at 0920", title: "Call", s: "2026-10-08T09:20" },
			{ in: "Call at 1730", title: "Call", s: "2026-10-07T17:30" },
			{ in: "Call at 2460", title: "Call at 2460", brief: [] },
			{ in: "Call at 0975", title: "Call at 0975", brief: [] },
			{ in: "Call 0900", title: "Call 0900", brief: [] },
			// read exactly as `at` the same time: after a date, after a repeat, before a start, in a time range (a suggestion)
			{ in: "Standup tomorrow at 0900", title: "Standup", s: "2026-10-08T09:00", brief: ["scheduled|applied|tomorrow at 0900"] },
			{ in: "Lunch at 1230 tomorrow", title: "Lunch", s: "2026-10-08T12:30" },
			{ in: "Call at 1200", title: "Call", s: "2026-10-07T12:00" },
			{ in: "Call at 0000", title: "Call", s: "2026-10-08T00:00" },
			{ in: "Gym every day at 0900", title: "Gym", rec: "daily@09:00", brief: ["recurrence|applied|every day at 0900"] },
			{ in: "Gym every day at 0900 starting tomorrow", title: "Gym", rec: "daily@09:00", s: "2026-10-08" },
			{ in: "Meeting at 0900-1000", title: "Meeting at 0900-1000", dur: null, brief: ["scheduled|suggestion|at 0900-1000"] },
			{ in: "Shift at 0900 to 1700", title: "Shift at 0900 to 1700", dur: null, brief: ["scheduled|suggestion|at 0900 to 1700"] },
		])("#69: $in", (row) => checkRow(row));
	});

	describe("durations need for", () => {
		it.each<Row>([
			{ in: "Gym for 2h", title: "Gym", dur: 120 },
			{ in: "Gym for 45m", title: "Gym", dur: 45 },
			{ in: "Gym for 1h 30m", title: "Gym", dur: 90 },
			{ in: "Gym 2h", title: "Gym 2h", dur: null, brief: [] },
			{ in: "Gym 30 min", title: "Gym 30 min", dur: null, brief: [] },
			{ in: "Gym 45m", title: "Gym 45m", dur: null, brief: [] },
		])("#69: $in", (row) => checkRow(row));
	});

	describe("literal text", () => {
		it.each<Row>([
			{ in: 'Read "Friday night lights"', title: 'Read "Friday night lights"', brief: [] },
			{ in: "Read “Friday night lights”", title: "Read “Friday night lights”", brief: [] },
			{ in: "Buy \\today paper", title: "Buy today paper", brief: [] },
			{ in: "Call \\#Work", title: "Call #Work", cat: null, brief: [] },
			{ in: "Fix \\!1", title: "Fix !1", pri: null, brief: [] },
			{ in: "Call \\@home", title: "Call @home", tags: [], brief: [] },
			// a backslash keeps the whole token or phrase that starts there
			{ in: "Pay \\by friday", title: "Pay by friday", brief: [] },
			{ in: "Pay \\every monday", title: "Pay every monday", brief: [] },
			{ in: "Pay \\at 5pm", title: "Pay at 5pm", brief: [] },
			{ in: "Pay \\for 2h", title: "Pay for 2h", dur: null, brief: [] },
			{ in: "Read \\[[Big]]", title: "Read [[Big]]", brief: [] },
			{ in: "Pay \\Friday's bill tomorrow", title: "Pay Friday's bill", s: "2026-10-08" },
			// an unclosed quote, a quote inside a word and single quotes are not literal
			{ in: 'Read "Friday', title: 'Read "', s: "2026-10-09" },
			{ in: 'Buy 5" screen tomorrow', title: 'Buy 5" screen', s: "2026-10-08" },
			{ in: "Read 'Friday' book", title: "Read '' book", s: "2026-10-09" },
		])("#69: $in", (row) => checkRow(row));
	});

	describe("list and section", () => {
		const SLASHED = [
			{ id: "cat-slash-0007", name: "Work/Admin" },
			{ id: WORK, name: "Work" },
		];
		it.each<Row>([
			{ in: "Report #Work/Admin", title: "Report", cat: WORK, sec: ADMIN, brief: ["category|applied|#Work/Admin"] },
			// sections are matched like list names
			{ in: "Report #work/ADMIN", title: "Report", cat: WORK, sec: ADMIN },
			// a list named with the slash wins
			{ in: "Report #Work/Admin", title: "Report", cat: "cat-slash-0007", sec: null, vault: { categories: SLASHED } },
			{ in: "Report #Work/Nope", title: "Report #Work/Nope", cat: null, blocking: ["category"], chips: ["invalid|category|#Work/Nope|n=No section named Nope in Work"] },
			{ in: "Report #Nope/Admin", title: "Report #Nope/Admin", cat: null, blocking: ["category"], chips: ["unresolved|category|#Nope/Admin|n=No list named Nope/Admin"] },
			{ in: "Report #Work/", title: "Report", cat: WORK, sec: null },
		])("#69: $in", (row) => checkRow(row));
	});

	describe("punctuation beside tokens", () => {
		it.each<Row>([
			{ in: "Pay rent !1.", title: "Pay rent", pri: 1, brief: ["priority|applied|!1"] },
			{ in: "Pay rent !1,", title: "Pay rent", pri: 1 },
			{ in: "Fix the sink @urgent!", title: "Fix the sink", tags: ["work/urgent"] },
			{ in: "Call #Work;", title: "Call", cat: WORK },
			{ in: "Pay rent (#Work)", title: "Pay rent", cat: WORK, brief: ["category|applied|#Work"] },
			{ in: "Pay rent (!2)", title: "Pay rent", pri: 2 },
			{ in: "Pay rent (@home)", title: "Pay rent", tags: ["home"] },
			{ in: "Fix (#Work, @home)", title: "Fix", cat: WORK, tags: ["home"] },
			{ in: "Report ((#Work))", title: "Report", cat: WORK },
			// `(` starts a token only at a word start
			{ in: "print(#Work)", title: "print(#Work)", cat: null, brief: [] },
			{ in: "Fix a(@b) c", title: "Fix a(@b) c", nt: [], brief: [] },
			// a lone mark beside a removed token, with whitespace or the text edge on both sides, at the start or end of the title, goes with it
			{ in: "Pay rent - tomorrow", title: "Pay rent", s: "2026-10-08" },
			{ in: "Pay rent (#Work).", title: "Pay rent", cat: WORK },
			// a mark only removed text, whitespace or the edge touches goes too
			{ in: "Pay rent tomorrow.", title: "Pay rent", s: "2026-10-08" },
			{ in: "Pay rent tomorrow!", title: "Pay rent", s: "2026-10-08" },
			{ in: "Pay rent tomorrow?", title: "Pay rent", s: "2026-10-08" },
			{ in: "Call at 0900.", title: "Call", s: "2026-10-08T09:00" },
			{ in: "Call tomorrow at noon.", title: "Call", s: "2026-10-08T12:00" },
			{ in: "Done tomorrow!", title: "Done", s: "2026-10-08" },
			{ in: "Is it Friday?", title: "Is it", s: "2026-10-09" },
			{ in: "Q&A: Friday?", title: "Q&A:", s: "2026-10-09" },
			{ in: "Call - - tomorrow", title: "Call -", s: "2026-10-08" },
			// a closing bracket split off a removed token goes like a lone mark
			{ in: "Pay rent !1)", title: "Pay rent", pri: 1 },
			{ in: "Pay rent !1]", title: "Pay rent", pri: 1 },
			{ in: "Note (see #Work)", title: "Note (see )", cat: WORK },
			// nothing left: the title is the whole input
			{ in: "Tomorrow!", title: "Tomorrow!", s: "2026-10-08" },
			{ in: "tomorrow.", title: "tomorrow.", s: "2026-10-08" },
			{ in: "Friday?", title: "Friday?", s: "2026-10-09" },
			{ in: "#Work.", title: "#Work.", cat: WORK },
			{ in: "every day.", title: "every day.", rec: "daily" },
			{ in: "- tomorrow", title: "- tomorrow", s: "2026-10-08" },
			{ in: "Pay rent – tomorrow", title: "Pay rent", s: "2026-10-08" },
			{ in: "Call mom, tomorrow", title: "Call mom", s: "2026-10-08" },
			{ in: "Pills every day, until Dec 1", title: "Pills", rec: "daily", end: "2026-12-01" },
			// a mark a word of the title touches stays, and so does one between title words
			{ in: "Wow! tomorrow", title: "Wow!", s: "2026-10-08" },
			{ in: "Plan: tomorrow review", title: "Plan: review", s: "2026-10-08" },
			{ in: "Hi. tomorrow", title: "Hi.", s: "2026-10-08" },
			{ in: "Note: tomorrow", title: "Note:", s: "2026-10-08" },
			{ in: "1. tomorrow call", title: "1. call", s: "2026-10-08" },
			{ in: "Self-review tomorrow", title: "Self-review", s: "2026-10-08" },
			{ in: "Re: invoice tomorrow", title: "Re: invoice", s: "2026-10-08" },
			{ in: "Pay rent: tomorrow", title: "Pay rent:", s: "2026-10-08" },
			{ in: "Call Ann tomorrow - about", title: "Call Ann - about", s: "2026-10-08" },
			{ in: "Fix sink @a.b", title: "Fix sink .b", nt: ["a"] },
		])("#69: $in", (row) => checkRow(row));
	});

	describe("en-GB month and day", () => {
		it.each<Row>([
			{ in: "Dentist Oct 15", locale: "en-GB", title: "Dentist", s: "2026-10-15", brief: ["scheduled|applied|Oct 15"] },
			{ in: "Dentist October 15", locale: "en-GB", title: "Dentist", s: "2026-10-15" },
			{ in: "Dentist 15 Oct", locale: "any", title: "Dentist", s: "2026-10-15" },
			{ in: "Feb 29 party", locale: "en-GB", title: "party", s: "2028-02-29" },
			{ in: "Feb 29 9am party", locale: "en-GB", title: "party", s: "2028-02-29T09:00" },
		])("#69: $in", (row) => checkRow(row));
	});
});
