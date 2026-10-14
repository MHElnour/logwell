import { describe, expect, it } from "vitest";
import type { QueryContext } from "../../src/domain/queries";
import { completionPlan, currentOccurrence, describeEnd, describeRule, effectiveSchedule, explicitRule, indexOccurrenceRecords, isSeriesEnded, normalizeRepeatRule, occurrencesBetween, ordinal, projectOccurrences, remainingCount, repeatEndProblem, repeatRuleProblem, restartedSeries, ruleAt, scheduleResolver, seriesAnchor, startRecurrence, versionAt, weekdayOf } from "../../src/domain/recurrence";
import { type OccurrenceRecord, REPEAT_FREQS, type Recurrence, type RepeatRule, type Task } from "../../src/domain/types";
import { elapsed, measured } from "../perf/measure";
import { dateRange, done, repeating, rule, series, skipped } from "./recurrence-fixtures";

const ctx: QueryContext = { today: "2026-10-05", zone: "Europe/Berlin", upcomingDays: 7, weekStart: "MO" };

describe("occurrencesBetween", () => {
	it("daily: every day from the anchor, never before it", () => {
		expect(occurrencesBetween(series("2026-10-01", rule()), "2026-09-28", "2026-10-04", "MO")).toEqual([
			"2026-10-01",
			"2026-10-02",
			"2026-10-03",
			"2026-10-04",
		]);
	});

	it("every 3 days counts from the anchor, whatever the window", () => {
		const rec = series("2026-10-01", rule({ interval: 3 }));
		expect(occurrencesBetween(rec, "2026-10-01", "2026-10-10", "MO")).toEqual(["2026-10-01", "2026-10-04", "2026-10-07", "2026-10-10"]);
		expect(occurrencesBetween(rec, "2026-10-02", "2026-10-09", "MO")).toEqual(["2026-10-04", "2026-10-07"]);
	});

	it("weekly without weekdays repeats on the anchor's weekday", () => {
		expect(occurrencesBetween(series("2026-10-09", rule({ freq: "weekly" })), "2026-10-01", "2026-10-31", "MO")).toEqual([
			"2026-10-09",
			"2026-10-16",
			"2026-10-23",
			"2026-10-30",
		]);
	});

	it("selected weekdays", () => {
		const rec = series("2026-10-05", rule({ freq: "weekly", weekdays: ["FR", "MO", "WE"] }));
		expect(occurrencesBetween(rec, "2026-10-05", "2026-10-12", "MO")).toEqual(["2026-10-05", "2026-10-07", "2026-10-09", "2026-10-12"]);
	});

	it("an anchor that is not a selected weekday starts at the next selected one", () => {
		const rec = series("2026-10-07", rule({ freq: "weekly", weekdays: ["MO"] }));
		expect(occurrencesBetween(rec, "2026-10-01", "2026-10-20", "MO")).toEqual(["2026-10-12", "2026-10-19"]);
	});

	it("every 2 weeks counts weeks from the anchor's week", () => {
		const rec = series("2026-10-07", rule({ freq: "weekly", interval: 2, weekdays: ["MO", "FR"] }));
		expect(occurrencesBetween(rec, "2026-10-01", "2026-11-08", "MO")).toEqual(["2026-10-09", "2026-10-19", "2026-10-23", "2026-11-02", "2026-11-06"]);
	});

	it("the week start decides which weeks count for an interval", () => {
		const rec = series("2026-10-04", rule({ freq: "weekly", interval: 2, weekdays: ["SA"] }));
		// Sunday Oct 4 opens a week that starts on Sunday, but closes a week that starts on Monday.
		expect(occurrencesBetween(rec, "2026-10-01", "2026-10-31", "SU")).toEqual(["2026-10-10", "2026-10-24"]);
		expect(occurrencesBetween(rec, "2026-10-01", "2026-10-31", "MO")).toEqual(["2026-10-17", "2026-10-31"]);
	});

	it("monthly on day 31 falls on the last day of shorter months and keeps the anchor day", () => {
		const rec = series("2026-01-31", rule({ freq: "monthly", monthly: { kind: "day", day: 31 } }));
		expect(occurrencesBetween(rec, "2026-01-01", "2026-06-30", "MO")).toEqual([
			"2026-01-31",
			"2026-02-28",
			"2026-03-31",
			"2026-04-30",
			"2026-05-31",
			"2026-06-30",
		]);
		expect(occurrencesBetween(rec, "2028-02-01", "2028-03-31", "MO")).toEqual(["2028-02-29", "2028-03-31"]);
	});

	it("monthly without a form uses the anchor's day of month", () => {
		const rec = series("2026-01-30", rule({ freq: "monthly" }));
		expect(occurrencesBetween(rec, "2026-01-01", "2026-03-31", "MO")).toEqual(["2026-01-30", "2026-02-28", "2026-03-30"]);
	});

	it("the Nth weekday and the last weekday of the month", () => {
		const first = series("2026-10-01", rule({ freq: "monthly", monthly: { kind: "nth", n: 1, weekday: "MO" } }));
		expect(occurrencesBetween(first, "2026-10-01", "2026-12-31", "MO")).toEqual(["2026-10-05", "2026-11-02", "2026-12-07"]);
		const last = series("2026-10-01", rule({ freq: "monthly", monthly: { kind: "nth", n: -1, weekday: "FR" } }));
		expect(occurrencesBetween(last, "2026-10-01", "2026-12-31", "MO")).toEqual(["2026-10-30", "2026-11-27", "2026-12-25"]);
		const second = series("2026-10-01", rule({ freq: "monthly", monthly: { kind: "nth", n: 2, weekday: "TU" } }));
		expect(occurrencesBetween(second, "2026-10-01", "2026-10-31", "MO")).toEqual(["2026-10-13"]);
	});

	it("the last day of the month", () => {
		const rec = series("2026-01-10", rule({ freq: "monthly", monthly: { kind: "lastDay" } }));
		expect(occurrencesBetween(rec, "2026-01-01", "2026-03-31", "MO")).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
	});

	it("an end date caps generation", () => {
		const rec = series("2026-10-01", rule(), { kind: "date", date: "2026-10-03" });
		expect(occurrencesBetween(rec, "2026-10-01", "2026-10-10", "MO")).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
	});

	it("a rule change from Mon/Wed/Fri to Tue/Thu on Oct 12", () => {
		const rec = series("2026-09-28", [
			["2026-09-28", rule({ freq: "weekly", weekdays: ["MO", "WE", "FR"] })],
			["2026-10-12", rule({ freq: "weekly", weekdays: ["TU", "TH"] })],
		]);
		expect(occurrencesBetween(rec, "2026-10-05", "2026-10-18", "MO")).toEqual(["2026-10-05", "2026-10-07", "2026-10-09", "2026-10-13", "2026-10-15"]);
	});

	it("after-completion versions generate nothing on their own (their next date needs the records)", () => {
		expect(occurrencesBetween(series("2026-10-01", rule({ afterCompletion: true, interval: 3 })), "2026-10-01", "2026-10-31", "MO")).toEqual([]);
	});

	it("an empty window gives nothing", () => {
		expect(occurrencesBetween(series("2026-10-01", rule()), "2026-10-05", "2026-10-04", "MO")).toEqual([]);
	});
});

