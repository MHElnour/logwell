import { describe, expect, it } from "vitest";
import { type CalendarContext, layoutMonth, layoutWeek, monthGrid, weekDays } from "../../src/domain/calendar";
import { completedRows } from "../../src/domain/queries";
import { indexOccurrenceRecords } from "../../src/domain/recurrence";
import type { OccurrenceRecord, Task } from "../../src/domain/types";
import { dateRange, done, repeating, rule, series, skipped } from "./recurrence-fixtures";

// A repeating task shows every occurrence in the visible range (fixed mode), the current one first
// among them; done ones are marked, skipped ones are hidden, an after-completion series shows its next date only.

const BERLIN = "Europe/Berlin";

function ctxFor(records: OccurrenceRecord[] = [], today = "2026-10-05"): CalendarContext {
	const map = new Map<string, OccurrenceRecord>(records.map((r) => [`${r.taskId}:${r.occurrenceDate}`, r]));
	return { zone: BERLIN, today, now: `${today}T10:00:00.000Z`, weekStart: "MO", records: indexOccurrenceRecords(map) };
}

/** Kinds by date over the days of a range, for one series. */
function kinds(t: Task, days: string[], ctx: CalendarContext): Record<string, string[]> {
	const layout = layoutWeek([t], days, ctx);
	const out: Record<string, string[]> = {};
	for (const d of days) {
		const all = (layout.allDay.get(d) ?? []).filter((e) => e.kind === "date").map((e) => String(e.occurrence));
		const timed = (layout.timed.get(d) ?? []).map((s) => `${String(s.occurrence)}@${Math.floor(s.startMin / 60)}:${String(s.startMin % 60).padStart(2, "0")}`);
		if (all.length + timed.length > 0) out[d] = [...all, ...timed];
	}
	return out;
}

const WEEK = weekDays("2026-10-05", "MO"); // Mon Oct 5 .. Sun Oct 11

describe("fixed schedules", () => {
	it("shows the current occurrence, then the future ones; the task's own scheduled (null) adds nothing", () => {
		const t = repeating(series("2026-10-05", rule({ freq: "weekly", weekdays: ["MO", "WE", "FR"] })));
		expect(kinds(t, WEEK, ctxFor())).toEqual({ "2026-10-05": ["current"], "2026-10-07": ["future"], "2026-10-09": ["future"] });
	});

	it("marks done ones, hides skipped ones, and an unresolved overdue date is still current/future", () => {
		const t = repeating(series("2026-10-01", rule()));
		const records = [done("2026-10-01"), done("2026-10-02"), skipped("2026-10-03", true)];
		const k = kinds(t, WEEK, ctxFor(records));
		// Records cover Oct 1-3, so Oct 4 is the current one and every later date is a future one.
		expect(k["2026-10-05"]).toEqual(["future"]);
		expect(k["2026-10-06"]).toEqual(["future"]);
		const before = kinds(t, weekDays("2026-09-30", "MO"), ctxFor(records));
		expect(before).toMatchObject({ "2026-10-01": ["done"], "2026-10-02": ["done"], "2026-10-04": ["current"] });
		expect(before["2026-10-03"]).toBeUndefined(); // skipped
	});

	it("a done occurrence is never past; an open overdue one is", () => {
		const t = repeating(series("2026-10-03", rule()));
		const layout = layoutWeek([t], weekDays("2026-10-05", "MO").slice(0, 1).concat(["2026-10-03", "2026-10-04"]), ctxFor([done("2026-10-03")]));
		const entry = (d: string) => layout.allDay.get(d)![0] as { past: boolean; occurrence: string };
		expect(entry("2026-10-03")).toMatchObject({ occurrence: "done", past: false });
		expect(entry("2026-10-04")).toMatchObject({ occurrence: "current", past: true });
	});

	it("an ended series shows its records only", () => {
		const t = repeating(series("2026-10-01", rule(), { kind: "never" }, "2026-10-04T10:00:00.000Z"));
		const days = weekDays("2026-09-30", "MO");
		const k = kinds(t, days, ctxFor([done("2026-10-01"), done("2026-10-02"), skipped("2026-10-03")]));
		expect(k).toEqual({ "2026-10-01": ["done"], "2026-10-02": ["done"] });
	});

	it("a date end stops the projection", () => {
		const t = repeating(series("2026-10-05", rule(), { kind: "date", date: "2026-10-07" }));
		expect(Object.keys(kinds(t, WEEK, ctxFor()))).toEqual(["2026-10-05", "2026-10-06", "2026-10-07"]);
	});
});

describe("after completion", () => {
	it("shows only the next date, and the done ones (done early: the next date is earlier than the done record)", () => {
		const t = repeating(series("2026-10-10", rule({ interval: 3, afterCompletion: true })));
		// Due Oct 10, done on Oct 5: the next date is Oct 8 (completion day + 3), before the done record's date.
		const k = kinds(t, WEEK, ctxFor([done("2026-10-10", "2026-10-05")]));
		expect(k).toEqual({ "2026-10-08": ["current"], "2026-10-10": ["done"] });
		// Nothing is projected past the next date.
		expect(kinds(t, weekDays("2026-10-12", "MO"), ctxFor([done("2026-10-10", "2026-10-05")]))).toEqual({});
	});
});

