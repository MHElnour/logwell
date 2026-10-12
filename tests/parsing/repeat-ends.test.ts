import * as chrono from "chrono-node";
import { describe, expect, it } from "vitest";
import type { Category, RepeatRule, Tag } from "../../src/domain/types";
import { parseQuickAdd } from "../../src/parsing";
import { DATE_READERS } from "../../src/parsing/dates";
import type { DateLocale, ParseResult, ParsedField, SpanDecision } from "../../src/parsing/types";
import { chipLabel } from "../../src/ui/quickadd/chipLabels";
import { BERLIN, NY, TOKYO, at, chipLines, makeCtx, ruleKey } from "./helpers";

// Repeating tasks rule 19 (#12): an end is `until <date>`, `ending (on) <date>`, `ends on <date>`, `for N times` or
// `for N <periods>`; an end before the start is refused. A repeat end is never a one-off date. Without a repeat,
// `until <date>` is a deadline. Wednesday 2026-10-07 10:00 in each zone.

const ZONES = [NY, BERLIN, TOKYO] as const;

function parse(input: string, zone: string, local = "2026-10-07T10:00"): ParseResult {
	return parseQuickAdd(input, makeCtx({ zone, now: at(zone, local) }));
}

interface Case {
	in: string;
	title: string;
	rec?: string;
	s?: string;
	/** "2026-12-01" (a date end) or "5x" (a count end); absent means no end. */
	end?: string;
	chips?: string[];
}

function endKey(r: ParseResult): string | undefined {
	const e = r.fields.recurrenceEnd;
	if (e === undefined) return undefined;
	return e.kind === "date" ? e.date : e.kind === "count" ? `${e.count}x` : "never";
}

const CASES: Case[] = [
	// an end date (audit 123, probes)
	{ in: "Pills every day until Dec 1", title: "Pills", rec: "daily", end: "2026-12-01", chips: ["applied|recurrence|every day|r=daily", "applied|repeatEnd|until Dec 1"] },
	{ in: "Pills every day until friday", title: "Pills", rec: "daily", end: "2026-10-09" },
	{ in: "Pills every day till Dec 1", title: "Pills", rec: "daily", end: "2026-12-01" },
	{ in: "Pills every day ending Dec 1", title: "Pills", rec: "daily", end: "2026-12-01" },
	{ in: "Pills every day ending on Dec 1", title: "Pills", rec: "daily", end: "2026-12-01" },
	{ in: "Pills every day ends on Dec 1", title: "Pills", rec: "daily", end: "2026-12-01" },
	{ in: "Pills daily until Dec 1", title: "Pills", rec: "daily", end: "2026-12-01" },
	{ in: "Gym every Monday until Nov 30 starting Oct 12", title: "Gym", rec: "weekly:MO", s: "2026-10-12", end: "2026-11-30" },
	// a count (audit 124)
	{ in: "Pills every day for 5 times", title: "Pills", rec: "daily", end: "5x", chips: ["applied|recurrence|every day|r=daily", "applied|repeatEnd|for 5 times"] },
	// A count needs `for`: a bare "5 times" is title text, as "3 times a day" is.
	{ in: "Pills every day 5 times", title: "Pills 5 times", rec: "daily" },
	{ in: "Gym every monday at 7am for 1 time", title: "Gym", rec: "weekly:MO@07:00", end: "1x" },
	// N periods after the start: the day before the Nth period from the start (decision 10)
	{ in: "Gym every day for 2 weeks", title: "Gym", rec: "daily", end: "2026-10-20" },
	{ in: "Gym every Monday for 3 weeks", title: "Gym", rec: "weekly:MO", end: "2026-10-27" },
	{ in: "Gym every Monday for 3 Mondays", title: "Gym", rec: "weekly:MO", end: "2026-10-27" },
	{ in: "Rent every month for 6 months", title: "Rent", rec: "monthly", end: "2027-04-06" },
	{ in: "Gym every day for 10 days starting Oct 10", title: "Gym", rec: "daily", s: "2026-10-10", end: "2026-10-19" },
	// elsewhere `for` stays a duration
	{ in: "Gym every day for 45m", title: "Gym", rec: "daily" },
	// a yearless end before the typed start is the next such date after it, as in the range `starting Dec 10 to Dec 1`
	{
		in: "Pills every day until Dec 1 starting Dec 10",
		title: "Pills",
		rec: "daily",
		s: "2026-12-10",
		end: "2027-12-01",
		chips: ["applied|recurrence|every day|r=daily", "applied|repeatEnd|until Dec 1", "applied|scheduled|starting Dec 10"],
	},
	{ in: "Pills every day for 0 times", title: "Pills for 0 times", rec: "daily", chips: ["applied|recurrence|every day|r=daily", "invalid|repeatEnd|for 0 times|n=End after 1 to 999 times."] },
];

