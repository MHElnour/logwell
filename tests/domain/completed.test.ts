import { describe, expect, it } from "vitest";
import { type CompletedScope, completedGroup, inCompletedScope, isKeptUnderParent } from "../../src/domain/completed";
import { type QueryContext, inViewScope } from "../../src/domain/queries";
import type { DateSpec, Task } from "../../src/domain/types";

// Which completed tasks a view's Completed group holds.

const ctx: QueryContext = { today: "2026-10-01", zone: "Europe/Berlin", upcomingDays: 7, weekStart: "MO" };
const TODAY: CompletedScope = { kind: "today" };

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
		status: "completed",
		completedAt: "2026-10-01T08:00:00.000Z",
		recurrence: null,
		sortKey: id,
		createdAt: "2026-09-01T09:00:00.000Z",
		modifiedAt: "2026-09-01T09:00:00.000Z",
		...patch,
	};
}

const day = (date: string): DateSpec => ({ kind: "date", date });
const inScope = (t: Task, scope: CompletedScope) => inCompletedScope(t, scope, ctx);

describe("Today scope", () => {
	it("holds a task dated today", () => {
		expect(inScope(task("a", { scheduled: day("2026-10-01"), completedAt: "2026-09-25T08:00:00.000Z" }), TODAY)).toBe(true);
	});

	it("holds a deadline-only task due today", () => {
		expect(inScope(task("a", { deadline: day("2026-10-01") }), TODAY)).toBe(true);
	});

	it("holds an overdue task that was completed today", () => {
		expect(inScope(task("a", { scheduled: day("2026-09-28"), completedAt: "2026-10-01T07:00:00.000Z" }), TODAY)).toBe(true);
	});

	it("leaves out an overdue task that was completed yesterday", () => {
		expect(inScope(task("a", { scheduled: day("2026-09-28"), completedAt: "2026-09-30T15:00:00.000Z" }), TODAY)).toBe(false);
	});

	it("leaves out an overdue deadline-only task completed yesterday", () => {
		expect(inScope(task("a", { deadline: day("2026-09-28"), completedAt: "2026-09-30T15:00:00.000Z" }), TODAY)).toBe(false);
	});

	it("leaves out a task without a date and a task dated tomorrow", () => {
		expect(inScope(task("a"), TODAY)).toBe(false);
		expect(inScope(task("b", { scheduled: day("2026-10-02") }), TODAY)).toBe(false);
	});

	it("uses the display zone at midnight: 22:00Z on Sep 30 is already Oct 1 in Berlin", () => {
		const overdue = { scheduled: day("2026-09-28") };
		expect(inScope(task("in", { ...overdue, completedAt: "2026-09-30T22:00:00.000Z" }), TODAY)).toBe(true);
		expect(inScope(task("out", { ...overdue, completedAt: "2026-09-30T21:59:59.999Z" }), TODAY)).toBe(false);
	});

	it("an overdue task completed after the end of today in the zone is not today's", () => {
		// 22:00Z on Oct 1 is Oct 2 in Berlin: a clock that moved on; today is still Oct 1 in ctx.
		expect(inScope(task("a", { scheduled: day("2026-09-28"), completedAt: "2026-10-01T22:00:00.000Z" }), TODAY)).toBe(false);
	});

	it("an open task is never in a Completed group", () => {
		expect(inScope(task("a", { status: "open", completedAt: null, scheduled: day("2026-10-01") }), TODAY)).toBe(false);
	});
});

describe("Upcoming scope", () => {
	const up: CompletedScope = { kind: "upcoming" };
	it("holds dates from tomorrow to today + days (K1a D1)", () => {
		expect(inScope(task("a", { scheduled: day("2026-10-02") }), up)).toBe(true);
		expect(inScope(task("b", { scheduled: day("2026-10-08") }), up)).toBe(true);
		expect(inScope(task("c", { deadline: day("2026-10-04") }), up)).toBe(true);
	});
	it("leaves out today, overdue, the day after the range and undated tasks", () => {
		expect(inScope(task("a", { scheduled: day("2026-10-01") }), up)).toBe(false);
		expect(inScope(task("a2", { scheduled: day("2026-09-30") }), up)).toBe(false);
		expect(inScope(task("b", { scheduled: day("2026-10-09") }), up)).toBe(false);
		expect(inScope(task("c"), up)).toBe(false);
	});
});

