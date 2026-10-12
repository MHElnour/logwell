import { describe, expect, it } from "vitest";
import { CheckpointApp } from "../../src/app/App";
import { COMPLETE_OCCURRENCE_LABEL, EDIT_REPEAT_LABEL, END_REPEAT_LABEL, REOPEN_OCCURRENCE_LABEL, type RecurrenceResult, SKIP_OCCURRENCE_LABEL, STOP_REPEATING_LABEL } from "../../src/app/RecurrenceService";
import { isDomainError } from "../../src/domain/errors";
import { currentOccurrence, effectiveSchedule, indexOccurrenceRecords, occurrencesBetween, remainingCount, repeatEndProblem } from "../../src/domain/recurrence";
import type { DateSpec, OccurrenceRecord, Recurrence, RepeatRule, Task, WeekStart } from "../../src/domain/types";
import { rule } from "../domain/recurrence-fixtures";
import { sequentialIds } from "../helpers";
import { type AppHarness, FakeNotes, appHarness } from "./harness";

// RecurrenceService. Europe/Berlin;
// 2026-10-05 is a Monday. Every write is one run whose label is the store's undo label.

const NOW = "2026-10-05T10:00:00.000Z";

async function setup(iso = NOW): Promise<AppHarness> {
	const h = await appHarness();
	h.clock.set(iso);
	return h;
}

async function plainTask(h: AppHarness, scheduled: DateSpec | null = null, patch: { deadline?: DateSpec } = {}): Promise<Task> {
	return (await h.app.tasks.create({ title: "Gym", scheduled, ...patch })).task;
}

async function repeatingTask(h: AppHarness, r: RepeatRule, anchor: string, end?: Parameters<AppHarness["app"]["recurrence"]["setRepeat"]>[3]): Promise<Task> {
	const t = await plainTask(h, { kind: "date", date: anchor });
	await h.app.recurrence.setRepeat(t.id, r, undefined, end);
	return h.app.store.state.tasks.get(t.id)!;
}

const task = (h: AppHarness, id: string): Task => h.app.store.state.tasks.get(id)!;
const records = (h: AppHarness, id: string): OccurrenceRecord[] => [...(indexOccurrenceRecords(h.app.store.state.occurrenceRecords).get(id) ?? [])];
const current = (h: AppHarness, id: string): string | null => currentOccurrence(task(h, id), records(h, id), "2026-10-05", "MO");

/** The result's label is the store's undo label, and undo puts every record back exactly. */
async function labelledAndUndoable(h: AppHarness, write: () => Promise<RecurrenceResult>, label: string): Promise<RecurrenceResult> {
	const before = { tasks: h.app.store.state.tasks, records: h.app.store.state.occurrenceRecords };
	const snapshot = (m: ReadonlyMap<string, unknown>) => JSON.stringify([...m].sort());
	const tasksBefore = snapshot(before.tasks);
	const recordsBefore = snapshot(before.records);
	const r = await write();
	expect(r.label).toBe(label);
	expect(r.wrote).toBe(true);
	expect(h.app.store.undoLabel).toBe(label);
	await h.app.store.undo();
	expect(snapshot(h.app.store.state.tasks)).toBe(tasksBefore);
	expect(snapshot(h.app.store.state.occurrenceRecords)).toBe(recordsBefore);
	return write();
}

async function rejects(p: Promise<unknown>, code: "InvalidValue" | "NotFound"): Promise<string> {
	try {
		await p;
	} catch (err) {
		expect(isDomainError(err, code)).toBe(true);
		return (err as Error).message;
	}
	throw new Error("expected a DomainError");
}

describe("setRepeat: making a task repeat (D4, decision 9)", () => {
	it("its scheduled date becomes the anchor and scheduled becomes null, in one undoable write", async () => {
		const h = await setup();
		const t = await plainTask(h, { kind: "date", date: "2026-10-09" });
		const r = await labelledAndUndoable(h, () => h.app.recurrence.setRepeat(t.id, rule({ freq: "weekly" })), EDIT_REPEAT_LABEL);
		expect(r).toMatchObject({ wrote: true, deadlineCleared: false, seriesEnded: false });
		expect(task(h, t.id)).toMatchObject({
			scheduled: null,
			recurrence: { anchor: "2026-10-09", versions: [{ effectiveFrom: "2026-10-09", rule: rule({ freq: "weekly" }) }], end: { kind: "never" }, endedAt: null },
		});
		expect(current(h, t.id)).toBe("2026-10-09");
	});

	it("a timed date gives the rule its time and zone; a deadline is cleared and reported", async () => {
		const h = await setup();
		const t = await plainTask(h, { kind: "datetime", local: "2026-10-06T07:00", tz: "Europe/Berlin" }, { deadline: { kind: "date", date: "2026-10-20" } });
		const r = await h.app.recurrence.setRepeat(t.id, rule());
		expect(r.deadlineCleared).toBe(true);
		expect(task(h, t.id).deadline).toBeNull();
		expect(task(h, t.id).recurrence?.versions[0]?.rule).toMatchObject({ time: "07:00", tz: "Europe/Berlin" });
		expect(task(h, t.id).recurrence?.anchor).toBe("2026-10-06");
	});

	it("without a date the anchor is `from`, else today", async () => {
		const h = await setup();
		const a = await plainTask(h);
		await h.app.recurrence.setRepeat(a.id, rule(), "2026-10-12");
		expect(task(h, a.id).recurrence?.anchor).toBe("2026-10-12");
		const b = await plainTask(h);
		await h.app.recurrence.setRepeat(b.id, rule(), undefined, { kind: "count", count: 3 });
		expect(task(h, b.id).recurrence).toMatchObject({ anchor: "2026-10-05", end: { kind: "count", count: 3 } });
	});

	it("weekdays are stored Monday first without repeats", async () => {
		const h = await setup();
		const t = await plainTask(h);
		await h.app.recurrence.setRepeat(t.id, rule({ freq: "weekly", weekdays: ["FR", "MO", "FR"] }));
		expect(task(h, t.id).recurrence?.versions[0]?.rule.weekdays).toEqual(["MO", "FR"]);
	});

	it("a subtask cannot repeat; an invalid rule, end or start date is refused", async () => {
		const h = await setup();
		const parent = await plainTask(h);
		const sub = (await h.app.tasks.create({ title: "Pack", parentId: parent.id })).task;
		expect(await rejects(h.app.recurrence.setRepeat(sub.id, rule()), "InvalidValue")).toBe("A subtask cannot repeat.");
		await rejects(h.app.recurrence.setRepeat(parent.id, rule({ interval: 0 })), "InvalidValue");
		await rejects(h.app.recurrence.setRepeat(parent.id, rule({ freq: "weekly", weekdays: ["MO"], afterCompletion: true })), "InvalidValue");
		await rejects(h.app.recurrence.setRepeat(parent.id, rule(), undefined, { kind: "count", count: 0 }), "InvalidValue");
		await rejects(h.app.recurrence.setRepeat(parent.id, rule(), "2026-02-30"), "InvalidValue");
		await rejects(h.app.recurrence.setRepeat("missing", rule()), "NotFound");
		expect(task(h, parent.id).recurrence).toBeNull();
	});

	it("null on a task that does not repeat writes nothing", async () => {
		const h = await setup();
		const t = await plainTask(h);
		expect(await h.app.recurrence.setRepeat(t.id, null)).toMatchObject({ wrote: false, label: EDIT_REPEAT_LABEL });
		expect(h.app.store.undoLabel).toBe("Create task");
	});
});