describe("Quick Add repeat ends (#12)", () => {
	for (const zone of ZONES) {
		it.each(CASES.map((c) => [c.in, c] as const))(`#12: ${zone}: %s`, (_name, c) => {
			const r = parse(c.in, zone);
			expect(r.title).toBe(c.title);
			expect(r.fields.recurrence === undefined ? undefined : ruleKey(r.fields.recurrence)).toBe(c.rec);
			const s = r.fields.scheduled;
			expect(s === undefined ? undefined : s.kind === "date" ? s.date : s.local).toBe(c.s);
			expect(r.fields.deadline).toBeUndefined();
			expect(endKey(r)).toBe(c.end);
			if (c.chips !== undefined) expect(chipLines(r)).toEqual(c.chips);
			for (const chip of r.chips) expect(chip.text).toBe(c.in.slice(chip.span.start, chip.span.end));
		});
	}

	it("#12: an end weekday said on that weekday takes the later date", () => {
		// Friday 2026-10-09: "until friday" is next Friday, not today.
		const r = parse("Pills every day until friday", NY, "2026-10-09T10:00");
		expect(endKey(r)).toBe("2026-10-16");
	});

	it("#12: an end must name a day: a month alone is no end, and stays the uncertain date it is", () => {
		const r = parse("Pills every day until march", NY);
		expect(r.fields.recurrenceEnd).toBeUndefined();
		expect(r.chips.find((c) => c.kind === "repeatEnd")).toBeUndefined();
		expect(r.chips.find((c) => c.kind === "scheduled")).toMatchObject({ status: "suggestion", text: "until march" });
		expect(r.title).toBe("Pills until march");
	});

	it("#12: typed before the repeat, `until <date>` is no part of it: a deadline, as without a repeat", () => {
		const r = parse("Until Dec 1 take pills every day", NY);
		expect(r.title).toBe("take pills");
		expect(r.fields.deadline).toEqual({ kind: "date", date: "2026-12-01" });
		expect(r.fields.recurrenceEnd).toBeUndefined();
		expect(ruleKey(r.fields.recurrence!)).toBe("daily");
	});

	it("#12: without a repeat, `until <date>` is a deadline (decision 8)", () => {
		const r = parse("Pay rent until Oct 20", NY);
		expect(r.title).toBe("Pay rent");
		expect(r.fields.deadline).toEqual({ kind: "date", date: "2026-10-20" });
		expect(r.fields.scheduled).toBeUndefined();
		expect(r.fields.recurrenceEnd).toBeUndefined();
	});

	it("#12: a bare word that is not a repeat leaves `until` a deadline", () => {
		const r = parse("Daily standup until friday", NY);
		expect(r.fields.recurrence).toBeUndefined();
		expect(r.fields.deadline).toEqual({ kind: "date", date: "2026-10-09" });
	});

	it("#12: `for N times` and `for 2 weeks` without a repeat stay text", () => {
		for (const input of ["Do it for 5 times", "Wait for 2 days", "Travel for 2 weeks"]) {
			const r = parse(input, NY);
			expect(r.fields.recurrenceEnd, input).toBeUndefined();
			expect(r.chips.some((c) => c.kind === "repeatEnd"), input).toBe(false);
		}
	});

	it("#12: an end of an unsupported repeat is never a date", () => {
		const r = parse("Call every 3 hours until Friday", NY);
		expect(r.fields.scheduled).toBeUndefined();
		expect(r.fields.deadline).toBeUndefined();
		expect(r.fields.recurrenceEnd).toBeUndefined();
		expect(chipLines(r)).toEqual(["unsupported|recurrence|every 3 hours|n=Recurrence not supported yet", "unsupported|repeatEnd|until Friday|n=Recurrence not supported yet"]);
	});

	it("#12: the end waits while the bare hour is still a choice", () => {
		const r = parse("Gym every monday at 9 until Dec 1", NY);
		expect(r.fields.recurrence).toBeUndefined();
		expect(r.fields.recurrenceEnd).toBeUndefined();
		expect(r.chips.find((c) => c.kind === "repeatEnd")?.status).toBe("suggestion");
	});

	it("#12: under a repeat picked by hand the typed end is a suggestion with the repeat", () => {
		const r = parseQuickAdd("Pills every day until Dec 1", makeCtx({ zone: NY, now: at(NY, "2026-10-07T10:00"), manual: ["recurrence"] }));
		expect(chipLines(r)).toEqual(["suggestion|recurrence|every day|r=daily|n=Replace repeat?", "suggestion|repeatEnd|until Dec 1|n=Replace repeat?"]);
		expect(r.fields.recurrenceEnd).toBeUndefined();
	});

	it("#12: the chip names the end", () => {
		const env = { zone: NY, today: "2026-10-07", categories: [] as Category[], tags: new Map<string, Tag>() };
		const label = (input: string): string => chipLabel(parse(input, NY).chips.find((c) => c.kind === "repeatEnd")!, env);
		expect(label("Pills every day until Dec 1")).toBe("Repeat: ends Dec 1");
		expect(label("Pills every day until Jan 5")).toBe("Repeat: ends Jan 5, 2027");
		expect(label("Pills every day for 5 times")).toBe("Repeat: ends after 5 times");
		expect(label("Gym every day for 2 weeks")).toBe("Repeat: ends Oct 20");
	});
});