describe("versionAt and ruleAt", () => {
	const rec = series("2026-10-01", [
		["2026-10-03", rule({ interval: 2 })],
		["2026-10-10", rule({ interval: 5 })],
	]);
	it("the last version on or before the date; the first one before any", () => {
		expect(versionAt(rec, "2026-10-01").rule.interval).toBe(2);
		expect(versionAt(rec, "2026-10-09").rule.interval).toBe(2);
		expect(ruleAt(rec, "2026-10-10").interval).toBe(5);
		expect(ruleAt(rec, "2027-01-01").interval).toBe(5);
	});
});

describe("currentOccurrence (fixed mode)", () => {
	const daily = series("2026-10-01", rule());

	it("the anchor before any record", () => {
		expect(currentOccurrence(repeating(daily), [], "2026-10-05", "MO")).toBe("2026-10-01");
	});

	it("the earliest generated date without a record", () => {
		expect(currentOccurrence(repeating(daily), [done("2026-10-01"), skipped("2026-10-02")], "2026-10-05", "MO")).toBe("2026-10-03");
	});

	it("a reopened (removed) record makes that date current again", () => {
		expect(currentOccurrence(repeating(daily), [done("2026-10-01"), done("2026-10-03")], "2026-10-05", "MO")).toBe("2026-10-02");
	});

	it("records in any order and records of dates the rule does not generate are fine", () => {
		const weekly = series("2026-10-05", rule({ freq: "weekly" }));
		expect(currentOccurrence(repeating(weekly), [done("2026-10-12"), done("2026-10-06"), done("2026-10-05")], "2026-10-05", "MO")).toBe("2026-10-19");
	});

	it("null when the task does not repeat, the series ended or the task is completed", () => {
		expect(currentOccurrence(repeating(null), [], "2026-10-05", "MO")).toBeNull();
		expect(currentOccurrence(repeating(series("2026-10-01", rule(), { kind: "never" }, "2026-10-03T09:00:00.000Z")), [], "2026-10-05", "MO")).toBeNull();
		expect(currentOccurrence(repeating(daily, { status: "completed", completedAt: "2026-10-03T09:00:00.000Z" }), [], "2026-10-05", "MO")).toBeNull();
	});

	it("a count end: null once the records reach it", () => {
		const rec = series("2026-10-01", rule(), { kind: "count", count: 3 });
		expect(currentOccurrence(repeating(rec), [done("2026-10-01"), skipped("2026-10-02")], "2026-10-05", "MO")).toBe("2026-10-03");
		expect(currentOccurrence(repeating(rec), [done("2026-10-01"), skipped("2026-10-02"), done("2026-10-03")], "2026-10-05", "MO")).toBeNull();
	});

	it("a date end: null when no date before it is left", () => {
		const rec = series("2026-10-01", rule(), { kind: "date", date: "2026-10-02" });
		expect(currentOccurrence(repeating(rec), [done("2026-10-01")], "2026-10-05", "MO")).toBe("2026-10-02");
		expect(currentOccurrence(repeating(rec), [done("2026-10-01"), done("2026-10-02")], "2026-10-05", "MO")).toBeNull();
	});

	it("records of other tasks are ignored", () => {
		expect(currentOccurrence(repeating(daily), [done("2026-10-01", "2026-10-01", "other")], "2026-10-05", "MO")).toBe("2026-10-01");
	});

	it("stays cheap with three years of daily records", () => {
		const records = dateRange("2023-10-01", "2026-10-04").map((d) => done(d));
		const rec = series("2023-10-01", rule());
		const { result, ms } = measured(() => currentOccurrence(repeating(rec), records, "2026-10-05", "MO"));
		expect(result).toBe("2026-10-05");
		expect(ms).toBeLessThan(200);
	});
});

