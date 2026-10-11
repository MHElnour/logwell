import { describe, expect, it } from "vitest";
import { buildBoard, buildList, viewTitle } from "../../src/app/views";
import type { TaskView, ViewGroup } from "../../src/app/views";
import type { GroupBy } from "../../src/domain/groupBy";
import { type TaskSort, emptyFilter } from "../../src/domain/queries";
import { INBOX_ID } from "../../src/domain/types";
import { type AppHarness, appHarness } from "./harness";

// Grouping of the list view. FakeClock starts at 2026-10-01T10:00Z; the display zone is
// Europe/Berlin, so today is Thursday 2026-10-01.

const date = (d: string) => ({ kind: "date" as const, date: d });

function group(h: AppHarness, view: TaskView, by: GroupBy | undefined, sort: TaskSort = "manual", held?: ReadonlySet<string>): ViewGroup[] {
	return buildList(h.app.store.state, view, h.app.queryContext(), { ...emptyFilter(), sort }, "", held, { groupBy: by }).groups;
}
const titles = (g: ViewGroup) => g.entries.map((e) => e.task.title);
const shape = (gs: ViewGroup[]) => gs.map((g) => [g.key, g.label ?? g.date, g.tone, titles(g)]);

async function seed() {
	const h = await appHarness();
	const t = h.app.tasks;
	await h.app.tags.create("Work");
	await h.app.tags.create("Home");
	const a = (await t.create({ title: "A", scheduled: date("2026-09-29"), priority: 1, tagKeys: ["work"] })).task;
	await t.create({ title: "A sub", parentId: a.id, scheduled: date("2026-10-05"), priority: 3 });
	await t.create({ title: "B", scheduled: { kind: "datetime", local: "2026-10-01T21:00", tz: "Europe/Berlin" }, priority: 2 });
	await t.create({ title: "C", scheduled: date("2026-10-02"), tagKeys: ["home", "work"] });
	await t.create({ title: "D", priority: 3 });
	await t.create({ title: "E", deadline: date("2026-10-03"), priority: 1, tagKeys: ["home"] });
	return { h, a };
}

const INBOX: TaskView = { kind: "inbox" };

describe("group by none", () => {
	it("is one plain group in sort-key order, with sections ignored", async () => {
		const { h } = await seed();
		const sec = await h.app.sections.create(INBOX_ID, "Todo");
		await h.app.tasks.update([...h.app.store.state.tasks.values()].find((x) => x.title === "D")!.id, { sectionId: sec.id });
		const gs = group(h, INBOX, "none");
		expect(shape(gs)).toEqual([["all", null, undefined, ["A", "A sub", "B", "C", "D", "E"]]]);
		expect(gs[0]!.section).toBeUndefined();
		expect(gs[0]!.drop).toBeUndefined();
	});

	it("is the default for Inbox, a list and a tag", async () => {
		const { h } = await seed();
		const work = await h.app.categories.create("Work");
		for (const view of [INBOX, { kind: "category", id: work.id }, { kind: "tag", key: "work" }] as TaskView[]) {
			const gs = group(h, view, undefined);
			expect(gs.length).toBeLessThanOrEqual(1);
			expect(gs.every((g) => g.section === undefined && g.date === null && g.label === undefined)).toBe(true);
		}
	});
});

describe("group by section", () => {
	it("is the K1b headings: No section first, then each section, empty ones included", async () => {
		const { h } = await seed();
		const todo = await h.app.sections.create(INBOX_ID, "Todo");
		await h.app.sections.create(INBOX_ID, "Later");
		const d = [...h.app.store.state.tasks.values()].find((x) => x.title === "D")!;
		await h.app.tasks.update(d.id, { sectionId: todo.id });
		const gs = group(h, INBOX, "section");
		expect(gs.map((g) => [g.section?.name, titles(g)])).toEqual([
			["No section", ["A", "A sub", "B", "C", "E"]],
			["Todo", ["D"]],
			["Later", []],
		]);
		expect(gs.map((g) => g.drop)).toEqual([
			{ kind: "section", sectionId: null },
			{ kind: "section", sectionId: todo.id },
			{ kind: "section", sectionId: gs[2]!.section!.id },
		]);
	});

	it("is only offered in Inbox and lists: other views fall back to their default", async () => {
		const { h } = await seed();
		const gs = group(h, { kind: "tag", key: "work" }, "section");
		expect(gs.every((g) => g.section === undefined)).toBe(true);
	});
});

