import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	type CalendarContext,
	type TimedSegment,
	type WeekStart,
	dayHours,
	layoutMonth,
	layoutWeek,
	monthGrid,
	weekDays,
	weekStartOf,
} from "../../src/domain/calendar";
import { isDeadlineMissed } from "../../src/domain/queries";
import type { DateSpec, Task } from "../../src/domain/types";

function task(id: string, patch: Partial<Task> = {}): Task {
	return {
		id,
		title: `Task ${id}`,
		descriptionNote: null,
		categoryId: "inbox",
		tagKeys: [],
		parentId: null,
		sectionId: null,
		scheduled: null,
		deadline: null,
		plannedDurationMin: null,
		urgent: false,
		important: false,
		priority: 0,
		status: "open",
		completedAt: null,
		recurrence: null,
		sortKey: id,
		createdAt: "2026-10-01T09:00:00.000Z",
		modifiedAt: "2026-10-01T09:00:00.000Z",
		...patch,
	};
}

const date = (d: string): DateSpec => ({ kind: "date", date: d });
const at = (local: string, tz = "Europe/Berlin"): DateSpec => ({ kind: "datetime", local, tz });

// 2026-10-02 is a Friday; the week Mon Sep 28 .. Sun Oct 4 crosses a month.
const ctx: CalendarContext = { zone: "Europe/Berlin", today: "2026-10-02", now: "2026-10-02T10:00:00.000Z", weekStart: "MO", records: new Map() };
const WEEK = weekDays("2026-10-02", "MO");

function seg(layoutTasks: Task[], day: string, c: CalendarContext = ctx, days = WEEK): TimedSegment[] {
	return layoutWeek(layoutTasks, days, c).timed.get(day) ?? [];
}

describe("week helpers (CAL-01)", () => {
	it("weekStartOf honors MO, SU and SA", () => {
		// Friday 2026-10-02
		expect(weekStartOf("2026-10-02", "MO")).toBe("2026-09-28");
		expect(weekStartOf("2026-10-02", "SU")).toBe("2026-09-27");
		expect(weekStartOf("2026-10-02", "SA")).toBe("2026-09-26");
		// The start day itself maps to itself.
		expect(weekStartOf("2026-09-28", "MO")).toBe("2026-09-28");
		expect(weekStartOf("2026-09-27", "SU")).toBe("2026-09-27");
		expect(weekStartOf("2026-09-26", "SA")).toBe("2026-09-26");
		// A Sunday belongs to the Monday-start week that began six days earlier.
		expect(weekStartOf("2026-10-04", "MO")).toBe("2026-09-28");
	});

	it("weekDays returns 7 consecutive dates across a month boundary", () => {
		expect(weekDays("2026-10-02", "MO")).toEqual([
			"2026-09-28",
			"2026-09-29",
			"2026-09-30",
			"2026-10-01",
			"2026-10-02",
			"2026-10-03",
			"2026-10-04",
		]);
	});

	it("weekDays crosses a year boundary for every week start", () => {
		// Friday 2027-01-01
		expect(weekDays("2027-01-01", "MO")).toEqual([
			"2026-12-28",
			"2026-12-29",
			"2026-12-30",
			"2026-12-31",
			"2027-01-01",
			"2027-01-02",
			"2027-01-03",
		]);
		expect(weekDays("2027-01-01", "SU")[0]).toBe("2026-12-27");
		expect(weekDays("2027-01-01", "SU")[6]).toBe("2027-01-02");
		expect(weekDays("2027-01-01", "SA")[0]).toBe("2026-12-26");
		expect(weekDays("2027-01-01", "SA")[6]).toBe("2027-01-01");
	});

	it("handles a leap day", () => {
		expect(weekDays("2028-02-29", "MO")).toContain("2028-03-01");
		expect(weekStartOf("2028-03-01", "SU")).toBe("2028-02-27");
	});
});

describe("monthGrid (CAL-02)", () => {
	function check(anchor: string, ws: WeekStart): string[][] {
		const grid = monthGrid(anchor, ws);
		const flat = grid.flat();
		for (const row of grid) expect(row).toHaveLength(7);
		for (let i = 1; i < flat.length; i++) {
			const prev = new Date(`${flat[i - 1]}T00:00:00Z`).getTime();
			const cur = new Date(`${flat[i]}T00:00:00Z`).getTime();
			expect(cur - prev).toBe(86_400_000);
		}
		// Covers the whole month.
		const ym = anchor.slice(0, 7);
		const inMonth = flat.filter((d) => d.startsWith(ym));
		expect(inMonth[0]).toBe(`${ym}-01`);
		expect(inMonth.length).toBeGreaterThanOrEqual(28);
		return grid;
	}

	it("October 2026 with Monday start is 5 whole weeks from Sep 28 to Nov 1", () => {
		const grid = check("2026-10-15", "MO");
		expect(grid).toHaveLength(5);
		expect(grid[0]?.[0]).toBe("2026-09-28");
		expect(grid[4]?.[6]).toBe("2026-11-01");
	});

	it("February 2026 starts on a Sunday: SU start is exactly 4 whole weeks, MO start 5", () => {
		const su = check("2026-02-10", "SU");
		expect(su).toHaveLength(4);
		expect(su[0]?.[0]).toBe("2026-02-01");
		expect(su[3]?.[6]).toBe("2026-02-28");
		const mo = check("2026-02-10", "MO");
		expect(mo).toHaveLength(5);
		expect(mo[0]?.[0]).toBe("2026-01-26");
		expect(mo[4]?.[6]).toBe("2026-03-01");
	});

	it("August 2026 (starts on Saturday) needs 6 rows with Monday start", () => {
		const grid = check("2026-08-31", "MO");
		expect(grid).toHaveLength(6);
		expect(grid[0]?.[0]).toBe("2026-07-27");
		expect(grid[5]?.[6]).toBe("2026-09-06");
	});

	it("SA start honors the week start and crosses a year boundary", () => {
		const grid = check("2026-12-01", "SA");
		expect(grid[0]?.[0]).toBe("2026-11-28");
		expect(grid.flat()).toContain("2026-12-31");
		const jan = check("2027-01-05", "SA");
		expect(jan[0]?.[0]).toBe("2026-12-26");
	});
});