describe("currentOccurrence (after completion)", () => {
	const every3 = series("2026-10-01", rule({ interval: 3, afterCompletion: true }));

	it("the anchor before any record", () => {
		expect(currentOccurrence(repeating(every3), [], "2026-10-05", "MO")).toBe("2026-10-01");
	});

	it("skipped: the skipped date plus the interval", () => {
		expect(currentOccurrence(repeating(every3), [done("2026-10-01", "2026-10-02"), skipped("2026-10-05")], "2026-10-05", "MO")).toBe("2026-10-08");
	});

	it("user decision: completed early, the next date is the completion day plus the interval (due Oct 10, done Oct 5 → Oct 8)", () => {
		expect(currentOccurrence(repeating(every3), [done("2026-10-10", "2026-10-05")], "2026-10-05", "MO")).toBe("2026-10-08");
	});

	it("user decision: completed late, the same rule (due Oct 8, done Oct 10 → Oct 13)", () => {
		expect(currentOccurrence(repeating(every3), [done("2026-10-08", "2026-10-10")], "2026-10-10", "MO")).toBe("2026-10-13");
	});

	it("the base is the most recently resolved record, not the latest by date", () => {
		// Oct 10 was done early on Oct 5; then Oct 8 was done on Oct 8, which is the newer resolution.
		expect(currentOccurrence(repeating(every3), [done("2026-10-10", "2026-10-05"), done("2026-10-08", "2026-10-08")], "2026-10-08", "MO")).toBe("2026-10-11");
	});

	it("a resolve-time tie prefers the done record, then the later date", () => {
		const a = { ...done("2026-10-04", "2026-10-04"), resolvedAt: "2026-10-06T09:00:00.000Z" };
		const b = { ...skipped("2026-10-06"), resolvedAt: "2026-10-06T09:00:00.000Z" };
		expect(currentOccurrence(repeating(every3), [b, a], "2026-10-06", "MO")).toBe("2026-10-07");
		const c = { ...skipped("2026-10-02"), resolvedAt: "2026-10-06T09:00:00.000Z" };
		expect(currentOccurrence(repeating(every3), [c, b], "2026-10-06", "MO")).toBe("2026-10-09");
	});

	it("a manual skip counts from the day it was skipped (completedOn), an automatic one from its date", () => {
		const manual = { ...skipped("2026-10-01"), completedOn: "2026-10-05" };
		expect(currentOccurrence(repeating(every3), [manual], "2026-10-05", "MO")).toBe("2026-10-08");
		expect(currentOccurrence(repeating(every3), [skipped("2026-10-01", true)], "2026-10-05", "MO")).toBe("2026-10-04");
	});

	it("a taken version floor 8,000 years past the base is passed arithmetically, not day by day", () => {
		// A fixed version every 999 months from 1976, then "1 day after done" from 9970; the base record is
		// the 1976 one (resolved last) and the floor date 9970-01-01 is taken, so the next is 9970-01-02.
		const rec = series("1976-01-01", [
			["1976-01-01", rule({ freq: "monthly", interval: 999 })],
			["9970-01-01", rule({ afterCompletion: true })],
		]);
		const fixedDates = occurrencesBetween(rec, "1976-01-01", "9969-12-31", "MO");
		const records = [
			...fixedDates.map((d) => ({ ...done(d), resolvedAt: "1975-01-01T00:00:00.000Z" })),
			{ ...done("9970-01-01"), resolvedAt: "1975-01-01T00:00:00.000Z" },
			{ ...done("1976-01-01"), resolvedAt: "2026-01-01T09:00:00.000Z" },
		];
		const ms = elapsed(() => {
			for (let i = 0; i < 100; i++) expect(currentOccurrence(repeating(rec), records, "2026-01-01", "MO")).toBe("9970-01-02");
		});
		// Walking ~2.9 million days per call took about 0.75 s for the 100 calls; the arithmetic takes a few ms.
		expect(ms).toBeLessThan(250);
	});

	it("the anchor is no floor: the first occurrence done early counts from the completion day", () => {
		const later = series("2026-10-10", rule({ interval: 3, afterCompletion: true }));
		expect(currentOccurrence(repeating(later), [done("2026-10-10", "2026-10-05")], "2026-10-05", "MO")).toBe("2026-10-08");
	});

	it("the first occurrence done early, then on time: the anchor stays (Oct 10 done Oct 5 → Oct 8, done Oct 8 → Oct 11)", () => {
		const later = series("2026-10-10", rule({ interval: 3, afterCompletion: true }));
		const records = [done("2026-10-10", "2026-10-05"), done("2026-10-08", "2026-10-08")];
		expect(currentOccurrence(repeating(later), records, "2026-10-08", "MO")).toBe("2026-10-11");
	});

	it("anchoredAt: after a move only records resolved after it count; until one exists the next is the anchor", () => {
		const old = [done("2026-10-10"), done("2026-10-13")]; // resolved Oct 10 and Oct 13, 09:00
		const earlier = { ...series("2026-10-14", rule({ interval: 3, afterCompletion: true })), anchoredAt: "2026-10-14T08:00:00.000Z" };
		expect(currentOccurrence(repeating(earlier), old, "2026-10-14", "MO")).toBe("2026-10-14");
		const moved = { ...series("2026-10-20", rule({ interval: 3, afterCompletion: true })), anchoredAt: "2026-10-14T08:00:00.000Z" };
		expect(currentOccurrence(repeating(moved), old, "2026-10-14", "MO")).toBe("2026-10-20");
		// Oct 20 done early on Oct 15 (resolved after the move) → Oct 18.
		expect(currentOccurrence(repeating(moved), [...old, done("2026-10-20", "2026-10-15")], "2026-10-15", "MO")).toBe("2026-10-18");
		// Without anchoredAt the old records count: Oct 13 + 3.
		expect(currentOccurrence(repeating(series("2026-10-14", rule({ interval: 3, afterCompletion: true }))), old, "2026-10-14", "MO")).toBe("2026-10-16");
	});

	it("anchoredAt with a taken anchor moves on by whole intervals from the anchor", () => {
		const moved = { ...series("2026-10-13", rule({ interval: 3, afterCompletion: true })), anchoredAt: "2026-10-14T08:00:00.000Z" };
		expect(currentOccurrence(repeating(moved), [done("2026-10-13")], "2026-10-14", "MO")).toBe("2026-10-16");
	});

	it("collision: a next date that already has a record moves on by whole intervals from the base", () => {
		// Oct 10 done early on Oct 5 → next Oct 8; Oct 8 done early on Oct 7 → Oct 10 is taken → Oct 13.
		const records = [done("2026-10-10", "2026-10-05"), done("2026-10-08", "2026-10-07")];
		expect(currentOccurrence(repeating(every3), records, "2026-10-07", "MO")).toBe("2026-10-13");
		const months = series("2026-01-31", rule({ freq: "monthly", afterCompletion: true }));
		// Base Jan 31 + 1 month = Feb 28 is taken → Jan 31 + 2 months = Mar 31 (from the base, never chained).
		expect(currentOccurrence(repeating(months), [done("2026-02-28", "2026-01-20"), done("2026-01-31", "2026-01-31")], "2026-02-01", "MO")).toBe("2026-03-31");
	});

	it("weeks and months; a month keeps the completion day where it exists (clamped)", () => {
		const weeks = series("2026-10-01", rule({ freq: "weekly", interval: 2, afterCompletion: true }));
		expect(currentOccurrence(repeating(weeks), [done("2026-10-01", "2026-10-03")], "2026-10-05", "MO")).toBe("2026-10-17");
		const months = series("2026-01-31", rule({ freq: "monthly", monthly: { kind: "day", day: 31 }, afterCompletion: true }));
		expect(currentOccurrence(repeating(months), [done("2026-01-31")], "2026-02-05", "MO")).toBe("2026-02-28");
	});

	it("a count end applies too", () => {
		const rec = series("2026-10-01", rule({ interval: 3, afterCompletion: true }), { kind: "count", count: 1 });
		expect(currentOccurrence(repeating(rec), [done("2026-10-01")], "2026-10-05", "MO")).toBeNull();
	});

	it("a date end: null when the next date is after it", () => {
		const rec = series("2026-10-01", rule({ interval: 3, afterCompletion: true }), { kind: "date", date: "2026-10-03" });
		expect(currentOccurrence(repeating(rec), [done("2026-10-01")], "2026-10-05", "MO")).toBeNull();
	});

	it("a fixed rule changed to after completion: the new version counts from the last record, not before its start", () => {
		const rec = series("2026-09-28", [
			["2026-09-28", rule({ freq: "weekly" })],
			["2026-10-05", rule({ interval: 3, afterCompletion: true })],
		]);
		expect(currentOccurrence(repeating(rec), [done("2026-09-28")], "2026-10-05", "MO")).toBe("2026-10-05");
		expect(currentOccurrence(repeating(rec), [done("2026-09-28"), done("2026-10-05", "2026-10-06")], "2026-10-06", "MO")).toBe("2026-10-09");
	});
});

describe("fixed mode: completing early or late never changes the schedule (user decision)", () => {
	const every3 = series("2026-10-01", rule({ interval: 3 }));
	const upTo = [done("2026-10-01"), done("2026-10-04"), done("2026-10-07")];
	it.each([
		["early", "2026-10-05"],
		["on time", "2026-10-10"],
		["late", "2026-10-12"],
	])("done %s: the next is the next generated date", (_when, completedOn) => {
		expect(currentOccurrence(repeating(every3), [...upTo, done("2026-10-10", completedOn)], completedOn, "MO")).toBe("2026-10-13");
	});
});

describe("effectiveSchedule", () => {
	it("a task that does not repeat keeps its scheduled date", () => {
		const t = repeating(null, { scheduled: { kind: "date", date: "2026-10-07" } });
		expect(effectiveSchedule(t, [], ctx)).toEqual({ kind: "date", date: "2026-10-07" });
	});

	it("an all-day series gives its current occurrence as a date", () => {
		expect(effectiveSchedule(repeating(series("2026-10-01", rule())), [done("2026-10-01")], ctx)).toEqual({ kind: "date", date: "2026-10-02" });
	});

	it("a timed series gives wall time and zone of the rule in force on that date", () => {
		const rec = series("2026-10-01", [
			["2026-10-01", rule({ time: "07:00", tz: "Europe/Berlin" })],
			["2026-10-02", rule({ time: "18:30", tz: "America/New_York" })],
		]);
		expect(effectiveSchedule(repeating(rec), [], ctx)).toEqual({ kind: "datetime", local: "2026-10-01T07:00", tz: "Europe/Berlin" });
		expect(effectiveSchedule(repeating(rec), [done("2026-10-01")], ctx)).toEqual({ kind: "datetime", local: "2026-10-02T18:30", tz: "America/New_York" });
	});

	it("an ended series has none", () => {
		expect(effectiveSchedule(repeating(series("2026-10-01", rule(), { kind: "never" }, "2026-10-02T09:00:00.000Z")), [], ctx)).toBeNull();
	});
});

