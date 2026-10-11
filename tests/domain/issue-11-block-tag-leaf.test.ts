import { describe, expect, it } from "vitest";
import { blockOpenView } from "../../src/app/blockView";
import { type BlockQueryState, runBlockQuery } from "../../src/domain/blockQuery";
import type { QueryContext } from "../../src/domain/queries";
import type { Category, Tag, Task } from "../../src/domain/types";
import { parseBlockQuery } from "../../src/parsing/blockQuery";

// A task block's `tag:` filter finds a child tag by its own name (#11).

const TS = "2026-09-01T09:00:00.000Z";
const CTX: QueryContext = { today: "2026-10-14", zone: "Europe/Berlin", upcomingDays: 7, weekStart: "MO" };

const tag = (key: string, displayName: string, createdAt = TS): Tag => ({ key, displayName, color: null, createdAt, modifiedAt: createdAt });
const inbox: Category = { id: "inbox", name: "Inbox", icon: null, color: null, nameKey: "inbox", isInbox: true, sortKey: "inbox", createdAt: TS, modifiedAt: TS };
const task = (id: string, tagKeys: string[]): Task => ({
	id,
	title: id,
	descriptionNote: null,
	categoryId: "inbox",
	tagKeys,
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
	createdAt: TS,
	modifiedAt: TS,
});

const tags = [tag("home/calls", "Home/Calls"), tag("home/garden", "Home/Garden")];
const tasks = [task("call", ["home/calls"]), task("garden", ["home/garden"]), task("none", [])];
const state: BlockQueryState = {
	tasks: new Map(tasks.map((t) => [t.id, t])),
	categories: new Map([[inbox.id, inbox]]),
	sections: new Map(),
	tags: new Map(tags.map((t) => [t.key, t])),
};
const run = (source: string) => runBlockQuery(parseBlockQuery(source).filters, state, CTX, "Plan.md");
const ids = (source: string): string[] => {
	const r = run(source);
	if (r.kind === "error") throw new Error(r.message);
	return r.entries.map((e) => e.task.id);
};

describe("task block: tag by its own name", () => {
	it("tag: calls finds the child tag", () => {
		expect(ids("tag: calls")).toEqual(["call"]);
	});

	it("tag: @Calls ignores case and the @", () => {
		expect(ids("tag: @Calls")).toEqual(["call"]);
	});

	it("tag: home/calls still works", () => {
		expect(ids("tag: home/calls")).toEqual(["call"]);
	});

	it("tag: home still includes every child", () => {
		expect(ids("tag: home").sort()).toEqual(["call", "garden"]);
	});

	it("a missing tag is the same error as before", () => {
		expect(run("tag: nope")).toEqual({ kind: "error", message: "No tag named “nope”." });
		expect(run("tag: work/calls")).toEqual({ kind: "error", message: "No tag named “work/calls”." });
	});
});

describe("blockOpenView: tag by its own name", () => {
	const view = (source: string) => blockOpenView(parseBlockQuery(source).filters, state);

	it("opens the child tag", () => {
		expect(view("tag: calls")).toEqual({ kind: "tag", key: "home/calls" });
		expect(view("tag: @Calls")).toEqual({ kind: "tag", key: "home/calls" });
	});

	it("still opens a parent and the full path", () => {
		expect(view("tag: home")).toEqual({ kind: "tag", key: "home" });
		expect(view("tag: home/calls")).toEqual({ kind: "tag", key: "home/calls" });
	});

	it("a tag that does not exist opens no view", () => {
		expect(view("tag: nope")).toBeNull();
	});
});