describe("setRepeat: editing a series (REC-06, B22)", () => {
	const mwf = rule({ freq: "weekly", weekdays: ["MO", "WE", "FR"] });
	const tuth = rule({ freq: "weekly", weekdays: ["TU", "TH"] });

	it("B22: a new version from a date; dates before it follow the old rule and their records stay", async () => {
		const h = await setup();
		const t = await repeatingTask(h, mwf, "2026-09-28");
		await h.app.recurrence.complete(t.id); // Sep 28 done, Sep 30, Oct 2 skipped (catch-up)
		const kept = records(h, t.id);
		await labelledAndUndoable(h, () => h.app.recurrence.setRepeat(t.id, tuth, "2026-10-12"), EDIT_REPEAT_LABEL);
		expect(task(h, t.id).recurrence?.versions.map((v) => [v.effectiveFrom, v.rule.weekdays])).toEqual([
			["2026-09-28", ["MO", "WE", "FR"]],
			["2026-10-12", ["TU", "TH"]],
		]);
		expect(records(h, t.id)).toEqual(kept);
		expect(current(h, t.id)).toBe("2026-10-05");
	});

	it("the default start is today, never before the anchor; the same date replaces, later versions are dropped", async () => {
		const h = await setup();
		const t = await repeatingTask(h, mwf, "2026-09-28");
		await h.app.recurrence.setRepeat(t.id, tuth, "2026-10-19");
		await h.app.recurrence.setRepeat(t.id, rule({ freq: "weekly", weekdays: ["SA"] }));
		expect(task(h, t.id).recurrence?.versions.map((v) => v.effectiveFrom)).toEqual(["2026-09-28", "2026-10-05"]);
		await h.app.recurrence.setRepeat(t.id, rule({ freq: "weekly", weekdays: ["SU"] }), "2026-10-05");
		expect(task(h, t.id).recurrence?.versions.map((v) => v.rule.weekdays)).toEqual([["MO", "WE", "FR"], ["SU"]]);
		await h.app.recurrence.setRepeat(t.id, rule({ freq: "daily" }), "2026-01-01");
		expect(task(h, t.id).recurrence?.versions).toEqual([{ effectiveFrom: "2026-09-28", rule: rule({ freq: "daily" }) }]);
	});

	it("F1: the picker's explicit copy of an implicit weekly rule (no week start) is no change", async () => {
		const h = await setup();
		const t = await repeatingTask(h, rule({ freq: "weekly" }), "2026-10-09"); // weekdays null: Fridays
		const before = task(h, t.id).recurrence;
		const r = await h.app.recurrence.setRepeat(t.id, rule({ freq: "weekly", weekdays: ["FR"] }));
		expect(r.wrote).toBe(false);
		expect(task(h, t.id).recurrence).toBe(before);
	});

	it("F1: an end-only edit through the picker changes the end and adds no version", async () => {
		const h = await setup();
		const t = await repeatingTask(h, rule({ freq: "weekly" }), "2026-10-09");
		const versions = task(h, t.id).recurrence?.versions;
		const r = await h.app.recurrence.setRepeat(t.id, rule({ freq: "weekly", weekdays: ["FR"] }), undefined, { kind: "count", count: 4 });
		expect(r.wrote).toBe(true);
		expect(task(h, t.id).recurrence?.end).toEqual({ kind: "count", count: 4 });
		expect(task(h, t.id).recurrence?.versions).toEqual(versions);
	});

	it("F1: a monthly rule on the anchor's day, made explicit, is no change; a real change still adds a version", async () => {
		const h = await setup();
		const m = await repeatingTask(h, rule({ freq: "monthly" }), "2026-10-31");
		expect((await h.app.recurrence.setRepeat(m.id, rule({ freq: "monthly", monthly: { kind: "day", day: 31 } }))).wrote).toBe(false);
		const t = await repeatingTask(h, rule({ freq: "weekly" }), "2026-09-04");
		const r = await h.app.recurrence.setRepeat(t.id, rule({ freq: "weekly", weekdays: ["FR", "MO"] }));
		expect(r.wrote).toBe(true);
		expect(task(h, t.id).recurrence?.versions.map((v) => [v.effectiveFrom, v.rule.weekdays])).toEqual([
			["2026-09-04", null],
			["2026-10-05", ["MO", "FR"]],
		]);
	});

	it("G1: an edit back to the previous rule on the same day leaves one version; A → B stays two", async () => {
		const h = await setup();
		const a = rule({ freq: "weekly" }); // Fridays (weekdays null)
		const b = rule({ freq: "weekly", weekdays: ["MO", "FR"] });
		const t = await repeatingTask(h, a, "2026-09-04");
		const original = task(h, t.id).recurrence?.versions;
		await h.app.recurrence.setRepeat(t.id, b);
		expect(task(h, t.id).recurrence?.versions.map((v) => v.effectiveFrom)).toEqual(["2026-09-04", "2026-10-05"]);
		await h.app.recurrence.setRepeat(t.id, rule({ freq: "weekly", weekdays: ["FR"] }));
		expect(task(h, t.id).recurrence?.versions).toEqual(original);
	});

	it("an unchanged rule writes nothing; a new end alone is a write", async () => {
		const h = await setup();
		const t = await repeatingTask(h, mwf, "2026-10-05");
		expect((await h.app.recurrence.setRepeat(t.id, mwf)).wrote).toBe(false);
		const r = await h.app.recurrence.setRepeat(t.id, mwf, undefined, { kind: "date", date: "2026-12-31" });
		expect(r.wrote).toBe(true);
		expect(task(h, t.id).recurrence?.end).toEqual({ kind: "date", date: "2026-12-31" });
		expect(task(h, t.id).recurrence?.versions).toHaveLength(1);
	});

	it("an ended series opens again with a new rule, unless its end is still reached", async () => {
		const h = await setup();
		const t = await repeatingTask(h, rule(), "2026-10-05");
		await h.app.recurrence.stop(t.id);
		await h.app.recurrence.setRepeat(t.id, rule({ interval: 2 }));
		expect(task(h, t.id)).toMatchObject({ status: "open", completedAt: null, recurrence: { endedAt: null } });
		const u = await repeatingTask(h, rule(), "2026-10-05", { kind: "count", count: 1 });
		await h.app.recurrence.complete(u.id);
		expect(task(h, u.id).status).toBe("completed");
		const r = await h.app.recurrence.setRepeat(u.id, rule({ interval: 2 }));
		expect(task(h, u.id).status).toBe("completed");
		expect(task(h, u.id).recurrence?.endedAt).not.toBeNull();
		expect(r.seriesEnded).toBe(false);
	});

	it("null: a plain task scheduled at its current occurrence (with the time), records kept", async () => {
		const h = await setup();
		const t = await plainTask(h, { kind: "datetime", local: "2026-10-01T07:30", tz: "Europe/Berlin" });
		await h.app.recurrence.setRepeat(t.id, rule());
		await h.app.recurrence.complete(t.id);
		const kept = records(h, t.id);
		await labelledAndUndoable(h, () => h.app.recurrence.setRepeat(t.id, null), EDIT_REPEAT_LABEL);
		expect(task(h, t.id)).toMatchObject({ recurrence: null, scheduled: { kind: "datetime", local: "2026-10-05T07:30", tz: "Europe/Berlin" } });
		expect(records(h, t.id)).toEqual(kept);
	});
});

