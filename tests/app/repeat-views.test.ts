import { describe, expect, it } from "vitest";
import { buildBoard, buildList, globalSearch, sidebarCounts } from "../../src/app/views";
import { matrixQuadrants } from "../../src/domain/matrix";
import { type TaskFilter, emptyFilter } from "../../src/domain/queries";
import type { RepeatRule, Task } from "../../src/domain/types";
import { rule } from "../domain/recurrence-fixtures";
import { type AppHarness, appHarness } from "./harness";

// Through the app: every view reads a repeating task's current occurrence (the single
// reader) and the Completed rows list its done occurrences. Europe/Berlin; 2026-10-05 is a Monday.

const NOW = "2026-10-05T10:00:00.000Z";
const TODAY = "2026-10-05";

async function setup(): Promise<AppHarness> {
	const h = await appHarness();
	h.clock.set(NOW);
	return h;
}

async function series(h: AppHarness, title: string, r: RepeatRule, anchor: string, patch: { sectionId?: string; important?: boolean; urgent?: boolean } = {}): Promise<Task> {
	return (await h.app.tasks.create({ title, scheduled: { kind: "date", date: anchor }, repeat: { rule: r }, ...patch })).task;
}

const titles = (groups: { entries: { task: Task }[] }[]): string[] => groups.flatMap((g) => g.entries.map((e) => e.task.title));
const view = (h: AppHarness, kind: "today" | "upcoming" | "inbox" | "completed", filter: TaskFilter = emptyFilter(), text = "") =>
	buildList(h.app.store.state, { kind }, h.app.queryContext(), filter, text).groups;

