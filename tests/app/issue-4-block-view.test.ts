import { describe, expect, it } from "vitest";
import { blockOpenView, taskListView } from "../../src/app/blockView";
import { parseBlockQuery } from "../../src/parsing/blockQuery";
import { appHarness } from "./harness";

// The view that "Open in Logwell" shows for a block, and the view that shows a task opened from a row.

const view = async (source: string, setup?: (h: Awaited<ReturnType<typeof appHarness>>) => Promise<void>) => {
	const h = await appHarness();
	await setup?.(h);
	return { h, view: blockOpenView(parseBlockQuery(source).filters, h.app.store.state) };
};

describe("blockOpenView", () => {
	it("a list filter opens that list", async () => {
		let id = "";
		const r = await view("list: work\nsection: x\ndue: today", async (h) => {
			id = (await h.app.categories.create("Work")).id;
		});
		expect(r.view).toEqual({ kind: "category", id });
	});

	it("the Inbox list opens the Inbox", async () => {
		expect((await view("list: Inbox")).view).toEqual({ kind: "inbox" });
	});

	it("a list that does not exist opens no view", async () => {
		expect((await view("list: Wrok")).view).toBeNull();
	});

	it("a tag filter opens the tag, a list wins over it", async () => {
		const tag = await view("tag: @Calls", async (h) => void (await h.app.tags.create("Calls")));
		expect(tag.view).toEqual({ kind: "tag", key: "calls" });
		let id = "";
		const both = await view("tag: Calls\nlist: Work", async (h) => {
			await h.app.tags.create("Calls");
			id = (await h.app.categories.create("Work")).id;
		});
		expect(both.view).toEqual({ kind: "category", id });
	});

	it("a parent tag with only child tags opens the parent", async () => {
		expect((await view("tag: Home", async (h) => void (await h.app.tags.create("Home/Garden")))).view).toEqual({ kind: "tag", key: "home" });
	});

	it("a tag that does not exist opens no view", async () => {
		expect((await view("tag: Nope")).view).toBeNull();
	});

	it("a due filter opens Today for today and overdue, Upcoming for the ranges ahead", async () => {
		expect((await view("due: today")).view).toEqual({ kind: "today" });
		expect((await view("due: overdue")).view).toEqual({ kind: "today" });
		expect((await view("due: this week")).view).toEqual({ kind: "upcoming" });
		expect((await view("due: next 7 days")).view).toEqual({ kind: "upcoming" });
	});

	it("a tag wins over a due filter", async () => {
		expect((await view("tag: Calls\ndue: today", async (h) => void (await h.app.tags.create("Calls")))).view).toEqual({ kind: "tag", key: "calls" });
	});

	it("priority, quadrant, linked and empty filters open no view", async () => {
		for (const source of ["priority: high", "quadrant: 1", "linked: this note", ""]) expect((await view(source)).view).toBeNull();
	});
});

describe("taskListView", () => {
	it("shows a task in its list, or in the Inbox", async () => {
		const h = await appHarness();
		const work = await h.app.categories.create("Work");
		const a = (await h.app.tasks.create({ title: "A", categoryId: work.id })).task;
		const b = (await h.app.tasks.create({ title: "B" })).task;
		expect(taskListView(a)).toEqual({ kind: "category", id: work.id });
		expect(taskListView(b)).toEqual({ kind: "inbox" });
	});
});