describe("complete (REC-03, B20, decision 4)", () => {
	it("B20: overdue by 4 days: the earliest is done, the other 3 auto-skipped, the next is today", async () => {
		const h = await setup();
		const t = await repeatingTask(h, rule(), "2026-10-01");
		const r = await labelledAndUndoable(h, () => h.app.recurrence.complete(t.id), COMPLETE_OCCURRENCE_LABEL);
		expect(r).toMatchObject({ date: "2026-10-01", autoSkipped: 3, seriesEnded: false });
		expect(records(h, t.id)).toEqual([
			{ taskId: t.id, occurrenceDate: "2026-10-01", status: "done", resolvedAt: NOW, auto: false, completedOn: "2026-10-05" },
			{ taskId: t.id, occurrenceDate: "2026-10-02", status: "skipped", resolvedAt: NOW, auto: true, completedOn: null },
			{ taskId: t.id, occurrenceDate: "2026-10-03", status: "skipped", resolvedAt: NOW, auto: true, completedOn: null },
			{ taskId: t.id, occurrenceDate: "2026-10-04", status: "skipped", resolvedAt: NOW, auto: true, completedOn: null },
		]);
		expect(current(h, t.id)).toBe("2026-10-05");
		expect(task(h, t.id).status).toBe("open");
	});

	it("an occurrence due today (or later) is simply done", async () => {
		const h = await setup();
		const t = await repeatingTask(h, rule({ freq: "weekly" }), "2026-10-05");
		await h.app.recurrence.complete(t.id);
		await h.app.recurrence.complete(t.id);
		expect(records(h, t.id).map((x) => [x.occurrenceDate, x.status, x.completedOn])).toEqual([
			["2026-10-05", "done", "2026-10-05"],
			["2026-10-12", "done", "2026-10-05"],
		]);
		expect(current(h, t.id)).toBe("2026-10-19");
	});

	it("decision 4: every subtask comes back unchecked in the same write", async () => {
		const h = await setup();
		const t = await repeatingTask(h, rule({ freq: "weekly" }), "2026-10-05");
		const a = (await h.app.tasks.create({ title: "Shoes", parentId: t.id })).task;
		const b = (await h.app.tasks.create({ title: "Towel", parentId: t.id })).task;
		await h.app.tasks.complete(a.id);
		await labelledAndUndoable(h, () => h.app.recurrence.complete(t.id), COMPLETE_OCCURRENCE_LABEL);
		expect(task(h, a.id)).toMatchObject({ status: "open", completedAt: null });
		expect(task(h, b.id).status).toBe("open");
	});

	it("the last allowed occurrence ends the series: endedAt, the task completed", async () => {
		const h = await setup();
		const t = await repeatingTask(h, rule(), "2026-10-04", { kind: "count", count: 2 });
		expect((await h.app.recurrence.complete(t.id)).seriesEnded).toBe(false);
		const r = await labelledAndUndoable(h, () => h.app.recurrence.complete(t.id), COMPLETE_OCCURRENCE_LABEL);
		expect(r.seriesEnded).toBe(true);
		expect(task(h, t.id)).toMatchObject({ status: "completed", completedAt: NOW, recurrence: { endedAt: NOW } });
		expect(records(h, t.id)).toHaveLength(2);
	});

	it("a catch-up stops at a count end and ends the series", async () => {
		const h = await setup();
		const t = await repeatingTask(h, rule(), "2026-09-20", { kind: "count", count: 3 });
		const r = await h.app.recurrence.complete(t.id);
		expect(r).toMatchObject({ date: "2026-09-20", autoSkipped: 2, seriesEnded: true });
		expect(records(h, t.id)).toHaveLength(3);
	});

	it("an end date passed ends the series with its last date", async () => {
		const h = await setup();
		const t = await repeatingTask(h, rule(), "2026-10-05", { kind: "date", date: "2026-10-05" });
		expect((await h.app.recurrence.complete(t.id)).seriesEnded).toBe(true);
		expect(task(h, t.id).status).toBe("completed");
	});

	it("after completion: done today, the next date counts from today", async () => {
		const h = await setup();
		const t = await repeatingTask(h, rule({ interval: 3, afterCompletion: true }), "2026-10-01");
		const r = await h.app.recurrence.complete(t.id);
		expect(r).toMatchObject({ date: "2026-10-01", autoSkipped: 0 });
		expect(records(h, t.id)[0]).toMatchObject({ status: "done", completedOn: "2026-10-05" });
		expect(current(h, t.id)).toBe("2026-10-08");
	});

	it.each([
		["early", "2026-10-10", "2026-10-13"],
		["on time", "2026-10-05", "2026-10-08"],
		["late", "2026-10-03", "2026-10-06"],
	])("fixed mode, done %s: the schedule does not move (the next is the next generated date)", async (_when, anchor, next) => {
		const h = await setup();
		const t = await repeatingTask(h, rule({ interval: 3 }), anchor);
		const r = await h.app.recurrence.complete(t.id);
		expect(r).toMatchObject({ date: anchor, autoSkipped: 0 });
		expect(records(h, t.id)).toEqual([{ taskId: t.id, occurrenceDate: anchor, status: "done", resolvedAt: NOW, auto: false, completedOn: "2026-10-05" }]);
		expect(current(h, t.id)).toBe(next);
	});

	it("after completion, done early: completion day plus the interval (due Oct 10, done Oct 5 → Oct 8)", async () => {
		const h = await setup();
		const t = await repeatingTask(h, rule({ interval: 3, afterCompletion: true }), "2026-10-10");
		await h.app.recurrence.complete(t.id);
		expect(records(h, t.id)[0]).toMatchObject({ occurrenceDate: "2026-10-10", completedOn: "2026-10-05" });
		expect(current(h, t.id)).toBe("2026-10-08");
	});

	it("after completion, done late: completion day plus the interval (due Oct 8, done Oct 10 → Oct 13)", async () => {
		const h = await setup();
		const t = await repeatingTask(h, rule({ interval: 3, afterCompletion: true }), "2026-10-08");
		h.clock.set("2026-10-10T10:00:00.000Z");
		await h.app.recurrence.complete(t.id);
		expect(records(h, t.id)[0]).toMatchObject({ occurrenceDate: "2026-10-08", completedOn: "2026-10-10" });
		expect(current(h, t.id)).toBe("2026-10-13");
	});

	it("after completion, the first occurrence done early then on time: the anchor stays (Oct 10 → Oct 8 → Oct 11)", async () => {
		const h = await setup();
		const t = await repeatingTask(h, rule({ interval: 3, afterCompletion: true }), "2026-10-10");
		await h.app.recurrence.complete(t.id); // done Oct 5
		expect(current(h, t.id)).toBe("2026-10-08");
		h.clock.set("2026-10-08T10:00:00.000Z");
		await h.app.recurrence.complete(t.id);
		expect(current(h, t.id)).toBe("2026-10-11");
		expect(task(h, t.id).recurrence?.anchor).toBe("2026-10-10");
		expect(task(h, t.id).recurrence?.anchoredAt).toBeUndefined();
	});

	it("after completion, done on time: the date plus the interval", async () => {
		const h = await setup();
		const t = await repeatingTask(h, rule({ interval: 3, afterCompletion: true }), "2026-10-05");
		await h.app.recurrence.complete(t.id);
		expect(current(h, t.id)).toBe("2026-10-08");
	});

	it("after completion, two early completions: a taken next date moves on by a whole interval", async () => {
		const h = await setup();
		const t = await repeatingTask(h, rule({ interval: 3, afterCompletion: true }), "2026-10-04");
		await h.app.recurrence.complete(t.id); // Oct 4 done on Oct 5 → Oct 8
		expect(current(h, t.id)).toBe("2026-10-08");
		h.clock.set("2026-10-07T10:00:00.000Z");
		await h.app.recurrence.complete(t.id); // Oct 8 done early on Oct 7 → Oct 10
		expect(current(h, t.id)).toBe("2026-10-10");
		await h.app.recurrence.complete(t.id); // Oct 10 done early on Oct 7 → Oct 10 is taken → Oct 13
		expect(records(h, t.id).map((x) => [x.occurrenceDate, x.completedOn])).toEqual([
			["2026-10-04", "2026-10-05"],
			["2026-10-08", "2026-10-07"],
			["2026-10-10", "2026-10-07"],
		]);
		expect(current(h, t.id)).toBe("2026-10-13");
	});

	it("refuses a task that does not repeat or an ended series", async () => {
		const h = await setup();
		const plain = await plainTask(h);
		await rejects(h.app.recurrence.complete(plain.id), "InvalidValue");
		const t = await repeatingTask(h, rule(), "2026-10-05");
		await h.app.recurrence.stop(t.id);
		await rejects(h.app.recurrence.complete(t.id), "InvalidValue");
		await rejects(h.app.recurrence.skip(t.id), "InvalidValue");
	});
});

describe("skip (REC-04)", () => {
	it("records skipped (not automatic) and advances", async () => {
		const h = await setup();
		const t = await repeatingTask(h, rule({ freq: "weekly" }), "2026-10-05");
		const r = await labelledAndUndoable(h, () => h.app.recurrence.skip(t.id), SKIP_OCCURRENCE_LABEL);
		expect(r).toMatchObject({ date: "2026-10-05", seriesEnded: false });
		expect(records(h, t.id)).toEqual([{ taskId: t.id, occurrenceDate: "2026-10-05", status: "skipped", resolvedAt: NOW, auto: false, completedOn: "2026-10-05" }]);
		expect(current(h, t.id)).toBe("2026-10-12");
	});

	it("M2: after completion, an overdue occurrence skipped today counts from today", async () => {
		const h = await setup();
		const t = await repeatingTask(h, rule({ interval: 3, afterCompletion: true }), "2026-10-01");
		await h.app.recurrence.skip(t.id);
		expect(records(h, t.id)[0]).toMatchObject({ occurrenceDate: "2026-10-01", completedOn: "2026-10-05" });
		expect(current(h, t.id)).toBe("2026-10-08");
	});

	it("M2: after completion, an on-time skip is unchanged (the date plus the interval)", async () => {
		const h = await setup();
		const t = await repeatingTask(h, rule({ interval: 3, afterCompletion: true }), "2026-10-05");
		await h.app.recurrence.skip(t.id);
		expect(current(h, t.id)).toBe("2026-10-08");
	});

	it("a skip can end a counted series", async () => {
		const h = await setup();
		const t = await repeatingTask(h, rule(), "2026-10-05", { kind: "count", count: 1 });
		expect((await h.app.recurrence.skip(t.id)).seriesEnded).toBe(true);
		expect(task(h, t.id).status).toBe("completed");
	});
});

describe("reopen (B23)", () => {
	it("removes the record: the date is unresolved again and becomes the current overdue occurrence", async () => {
		const h = await setup();
		const t = await repeatingTask(h, rule(), "2026-10-01");
		await h.app.recurrence.complete(t.id);
		const r = await labelledAndUndoable(h, () => h.app.recurrence.reopen(t.id, "2026-10-02"), REOPEN_OCCURRENCE_LABEL);
		expect(r).toMatchObject({ date: "2026-10-02" });
		expect(records(h, t.id).map((x) => x.occurrenceDate)).toEqual(["2026-10-01", "2026-10-03", "2026-10-04"]);
		expect(current(h, t.id)).toBe("2026-10-02");
	});

	it("L3: refuses a record before a moved series' start (history), but not an early after-completion one", async () => {
		const h = await setup();
		const t = await repeatingTask(h, rule(), "2026-10-01");
		await h.app.recurrence.complete(t.id); // Oct 1 done, Oct 2–4 skipped
		h.clock.set("2026-10-05T11:00:00.000Z");
		await h.app.tasks.update(t.id, { scheduled: { kind: "date", date: "2026-10-08" } });
		expect(await rejects(h.app.recurrence.reopen(t.id, "2026-10-02"), "InvalidValue")).toBe("That occurrence is before the series' start date.");
		expect(records(h, t.id)).toHaveLength(4);
		const ac = await repeatingTask(h, rule({ interval: 3, afterCompletion: true }), "2026-10-10");
		await h.app.recurrence.complete(ac.id); // Oct 10 done Oct 5 → Oct 8, before the anchor
		await h.app.recurrence.complete(ac.id); // Oct 8 done early
		expect((await h.app.recurrence.reopen(ac.id, "2026-10-08")).wrote).toBe(true);
	});

	it("refuses a date without a record", async () => {
		const h = await setup();
		const t = await repeatingTask(h, rule(), "2026-10-01");
		await rejects(h.app.recurrence.reopen(t.id, "2026-10-01"), "NotFound");
	});

	it("a series ended by its count opens again", async () => {
		const h = await setup();
		const t = await repeatingTask(h, rule(), "2026-10-05", { kind: "count", count: 1 });
		await h.app.recurrence.complete(t.id);
		await h.app.recurrence.reopen(t.id, "2026-10-05");
		expect(task(h, t.id)).toMatchObject({ status: "open", completedAt: null, recurrence: { endedAt: null } });
		expect(current(h, t.id)).toBe("2026-10-05");
	});

	it("a series stopped with Stop repeating stays stopped", async () => {
		const h = await setup();
		const t = await repeatingTask(h, rule(), "2026-10-05");
		await h.app.recurrence.complete(t.id);
		await h.app.recurrence.stop(t.id);
		await h.app.recurrence.reopen(t.id, "2026-10-05");
		expect(task(h, t.id).status).toBe("completed");
		expect(records(h, t.id)).toEqual([]);
	});
});

