import { describe, expect, it } from "vitest";
import type { OccurrenceRecord, Recurrence, Task } from "../../src/domain/types";
import { inboxCategory } from "../../src/persistence/schema";
import { serializeRecord } from "../../src/persistence/serializer";
import { validateDb } from "../../src/persistence/validate";

// The typed readers of `recurrence` and `occurrenceRecords` repair and record an issue instead of
// failing the load (as for focus sessions and habits). One test per rule.

const NOW = "2026-10-05T10:00:00.000Z";
type Obj = Record<string, unknown>;

const rule = (patch: Obj = {}): Obj => ({
	freq: "weekly",
	interval: 1,
	weekdays: ["MO", "WE"],
	monthly: null,
	afterCompletion: false,
	time: null,
	tz: null,
	...patch,
});

const rec = (patch: Obj = {}, rulePatch: Obj = {}): Obj => ({
	anchor: "2026-10-05",
	versions: [{ effectiveFrom: "2026-10-05", rule: rule(rulePatch) }],
	end: { kind: "never" },
	endedAt: null,
	...patch,
});

function taskWith(recurrence: unknown, patch: Obj = {}): Obj {
	return {
		id: "t1",
		title: "Gym",
		categoryId: "inbox",
		tagKeys: [],
		urgent: false,
		important: false,
		status: "open",
		recurrence,
		sortKey: "V",
		createdAt: NOW,
		modifiedAt: NOW,
		...patch,
	};
}

function load(collections: Obj): { tasks: ReadonlyMap<string, Task>; records: ReadonlyMap<string, OccurrenceRecord>; issues: string[]; trash: Task[] } {
	const raw = { format: "checkpoint-db", schemaVersion: 4, dbId: "db-1", revision: "r-000000000001", categories: [inboxCategory(NOW)], ...collections };
	const { data, issues } = validateDb(raw, NOW);
	return { tasks: data.tasks, records: data.occurrenceRecords, issues, trash: [...data.trash.values()].flatMap((e) => e.tasks) };
}

function loadRec(recurrence: unknown): { value: Recurrence | null; issues: string[] } {
	const r = load({ tasks: [taskWith(recurrence)] });
	return { value: r.tasks.get("t1")?.recurrence ?? null, issues: r.issues };
}

const ruleOf = (r: { value: Recurrence | null }) => r.value?.versions[0]?.rule;