describe("dayHours (D1)", () => {
	it("a normal day has 1440 minutes and no marks", () => {
		expect(dayHours("2026-10-02", "Europe/Berlin")).toEqual({
			date: "2026-10-02",
			lengthMin: 1440,
			skipped: null,
			repeated: null,
		});
	});

	it("America/New_York spring forward 2026-03-08: 23 h, 02:00-03:00 skipped", () => {
		expect(dayHours("2026-03-08", "America/New_York")).toEqual({
			date: "2026-03-08",
			lengthMin: 1380,
			skipped: { startMin: 120, endMin: 180 },
			repeated: null,
		});
	});

	it("America/New_York fall back 2026-11-01: 25 h, 01:00-02:00 repeated", () => {
		expect(dayHours("2026-11-01", "America/New_York")).toEqual({
			date: "2026-11-01",
			lengthMin: 1500,
			skipped: null,
			repeated: { startMin: 60, endMin: 120 },
		});
	});

	it("Europe/Berlin 2026-03-29 skips 02:00-03:00 and 2026-10-25 repeats 02:00-03:00", () => {
		const spring = dayHours("2026-03-29", "Europe/Berlin");
		expect(spring.lengthMin).toBe(1380);
		expect(spring.skipped).toEqual({ startMin: 120, endMin: 180 });
		expect(spring.repeated).toBeNull();
		const fall = dayHours("2026-10-25", "Europe/Berlin");
		expect(fall.lengthMin).toBe(1500);
		expect(fall.skipped).toBeNull();
		expect(fall.repeated).toEqual({ startMin: 120, endMin: 180 });
	});

	it("days next to a transition are normal", () => {
		expect(dayHours("2026-03-07", "America/New_York").lengthMin).toBe(1440);
		expect(dayHours("2026-03-09", "America/New_York").lengthMin).toBe(1440);
		expect(dayHours("2026-11-02", "America/New_York").skipped).toBeNull();
	});

	it("Asia/Tokyo has no DST, ever", () => {
		for (const d of ["2026-03-08", "2026-03-29", "2026-10-25", "2026-11-01"]) {
			expect(dayHours(d, "Asia/Tokyo")).toEqual({ date: d, lengthMin: 1440, skipped: null, repeated: null });
		}
	});

	it("derives 30-minute shifts from the offsets (Australia/Lord_Howe)", () => {
		// Spring forward: Sunday 2026-10-04 at 02:00 the clock jumps to 02:30.
		const spring = dayHours("2026-10-04", "Australia/Lord_Howe");
		expect(spring.lengthMin).toBe(1410);
		expect(spring.skipped).toEqual({ startMin: 120, endMin: 150 });
		expect(spring.repeated).toBeNull();
		// Fall back: Sunday 2026-04-05 at 02:00 the clock returns to 01:30.
		const fall = dayHours("2026-04-05", "Australia/Lord_Howe");
		expect(fall.lengthMin).toBe(1470);
		expect(fall.repeated).toEqual({ startMin: 90, endMin: 120 });
		expect(fall.skipped).toBeNull();
	});

	it.each([
		["America/Santiago", "2026-09-05", "2026-09-06"],
		["America/Havana", "2026-03-07", "2026-03-08"],
	])("the day before a gap at local midnight is a normal day (%s %s)", (zone, before, gapDay) => {
		// Midnight of the gap day does not exist, so this day runs 24 h to the first instant of the next one.
		expect(dayHours(before, zone)).toEqual({ date: before, lengthMin: 1440, skipped: null, repeated: null });
		// The gap day itself reports the missing hour from 00:00, and is 23 h long.
		const gap = dayHours(gapDay, zone);
		expect(gap.lengthMin).toBe(1380);
		expect(gap.skipped).toEqual({ startMin: 0, endMin: 60 });
		expect(gap.repeated).toBeNull();
	});

	it("a fall-back at local midnight stays in the day before (America/Santiago 2026-04-04)", () => {
		const d = dayHours("2026-04-04", "America/Santiago");
		expect(d.lengthMin).toBe(1500);
		expect(d.repeated).toEqual({ startMin: 1380, endMin: 1440 });
		expect(d.skipped).toBeNull();
	});

	it("a gap at midnight is reported from 00:00 (America/Sao_Paulo 2018-11-04)", () => {
		const d = dayHours("2018-11-04", "America/Sao_Paulo");
		expect(d.lengthMin).toBe(1380);
		expect(d.skipped).toEqual({ startMin: 0, endMin: 60 });
	});
});