describe("stop", () => {
	it("ends the series now: completed, history kept; a second stop writes nothing", async () => {
		const h = await setup();
		const t = await repeatingTask(h, rule(), "2026-10-04");
		await h.app.recurrence.complete(t.id);
		const r = await labelledAndUndoable(h, () => h.app.recurrence.stop(t.id), STOP_REPEATING_LABEL);
		expect(r.seriesEnded).toBe(true);
		expect(task(h, t.id)).toMatchObject({ status: "completed", completedAt: NOW, recurrence: { endedAt: NOW } });
		expect(records(h, t.id)).toHaveLength(1);
		expect((await h.app.recurrence.stop(t.id)).wrote).toBe(false);
		const plain = await plainTask(h);
		await rejects(h.app.recurrence.stop(plain.id), "InvalidValue");
	});
});

describe("sequences: after completion vs fixed (user decision, undo after each step)", () => {
	const at = (h: AppHarness, day: string) => h.clock.set(`${day}T10:00:00.000Z`);

	/** Runs a step, checks the next date, undoes it (back to `before`), and runs it again. */
	async function step(h: AppHarness, id: string, write: () => Promise<RecurrenceResult>, next: string | null, before: string | null): Promise<void> {
		await write();
		expect(current(h, id)).toBe(next);
		await h.app.store.undo();
		expect(current(h, id)).toBe(before);
		await write();
		expect(current(h, id)).toBe(next);
	}

	it("after completion: early done, skip, reopen the skip, reopen the done one", async () => {
		const h = await setup();
		const t = await repeatingTask(h, rule({ interval: 3, afterCompletion: true }), "2026-10-10");
		expect(current(h, t.id)).toBe("2026-10-10");
		await step(h, t.id, () => h.app.recurrence.complete(t.id), "2026-10-08", "2026-10-10"); // done Oct 5
		at(h, "2026-10-08");
		await step(h, t.id, () => h.app.recurrence.skip(t.id), "2026-10-11", "2026-10-08");
		// The anchor stays where the user set it.
		expect(task(h, t.id).recurrence).toMatchObject({ anchor: "2026-10-10", versions: [{ effectiveFrom: "2026-10-10" }] });
		// The base falls back to the Oct 10 record done on Oct 5.
		await step(h, t.id, () => h.app.recurrence.reopen(t.id, "2026-10-08"), "2026-10-08", "2026-10-11");
		// No record left: the next date is the anchor.
		await step(h, t.id, () => h.app.recurrence.reopen(t.id, "2026-10-10"), "2026-10-10", "2026-10-08");
		expect(records(h, t.id)).toEqual([]);
	});

	it("after completion: reopening an older record does not move the next date", async () => {
		const h = await setup();
		const t = await repeatingTask(h, rule({ interval: 3, afterCompletion: true }), "2026-10-10");
		await h.app.recurrence.complete(t.id); // Oct 10 done on Oct 5 → Oct 8
		at(h, "2026-10-08");
		await h.app.recurrence.skip(t.id); // Oct 8 skipped → Oct 11
		await step(h, t.id, () => h.app.recurrence.reopen(t.id, "2026-10-10"), "2026-10-11", "2026-10-11");
	});

	it("after completion: a missed occurrence done late has no catch-up (Oct 8 done on Oct 20 → Oct 23)", async () => {
		const h = await setup();
		const t = await repeatingTask(h, rule({ interval: 3, afterCompletion: true }), "2026-10-10");
		await h.app.recurrence.complete(t.id); // → Oct 8
		at(h, "2026-10-20");
		await step(h, t.id, () => h.app.recurrence.complete(t.id), "2026-10-23", "2026-10-08");
		expect(records(h, t.id).map((x) => [x.occurrenceDate, x.status, x.auto, x.completedOn])).toEqual([
			["2026-10-08", "done", false, "2026-10-20"],
			["2026-10-10", "done", false, "2026-10-05"],
		]);
	});

	it("fixed: done early keeps the schedule (Oct 10 done on Oct 5 → Oct 13)", async () => {
		const h = await setup();
		const t = await repeatingTask(h, rule({ interval: 3 }), "2026-10-10");
		await step(h, t.id, () => h.app.recurrence.complete(t.id), "2026-10-13", "2026-10-10");
	});

	it("fixed: missed Oct 10, 13, 16 and 19, completed on Oct 20 → Oct 10 done, the rest auto-skipped, next Oct 22", async () => {
		const h = await setup();
		const t = await repeatingTask(h, rule({ interval: 3 }), "2026-10-10");
		at(h, "2026-10-20");
		await step(h, t.id, () => h.app.recurrence.complete(t.id), "2026-10-22", "2026-10-10");
		expect(records(h, t.id).map((x) => [x.occurrenceDate, x.status, x.auto, x.completedOn])).toEqual([
			["2026-10-10", "done", false, "2026-10-20"],
			["2026-10-13", "skipped", true, null],
			["2026-10-16", "skipped", true, null],
			["2026-10-19", "skipped", true, null],
		]);
	});
});

describe("endExhaustedSeries (the open and hourly sweep)", () => {
	/** Records written outside the service, as sync or an import delivers them. */
	function deliver(h: AppHarness, ...list: OccurrenceRecord[]): void {
		const map = new Map(h.store.data.occurrenceRecords);
		for (const r of list) map.set(`${r.taskId}:${r.occurrenceDate}`, r);
		h.store.commit({ ...h.store.data, occurrenceRecords: map }, list.map((r) => ({ c: "occurrenceRecords" as const, id: `${r.taskId}:${r.occurrenceDate}`, v: r })));
	}
	const rec = (taskId: string, date: string): OccurrenceRecord => ({
		taskId,
		occurrenceDate: date,
		status: "done",
		resolvedAt: "2026-10-04T09:00:00.000Z",
		auto: false,
		completedOn: date,
	});

	it("ends a series whose dates up to its end date are all resolved", async () => {
		const h = await setup();
		const t = await repeatingTask(h, rule(), "2026-10-02", { kind: "date", date: "2026-10-04" });
		deliver(h, rec(t.id, "2026-10-02"), rec(t.id, "2026-10-03"), rec(t.id, "2026-10-04"));
		expect(task(h, t.id).status).toBe("open");
		expect(await h.app.recurrence.endExhaustedSeries()).toBe(1);
		expect(task(h, t.id)).toMatchObject({ status: "completed", completedAt: NOW, recurrence: { endedAt: NOW } });
		expect(h.app.store.undoLabel).not.toBe(END_REPEAT_LABEL);
		expect(await h.app.recurrence.endExhaustedSeries()).toBe(0);
	});

	it("a series moved past its end date loses the end (M5), so the sweep leaves it alone", async () => {
		const h = await setup();
		const t = await repeatingTask(h, rule(), "2026-10-05", { kind: "date", date: "2026-10-10" });
		const r = await h.app.tasks.update(t.id, { scheduled: { kind: "date", date: "2026-10-12" } });
		expect(r.reanchored).toEqual({ date: "2026-10-12", endCleared: true });
		expect(task(h, t.id).recurrence?.end).toEqual({ kind: "never" });
		expect(await h.app.recurrence.endExhaustedSeries()).toBe(0);
		expect(current(h, t.id)).toBe("2026-10-12");
	});

	it("ends a series whose count is reached by delivered records", async () => {
		const h = await setup();
		const t = await repeatingTask(h, rule(), "2026-10-02", { kind: "count", count: 2 });
		deliver(h, rec(t.id, "2026-10-02"), rec(t.id, "2026-10-03"));
		expect(await h.app.recurrence.endExhaustedSeries()).toBe(1);
		expect(task(h, t.id)).toMatchObject({ status: "completed", recurrence: { endedAt: NOW } });
	});

	it("leaves a live series, an overdue last occurrence and a stopped series alone", async () => {
		const h = await setup();
		const live = await repeatingTask(h, rule(), "2026-10-01");
		// End date passed but its last occurrence (Oct 3) is still open: it stays, overdue, to be completed.
		const overdue = await repeatingTask(h, rule(), "2026-10-02", { kind: "date", date: "2026-10-03" });
		deliver(h, rec(overdue.id, "2026-10-02"));
		const stopped = await repeatingTask(h, rule(), "2026-10-01", { kind: "count", count: 1 });
		await h.app.recurrence.stop(stopped.id);
		deliver(h, rec(stopped.id, "2026-10-01"));
		const before = [live, overdue, stopped].map((t) => task(h, t.id));
		expect(await h.app.recurrence.endExhaustedSeries()).toBe(0);
		expect([live, overdue, stopped].map((t) => task(h, t.id))).toEqual(before);
		expect(current(h, overdue.id)).toBe("2026-10-03");
	});

	it("writes nothing when nothing is exhausted: no undo entry, no changed event", async () => {
		const h = await setup();
		await repeatingTask(h, rule(), "2026-10-01");
		const label = h.app.store.undoLabel;
		const events: string[] = [];
		h.app.store.bus.on("changed", (e) => events.push(e.label));
		expect(await h.app.recurrence.endExhaustedSeries()).toBe(0);
		expect(events).toEqual([]);
		expect(h.app.store.undoLabel).toBe(label);
	});
});

