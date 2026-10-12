import * as chrono from "chrono-node";
import { describe, expect, it } from "vitest";
import type { RepeatRule } from "../../src/domain/types";
import { parseQuickAdd } from "../../src/parsing";
import { DATE_READERS } from "../../src/parsing/dates";
import type { ParseResult } from "../../src/parsing/types";
import { BERLIN, NY, TOKYO, at, makeCtx, ruleKey } from "./helpers";

// Repeating tasks rule 19 (#12): `<date> until <date>` is a start and a repeat end, never one date range; without a
// repeat the `until` date is a deadline (decision 8). Other range words (`to`, `-`, `through`) stay one range.
// A typed end under a repeat picked by hand is checked against that repeat. Wednesday 2026-10-07 10:00 in each zone.

const ZONES = [NY, BERLIN, TOKYO] as const;

const daily: RepeatRule = { freq: "daily", interval: 1, weekdays: null, monthly: null, afterCompletion: false, time: null, tz: null };
const friday: RepeatRule = { ...daily, freq: "weekly", weekdays: ["FR"] };

function parse(input: string, zone: string, extra: { pickedRule?: RepeatRule } = {}): ParseResult {
	const ctx = makeCtx({ zone, now: at(zone, "2026-10-07T10:00"), manual: extra.pickedRule === undefined ? [] : ["recurrence"] });
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

describe.each(ZONES)("`<date> until <date>` in %s", (zone) => {
	it("a start and an end of a repeat", () => {
		for (const input of [
			"Pills every day starting Oct 12 until Dec 1",
			"Pills every day starting Oct 12 till Dec 1",
			"Pills every day Oct 12 until Dec 1",
		]) {
			const r = parse(input, zone);
			expect(r.title, input).toBe("Pills");
			expect(r.fields.recurrence === undefined ? undefined : ruleKey(r.fields.recurrence), input).toBe("daily");
			expect(day(r, "scheduled"), input).toBe("2026-10-12");
			expect(end(r), input).toBe("2026-12-01");
			expect(r.fields.deadline, input).toBeUndefined();
			const endChip = r.chips.find((c) => c.kind === "repeatEnd");
			expect(endChip?.text.toLowerCase().startsWith("until") || endChip?.text.toLowerCase().startsWith("till"), input).toBe(true);
		}
	});

	it("a yearly repeat on a date keeps its own year when the end has one", () => {
		const r = parse("Taxes every year on April 15 until Apr 16 2030", zone);
		expect(r.title).toBe("Taxes");
		expect(r.fields.recurrence === undefined ? undefined : ruleKey(r.fields.recurrence)).toBe("yearly");
		expect(day(r, "scheduled")).toBe("2027-04-15");
		expect(end(r)).toBe("2030-04-16");
		expect(r.chips.some((c) => c.status === "unsupported" || c.status === "suggestion")).toBe(false);
	});

	it("without a repeat the start is the date and the `until` date a deadline", () => {
		const r = parse("Trip Oct 12 until Oct 20", zone);
		expect(r.title).toBe("Trip");
		expect(day(r, "scheduled")).toBe("2026-10-12");
		expect(day(r, "deadline")).toBe("2026-10-20");
		expect(r.fields.recurrenceEnd).toBeUndefined();
	});

	it("other range words stay one date range (a suggestion)", () => {
		for (const input of ["Trip Oct 12 to Oct 20", "Trip Oct 12 through Oct 20", "Trip Oct 12 - Oct 20"]) {
			const r = parse(input, zone);
			const dates = r.chips.filter((c) => c.kind === "scheduled" || c.kind === "deadline");
			expect(dates, input).toHaveLength(1);
			expect(dates[0]?.status, input).toBe("suggestion");
			expect(r.fields.deadline, input).toBeUndefined();
		}
	});
});

describe("the date readers and the range words", () => {
	it("read `until` and `till` as two dates, `to` as one range; the shared chrono instance still merges `until`", () => {
		const ref = { instant: at(NY, "2026-10-07T10:00"), timezone: -240 };
		for (const reader of [DATE_READERS.en, DATE_READERS["en-GB"]]) {
			expect(reader.parse("Oct 12 until Dec 1", ref, { forwardDate: true }).map((r) => [r.index, r.text, r.end === null])).toEqual([
				[0, "Oct 12", true],
				[13, "Dec 1", true],
			]);
			expect(reader.parse("Oct 12 till Dec 1", ref, { forwardDate: true })).toHaveLength(2);
			const range = reader.parse("Oct 12 to Dec 1", ref, { forwardDate: true });
			expect(range).toHaveLength(1);
			expect(range[0]?.end).not.toBeNull();
		}
		const shared = chrono.en.casual.parse("Oct 12 until Dec 1", ref, { forwardDate: true });
		expect(shared).toHaveLength(1);
		expect(shared[0]?.end).not.toBeNull();
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
