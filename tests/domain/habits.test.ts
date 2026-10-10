import { describe, expect, it } from "vitest";
import { monthGrid, weekStartOf } from "../../src/domain/calendar";
import {
	dayShare,
	dayStatus,
	describeGoal,
	describeSchedule,
	groupHabits,
	type HabitInput,
	indexCheckins,
	isScheduled,
	monthCells,
	monthStats,
	nextVersion,
	periodOf,
	progressOn,
	streaks,
	timeOfDayNow,
	total,
	validateHabitInput,
	versionAt,
} from "../../src/domain/habits";
import type { HabitSchedule } from "../../src/domain/types";
import { ci, dates, habit, idx, ver } from "./habit-fixtures";

// The habit evaluator.
// October 2026 starts on a Thursday; 2026-10-04 is a Sunday and 2026-10-05 a Monday.

const MWF: HabitSchedule = { kind: "weekdays", days: ["MO", "WE", "FR"] };

describe("versions and schedules (D5)", () => {
	const h = habit("h", [ver("2026-09-01", { type: "quantity", target: 30, unit: "min" }), ver("2026-10-01", { type: "quantity", target: 20, unit: "min" }, MWF)]);

	it("versionAt picks the last version effective on the date, and null before the first", () => {
		expect(versionAt(h, "2026-08-31")).toBeNull();
		expect(versionAt(h, "2026-09-01")?.goal.target).toBe(30);
		expect(versionAt(h, "2026-09-30")?.goal.target).toBe(30);
		expect(versionAt(h, "2026-10-01")?.goal.target).toBe(20);
	});

	it("isScheduled follows the version of the day, never before the first version", () => {
		expect(isScheduled(h, "2026-08-31")).toBe(false);
		expect(isScheduled(h, "2026-09-29")).toBe(true); // a Tuesday under the daily version
		expect(isScheduled(h, "2026-10-06")).toBe(false); // a Tuesday under Mon, Wed, Fri
		expect(isScheduled(h, "2026-10-05")).toBe(true);
		expect(isScheduled(habit("w", [ver("2026-10-01", { period: "week", target: 3 }, { kind: "weekly" })]), "2026-10-04")).toBe(true);
	});

	it("periodOf: a day, or a week by the version's weekStart", () => {
		expect(periodOf(h, "2026-10-07")).toMatchObject({ start: "2026-10-07", end: "2026-10-07" });
		expect(periodOf(h, "2026-08-01")).toBeNull();
		const mo = habit("w", [ver("2026-09-01", { period: "week", target: 3 }, { kind: "weekly" }, "MO")]);
		const su = habit("w", [ver("2026-09-01", { period: "week", target: 3 }, { kind: "weekly" }, "SU")]);
		expect(periodOf(mo, "2026-10-07")).toMatchObject({ start: "2026-10-05", end: "2026-10-11" });
		expect(periodOf(su, "2026-10-07")).toMatchObject({ start: "2026-10-04", end: "2026-10-10" });
	});

	it("periodOf: a week is cut at the first version and before the next one", () => {
		const w = habit("w", [
			ver("2026-10-07", { period: "week", target: 3 }, { kind: "weekly" }, "MO"),
			ver("2026-10-11", { period: "week", target: 2 }, { kind: "weekly" }, "SU"),
		]);
		expect(periodOf(w, "2026-10-08")).toMatchObject({ start: "2026-10-07", end: "2026-10-10" });
		expect(periodOf(w, "2026-10-12")).toMatchObject({ start: "2026-10-11", end: "2026-10-17" });
		expect(periodOf(w, "2026-10-12")?.version.goal.target).toBe(2);
	});

	it("periodOf weeks agree with the calendar's weekStartOf", () => {
		for (const ws of ["MO", "SU", "SA"] as const) {
			const w = habit("w", [ver("2020-01-01", { period: "week", target: 1 }, { kind: "weekly" }, ws)]);
			for (const d of dates("2026-10-20", "2026-11-03")) expect(periodOf(w, d)?.start).toBe(weekStartOf(d, ws));
		}
	});
});

describe("check-in index", () => {
	it("keeps active check-ins only, by habit and date, sorted", () => {
		const a = ci("h", "2026-10-02", 5);
		const b = ci("h", "2026-10-01", 3);
		const gone = ci("h", "2026-10-01", 9, { deletedAt: "2026-10-01T21:00:00.000Z" });
		const other = ci("x", "2026-10-01", 1);
		const index = idx(a, b, gone, other);
		expect(index.active("h").map((c) => c.id)).toEqual([b.id, a.id]);
		expect(index.byDate("h").get("2026-10-01")).toEqual([b]);
		expect(index.byDate("nobody").size).toBe(0);
		expect(index.active("nobody")).toEqual([]);
	});
});