describe("the repeating branches of TaskService", () => {
	// The recurring branches of TaskService. Europe/Berlin;
	// 2026-10-05 is a Monday.

	const NOW = "2026-10-05T10:00:00.000Z";
	const SETTINGS = { zone: () => "Europe/Berlin", noteFolder: () => "Task notes", upcomingDays: () => 14, weekStart: () => "MO" as WeekStart, eveningTime: () => "20:00" };

	async function setup(): Promise<AppHarness> {
		const h = await appHarness();
		h.clock.set(NOW);
		return h;
	}

	const task = (h: AppHarness, id: string): Task => h.app.store.state.tasks.get(id)!;
	const records = (h: AppHarness, id: string): OccurrenceRecord[] => [...(indexOccurrenceRecords(h.app.store.state.occurrenceRecords).get(id) ?? [])];
	const current = (h: AppHarness, id: string): string | null => currentOccurrence(task(h, id), records(h, id), "2026-10-05", "MO");

	async function rejects(p: Promise<unknown>, message?: string): Promise<void> {
		try {
			await p;
		} catch (err) {
			expect(isDomainError(err, "InvalidValue")).toBe(true);
			if (message !== undefined) expect((err as Error).message).toBe(message);
			return;
		}
		throw new Error("expected InvalidValue");
	}

	async function daily(h: AppHarness, anchor = "2026-10-01"): Promise<Task> {
		return (await h.app.tasks.create({ title: "Stretch", scheduled: { kind: "date", date: anchor }, repeat: { rule: rule() } })).task;
	}

	describe("create with repeat (Quick Add, one write)", () => {
		it("the date becomes the anchor and scheduled is stored as null; one undo removes it", async () => {
			const h = await setup();
			const { task: t } = await h.app.tasks.create({
				title: "Gym",
				scheduled: { kind: "date", date: "2026-10-09" },
				repeat: { rule: rule({ freq: "weekly" }), end: { kind: "count", count: 10 } },
			});
			expect(t).toMatchObject({
				scheduled: null,
				recurrence: { anchor: "2026-10-09", versions: [{ effectiveFrom: "2026-10-09", rule: rule({ freq: "weekly" }) }], end: { kind: "count", count: 10 }, endedAt: null },
			});
			expect(h.app.store.undoLabel).toBe("Create task");
			await h.app.store.undo();
			expect(h.app.store.state.tasks.has(t.id)).toBe(false);
			expect(h.app.store.canUndo).toBe(false);
		});

		it("a timed date gives the rule its wall time and zone; without a date the anchor is today", async () => {
			const h = await setup();
			const timed = (await h.app.tasks.create({ title: "Run", scheduled: { kind: "datetime", local: "2026-10-06T06:45", tz: "Europe/Berlin" }, repeat: { rule: rule() } })).task;
			expect(timed.recurrence?.versions[0]?.rule).toMatchObject({ time: "06:45", tz: "Europe/Berlin" });
			expect(timed.recurrence?.anchor).toBe("2026-10-06");
			const undated = (await h.app.tasks.create({ title: "Read", repeat: { rule: rule() } })).task;
			expect(undated.recurrence).toMatchObject({ anchor: "2026-10-05", end: { kind: "never" } });
			const none = (await h.app.tasks.create({ title: "Plain", repeat: null })).task;
			expect(none.recurrence).toBeNull();
		});

		it("refuses a deadline, a parent or an invalid rule together with repeat", async () => {
			const h = await setup();
			await rejects(h.app.tasks.create({ title: "x", deadline: { kind: "date", date: "2026-10-20" }, repeat: { rule: rule() } }), "A repeating task has no deadline.");
			const parent = (await h.app.tasks.create({ title: "Parent" })).task;
			await rejects(h.app.tasks.create({ title: "x", parentId: parent.id, repeat: { rule: rule() } }), "A subtask cannot repeat.");
			await rejects(h.app.tasks.create({ title: "x", repeat: { rule: rule({ interval: 0 }) } }));
			await rejects(h.app.tasks.create({ title: "x", repeat: { rule: rule(), end: { kind: "count", count: -1 } } }));
		});
	});

	describe("complete and reopen on a repeating task", () => {
		it("complete delegates to the occurrence (no subtask confirmation) and carries its label", async () => {
			const h = await setup();
			const t = await daily(h, "2026-10-05");
			await h.app.tasks.create({ title: "Sub", parentId: t.id });
			expect(await h.app.tasks.complete(t.id)).toEqual({ kind: "done", completed: 1, label: "Complete occurrence", seriesEnded: false });
			expect(h.app.store.undoLabel).toBe("Complete occurrence");
			expect(task(h, t.id).status).toBe("open");
			expect(current(h, t.id)).toBe("2026-10-06");
		});

		it("a plain task keeps the old behaviour and label", async () => {
			const h = await setup();
			const t = (await h.app.tasks.create({ title: "Once" })).task;
			expect(await h.app.tasks.complete(t.id)).toEqual({ kind: "done", completed: 1, label: "Complete task" });
			expect(h.app.store.undoLabel).toBe("Complete task");
		});

		it("reopen of an ended series clears endedAt", async () => {
			const h = await setup();
			const t = await daily(h, "2026-10-05");
			await h.app.recurrence.stop(t.id);
			await h.app.tasks.reopen(t.id);
			expect(task(h, t.id)).toMatchObject({ status: "open", completedAt: null, recurrence: { endedAt: null, end: { kind: "never" } } });
			expect(current(h, t.id)).toBe("2026-10-05");
		});

		it("reopen of a series whose count is used up sets the end to never", async () => {
			const h = await setup();
			const t = (await h.app.tasks.create({ title: "Twice", scheduled: { kind: "date", date: "2026-10-04" }, repeat: { rule: rule(), end: { kind: "count", count: 2 } } })).task;
			await h.app.tasks.complete(t.id);
			await h.app.tasks.complete(t.id);
			expect(task(h, t.id).status).toBe("completed");
			await h.app.tasks.reopen(t.id);
			expect(task(h, t.id).recurrence).toMatchObject({ endedAt: null, end: { kind: "never" } });
			expect(current(h, t.id)).toBe("2026-10-06");
		});
	});

	describe("schedule and deadline edits of a repeating task (spec §21.1 item 2, decision 9)", () => {
		it("a deadline is refused", async () => {
			const h = await setup();
			const t = await daily(h);
			await rejects(h.app.tasks.update(t.id, { deadline: { kind: "date", date: "2026-10-20" } }), "A repeating task has no deadline.");
			expect((await h.app.tasks.update(t.id, { deadline: null })).changed).toBe(false);
		});

		it("scheduled null stops repeating: a plain undated task, records kept", async () => {
			const h = await setup();
			const t = await daily(h);
			await h.app.tasks.complete(t.id);
			const kept = records(h, t.id);
			await h.app.tasks.update(t.id, { scheduled: null });
			expect(task(h, t.id)).toMatchObject({ recurrence: null, scheduled: null });
			expect(records(h, t.id)).toEqual(kept);
		});

		it("a date re-anchors the series there; scheduled stays null", async () => {
			const h = await setup();
			const t = await daily(h);
			await h.app.tasks.update(t.id, { scheduled: { kind: "date", date: "2026-10-08" } });
			expect(task(h, t.id)).toMatchObject({ scheduled: null, recurrence: { anchor: "2026-10-08", versions: [{ effectiveFrom: "2026-10-08", rule: rule() }] } });
			expect(current(h, t.id)).toBe("2026-10-08");
		});

		it("a timed date gives the series its time; a date-only one makes it all-day; later versions stay", async () => {
			const h = await setup();
			const t = await daily(h);
			await h.app.recurrence.setRepeat(t.id, rule({ interval: 2 }), "2026-10-20");
			await h.app.tasks.update(t.id, { scheduled: { kind: "datetime", local: "2026-10-07T18:00", tz: "Europe/Berlin" } });
			expect(task(h, t.id).recurrence?.versions).toEqual([
				{ effectiveFrom: "2026-10-07", rule: rule({ time: "18:00", tz: "Europe/Berlin" }) },
				{ effectiveFrom: "2026-10-20", rule: rule({ interval: 2 }) },
			]);
			await h.app.tasks.update(t.id, { scheduled: { kind: "date", date: "2026-10-07" } });
			expect(task(h, t.id).recurrence?.versions[0]?.rule).toMatchObject({ time: null, tz: null });
		});

		it("an after-completion series with history moves to a later date", async () => {
			const h = await setup();
			const t = (await h.app.tasks.create({ title: "Water", scheduled: { kind: "date", date: "2026-10-05" }, repeat: { rule: rule({ interval: 3, afterCompletion: true }) } })).task;
			await h.app.tasks.complete(t.id);
			expect(current(h, t.id)).toBe("2026-10-08");
			await h.app.tasks.update(t.id, { scheduled: { kind: "date", date: "2026-10-20" } });
			expect(current(h, t.id)).toBe("2026-10-20");
		});

		it("Schedule for today: an after-completion series moved earlier than its next date counts from today", async () => {
			const h = await setup();
			h.clock.set("2026-10-04T10:00:00.000Z");
			const t = (await h.app.tasks.create({ title: "Water", scheduled: { kind: "date", date: "2026-10-04" }, repeat: { rule: rule({ interval: 3, afterCompletion: true }) } })).task;
			await h.app.tasks.complete(t.id); // done yesterday (Oct 4) → Oct 7
			h.clock.set(NOW);
			expect(current(h, t.id)).toBe("2026-10-07");
			await h.app.tasks.update(t.id, { scheduled: { kind: "date", date: "2026-10-05" } });
			expect(task(h, t.id).recurrence).toMatchObject({ anchor: "2026-10-05", anchoredAt: NOW });
			expect(current(h, t.id)).toBe("2026-10-05");
			h.clock.set("2026-10-05T11:00:00.000Z");
			await h.app.tasks.complete(t.id);
			expect(current(h, t.id)).toBe("2026-10-08");
		});

		it("a timed move takes the picked time until the next record", async () => {
			const h = await setup();
			h.clock.set("2026-10-04T10:00:00.000Z");
			const t = (await h.app.tasks.create({ title: "Water", scheduled: { kind: "date", date: "2026-10-04" }, repeat: { rule: rule({ interval: 3, afterCompletion: true }) } })).task;
			await h.app.tasks.complete(t.id);
			h.clock.set(NOW);
			await h.app.tasks.update(t.id, { scheduled: { kind: "datetime", local: "2026-10-05T18:00", tz: "Europe/Berlin" } });
			expect(effectiveSchedule(task(h, t.id), records(h, t.id), { today: "2026-10-05", zone: "Europe/Berlin", upcomingDays: 7, weekStart: "MO" })).toEqual({
				kind: "datetime",
				local: "2026-10-05T18:00",
				tz: "Europe/Berlin",
			});
		});

		it("undo of a move restores the previous next date", async () => {
			const h = await setup();
			h.clock.set("2026-10-04T10:00:00.000Z");
			const t = (await h.app.tasks.create({ title: "Water", scheduled: { kind: "date", date: "2026-10-04" }, repeat: { rule: rule({ interval: 3, afterCompletion: true }) } })).task;
			await h.app.tasks.complete(t.id);
			h.clock.set(NOW);
			await h.app.tasks.update(t.id, { scheduled: { kind: "date", date: "2026-10-05" } });
			expect(current(h, t.id)).toBe("2026-10-05");
			await h.app.store.undo();
			expect(current(h, t.id)).toBe("2026-10-07");
			expect(task(h, t.id).recurrence?.anchoredAt).toBeUndefined();
		});

		it("making a task with old records repeat again stamps anchoredAt, so after completion starts from the new date", async () => {
			const h = await setup();
			h.clock.set("2026-10-01T10:00:00.000Z");
			const t = (await h.app.tasks.create({ title: "Water", scheduled: { kind: "date", date: "2026-10-01" }, repeat: { rule: rule({ interval: 3, afterCompletion: true }) } })).task;
			await h.app.tasks.complete(t.id); // Oct 1 → Oct 4
			await h.app.recurrence.setRepeat(t.id, null); // a plain task on Oct 4, the record kept
			h.clock.set(NOW);
			await h.app.tasks.update(t.id, { scheduled: { kind: "date", date: "2026-10-09" } });
			await h.app.recurrence.setRepeat(t.id, rule({ interval: 3, afterCompletion: true }));
			expect(task(h, t.id).recurrence).toMatchObject({ anchor: "2026-10-09", anchoredAt: NOW });
			expect(current(h, t.id)).toBe("2026-10-09");
		});

		it("the same date again changes nothing", async () => {
			const h = await setup();
			const t = await daily(h, "2026-10-07");
			expect((await h.app.tasks.update(t.id, { scheduled: { kind: "date", date: "2026-10-07" } })).changed).toBe(false);
		});
	});

	describe("subtasks, duplicate and trash", () => {
		it("a repeating task cannot become a subtask; a repeating parent can have subtasks (D10)", async () => {
			const h = await setup();
			const t = await daily(h);
			const parent = (await h.app.tasks.create({ title: "Parent" })).task;
			await rejects(h.app.tasks.setParent(t.id, parent.id), "A repeating task cannot be a subtask.");
			const sub = (await h.app.tasks.create({ title: "Sub", parentId: t.id })).task;
			expect(sub.parentId).toBe(t.id);
		});

		it("H3, N7: duplicate starts the copy at the source's current occurrence with only the rule in force then", async () => {
			const h = await setup();
			const t = await daily(h, "2025-03-01");
			await h.app.tasks.complete(t.id); // a long catch-up; the source is due today now
			// Every 3 days from Nov 1, counted from the source's anchor: Nov 3, 6, 9 for the source.
			await h.app.recurrence.setRepeat(t.id, rule({ interval: 3 }), "2026-11-01");
			const copy = await h.app.tasks.duplicate(t.id);
			expect(copy.recurrence).toEqual({
				anchor: "2026-10-05",
				versions: [{ effectiveFrom: "2026-10-05", rule: rule() }],
				end: { kind: "never" },
				endedAt: null,
			});
			// The later version is not copied: it would count from the copy's anchor (Nov 2, 5, 8), not Nov 3, 6, 9.
			expect(occurrencesBetween(task(h, t.id).recurrence!, "2026-11-01", "2026-11-09", "MO")).toEqual(["2026-11-03", "2026-11-06", "2026-11-09"]);
			expect(copy.status).toBe("open");
			expect(records(h, copy.id)).toEqual([]);
			expect(current(h, copy.id)).toBe("2026-10-05");
			const r = await h.app.recurrence.complete(copy.id);
			expect(r.autoSkipped).toBe(0);
		});

		it("H3: a 2025 daily series never completed: the copy is due today and completes with no auto-skips", async () => {
			const h = await setup();
			const t = await daily(h, "2025-03-01");
			const copy = await h.app.tasks.duplicate(t.id);
			expect(copy.recurrence?.anchor).toBe("2026-10-05");
			expect(current(h, copy.id)).toBe("2026-10-05");
			expect((await h.app.recurrence.complete(copy.id)).autoSkipped).toBe(0);
			await h.app.recurrence.stop(t.id);
			expect((await h.app.tasks.duplicate(t.id)).recurrence?.anchor).toBe("2026-10-05");
		});

		it("H3: an overdue weekly or monthly copy keeps the source's weekday and day of month", async () => {
			const h = await setup();
			const fridays = (await h.app.tasks.create({ title: "Review", scheduled: { kind: "date", date: "2025-03-07" }, repeat: { rule: rule({ freq: "weekly" }) } })).task;
			const copy = await h.app.tasks.duplicate(fridays.id);
			expect(copy.recurrence).toMatchObject({ anchor: "2026-10-09", versions: [{ effectiveFrom: "2026-10-09", rule: { weekdays: ["FR"] } }] });
			const rent = (await h.app.tasks.create({ title: "Rent", scheduled: { kind: "date", date: "2025-01-31" }, repeat: { rule: rule({ freq: "monthly" }) } })).task;
			const rentCopy = await h.app.tasks.duplicate(rent.id);
			expect(rentCopy.recurrence).toMatchObject({ anchor: "2026-10-31", versions: [{ rule: { monthly: { kind: "day", day: 31 } } }] });
		});

		it("delete and restore keep the records; purging removes them", async () => {
			const h = await setup();
			const t = await daily(h);
			await h.app.tasks.complete(t.id);
			expect(records(h, t.id)).toHaveLength(4);
			const entry = await h.app.tasks.delete(t.id);
			expect(records(h, t.id)).toHaveLength(4);
			await h.app.tasks.restore(entry.batchId);
			expect(records(h, t.id)).toHaveLength(4);
			const again = await h.app.tasks.delete(t.id);
			const other = await daily(h, "2026-10-05");
			await h.app.tasks.complete(other.id);
			await h.app.tasks.purge(again.batchId);
			expect(records(h, t.id)).toEqual([]);
			expect(records(h, other.id)).toHaveLength(1);
		});

		it("emptying the trash and the 30-day purge remove the records too", async () => {
			const h = await setup();
			const a = await daily(h);
			await h.app.tasks.complete(a.id);
			await h.app.tasks.delete(a.id);
			await h.app.tasks.emptyTrash();
			expect(records(h, a.id)).toEqual([]);
			const b = await daily(h);
			await h.app.tasks.complete(b.id);
			await h.app.tasks.delete(b.id);
			h.clock.set("2026-11-20T10:00:00.000Z");
			expect(await h.app.tasks.purgeExpired()).toBe(1);
			expect(records(h, b.id)).toEqual([]);
		});
	});

	describe("deep-review fixes in TaskService", () => {
		it("M3: complete queued behind a setRepeat refuses instead of ending the series", async () => {
			const h = await setup();
			const t = (await h.app.tasks.create({ title: "Gym" })).task;
			const repeat = h.app.recurrence.setRepeat(t.id, rule());
			const complete = h.app.tasks.complete(t.id);
			await repeat;
			await rejects(complete, "This task repeats now; complete it again.");
			expect(task(h, t.id)).toMatchObject({ status: "open", recurrence: { endedAt: null } });
			expect(records(h, t.id)).toEqual([]);
		});

		it("M4: a weekly repeat made by create or setRepeat carries the week start setting", async () => {
			const h = await setup();
			const a = (await h.app.tasks.create({ title: "A", repeat: { rule: rule({ freq: "weekly", interval: 2 }) } })).task;
			expect(a.recurrence?.versions[0]?.rule.weekStart).toBe("MO");
			const b = (await h.app.tasks.create({ title: "B" })).task;
			await h.app.recurrence.setRepeat(b.id, rule({ freq: "weekly", weekdays: ["SU"], weekStart: "SU" }));
			expect(task(h, b.id).recurrence?.versions[0]?.rule.weekStart).toBe("SU");
			const c = (await h.app.tasks.create({ title: "C", repeat: { rule: rule() } })).task;
			expect(c.recurrence?.versions[0]?.rule).not.toHaveProperty("weekStart");
		});

		it("M5: update and place report a re-anchor with the new current date; a passed end date is removed", async () => {
			const h = await setup();
			const t = (await h.app.tasks.create({ title: "Gym", scheduled: { kind: "date", date: "2026-10-05" }, repeat: { rule: rule({ freq: "weekly" }), end: { kind: "date", date: "2026-10-20" } } })).task;
			const r = await h.app.tasks.update(t.id, { scheduled: { kind: "date", date: "2026-10-07" } });
			expect(r.reanchored).toEqual({ date: "2026-10-07", endCleared: false });
			expect(h.app.store.undoLabel).toBe("Edit task");
			const p = await h.app.tasks.place(t.id, [t.id], { scheduled: { kind: "date", date: "2026-10-28" } });
			expect(p.reanchored).toEqual({ date: "2026-10-28", endCleared: true });
			expect(task(h, t.id).recurrence?.end).toEqual({ kind: "never" });
			const same = await h.app.tasks.update(t.id, { scheduled: { kind: "date", date: "2026-10-28" } });
			expect(same.reanchored).toBeUndefined();
			const plain = await h.app.tasks.update(t.id, { title: "Gym class" });
			expect(plain.reanchored).toBeUndefined();
		});

		it("M1: old records, then Never, then weekly ending after 5: open, dated, and 5 completions end it", async () => {
			const h = await setup();
			h.clock.set("2026-08-01T10:00:00.000Z");
			const t = (await h.app.tasks.create({ title: "Stretch", scheduled: { kind: "date", date: "2026-08-01" }, repeat: { rule: rule() } })).task;
			for (let i = 0; i < 34; i++) {
				h.clock.set(`2026-${i < 31 ? "08" : "09"}-${String(i < 31 ? i + 1 : i - 30).padStart(2, "0")}T10:00:00.000Z`);
				await h.app.tasks.complete(t.id);
			}
			expect(records(h, t.id)).toHaveLength(34);
			h.clock.set(NOW);
			await h.app.recurrence.setRepeat(t.id, null);
			await h.app.tasks.update(t.id, { scheduled: { kind: "date", date: "2026-10-09" } });
			h.clock.set("2026-10-05T10:01:00.000Z");
			await h.app.recurrence.setRepeat(t.id, rule({ freq: "weekly" }), undefined, { kind: "count", count: 5 });
			expect(task(h, t.id)).toMatchObject({ status: "open", recurrence: { anchor: "2026-10-09", endedAt: null } });
			expect(current(h, t.id)).toBe("2026-10-09");
			for (let i = 0; i < 5; i++) {
				h.clock.set(`2026-10-${String(10 + i).padStart(2, "0")}T10:00:00.000Z`);
				const r = await h.app.tasks.complete(t.id);
				expect(r.kind === "done" && r.seriesEnded).toBe(i === 4);
			}
			expect(task(h, t.id).status).toBe("completed");
		});
	});

	describe("second-round fixes in TaskService and setRepeat", () => {
		it("N1: a date move keeps a count end's progress (daily, ends after 5, 3 done, moved → 2 left)", async () => {
			const h = await setup();
			const t = (await h.app.tasks.create({ title: "Run", scheduled: { kind: "date", date: "2026-10-05" }, repeat: { rule: rule(), end: { kind: "count", count: 5 } } })).task;
			for (let i = 0; i < 3; i++) {
				h.clock.set(`2026-10-05T1${i}:00:00.000Z`);
				await h.app.tasks.complete(t.id);
			}
			expect(remainingCount(task(h, t.id).recurrence!, records(h, t.id))).toBe(2);
			h.clock.set("2026-10-05T15:00:00.000Z");
			await h.app.tasks.update(t.id, { scheduled: { kind: "date", date: "2026-10-12" } });
			expect(task(h, t.id).recurrence).not.toHaveProperty("countFrom");
			expect(remainingCount(task(h, t.id).recurrence!, records(h, t.id))).toBe(2);
		});

		it("N1: Schedule for today on a series already due today writes nothing, whatever its anchor", async () => {
			const h = await setup();
			const t = await daily(h, "2026-10-01");
			await h.app.tasks.complete(t.id); // catch-up: due today now, anchor still Oct 1
			expect(current(h, t.id)).toBe("2026-10-05");
			const label = h.app.store.undoLabel;
			const r = await h.app.tasks.update(t.id, { scheduled: { kind: "date", date: "2026-10-05" } });
			expect(r.changed).toBe(false);
			expect(r.reanchored).toBeUndefined();
			expect(h.app.store.undoLabel).toBe(label);
			// A different time on the same day is a move.
			const timed = await h.app.tasks.update(t.id, { scheduled: { kind: "datetime", local: "2026-10-05T18:00", tz: "Europe/Berlin" } });
			expect(timed.changed).toBe(true);
		});

		it("N1: making a task with old records repeat again stamps countFrom with anchoredAt", async () => {
			const h = await setup();
			const t = await daily(h, "2026-10-05");
			await h.app.tasks.complete(t.id);
			await h.app.recurrence.setRepeat(t.id, null);
			h.clock.set("2026-10-05T11:00:00.000Z");
			await h.app.recurrence.setRepeat(t.id, rule({ freq: "weekly" }), undefined, { kind: "count", count: 2 });
			expect(task(h, t.id).recurrence).toMatchObject({ anchoredAt: "2026-10-05T11:00:00.000Z", countFrom: "2026-10-05T11:00:00.000Z" });
			expect(remainingCount(task(h, t.id).recurrence!, records(h, t.id))).toBe(2);
		});

		it("N3: Done with an unchanged rule after a week-start change adds no version and moves no date", async () => {
			const h = await setup();
			const prefs = { weekStart: "MO" as WeekStart };
			const app = new CheckpointApp(h.store, h.clock, sequentialIds("w"), { ...SETTINGS, weekStart: () => prefs.weekStart }, new FakeNotes());
			const r = rule({ freq: "weekly", interval: 2, weekdays: ["SU", "MO"] });
			const t = (await app.tasks.create({ title: "Swim", scheduled: { kind: "date", date: "2026-09-06" }, repeat: { rule: r } })).task;
			expect(t.recurrence?.versions[0]?.rule.weekStart).toBe("MO");
			const before = occurrencesBetween(task(h, t.id).recurrence!, "2026-10-01", "2026-11-30", "MO");
			prefs.weekStart = "SU";
			const res = await app.recurrence.setRepeat(t.id, r);
			expect(res.wrote).toBe(false);
			expect(task(h, t.id).recurrence?.versions).toHaveLength(1);
			expect(occurrencesBetween(task(h, t.id).recurrence!, "2026-10-01", "2026-11-30", "SU")).toEqual(before);
		});

		it("N4: a move that leaves no occurrence before the end date removes the end", async () => {
			const h = await setup();
			const t = (await h.app.tasks.create({
				title: "Standup",
				scheduled: { kind: "date", date: "2026-10-05" },
				repeat: { rule: rule({ freq: "weekly", weekdays: ["MO"] }), end: { kind: "date", date: "2026-10-21" } },
			})).task;
			const r = await h.app.tasks.update(t.id, { scheduled: { kind: "date", date: "2026-10-20" } });
			expect(r.reanchored).toEqual({ date: "2026-10-26", endCleared: true });
			expect(task(h, t.id).recurrence?.end).toEqual({ kind: "never" });
			expect(await h.app.recurrence.endExhaustedSeries()).toBe(0);
			// A move that keeps an occurrence before the end keeps the end.
			const u = (await h.app.tasks.create({
				title: "Review",
				scheduled: { kind: "date", date: "2026-10-05" },
				repeat: { rule: rule({ freq: "weekly", weekdays: ["MO"] }), end: { kind: "date", date: "2026-10-21" } },
			})).task;
			const kept = await h.app.tasks.update(u.id, { scheduled: { kind: "date", date: "2026-10-12" } });
			expect(kept.reanchored).toEqual({ date: "2026-10-12", endCleared: false });
		});

		it("N5: a series with endedAt but left open (a hand edit) completes as a plain task", async () => {
			const h = await setup();
			const t = await daily(h, "2026-10-05");
			const broken = { ...task(h, t.id), recurrence: { ...task(h, t.id).recurrence!, endedAt: "2026-10-04T10:00:00.000Z" } };
			h.store.commit({ ...h.store.data, tasks: new Map([...h.store.data.tasks, [t.id, broken]]) }, [{ c: "tasks", id: t.id, v: broken }]);
			expect(await h.app.tasks.complete(t.id)).toEqual({ kind: "done", completed: 1, label: "Complete task" });
			expect(task(h, t.id).status).toBe("completed");
		});
	});
});

