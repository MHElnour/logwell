import { describe, expect, it } from "vitest";
import { QUADRANT_ORDER, matrixQuadrants, quadrantFlags } from "../../src/domain/matrix";
import type { QueryContext } from "../../src/domain/queries";
import type { DateSpec, Task } from "../../src/domain/types";

const ctx: QueryContext = { today: "2026-10-01", zone: "Europe/Berlin", upcomingDays: 7, weekStart: "MO" };

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
		createdAt: "2026-09-01T09:00:00.000Z",
		modifiedAt: "2026-09-01T09:00:00.000Z",
		...patch,
	};
}

const day = (date: string): DateSpec => ({ kind: "date", date });
const timed = (local: string): DateSpec => ({ kind: "datetime", local, tz: "Europe/Berlin" });

function run(tasks: Task[]) {
	const byId = new Map(tasks.map((t) => [t.id, t]));
	return matrixQuadrants(tasks, byId, ctx);
}
const ids = (groups: { id: string; entries: { task: Task }[] }[], group: string) =>
	groups.find((g) => g.id === group)?.entries.map((e) => e.task.id) ?? [];

describe("quadrant order and flags (D1)", () => {
	it("lists I to IV and maps each to its flags", () => {
		expect(QUADRANT_ORDER).toEqual(["urgent-important", "important", "urgent", "neither"]);
		expect(quadrantFlags("urgent-important")).toEqual({ urgent: true, important: true });
		expect(quadrantFlags("important")).toEqual({ urgent: false, important: true });
		expect(quadrantFlags("urgent")).toEqual({ urgent: true, important: false });
		expect(quadrantFlags("neither")).toEqual({ urgent: false, important: false });
	});
});

describe("date groups (D3)", () => {
	const cases: [string, string | null, string][] = [
		["yesterday", "2026-09-30", "overdue"],
		["today", "2026-10-01", "today"],
		["today + 1", "2026-10-02", "next7"],
		["today + 6", "2026-10-07", "next7"],
		["today + 7", "2026-10-08", "later"],
		["no date", null, "nodate"],
	];
	for (const [name, date, group] of cases) {
		it(`${name} goes to ${group}`, () => {
			const q = run([task("a", { scheduled: date === null ? null : day(date) })]);
			expect(ids(q.neither, group)).toEqual(["a"]);
			expect(q.neither).toHaveLength(1);
		});
	}

	it("a deadline-only task is grouped by its deadline", () => {
		const q = run([task("a", { deadline: day("2026-10-03") })]);
		expect(ids(q.neither, "next7")).toEqual(["a"]);
	});

	it("overdue by deadline only: schedule today, deadline yesterday is overdue", () => {
		const q = run([task("a", { scheduled: day("2026-10-01"), deadline: day("2026-09-30") })]);
		expect(ids(q.neither, "overdue")).toEqual(["a"]);
	});

	it("a timed schedule earlier today is not overdue", () => {
		const q = run([task("a", { scheduled: timed("2026-10-01T08:00") })]);
		expect(ids(q.neither, "today")).toEqual(["a"]);
	});

	it("completed tasks go to a final Completed group, whatever their date", () => {
		const q = run([
			task("a", { scheduled: day("2026-09-01"), status: "completed", completedAt: "2026-09-02T00:00:00.000Z" }),
			task("b", { scheduled: day("2026-10-01") }),
		]);
		expect(q.neither.map((g) => g.id)).toEqual(["today", "completed"]);
		expect(ids(q.neither, "completed")).toEqual(["a"]);
	});

	it("renders groups in order and drops empty ones", () => {
		const q = run([
			task("l", { scheduled: day("2026-12-01") }),
			task("n"),
			task("o", { scheduled: day("2026-09-01") }),
			task("t", { scheduled: day("2026-10-01") }),
			task("w", { scheduled: day("2026-10-04") }),
		]);
		expect(q.neither.map((g) => g.id)).toEqual(["overdue", "today", "next7", "later", "nodate"]);
		expect(run([]).neither).toEqual([]);
	});
});