describe("layoutWeek placement (CAL-03, CAL-04, CAL-05)", () => {
	it("keys allDay, timed and hours by every day, with empty arrays for empty days", () => {
		const layout = layoutWeek([], WEEK, ctx);
		expect(layout.days).toEqual(WEEK);
		expect([...layout.allDay.keys()]).toEqual(WEEK);
		expect([...layout.timed.keys()]).toEqual(WEEK);
		for (const d of WEEK) {
			expect(layout.allDay.get(d)).toEqual([]);
			expect(layout.timed.get(d)).toEqual([]);
		}
		expect(layout.hours.map((h) => h.date)).toEqual(WEEK);
	});

	it("places a timed task on its start column and wall minute", () => {
		const t = task("a", { scheduled: at("2026-10-02T19:00"), plannedDurationMin: 45 });
		const [s] = seg([t], "2026-10-02");
		expect(s).toMatchObject({
			date: "2026-10-02",
			startMin: 1140,
			endMin: 1185,
			durationMin: 45,
			noDuration: false,
			continued: false,
			column: 0,
			columns: 1,
		});
		expect(s?.task).toBe(t);
	});

	it("places date-only tasks in the all-day row and never moves them across zones (B19)", () => {
		const t = task("d", { scheduled: date("2026-10-03") });
		for (const zone of ["Pacific/Kiritimati", "Pacific/Pago_Pago", "UTC"]) {
			const layout = layoutWeek([t], WEEK, { ...ctx, zone });
			expect(layout.allDay.get("2026-10-03")).toEqual([{ kind: "date", task: t, date: "2026-10-03", past: false, occurrence: null }]);
			expect(layout.timed.get("2026-10-03")).toEqual([]);
		}
	});

	it("converts a task stored in another zone to the display zone (B19)", () => {
		// 19:00 in New York (EDT, UTC-4) is 01:00 on the next day in Berlin (CEST, UTC+2).
		const t = task("ny", { scheduled: at("2026-10-02T19:00", "America/New_York"), plannedDurationMin: 30 });
		expect(seg([t], "2026-10-02")).toEqual([]);
		const [s] = seg([t], "2026-10-03");
		expect(s?.startMin).toBe(60);
		expect(s?.endMin).toBe(90);
	});

	it("shortcuts the same-zone case without changing the result", () => {
		const t = task("same", { scheduled: at("2026-10-02T09:15", "UTC"), plannedDurationMin: 15 });
		const [s] = seg([t], "2026-10-02", { ...ctx, zone: "UTC" });
		expect(s?.startMin).toBe(555);
	});

	it("gives a task with no duration 30 minutes and flags it (CAL-05)", () => {
		const t = task("n", { scheduled: at("2026-10-02T08:00") });
		const [s] = seg([t], "2026-10-02");
		expect(s).toMatchObject({ startMin: 480, endMin: 510, durationMin: 30, noDuration: true });
	});

	it("splits a block that crosses midnight into two segments (D1)", () => {
		const t = task("late", { scheduled: at("2026-10-02T23:30"), plannedDurationMin: 60 });
		const [first] = seg([t], "2026-10-02");
		const [second] = seg([t], "2026-10-03");
		expect(first).toMatchObject({ startMin: 1410, endMin: 1440, durationMin: 60, continued: false });
		expect(second).toMatchObject({ date: "2026-10-03", startMin: 0, endMin: 30, durationMin: 60, continued: true });
	});

	it("drops the continued segment when the next day is outside the visible days", () => {
		const t = task("sun", { scheduled: at("2026-10-04T23:30"), plannedDurationMin: 60 });
		const layout = layoutWeek([t], WEEK, ctx);
		expect(layout.timed.get("2026-10-04")).toHaveLength(1);
		expect([...layout.timed.keys()]).toEqual(WEEK);
	});

	it("shows the continued part of a block that started the day before the visible days", () => {
		const t = task("pre", { scheduled: at("2026-09-27T23:00"), plannedDurationMin: 120 });
		const [s] = seg([t], "2026-09-28");
		expect(s).toMatchObject({ startMin: 0, endMin: 60, continued: true, durationMin: 120 });
	});

	it("splits a block longer than a day across several days", () => {
		const t = task("long", { scheduled: at("2026-09-30T12:00"), plannedDurationMin: 3000 });
		expect(seg([t], "2026-09-30")[0]).toMatchObject({ startMin: 720, endMin: 1440, continued: false });
		expect(seg([t], "2026-10-01")[0]).toMatchObject({ startMin: 0, endMin: 1440, continued: true });
		expect(seg([t], "2026-10-02")[0]).toMatchObject({ startMin: 0, endMin: 840, continued: true });
		expect(seg([t], "2026-10-03")).toEqual([]);
	});

	it("an absurd duration does not blow up", () => {
		const t = task("huge", { scheduled: at("2026-09-28T00:00"), plannedDurationMin: 1_000_000_000 });
		const layout = layoutWeek([t], WEEK, ctx);
		for (const d of WEEK) expect(layout.timed.get(d)).toHaveLength(1);
	});

	it("a block at 01:30 for 60 min on a fall-back day has height 60 (D1)", () => {
		const zone = "America/New_York";
		const days = ["2026-11-01"];
		const c = { zone, today: "2026-11-01", now: "2026-11-01T00:00:00.000Z", weekStart: "MO" as const, records: new Map() };
		const t = task("fb", { scheduled: at("2026-11-01T01:30", zone), plannedDurationMin: 60 });
		const [s] = seg([t], "2026-11-01", c, days);
		expect(s).toMatchObject({ startMin: 90, endMin: 150 });
		expect(layoutWeek([t], days, c).hours[0]?.repeated).toEqual({ startMin: 60, endMin: 120 });
	});

	describe("endLocal: the real end of the whole block in the display zone (DST)", () => {
		const zone = "America/New_York";
		const run = (t: Task, day: string) => {
			const c = { zone, today: day, now: "2026-01-01T00:00:00.000Z", weekStart: "MO" as const, records: new Map() };
			return layoutWeek([t], [day], c).timed.get(day) ?? [];
		};

		it("is plain wall arithmetic on a normal day", () => {
			const t = task("n", { scheduled: at("2026-10-02T19:00"), plannedDurationMin: 45 });
			expect(seg([t], "2026-10-02")[0]?.endLocal).toBe("19:45");
		});

		it("spring forward: 01:30 + 60 min ends at 03:30, not 02:30", () => {
			const t = task("s", { scheduled: at("2026-03-08T01:30", zone), plannedDurationMin: 60 });
			const [s] = run(t, "2026-03-08");
			expect(s).toMatchObject({ startMin: 90, endMin: 150, endLocal: "03:30" });
		});

		it("spring forward: a block spanning the skipped hour (01:00 + 120 min) ends at 04:00", () => {
			const t = task("s2", { scheduled: at("2026-03-08T01:00", zone), plannedDurationMin: 120 });
			expect(run(t, "2026-03-08")[0]?.endLocal).toBe("04:00");
		});

		it("fall back: 00:30 + 120 min ends at 01:30 (second occurrence), not 02:30", () => {
			const t = task("f", { scheduled: at("2026-11-01T00:30", zone), plannedDurationMin: 120 });
			const [s] = run(t, "2026-11-01");
			expect(s).toMatchObject({ startMin: 30, endMin: 150, endLocal: "01:30" });
		});

		it("fall back: a block that starts in the second occurrence of the repeated hour", () => {
			// 06:30Z is 01:30 EST, the second 01:30 of the day.
			const t = task("f2", { scheduled: { kind: "datetime", local: "2026-11-01T06:30", tz: "UTC" }, plannedDurationMin: 60 });
			const [s] = run(t, "2026-11-01");
			expect(s).toMatchObject({ startMin: 90, endMin: 150, endLocal: "02:30" });
			// 20 minutes from 01:50 EST ends at 02:10, both occurrences of 01:xx are in the same wall rows.
			const t2 = task("f3", { scheduled: { kind: "datetime", local: "2026-11-01T06:50", tz: "UTC" }, plannedDurationMin: 20 });
			expect(run(t2, "2026-11-01")[0]).toMatchObject({ startMin: 110, endLocal: "02:10" });
		});

		it("a midnight block on a spring-forward day splits and both halves carry the block's end", () => {
			// 23:30 EST on Mar 7 + 180 min = 02:30 EST = 03:30 EDT on Mar 8.
			const t = task("m", { scheduled: at("2026-03-07T23:30", zone), plannedDurationMin: 180 });
			const days = ["2026-03-07", "2026-03-08"];
			const c = { zone, today: "2026-03-07", now: "2026-01-01T00:00:00.000Z", weekStart: "MO" as const, records: new Map() };
			const layout = layoutWeek([t], days, c);
			expect(layout.timed.get("2026-03-07")?.[0]).toMatchObject({ startMin: 1410, endMin: 1440, continued: false, endLocal: "03:30" });
			expect(layout.timed.get("2026-03-08")?.[0]).toMatchObject({ startMin: 0, continued: true, endLocal: "03:30" });
		});

		it("a midnight block on a fall-back day splits and both halves carry the block's end", () => {
			// 23:30 EDT on Oct 31 + 180 min = 02:30 EDT = 01:30 EST on Nov 1.
			const t = task("m2", { scheduled: at("2026-10-31T23:30", zone), plannedDurationMin: 180 });
			const days = ["2026-10-31", "2026-11-01"];
			const c = { zone, today: "2026-10-31", now: "2026-01-01T00:00:00.000Z", weekStart: "MO" as const, records: new Map() };
			const layout = layoutWeek([t], days, c);
			expect(layout.timed.get("2026-10-31")?.[0]?.endLocal).toBe("01:30");
			expect(layout.timed.get("2026-11-01")?.[0]).toMatchObject({ continued: true, endLocal: "01:30" });
		});

		it("converts from the task's zone: 19:00 New York on Oct 2 is 01:00 Berlin, +30 min ends 01:30", () => {
			const t = task("c", { scheduled: at("2026-10-02T19:00", zone), plannedDurationMin: 30 });
			expect(seg([t], "2026-10-03")[0]?.endLocal).toBe("01:30");
		});

		it("no-duration blocks end 30 minutes after the start", () => {
			const t = task("nd", { scheduled: at("2026-10-02T08:00") });
			expect(seg([t], "2026-10-02")[0]?.endLocal).toBe("08:30");
		});
	});

	it("places subtasks like any task", () => {
		const parent = task("p", { scheduled: date("2026-10-02") });
		const sub = task("s", { parentId: "p", scheduled: at("2026-10-02T10:00") });
		const layout = layoutWeek([parent, sub], WEEK, ctx);
		expect(layout.allDay.get("2026-10-02")).toHaveLength(1);
		expect(layout.timed.get("2026-10-02")).toHaveLength(1);
	});

	it("ignores tasks outside the visible days and tasks with neither date", () => {
		const layout = layoutWeek(
			[
				task("far", { scheduled: date("2026-12-01") }),
				task("none"),
				task("farT", { scheduled: at("2026-12-01T10:00") }),
				task("farD", { deadline: date("2026-12-01") }),
			],
			WEEK,
			ctx,
		);
		for (const d of WEEK) {
			expect(layout.allDay.get(d)).toEqual([]);
			expect(layout.timed.get(d)).toEqual([]);
		}
	});

	it("accepts any iterable of tasks", () => {
		const layout = layoutWeek(new Set([task("a", { scheduled: date("2026-10-02") })]), WEEK, ctx);
		expect(layout.allDay.get("2026-10-02")).toHaveLength(1);
	});
});