describe("timed series and DST", () => {
	const nine = rule({ time: "09:00", tz: BERLIN });

	it("keeps 09:00 wall time across the European DST days (Oct 25 and Mar 29)", () => {
		const t = repeating(series("2026-10-23", nine));
		const days = dateRange("2026-10-23", "2026-10-29");
		const c = ctxFor([], "2026-10-23");
		const layout = layoutWeek([t], days, c);
		for (const d of days) expect(layout.timed.get(d)).toMatchObject([{ startMin: 540, endLocal: "09:30" }]);
		const spring = repeating(series("2026-03-27", nine));
		const sd = dateRange("2026-03-27", "2026-04-02");
		const sl = layoutWeek([spring], sd, ctxFor([], "2026-03-27"));
		for (const d of sd) expect(sl.timed.get(d)).toMatchObject([{ startMin: 540 }]);
	});

	it("shows a series stored in another zone at the display-zone wall time", () => {
		// 09:00 in New York is 15:00 in Berlin in October (both on summer time) and 15:00 again after Berlin
		// moves back on Oct 25 only when New York also did: here NY is still on summer time, Berlin is not.
		const t = repeating(series("2026-10-23", rule({ time: "09:00", tz: "America/New_York" })));
		const layout = layoutWeek([t], ["2026-10-23", "2026-10-26"], ctxFor([], "2026-10-23"));
		expect(layout.timed.get("2026-10-23")![0]!.startMin).toBe(15 * 60);
		expect(layout.timed.get("2026-10-26")![0]!.startMin).toBe(14 * 60);
	});

	it("a timed occurrence is past once its end has passed, a done one never", () => {
		const t = repeating(series("2026-10-05", nine), { plannedDurationMin: 60 });
		const c = ctxFor([done("2026-10-05")], "2026-10-06");
		const layout = layoutWeek([t], ["2026-10-05", "2026-10-06"], { ...c, now: "2026-10-06T12:00:00.000Z" });
		expect(layout.timed.get("2026-10-05")![0]).toMatchObject({ occurrence: "done", past: false });
		expect(layout.timed.get("2026-10-06")![0]).toMatchObject({ occurrence: "current", past: true });
	});
});

describe("month grids", () => {
	function monthCounts(t: Task, anchor: string): Record<string, number> {
		const grid = monthGrid(anchor, "MO");
		const cells = layoutMonth([t], grid, anchor.slice(0, 7), ctxFor([], "2026-01-01")).flat();
		return Object.fromEntries(cells.filter((c) => c.count > 0 && c.inMonth).map((c) => [c.date, c.count]));
	}

	it("monthly on the 31st: February and April fall on their last day (B21), never chained", () => {
		const t = repeating(series("2026-01-31", rule({ freq: "monthly" })));
		expect(monthCounts(t, "2026-02-01")).toEqual({ "2026-02-28": 1 });
		expect(monthCounts(t, "2026-03-01")).toEqual({ "2026-03-31": 1 });
		expect(monthCounts(t, "2026-04-01")).toEqual({ "2026-04-30": 1 });
		const leap = repeating(series("2027-12-31", rule({ freq: "monthly" })));
		expect(monthCounts(leap, "2028-02-01")).toEqual({ "2028-02-29": 1 });
	});

	it("a month cell counts the occurrence once, and shows it with its kind", () => {
		const t = repeating(series("2026-10-05", rule({ freq: "weekly", weekdays: ["MO"] })));
		const cells = layoutMonth([t], monthGrid("2026-10-01", "MO"), "2026-10", ctxFor()).flat();
		const mondays = cells.filter((c) => c.count > 0 && c.inMonth).map((c) => [c.date, (c.shown[0] as { occurrence: string }).occurrence]);
		expect(mondays).toEqual([["2026-10-05", "current"], ["2026-10-12", "future"], ["2026-10-19", "future"], ["2026-10-26", "future"]]);
	});
});

describe("the Completed rows do not depend on date order", () => {
	it("orders done occurrences by resolvedAt even when a later resolution has an earlier date", () => {
		const t = repeating(series("2026-10-10", rule({ interval: 3, afterCompletion: true })));
		const late = { ...done("2026-10-10", "2026-10-05"), resolvedAt: "2026-10-05T10:00:00.000Z" };
		const early = { ...done("2026-10-08", "2026-10-08"), resolvedAt: "2026-10-08T10:00:00.000Z" };
		const ctx = { today: "2026-10-09", zone: BERLIN, upcomingDays: 14, weekStart: "MO" as const };
		const rows = completedRows([], [{ task: t, record: late }, { task: t, record: early }], new Map([[t.id, t]]), ctx);
		expect(rows.map((r) => r.occurrence!.date)).toEqual(["2026-10-08", "2026-10-10"]);
	});
});