describe("completionPlan", () => {
	it("a daily series 4 days overdue: the earliest is done, the other 3 are skipped, the next is today", () => {
		const t = repeating(series("2026-10-01", rule()));
		const plan = completionPlan(t, [], "2026-10-05", "MO");
		expect(plan).toEqual({ done: "2026-10-01", autoSkipped: ["2026-10-02", "2026-10-03", "2026-10-04"] });
		const after: OccurrenceRecord[] = [done(plan!.done), ...plan!.autoSkipped.map((d) => skipped(d, true))];
		expect(currentOccurrence(t, after, "2026-10-05", "MO")).toBe("2026-10-05");
	});

	it("an occurrence due today or later is simply done", () => {
		const t = repeating(series("2026-10-05", rule({ freq: "weekly" })));
		expect(completionPlan(t, [], "2026-10-05", "MO")).toEqual({ done: "2026-10-05", autoSkipped: [] });
		expect(completionPlan(t, [], "2026-10-01", "MO")).toEqual({ done: "2026-10-05", autoSkipped: [] });
	});

	it("selected weekdays overdue: only generated past dates are skipped, today is not", () => {
		const t = repeating(series("2026-09-28", rule({ freq: "weekly", weekdays: ["MO", "WE", "FR"] })));
		expect(completionPlan(t, [], "2026-10-07", "MO")).toEqual({ done: "2026-09-28", autoSkipped: ["2026-09-30", "2026-10-02", "2026-10-05"] });
	});

	it("dates that already have a record are left alone", () => {
		const t = repeating(series("2026-10-01", rule()));
		expect(completionPlan(t, [done("2026-10-03")], "2026-10-05", "MO")).toEqual({ done: "2026-10-01", autoSkipped: ["2026-10-02", "2026-10-04"] });
	});

	it("a count end stops the catch-up at the limit", () => {
		const t = repeating(series("2026-10-01", rule(), { kind: "count", count: 3 }));
		expect(completionPlan(t, [], "2026-10-10", "MO")).toEqual({ done: "2026-10-01", autoSkipped: ["2026-10-02", "2026-10-03"] });
	});

	it("the catch-up stops where an after-completion version starts (only fixed dates are skipped automatically)", () => {
		const t = repeating(
			series("2026-10-01", [
				["2026-10-01", rule()],
				["2026-10-04", rule({ interval: 3, afterCompletion: true })],
			]),
		);
		expect(completionPlan(t, [], "2026-10-10", "MO")).toEqual({ done: "2026-10-01", autoSkipped: ["2026-10-02", "2026-10-03"] });
	});

	it("after completion never catches up", () => {
		const t = repeating(series("2026-10-01", rule({ interval: 3, afterCompletion: true })));
		expect(completionPlan(t, [], "2026-10-09", "MO")).toEqual({ done: "2026-10-01", autoSkipped: [] });
	});

	it("null for an ended series", () => {
		expect(completionPlan(repeating(series("2026-10-01", rule(), { kind: "never" }, "2026-10-02T09:00:00.000Z")), [], "2026-10-05", "MO")).toBeNull();
	});
});

describe("isSeriesEnded and remainingCount", () => {
	it("endedAt, a reached count or a passed end date", () => {
		expect(isSeriesEnded(series("2026-10-01", rule()), [])).toBe(false);
		expect(isSeriesEnded(series("2026-10-01", rule(), { kind: "never" }, "2026-10-02T09:00:00.000Z"), [])).toBe(true);
		const count = series("2026-10-01", rule(), { kind: "count", count: 2 });
		expect(isSeriesEnded(count, [done("2026-10-01")])).toBe(false);
		expect(isSeriesEnded(count, [done("2026-10-01"), skipped("2026-10-02")])).toBe(true);
		const date = series("2026-10-01", rule(), { kind: "date", date: "2026-10-01" });
		expect(isSeriesEnded(date, [])).toBe(false);
		expect(isSeriesEnded(date, [done("2026-10-01")])).toBe(true);
	});

	it("remainingCount", () => {
		expect(remainingCount(series("2026-10-01", rule()), [])).toBeNull();
		expect(remainingCount(series("2026-10-01", rule(), { kind: "count", count: 5 }), [done("2026-10-01")])).toBe(4);
	});
});

describe("describeRule and describeEnd (the chip)", () => {
	const d = (anchor: string, r: Parameters<typeof rule>[0]) => describeRule(series(anchor, rule(r)));
	it.each([
		[d("2026-10-01", {}), "every day"],
		[d("2026-10-01", { interval: 3 }), "every 3 days"],
		[d("2026-10-09", { freq: "weekly" }), "every Fri"],
		[d("2026-10-05", { freq: "weekly", weekdays: ["FR", "MO", "WE"] }), "every Mon, Wed, Fri"],
		[d("2026-10-05", { freq: "weekly", weekdays: ["MO", "TU", "WE", "TH", "FR"] }), "every weekday"],
		[d("2026-10-05", { freq: "weekly", weekdays: ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] }), "every day"],
		[d("2026-10-05", { freq: "weekly", interval: 2, weekdays: ["MO"] }), "every 2 weeks, Mon"],
		[d("2026-10-05", { freq: "weekly", interval: 2 }), "every 2 weeks, Mon"],
		[d("2026-10-01", { freq: "monthly", monthly: { kind: "day", day: 1 } }), "monthly on the 1st"],
		[d("2026-10-22", { freq: "monthly" }), "monthly on the 22nd"],
		[d("2026-10-01", { freq: "monthly", monthly: { kind: "day", day: 31 } }), "monthly on the 31st"],
		[d("2026-10-01", { freq: "monthly", interval: 3, monthly: { kind: "day", day: 13 } }), "every 3 months on the 13th"],
		[d("2026-10-01", { freq: "monthly", monthly: { kind: "lastDay" } }), "monthly on the last day"],
		[d("2026-10-01", { freq: "monthly", interval: 2, monthly: { kind: "lastDay" } }), "every 2 months on the last day"],
		[d("2026-10-01", { freq: "monthly", monthly: { kind: "nth", n: 1, weekday: "MO" } }), "monthly on the first Monday"],
		[d("2026-10-01", { freq: "monthly", monthly: { kind: "nth", n: -1, weekday: "FR" } }), "monthly on the last Friday"],
		[d("2026-10-01", { freq: "monthly", interval: 2, monthly: { kind: "nth", n: -1, weekday: "FR" } }), "every 2 months on the last Friday"],
		[d("2026-10-01", { freq: "monthly", interval: 2, monthly: { kind: "nth", n: 3, weekday: "WE" } }), "every 2 months on the third Wednesday"],
		[d("2026-10-05", { freq: "weekly", interval: 2, weekdays: ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] }), "every 2 weeks, daily"],
		[d("2026-10-01", { interval: 3, afterCompletion: true }), "3 days after done"],
		[d("2026-10-01", { afterCompletion: true }), "1 day after done"],
		[d("2026-10-01", { freq: "weekly", interval: 2, afterCompletion: true }), "2 weeks after done"],
		[d("2026-10-01", { freq: "monthly", afterCompletion: true }), "1 month after done"],
	])("%s", (actual, expected) => {
		expect(actual).toBe(expected);
	});

	it("describes the version in force on a date, the last one by default", () => {
		const rec = series("2026-09-28", [
			["2026-09-28", rule({ freq: "weekly", weekdays: ["MO", "WE", "FR"] })],
			["2026-10-12", rule({ freq: "weekly", weekdays: ["TU", "TH"] })],
		]);
		expect(describeRule(rec)).toBe("every Tue, Thu");
		expect(describeRule(rec, "2026-10-05")).toBe("every Mon, Wed, Fri");
	});

	it("describeEnd", () => {
		expect(describeEnd(series("2026-10-01", rule()))).toBeNull();
		expect(describeEnd(series("2026-10-01", rule(), { kind: "date", date: "2026-12-31" }), "2026-10-05")).toBe("ends Dec 31");
		expect(describeEnd(series("2026-10-01", rule(), { kind: "date", date: "2027-01-15" }), "2026-10-05")).toBe("ends Jan 15, 2027");
		expect(describeEnd(series("2026-10-01", rule(), { kind: "count", count: 10 }))).toBe("ends after 10 times");
		expect(describeEnd(series("2026-10-01", rule(), { kind: "count", count: 1 }))).toBe("ends after 1 time");
	});
});