describe("Upcoming scope: due by today belongs to Today only", () => {
	const up: CompletedScope = { kind: "upcoming" };
	it("leaves out a task scheduled tomorrow with a deadline today or in the past", () => {
		expect(inScope(task("a", { scheduled: day("2026-10-02"), deadline: day("2026-10-01") }), up)).toBe(false);
		expect(inScope(task("b", { scheduled: day("2026-10-02"), deadline: day("2026-09-28") }), up)).toBe(false);
		expect(inScope(task("a", { scheduled: day("2026-10-02"), deadline: day("2026-10-01") }), TODAY)).toBe(true);
	});
	it("keeps a task scheduled tomorrow with a later deadline", () => {
		expect(inScope(task("c", { scheduled: day("2026-10-02"), deadline: day("2026-10-05") }), up)).toBe(true);
	});
});

describe("Inbox, list and tag scopes", () => {
	it("hold every completed task of that list or tag, whatever its date or completion day", () => {
		const old = { completedAt: "2020-01-01T00:00:00.000Z" };
		expect(inScope(task("a", old), { kind: "inbox" })).toBe(true);
		expect(inScope(task("b", { ...old, categoryId: "study" }), { kind: "inbox" })).toBe(false);
		expect(inScope(task("c", { ...old, categoryId: "study" }), { kind: "category", id: "study" })).toBe(true);
		expect(inScope(task("d", old), { kind: "category", id: "study" })).toBe(false);
		expect(inScope(task("e", { ...old, tagKeys: ["x", "y"] }), { kind: "tag", key: "y" })).toBe(true);
		expect(inScope(task("f", old), { kind: "tag", key: "y" })).toBe(false);
	});
});

describe("subtasks (SUB-07, spec §7)", () => {
	const parentOpen = task("p", { status: "open", completedAt: null });
	const parentDone = task("p", { status: "completed" });
	const sub = task("s", { parentId: "p" });
	it("a completed subtask of an open parent stays under its parent", () => {
		expect(isKeptUnderParent(sub, new Map([["p", parentOpen]]))).toBe(true);
	});
	it("a subtask of a completed parent, a missing parent or no parent does not", () => {
		expect(isKeptUnderParent(sub, new Map([["p", parentDone]]))).toBe(false);
		expect(isKeptUnderParent(sub, new Map())).toBe(false);
		expect(isKeptUnderParent(task("t"), new Map([["p", parentOpen]]))).toBe(false);
	});
	it("an open subtask is not kept as completed", () => {
		expect(isKeptUnderParent(task("s", { parentId: "p", status: "open", completedAt: null }), new Map([["p", parentOpen]]))).toBe(false);
	});
});

describe("a completed subtask and a parent that is not in the view (#98)", () => {
	const parentOpen = task("p", { status: "open", completedAt: null });
	const sub = task("s", { parentId: "p" });
	const byId = new Map([["p", parentOpen]]);
	it("stays under its parent only when that parent's row is shown", () => {
		expect(isKeptUnderParent(sub, byId, new Set(["p"]))).toBe(true);
		expect(isKeptUnderParent(sub, byId, new Set())).toBe(false);
	});
	it("goes to the Completed group when the parent is not shown, and stays out of it when it is", () => {
		const tasks = [sub, parentOpen];
		expect(completedGroup(tasks, byId, { kind: "inbox" }, ctx, new Set(), new Set()).map((e) => e.task.id)).toEqual(["s"]);
		expect(completedGroup(tasks, byId, { kind: "inbox" }, ctx, new Set(), new Set(["p"]))).toEqual([]);
	});
	it("takes the shown rows as a test of the parent as well as a set of IDs (issue 41)", () => {
		const asked: string[] = [];
		const shown = (yes: boolean) => (t: Task) => (asked.push(t.id), yes);
		expect(isKeptUnderParent(sub, byId, shown(true))).toBe(true);
		expect(isKeptUnderParent(sub, byId, shown(false))).toBe(false);
		expect(completedGroup([sub, parentOpen], byId, { kind: "inbox" }, ctx, new Set(), shown(false)).map((e) => e.task.id)).toEqual(["s"]);
		expect(completedGroup([sub, parentOpen], byId, { kind: "inbox" }, ctx, new Set(), shown(true))).toEqual([]);
		// Only the open parent is asked about, never the subtask itself.
		expect(new Set(asked)).toEqual(new Set(["p"]));
	});
});