describe("progress (HAB-04, HAB-05, HAB-06)", () => {
	it("sums count and quantity check-ins in the period", () => {
		const h = habit("h", [ver("2026-09-01", { type: "quantity", target: 30, unit: "min" })]);
		const p = progressOn(h, idx(ci("h", "2026-10-04", 20), ci("h", "2026-10-04", 10), ci("h", "2026-10-03", 99)), "2026-10-04");
		expect(p).toMatchObject({ value: 30, target: 30, met: true, period: { start: "2026-10-04", end: "2026-10-04" } });
	});

	it("rounds sums to 6 decimals, so 0.7 + 0.1 meets 0.8", () => {
		const h = habit("h", [ver("2026-09-01", { type: "quantity", target: 0.8, unit: "km" })]);
		expect(progressOn(h, idx(ci("h", "2026-10-04", 0.7), ci("h", "2026-10-04", 0.1)), "2026-10-04")?.met).toBe(true);
	});

	it("HAB-06: two active binary check-ins on one date count as one", () => {
		const day = habit("h", [ver("2026-09-01")]);
		const index = idx(ci("h", "2026-10-04"), ci("h", "2026-10-04"));
		expect(progressOn(day, index, "2026-10-04")).toMatchObject({ value: 1, met: true });
		const week = habit("h", [ver("2026-09-01", { period: "week", target: 2 }, { kind: "weekly" })]);
		expect(progressOn(week, index, "2026-10-04")).toMatchObject({ value: 1, met: false });
		expect(total(day, index)).toBe(1);
	});

	it("a week period sums the whole week", () => {
		const h = habit("h", [ver("2026-09-01", { type: "count", target: 3, period: "week" }, { kind: "weekly" })]);
		const index = idx(ci("h", "2026-10-05"), ci("h", "2026-10-07"), ci("h", "2026-10-11"), ci("h", "2026-10-12"));
		expect(progressOn(h, index, "2026-10-06")).toMatchObject({ value: 3, met: true });
		expect(progressOn(h, index, "2026-10-12")).toMatchObject({ value: 1, met: false });
	});

	it("is null before the first version", () => {
		expect(progressOn(habit("h", [ver("2026-10-01")]), idx(), "2026-09-30")).toBeNull();
	});
});

describe("day status (D7)", () => {
	const today = "2026-10-07";

	it("day period: met, partial, missed, off, future, before", () => {
		const h = habit("h", [ver("2026-10-01", { type: "count", target: 2 }, MWF)]);
		const index = idx(ci("h", "2026-10-02"), ci("h", "2026-10-02"), ci("h", "2026-10-05"));
		expect(dayStatus(h, index, "2026-10-02", today)).toBe("met");
		expect(dayStatus(h, index, "2026-10-05", today)).toBe("partial");
		expect(dayStatus(h, index, "2026-10-07", today)).toBe("missed"); // today, scheduled, nothing yet
		expect(dayStatus(h, index, "2026-10-06", today)).toBe("off");
		expect(dayStatus(h, index, "2026-10-09", today)).toBe("future");
		expect(dayStatus(h, index, "2026-09-30", today)).toBe("before");
	});

	it("an unscheduled day is off even with a check-in", () => {
		const h = habit("h", [ver("2026-10-01", {}, MWF)]);
		expect(dayStatus(h, idx(ci("h", "2026-10-06")), "2026-10-06", today)).toBe("off");
	});

	it("week period: days with a check-in show the week's state; days without are missed only when the week is over and not met", () => {
		const h = habit("h", [ver("2026-09-28", { type: "count", target: 2, period: "week" }, { kind: "weekly" })]);
		// Week Sep 28 - Oct 4: two check-ins, met. Week Oct 5 - 11 (current): one so far.
		// Week Sep 21 does not exist (before). Week of Sep 28 is over and met.
		const index = idx(ci("h", "2026-09-29"), ci("h", "2026-10-01"), ci("h", "2026-10-06"));
		expect(dayStatus(h, index, "2026-09-29", today)).toBe("met");
		expect(dayStatus(h, index, "2026-09-30", today)).toBe("off"); // no check-in, week met
		expect(dayStatus(h, index, "2026-10-06", today)).toBe("partial");
		expect(dayStatus(h, index, "2026-10-05", today)).toBe("off"); // the current week is not over
		const missedWeek = idx(ci("h", "2026-09-29"), ci("h", "2026-10-06"));
		expect(dayStatus(h, missedWeek, "2026-09-30", today)).toBe("missed");
		expect(dayStatus(h, missedWeek, "2026-09-29", today)).toBe("partial");
	});
});

