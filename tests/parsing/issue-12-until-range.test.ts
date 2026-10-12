import * as chrono from "chrono-node";
import { describe, expect, it } from "vitest";
import type { RepeatRule } from "../../src/domain/types";
import { parseQuickAdd } from "../../src/parsing";
import { DATE_READERS } from "../../src/parsing/dates";
import type { DateLocale, ParseResult } from "../../src/parsing/types";
import { BERLIN, NY, TOKYO, at, makeCtx } from "./helpers";

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
	it.each(RANGES)("%s (%s) is one visible suggestion, nothing applied, text kept", (input, locale, text) => {
		const r = parse(input, zone, { locale });
		noDateApplied(r);
		expect(r.title).toBe(input);
		const dates = r.chips.filter((c) => c.kind === "scheduled" || c.kind === "deadline");
		expect(dates).toHaveLength(1);
		expect(dates[0]?.status).toBe("suggestion");
		expect(dates[0]?.text).toBe(text);
	});

	it("a lone `until <date>` is a repeat end under a repeat and a deadline without one", () => {
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
	it("merge `until`, `till` and `to` ranges exactly like chrono's own readers", () => {
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
	it("is checked against the picked repeat: an end before its first date blocks saving", () => {
		const r = parse("Gym until Oct 8", NY, { pickedRule: friday });
		const chip = r.chips.find((c) => c.kind === "repeatEnd");
		expect(chip).toMatchObject({ status: "invalid", notice: "The repeat ends before its first date." });
		expect(r.blocking).toEqual([chip!.id]);
		expect(r.title).toBe("Gym until Oct 8");
	});

	it("an end on or after the first date applies", () => {
		const r = parse("Gym until Oct 9", NY, { pickedRule: friday });
		expect(r.chips.find((c) => c.kind === "repeatEnd")?.status).toBe("applied");
		expect(r.blocking).toEqual([]);
		expect(end(r)).toBe("2026-10-09");
	});
});
