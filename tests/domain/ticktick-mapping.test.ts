import { Settings } from "luxon";
import { describe, expect, it } from "vitest";
import {
	dateFromTt,
	dateToTt,
	fieldHashes,
	isSyncable,
	priorityFromTt,
	priorityToTt,
	pulledDatePatch,
	statusFromTt,
	statusToTt,
	syncDateOf,
	type SyncFields,
} from "../../src/domain/ticktick/mapping";
import type { TtTask } from "../../src/domain/ticktick/types";
import type { DateSpec } from "../../src/domain/types";
import recorded from "../fixtures/ticktick/recorded.json";

// The pure field mapping between Logwell and TickTick. Driven by responses recorded from
// the real API (tests/fixtures/ticktick/recorded.json).

type Recorded = { status: number; body?: unknown; results?: unknown[] };
const responses = recorded.responses as unknown as Record<string, Recorded>;

function task(key: string, index = 0): TtTask {
	const r = responses[key];
	if (r === undefined) throw new Error(`no recorded response ${key}`);
	const v = r.body !== undefined ? r.body : r.results?.[index];
	const t: unknown = Array.isArray(v) ? (v as unknown[])[index] : v;
	return t as TtTask;
}

const date = (d: string): DateSpec => ({ kind: "date", date: d });
const timed = (local: string, tz: string): DateSpec => ({ kind: "datetime", local, tz });

describe("priority (SYNC-04)", () => {
	it("maps TickTick 5/3/1/0 to Logwell high/medium/low/none", () => {
		expect([5, 3, 1, 0].map(priorityFromTt)).toEqual([1, 2, 3, 0]);
	});

	it("maps Logwell high/medium/low/none to 5/3/1/0", () => {
		expect([1, 2, 3, 0].map((p) => priorityToTt(p as 0 | 1 | 2 | 3))).toEqual([5, 3, 1, 0]);
	});

	it("reads an unknown or missing value as none", () => {
		expect([2, 4, 7, -1, 99, undefined, Number.NaN].map(priorityFromTt)).toEqual([0, 0, 0, 0, 0, 0, 0]);
	});

	it("reads the recorded Call the bank task (5) as high", () => {
		expect(priorityFromTt(task("10-tasks/01-create-all-day-task").priority)).toBe(1);
	});
});

describe("status (SYNC-04 and the won't do decision)", () => {
	it("maps 0 to open, 2 and -1 to completed", () => {
		expect(statusFromTt(0)).toBe("open");
		expect(statusFromTt(2)).toBe("completed");
		expect(statusFromTt(-1)).toBe("completed");
	});

	it("reads a missing or unknown status as open", () => {
		expect(statusFromTt(undefined)).toBe("open");
		expect(statusFromTt(7)).toBe("open");
	});

	it("maps Logwell open and completed to 0 and 2", () => {
		expect(statusToTt("open")).toBe(0);
		expect(statusToTt("completed")).toBe(2);
	});

	it("reads the recorded won't do task as completed", () => {
		expect(statusFromTt(task("probe/15-wontdo-set--1").status)).toBe("completed");
	});

	it("reads a reopened task as open although completedTime stays set", () => {
		const t = task("10-tasks/10-reopen-task-status-0");
		expect(t.completedTime).toBeDefined();
		expect(statusFromTt(t.status)).toBe("open");
	});

	it("reads a completed task from the completed list as completed", () => {
		expect(statusFromTt(task("10-tasks/09-list-completed-in-window").status)).toBe("completed");
	});
});