describe("one reader of when a task is due", () => {
	it("Today shows the current occurrence, overdue included; completing catches up", async () => {
		const h = await setup();
		const t = await series(h, "Stretch", rule(), "2026-10-01");
		expect(t.scheduled).toBeNull();
		let today = view(h, "today");
		expect(today.map((g) => [g.label, g.entries.map((e) => [e.task.title, e.schedule])])).toEqual([["Overdue", [["Stretch", { kind: "date", date: "2026-10-01" }]]]]);
		expect(sidebarCounts(h.app.store.state, h.app.queryContext())).toMatchObject({ today: 1, upcoming: 0 });
		await h.app.tasks.complete(t.id);
		today = view(h, "today");
		expect(today.map((g) => [g.label, g.entries.map((e) => e.schedule)])).toEqual([["Today", [{ kind: "date", date: TODAY }]]]);
	});

	it("Upcoming shows only the next occurrence of a series, once", async () => {
		const h = await setup();
		await series(h, "Gym", rule({ freq: "weekly", weekdays: ["WE", "FR"] }), "2026-10-07");
		const upcoming = view(h, "upcoming");
		expect(upcoming.map((g) => [g.date, titles([g])])).toEqual([["2026-10-07", ["Gym"]]]);
		expect(sidebarCounts(h.app.store.state, h.app.queryContext())).toMatchObject({ today: 0, upcoming: 1 });
		const gym = [...h.app.store.state.tasks.values()][0]!;
		await h.app.tasks.complete(gym.id);
		expect(view(h, "upcoming").map((g) => g.date)).toEqual(["2026-10-09"]);
	});

	it("a time-of-day series carries the rule's time and zone in its entry", async () => {
		const h = await setup();
		await series(h, "Run", rule({ time: "07:30", tz: "Europe/Berlin" }), "2026-10-06");
		const [group] = view(h, "upcoming");
		expect(group!.entries[0]!.schedule).toEqual({ kind: "datetime", local: "2026-10-06T07:30", tz: "Europe/Berlin" });
	});

	it("an after-completion series moves with the completion day", async () => {
		const h = await setup();
		const t = await series(h, "Water plants", rule({ interval: 3, afterCompletion: true }), "2026-10-05");
		await h.app.tasks.complete(t.id);
		expect(view(h, "upcoming").map((g) => g.date)).toEqual(["2026-10-08"]);
	});

	it("an ended series has no schedule: it leaves Today and Upcoming and sorts as undated", async () => {
		const h = await setup();
		const t = await series(h, "Stretch", rule(), "2026-10-05");
		await h.app.recurrence.stop(t.id);
		expect(view(h, "today")).toEqual([]);
		expect(view(h, "upcoming")).toEqual([]);
		const [row] = view(h, "completed");
		expect(row!.entries[0]).toMatchObject({ task: { title: "Stretch", status: "completed" }, schedule: null, occurrence: null });
	});

	it("a list groups by date under the current occurrence and sorts by it; plain tasks are unchanged", async () => {
		const h = await setup();
		await series(h, "Monthly rent", rule({ freq: "monthly", monthly: { kind: "day", day: 8 } }), "2026-10-05");
		await h.app.tasks.create({ title: "Plain", scheduled: { kind: "date", date: "2026-10-07" } });
		await h.app.tasks.create({ title: "Later", scheduled: { kind: "date", date: "2026-10-30" } });
		const ctx = h.app.queryContext();
		const byDate = buildList(h.app.store.state, { kind: "inbox" }, ctx, emptyFilter(), "", undefined, { groupBy: "date" }).groups;
		expect(byDate.map((g) => [g.key, titles([g])])).toEqual([
			["2026-10-07", ["Plain"]],
			["2026-10-08", ["Monthly rent"]],
			["2026-10-30", ["Later"]],
		]);
		const sorted = buildList(h.app.store.state, { kind: "inbox" }, ctx, { ...emptyFilter(), sort: "date" }, "").groups;
		expect(titles(sorted)).toEqual(["Plain", "Monthly rent", "Later"]);
	});

	it("the board's day columns hold the current occurrence", async () => {
		const h = await setup();
		await series(h, "Gym", rule({ freq: "weekly", weekdays: ["WE"] }), "2026-10-07");
		const columns = buildBoard(h.app.store.state, { kind: "upcoming" }, h.app.queryContext(), emptyFilter(), "");
		expect(columns.filter((c) => c.cards.length > 0).map((c) => [c.id, c.cards.map((x) => [x.entry.task.title, x.entry.schedule])])).toEqual([["2026-10-07", [["Gym", { kind: "date", date: "2026-10-07" }]]]]);
	});

	it("the date filters of search read the current occurrence; an ended series is undated", async () => {
		const h = await setup();
		const due = await series(h, "Due today", rule(), TODAY);
		await series(h, "Overdue", rule(), "2026-10-02");
		await series(h, "Next week", rule({ freq: "weekly", weekdays: ["MO"] }), "2026-10-12");
		const ended = await series(h, "Ended", rule(), TODAY);
		await h.app.recurrence.stop(ended.id);
		const ctx = h.app.queryContext();
		// A blank query lists nothing; ask with a letter every title shares.
		const search = (date: TaskFilter["date"]) => globalSearch(h.app.store.state, "e", ctx, { ...emptyFilter(), date }).tasks.map((e) => e.task.title).sort();
		expect(search("today")).toEqual(["Due today"]);
		expect(search("overdue")).toEqual(["Overdue"]);
		// Next week (Oct 12) is past today + 6.
		expect(search("next7")).toEqual(["Due today"]);
		expect(search("none")).toEqual(["Ended"]);
		expect(due.recurrence).not.toBeNull();
	});

	it("the matrix places a series by its current occurrence, overdue first", async () => {
		const h = await setup();
		await series(h, "Late", rule(), "2026-10-01", { important: true });
		await series(h, "Soon", rule({ freq: "weekly", weekdays: ["FR"] }), "2026-10-09", { important: true });
		const ctx = h.app.queryContext();
		const q = matrixQuadrants(h.app.store.state.tasks.values(), h.app.store.state.tasks, ctx);
		expect(q.important.map((g) => [g.id, g.entries.map((e) => [e.task.title, e.schedule])])).toEqual([
			["overdue", [["Late", { kind: "date", date: "2026-10-01" }]]],
			["next7", [["Soon", { kind: "date", date: "2026-10-09" }]]],
		]);
	});

	it("queryContext().schedule is one stable function that follows the store, even from an old context", async () => {
		const h = await setup();
		const t = await series(h, "Stretch", rule(), "2026-10-01");
		const old = h.app.queryContext();
		expect(old.schedule).toBe(h.app.queryContext().schedule);
		expect(old.schedule!(t)).toEqual({ kind: "date", date: "2026-10-01" });
		await h.app.tasks.complete(t.id);
		const now = h.app.store.state.tasks.get(t.id)!;
		expect(old.schedule!(now)).toEqual({ kind: "date", date: TODAY });
		expect(h.app.effectiveSchedule(now)).toEqual({ kind: "date", date: TODAY });
		const plain = (await h.app.tasks.create({ title: "Plain", scheduled: { kind: "date", date: "2026-10-09" } })).task;
		expect(h.app.effectiveSchedule(plain)).toEqual({ kind: "date", date: "2026-10-09" });
	});
});