describe("group by date in a list", () => {
	it("has one heading per date, past dates in red, today and tomorrow toned, No date last", async () => {
		const { h } = await seed();
		const gs = group(h, INBOX, "date");
		expect(shape(gs)).toEqual([
			["2026-09-29", "2026-09-29", "overdue", ["A", "A sub"]],
			["2026-10-01", "2026-10-01", "today", ["B"]],
			["2026-10-02", "2026-10-02", "tomorrow", ["C"]],
			["2026-10-03", "2026-10-03", undefined, ["E"]],
			["nodate", "No date", undefined, ["D"]],
		]);
		expect(gs.at(-1)!.date).toBeNull();
	});

	it("keeps a subtask under its parent, whatever its own date", async () => {
		const { h } = await seed();
		const gs = group(h, INBOX, "date");
		const first = gs[0]!;
		expect(first.entries.map((e) => [e.task.title, e.depth])).toEqual([
			["A", 0],
			["A sub", 1],
		]);
		expect(gs.flatMap(titles).filter((x) => x === "A sub")).toHaveLength(1);
	});

	it("orders inside a group by the sort, and drops are allowed on dates but not on No date", async () => {
		const { h } = await seed();
		await h.app.tasks.create({ title: "B2", scheduled: date("2026-10-01"), priority: 1 });
		const manual = group(h, INBOX, "date", "manual").find((g) => g.key === "2026-10-01")!;
		expect(titles(manual)).toEqual(["B", "B2"]);
		const byPriority = group(h, INBOX, "date", "priority").find((g) => g.key === "2026-10-01")!;
		expect(titles(byPriority)).toEqual(["B2", "B"]);
		const gs = group(h, INBOX, "date");
		expect(gs.find((g) => g.key === "2026-10-01")!.drop).toEqual({ kind: "date", date: "2026-10-01" });
		expect(gs.find((g) => g.key === "2026-09-29")!.drop).toEqual({ kind: "date", date: "2026-09-29" });
		expect(gs.find((g) => g.key === "nodate")!.drop).toBeUndefined();
	});

	it("uses the display zone for a timed value near midnight", async () => {
		const h = await appHarness();
		// 23:30 in Berlin on the 2nd is the 2nd in the display zone, although it is 21:30 UTC.
		await h.app.tasks.create({ title: "Late", scheduled: { kind: "datetime", local: "2026-10-02T23:30", tz: "Europe/Berlin" } });
		expect(group(h, INBOX, "date").map((g) => g.key)).toEqual(["2026-10-02"]);
	});

	it("leaves out a completed task, and keeps a completed subtask under its open parent", async () => {
		const { h, a } = await seed();
		const t = [...h.app.store.state.tasks.values()];
		await h.app.tasks.complete(t.find((x) => x.title === "B")!.id);
		await h.app.tasks.complete(t.find((x) => x.title === "A sub")!.id);
		const gs = group(h, INBOX, "date");
		expect(gs.flatMap(titles)).toEqual(["A", "A sub", "C", "E", "D"]);
		expect(gs[0]!.entries[1]!.task.parentId).toBe(a.id);
		expect(buildList(h.app.store.state, INBOX, h.app.queryContext(), emptyFilter(), "").completed.map((e) => e.task.title)).toEqual(["B"]);
	});
});

describe("group by date in Today and Upcoming", () => {
	it("is Overdue and Today in Today, as before", async () => {
		const { h } = await seed();
		const explicit = group(h, { kind: "today" }, "date");
		expect(shape(explicit)).toEqual([
			["overdue", "Overdue", "overdue", ["A"]],
			["today", "Today", "today", ["B"]],
		]);
		expect(shape(group(h, { kind: "today" }, undefined))).toEqual(shape(explicit));
		expect(explicit[0]!.drop).toBeUndefined();
		expect(explicit[1]!.drop).toEqual({ kind: "date", date: "2026-10-01" });
	});

	it("is one group per day in Upcoming, as before", async () => {
		const { h } = await seed();
		const up = group(h, { kind: "upcoming" }, undefined);
		expect(shape(up)).toEqual([
			["2026-10-02", "2026-10-02", "tomorrow", ["C"]],
			["2026-10-03", "2026-10-03", undefined, ["E"]],
			["2026-10-05", "2026-10-05", undefined, ["A sub"]],
		]);
		expect(up[0]!.drop).toEqual({ kind: "date", date: "2026-10-02" });
		expect(up[2]!.entries[0]!.parentTitle).toBe("A");
	});
});