describe("an end before the start rolls past it", () => {
	// Repeating tasks rule 19 and Tasks and Quick Add rule 25 (#12): a repeat's end typed as a month and day with no year
	// that falls before the start is the next such date after the start, with `until` as in a range (`May 5 until Dec 1`
	// and `May 5, until Dec 1` agree); an end that rolls more than a year past the start is a visible suggestion; and a
	// two-digit number after a comma is never a year (`Jun 3, 25 people`).

	const ZONES = [NY, BERLIN, TOKYO] as const;

	function parse(input: string, zone: string, now = "2026-10-07T10:00", locale: DateLocale = "en"): ParseResult {
		return parseQuickAdd(input, makeCtx({ zone, locale, now: at(zone, now) }));
	}
	const sched = (r: ParseResult): string | undefined => (r.fields.scheduled === undefined ? undefined : r.fields.scheduled.kind === "date" ? r.fields.scheduled.date : r.fields.scheduled.local);
	const endChip = (r: ParseResult) => r.chips.find((c) => c.kind === "repeatEnd");

	describe.each(ZONES)("a repeat end before its start in %s", (zone) => {
		it("#12: `until` after a comma agrees with the merged range: the end is the next such date after the start", () => {
			const plain = parse("Birthday every year on May 5 until Dec 1", zone);
			const comma = parse("Birthday every year on May 5, until Dec 1", zone);
			for (const r of [plain, comma]) {
				expect(sched(r), r.input).toBe("2027-05-05");
				expect(endChip(r), r.input).toMatchObject({ status: "applied", end: { kind: "date", date: "2027-12-01" } });
				expect(r.blocking, r.input).toEqual([]);
			}
			expect(comma.title).toBe("Birthday");
		});

		it("#12: an end with its own year, or naming its own day, stays where it is: invalid before the start", () => {
			for (const input of ["Birthday every year on May 5, until Dec 1 2026", "Gym every day starting Oct 20 until tomorrow"]) {
				const r = parse(input, zone);
				expect(endChip(r)?.status, input).toBe("invalid");
				expect(r.blocking, input).toEqual([endChip(r)!.id]);
			}
			// So does an end before a start picked by hand: only a typed start moves a yearless end.
			const picked = parseQuickAdd("Stretch daily until Oct 15", { ...makeCtx({ zone, now: at(zone, "2026-10-07T10:00") }), startDate: "2026-10-20" });
			expect(endChip(picked)?.status).toBe("invalid");
		});

		it("#12: an end that rolls more than a year past the start is a suggestion, not applied", () => {
			for (const input of ["Gym every day from Feb 20 to Feb 29", "Gym every day starting Feb 20 until Feb 29", "Gym every day starting Feb 20, until Feb 29"]) {
				const r = parse(input, zone, "2027-02-10T10:00");
				expect(sched(r), input).toBe("2027-02-20");
				expect(endChip(r), input).toMatchObject({ status: "suggestion", notice: "Use as end date?", end: { kind: "date", date: "2028-02-29" } });
				expect(r.fields.recurrenceEnd, input).toBeUndefined();
				expect(r.blocking, input).toEqual([]);
			}
			// Within a year it applies, as before; `until Oct 1 starting Oct 3` rolls like the range `starting Oct 3 to Oct 1`.
			const r = parse("Gym every day starting Dec 20 to Jan 5", zone);
			expect(endChip(r)).toMatchObject({ status: "applied", end: { kind: "date", date: "2027-01-05" } });
			expect(endChip(parse("Pills every day until Oct 1 starting Oct 3", zone))).toMatchObject({ status: "applied", end: { kind: "date", date: "2028-10-01" } });
		});
	});

	describe.each(ZONES)("a two-digit number after a comma in %s", (zone) => {
		it.each(["en", "en-GB"] as const)("#12: %s: is never a year, with or without a repeat", (locale) => {
			const [jun3, may5] = locale === "en" ? ["Jun 3", "May 5"] : ["3 Jun", "5 May"];
			const yearly = parse(`Birthday every year on ${jun3}, 25 people`, zone, "2026-10-07T10:00", locale);
			expect(yearly.fields.recurrence?.freq).toBe("yearly");
			expect(sched(yearly)).toBe("2027-06-03");
			expect(yearly.title).toBe("Birthday 25 people");
			const guests = parse(`Party ${may5}, 20 guests`, zone, "2026-10-07T10:00", locale);
			expect(sched(guests)).toBe("2027-05-05");
			expect(guests.title).toBe("Party 20 guests");
			expect(guests.chips.map((c) => c.text)).toEqual([may5]);
			// Four digits are a year.
			expect(sched(parse(`Party ${jun3}, 2025 people`, zone, "2026-10-07T10:00", locale))).toBe("2025-06-03");
		});
	});
});