describe("projectOccurrences", () => {
	const fridays = series("2026-10-02", rule({ freq: "weekly" }));

	it("records, the current occurrence and the later dates", () => {
		const t = repeating(fridays);
		expect(projectOccurrences(t, [done("2026-10-02"), skipped("2026-10-09")], "2026-10-01", "2026-10-31", "MO")).toEqual([
			{ date: "2026-10-02", kind: "done" },
			{ date: "2026-10-09", kind: "skipped" },
			{ date: "2026-10-16", kind: "current" },
			{ date: "2026-10-23", kind: "future" },
			{ date: "2026-10-30", kind: "future" },
		]);
	});

	it("a count end limits the later dates, counting those before the window", () => {
		const t = repeating(series("2026-10-02", rule({ freq: "weekly" }), { kind: "count", count: 4 }));
		expect(projectOccurrences(t, [done("2026-10-02")], "2026-10-20", "2026-11-30", "MO")).toEqual([{ date: "2026-10-23", kind: "future" }]);
	});

	it("an ended series shows its records only", () => {
		const t = repeating(series("2026-10-02", rule({ freq: "weekly" }), { kind: "never" }, "2026-10-10T09:00:00.000Z"));
		expect(projectOccurrences(t, [done("2026-10-02")], "2026-10-01", "2026-10-31", "MO")).toEqual([{ date: "2026-10-02", kind: "done" }]);
	});

	it("after completion shows only its next date", () => {
		const t = repeating(series("2026-10-01", rule({ interval: 3, afterCompletion: true })));
		expect(projectOccurrences(t, [done("2026-10-01", "2026-10-02")], "2026-10-01", "2026-10-31", "MO")).toEqual([
			{ date: "2026-10-01", kind: "done" },
			{ date: "2026-10-05", kind: "current" },
		]);
	});

	it("a task that does not repeat projects nothing", () => {
		expect(projectOccurrences(repeating(null), [], "2026-10-01", "2026-10-31", "MO")).toEqual([]);
	});
});

describe("indexOccurrenceRecords and scheduleResolver", () => {
	it("groups records by task, sorted by date, and caches per map", () => {
		const map = new Map<string, OccurrenceRecord>(
			[done("2026-10-03"), done("2026-10-01"), done("2026-10-02", "2026-10-02", "t2")].map((r) => [`${r.taskId}:${r.occurrenceDate}`, r]),
		);
		const index = indexOccurrenceRecords(map);
		expect(index.get("t1")?.map((r) => r.occurrenceDate)).toEqual(["2026-10-01", "2026-10-03"]);
		expect(index.get("t2")).toHaveLength(1);
		expect(indexOccurrenceRecords(map)).toBe(index);
	});

	it("resolves like effectiveSchedule, once per task", () => {
		const t = repeating(series("2026-10-01", rule()));
		const plain = repeating(null, { id: "t2", scheduled: { kind: "date", date: "2026-10-09" } });
		const map = new Map([["t1:2026-10-01", done("2026-10-01")]]);
		const resolve = scheduleResolver({ occurrenceRecords: map }, ctx);
		expect(resolve(t)).toEqual({ kind: "date", date: "2026-10-02" });
		expect(resolve(t)).toBe(resolve(t));
		expect(resolve(plain)).toEqual({ kind: "date", date: "2026-10-09" });
	});
});

describe("repeatRuleProblem and normalizeRepeatRule", () => {
	it("accepts the valid forms", () => {
		expect(repeatRuleProblem(rule())).toBeNull();
		expect(repeatRuleProblem(rule({ freq: "weekly", weekdays: ["MO"], interval: 2, time: "07:00", tz: "Europe/Berlin" }))).toBeNull();
		expect(repeatRuleProblem(rule({ freq: "monthly", monthly: { kind: "day", day: 31 }, afterCompletion: true }))).toBeNull();
	});

	it.each([
		[rule({ freq: "hourly" as never })],
		[rule({ interval: 0 })],
		[rule({ interval: 1.5 })],
		[rule({ freq: "weekly", weekdays: [] })],
		[rule({ freq: "weekly", weekdays: ["XX" as never] })],
		[rule({ freq: "monthly", monthly: { kind: "day", day: 32 } })],
		[rule({ freq: "monthly", monthly: { kind: "nth", n: 5 as never, weekday: "MO" } })],
		[rule({ freq: "weekly", weekdays: ["MO"], afterCompletion: true })],
		[rule({ freq: "monthly", monthly: { kind: "lastDay" }, afterCompletion: true })],
		[rule({ time: "7am", tz: "Europe/Berlin" })],
		[rule({ time: "07:00", tz: null })],
		[rule({ time: "07:00", tz: "Nowhere/Land" })],
	])("refuses %j", (r) => {
		expect(repeatRuleProblem(r)).toEqual(expect.any(String));
	});

	it("normalizes: weekdays in Monday-first order without repeats, unused fields null", () => {
		expect(normalizeRepeatRule(rule({ freq: "weekly", weekdays: ["FR", "MO", "FR"] })).weekdays).toEqual(["MO", "FR"]);
		expect(normalizeRepeatRule(rule({ freq: "daily", weekdays: ["MO"], monthly: { kind: "lastDay" } }))).toEqual(rule());
	});
});