describe("ordering inside a day", () => {
	it("orders all-day entries as date entries then deadlines, each by sort key", () => {
		const layout = layoutWeek(
			[
				task("b", { sortKey: "B", deadline: date("2026-10-02") }),
				task("z", { sortKey: "Z", scheduled: date("2026-10-02") }),
				task("a", { sortKey: "A", deadline: date("2026-10-02") }),
				task("m", { sortKey: "M", scheduled: date("2026-10-02") }),
			],
			WEEK,
			ctx,
		);
		const got = layout.allDay.get("2026-10-02")?.map((e) => `${e.kind}:${e.task.id}`);
		expect(got).toEqual(["date:m", "date:z", "deadline:a", "deadline:b"]);
	});

	it("orders timed segments by start, then longer first, then sort key", () => {
		const day = "2026-10-02";
		const got = seg(
			[
				task("late", { sortKey: "A", scheduled: at(`${day}T11:00`), plannedDurationMin: 60 }),
				task("shortB", { sortKey: "B", scheduled: at(`${day}T09:00`), plannedDurationMin: 30 }),
				task("long", { sortKey: "C", scheduled: at(`${day}T09:00`), plannedDurationMin: 90 }),
				task("shortA", { sortKey: "A", scheduled: at(`${day}T09:00`), plannedDurationMin: 30 }),
			],
			day,
		).map((s) => s.task.id);
		expect(got).toEqual(["long", "shortA", "shortB", "late"]);
	});
});

