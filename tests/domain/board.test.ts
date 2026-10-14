import { describe, expect, it } from "vitest";
import { dayTitle } from "../../src/domain/board";
import { type QueryContext, emptyFilter, upcomingGroups, todayEntries, flatEntries } from "../../src/domain/queries";
import type { DateSpec, Task } from "../../src/domain/types";
import { type DbData, createEmptyDb } from "../../src/persistence/schema";
import { buildBoard, buildList } from "../../src/app/views";
import { makeTask } from "../persistence/fixtures";

// Board columns. 2026-10-01 is a Thursday; the zone is Europe/Berlin.

const ctx: QueryContext = { today: "2026-10-01", zone: "Europe/Berlin", upcomingDays: 3, weekStart: "MO" };
const day = (date: string): DateSpec => ({ kind: "date", date });

function db(tasks: Task[]): DbData {
	const d = createEmptyDb({ dbId: "db", revision: "r", deviceId: "d", now: "2026-10-01T08:00:00.000Z" });
	return { ...d, tasks: new Map(tasks.map((x) => [x.id, x])) };
}

const titles = (cards: { entry: { task: Task }; subtasks: { task: Task }[] }[]) =>
	cards.map((c) => [c.entry.task.title, ...c.subtasks.map((s) => s.task.title)]);

const t = (id: string, patch: Partial<Task> = {}) => makeTask(id, { title: id, sortKey: id, ...patch });

describe("Upcoming starts tomorrow", () => {
	const tasks = [
		t("overdue", { scheduled: day("2026-09-30") }),
		t("today", { scheduled: day("2026-10-01") }),
		t("tomorrow", { scheduled: day("2026-10-02") }),
		t("last", { scheduled: day("2026-10-04") }),
		t("after", { scheduled: day("2026-10-05") }),
		t("deadline-only", { deadline: day("2026-10-03") }),
		t("deadline-today", { deadline: day("2026-10-01") }),
		t("undated"),
	];
	const byId = new Map(tasks.map((x) => [x.id, x]));
	it("holds tomorrow through today + days, by key date, and no today or overdue", () => {
		const groups = upcomingGroups(tasks, byId, ctx);
		expect(groups.map((g) => [g.date, g.entries.map((e) => e.task.id)])).toEqual([
			["2026-10-02", ["tomorrow"]],
			["2026-10-03", ["deadline-only"]],
			["2026-10-04", ["last"]],
		]);
	});
	it("the view shows the same", () => {
		const groups = buildList(db(tasks), { kind: "upcoming" }, ctx, emptyFilter(), "").groups;
		expect(groups.map((g) => [g.date, g.tone])).toEqual([
			["2026-10-02", "tomorrow"],
			["2026-10-03", undefined],
			["2026-10-04", undefined],
		]);
	});
});

describe("default order is the sort key", () => {
	it("Today and Upcoming order by sortKey inside a group, not by time", () => {
		const a = t("b-first", { sortKey: "A", scheduled: { kind: "datetime", local: "2026-10-01T20:00", tz: "Europe/Berlin" } });
		const b = t("a-second", { sortKey: "B", scheduled: { kind: "datetime", local: "2026-10-01T08:00", tz: "Europe/Berlin" } });
		const byId = new Map([a, b].map((x) => [x.id, x]));
		expect(todayEntries([b, a], byId, ctx).map((e) => e.task.id)).toEqual(["b-first", "a-second"]);
		const c = { ...a, scheduled: day("2026-10-02") };
		const d = { ...b, scheduled: day("2026-10-02") };
		expect(upcomingGroups([d, c], byId, ctx)[0]!.entries.map((e) => e.task.id)).toEqual(["b-first", "a-second"]);
		expect(flatEntries([c], byId, ctx)).toHaveLength(1);
	});
	it("the date sort still orders by time", () => {
		const a = t("late", { sortKey: "A", scheduled: { kind: "datetime", local: "2026-10-01T20:00", tz: "Europe/Berlin" } });
		const b = t("early", { sortKey: "B", scheduled: { kind: "datetime", local: "2026-10-01T08:00", tz: "Europe/Berlin" } });
		const groups = buildList(db([a, b]), { kind: "today" }, ctx, { ...emptyFilter(), sort: "date" }, "").groups;
		expect(groups[0]!.entries.map((e) => e.task.id)).toEqual(["early", "late"]);
	});
});