describe("recurrence reader (D2)", () => {
	it("a valid recurrence loads unchanged with no issue", () => {
		const r = loadRec(rec());
		expect(r.issues).toEqual([]);
		expect(r.value).toEqual(rec());
	});

	it("null and a missing field mean not repeating, with no issue", () => {
		expect(loadRec(null)).toEqual({ value: null, issues: [] });
		const r = load({ tasks: [{ ...taskWith(null), recurrence: undefined }] });
		expect(r.tasks.get("t1")?.recurrence).toBeNull();
		expect(r.issues).toEqual([]);
	});

	it("a recurrence that is not an object is cleared with an issue", () => {
		const r = loadRec("every day");
		expect(r.value).toBeNull();
		expect(r.issues).toHaveLength(1);
		expect(r.issues[0]).toContain("Gym");
	});

	it("an interval below 1 or not a whole number becomes 1", () => {
		for (const interval of [0, -2, 2.5, "2"]) {
			const r = loadRec(rec({}, { interval }));
			expect(ruleOf(r)?.interval).toBe(1);
			expect(r.issues).toHaveLength(1);
		}
	});

	it("H1: an interval above 999 becomes 999", () => {
		for (const interval of [1000, 1e15]) {
			const r = loadRec(rec({}, { interval }));
			expect(ruleOf(r)?.interval).toBe(999);
			expect(r.issues).toHaveLength(1);
		}
		expect(loadRec(rec({}, { interval: 999 })).issues).toEqual([]);
	});

	it("M4: a known week start is kept, an unknown one dropped, none written when absent", () => {
		const ok = loadRec(rec({}, { weekStart: "SU" }));
		expect(ruleOf(ok)?.weekStart).toBe("SU");
		expect(ok.issues).toEqual([]);
		const bad = loadRec(rec({}, { weekStart: "TU" }));
		expect(ruleOf(bad)).not.toHaveProperty("weekStart");
		expect(bad.issues).toHaveLength(1);
		expect(ruleOf(loadRec(rec()))).not.toHaveProperty("weekStart");
	});

	it("L4: a deadline on a repeating task is removed", () => {
		const r = load({ tasks: [taskWith(rec(), { deadline: { kind: "date", date: "2026-10-20" } })] });
		expect(r.tasks.get("t1")?.deadline).toBeNull();
		expect(r.issues).toHaveLength(1);
		const plain = load({ tasks: [taskWith(null, { deadline: { kind: "date", date: "2026-10-20" } })] });
		expect(plain.tasks.get("t1")?.deadline).toEqual({ kind: "date", date: "2026-10-20" });
		expect(plain.issues).toEqual([]);
	});

	it("an unknown weekday is dropped", () => {
		const r = loadRec(rec({}, { weekdays: ["MO", "XX", "FR"] }));
		expect(ruleOf(r)?.weekdays).toEqual(["MO", "FR"]);
		expect(r.issues).toHaveLength(1);
	});

	it("weekdays that end up empty become null (the anchor's weekday)", () => {
		for (const weekdays of [[], ["XX"], "MO"]) {
			const r = loadRec(rec({}, { weekdays }));
			expect(ruleOf(r)?.weekdays).toBeNull();
			expect(r.issues.length).toBeGreaterThan(0);
		}
	});

	it("weekdays on a daily or monthly rule are cleared", () => {
		const r = loadRec(rec({}, { freq: "daily", weekdays: ["MO"] }));
		expect(ruleOf(r)).toMatchObject({ freq: "daily", weekdays: null });
		expect(r.issues).toHaveLength(1);
	});

	it("a monthly form on a daily or weekly rule is cleared", () => {
		const r = loadRec(rec({}, { monthly: { kind: "day", day: 3 } }));
		expect(ruleOf(r)?.monthly).toBeNull();
		expect(r.issues).toHaveLength(1);
	});

	it("a day of month is clamped to 1..31", () => {
		const high = loadRec(rec({}, { freq: "monthly", weekdays: null, monthly: { kind: "day", day: 40 } }));
		expect(ruleOf(high)?.monthly).toEqual({ kind: "day", day: 31 });
		expect(high.issues).toHaveLength(1);
		const low = loadRec(rec({}, { freq: "monthly", weekdays: null, monthly: { kind: "day", day: 0 } }));
		expect(ruleOf(low)?.monthly).toEqual({ kind: "day", day: 1 });
		const frac = loadRec(rec({}, { freq: "monthly", weekdays: null, monthly: { kind: "day", day: 14.6 } }));
		expect(ruleOf(frac)?.monthly).toEqual({ kind: "day", day: 15 });
	});

	it("an Nth weekday with a bad n or weekday, or an unknown monthly form, is cleared (the anchor's day)", () => {
		for (const monthly of [{ kind: "nth", n: 5, weekday: "MO" }, { kind: "nth", n: 1, weekday: "XX" }, { kind: "every" }, "last"]) {
			const r = loadRec(rec({}, { freq: "monthly", weekdays: null, monthly }));
			expect(ruleOf(r)?.monthly).toBeNull();
			expect(r.issues).toHaveLength(1);
		}
		const ok = loadRec(rec({}, { freq: "monthly", weekdays: null, monthly: { kind: "nth", n: -1, weekday: "FR" } }));
		expect(ruleOf(ok)?.monthly).toEqual({ kind: "nth", n: -1, weekday: "FR" });
		expect(ok.issues).toEqual([]);
	});

	it("after completion is turned off with picked weekdays, an Nth weekday or the last day", () => {
		const weekly = loadRec(rec({}, { afterCompletion: true }));
		expect(ruleOf(weekly)?.afterCompletion).toBe(false);
		expect(weekly.issues).toHaveLength(1);
		for (const monthly of [{ kind: "nth", n: 2, weekday: "TU" }, { kind: "lastDay" }]) {
			const r = loadRec(rec({}, { freq: "monthly", weekdays: null, monthly, afterCompletion: true }));
			expect(ruleOf(r)?.afterCompletion).toBe(false);
			expect(r.issues).toHaveLength(1);
		}
		const day = loadRec(rec({}, { freq: "monthly", weekdays: null, monthly: { kind: "day", day: 31 }, afterCompletion: true }));
		expect(ruleOf(day)?.afterCompletion).toBe(true);
		expect(day.issues).toEqual([]);
		const notBool = loadRec(rec({}, { freq: "daily", weekdays: null, afterCompletion: "yes" }));
		expect(ruleOf(notBool)?.afterCompletion).toBe(false);
		expect(notBool.issues).toHaveLength(1);
	});

	it("an invalid time or zone clears both", () => {
		for (const [time, tz] of [["7am", "Europe/Berlin"], ["07:00", "Mars/Olympus"], ["07:00", null], [null, "Europe/Berlin"], ["25:00", "UTC"]]) {
			const r = loadRec(rec({}, { time, tz }));
			expect(ruleOf(r)).toMatchObject({ time: null, tz: null });
			expect(r.issues).toHaveLength(1);
		}
		const ok = loadRec(rec({}, { time: "07:00", tz: "Europe/Berlin" }));
		expect(ruleOf(ok)).toMatchObject({ time: "07:00", tz: "Europe/Berlin" });
		expect(ok.issues).toEqual([]);
	});

	it("an invalid end becomes never", () => {
		for (const end of [{ kind: "count", count: 0 }, { kind: "count", count: 2.5 }, { kind: "date", date: "2026-13-01" }, { kind: "soon" }, "never", null]) {
			const r = loadRec(rec({ end }));
			expect(r.value?.end).toEqual({ kind: "never" });
			expect(r.issues).toHaveLength(1);
		}
		expect(loadRec(rec({ end: { kind: "count", count: 10 } })).value?.end).toEqual({ kind: "count", count: 10 });
		expect(loadRec(rec({ end: { kind: "date", date: "2026-12-31" } })).value?.end).toEqual({ kind: "date", date: "2026-12-31" });
	});

	it("an unreadable end time is cleared", () => {
		const r = loadRec(rec({ endedAt: 5 }));
		expect(r.value?.endedAt).toBeNull();
		expect(r.issues).toHaveLength(1);
	});

	it("anchoredAt is kept when it is a string and dropped otherwise", () => {
		const ok = loadRec(rec({ anchoredAt: "2026-10-05T08:00:00.000Z" }));
		expect(ok.value?.anchoredAt).toBe("2026-10-05T08:00:00.000Z");
		expect(ok.issues).toEqual([]);
		for (const anchoredAt of [5, "", null]) {
			const r = loadRec(rec({ anchoredAt }));
			expect(r.value).not.toHaveProperty("anchoredAt");
			expect(r.issues).toHaveLength(1);
		}
		const absent = loadRec(rec());
		expect(absent.value).not.toHaveProperty("anchoredAt");
	});

	it("N1: countFrom is kept when it is a string and dropped otherwise", () => {
		const ok = loadRec(rec({ countFrom: "2026-10-05T08:00:00.000Z" }));
		expect(ok.value?.countFrom).toBe("2026-10-05T08:00:00.000Z");
		expect(ok.issues).toEqual([]);
		for (const countFrom of [5, "", null]) {
			const r = loadRec(rec({ countFrom }));
			expect(r.value).not.toHaveProperty("countFrom");
			expect(r.issues).toHaveLength(1);
		}
		expect(serializeRecord("tasks", load({ tasks: [taskWith(rec())] }).tasks.get("t1")!)).not.toContain("countFrom");
	});

	it("anchoredAt is written only when present", () => {
		const without = load({ tasks: [taskWith(rec())] }).tasks.get("t1")!;
		expect(serializeRecord("tasks", without)).not.toContain("anchoredAt");
		const withIt = load({ tasks: [taskWith(rec({ anchoredAt: NOW }))] }).tasks.get("t1")!;
		expect(serializeRecord("tasks", withIt)).toContain(`"anchoredAt":"${NOW}"`);
	});

	it("an invalid anchor clears the recurrence", () => {
		for (const anchor of ["2026-02-30", "soon", 3]) {
			const r = loadRec(rec({ anchor }));
			expect(r.value).toBeNull();
			expect(r.issues).toHaveLength(1);
		}
	});

	it("no readable version clears the recurrence", () => {
		for (const versions of [[], null, [{ effectiveFrom: "x", rule: rule() }], [{ effectiveFrom: "2026-10-05", rule: rule({ freq: "hourly" }) }]]) {
			const r = loadRec(rec({ versions }));
			expect(r.value).toBeNull();
			expect(r.issues.length).toBeGreaterThan(0);
		}
	});

	it("an unreadable version is dropped and the others kept", () => {
		const r = loadRec(rec({ versions: [{ effectiveFrom: "2026-10-05", rule: rule() }, { effectiveFrom: "2026-10-12" }] }));
		expect(r.value?.versions).toHaveLength(1);
		expect(r.issues).toHaveLength(1);
	});

	it("versions are sorted by effectiveFrom; a duplicate date keeps the last one", () => {
		const r = loadRec(
			rec({
				versions: [
					{ effectiveFrom: "2026-10-12", rule: rule({ weekdays: ["TU"] }) },
					{ effectiveFrom: "2026-10-05", rule: rule({ weekdays: ["MO"] }) },
					{ effectiveFrom: "2026-10-12", rule: rule({ weekdays: ["TH"] }) },
				],
			}),
		);
		expect(r.value?.versions.map((v) => [v.effectiveFrom, v.rule.weekdays])).toEqual([
			["2026-10-05", ["MO"]],
			["2026-10-12", ["TH"]],
		]);
		expect(r.issues).toHaveLength(1);
	});

	it("fields this version does not know are kept, at the top, in versions and in rules", () => {
		const raw = rec({ color: "red" });
		(raw.versions as Obj[])[0] = { ...(raw.versions as Obj[])[0], note: "v2" };
		((raw.versions as Obj[])[0]!.rule as Obj).byHour = [7];
		const r = loadRec(raw);
		expect(r.issues).toEqual([]);
		expect(r.value).toMatchObject({ color: "red", versions: [{ note: "v2", rule: { byHour: [7] } }] });
	});

	it("a trashed task's recurrence is read the same way", () => {
		const r = load({ trash: [{ batchId: "b1", deletedAt: NOW, tasks: [taskWith(rec({}, { interval: 0 }))] }] });
		expect(r.trash[0]?.recurrence?.versions[0]?.rule.interval).toBe(1);
		expect(r.issues).toHaveLength(1);
	});
});

