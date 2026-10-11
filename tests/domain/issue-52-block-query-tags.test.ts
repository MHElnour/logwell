import { describe, expect, it } from "vitest";
import { type BlockQueryState, compileBlockQuery, runBlockQuery } from "../../src/domain/blockQuery";
import type { QueryContext } from "../../src/domain/queries";
import type { Category, Tag, Task } from "../../src/domain/types";
import { parseBlockQuery } from "../../src/parsing/blockQuery";

// `tag:` takes a comma list; a task with any of the tags shows (#52).

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

const tags = [tag("home", "Home"), tag("home/calls", "Home/Calls"), tag("home/garden", "Home/Garden"), tag("work", "Work"), tag("errands", "Errands"), tag("homework", "Homework")];
const tasks = [
	task("call", ["home/calls"]),
	task("garden", ["home/garden"]),
	task("work", ["work"]),
	task("errand", ["errands"]),
	task("both", ["home/calls", "work"]),
	task("homework", ["homework"]),
	task("none", []),
];
const state: BlockQueryState = {
	tasks: new Map(tasks.map((t) => [t.id, t])),
	categories: new Map([["inbox", inbox]]),
	sections: new Map(),
	tags: new Map(tags.map((t) => [t.key, t])),
};

const run = (source: string) => runBlockQuery(parseBlockQuery(source).filters, state, CTX, "Note.md");
const ids = (source: string): string[] => {
	const r = run(source);
	if (r.kind === "error") throw new Error(r.message);
	return r.entries.map((e) => e.task.id).sort();
};

describe("block matcher: tag list", () => {
	it("a task with any of the tags shows", () => {
		expect(ids("tag: work, errands")).toEqual(["both", "errand", "work"]);
	});

	it("a task with several of the tags shows once", () => {
		const r = run("tag: calls, work");
		expect(r.kind === "ok" && r.entries.map((e) => e.task.id).sort()).toEqual(["both", "call", "work"]);
	});

	it("a parent tag includes its children, next to a second tag", () => {
		expect(ids("tag: home, errands")).toEqual(["both", "call", "errand", "garden"]);
	});

	it("a parent and its own child give the parent's tasks", () => {
		expect(ids("tag: home, home/calls")).toEqual(["both", "call", "garden"]);
	});

	it("a name alone finds the child tag, with or without @, in any casing", () => {
		expect(ids("tag: @Calls, ERRANDS")).toEqual(["both", "call", "errand"]);
	});

	it("a sibling that shares a prefix is not included", () => {
		expect(ids("tag: home, work")).toEqual(["both", "call", "garden", "work"]);
	});

	it("the same tag twice is the same as once", () => {
		expect(ids("tag: work, WORK, @work")).toEqual(ids("tag: work"));
	});

	it("one tag behaves as before", () => {
		expect(ids("tag: home")).toEqual(["both", "call", "garden"]);
	});

	it("an unknown tag in the list is an error naming it", () => {
		expect(run("tag: work, nope")).toEqual({ kind: "error", message: "No tag named “nope”." });
	});

	it("the first unknown tag in typed order is reported", () => {
		expect(run("tag: nope2, work, nope1")).toEqual({ kind: "error", message: "No tag named “nope2”." });
		expect(run("tag: work, nope1, nope2")).toEqual({ kind: "error", message: "No tag named “nope1”." });
	});

	it("a path that is no tag is unknown, even beside a good one", () => {
		expect(run("tag: work, work/calls")).toEqual({ kind: "error", message: "No tag named “work/calls”." });
	});

	it("an unknown tag is reported by compileBlockQuery too", () => {
		expect(compileBlockQuery(parseBlockQuery("tag: work, nope").filters, state, CTX, "Note.md")).toEqual({ kind: "error", message: "No tag named “nope”." });
	});

	it("the compiled test agrees with the run for every task, asked twice", () => {
		const m = compileBlockQuery(parseBlockQuery("tag: home/calls, work, errands").filters, state, CTX, "Note.md");
		if (m.kind !== "ok") throw new Error("expected ok");
		const first = tasks.filter((t) => m.matches(t)).map((t) => t.id);
		expect(first).toEqual(["call", "work", "errand", "both"]);
		expect(tasks.filter((t) => m.matches(t)).map((t) => t.id)).toEqual(first);
	});

	it("combines with the date keys by AND", () => {
		const dated = new Map(state.tasks);
		dated.set("work", { ...task("work", ["work"]), scheduled: { kind: "date", date: "2026-10-14" } });
		const s: BlockQueryState = { ...state, tasks: dated };
		const r = runBlockQuery(parseBlockQuery("tag: work, errands\nscheduled: today").filters, s, CTX, "Note.md");
		expect(r.kind === "ok" && r.entries.map((e) => e.task.id)).toEqual(["work"]);
	});
});