describe("isSyncable (SYNC-06)", () => {
	it("syncs a normal task", () => {
		expect(isSyncable(task("10-tasks/01-create-all-day-task"))).toBe(true);
	});

	it("syncs a checklist task", () => {
		const t = task("probe/12-checklist-create");
		expect(t.kind).toBe("CHECKLIST");
		expect(isSyncable(t)).toBe(true);
	});

	it("does not sync a repeating task", () => {
		const t = task("30-recurrence/01-create-weekly-repeating-task");
		expect(t.repeatFlag).toContain("RRULE");
		expect(isSyncable(t)).toBe(false);
	});

	it("does not sync a TickTick note", () => {
		expect(isSyncable({ ...task("10-tasks/01-create-all-day-task"), kind: "NOTE" })).toBe(false);
	});

	it("treats an empty repeatFlag as not repeating", () => {
		expect(isSyncable({ ...task("10-tasks/01-create-all-day-task"), repeatFlag: "" })).toBe(true);
	});
});

describe("syncDateOf (SYNC-05 push)", () => {
	const a = date("2026-10-08");
	const b = date("2026-10-12");
	it("is the deadline when set", () => {
		expect(syncDateOf({ scheduled: a, deadline: b })).toEqual(b);
		expect(syncDateOf({ scheduled: null, deadline: b })).toEqual(b);
	});
	it("is the schedule when there is no deadline", () => {
		expect(syncDateOf({ scheduled: a, deadline: null })).toEqual(a);
	});
	it("is null with neither", () => {
		expect(syncDateOf({ scheduled: null, deadline: null })).toBeNull();
	});
});

describe("dateToTt (push)", () => {
	it("sends a date as local midnight of the display zone, start equal to due", () => {
		expect(dateToTt(date("2026-10-08"), "Europe/Moscow")).toEqual({
			startDate: "2026-10-08T00:00:00+0300",
			dueDate: "2026-10-08T00:00:00+0300",
			isAllDay: true,
			timeZone: "Europe/Moscow",
		});
	});

	it("uses the offset of that date in the display zone (New York, both sides of a DST change)", () => {
		expect(dateToTt(date("2026-03-07"), "America/New_York").dueDate).toBe("2026-03-07T00:00:00-0500");
		expect(dateToTt(date("2026-03-08"), "America/New_York").dueDate).toBe("2026-03-08T00:00:00-0500");
		expect(dateToTt(date("2026-03-09"), "America/New_York").dueDate).toBe("2026-03-09T00:00:00-0400");
		expect(dateToTt(date("2026-11-01"), "America/New_York").dueDate).toBe("2026-11-01T00:00:00-0400");
		expect(dateToTt(date("2026-11-02"), "America/New_York").dueDate).toBe("2026-11-02T00:00:00-0500");
	});

	it("sends a datetime as its wall time in its own zone, ignoring the display zone", () => {
		expect(dateToTt(timed("2026-10-08T09:30", "Europe/Moscow"), "America/New_York")).toEqual({
			startDate: "2026-10-08T09:30:00+0300",
			dueDate: "2026-10-08T09:30:00+0300",
			isAllDay: false,
			timeZone: "Europe/Moscow",
		});
	});

	it("sends a datetime in a zone with a different offset on that day", () => {
		expect(dateToTt(timed("2026-07-01T18:00", "America/New_York"), "Europe/Moscow").dueDate).toBe("2026-07-01T18:00:00-0400");
	});

	it("moves a wall time inside a spring-forward gap to the first valid time", () => {
		expect(dateToTt(timed("2026-03-08T02:30", "America/New_York"), "Europe/Moscow").dueDate).toBe("2026-03-08T03:30:00-0400");
	});

	it("keeps the day for a date whose midnight does not exist in the zone", () => {
		// Sao Paulo skipped 00:00 on 2018-11-04 (clocks went from 00:00 to 01:00).
		const sent = dateToTt(date("2018-11-04"), "America/Sao_Paulo");
		expect(dateFromTt({ ...sent, timeZone: "America/Sao_Paulo" }, "UTC")).toEqual(date("2018-11-04"));
	});
});