describe("streaks (HAB-08, D6)", () => {
	it("daily: unscheduled days are skipped and the unfinished day never breaks the streak", () => {
		const h = habit("h", [ver("2026-09-01", {}, MWF)]);
		// Met on Mon 28, Wed 30, Fri 2, Mon 5; today Wed 7 not done yet.
		const index = idx(...["2026-09-28", "2026-09-30", "2026-10-02", "2026-10-05"].map((d) => ci("h", d)));
		expect(streaks(h, index, "2026-10-07")).toEqual({ current: 4, best: 4, unit: "days" });
		const done = idx(...["2026-09-28", "2026-09-30", "2026-10-02", "2026-10-05", "2026-10-07"].map((d) => ci("h", d)));
		expect(streaks(h, done, "2026-10-07").current).toBe(5);
	});

	it("a missed scheduled day ends the walk; best keeps the longest run", () => {
		const h = habit("h", [ver("2026-09-01")]);
		const met = [...dates("2026-09-10", "2026-09-14"), ...dates("2026-10-01", "2026-10-03")];
		expect(streaks(h, idx(...met.map((d) => ci("h", d))), "2026-10-04")).toEqual({ current: 3, best: 5, unit: "days" });
	});

	it("weekly: weekStart MO and SU give different weeks", () => {
		// Today Wed Oct 14. Check-ins on Mon Oct 5 and Sun Oct 11, target 2 a week.
		const index = idx(ci("h", "2026-10-05"), ci("h", "2026-10-11"));
		const mo = habit("h", [ver("2026-09-01", { target: 2, period: "week" }, { kind: "weekly" }, "MO")]);
		const su = habit("h", [ver("2026-09-01", { target: 2, period: "week" }, { kind: "weekly" }, "SU")]);
		expect(streaks(mo, index, "2026-10-14")).toEqual({ current: 1, best: 1, unit: "weeks" });
		expect(streaks(su, index, "2026-10-14")).toEqual({ current: 0, best: 0, unit: "weeks" });
	});

	it("weekly: the current week counts when met and is skipped when not", () => {
		const h = habit("h", [ver("2026-09-01", { type: "count", target: 2, period: "week" }, { kind: "weekly" })]);
		const past = [ci("h", "2026-09-22"), ci("h", "2026-09-23"), ci("h", "2026-09-29"), ci("h", "2026-09-30")];
		expect(streaks(h, idx(...past), "2026-10-07").current).toBe(2);
		expect(streaks(h, idx(...past, ci("h", "2026-10-05"), ci("h", "2026-10-06")), "2026-10-07").current).toBe(3);
	});

	it("a first week cut short by the creation date is skipped when not met", () => {
		// Created Wed Sep 16; that first week (Sep 16-20) had one of three.
		const h = habit("h", [ver("2026-09-16", { type: "count", target: 3, period: "week" }, { kind: "weekly" })]);
		const index = idx(ci("h", "2026-09-17"), ...["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-28", "2026-09-29", "2026-09-30"].map((d) => ci("h", d)));
		expect(streaks(h, index, "2026-10-02")).toEqual({ current: 2, best: 2, unit: "weeks" });
	});

	it("a schedule change mid-history keeps the walk going when the unit stays (D5)", () => {
		// Daily until Oct 1, then Mon, Wed, Fri. Every scheduled day met.
		const h = habit("h", [ver("2026-09-25"), ver("2026-10-01", {}, MWF)]);
		const met = [...dates("2026-09-25", "2026-09-30"), "2026-10-02", "2026-10-05"];
		expect(streaks(h, idx(...met.map((d) => ci("h", d))), "2026-10-06")).toEqual({ current: 8, best: 8, unit: "days" });
	});

	it("a change of period counts the current unit only: older periods of the other unit end the walk", () => {
		const h = habit("h", [ver("2026-09-01"), ver("2026-09-28", { target: 2, period: "week" }, { kind: "weekly" })]);
		const met = [...dates("2026-09-01", "2026-09-27"), "2026-09-29", "2026-09-30", "2026-10-06", "2026-10-07"];
		expect(streaks(h, idx(...met.map((d) => ci("h", d))), "2026-10-08")).toEqual({ current: 2, best: 2, unit: "weeks" });
	});

	it("is zero before the first version", () => {
		expect(streaks(habit("h", [ver("2026-10-10")]), idx(), "2026-10-04")).toEqual({ current: 0, best: 0, unit: "days" });
	});
});

