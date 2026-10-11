import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type TaskView, buildBoard, buildList } from "../../src/app/views";
import { groupByOptions } from "../../src/domain/groupBy";
import { type TaskFilter, type TaskSort, emptyFilter } from "../../src/domain/queries";
import type { ID } from "../../src/domain/types";
import { seededState } from "./issue-41-seed";

// Issue 41: the Tasks view's rows, Completed group and board, pinned to what they were before the views were
// rebuilt from one pass. For a seeded state, every view (Inbox, each list, Today, Upcoming, each tag, Completed,
// Trash) is built with every grouping, sort and a set of filters, with and without held (just completed) tasks,
// and each result is compared by hash with `tests/fixtures/issue-41-views.golden.json`.
// CHECKPOINT_UPDATE_GOLDEN=1 rewrites the fixture; only do that on code whose output is known to be right.

const FIXTURE = new URL("../fixtures/issue-41-views.golden.json", import.meta.url);
const UPDATE = Boolean(process.env.CHECKPOINT_UPDATE_GOLDEN);
const SORTS: TaskSort[] = ["manual", "date", "priority"];

const FILTERS: { name: string; filter: TaskFilter; text: string }[] = [
	{ name: "all", filter: emptyFilter(), text: "" },
	{ name: "open", filter: emptyFilter("open"), text: "" },
	{ name: "completed", filter: emptyFilter("completed"), text: "" },
	// Text and date filters pass some subtasks without their parent (and parents without some subtasks).
	{ name: "text", filter: emptyFilter(), text: "call" },
	{ name: "next7", filter: { ...emptyFilter(), date: "next7" }, text: "" },
	{ name: "priority", filter: { ...emptyFilter(), priorities: [1, 2] }, text: "" },
];

/** A stable text of a result: tasks by id, everything else as built. */
function serialize(value: unknown): string {
	return JSON.stringify(value, (_key, v: unknown) => {
		if (typeof v === "object" && v !== null && "sortKey" in v && "status" in v && "categoryId" in v && "id" in v) return `#${String(v.id)}`;
		return v;
	});
}

const digest = (value: unknown, rows: number) => `${createHash("sha256").update(serialize(value)).digest("hex").slice(0, 16)}:${rows}`;

describe("Tasks views match the golden results (issue 41)", () => {
	it("builds every view, grouping, sort, filter and held set as before", async () => {
		const { h, lists, tagKeys, held } = await seededState();
		const state = h.app.store.state;
		const ctx = h.app.queryContext();
		const views: TaskView[] = [
			{ kind: "inbox" },
			...lists.map((id) => ({ kind: "category" as const, id })),
			{ kind: "today" },
			{ kind: "upcoming" },
			...tagKeys.map((key) => ({ kind: "tag" as const, key })),
			{ kind: "completed" },
			{ kind: "trash" },
		];
		const actual: Record<string, string> = {};
		for (const view of views) {
			const v = view.kind === "category" ? `list:${lists.indexOf(view.id)}` : view.kind === "tag" ? `tag:${view.key}` : view.kind;
			for (const sort of SORTS) {
				for (const f of FILTERS) {
					const filter = { ...f.filter, sort };
					for (const [heldName, hs] of [["none", new Set<ID>()], ["held", held]] as const) {
						const at = `${v}|${sort}|${f.name}|${heldName}`;
						for (const groupBy of [undefined, ...groupByOptions(view.kind)]) {
							const groups = buildList(state, view, ctx, filter, f.text, hs, { groupBy }).groups;
							actual[`view|${at}|${groupBy ?? "default"}`] = digest(groups, groups.reduce((n, g) => n + g.entries.length, 0));
						}
						const completed = buildList(state, view, ctx, filter, f.text, hs).completed;
						actual[`completed|${at}`] = digest(completed, completed.length);
						const board = buildBoard(state, view, ctx, filter, f.text, hs);
						actual[`board|${at}`] = digest(board, board.reduce((n, c) => n + c.cards.length + c.completed.length, 0));
					}
				}
			}
		}
		if (UPDATE) writeFileSync(FIXTURE, `${JSON.stringify(actual, null, 1)}\n`);
		expect(existsSync(FIXTURE), "the golden fixture is missing").toBe(true);
		const expected = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, string>;
		// Not empty by accident: the seeded state fills the views.
		expect(Object.values(expected).filter((d) => !d.endsWith(":0")).length).toBeGreaterThan(Object.keys(expected).length / 2);
		const differing = Object.keys({ ...expected, ...actual }).filter((k) => expected[k] !== actual[k]);
		expect(differing).toEqual([]);
	}, 60_000);
});
