import { describe, expect, it } from "vitest";
import {
	COMPLETE_OCCURRENCE_LABEL,
	END_REPEAT_LABEL,
	EDIT_REPEAT_LABEL,
	type RecurrenceResult,
	REOPEN_OCCURRENCE_LABEL,
	SKIP_OCCURRENCE_LABEL,
	STOP_REPEATING_LABEL,
} from "../../src/app/RecurrenceService";
import { isDomainError } from "../../src/domain/errors";
import { currentOccurrence, indexOccurrenceRecords } from "../../src/domain/recurrence";
import type { DateSpec, OccurrenceRecord, RepeatRule, Task } from "../../src/domain/types";
import { rule } from "../domain/recurrence-fixtures";
import { type AppHarness, appHarness } from "./harness";

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