describe("overlap columns (CAL-04)", () => {
	const day = "2026-10-02";
	function block(id: string, startMin: number, len: number): Task {
		const h = String(Math.floor(startMin / 60)).padStart(2, "0");
		const m = String(startMin % 60).padStart(2, "0");
		return task(id, { scheduled: at(`${day}T${h}:${m}`), plannedDurationMin: len });
	}
	function cols(tasks: Task[]): Record<string, [number, number]> {
		const out: Record<string, [number, number]> = {};
		for (const s of seg(tasks, day)) out[s.task.id] = [s.column, s.columns];
		return out;
	}

	it("disjoint blocks each get one column", () => {
		expect(cols([block("a", 60, 30), block("b", 120, 30), block("c", 600, 60)])).toEqual({
			a: [0, 1],
			b: [0, 1],
			c: [0, 1],
		});
	});

	it("two overlapping blocks get 2 columns", () => {
		expect(cols([block("a", 60, 60), block("b", 90, 60)])).toEqual({ a: [0, 2], b: [1, 2] });
	});

	it("a chain A-B, B-C (A and C disjoint) uses 2 columns, A and C sharing column 0", () => {
		expect(cols([block("a", 0, 60), block("b", 30, 60), block("c", 60, 60)])).toEqual({
			a: [0, 2],
			b: [1, 2],
			c: [0, 2],
		});
	});

	it("touching blocks (end == start) do not overlap", () => {
		expect(cols([block("a", 60, 60), block("b", 120, 60)])).toEqual({ a: [0, 1], b: [0, 1] });
	});

	it("a cluster of 4 reuses columns greedily", () => {
		// a 0-120 | b 30-60 | c 60-150 | d 120-180
		// a col0; b col1; c: col0 busy until 120, col1 free at 60 -> col1; d: col0 free at 120 -> col0
		expect(cols([block("a", 0, 120), block("b", 30, 30), block("c", 60, 90), block("d", 120, 60)])).toEqual({
			a: [0, 2],
			b: [1, 2],
			c: [1, 2],
			d: [0, 2],
		});
	});

	it("separate clusters have independent column counts", () => {
		expect(
			cols([block("a", 0, 60), block("b", 30, 60), block("c", 45, 60), block("x", 300, 60), block("y", 600, 30)]),
		).toEqual({ a: [0, 3], b: [1, 3], c: [2, 3], x: [0, 1], y: [0, 1] });
	});

	it("a segment that lies inside a longer one shares the cluster", () => {
		expect(cols([block("long", 0, 600), block("s1", 60, 30), block("s2", 200, 30)])).toEqual({
			long: [0, 2],
			s1: [1, 2],
			s2: [1, 2],
		});
	});

	it("property: overlapping segments never share a column, and column < columns", () => {
		const input = fc.array(
			fc.record({ start: fc.integer({ min: 0, max: 1439 }), len: fc.integer({ min: 1, max: 600 }) }),
			{ minLength: 0, maxLength: 30 },
		);
		fc.assert(
			fc.property(input, (items) => {
				const tasks = items.map((it, i) => block(`t${i}`, it.start, it.len));
				const segments = seg(tasks, day);
				for (const s of segments) {
					expect(s.column).toBeGreaterThanOrEqual(0);
					expect(s.column).toBeLessThan(s.columns);
				}
				for (let i = 0; i < segments.length; i++) {
					for (let j = i + 1; j < segments.length; j++) {
						const a = segments[i] as TimedSegment;
						const b = segments[j] as TimedSegment;
						if (a.startMin < b.endMin && b.startMin < a.endMin) expect(a.column).not.toBe(b.column);
					}
				}
			}),
			{ numRuns: 200 },
		);
	});
});