describe("dates on a device whose language writes other digits", () => {
	it("#100: a timed date goes up and comes down with the digits 0 to 9", () => {
		const before = Settings.defaultLocale;
		Settings.defaultLocale = "ar-EG";
		try {
			expect(dateToTt(timed("2026-10-21T07:45", "Europe/Moscow"), "UTC").dueDate).toBe("2026-10-21T07:45:00+0300");
			expect(dateFromTt({ dueDate: "2026-10-22T04:15:00.000+0000", isAllDay: false, timeZone: "Europe/Moscow" }, "UTC")).toEqual(timed("2026-10-22T07:15", "Europe/Moscow"));
		} finally {
			Settings.defaultLocale = before;
		}
	});
});

describe("dateFromTt (pull)", () => {
	it("reads the recorded all-day task as the date in its own zone (V5)", () => {
		const t = task("10-tasks/01-create-all-day-task");
		expect(t.dueDate).toBe("2026-10-07T21:00:00.000+0000");
		expect(dateFromTt(t, "UTC")).toEqual(date("2026-10-08"));
	});

	it("reads the recorded timed task as wall time in its zone with that tz (V7)", () => {
		expect(dateFromTt(task("10-tasks/03-create-timed-task"), "UTC")).toEqual(timed("2026-10-08T10:00", "Europe/Moscow"));
	});

	it("keeps one instant for a span sent as start and due (V7b): the span is lost", () => {
		const t = task("probe/05-v7b-read-span");
		expect(t.startDate).toBe(t.dueDate);
		expect(dateFromTt(t, "UTC")).toEqual(timed("2026-10-09T10:00", "Europe/Moscow"));
	});

	it("reads a start-only task the same way", () => {
		expect(dateFromTt(task("probe/02-v7b-create-start-only"), "UTC")).toEqual(timed("2026-10-09T09:00", "Europe/Moscow"));
	});

	it("reads an all-day task of the weekly repeating probe", () => {
		expect(dateFromTt(task("30-recurrence/01-create-weekly-repeating-task"), "UTC")).toEqual(date("2026-10-08"));
	});

	it("reads an all-day task in New York across the DST change", () => {
		const base = { isAllDay: true, timeZone: "America/New_York" };
		expect(dateFromTt({ ...base, dueDate: "2026-11-01T04:00:00.000+0000" }, "UTC")).toEqual(date("2026-11-01"));
		expect(dateFromTt({ ...base, dueDate: "2026-11-02T05:00:00.000+0000" }, "UTC")).toEqual(date("2026-11-02"));
		expect(dateFromTt({ ...base, dueDate: "2026-03-08T05:00:00.000+0000" }, "UTC")).toEqual(date("2026-03-08"));
		expect(dateFromTt({ ...base, dueDate: "2026-03-09T04:00:00.000+0000" }, "UTC")).toEqual(date("2026-03-09"));
	});

	it("reads a timed task in New York on the fall-back day", () => {
		const t = { isAllDay: false, timeZone: "America/New_York", dueDate: "2026-11-01T14:30:00.000+0000" };
		expect(dateFromTt(t, "UTC")).toEqual(timed("2026-11-01T09:30", "America/New_York"));
	});

	it("is independent of the display zone (fallback only applies to a missing zone)", () => {
		const t = task("10-tasks/01-create-all-day-task");
		expect(dateFromTt(t, "America/New_York")).toEqual(date("2026-10-08"));
	});

	it("uses the fallback zone when the task has no usable zone", () => {
		const t = { isAllDay: false, dueDate: "2026-10-07T21:00:00.000+0000" };
		expect(dateFromTt(t, "Europe/Moscow")).toEqual(timed("2026-10-08T00:00", "Europe/Moscow"));
		expect(dateFromTt({ ...t, timeZone: "Not/AZone" }, "Europe/Moscow")).toEqual(timed("2026-10-08T00:00", "Europe/Moscow"));
	});

	it("reads a task without a date as null", () => {
		expect(dateFromTt(task("10-tasks/04-create-subtask"), "UTC")).toBeNull();
	});

	it("reads an unparseable date as null", () => {
		expect(dateFromTt({ dueDate: "next friday", timeZone: "Europe/Moscow" }, "UTC")).toBeNull();
	});

	it("returns a fresh value on every call (the memo is not shared)", () => {
		const t = task("10-tasks/01-create-all-day-task");
		const x = dateFromTt(t, "UTC");
		if (x === null || x.kind !== "date") throw new Error("expected a date");
		x.date = "1999-01-01";
		expect(dateFromTt(t, "UTC")).toEqual(date("2026-10-08"));
	});

	it("round-trips every date and datetime through the push format", () => {
		const specs: [DateSpec, string][] = [
			[date("2026-10-08"), "Europe/Moscow"],
			[date("2026-03-08"), "America/New_York"],
			[date("2026-11-01"), "America/New_York"],
			[date("2026-10-04"), "Pacific/Auckland"],
			[date("2026-12-31"), "Pacific/Kiritimati"],
			[timed("2026-10-08T09:30", "Europe/Moscow"), "UTC"],
			[timed("2026-11-01T01:30", "America/New_York"), "UTC"],
			[timed("2026-07-01T23:59", "America/New_York"), "Europe/Moscow"],
		];
		for (const [spec, display] of specs) {
			const sent = dateToTt(spec, display);
			expect(dateFromTt(sent, "UTC")).toEqual(spec);
		}
	});
});