describe("order inside a group (D4, MAT-06)", () => {
	it("scheduled first by time, then unscheduled; ties by createdAt then id; priority and sortKey ignored", () => {
		const q = run([
			task("u2", { deadline: day("2026-10-01"), createdAt: "2026-09-02T00:00:00.000Z", priority: 1, sortKey: "a" }),
			task("u1", { deadline: day("2026-10-01"), createdAt: "2026-09-01T00:00:00.000Z", priority: 3, sortKey: "z" }),
			task("late", { scheduled: timed("2026-10-01T15:00"), priority: 1 }),
			task("early", { scheduled: timed("2026-10-01T08:00"), priority: 3 }),
			task("allday", { scheduled: day("2026-10-01") }),
			task("tie-b", { scheduled: day("2026-10-01"), createdAt: "2026-09-01T10:00:00.000Z" }),
		]);
		expect(ids(q.neither, "today")).toEqual(["allday", "tie-b", "early", "late", "u1", "u2"]);
	});

	it("ties on createdAt fall back to id", () => {
		const q = run([task("b"), task("a")]);
		expect(ids(q.neither, "nodate")).toEqual(["a", "b"]);
	});
});

describe("quadrants (MAT-01, MAT-02, PRI-04, B42)", () => {
	it("puts each task in the quadrant of its flags, whatever its dates", () => {
		const q = run([
			task("i", { urgent: true, important: true, scheduled: day("2026-12-01") }),
			task("ii", { important: true, deadline: day("2026-09-01") }),
			task("iii", { urgent: true }),
			task("iv"),
		]);
		expect(q["urgent-important"].flatMap((g) => g.entries.map((e) => e.task.id))).toEqual(["i"]);
		expect(q.important.flatMap((g) => g.entries.map((e) => e.task.id))).toEqual(["ii"]);
		expect(q.urgent.flatMap((g) => g.entries.map((e) => e.task.id))).toEqual(["iii"]);
		expect(q.neither.flatMap((g) => g.entries.map((e) => e.task.id))).toEqual(["iv"]);
	});

	it("all four priorities share one quadrant", () => {
		const q = run([0, 1, 2, 3].map((p) => task(`p${p}`, { urgent: true, priority: p as 0 | 1 | 2 | 3 })));
		expect(q.urgent.flatMap((g) => g.entries)).toHaveLength(4);
		expect(q["urgent-important"]).toEqual([]);
	});

	it("a subtask sits in its own quadrant, flat, with the parent title", () => {
		const q = run([task("parent", { urgent: true, important: true }), task("child", { parentId: "parent", important: true })]);
		const entry = q.important[0]!.entries[0]!;
		expect(entry.task.id).toBe("child");
		expect(entry.depth).toBe(0);
		expect(entry.parentTitle).toBe("Task parent");
		expect(q["urgent-important"][0]!.entries[0]!.parentTitle).toBeNull();
	});
});

describe("Completed group (spec §7)", () => {
	const done = (id: string, completedAt: string, patch: Partial<Task> = {}) => task(id, { status: "completed", completedAt, ...patch });

	it("is last in each quadrant and ordered newest completedAt first", () => {
		const q = run([
			done("old", "2026-09-01T08:00:00.000Z", { urgent: true }),
			done("new", "2026-10-01T08:00:00.000Z", { urgent: true }),
			task("open", { urgent: true }),
		]);
		expect(q.urgent.map((g) => g.id)).toEqual(["nodate", "completed"]);
		expect(ids(q.urgent, "completed")).toEqual(["new", "old"]);
	});

	it("keeps a task completed a moment ago in its date group while it is held, then moves it", () => {
		const t = done("a", "2026-10-01T09:59:00.000Z", { scheduled: day("2026-09-30") });
		const byId = new Map([[t.id, t]]);
		const held = matrixQuadrants([t], byId, ctx, new Set(["a"]));
		expect(held.neither.map((g) => g.id)).toEqual(["overdue"]);
		const released = matrixQuadrants([t], byId, ctx, new Set());
		expect(released.neither.map((g) => g.id)).toEqual(["completed"]);
	});
});