describe("past and missed (D2)", () => {
	// now = 2026-10-02T10:00Z = 12:00 Berlin
	function timedPast(patch: Partial<Task>): boolean | undefined {
		return seg([task("t", patch)], "2026-10-02")[0]?.past;
	}

	it("a timed task that ended 1 minute ago is past", () => {
		expect(timedPast({ scheduled: at("2026-10-02T11:00"), plannedDurationMin: 59 })).toBe(true);
	});

	it("a running timed task is not past", () => {
		expect(timedPast({ scheduled: at("2026-10-02T11:00"), plannedDurationMin: 90 })).toBe(false);
	});

	it("a task ending exactly now is not past yet (end < now)", () => {
		expect(timedPast({ scheduled: at("2026-10-02T11:00"), plannedDurationMin: 60 })).toBe(false);
	});

	it("a future timed task is not past", () => {
		expect(timedPast({ scheduled: at("2026-10-02T15:00"), plannedDurationMin: 30 })).toBe(false);
	});

	it("a timed task with no duration uses the 30 minute default for its end", () => {
		// ends 11:30 Berlin, before now 12:00
		expect(timedPast({ scheduled: at("2026-10-02T11:00") })).toBe(true);
		// ends 12:30 Berlin, after now
		expect(timedPast({ scheduled: at("2026-10-02T12:00") })).toBe(false);
	});

	it("the end instant is computed in the task's own zone", () => {
		// 06:00 New York (EDT) = 10:00Z = now; with 30 minutes it ends after now.
		expect(timedPast({ scheduled: at("2026-10-02T06:00", "America/New_York"), plannedDurationMin: 30 })).toBe(false);
		// 05:00 New York = 09:00Z, 30 minutes: ended 30 minutes ago.
		expect(timedPast({ scheduled: at("2026-10-02T05:00", "America/New_York"), plannedDurationMin: 30 })).toBe(true);
	});

	it("both segments of a split block share the block's past flag", () => {
		const t = task("split", { scheduled: at("2026-10-01T23:30"), plannedDurationMin: 60 });
		const layout = layoutWeek([t], WEEK, ctx);
		expect(layout.timed.get("2026-10-01")?.[0]?.past).toBe(true);
		expect(layout.timed.get("2026-10-02")?.[0]?.past).toBe(true);
	});

	it("date-only entries are past when the date is before today", () => {
		const layout = layoutWeek(
			[
				task("y", { scheduled: date("2026-10-01") }),
				task("t", { scheduled: date("2026-10-02") }),
				task("n", { scheduled: date("2026-10-03") }),
			],
			WEEK,
			ctx,
		);
		const past = (d: string) => (layout.allDay.get(d)?.[0] as { past: boolean }).past;
		expect(past("2026-10-01")).toBe(true);
		expect(past("2026-10-02")).toBe(false);
		expect(past("2026-10-03")).toBe(false);
	});

	it("completed entries are never past or missed", () => {
		const done = {
			status: "completed" as const,
			completedAt: "2026-10-01T10:00:00.000Z",
		};
		const layout = layoutWeek(
			[
				task("d", { ...done, scheduled: date("2026-10-01"), deadline: date("2026-09-30") }),
				task("t", { ...done, scheduled: at("2026-10-02T08:00"), plannedDurationMin: 30 }),
			],
			WEEK,
			ctx,
		);
		expect(layout.allDay.get("2026-10-01")).toEqual([
			expect.objectContaining({ kind: "date", past: false }),
		]);
		expect(layout.allDay.get("2026-09-30")).toEqual([
			expect.objectContaining({ kind: "deadline", missed: false }),
		]);
		expect(layout.timed.get("2026-10-02")?.[0]?.past).toBe(false);
	});
});

describe("deadline entries (B43)", () => {
	it("a date deadline shows in the all-day row on its date", () => {
		const t = task("d", { deadline: date("2026-10-05") });
		const days = weekDays("2026-10-05", "MO");
		const layout = layoutWeek([t], days, ctx);
		expect(layout.allDay.get("2026-10-05")).toEqual([{ kind: "deadline", task: t, date: "2026-10-05", missed: false, occurrence: null }]);
	});

	it("a datetime deadline shows in the all-day row on its display-zone date", () => {
		// 23:30 in New York on Oct 2 is 05:30 on Oct 3 in Berlin.
		const t = task("dt", { deadline: at("2026-10-02T23:30", "America/New_York") });
		const layout = layoutWeek([t], WEEK, ctx);
		expect(layout.allDay.get("2026-10-02")).toEqual([]);
		expect(layout.allDay.get("2026-10-03")).toEqual([
			{ kind: "deadline", task: t, date: "2026-10-03", missed: false, occurrence: null },
		]);
		expect(layout.timed.get("2026-10-03")).toEqual([]);
	});

	it("missed matches isDeadlineMissed for date and datetime deadlines", () => {
		const cases: Task[] = [
			task("yd", { deadline: date("2026-10-01") }),
			task("td", { deadline: date("2026-10-02") }),
			task("fd", { deadline: date("2026-10-03") }),
			task("ydt", { deadline: at("2026-10-01T09:00") }),
			task("tdt", { deadline: at("2026-10-02T09:00") }),
			task("done", { deadline: date("2026-10-01"), status: "completed", completedAt: "2026-10-01T10:00:00.000Z" }),
			// Deadline instant is on Oct 1 in New York but Oct 2 in Berlin: not missed in Berlin.
			task("zone", { deadline: at("2026-10-01T20:00", "America/New_York") }),
		];
		const layout = layoutWeek(cases, WEEK, ctx);
		const entries = [...layout.allDay.values()].flat();
		expect(entries).toHaveLength(cases.length);
		for (const e of entries) {
			expect(e.kind).toBe("deadline");
			if (e.kind !== "deadline") continue;
			expect(e.missed).toBe(isDeadlineMissed(e.task, { today: ctx.today, zone: ctx.zone, upcomingDays: 0, weekStart: "MO" }));
		}
		const missed = entries.filter((e) => e.kind === "deadline" && e.missed).map((e) => e.task.id);
		expect(missed.sort()).toEqual(["yd", "ydt"]);
	});

	it("a task with a schedule and a deadline yields both entries", () => {
		const t = task("both", { scheduled: at("2026-10-02T09:00"), plannedDurationMin: 30, deadline: date("2026-10-04") });
		const layout = layoutWeek([t], WEEK, ctx);
		expect(layout.timed.get("2026-10-02")).toHaveLength(1);
		expect(layout.allDay.get("2026-10-04")).toEqual([{ kind: "deadline", task: t, date: "2026-10-04", missed: false, occurrence: null }]);
	});

	it("a task with a schedule and a deadline on the same day yields both entries on that day", () => {
		const t = task("same", { scheduled: date("2026-10-03"), deadline: date("2026-10-03") });
		const got = layoutWeek([t], WEEK, ctx).allDay.get("2026-10-03")?.map((e) => e.kind);
		expect(got).toEqual(["date", "deadline"]);
	});
});