describe("dayTitle", () => {
	it("names tomorrow and later days", () => {
		expect(dayTitle("2026-10-02", ctx)).toBe("Friday, Tomorrow");
		expect(dayTitle("2026-10-05", ctx)).toBe("Monday, Oct 5");
	});
});

describe("buildBoard: Today", () => {
	it("has Overdue then Today, with titles, tones and drop rules; sorted by sortKey", () => {
		const board = buildBoard(
			db([
				t("o2", { sortKey: "B", scheduled: day("2026-09-29") }),
				t("o1", { sortKey: "A", scheduled: day("2026-09-30") }),
				t("t2", { sortKey: "D", scheduled: day("2026-10-01") }),
				t("t1", { sortKey: "C", deadline: day("2026-10-01") }),
				t("later", { scheduled: day("2026-10-02") }),
			]),
			{ kind: "today" },
			ctx,
			emptyFilter(),
			"",
		);
		expect(board.map((c) => [c.id, c.title, c.tone, c.date, c.acceptsDrop])).toEqual([
			["overdue", "Overdue", "overdue", null, false],
			["today", "Today", "today", "2026-10-01", true],
		]);
		expect(titles(board[0]!.cards)).toEqual([["o1"], ["o2"]]);
		expect(titles(board[1]!.cards)).toEqual([["t1"], ["t2"]]);
	});
	it("hides Overdue when empty but keeps an empty Today", () => {
		const board = buildBoard(db([]), { kind: "today" }, ctx, emptyFilter(), "");
		expect(board.map((c) => c.id)).toEqual(["today"]);
		expect(board[0]!.cards).toEqual([]);
	});
	it("completed group: completed today and overdue-completed-today are in Today's Completed; Overdue has none", () => {
		const done = { status: "completed" as const, completedAt: "2026-10-01T08:00:00.000Z" };
		const board = buildBoard(
			db([
				t("open-over", { scheduled: day("2026-09-30") }),
				t("done-today", { ...done, scheduled: day("2026-10-01") }),
				t("done-over", { ...done, completedAt: "2026-10-01T09:00:00.000Z", scheduled: day("2026-09-20") }),
				t("done-old", { ...done, completedAt: "2026-09-25T09:00:00.000Z", scheduled: day("2026-09-20") }),
			]),
			{ kind: "today" },
			ctx,
			emptyFilter(),
			"",
		);
		expect(board[0]!.completed).toEqual([]);
		expect(board[1]!.completed.map((e) => e.task.id)).toEqual(["done-over", "done-today"]);
	});
	it("a held completed task stays among the cards, not in Completed", () => {
		const done = t("held", { status: "completed", completedAt: "2026-10-01T09:00:00.000Z", scheduled: day("2026-10-01") });
		const board = buildBoard(db([done]), { kind: "today" }, ctx, emptyFilter(), "", new Set(["held"]));
		expect(titles(board[0]!.cards)).toEqual([["held"]]);
		expect(board[0]!.completed).toEqual([]);
	});
});

describe("buildBoard: Upcoming", () => {
	const tasks = [
		t("fri", { scheduled: day("2026-10-02") }),
		t("sun", { scheduled: day("2026-10-04") }),
		t("today", { scheduled: day("2026-10-01") }),
		t("over", { scheduled: day("2026-09-30") }),
		t("done-fri", { status: "completed", completedAt: "2026-10-01T09:00:00.000Z", scheduled: day("2026-10-02") }),
	];
	it("has one column per day from tomorrow, empty ones included, with day titles", () => {
		const board = buildBoard(db(tasks), { kind: "upcoming" }, ctx, emptyFilter(), "");
		expect(board.map((c) => [c.id, c.title, c.tone, c.date, c.acceptsDrop])).toEqual([
			["2026-10-02", "Friday, Tomorrow", "tomorrow", "2026-10-02", true],
			["2026-10-03", "Saturday, Oct 3", undefined, "2026-10-03", true],
			["2026-10-04", "Sunday, Oct 4", undefined, "2026-10-04", true],
		]);
		expect(board.map((c) => titles(c.cards))).toEqual([[["fri"]], [], [["sun"]]]);
		const longer = buildBoard(db(tasks), { kind: "upcoming" }, { ...ctx, upcomingDays: 4 }, emptyFilter(), "");
		expect(longer.at(-1)).toMatchObject({ id: "2026-10-05", title: "Monday, Oct 5" });
	});
	it("each column has its own Completed group", () => {
		const board = buildBoard(db(tasks), { kind: "upcoming" }, ctx, emptyFilter(), "");
		expect(board.map((c) => c.completed.map((e) => e.task.id))).toEqual([["done-fri"], [], []]);
	});
	it("applies the filter and the text search", () => {
		const more = [...tasks, t("fri-b", { scheduled: day("2026-10-02"), priority: 1 })];
		const filtered = buildBoard(db(more), { kind: "upcoming" }, ctx, { ...emptyFilter(), priorities: [1] }, "");
		expect(filtered.map((c) => titles(c.cards))).toEqual([[["fri-b"]], [], []]);
		const searched = buildBoard(db(more), { kind: "upcoming" }, ctx, emptyFilter(), "sun");
		expect(searched.map((c) => titles(c.cards))).toEqual([[], [], [["sun"]]]);
	});
	it("sorts by sortKey, or by priority", () => {
		const list = [
			t("a", { sortKey: "A", scheduled: day("2026-10-02"), priority: 3 }),
			t("b", { sortKey: "B", scheduled: day("2026-10-02"), priority: 1 }),
		];
		const def = buildBoard(db(list), { kind: "upcoming" }, ctx, emptyFilter(), "");
		expect(titles(def[0]!.cards)).toEqual([["a"], ["b"]]);
		const byPriority = buildBoard(db(list), { kind: "upcoming" }, ctx, { ...emptyFilter(), sort: "priority" }, "");
		expect(titles(byPriority[0]!.cards)).toEqual([["b"], ["a"]]);
	});
});

