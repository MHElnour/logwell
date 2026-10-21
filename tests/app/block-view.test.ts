import { describe, expect, it } from "vitest";
import { blockOpenView, taskListView } from "../../src/app/blockView";
import { parseBlockQuery } from "../../src/parsing/blockQuery";
import { appHarness } from "./harness";

describe("the views a block opens", () => {
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

		it("a child tag by its own name opens that tag, in any casing; a parent and the full path still open theirs", async () => {
			const withHome = async (h: Awaited<ReturnType<typeof appHarness>>) => {
				await h.app.tags.create("Home/Calls");
				await h.app.tags.create("Home/Garden");
			};
			for (const source of ["tag: calls", "tag: @Calls", "tag: home/calls"]) expect((await view(source, withHome)).view, source).toEqual({ kind: "tag", key: "home/calls" });
			expect((await view("tag: home", withHome)).view).toEqual({ kind: "tag", key: "home" });
		});

		it("a list name follows the list-name rule: loose spelling, an ambiguous name opens no view", async () => {
			let work = "";
			const lists = async (h: Awaited<ReturnType<typeof appHarness>>) => {
				await h.app.categories.create("Home work");
				await h.app.categories.create("Home-work");
				work = (await h.app.categories.create("Work")).id;
			};
			expect((await view("list: WorK", lists)).view).toEqual({ kind: "category", id: work });
			expect((await view("list: homework", lists)).view).toBeNull();
			expect((await view("list: wrok", lists)).view).toBeNull();
		});

		it("priority, quadrant, linked and empty filters open no view", async () => {
			for (const source of ["priority: high", "quadrant: 1", "linked: this note", ""]) expect((await view(source)).view).toBeNull();
		});
	});

	it.each([
		["alone", "status: completed"],
		["before a list", "status: completed\nlist: Work"],
		["before a tag", "tag: Calls\nstatus: completed"],
		["before a date", "status: completed\ndue: today"],
		["with filters no view shows", "status: completed\npriority: high"],
		["with a list that does not exist", "status: completed\nlist: Wrok"],
	])("#222: a completed block opens the Completed view, %s", async (_name, source) => {
		const r = await view(source, async (h) => {
			await h.app.categories.create("Work");
			await h.app.tags.create("Calls");
		});
		expect(r.view).toEqual({ kind: "completed" });
	});

	it("#222: status: open opens the same view as no status line", async () => {
		let id = "";
		const r = await view("status: open\nlist: Work", async (h) => void (id = (await h.app.categories.create("Work")).id));
		expect(r.view).toEqual({ kind: "category", id });
		expect((await view("status: open")).view).toBeNull();
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
});

describe("scheduled and tag list filters", () => {
	// The view that "Open in Logwell" shows for a block with `scheduled:` and a tag list (#52).

	type Harness = Awaited<ReturnType<typeof appHarness>>;
	const view = async (source: string, setup?: (h: Harness) => Promise<void>) => {
		const h = await appHarness();
		await setup?.(h);
		return blockOpenView(parseBlockQuery(source).filters, h.app.store.state);
	};
	const withTags = async (h: Harness) => {
		await h.app.tags.create("Home/Calls");
		await h.app.tags.create("Errands");
		await h.app.tags.create("Work");
	};

	describe("blockOpenView: scheduled", () => {
		it("opens Today for today and overdue, Upcoming for the ranges ahead", async () => {
			expect(await view("scheduled: today")).toEqual({ kind: "today" });
			expect(await view("scheduled: overdue")).toEqual({ kind: "today" });
			expect(await view("scheduled: this week")).toEqual({ kind: "upcoming" });
			expect(await view("scheduled: next 7 days")).toEqual({ kind: "upcoming" });
		});

		it.each(["due: 02-10-2026", "scheduled: 20-10-2026 to 25-10-2026"])("opens Upcoming for a typed date: %s", async (source) => {
			expect(await view(source)).toEqual({ kind: "upcoming" });
		});

		it("Today wins when either date key is today or overdue", async () => {
			expect(await view("due: this week\nscheduled: today")).toEqual({ kind: "today" });
			expect(await view("due: overdue\nscheduled: next 7 days")).toEqual({ kind: "today" });
			expect(await view("due: next 7 days\nscheduled: this week")).toEqual({ kind: "upcoming" });
		});

		it("a list or a tag wins over the date keys", async () => {
			let id = "";
			const list = await view("scheduled: today\nlist: Work", async (h) => void (id = (await h.app.categories.create("Work")).id));
			expect(list).toEqual({ kind: "category", id });
			expect(await view("scheduled: today\ntag: errands", withTags)).toEqual({ kind: "tag", key: "errands" });
		});
	});

	describe("blockOpenView: tag list", () => {
		it("one tag in the list opens that tag", async () => {
			expect(await view("tag: @Errands", withTags)).toEqual({ kind: "tag", key: "errands" });
		});

		it("a name and the same tag by its path are one tag", async () => {
			expect(await view("tag: calls, home/calls", withTags)).toEqual({ kind: "tag", key: "home/calls" });
		});

		it("a child beside its parent opens the parent", async () => {
			expect(await view("tag: home/calls, home", withTags)).toEqual({ kind: "tag", key: "home" });
			expect(await view("tag: home, calls", withTags)).toEqual({ kind: "tag", key: "home" });
		});

		it("unrelated tags open no tag view", async () => {
			expect(await view("tag: errands, work", withTags)).toBeNull();
		});

		it("unrelated tags fall through to the date keys", async () => {
			expect(await view("tag: errands, work\ndue: today", withTags)).toEqual({ kind: "today" });
			expect(await view("tag: errands, work\nscheduled: next 7 days", withTags)).toEqual({ kind: "upcoming" });
		});

		it("a tag that does not exist opens no view, even with a date key", async () => {
			expect(await view("tag: errands, nope\ndue: today", withTags)).toBeNull();
		});

		it("a list wins over several tags", async () => {
			let id = "";
			const r = await view("tag: errands, work\nlist: Work", async (h) => {
				await withTags(h);
				id = (await h.app.categories.create("Work")).id;
			});
			expect(r).toEqual({ kind: "category", id });
		});
	});
});