describe("pulledDatePatch (SYNC-05 pull)", () => {
	const a = date("2026-10-08");
	const b = date("2026-10-12");
	const c = date("2026-10-15");

	it("a new task gets the date as both schedule and deadline", () => {
		expect(pulledDatePatch(null, a)).toEqual({ scheduled: a, deadline: a });
	});

	it("a new task without a date has neither", () => {
		expect(pulledDatePatch(null, null)).toEqual({ scheduled: null, deadline: null });
	});

	it("with a deadline only, moves the deadline", () => {
		expect(pulledDatePatch({ scheduled: null, deadline: b }, c)).toEqual({ deadline: c });
	});

	it("with a schedule only, moves the schedule", () => {
		expect(pulledDatePatch({ scheduled: a, deadline: null }, c)).toEqual({ scheduled: c });
	});

	it("with both different, moves the deadline (the date that was sent) and leaves the schedule", () => {
		expect(pulledDatePatch({ scheduled: a, deadline: b }, c)).toEqual({ deadline: c });
	});

	it("with schedule equal to deadline, moves both", () => {
		expect(pulledDatePatch({ scheduled: b, deadline: b }, c)).toEqual({ scheduled: c, deadline: c });
	});

	it("compares timed dates by wall time and zone", () => {
		const t1 = timed("2026-10-08T09:00", "Europe/Moscow");
		const t2 = timed("2026-10-08T10:00", "Europe/Moscow");
		expect(pulledDatePatch({ scheduled: t1, deadline: { ...t1 } }, t2)).toEqual({ scheduled: t2, deadline: t2 });
		expect(pulledDatePatch({ scheduled: timed("2026-10-08T09:00", "UTC"), deadline: t1 }, t2)).toEqual({ deadline: t2 });
	});

	it("a date and a datetime on the same day are not equal", () => {
		const d = date("2026-10-08");
		const t = timed("2026-10-08T09:00", "Europe/Moscow");
		expect(pulledDatePatch({ scheduled: d, deadline: t }, c)).toEqual({ deadline: c });
	});

	it("an existing task given a timed date keeps the tz of the TickTick task", () => {
		const t = timed("2026-10-08T10:00", "Europe/Moscow");
		expect(pulledDatePatch({ scheduled: null, deadline: b }, t)).toEqual({ deadline: t });
	});

	it("with no date on either side changes nothing; a new date on a dateless task is both, like a new task", () => {
		expect(pulledDatePatch({ scheduled: null, deadline: null }, null)).toEqual({});
		expect(pulledDatePatch({ scheduled: null, deadline: null }, a)).toEqual({ scheduled: a, deadline: a });
	});

	it("#120: a date cleared in TickTick clears both dates, equal or not", () => {
		expect(pulledDatePatch({ scheduled: a, deadline: b }, null)).toEqual({ scheduled: null, deadline: null });
		expect(pulledDatePatch({ scheduled: null, deadline: b }, null)).toEqual({ deadline: null });
		expect(pulledDatePatch({ scheduled: b, deadline: b }, null)).toEqual({ scheduled: null, deadline: null });
		expect(pulledDatePatch({ scheduled: a, deadline: null }, null)).toEqual({ scheduled: null });
	});

	it("omits a field that already holds the pulled value", () => {
		expect(pulledDatePatch({ scheduled: a, deadline: b }, b)).toEqual({});
		expect(pulledDatePatch({ scheduled: b, deadline: b }, b)).toEqual({});
	});
});