describe("buildBoard: Inbox and lists", () => {
	it("Inbox is one No section column; subtasks nest under a parent in the column", () => {
		const board = buildBoard(
			db([
				t("p", { sortKey: "A" }),
				t("s2", { sortKey: "B", parentId: "p" }),
				t("s1", { sortKey: "A", parentId: "p" }),
				t("q", { sortKey: "B" }),
				t("other", { categoryId: "x" }),
			]),
			{ kind: "inbox" },
			ctx,
			emptyFilter(),
			"",
		);
		expect(board).toHaveLength(1);
		expect(board[0]).toMatchObject({ id: "none", title: "No section", date: null, acceptsDrop: true });
		expect(titles(board[0]!.cards)).toEqual([["p", "s1", "s2"], ["q"]]);
		expect(board[0]!.cards[0]!.subtasks.every((s) => s.depth === 1 && s.parentTitle === null)).toBe(true);
	});
	it("a list has its own column and Completed group", () => {
		const board = buildBoard(
			db([t("a", { categoryId: "x" }), t("b", { categoryId: "x", status: "completed", completedAt: "2026-10-01T09:00:00.000Z" }), t("c")]),
			{ kind: "category", id: "x" },
			ctx,
			emptyFilter(),
			"",
		);
		expect(titles(board[0]!.cards)).toEqual([["a"]]);
		expect(board[0]!.completed.map((e) => e.task.id)).toEqual(["b"]);
	});
	it("has no board for tags, Completed or Trash", () => {
		for (const view of [{ kind: "tag", key: "k" }, { kind: "completed" }, { kind: "trash" }] as const) {
			expect(buildBoard(db([t("a")]), view, ctx, emptyFilter(), "")).toEqual([]);
		}
	});
});

describe("buildBoard: subtasks across columns", () => {
	it("nests only when the parent is in the same column; otherwise a Parent › card", () => {
		const board = buildBoard(
			db([
				t("p", { scheduled: day("2026-10-02") }),
				t("same", { parentId: "p", scheduled: day("2026-10-02") }),
				t("elsewhere", { parentId: "p", scheduled: day("2026-10-04") }),
			]),
			{ kind: "upcoming" },
			ctx,
			emptyFilter(),
			"",
		);
		expect(titles(board[0]!.cards)).toEqual([["p", "same"]]);
		expect(board[2]!.cards).toHaveLength(1);
		expect(board[2]!.cards[0]!.entry).toMatchObject({ depth: 0, parentTitle: "p" });
		expect(board[2]!.cards[0]!.subtasks).toEqual([]);
	});
	it("in Today a subtask of an overdue parent is its own card in Today", () => {
		const board = buildBoard(
			db([t("p", { scheduled: day("2026-09-30") }), t("s", { parentId: "p", scheduled: day("2026-10-01") })]),
			{ kind: "today" },
			ctx,
			emptyFilter(),
			"",
		);
		expect(board[0]!.cards[0]!.subtasks).toEqual([]);
		expect(board[1]!.cards[0]!.entry).toMatchObject({ parentTitle: "p" });
	});
});