describe("repeatEndProblem: one check for the picker, Quick Add and the services", () => {
	// 2026-10-05 is a Monday. The services' refusals are in tests/app/recurrence-service.test.ts.
	const ENDS_BEFORE = "The repeat ends before its first date.";
	const friday = rule({ freq: "weekly", weekdays: ["FR"] });

	it("#12: accepts never, a count of 1 to 999 and a date on or after the first occurrence", () => {
		expect(repeatEndProblem({ kind: "never" }, series("2026-10-05", rule()))).toBeNull();
		expect(repeatEndProblem({ kind: "count", count: 1 })).toBeNull();
		expect(repeatEndProblem({ kind: "count", count: 999 })).toBeNull();
		expect(repeatEndProblem({ kind: "date", date: "2026-10-05" }, series("2026-10-05", rule()))).toBeNull();
		expect(repeatEndProblem({ kind: "date", date: "2026-10-09" }, series("2026-10-05", friday))).toBeNull();
		expect(repeatEndProblem({ kind: "date", date: "2026-12-01" })).toBeNull();
	});

	it("#12: refuses a count out of range, a date that is not one, a date before the anchor or before the first occurrence", () => {
		expect(repeatEndProblem({ kind: "count", count: 0 })).toBe("End after 1 to 999 times.");
		expect(repeatEndProblem({ kind: "count", count: 1.5 })).toBe("End after 1 to 999 times.");
		expect(repeatEndProblem({ kind: "count", count: 1000 })).toBe("End after 1 to 999 times.");
		expect(repeatEndProblem({ kind: "date", date: "2026-02-30" })).toBe("The end date is not valid.");
		expect(repeatEndProblem({ kind: "date", date: "2026-10-04" }, series("2026-10-05", rule()))).toBe(ENDS_BEFORE);
		// Every Friday from Monday Oct 5, ending Wednesday Oct 7: no occurrence at all.
		expect(repeatEndProblem({ kind: "date", date: "2026-10-07" }, series("2026-10-05", friday))).toBe(ENDS_BEFORE);
		// Every 15th from Oct 5, ending Oct 14.
		expect(repeatEndProblem({ kind: "date", date: "2026-10-14" }, series("2026-10-05", rule({ freq: "monthly", monthly: { kind: "day", day: 15 } })))).toBe(ENDS_BEFORE);
	});
});

describe("startRecurrence (make repeating: Quick Add and setRepeat)", () => {
	it("no date: the fallback is the anchor", () => {
		expect(startRecurrence(null, rule(), undefined, "2026-10-05", "Europe/Berlin")).toEqual({
			recurrence: series("2026-10-05", rule()),
			timeFromSpec: false,
		});
	});

	it("a date: it becomes the anchor", () => {
		const r = startRecurrence({ kind: "date", date: "2026-10-09" }, rule({ freq: "weekly" }), { kind: "count", count: 5 }, "2026-10-05", "Europe/Berlin");
		expect(r.recurrence).toEqual(series("2026-10-09", rule({ freq: "weekly" }), { kind: "count", count: 5 }));
	});

	it("a timed date: the rule takes its wall time and zone, the anchor is its wall date", () => {
		const r = startRecurrence({ kind: "datetime", local: "2026-10-09T23:30", tz: "America/New_York" }, rule(), undefined, "2026-10-05", "Europe/Berlin");
		expect(r.timeFromSpec).toBe(true);
		expect(r.recurrence).toEqual(series("2026-10-09", rule({ time: "23:30", tz: "America/New_York" })));
	});

	it("a rule with its own time keeps it; the anchor is the display-zone date", () => {
		const r = startRecurrence(
			{ kind: "datetime", local: "2026-10-09T23:30", tz: "America/New_York" },
			rule({ time: "07:00", tz: "Europe/Berlin" }),
			undefined,
			"2026-10-05",
			"Europe/Berlin",
		);
		expect(r.timeFromSpec).toBe(false);
		expect(r.recurrence.anchor).toBe("2026-10-10");
		expect(r.recurrence.versions[0]?.rule.time).toBe("07:00");
	});

	// A weekly repeat with picked weekdays starts on its first such weekday on or after its start date, so `every 2 weeks
	// on Monday` started on a Wednesday first falls on the coming Monday.
	const weekly = (interval: number, weekdays: RepeatRule["weekdays"]): RepeatRule => rule({ freq: "weekly", interval, weekdays });
	const firstOf = (r: ReturnType<typeof startRecurrence>): string | undefined => occurrencesBetween(r.recurrence, r.recurrence.anchor, "2027-12-31", "MO")[0];

	it("#12: the anchor of a new series is the first picked weekday on or after the start for a weekly rule with weekdays, else the start", () => {
		expect(seriesAnchor("2026-10-07", weekly(2, ["MO"]))).toBe("2026-10-12");
		expect(seriesAnchor("2026-10-07", weekly(1, ["WE"]))).toBe("2026-10-07");
		expect(seriesAnchor("2026-10-07", weekly(2, ["TU", "TH"]))).toBe("2026-10-08");
		expect(seriesAnchor("2026-10-07", weekly(2, null))).toBe("2026-10-07");
		expect(seriesAnchor("2026-10-07", rule())).toBe("2026-10-07");
		expect(seriesAnchor("2026-10-07", rule({ freq: "monthly", monthly: { kind: "day", day: 5 } }))).toBe("2026-10-07");
	});

	it("#12: startRecurrence uses the anchor, so the first occurrence is the coming weekday", () => {
		const started = startRecurrence(null, weekly(2, ["MO"]), undefined, "2026-10-07", "Europe/Berlin", "MO");
		expect(started.recurrence.anchor).toBe("2026-10-12");
		expect(firstOf(started)).toBe("2026-10-12");
		const timed = startRecurrence({ kind: "datetime", local: "2026-10-07T09:00", tz: "Europe/Berlin" }, weekly(2, ["MO"]), undefined, "2026-10-07", "Europe/Berlin", "MO");
		expect(timed.recurrence.anchor).toBe("2026-10-12");
		expect(timed.recurrence.versions[0]!.rule.time).toBe("09:00");
		expect(startRecurrence(null, weekly(3, ["TU", "TH"]), undefined, "2026-10-07", "Europe/Berlin", "MO").recurrence.anchor).toBe("2026-10-08");
		// A later start moves the anchor to the first weekday on or after it.
		expect(firstOf(startRecurrence(null, weekly(2, ["MO"]), undefined, "2026-10-20", "Europe/Berlin", "MO"))).toBe("2026-10-26");
	});
});