describe("fieldHashes", () => {
	const base: SyncFields = {
		title: "Call the bank",
		status: "open",
		priority: 1,
		date: date("2026-10-08"),
		parent: null,
		section: null,
		tags: [],
	};

	it("returns one short hex string per field", () => {
		const h = fieldHashes(base);
		expect(Object.keys(h).sort()).toEqual(["date", "parent", "priority", "section", "status", "tags", "title"]);
		for (const v of Object.values(h)) expect(v).toMatch(/^[0-9a-f]{8}$/u);
	});

	it("is stable: equal values hash equal, whatever the key order", () => {
		const reordered: SyncFields = {
			section: null,
			parent: null,
			date: date("2026-10-08"),
			priority: 1,
			status: "open",
			title: "Call the bank",
			tags: [],
		};
		expect(fieldHashes(reordered)).toEqual(fieldHashes(base));
		expect(fieldHashes({ ...base })).toEqual(fieldHashes(base));
	});

	it("is pinned (a change of the hash would make every linked task look edited)", () => {
		expect(fieldHashes(base)).toEqual({
			title: "2308506a",
			status: "1cef50d1",
			priority: "340ca71c",
			date: "8367f66e",
			parent: "77074ba4",
			section: "77074ba4",
			tags: "741638a5",
		});
	});

	it("changes only the hash of the field that changed", () => {
		const before = fieldHashes(base);
		const after = fieldHashes({ ...base, title: "Call the bank today" });
		expect(after.title).not.toBe(before.title);
		expect({ ...after, title: "" }).toEqual({ ...before, title: "" });
	});

	it("tells apart every value of a field", () => {
		const hashes = [
			fieldHashes({ ...base, date: null }).date,
			fieldHashes({ ...base, date: date("2026-10-08") }).date,
			fieldHashes({ ...base, date: date("2026-10-09") }).date,
			fieldHashes({ ...base, date: timed("2026-10-08T09:00", "Europe/Moscow") }).date,
			fieldHashes({ ...base, date: timed("2026-10-08T09:00", "UTC") }).date,
			fieldHashes({ ...base, date: timed("2026-10-08T09:01", "Europe/Moscow") }).date,
		];
		expect(new Set(hashes).size).toBe(hashes.length);
		expect(fieldHashes({ ...base, parent: null }).parent).not.toBe(fieldHashes({ ...base, parent: "" }).parent);
		expect(fieldHashes({ ...base, status: "open" }).status).not.toBe(fieldHashes({ ...base, status: "completed" }).status);
		expect(fieldHashes({ ...base, priority: 0 }).priority).not.toBe(fieldHashes({ ...base, priority: 3 }).priority);
	});

	it("hashes non-ASCII titles and equal dates built separately alike", () => {
		expect(fieldHashes({ ...base, title: "Café ☕" }).title).toBe(fieldHashes({ ...base, title: "Café ☕".normalize("NFC") }).title);
		expect(fieldHashes({ ...base, date: { kind: "date", date: "2026-10-08" } }).date).toBe(fieldHashes(base).date);
	});

	it("matches between a Logwell value and the same value read back from TickTick", () => {
		const fromTt = dateFromTt(dateToTt(date("2026-10-08"), "Europe/Moscow"), "UTC");
		expect(fieldHashes({ ...base, date: fromTt }).date).toBe(fieldHashes(base).date);
	});
});