describe("a range joined by until or till", () => {
	// Repeating tasks rule 19 (#12): a date range joined by `until` or `till` (`Oct 12 until Dec 1`, `tomorrow until 5pm`)
	// is chrono's range, as for `to`: without a typed repeat it stays ONE visible suggestion and nothing is applied
	// silently (no start, no end, no deadline from it). Under a typed repeat it is the repeat's start and end
	// (issue-12-repeat-range.test.ts). A lone `until <date>` is a repeat end under a repeat and a deadline without one. A
	// typed end under a repeat picked by hand is checked against that repeat.
	// Wednesday 2026-10-07 10:00 in each zone.

	const ZONES = [NY, BERLIN, TOKYO] as const;

	const daily: RepeatRule = { freq: "daily", interval: 1, weekdays: null, monthly: null, afterCompletion: false, time: null, tz: null };
	const friday: RepeatRule = { ...daily, freq: "weekly", weekdays: ["FR"] };

	function parse(input: string, zone: string, extra: { pickedRule?: RepeatRule; locale?: DateLocale } = {}): ParseResult {
		const ctx = makeCtx({ zone, now: at(zone, "2026-10-07T10:00"), locale: extra.locale ?? "en", manual: extra.pickedRule === undefined ? [] : ["recurrence"] });
		return parseQuickAdd(input, extra.pickedRule === undefined ? ctx : { ...ctx, pickedRule: extra.pickedRule });
	}

	const day = (r: ParseResult, field: "scheduled" | "deadline"): string | undefined => {
		const s = r.fields[field];
		return s === undefined ? undefined : s.kind === "date" ? s.date : s.local;
	};
	const end = (r: ParseResult): string | undefined => {
		const e = r.fields.recurrenceEnd;
		return e === undefined ? undefined : e.kind === "date" ? e.date : e.kind;
	};

	const noDateApplied = (r: ParseResult): void => {
		expect(r.fields.scheduled).toBeUndefined();
		expect(r.fields.deadline).toBeUndefined();
		expect(r.fields.recurrenceEnd).toBeUndefined();
		expect(r.chips.filter((c) => c.kind === "scheduled" || c.kind === "deadline" || c.kind === "repeatEnd").every((c) => c.status === "suggestion")).toBe(true);
		expect(r.blocking).toEqual([]);
	};

	// What the date reader gives with chrono's own range merge: [input, locale, the suggestion's text]. The text is also
	// kept in the title.
	const RANGES: ReadonlyArray<readonly [string, DateLocale, string]> = [
		["Meeting tomorrow until 5pm", "en", "tomorrow until 5pm"],
		["Party Friday until midnight", "en", "Friday until midnight"],
		["Meeting Oct 12 until noon", "en", "Oct 12 until noon"],
		["Meeting 12 Oct until 5pm", "en-GB", "12 Oct until 5pm"],
		["Trip Oct 12 till Dec 1", "en", "Oct 12 till Dec 1"],
		["Trip tomorrow till Friday", "en", "tomorrow till Friday"],
		["Trip Monday until Friday", "en", "Monday until Friday"],
		["Trip 20/10 until 12/10", "en-GB", "20/10 until 12/10"],
		["Trip Oct 12 until Oct 20", "en", "Oct 12 until Oct 20"],
		["Trip Oct 12 to Oct 20", "en", "Oct 12 to Oct 20"],
		["Trip Oct 12 through Oct 20", "en", "Oct 12 through Oct 20"],
		["Trip Oct 12 - Oct 20", "en", "Oct 12 - Oct 20"],
	];

	describe.each(ZONES)("a date range in %s", (zone) => {
		it.each(RANGES)("#12: %s (%s) is one visible suggestion, nothing applied, text kept", (input, locale, text) => {
			const r = parse(input, zone, { locale });
			noDateApplied(r);
			expect(r.title).toBe(input);
			const dates = r.chips.filter((c) => c.kind === "scheduled" || c.kind === "deadline");
			expect(dates).toHaveLength(1);
			expect(dates[0]?.status).toBe("suggestion");
			expect(dates[0]?.text).toBe(text);
		});

		it("#12: a lone `until <date>` is a repeat end under a repeat and a deadline without one", () => {
			const withRepeat = parse("Pills every day until Dec 1", zone);
			expect(withRepeat.title).toBe("Pills");
			expect(end(withRepeat)).toBe("2026-12-01");
			expect(withRepeat.fields.deadline).toBeUndefined();
			const alone = parse("Gym until Dec 1", zone);
			expect(alone.title).toBe("Gym");
			expect(day(alone, "deadline")).toBe("2026-12-01");
			expect(alone.fields.recurrenceEnd).toBeUndefined();
		});
	});

	describe("the date readers and the range words", () => {
		it("#12: merge `until`, `till` and `to` ranges exactly like chrono's own readers", () => {
			const ref = { instant: at(NY, "2026-10-07T10:00"), timezone: -240 };
			const own = { en: chrono.en.casual, "en-GB": chrono.en.GB };
			for (const locale of ["en", "en-GB"] as const) {
				for (const input of ["Oct 12 until Dec 1", "Oct 12 till Dec 1", "Oct 12 to Dec 1", "tomorrow until 5pm"]) {
					const mine = DATE_READERS[locale].parse(input, ref, { forwardDate: true }).map((r) => [r.index, r.text, r.end === null]);
					const theirs = own[locale].parse(input, ref, { forwardDate: true }).map((r) => [r.index, r.text, r.end === null]);
					expect(mine, `${locale} ${input}`).toEqual(theirs);
				}
				const range = DATE_READERS[locale].parse("Oct 12 until Dec 1", ref, { forwardDate: true });
				expect(range).toHaveLength(1);
				expect(range[0]?.end).not.toBeNull();
			}
		});
	});

	describe("a typed end under a repeat picked by hand", () => {
		it("#12: is checked against the picked repeat: an end before its first date blocks saving", () => {
			const r = parse("Gym until Oct 8", NY, { pickedRule: friday });
			const chip = r.chips.find((c) => c.kind === "repeatEnd");
			expect(chip).toMatchObject({ status: "invalid", notice: "The repeat ends before its first date." });
			expect(r.blocking).toEqual([chip!.id]);
			expect(r.title).toBe("Gym until Oct 8");
		});

		it("#12: an end on or after the first date applies", () => {
			const r = parse("Gym until Oct 9", NY, { pickedRule: friday });
			expect(r.chips.find((c) => c.kind === "repeatEnd")?.status).toBe("applied");
			expect(r.blocking).toEqual([]);
			expect(end(r)).toBe("2026-10-09");
		});
	});
});