describe("totals (D7)", () => {
	it("sums the active check-ins", () => {
		const h = habit("h", [ver("2026-09-01", { type: "quantity", target: 30, unit: "min" })]);
		const index = idx(ci("h", "2026-10-01", 20), ci("h", "2026-10-02", 12.5), ci("h", "2026-10-02", 100, { deletedAt: "2026-10-02T21:00:00.000Z" }));
		expect(total(h, index)).toBe(32.5);
	});
});

describe("month stats and cells (D7)", () => {
	it("a day habit reads n of m scheduled days so far (mockup: 3 of 4 days on Oct 4)", () => {
		const h = habit("h", [ver("2026-09-01", { type: "quantity", target: 30, unit: "min" })]);
		const index = idx(ci("h", "2026-10-01", 30), ci("h", "2026-10-02", 30), ci("h", "2026-10-03", 30), ci("h", "2026-10-04", 20));
		expect(monthStats(h, index, "2026-10", "2026-10-04")).toEqual({ met: 3, of: 4, unit: "days" });
		expect(monthStats(h, index, "2026-11", "2026-10-04")).toEqual({ met: 0, of: 0, unit: "days" });
		expect(monthStats(h, index, "2026-08", "2026-10-04")).toEqual({ met: 0, of: 0, unit: "days" });
	});

	it("counts only scheduled days", () => {
		const h = habit("h", [ver("2026-09-01", {}, MWF)]);
		// Oct 1-9: Fri 2, Mon 5, Wed 7, Fri 9 are scheduled.
		expect(monthStats(h, idx(ci("h", "2026-10-02"), ci("h", "2026-10-07")), "2026-10", "2026-10-09")).toEqual({ met: 2, of: 4, unit: "days" });
	});

	it("a week habit reads n of m weeks that start in the month, under each week start", () => {
		const index = idx(ci("h", "2026-10-05"), ci("h", "2026-10-06"), ci("h", "2026-10-11"), ci("h", "2026-10-12"));
		const mk = (ws: "MO" | "SU" | "SA") => habit("h", [ver("2026-09-01", { target: 2, period: "week" }, { kind: "weekly" }, ws)]);
		// MO: weeks of Oct 5 (met) and Oct 12 (current, 1 of 2).
		expect(monthStats(mk("MO"), index, "2026-10", "2026-10-14")).toEqual({ met: 1, of: 2, unit: "weeks" });
		// SU: weeks of Oct 4 (5, 6: met) and Oct 11 (11, 12: met).
		expect(monthStats(mk("SU"), index, "2026-10", "2026-10-14")).toEqual({ met: 2, of: 2, unit: "weeks" });
		// SA: weeks of Oct 3 (5, 6: met) and Oct 10 (11, 12: met).
		expect(monthStats(mk("SA"), index, "2026-10", "2026-10-14")).toEqual({ met: 2, of: 2, unit: "weeks" });
	});

	it("monthCells lays out a month that starts mid-week under each week start", () => {
		const h = habit("h", [ver("2026-10-02")]);
		const index = idx(ci("h", "2026-10-03"));
		const mo = monthCells(h, index, "2026-10", "2026-10-04", "MO");
		expect(mo).toHaveLength(monthGrid("2026-10-01", "MO").length);
		expect(mo[0]!.map((c) => c.date)).toEqual([null, null, null, "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
		expect(mo[0]!.map((c) => c.status)).toEqual([null, null, null, "before", "missed", "met", "missed"]);
		expect(mo[1]![0]).toEqual({ date: "2026-10-05", status: "future" });
		expect(mo[mo.length - 1]!.filter((c) => c.date !== null).at(-1)?.date).toBe("2026-10-31");
		const su = monthCells(h, index, "2026-10", "2026-10-04", "SU");
		expect(su).toHaveLength(monthGrid("2026-10-01", "SU").length);
		expect(su[0]!.map((c) => c.date)).toEqual([null, null, null, null, "2026-10-01", "2026-10-02", "2026-10-03"]);
		const sa = monthCells(h, index, "2026-10", "2026-10-04", "SA");
		expect(sa).toHaveLength(6);
		expect(sa).toHaveLength(monthGrid("2026-10-01", "SA").length);
		expect(sa[0]!.map((c) => c.date)).toEqual([null, null, null, null, null, "2026-10-01", "2026-10-02"]);
		expect(sa[5]!.map((c) => c.date)).toEqual(["2026-10-31", null, null, null, null, null, null]);
	});
});

describe("day share for the strip ring (D7)", () => {
	it("mixes day and week habits; a week habit is scheduled every day and met on a day with a check-in", () => {
		const date = "2026-10-06"; // Tuesday
		const daily = habit("a", [ver("2026-09-01")]);
		const count = habit("b", [ver("2026-09-01", { type: "count", target: 8 })]);
		const mwf = habit("c", [ver("2026-09-01", {}, MWF)]);
		const weekWith = habit("d", [ver("2026-09-01", { target: 3, period: "week" }, { kind: "weekly" })]);
		const weekWithout = habit("e", [ver("2026-09-01", { target: 3, period: "week" }, { kind: "weekly" })]);
		const archived = habit("f", [ver("2026-09-01")], { archivedAt: "2026-10-01T09:00:00.000Z" });
		const index = idx(ci("a", date), ci("b", date, 5), ci("d", date), ci("e", "2026-10-05"), ci("f", date));
		const all = [daily, count, mwf, weekWith, weekWithout, archived];
		expect(dayShare(all.filter((h) => h.archivedAt === null), index, date, date)).toEqual({ met: 2, scheduled: 4 });
		expect(dayShare(all, index, date, date)).toEqual({ met: 3, scheduled: 5 });
	});

	it("a day before every habit's start has nothing scheduled", () => {
		expect(dayShare([habit("a", [ver("2026-10-05")])], idx(), "2026-10-04", "2026-10-06")).toEqual({ met: 0, scheduled: 0 });
	});
});

describe("time of day (D11)", () => {
	it.each([
		["04:59", "evening"],
		["05:00", "morning"],
		["11:59", "morning"],
		["12:00", "afternoon"],
		["19:59", "afternoon"],
		["20:00", "evening"],
		["23:59", "evening"],
		["00:00", "evening"],
	] as const)("%s is %s with the default Evening time", (time, expected) => {
		expect(timeOfDayNow(time, "20:00")).toBe(expected);
	});

	it("follows the Evening time setting", () => {
		expect(timeOfDayNow("18:30", "18:30")).toBe("evening");
		expect(timeOfDayNow("18:29", "18:30")).toBe("afternoon");
	});

	it("groupHabits orders Morning, Afternoon, Evening, Anytime, by sortKey, and drops empty groups", () => {
		const hs = [
			habit("1", [ver("2026-09-01")], { timeOfDay: "anytime", sortKey: "b" }),
			habit("2", [ver("2026-09-01")], { timeOfDay: "evening", sortKey: "c" }),
			habit("3", [ver("2026-09-01")], { timeOfDay: "anytime", sortKey: "a" }),
			habit("4", [ver("2026-09-01")], { timeOfDay: "morning", sortKey: "d" }),
		];
		expect(groupHabits(hs).map((g) => [g.timeOfDay, g.habits.map((h) => h.id)])).toEqual([
			["morning", ["4"]],
			["evening", ["2"]],
			["anytime", ["3", "1"]],
		]);
	});
});

describe("dialog rules (D20)", () => {
	const base: HabitInput = {
		name: "Read",
		icon: null,
		color: null,
		timeOfDay: "anytime",
		reminder: null,
		goal: { type: "quantity", target: 30, unit: "min", period: "day" },
		schedule: { kind: "daily" },
	};
	const goal = (g: Partial<HabitInput["goal"]>) => ({ ...base, goal: { ...base.goal, ...g } });

	it("accepts a valid habit", () => {
		expect(validateHabitInput(base)).toBeNull();
		expect(validateHabitInput({ ...base, reminder: { time: "07:30" } })).toBeNull();
		expect(validateHabitInput(goal({ type: "count", target: 8, unit: null }))).toBeNull();
		expect(validateHabitInput(goal({ type: "quantity", target: 2.5, unit: "km" }))).toBeNull();
	});

	it("returns the message for each rule", () => {
		expect(validateHabitInput({ ...base, name: "   " })).toBe("Enter a name.");
		expect(validateHabitInput(goal({ unit: null }))).toBe("Enter a unit, like min or km.");
		expect(validateHabitInput(goal({ unit: "  " }))).toBe("Enter a unit, like min or km.");
		expect(validateHabitInput(goal({ target: 0 }))).toBe("The goal must be a number above 0.");
		expect(validateHabitInput(goal({ target: -3 }))).toBe("The goal must be a number above 0.");
		expect(validateHabitInput(goal({ target: Number.NaN }))).toBe("The goal must be a number above 0.");
		expect(validateHabitInput(goal({ type: "count", target: 2.5, unit: null }))).toBe("A count goal must be a whole number.");
		expect(validateHabitInput(goal({ unit: "thirteen char" }))).toBe("Keep the unit to 12 characters or fewer.");
		expect(validateHabitInput({ ...base, schedule: { kind: "weekdays", days: [] } })).toBe("Pick at least one day.");
		expect(validateHabitInput({ ...base, reminder: { time: "25:00" } })).toBe("Enter the reminder time as HH:MM.");
		expect(validateHabitInput({ ...base, reminder: { time: "7:30" } })).toBe("Enter the reminder time as HH:MM.");
	});
});

describe("nextVersion (D5, HAB-09)", () => {
	const q = (target: number) => ({ type: "quantity" as const, target, unit: "min", period: "day" as const });
	const h = habit("h", [ver("2026-09-01", q(30))]);

	it("appends a version from today for a day period", () => {
		const vs = nextVersion(h, q(20), { kind: "daily" }, "MO", "2026-10-05");
		expect(vs.map((v) => [v.effectiveFrom, v.goal.target])).toEqual([
			["2026-09-01", 30],
			["2026-10-05", 20],
		]);
	});

	it("an edit on the same effectiveFrom replaces instead of stacking", () => {
		const once = habit("h", nextVersion(h, q(20), { kind: "daily" }, "MO", "2026-10-05"));
		const twice = nextVersion(once, q(25), { kind: "daily" }, "MO", "2026-10-05");
		expect(twice.map((v) => [v.effectiveFrom, v.goal.target])).toEqual([
			["2026-09-01", 30],
			["2026-10-05", 25],
		]);
	});

	it("a same-day edit back to the earlier rule removes the day's version", () => {
		const once = habit("h", nextVersion(h, q(20), { kind: "daily" }, "MO", "2026-10-05"));
		expect(nextVersion(once, q(30), { kind: "daily" }, "MO", "2026-10-05")).toEqual(h.versions);
	});

	it("a week period starts at the start of the current week by the new weekStart", () => {
		const w = { type: "count" as const, target: 3, unit: null, period: "week" as const };
		expect(nextVersion(h, w, { kind: "weekly" }, "MO", "2026-10-07").at(-1)).toMatchObject({ effectiveFrom: "2026-10-05", weekStart: "MO" });
		expect(nextVersion(h, w, { kind: "weekly" }, "SU", "2026-10-07").at(-1)).toMatchObject({ effectiveFrom: "2026-10-04", weekStart: "SU" });
	});

	it("never moves the start before the first version", () => {
		const fresh = habit("h", [ver("2026-10-07", q(30))]);
		const w = { type: "count" as const, target: 3, unit: null, period: "week" as const };
		const vs = nextVersion(fresh, w, { kind: "weekly" }, "MO", "2026-10-07");
		expect(vs).toHaveLength(1);
		expect(vs[0]).toMatchObject({ effectiveFrom: "2026-10-07", goal: w });
	});
});

describe("texts (mockup)", () => {
	it("describeGoal", () => {
		expect(describeGoal(ver("2026-09-01", { type: "quantity", target: 30, unit: "min" }))).toBe("30 min a day");
		expect(describeGoal(ver("2026-09-01", { type: "count", target: 8, unit: "glasses" }))).toBe("8 glasses a day");
		expect(describeGoal(ver("2026-09-01", { type: "binary", target: 3, period: "week" }, { kind: "weekly" }))).toBe("3 times a week");
		expect(describeGoal(ver("2026-09-01", { type: "count", target: 50 }))).toBe("50 times a day");
		expect(describeGoal(ver("2026-09-01"))).toBe("once a day");
		expect(describeGoal(ver("2026-09-01", { type: "quantity", target: 2.5, unit: "km", period: "week" }))).toBe("2.5 km a week");
	});

	it("describeSchedule", () => {
		expect(describeSchedule(ver("2026-09-01"))).toBe("every day");
		expect(describeSchedule(ver("2026-09-01", {}, { kind: "weekdays", days: ["FR", "MO", "WE"] }))).toBe("Mon, Wed, Fri");
		expect(describeSchedule(ver("2026-09-01", {}, { kind: "weekdays", days: ["MO", "SU"] }, "SU"))).toBe("Sun, Mon");
		expect(describeSchedule(ver("2026-09-01", {}, { kind: "weekdays", days: ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] }))).toBe("every day");
		expect(describeSchedule(ver("2026-09-01", { period: "week", target: 3 }, { kind: "weekly" }))).toBe("any days");
	});
});

describe("indexCheckins input", () => {
	it("accepts any ReadonlyMap", () => {
		expect(indexCheckins(new Map()).active("x")).toEqual([]);
	});
});

// -- edge cases -----------------------------

describe("review #1: a week-start edit never cuts a finished week (HAB-09, spec §21.1 item 5, D5)", () => {
	// Today Wed Oct 7. Weekly count habit on MO weeks: Sep 21-27 met, Sep 28 - Oct 4 met (Mon 28 and Sun 4).
	const today = "2026-10-07";
	const h = habit("h", [ver("2026-09-01", { type: "count", target: 2, period: "week" }, { kind: "weekly" }, "MO")]);
	const index = idx(ci("h", "2026-09-22"), ci("h", "2026-09-24"), ci("h", "2026-09-28"), ci("h", "2026-10-04"), ci("h", "2026-10-06"));
	const goal = { type: "count" as const, target: 3, unit: null, period: "week" as const };

	it.each(["SU", "SA"] as const)("MO to %s on a Wednesday: the new version starts at the current period, the finished week is unchanged", (ws) => {
		const versions = nextVersion(h, goal, { kind: "weekly" }, ws, today);
		expect(versions.map((v) => [v.effectiveFrom, v.weekStart])).toEqual([
			["2026-09-01", "MO"],
			["2026-10-05", ws],
		]);
		const edited = habit("h", versions);
		for (const d of dates("2026-09-21", "2026-10-04")) expect([d, dayStatus(edited, index, d, today)]).toEqual([d, dayStatus(h, index, d, today)]);
		expect(dayStatus(edited, index, "2026-09-28", today)).toBe("met");
		expect(streaks(edited, index, today)).toEqual(streaks(h, index, today));
		expect(streaks(edited, index, today).current).toBe(2);
		expect(monthStats(edited, index, "2026-09", today)).toEqual(monthStats(h, index, "2026-09", today));
		// The new version's first week is cut short at Oct 5.
		expect(periodOf(edited, today)).toMatchObject({ start: "2026-10-05", end: ws === "SU" ? "2026-10-10" : "2026-10-09" });
	});

	it("a day-period version added earlier this week is replaced by a week-period edit mid-week", () => {
		const d = habit("d", [ver("2026-09-01", { type: "count", target: 8 }), ver("2026-10-06", { type: "count", target: 5 })]);
		const versions = nextVersion(d, goal, { kind: "weekly" }, "MO", today);
		expect(versions.map((v) => [v.effectiveFrom, v.goal.period, v.goal.target])).toEqual([
			["2026-09-01", "day", 8],
			["2026-10-05", "week", 3],
		]);
	});

	it("a day-period habit changed to a week period on a new week start still starts at that week (D5)", () => {
		// The day before the new week start is a day period, not a finished week, so nothing is clamped.
		const d = habit("d", [ver("2026-09-01", { type: "count", target: 8 })]);
		expect(nextVersion(d, goal, { kind: "weekly" }, "SU", today).at(-1)?.effectiveFrom).toBe("2026-10-04");
	});
});

describe("review #9: streaks across a week-start split", () => {
	// MO weeks until Oct 4, SU weeks from Mon Oct 5: the SU week Oct 4-10 is cut short to Oct 5-10.
	const h = habit("h", [
		ver("2026-09-01", { type: "count", target: 2, period: "week" }, { kind: "weekly" }, "MO"),
		ver("2026-10-05", { type: "count", target: 2, period: "week" }, { kind: "weekly" }, "SU"),
	]);
	const base = ["2026-09-21", "2026-09-22", "2026-09-28", "2026-10-04", "2026-10-11", "2026-10-12"];

	it("counts the cut-short week when met", () => {
		const index = idx(...[...base, "2026-10-06", "2026-10-10"].map((d) => ci("h", d)));
		expect(streaks(h, index, "2026-10-18")).toEqual({ current: 4, best: 4, unit: "weeks" });
	});

	it("skips the cut-short week when not met, and the walk goes on", () => {
		const index = idx(...[...base, "2026-10-06"].map((d) => ci("h", d)));
		expect(streaks(h, index, "2026-10-18")).toEqual({ current: 3, best: 3, unit: "weeks" });
	});
});

describe("review #5: a check-in of value 0 is not presence", () => {
	it("is left out of the index", () => {
		const zero = ci("h", "2026-10-06", 0);
		const one = ci("h", "2026-10-06", 2);
		const index = idx(zero, one);
		expect(index.active("h")).toEqual([one]);
		expect(index.byDate("h").get("2026-10-06")).toEqual([one]);
		expect(idx(zero).byDate("h").size).toBe(0);
	});

	it("a quantity 0 check-in on a week habit is neither partial nor met for the day", () => {
		const h = habit("h", [ver("2026-09-01", { type: "quantity", target: 30, unit: "km", period: "week" }, { kind: "weekly" })]);
		const index = idx(ci("h", "2026-10-06", 0));
		expect(dayStatus(h, index, "2026-10-06", "2026-10-07")).toBe("off");
		expect(dayShare([h], index, "2026-10-06", "2026-10-07")).toEqual({ met: 0, scheduled: 1 });
	});

	it("a binary check-in of 0 is not met", () => {
		const day = habit("h", [ver("2026-09-01")]);
		const index = idx(ci("h", "2026-10-06", 0));
		expect(progressOn(day, index, "2026-10-06")).toMatchObject({ value: 0, met: false });
		expect(dayStatus(day, index, "2026-10-06", "2026-10-07")).toBe("missed");
		const week = habit("h", [ver("2026-09-01", { target: 1, period: "week" }, { kind: "weekly" })]);
		expect(progressOn(week, index, "2026-10-06")).toMatchObject({ value: 0, met: false });
		expect(total(day, index)).toBe(0);
	});
});

describe("review #6: a binary week target above 7 can never be met", () => {
	it("is refused", () => {
		const input: HabitInput = {
			name: "Gym",
			icon: null,
			color: null,
			timeOfDay: "anytime",
			reminder: null,
			goal: { type: "binary", target: 8, unit: null, period: "week" },
			schedule: { kind: "weekly" },
		};
		expect(validateHabitInput(input)).toBe("A week has at most 7 days.");
		expect(validateHabitInput({ ...input, goal: { ...input.goal, target: 7 } })).toBeNull();
		expect(validateHabitInput({ ...input, goal: { type: "count", target: 8, unit: null, period: "week" } })).toBeNull();
	});
});

describe("review #7: an unmet cut-short week reads the same in day status, month stats and streaks", () => {
	// "3 times a week", created on Saturday Oct 3: the creation week (MO) is Sat 3 and Sun 4.
	const h = habit("h", [ver("2026-10-03", { target: 3, period: "week" }, { kind: "weekly" }, "MO")]);

	it("its empty days are off once it has passed, and it is left out of the month's weeks", () => {
		const index = idx();
		expect(dayStatus(h, index, "2026-10-03", "2026-10-11")).toBe("off");
		expect(dayStatus(h, index, "2026-10-04", "2026-10-11")).toBe("off");
		expect(dayStatus(h, index, "2026-10-05", "2026-10-12")).toBe("missed"); // a full week is still missed
		expect(monthStats(h, index, "2026-10", "2026-10-11")).toEqual({ met: 0, of: 1, unit: "weeks" });
		expect(monthStats(h, index, "2026-10", "2026-10-12")).toEqual({ met: 0, of: 2, unit: "weeks" });
		expect(streaks(h, index, "2026-10-11")).toEqual({ current: 0, best: 0, unit: "weeks" });
	});

	it("a day with a check-in in it is partial, and a met one still counts", () => {
		expect(dayStatus(h, idx(ci("h", "2026-10-03")), "2026-10-03", "2026-10-11")).toBe("partial");
		const short = habit("h", [ver("2026-10-03", { target: 2, period: "week" }, { kind: "weekly" }, "MO")]);
		const met = idx(ci("h", "2026-10-03"), ci("h", "2026-10-04"));
		expect(monthStats(short, met, "2026-10", "2026-10-11")).toEqual({ met: 1, of: 2, unit: "weeks" });
		expect(dayStatus(short, met, "2026-10-04", "2026-10-11")).toBe("met");
	});
});