describe("group by priority", () => {
	it("is High, Medium, Low, None, with empty groups left out and a subtask under its parent", async () => {
		const { h } = await seed();
		const gs = group(h, INBOX, "priority");
		expect(shape(gs)).toEqual([
			["priority:1", "High", undefined, ["A", "A sub", "E"]],
			["priority:2", "Medium", undefined, ["B"]],
			["priority:3", "Low", undefined, ["D"]],
			["priority:0", "None", undefined, ["C"]],
		]);
		expect(gs.map((g) => g.drop)).toEqual([1, 2, 3, 0].map((priority) => ({ kind: "priority", priority })));
	});

	it("leaves out a priority nobody has", async () => {
		const h = await appHarness();
		await h.app.tasks.create({ title: "Only", priority: 2 });
		expect(group(h, INBOX, "priority").map((g) => g.key)).toEqual(["priority:2"]);
	});

	it("groups a flat subtask in Today by its own priority", async () => {
		const { h } = await seed();
		const gs = group(h, { kind: "today" }, "priority");
		// "A sub" is scheduled on 2026-10-05, so it is not in Today: the parent is overdue, High.
		expect(shape(gs)).toEqual([
			["priority:1", "High", undefined, ["A"]],
			["priority:2", "Medium", undefined, ["B"]],
		]);
		const sub = [...h.app.store.state.tasks.values()].find((x) => x.title === "A sub")!;
		await h.app.tasks.update(sub.id, { scheduled: date("2026-10-01") });
		const again = group(h, { kind: "today" }, "priority");
		expect(shape(again).map((r) => r[3])).toEqual([["A"], ["B"], ["A sub"]]);
		expect(again[2]!.entries[0]).toMatchObject({ depth: 0, parentTitle: "A" });
	});

	it("follows the sort inside a group", async () => {
		const { h } = await seed();
		const gs = group(h, INBOX, "priority", "date");
		expect(titles(gs[0]!)).toEqual(["A", "A sub", "E"]);
	});
});

describe("group by tag", () => {
	it("puts a task once under its first tag, then No tag last", async () => {
		const { h } = await seed();
		const gs = group(h, INBOX, "tag");
		// C has [home, work]: it is under Home only. Groups are sorted by display name.
		expect(shape(gs)).toEqual([
			["tag:home", "@Home", undefined, ["C", "E"]],
			["tag:work", "@Work", undefined, ["A", "A sub"]],
			["notag", "No tag", undefined, ["B", "D"]],
		]);
		const all = gs.flatMap(titles);
		expect(new Set(all).size).toBe(all.length);
		expect(gs.every((g) => g.drop === undefined)).toBe(true);
	});

	it("follows the order of the task's tags, not alphabetical order", async () => {
		const h = await appHarness();
		await h.app.tags.create("Alpha");
		await h.app.tags.create("Zulu");
		await h.app.tasks.create({ title: "T", tagKeys: ["zulu", "alpha"] });
		expect(group(h, INBOX, "tag").map((g) => g.key)).toEqual(["tag:zulu"]);
	});

	it("works inside a tag view: the viewed tag is not special", async () => {
		const { h } = await seed();
		const gs = group(h, { kind: "tag", key: "work" }, "priority");
		expect(gs.flatMap(titles)).toEqual(["A", "C"]);
	});
});

describe("group by list", () => {
	it("is one group per list in sidebar order (Inbox first), each a drop target", async () => {
		const h = await appHarness();
		const work = await h.app.categories.create("Work");
		const home = await h.app.categories.create("Home");
		const today = date("2026-10-01");
		await h.app.tasks.create({ title: "H", categoryId: home.id, scheduled: today });
		await h.app.tasks.create({ title: "W", categoryId: work.id, scheduled: today });
		await h.app.tasks.create({ title: "I", scheduled: today });
		const w2 = (await h.app.tasks.create({ title: "W2", categoryId: work.id, scheduled: today })).task;
		await h.app.tasks.create({ title: "W2 sub", parentId: w2.id, scheduled: today });
		const gs = group(h, { kind: "today" }, "list");
		expect(shape(gs)).toEqual([
			[`list:${INBOX_ID}`, "Inbox", undefined, ["I"]],
			[`list:${work.id}`, "Work", undefined, ["W", "W2 sub", "W2"]],
			[`list:${home.id}`, "Home", undefined, ["H"]],
		]);
		expect(gs.map((g) => g.drop)).toEqual([INBOX_ID, work.id, home.id].map((categoryId) => ({ kind: "list", categoryId })));
	});

	it("names a list that is missing Inbox, like every other place (issue 27)", async () => {
		const h = await appHarness();
		const gone = await h.app.categories.create("Gone");
		await h.app.tasks.create({ title: "G", categoryId: gone.id, scheduled: date("2026-10-01") });
		(h.app.store.state.categories as Map<string, unknown>).delete(gone.id);
		expect(group(h, { kind: "today" }, "list").map((g) => g.label)).toEqual(["Inbox"]);
		expect(viewTitle({ kind: "category", id: gone.id }, h.app.store.state)).toBe("Inbox");
	});

	it("is not offered in Inbox: it falls back to none", async () => {
		const { h } = await seed();
		expect(group(h, INBOX, "list").map((g) => g.key)).toEqual(["all"]);
	});
});

describe("grouping and the board", () => {
	it("the board columns do not depend on the list grouping", async () => {
		const { h } = await seed();
		await h.app.sections.create(INBOX_ID, "Todo");
		const cols = buildBoard(h.app.store.state, INBOX, h.app.queryContext(), emptyFilter(), "");
		expect(cols.map((c) => c.title)).toEqual(["No section", "Todo"]);
		const today = buildBoard(h.app.store.state, { kind: "today" }, h.app.queryContext(), emptyFilter(), "");
		expect(today.map((c) => c.title)).toEqual(["Overdue", "Today"]);
	});
});