describe("inViewScope: the open rows a view lists (issue 41)", () => {
	const open = (patch: Partial<Task>) => task("o", { status: "open", completedAt: null, ...patch });
	it("Today lists what is due by today; Upcoming what is dated in its range and not due by today", () => {
		expect(inViewScope(open({ scheduled: day("2026-09-28") }), TODAY, ctx)).toBe(true);
		expect(inViewScope(open({ deadline: day("2026-10-01") }), TODAY, ctx)).toBe(true);
		expect(inViewScope(open({ scheduled: day("2026-10-02") }), TODAY, ctx)).toBe(false);
		expect(inViewScope(open({ scheduled: day("2026-10-02") }), { kind: "upcoming" }, ctx)).toBe(true);
		expect(inViewScope(open({ scheduled: day("2026-10-02"), deadline: day("2026-10-01") }), { kind: "upcoming" }, ctx)).toBe(false);
		expect(inViewScope(open({ scheduled: day("2026-10-20") }), { kind: "upcoming" }, ctx)).toBe(false);
		expect(inViewScope(open({}), { kind: "upcoming" }, ctx)).toBe(false);
	});
	it("Inbox, a list and a tag list what belongs there, a child tag included", () => {
		expect(inViewScope(open({}), { kind: "inbox" }, ctx)).toBe(true);
		expect(inViewScope(open({ categoryId: "l" }), { kind: "inbox" }, ctx)).toBe(false);
		expect(inViewScope(open({ categoryId: "l" }), { kind: "category", id: "l" }, ctx)).toBe(true);
		expect(inViewScope(open({ tagKeys: ["home/garden"] }), { kind: "tag", key: "home" }, ctx)).toBe(true);
		expect(inViewScope(open({ tagKeys: ["homework"] }), { kind: "tag", key: "home" }, ctx)).toBe(false);
	});
	it("ignores the status: a completed task in the same place is in the same scope", () => {
		expect(inViewScope(task("c", { categoryId: "l" }), { kind: "category", id: "l" }, ctx)).toBe(true);
	});
});

describe("completedGroup", () => {
	it("is newest first, drops subtasks kept under an open parent and held tasks, and prefixes a subtask", () => {
		const parentOpen = task("p", { status: "open", completedAt: null, title: "Trip" });
		const doneParent = task("q", { title: "Done parent", completedAt: "2026-10-01T05:00:00.000Z" });
		const tasks = [
			task("old", { completedAt: "2026-09-01T05:00:00.000Z" }),
			task("new", { completedAt: "2026-10-01T09:00:00.000Z" }),
			doneParent,
			task("kept", { parentId: "p", completedAt: "2026-10-01T09:30:00.000Z" }),
			task("sub", { parentId: "q", completedAt: "2026-10-01T06:00:00.000Z" }),
			task("held", { completedAt: "2026-10-01T09:45:00.000Z" }),
			task("open", { status: "open", completedAt: null }),
		];
		const byId = new Map([...tasks, parentOpen].map((t) => [t.id, t]));
		const entries = completedGroup(tasks, byId, { kind: "inbox" }, ctx, new Set(["held"]));
		expect(entries.map((e) => e.task.id)).toEqual(["new", "sub", "q", "old"]);
		expect(entries.find((e) => e.task.id === "sub")!.parentTitle).toBe("Done parent");
	});
});