describe("engine limits, counts and catch-up", () => {
	it("an interval above 999 is refused, and a huge stored one never hangs", () => {
		expect(repeatRuleProblem(rule({ interval: 999 }))).toBeNull();
		expect(repeatRuleProblem(rule({ interval: 1000 }))).toBe("Repeat every 1 to 999.");
		// A huge stored interval works as 999 (the validator also repairs it on load).
		const daily = series("2026-10-01", rule({ interval: 1e15 }));
		expect(occurrencesBetween(daily, "2026-10-01", "2031-10-01", "MO")).toEqual(["2026-10-01", "2029-06-26"]);
		for (const freq of ["weekly", "monthly"] as const) {
			const rec = series("2026-10-01", rule({ freq, interval: 1e15 }));
			expect(occurrencesBetween(rec, "2026-10-01", "2036-10-01", "MO")).toEqual(["2026-10-01"]);
			expect(currentOccurrence(repeating(rec), [done("2026-10-01")], "2026-10-05", "MO")! > "2036-10-01").toBe(true);
		}
		const monthly = series("2026-10-31", rule({ freq: "monthly", interval: Number.MAX_SAFE_INTEGER }));
		expect(occurrencesBetween(monthly, "2026-11-01", "2030-01-01", "MO")).toEqual([]);
	});

	it("a count counts only records resolved after countFrom; anchoredAt alone does not restart it", () => {
		const old = Array.from({ length: 34 }, (_, i) => ({ ...done(`2026-08-${String((i % 28) + 1).padStart(2, "0")}`), resolvedAt: `2026-09-01T00:00:${String(i).padStart(2, "0")}.000Z` }));
		const base = series("2026-10-09", rule({ freq: "weekly" }), { kind: "count", count: 5 });
		const rec = { ...base, anchoredAt: "2026-10-05T10:00:00.000Z", countFrom: "2026-10-05T10:00:00.000Z" };
		expect(isSeriesEnded(rec, old)).toBe(false);
		expect(remainingCount(rec, old)).toBe(5);
		const newer = [...old, { ...done("2026-10-09"), resolvedAt: "2026-10-09T09:00:00.000Z" }];
		expect(remainingCount(rec, newer)).toBe(4);
		const movedOnly = { ...base, anchoredAt: "2026-10-05T10:00:00.000Z" };
		expect(isSeriesEnded(movedOnly, old)).toBe(true);
		expect(remainingCount(movedOnly, old)).toBe(0);
	});

	it("a weekly rule keeps its own week start whatever the setting", () => {
		// Every 2 weeks on Sun and Mon, anchored Sun Sep 6 2026.
		const records = [done("2026-09-06"), done("2026-09-07")];
		const without = series("2026-09-06", rule({ freq: "weekly", interval: 2, weekdays: ["SU", "MO"] }));
		const a = currentOccurrence(repeating(without), records, "2026-09-10", "MO");
		const b = currentOccurrence(repeating(without), records, "2026-09-10", "SU");
		expect(a).not.toBe(b);
		const frozen = series("2026-09-06", rule({ freq: "weekly", interval: 2, weekdays: ["SU", "MO"], weekStart: "SU" }));
		expect(currentOccurrence(repeating(frozen), records, "2026-09-10", "MO")).toBe(currentOccurrence(repeating(frozen), records, "2026-09-10", "SU"));
		expect(currentOccurrence(repeating(frozen), records, "2026-09-10", "MO")).toBe("2026-09-20");
	});

	it("normalizeRepeatRule stamps the week start on weekly rules only, keeping one already set", () => {
		expect(normalizeRepeatRule(rule({ freq: "weekly" }), "SU").weekStart).toBe("SU");
		expect(normalizeRepeatRule(rule({ freq: "weekly", weekStart: "SA" }), "SU").weekStart).toBe("SA");
		expect(normalizeRepeatRule(rule({ freq: "weekly" }))).not.toHaveProperty("weekStart");
		expect(normalizeRepeatRule(rule({ freq: "daily", weekStart: "SU" }), "SU")).not.toHaveProperty("weekStart");
		expect(repeatRuleProblem(rule({ freq: "weekly", weekStart: "TU" as never }))).toEqual(expect.any(String));
	});

	it("fixed → after completion → fixed, all past: the catch-up passes the after-completion range", () => {
		const t = repeating(
			series("2026-09-01", [
				["2026-09-01", rule()],
				["2026-09-10", rule({ interval: 3, afterCompletion: true })],
				["2026-09-20", rule()],
			]),
		);
		const plan = completionPlan(t, [], "2026-10-05", "MO")!;
		expect(plan.done).toBe("2026-09-01");
		expect(plan.autoSkipped).toContain("2026-09-20");
		expect(plan.autoSkipped).toContain("2026-10-04");
		const at = "2026-10-05T10:00:00.000Z";
		const written = [{ ...done(plan.done, "2026-10-05"), resolvedAt: at }, ...plan.autoSkipped.map((d) => ({ ...skipped(d, true), resolvedAt: at }))];
		expect(currentOccurrence(t, written, "2026-10-05", "MO")).toBe("2026-10-05");
	});

	it("a catch-up followed by an after-completion version counts from the completion day", () => {
		const t = repeating(
			series("2026-10-01", [
				["2026-10-01", rule()],
				["2026-10-04", rule({ interval: 3, afterCompletion: true })],
			]),
		);
		const plan = completionPlan(t, [], "2026-10-05", "MO")!;
		const at = "2026-10-05T10:00:00.000Z";
		const written = [{ ...done(plan.done, "2026-10-05"), resolvedAt: at }, ...plan.autoSkipped.map((d) => ({ ...skipped(d, true), resolvedAt: at }))];
		expect(currentOccurrence(t, written, "2026-10-05", "MO")).toBe("2026-10-08");
	});

	it("with today, generated dates after the current one and before today are missed", () => {
		const t = repeating(series("2026-10-01", rule()));
		expect(projectOccurrences(t, [], "2026-10-01", "2026-10-06", "MO", "2026-10-04").map((p) => p.kind)).toEqual([
			"current",
			"missed",
			"missed",
			"future",
			"future",
			"future",
		]);
		expect(projectOccurrences(t, [], "2026-10-01", "2026-10-03", "MO").map((p) => p.kind)).toEqual(["current", "future", "future"]);
	});

	it("explicitRule spells out the anchor's weekday and day of month; after completion is untouched", () => {
		expect(explicitRule(rule({ freq: "weekly" }), "2026-10-09").weekdays).toEqual(["FR"]);
		expect(explicitRule(rule({ freq: "monthly" }), "2026-10-31").monthly).toEqual({ kind: "day", day: 31 });
		const after = rule({ freq: "monthly", afterCompletion: true });
		expect(explicitRule(after, "2026-10-31")).toBe(after);
		const daily = rule();
		expect(explicitRule(daily, "2026-10-31")).toBe(daily);
	});

	it("ordinal gives a day number its English suffix, teens included, and weekdayOf names the weekday of a date", () => {
		expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "31st"]);
		expect(weekdayOf("2026-10-05")).toBe("MO");
		expect(weekdayOf("2026-09-06")).toBe("SU");
	});
});

