import { describe, expect, it } from "vitest";
import { blockOpenView } from "../../src/app/blockView";
import { parseBlockQuery } from "../../src/parsing/blockQuery";
import { appHarness } from "./harness";

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