describe("layoutMonth (CAL-02, D4)", () => {
	const grid = monthGrid("2026-10-15", "MO");
	const month = "2026-10";

	function cell(cells: ReturnType<typeof layoutMonth>, d: string) {
		const found = cells.flat().find((c) => c.date === d);
		if (found === undefined) throw new Error(`no cell ${d}`);
		return found;
	}

	it("returns a cell per grid date with the same shape", () => {
		const cells = layoutMonth([], grid, month, ctx);
		expect(cells).toHaveLength(grid.length);
		cells.forEach((row, i) => expect(row.map((c) => c.date)).toEqual(grid[i]));
		expect(cell(cells, "2026-10-10")).toEqual({ date: "2026-10-10", inMonth: true, count: 0, shown: [], more: 0 });
	});

	it("marks leading and trailing days as not in the month", () => {
		const cells = layoutMonth([], grid, month, ctx);
		expect(cell(cells, "2026-09-28").inMonth).toBe(false);
		expect(cell(cells, "2026-09-30").inMonth).toBe(false);
		expect(cell(cells, "2026-10-01").inMonth).toBe(true);
		expect(cell(cells, "2026-10-31").inMonth).toBe(true);
		expect(cell(cells, "2026-11-01").inMonth).toBe(false);
	});

	it("shows the first 3 and counts the rest as '+k more'", () => {
		const day = "2026-10-08";
		const tasks = [
			task("d1", { sortKey: "1", scheduled: date(day) }),
			task("d2", { sortKey: "2", scheduled: date(day) }),
			task("t1", { sortKey: "3", scheduled: at(`${day}T08:00`) }),
			task("t2", { sortKey: "4", scheduled: at(`${day}T09:00`) }),
			task("dl", { sortKey: "5", deadline: date(day) }),
		];
		const c = cell(layoutMonth(tasks, grid, month, ctx), day);
		expect(c.count).toBe(5);
		expect(c.shown).toHaveLength(3);
		expect(c.more).toBe(2);
		expect(c.shown.map((e) => e.task.id)).toEqual(["d1", "d2", "t1"]);
	});

	it("orders date entries, then timed by start, then deadlines", () => {
		const day = "2026-10-08";
		const tasks = [
			task("dl", { sortKey: "A", deadline: date(day) }),
			task("t2", { sortKey: "B", scheduled: at(`${day}T09:00`) }),
			task("t1", { sortKey: "C", scheduled: at(`${day}T08:00`) }),
			task("d", { sortKey: "D", scheduled: date(day) }),
		];
		const c = cell(layoutMonth(tasks, grid, month, ctx, 10), day);
		expect(c.shown.map((e) => e.task.id)).toEqual(["d", "t1", "t2", "dl"]);
		expect(c.more).toBe(0);
		expect(c.count).toBe(4);
	});

	it("honors maxTitles", () => {
		const day = "2026-10-08";
		const tasks = [1, 2, 3].map((i) => task(`d${i}`, { sortKey: String(i), scheduled: date(day) }));
		expect(cell(layoutMonth(tasks, grid, month, ctx, 2), day)).toMatchObject({ count: 3, more: 1 });
		expect(cell(layoutMonth(tasks, grid, month, ctx, 2), day).shown).toHaveLength(2);
		expect(cell(layoutMonth(tasks, grid, month, ctx, 0), day)).toMatchObject({ count: 3, more: 3, shown: [] });
	});

	it("counts each entry of a task that has both a schedule and a deadline that day", () => {
		const day = "2026-10-08";
		const c = cell(
			layoutMonth([task("both", { scheduled: date(day), deadline: date(day) })], grid, month, ctx),
			day,
		);
		expect(c.count).toBe(2);
		expect(c.shown).toHaveLength(2);
	});

	it("does not repeat the continued part of a block that crossed midnight", () => {
		const t = task("late", { scheduled: at("2026-10-08T23:30"), plannedDurationMin: 90 });
		const cells = layoutMonth([t], grid, month, ctx);
		expect(cell(cells, "2026-10-08").count).toBe(1);
		expect(cell(cells, "2026-10-09").count).toBe(0);
	});

	it("places entries in the leading and trailing out-of-month cells too", () => {
		const t = task("lead", { scheduled: date("2026-09-29") });
		expect(cell(layoutMonth([t], grid, month, ctx), "2026-09-29")).toMatchObject({ inMonth: false, count: 1 });
	});

	it("exposes a timed segment as the entry for a timed task", () => {
		const t = task("t", { scheduled: at("2026-10-08T08:00"), plannedDurationMin: 45 });
		const [entry] = cell(layoutMonth([t], grid, month, ctx), "2026-10-08").shown;
		expect(entry).toMatchObject({ startMin: 480, endMin: 525, durationMin: 45 });
	});
});