describe("yearly repeats", () => {
	// A yearly repeat (#12): every N years on the anchor's month and day.

	const yearly = (patch: Parameters<typeof rule>[0] = {}) => rule({ freq: "yearly", ...patch });
	const ctx: QueryContext = { today: "2026-10-05", zone: "Europe/Berlin", upcomingDays: 7, weekStart: "MO" };

	describe("yearly occurrences (#12)", () => {
		it("#12: is a stored frequency", () => {
			expect(REPEAT_FREQS).toContain("yearly");
			expect(repeatRuleProblem(yearly())).toBeNull();
			expect(repeatRuleProblem(yearly({ interval: 999 }))).toBeNull();
			expect(repeatRuleProblem(yearly({ interval: 1000 }))).not.toBeNull();
		});

		it("#12: repeats on the anchor's month and day", () => {
			expect(occurrencesBetween(series("2026-10-09", yearly()), "2026-01-01", "2029-12-31", "MO")).toEqual([
				"2026-10-09",
				"2027-10-09",
				"2028-10-09",
				"2029-10-09",
			]);
		});

		it("#12: a Feb 29 anchor falls on Feb 28 in other years and comes back on Feb 29", () => {
			expect(occurrencesBetween(series("2028-02-29", yearly()), "2028-01-01", "2032-12-31", "MO")).toEqual([
				"2028-02-29",
				"2029-02-28",
				"2030-02-28",
				"2031-02-28",
				"2032-02-29",
			]);
		});

		it("#12: every 2 years counts from the anchor's year, whatever the window", () => {
			const rec = series("2026-10-09", yearly({ interval: 2 }));
			expect(occurrencesBetween(rec, "2026-01-01", "2031-12-31", "MO")).toEqual(["2026-10-09", "2028-10-09", "2030-10-09"]);
			expect(occurrencesBetween(rec, "2027-01-01", "2029-01-01", "MO")).toEqual(["2028-10-09"]);
		});

		it("#12: an end date caps the series", () => {
			const rec = series("2026-03-14", yearly(), { kind: "date", date: "2028-03-13" });
			expect(occurrencesBetween(rec, "2026-01-01", "2035-12-31", "MO")).toEqual(["2026-03-14", "2027-03-14"]);
		});

		it("#12: a count end allows that many occurrences", () => {
			const task = repeating(series("2026-03-14", yearly(), { kind: "count", count: 3 }));
			const shown = projectOccurrences(task, [], "2026-01-01", "2035-12-31", "MO");
			expect(shown.map((o) => o.date)).toEqual(["2026-03-14", "2027-03-14", "2028-03-14"]);
			const records = [done("2026-03-14"), done("2027-03-14"), done("2028-03-14")];
			expect(currentOccurrence(task, records, "2028-03-14", "MO")).toBeNull();
		});

		it("#12: completing an overdue yearly series skips the missed years before today", () => {
			const task = repeating(series("2024-03-14", yearly()));
			expect(completionPlan(task, [], "2026-10-05", "MO")).toEqual({ done: "2024-03-14", autoSkipped: ["2025-03-14", "2026-03-14"] });
		});

		it("#12: a timed rule keeps its wall time and zone on every year", () => {
			const task = repeating(series("2026-10-09", yearly({ time: "09:00", tz: "Europe/Berlin" })));
			expect(effectiveSchedule(task, [done("2026-10-09")], ctx)).toEqual({ kind: "datetime", local: "2027-10-09T09:00", tz: "Europe/Berlin" });
		});

		it("#12: a monthly series changed to yearly keeps the anchor's phase", () => {
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

	describe("yearly after completion (#12)", () => {
		it("#12: the next date is the completion day one interval later", () => {
			const task = repeating(series("2026-03-14", yearly({ afterCompletion: true })));
			expect(currentOccurrence(task, [], "2026-03-01", "MO")).toBe("2026-03-14");
			const records: OccurrenceRecord[] = [done("2026-03-14", "2026-03-20")];
			expect(currentOccurrence(task, records, "2026-03-20", "MO")).toBe("2027-03-20");
		});

		it("#12: every 2 years, completed on Feb 29, comes back on Feb 28", () => {
			const task = repeating(series("2028-02-20", yearly({ afterCompletion: true, interval: 2 })));
			expect(currentOccurrence(task, [done("2028-02-20", "2028-02-29")], "2028-02-29", "MO")).toBe("2030-02-28");
		});

		it("#12: a taken next date moves on by whole years", () => {
			const task = repeating(series("2026-03-14", yearly({ afterCompletion: true })));
			const records: OccurrenceRecord[] = [
				{ ...done("2027-03-20", "2026-01-10"), resolvedAt: "2026-01-10T09:00:00.000Z" },
				{ ...done("2026-03-14", "2026-03-20"), resolvedAt: "2026-03-20T09:00:00.000Z" },
			];
			expect(currentOccurrence(task, records, "2026-03-20", "MO")).toBe("2028-03-20");
		});
	});

	describe("yearly wording and stored form (#12)", () => {
		it("#12: describes the rule with the anchor's month and day", () => {
			expect(describeRule(series("2026-03-14", yearly()))).toBe("yearly on Mar 14");
			expect(describeRule(series("2026-03-14", yearly({ interval: 2 })))).toBe("every 2 years on Mar 14");
			expect(describeRule(series("2026-03-14", yearly({ afterCompletion: true })))).toBe("1 year after done");
			expect(describeRule(series("2026-03-14", yearly({ afterCompletion: true, interval: 3 })))).toBe("3 years after done");
			expect(describeRule(series("2028-02-29", yearly()))).toBe("yearly on Feb 29");
		});

		it("#12: normalizing clears weekdays and the day of month", () => {
			expect(normalizeRepeatRule(yearly({ weekdays: ["MO"], monthly: { kind: "day", day: 3 } }), "SU")).toEqual(yearly());
		});

		it("#12: making a task repeat yearly anchors it on its date and takes a timed date's time", () => {
			const started = startRecurrence({ kind: "datetime", local: "2026-10-09T08:30", tz: "Europe/Berlin" }, yearly(), undefined, "2026-10-05", "Europe/Berlin");
			expect(started.recurrence.anchor).toBe("2026-10-09");
			expect(started.recurrence.versions[0]!.rule).toEqual(yearly({ time: "08:30", tz: "Europe/Berlin" }));
		});
	});
});

// Duplicating a yearly series (#12). The copy starts on the source's current occurrence
// and takes its month and day from there. A copy of a Feb 29 series is anchored on Feb 28 (the clamped date), so
// it falls on Feb 28 in leap years too: one day before the original.

const TODAY = "2025-01-10";
const yearly = (patch: Parameters<typeof rule>[0] = {}) => rule({ freq: "yearly", ...patch });
const withSeries = (rec: Recurrence) => repeating(rec) as Task & { recurrence: Recurrence };

function copyOf(rec: Recurrence, records = [done(rec.anchor)]): Recurrence {
	return restartedSeries(withSeries(rec), records, TODAY, "MO");
}

describe("Duplicate of a yearly series (#12)", () => {
	it("#12: a Feb 29 source: the copy is anchored on Feb 28 and stays there in leap years", () => {
		const source = series("2024-02-29", yearly());
		const copy = copyOf(source);
		expect(copy.anchor).toBe("2025-02-28");
		expect(occurrencesBetween(copy, "2025-01-01", "2028-12-31", "MO")).toEqual(["2025-02-28", "2026-02-28", "2027-02-28", "2028-02-28"]);
		expect(occurrencesBetween(source, "2028-01-01", "2028-12-31", "MO")).toEqual(["2028-02-29"]);
	});

	it("#12: a Feb 29 source every 3 years: the copy keeps the interval from Feb 28", () => {
		const copy = copyOf(series("2024-02-29", yearly({ interval: 3 })));
		expect(copy.anchor).toBe("2027-02-28");
		expect(occurrencesBetween(copy, "2025-01-01", "2036-12-31", "MO")).toEqual(["2027-02-28", "2030-02-28", "2033-02-28", "2036-02-28"]);
	});

	it("#12: a source on another day keeps its dates", () => {
		const source = series("2024-03-14", yearly());
		const copy = copyOf(source);
		expect(copy.anchor).toBe("2025-03-14");
		expect(occurrencesBetween(copy, "2025-01-01", "2032-12-31", "MO")).toEqual(occurrencesBetween(source, copy.anchor, "2032-12-31", "MO"));
	});

	it("#12: a Feb 29 source counting from completion starts on its current occurrence (it counts from the completion)", () => {
		const copy = copyOf(series("2024-02-29", yearly({ afterCompletion: true })));
		expect(copy.anchor).toBe("2025-02-28");
	});
});