describe("done occurrences in the Completed history", () => {
	it("the Completed view lists done occurrences newest first with completed tasks; skipped ones never appear", async () => {
		const h = await setup();
		const a = await series(h, "Weekly review", rule({ freq: "weekly", weekdays: ["FR"] }), "2026-09-25");
		const plain = (await h.app.tasks.create({ title: "One-off" })).task;
		h.clock.set("2026-10-05T10:00:00.000Z");
		await h.app.tasks.complete(a.id); // Sep 25 done, Oct 2 auto-skipped (catch-up)
		h.clock.set("2026-10-05T11:00:00.000Z");
		await h.app.tasks.complete(plain.id);
		h.clock.set("2026-10-05T12:00:00.000Z");
		await h.app.recurrence.skip(a.id); // Oct 9 skipped on purpose
		const [group] = view(h, "completed");
		expect(group!.entries.map((e) => [e.task.title, e.occurrence])).toEqual([
			["One-off", null],
			["Weekly review", { date: "2026-09-25", status: "done" }],
		]);
		const row = group!.entries[1]!;
		expect(row.schedule).toEqual({ kind: "date", date: "2026-09-25" });
		// The series itself is not a completed task.
		expect(h.app.store.state.tasks.get(a.id)!.status).toBe("open");
	});

	it("each row of a series is unique and a stopped series is also a completed task row", async () => {
		const h = await setup();
		const a = await series(h, "Stretch", rule(), "2026-10-03");
		await h.app.tasks.complete(a.id);
		await h.app.tasks.complete(a.id);
		await h.app.recurrence.stop(a.id);
		const [group] = view(h, "completed");
		const keys = group!.entries.map((e) => `${e.task.id}:${e.occurrence?.date ?? ""}`);
		expect(new Set(keys).size).toBe(keys.length);
		expect(group!.entries.filter((e) => e.occurrence === null).map((e) => e.task.title)).toEqual(["Stretch"]);
		expect(group!.entries.filter((e) => e.occurrence !== null).map((e) => e.occurrence!.date).sort()).toEqual(["2026-10-03", "2026-10-05"]);
	});

	it("the status filter is about the occurrence: open hides the rows, completed and all keep them; text and fields filter the series", async () => {
		const h = await setup();
		const a = await series(h, "Stretch", rule(), "2026-10-05");
		await series(h, "Read", rule(), "2026-10-05");
		await h.app.tasks.complete(a.id);
		expect(titles(view(h, "completed", emptyFilter("open")))).toEqual([]);
		expect(titles(view(h, "completed", emptyFilter("completed")))).toEqual(["Stretch"]);
		expect(titles(view(h, "completed", emptyFilter("all")))).toEqual(["Stretch"]);
		expect(titles(view(h, "completed", emptyFilter(), "read"))).toEqual([]);
		expect(titles(view(h, "completed", { ...emptyFilter(), priorities: [1] }))).toEqual([]);
	});

	it("a view's Completed group: Today holds what was done today, Upcoming what was done ahead, a list its own", async () => {
		const h = await setup();
		const a = await series(h, "Overdue one", rule(), "2026-10-03"); // Oct 3 done today, Oct 4 auto-skipped
		const b = await series(h, "Early", rule({ freq: "weekly", weekdays: ["FR"] }), "2026-10-09");
		await h.app.tasks.complete(a.id);
		await h.app.tasks.complete(b.id); // Oct 9 done ahead of time
		const ctx = h.app.queryContext();
		const group = (kind: "today" | "upcoming" | "inbox") => buildList(h.app.store.state, { kind }, ctx, emptyFilter(), "").completed.map((e) => [e.task.title, e.occurrence?.date ?? null]);
		expect(group("today")).toEqual([["Overdue one", "2026-10-03"]]);
		expect(group("upcoming")).toEqual([["Early", "2026-10-09"]]);
		expect(group("inbox")).toHaveLength(2);
		// The board's Upcoming column of that day lists the done occurrence under its own day.
		const col = buildBoard(h.app.store.state, { kind: "upcoming" }, ctx, emptyFilter(), "").find((c) => c.id === "2026-10-09");
		expect(col!.completed.map((e) => [e.task.title, e.occurrence?.date])).toEqual([["Early", "2026-10-09"]]);
	});

	it("Reopen removes the row", async () => {
		const h = await setup();
		const a = await series(h, "Stretch", rule(), "2026-10-05");
		await h.app.tasks.complete(a.id);
		expect(titles(view(h, "completed"))).toEqual(["Stretch"]);
		await h.app.recurrence.reopen(a.id, TODAY);
		expect(titles(view(h, "completed"))).toEqual([]);
	});
});