describe("range pre-check (performance) never drops an entry that is visible", () => {
	// Reference: the same tasks laid out over a window 40 days wider on each side, then read back
	// on the visible week. The wide window makes the cheap pre-check irrelevant for these tasks.
	const wide = weekDays("2026-10-02", "MO");
	const first = wide[0] as string;
	const last = wide[6] as string;
	const addD = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
	const bigWindow = Array.from({ length: 87 }, (_, i) => addD(first, i - 40));

	it("matches a wide-window layout for tasks around the edges, in every zone pair and with multi-day blocks", () => {
		const zones = ["Pacific/Pago_Pago", "Pacific/Kiritimati", "UTC", "Europe/Berlin", "America/Los_Angeles"];
		const tasks: Task[] = [];
		let n = 0;
		for (const tz of zones) {
			for (let off = -6; off <= 6; off++) {
				for (const dayBase of [first, last]) {
					for (const time of ["00:10", "11:30", "23:50"]) {
						for (const dur of [null, 30, 1500, 3 * 1440, 10 * 1440]) {
							tasks.push(
								task(`e${n++}`, {
									scheduled: at(`${addD(dayBase, off)}T${time}`, tz),
									plannedDurationMin: dur,
									deadline: dur === 30 ? at(`${addD(dayBase, off)}T${time}`, tz) : null,
								}),
							);
						}
					}
				}
			}
		}
		for (const zone of zones) {
			const c = { ...ctx, zone };
			const narrow = layoutWeek(tasks, wide, c);
			const reference = layoutWeek(tasks, bigWindow, c);
			for (const d of wide) {
				expect(narrow.timed.get(d), `timed ${zone} ${d}`).toEqual(reference.timed.get(d));
				expect(narrow.allDay.get(d), `allDay ${zone} ${d}`).toEqual(reference.allDay.get(d));
			}
		}
	});
});

describe("performance", () => {
	function bigStore(): Task[] {
		// 5,000 tasks spread over a year around the visible week, so most are out of range.
		const tasks: Task[] = [];
		const zones = ["Europe/Berlin", "America/New_York", "Asia/Tokyo"];
		for (let i = 0; i < 5000; i++) {
			const d = new Date(Date.parse("2026-04-01T00:00:00Z") + (i % 365) * 86_400_000).toISOString().slice(0, 10);
			const hh = String(i % 24).padStart(2, "0");
			const mm = String((i * 7) % 60).padStart(2, "0");
			const kind = i % 3;
			tasks.push(
				task(`b${i}`, {
					scheduled: kind === 0 ? date(d) : at(`${d}T${hh}:${mm}`, zones[i % 3]),
					plannedDurationMin: kind === 2 ? null : 15 + (i % 8) * 15,
					deadline: i % 5 === 0 ? date(d) : null,
				}),
			);
		}
		return tasks;
	}

	it("lays out a week of 5,000 tasks spread over a year (reported as an annotation, not asserted)", async ({ annotate }) => {
		const tasks = bigStore();
		const start = performance.now();
		const layout = layoutWeek(tasks, WEEK, ctx);
		const ms = performance.now() - start;
		await annotate(`layoutWeek 5000 tasks over a year: ${ms.toFixed(1)} ms`);
		expect(layout.days).toEqual(WEEK);
	});

	it("lays out a month of 5,000 tasks spread over a year (reported as an annotation, not asserted)", async ({ annotate }) => {
		const tasks = bigStore();
		const grid = monthGrid("2026-10-02", "MO");
		const start = performance.now();
		const cells = layoutMonth(tasks, grid, "2026-10", ctx);
		const ms = performance.now() - start;
		await annotate(`layoutMonth 5000 tasks over a year: ${ms.toFixed(1)} ms`);
		expect(cells).toHaveLength(grid.length);
	});

	it("lays out a week where all 5,000 tasks are inside it (reported as an annotation, not asserted)", async ({ annotate }) => {
		const tasks: Task[] = [];
		const zones = ["Europe/Berlin", "America/New_York", "Asia/Tokyo"];
		for (let i = 0; i < 5000; i++) {
			const day = WEEK[i % 7] as string;
			const hh = String(i % 24).padStart(2, "0");
			const mm = String((i * 7) % 60).padStart(2, "0");
			const kind = i % 3;
			tasks.push(
				task(`p${i}`, {
					scheduled: kind === 0 ? date(day) : at(`${day}T${hh}:${mm}`, zones[i % 3]),
					plannedDurationMin: kind === 2 ? null : 15 + (i % 8) * 15,
					deadline: i % 5 === 0 ? date(day) : null,
				}),
			);
		}
		const start = performance.now();
		const layout = layoutWeek(tasks, WEEK, ctx);
		const ms = performance.now() - start;
		await annotate(`layoutWeek 5000 tasks in range: ${ms.toFixed(1)} ms`);
		expect([...layout.timed.values()].flat().length).toBeGreaterThan(3000);
	});
});