const record = (patch: Obj = {}): Obj => ({
	taskId: "t1",
	occurrenceDate: "2026-10-05",
	status: "done",
	resolvedAt: NOW,
	completedOn: "2026-10-05",
	...patch,
});

function loadRecords(records: Obj[], tasks: Obj[] = [taskWith(rec())]) {
	return load({ tasks, occurrenceRecords: records });
}

describe("occurrence record reader (D2)", () => {
	it("a valid record loads with the defaults filled in", () => {
		const r = loadRecords([record(), record({ occurrenceDate: "2026-10-07", status: "skipped", auto: true, completedOn: undefined })]);
		expect(r.issues).toEqual([]);
		expect(r.records.get("t1:2026-10-05")).toEqual({ ...record(), auto: false });
		expect(r.records.get("t1:2026-10-07")).toEqual({ ...record({ occurrenceDate: "2026-10-07", status: "skipped", auto: true }), completedOn: null });
	});

	it("a record with a bad status is dropped", () => {
		const r = loadRecords([record({ status: "missed" })]);
		expect(r.records.size).toBe(0);
		expect(r.issues).toHaveLength(1);
	});

	it("a record with a bad date or task id is dropped", () => {
		const r = loadRecords([record({ occurrenceDate: "2026-02-30" }), record({ taskId: "", occurrenceDate: "2026-10-06" })]);
		expect(r.records.size).toBe(0);
		expect(r.issues).toHaveLength(2);
	});

	it("a record whose task is missing is kept silently (sync can deliver it first)", () => {
		const r = loadRecords([record({ taskId: "gone" })]);
		expect(r.records.get("gone:2026-10-05")).toBeDefined();
		expect(r.issues).toEqual([]);
	});

	it("a record of a task that no longer repeats is kept (history)", () => {
		const r = loadRecords([record()], [taskWith(null)]);
		expect(r.records.get("t1:2026-10-05")).toBeDefined();
		expect(r.issues).toEqual([]);
	});

	it("an unreadable auto flag becomes false", () => {
		const r = loadRecords([record({ auto: "yes" })]);
		expect(r.records.get("t1:2026-10-05")?.auto).toBe(false);
		expect(r.issues).toHaveLength(1);
	});

	it("an unreadable completion day is cleared", () => {
		const r = loadRecords([record({ completedOn: "today" })]);
		expect(r.records.get("t1:2026-10-05")?.completedOn).toBeNull();
		expect(r.issues).toHaveLength(1);
	});

	it("an unreadable resolve time takes a fixed old instant", () => {
		const r = loadRecords([record({ resolvedAt: 7 })]);
		expect(r.records.get("t1:2026-10-05")?.resolvedAt).toBe("1970-01-01T00:00:00.000Z");
		expect(r.issues).toHaveLength(1);
	});

	it("fields this version does not know are kept", () => {
		const r = loadRecords([record({ note: "felt good" })]);
		expect(r.records.get("t1:2026-10-05")).toMatchObject({ note: "felt good" });
		expect(r.issues).toEqual([]);
	});
});