describe("repeat edges", () => {
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
		it("#12: `for N …` counts from the start the model has (a date picked by hand or a preset)", () => {
			const r = parse("Stretch daily for 2 weeks", zone, { startDate: "2026-10-20" });
			expect(endKey(r)).toBe("2026-11-02");
			const before = parse("Stretch daily until Oct 15", zone, { startDate: "2026-10-20" });
			expect(chipLines(before)).toEqual(["applied|recurrence|daily|r=daily", "invalid|repeatEnd|until Oct 15|n=The repeat ends before its first date."]);
			// A typed date wins over the model's start, as it does on save.
			expect(endKey(parse("Stretch daily for 2 weeks starting Oct 10", zone, { startDate: "2026-10-20" }))).toBe("2026-10-23");
		});

		it("#12: an end before the first occurrence is invalid, not only one before the start", () => {
			const r = parse("Gym every friday until Oct 8", zone);
			expect(rec(r)).toBe("weekly:FR");
			expect(endKey(r)).toBeUndefined();
			expect(r.chips.find((c) => c.kind === "repeatEnd")).toMatchObject({ status: "invalid", notice: "The repeat ends before its first date." });
		});

		it("#12: an invalid end blocks saving", () => {
			// An end with its own year before the typed start (a yearless one would roll to the next Oct 1).
			const r = parse("Pills every day until Oct 1 2027 starting Oct 3", zone);
			const end = r.chips.find((c) => c.kind === "repeatEnd")!;
			expect(end.status).toBe("invalid");
			expect(r.blocking).toEqual([end.id]);
			const count = parse("Read daily for 1000 times", zone);
			expect(chipLines(count)).toEqual(["applied|recurrence|daily|r=daily", "invalid|repeatEnd|for 1000 times|n=End after 1 to 999 times."]);
			expect(count.blocking.length).toBe(1);
		});

		it("#12: outside a repeat only `until` leads a date; ending, till, beginning and starting stay title words", () => {
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

		it("#12: an end waits, unapplied, while its repeat's time is still a choice", () => {
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

		it("#12: with a repeat picked by hand, `until <date>` is its end, not a deadline", () => {
			const r = parse("Pills until Dec 1", zone, { manual: ["recurrence"] });
			expect(r.title).toBe("Pills");
			expect(r.fields.deadline).toBeUndefined();
			expect(endKey(r)).toBe("2026-12-01");
		});

		it("#12: more weekdays after `every other` or `every N weeks` are part of the repeat, never a date", () => {
			const cases: [string, string, string | undefined][] = [
				["Trash every other monday and wednesday", "Trash", "weekly/2:MO,WE"],
				["Trash every other monday wed", "Trash", "weekly/2:MO,WE"],
				["Gym every 2 weeks tuesday", "Gym", "weekly/2:TU"],
				["Gym every week monday", "Gym", "weekly:MO"],
				["Run every day first thing", "Run first thing", "daily"],
				// A range of weekdays is every weekday from the first to the last, round the week.
				["Gym every mon-fri", "Gym", "weekly:MO,TU,WE,TH,FR"],
				["Gym every tuesday to thursday", "Gym", "weekly:TU,WE,TH"],
				["Gym every other fri-mon", "Gym", "weekly/2:MO,FR,SA,SU"],
				["Gym every 2 weeks on mon-wed at 9am", "Gym", "weekly/2:MO,TU,WE@09:00"],
				["Gym weekly mon-fri", "Gym", "weekly:MO,TU,WE,TH,FR"],
				["Standup weekly monday to friday", "Standup", "weekly:MO,TU,WE,TH,FR"],
				["Gym weekly tue-thu", "Gym", "weekly:TU,WE,TH"],
			];
			for (const [input, title, key] of cases) {
				const r = parse(input, zone);
				expect(r.title, input).toBe(title);
				expect(rec(r), input).toBe(key);
				expect(sched(r), input).toBeUndefined();
			}
			// A form that takes no weekday keeps its words; the weekday after it is a date (the repeat grammar, rule 40).
			const dated: [string, string, string | undefined, string | undefined][] = [
				["Gym every 3 days monday", "Gym", "daily/3", "2026-10-12"],
				["Gym every monday at 7 wednesday", "Gym every monday at 7 wednesday", undefined, undefined],
				["Gym every month 15th", "Gym 15th", "monthly", undefined],
			];
			for (const [input, title, key, date] of dated) {
				const r = parse(input, zone);
				expect(r.title, input).toBe(title);
				expect(rec(r), input).toBe(key);
				expect(sched(r), input).toBe(date);
			}
			expect(parse("Gym every monday at 7 wednesday", zone).chips.map((c) => `${c.kind}|${c.status}`)).toEqual(["recurrence|choice", "scheduled|choice"]);
			const other = parse("Gym every other 2nd tuesday", zone);
			expect(other.fields.recurrence).toBeUndefined();
			expect(other.chips.map((c) => `${c.kind}|${c.status}|${c.notice ?? ""}`)).toEqual([`recurrence|unsupported|${REC}`]);
		});

		it("#12: `sat` and `sun` continue a space-joined list only at the end of the text; the full names always do", () => {
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

		it("#12: leaves no stray `on` or comma in the title", () => {
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

		it("#12: `every year on` followed by no readable date is not supported, never a repeat from today", () => {
			const r = parse("Bday every year on 45", zone);
			expect(r.fields.recurrence).toBeUndefined();
			expect(r.fields.scheduled).toBeUndefined();
			expect(r.chips.find((c) => c.kind === "recurrence")?.status).toBe("unsupported");
		});

		it("#12: `for N <periods>` anywhere after a repeat is its end, never part of a date", () => {
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

		it("#12: `for N …` before the repeat stays title text, and is never read as a date", () => {
			for (const input of ["Plan meals for 7 days every sunday", "Plan meals for 7 days every sunday."]) {
				const r = parse(input, zone);
				expect(r.title, input).toBe("Plan meals for 7 days");
				expect(rec(r), input).toBe("weekly:SU");
				expect(r.fields.scheduled, input).toBeUndefined();
				expect(r.fields.recurrenceEnd, input).toBeUndefined();
				expect(r.chips.map((c) => c.kind), input).toEqual(["recurrence"]);
			}
			const pack = parse("Pack for 3 days trip every friday", zone);
			expect(pack.title).toBe("Pack for 3 days trip");
			expect(rec(pack)).toBe("weekly:FR");
			expect(pack.chips.map((c) => c.kind)).toEqual(["recurrence"]);
			const daily = parse("Pack for 3 days daily", zone);
			expect(daily.title).toBe("Pack for 3 days");
			expect(rec(daily)).toBe("daily");
			expect(daily.fields.recurrenceEnd).toBeUndefined();
		});

		it("#12: `for N …` never ends a repeat picked by hand: it stays text", () => {
			const r = parse("Daily standup for 2 weeks", zone, { manual: ["recurrence"] });
			expect(r.chips).toEqual([]);
			expect(r.title).toBe("Daily standup for 2 weeks");
		});

		it("#12: an end after the typed start date takes its comma and leaves the date text alone", () => {
			const count = parse("Taxes every year on April 15, for 3 times", zone);
			expect(count.title).toBe("Taxes");
			expect(rec(count)).toBe("yearly");
			expect(count.chips.find((c) => c.kind === "scheduled")?.text).toBe("April 15");
			expect(endKey(count)).toBe("3x");
			const years = parse("Taxes every year on April 15 for 5 years", zone);
			expect(years.chips.find((c) => c.kind === "scheduled")?.text).toBe("April 15");
			expect(years.title).toBe("Taxes");
			expect(endKey(years)).toBe("2032-04-14");
		});
	});
});