describe("an end before the start is refused", () => {
	// Repeating tasks rule 19 (#12): an end before the start is refused. A series whose end comes before its first
	// occurrence would be ended (completed, without Undo) by the hourly sweep right after it is written, so every writer
	// refuses it: Quick Add's create, the picker's setRepeat, and the picker itself. Europe/Berlin; 2026-10-05 is a Monday.

	const NOW = "2026-10-05T10:00:00.000Z";
	const ENDS_BEFORE = "The repeat ends before its first date.";
	const friday: RepeatRule = rule({ freq: "weekly", weekdays: ["FR"] });

	async function setup(): Promise<AppHarness> {
		const h = await appHarness();
		h.clock.set(NOW);
		return h;
	}

	async function refused(p: Promise<unknown>, message: string): Promise<void> {
		try {
			await p;
		} catch (err) {
			expect(isDomainError(err, "InvalidValue")).toBe(true);
			expect((err as Error).message).toBe(message);
			return;
		}
		throw new Error("expected InvalidValue");
	}

	const series = (anchor: string, r: RepeatRule): Pick<Recurrence, "anchor" | "versions"> => ({ anchor, versions: [{ effectiveFrom: anchor, rule: r }] });

	describe("repeatEndProblem: one check for the picker, Quick Add and the services", () => {
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

	describe("TaskService.create refuses a repeat that ends before its first date", () => {
		it("#12: an end date before the typed date writes nothing", async () => {
			const h = await setup();
			const before = h.app.store.state.tasks.size;
			await refused(h.app.tasks.create({ title: "Pills", scheduled: { kind: "date", date: "2026-10-20" }, repeat: { rule: rule(), end: { kind: "date", date: "2026-10-19" } } }), ENDS_BEFORE);
			expect(h.app.store.state.tasks.size).toBe(before);
		});

		it("#12: without a date the anchor is today: an end yesterday is refused, today is accepted and survives the sweep", async () => {
			const h = await setup();
			await refused(h.app.tasks.create({ title: "Pills", repeat: { rule: rule(), end: { kind: "date", date: "2026-10-04" } } }), ENDS_BEFORE);
			const { task } = await h.app.tasks.create({ title: "Pills", repeat: { rule: rule(), end: { kind: "date", date: "2026-10-05" } } });
			expect(task.recurrence).toMatchObject({ anchor: "2026-10-05", end: { kind: "date", date: "2026-10-05" }, endedAt: null });
			await h.app.recurrence.endExhaustedSeries();
			expect(h.app.store.state.tasks.get(task.id)?.status).toBe("open");
		});

		it("#12: an end on or after the anchor but before the first occurrence is refused (every Friday until Wednesday)", async () => {
			const h = await setup();
			const before = h.app.store.state.tasks.size;
			await refused(h.app.tasks.create({ title: "Gym", repeat: { rule: friday, end: { kind: "date", date: "2026-10-07" } } }), ENDS_BEFORE);
			await refused(
				h.app.tasks.create({ title: "Pay", repeat: { rule: rule({ freq: "monthly", monthly: { kind: "day", day: 15 } }), end: { kind: "date", date: "2026-10-14" } } }),
				ENDS_BEFORE,
			);
			expect(h.app.store.state.tasks.size).toBe(before);
			await h.app.recurrence.endExhaustedSeries();
			expect([...h.app.store.state.tasks.values()].filter((t) => t.status === "completed")).toEqual([]);
		});

		it("#12: a timed date anchors on its own wall date", async () => {
			const h = await setup();
			const scheduled = { kind: "datetime" as const, local: "2026-10-08T06:45", tz: "Europe/Berlin" };
			await refused(h.app.tasks.create({ title: "Run", scheduled, repeat: { rule: rule(), end: { kind: "date", date: "2026-10-07" } } }), ENDS_BEFORE);
			const { task } = await h.app.tasks.create({ title: "Run", scheduled, repeat: { rule: rule(), end: { kind: "date", date: "2026-10-08" } } });
			expect(task.recurrence?.anchor).toBe("2026-10-08");
		});
	});

	describe("RecurrenceService.setRepeat refuses a repeat that ends before its first date", () => {
		it("#12: making a dated task repeat with an end before its date is refused; the task stays as it was and the sweep leaves it", async () => {
			const h = await setup();
			const { task } = await h.app.tasks.create({ title: "Plain", scheduled: { kind: "date", date: "2026-10-20" } });
			await refused(h.app.recurrence.setRepeat(task.id, rule(), undefined, { kind: "date", date: "2026-10-15" }), ENDS_BEFORE);
			expect(h.app.store.state.tasks.get(task.id)).toMatchObject({ recurrence: null, status: "open", scheduled: { kind: "date", date: "2026-10-20" } });
			await h.app.recurrence.endExhaustedSeries();
			expect(h.app.store.state.tasks.get(task.id)?.status).toBe("open");
		});

		it("#12: making a task repeat every Friday until Wednesday is refused", async () => {
			const h = await setup();
			const { task } = await h.app.tasks.create({ title: "Gym", scheduled: { kind: "date", date: "2026-10-05" } });
			await refused(h.app.recurrence.setRepeat(task.id, friday, undefined, { kind: "date", date: "2026-10-07" }), ENDS_BEFORE);
			expect(h.app.store.state.tasks.get(task.id)?.recurrence).toBeNull();
		});

		it("#12: a new end before an existing series' first occurrence is refused; one after it is kept", async () => {
			const h = await setup();
			const { task } = await h.app.tasks.create({ title: "Pills", scheduled: { kind: "date", date: "2026-10-05" }, repeat: { rule: rule() } });
			await refused(h.app.recurrence.setRepeat(task.id, rule(), undefined, { kind: "date", date: "2026-10-01" }), ENDS_BEFORE);
			expect(h.app.store.state.tasks.get(task.id)?.recurrence?.end).toEqual({ kind: "never" });
			await h.app.recurrence.setRepeat(task.id, rule(), undefined, { kind: "date", date: "2026-10-10" });
			expect(h.app.store.state.tasks.get(task.id)?.recurrence?.end).toEqual({ kind: "date", date: "2026-10-10" });
		});

		it("#12: a rule change that leaves the kept end before the new first date is refused", async () => {
			const h = await setup();
			// Every Monday from Monday Oct 5, ending Oct 20; changed today to monthly on the 25th: no date before Oct 20.
			const { task } = await h.app.tasks.create({ title: "Gym", repeat: { rule: rule({ freq: "weekly", weekdays: ["MO"] }), end: { kind: "date", date: "2026-10-20" } } });
			await refused(h.app.recurrence.setRepeat(task.id, rule({ freq: "monthly", monthly: { kind: "day", day: 25 } })), ENDS_BEFORE);
			expect(h.app.store.state.tasks.get(task.id)?.recurrence?.versions).toHaveLength(1);
			await h.app.recurrence.setRepeat(task.id, rule({ freq: "monthly", monthly: { kind: "day", day: 15 } }));
			expect(h.app.store.state.tasks.get(task.id)?.recurrence?.versions.at(-1)?.rule.monthly).toEqual({ kind: "day", day: 15 });
		});

		it("#12: a stored count above 999 is kept by later edits; only a new count must be 1 to 999", async () => {
			const h = await setup();
			const { task } = await h.app.tasks.create({ title: "Pills", repeat: { rule: rule(), end: { kind: "count", count: 5 } } });
			await h.app.store.run("Seed", (tx) => {
				const t = tx.get("tasks", task.id)!;
				tx.put("tasks", { ...t, recurrence: { ...t.recurrence!, end: { kind: "count", count: 1500 } } });
			});
			await h.app.recurrence.setRepeat(task.id, rule({ interval: 2 }));
			await h.app.recurrence.setRepeat(task.id, rule({ interval: 3 }), undefined, { kind: "count", count: 1500 });
			expect(h.app.store.state.tasks.get(task.id)?.recurrence?.end).toEqual({ kind: "count", count: 1500 });
			await refused(h.app.recurrence.setRepeat(task.id, rule({ interval: 3 }), undefined, { kind: "count", count: 2000 }), "End after 1 to 999 times.");
		});
	});

	describe("Duplicate keeps an end only when the copy still has a date before it", () => {
		it("#12: a copy whose end comes before its first date never ends, and the sweep leaves it open", async () => {
			const h = await appHarness();
			h.clock.set("2026-10-02T10:00:00.000Z"); // Friday
			const { task } = await h.app.tasks.create({ title: "Gym", repeat: { rule: friday, end: { kind: "date", date: "2026-10-14" } } });
			h.clock.set("2026-10-12T10:00:00.000Z"); // Monday: the copy starts today, and its next Friday is after the end
			const copy = await h.app.tasks.duplicate(task.id);
			expect(copy.recurrence?.end).toEqual({ kind: "never" });
			await h.app.recurrence.endExhaustedSeries();
			expect(h.app.store.state.tasks.get(copy.id)?.status).toBe("open");
		});

		it("#12: a copy that still has a date before the end keeps it", async () => {
			const h = await appHarness();
			h.clock.set("2026-10-02T10:00:00.000Z");
			const { task } = await h.app.tasks.create({ title: "Gym", repeat: { rule: friday, end: { kind: "date", date: "2026-10-20" } } });
			h.clock.set("2026-10-12T10:00:00.000Z");
			const copy = await h.app.tasks.duplicate(task.id);
			expect(copy.recurrence?.end).toEqual({ kind: "date", date: "2026-10-20" });
		});
	});
});
