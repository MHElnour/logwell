import { describe, expect, it } from "vitest";
import type { QueryContext } from "../../src/domain/queries";
import {
	completionPlan,
	currentOccurrence,
	describeRule,
	effectiveSchedule,
	normalizeRepeatRule,
	occurrencesBetween,
	projectOccurrences,
	repeatRuleProblem,
	startRecurrence,
} from "../../src/domain/recurrence";
import type { OccurrenceRecord } from "../../src/domain/types";
import { REPEAT_FREQS } from "../../src/domain/types";
import { done, repeating, rule, series } from "./recurrence-fixtures";

// A yearly repeat (#12): every N years on the anchor's month and day (Repeating tasks rules 1 and 5).

const yearly = (patch: Parameters<typeof rule>[0] = {}) => rule({ freq: "yearly", ...patch });
const ctx: QueryContext = { today: "2026-10-05", zone: "Europe/Berlin", upcomingDays: 7, weekStart: "MO" };

describe("yearly occurrences (Repeating tasks rules 1 and 5, #12)", () => {
	it("is a stored frequency", () => {
		expect(REPEAT_FREQS).toContain("yearly");
		expect(repeatRuleProblem(yearly())).toBeNull();
		expect(repeatRuleProblem(yearly({ interval: 999 }))).toBeNull();
		expect(repeatRuleProblem(yearly({ interval: 1000 }))).not.toBeNull();
	});

	it("repeats on the anchor's month and day", () => {
		expect(occurrencesBetween(series("2026-10-09", yearly()), "2026-01-01", "2029-12-31", "MO")).toEqual([
			"2026-10-09",
			"2027-10-09",
			"2028-10-09",
			"2029-10-09",
		]);
	});

	it("a Feb 29 anchor falls on Feb 28 in other years and comes back on Feb 29", () => {
		expect(occurrencesBetween(series("2028-02-29", yearly()), "2028-01-01", "2032-12-31", "MO")).toEqual([
			"2028-02-29",
			"2029-02-28",
			"2030-02-28",
			"2031-02-28",
			"2032-02-29",
		]);
	});

	it("every 2 years counts from the anchor's year, whatever the window", () => {
		const rec = series("2026-10-09", yearly({ interval: 2 }));
		expect(occurrencesBetween(rec, "2026-01-01", "2031-12-31", "MO")).toEqual(["2026-10-09", "2028-10-09", "2030-10-09"]);
		expect(occurrencesBetween(rec, "2027-01-01", "2029-01-01", "MO")).toEqual(["2028-10-09"]);
	});

	it("an end date caps the series", () => {
		const rec = series("2026-03-14", yearly(), { kind: "date", date: "2028-03-13" });
		expect(occurrencesBetween(rec, "2026-01-01", "2035-12-31", "MO")).toEqual(["2026-03-14", "2027-03-14"]);
	});

	it("a count end allows that many occurrences", () => {
		const task = repeating(series("2026-03-14", yearly(), { kind: "count", count: 3 }));
		const shown = projectOccurrences(task, [], "2026-01-01", "2035-12-31", "MO");
		expect(shown.map((o) => o.date)).toEqual(["2026-03-14", "2027-03-14", "2028-03-14"]);
		const records = [done("2026-03-14"), done("2027-03-14"), done("2028-03-14")];
		expect(currentOccurrence(task, records, "2028-03-14", "MO")).toBeNull();
	});

	it("completing an overdue yearly series skips the missed years before today", () => {
		const task = repeating(series("2024-03-14", yearly()));
		expect(completionPlan(task, [], "2026-10-05", "MO")).toEqual({ done: "2024-03-14", autoSkipped: ["2025-03-14", "2026-03-14"] });
	});

	it("a timed rule keeps its wall time and zone on every year", () => {
		const task = repeating(series("2026-10-09", yearly({ time: "09:00", tz: "Europe/Berlin" })));
		expect(effectiveSchedule(task, [done("2026-10-09")], ctx)).toEqual({ kind: "datetime", local: "2027-10-09T09:00", tz: "Europe/Berlin" });
	});

	it("a monthly series changed to yearly keeps the anchor's phase", () => {
		const rec = series("2026-01-15", [
			["2026-01-15", rule({ freq: "monthly" })],
			["2026-06-01", yearly()],
		]);
		expect(occurrencesBetween(rec, "2026-01-01", "2028-12-31", "MO")).toEqual([
			"2026-01-15",
			"2026-02-15",
			"2026-03-15",
			"2026-04-15",
			"2026-05-15",
			"2027-01-15",
			"2028-01-15",
		]);
	});
});

describe("yearly after completion (Repeating tasks rule 7, #12)", () => {
	it("the next date is the completion day one interval later", () => {
		const task = repeating(series("2026-03-14", yearly({ afterCompletion: true })));
		expect(currentOccurrence(task, [], "2026-03-01", "MO")).toBe("2026-03-14");
		const records: OccurrenceRecord[] = [done("2026-03-14", "2026-03-20")];
		expect(currentOccurrence(task, records, "2026-03-20", "MO")).toBe("2027-03-20");
	});

	it("every 2 years, completed on Feb 29, comes back on Feb 28", () => {
		const task = repeating(series("2028-02-20", yearly({ afterCompletion: true, interval: 2 })));
		expect(currentOccurrence(task, [done("2028-02-20", "2028-02-29")], "2028-02-29", "MO")).toBe("2030-02-28");
	});

	it("a taken next date moves on by whole years", () => {
		const task = repeating(series("2026-03-14", yearly({ afterCompletion: true })));
		const records: OccurrenceRecord[] = [
			{ ...done("2027-03-20", "2026-01-10"), resolvedAt: "2026-01-10T09:00:00.000Z" },
			{ ...done("2026-03-14", "2026-03-20"), resolvedAt: "2026-03-20T09:00:00.000Z" },
		];
		expect(currentOccurrence(task, records, "2026-03-20", "MO")).toBe("2028-03-20");
	});
});

describe("yearly wording and stored form (#12)", () => {
	it("describes the rule with the anchor's month and day", () => {
		expect(describeRule(series("2026-03-14", yearly()))).toBe("yearly on Mar 14");
		expect(describeRule(series("2026-03-14", yearly({ interval: 2 })))).toBe("every 2 years on Mar 14");
		expect(describeRule(series("2026-03-14", yearly({ afterCompletion: true })))).toBe("1 year after done");
		expect(describeRule(series("2026-03-14", yearly({ afterCompletion: true, interval: 3 })))).toBe("3 years after done");
		expect(describeRule(series("2028-02-29", yearly()))).toBe("yearly on Feb 29");
	});

	it("normalizing clears weekdays and the day of month", () => {
		expect(normalizeRepeatRule(yearly({ weekdays: ["MO"], monthly: { kind: "day", day: 3 } }), "SU")).toEqual(yearly());
	});

	it("making a task repeat yearly anchors it on its date and takes a timed date's time", () => {
		const started = startRecurrence({ kind: "datetime", local: "2026-10-09T08:30", tz: "Europe/Berlin" }, yearly(), undefined, "2026-10-05", "Europe/Berlin");
		expect(started.recurrence.anchor).toBe("2026-10-09");
		expect(started.recurrence.versions[0]!.rule).toEqual(yearly({ time: "08:30", tz: "Europe/Berlin" }));
	});
});
