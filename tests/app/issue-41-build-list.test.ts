import { describe, expect, it } from "vitest";
import { type TaskView, buildList } from "../../src/app/views";
import { groupByOptions } from "../../src/domain/groupBy";
import { type TaskFilter, type TaskSort, emptyFilter } from "../../src/domain/queries";
import type { ID } from "../../src/domain/types";
import { seededState } from "./issue-41-seed";

// Issue 41: the Tasks section builds a view's open rows and its Completed group with one `buildList`, reading only
// the view's candidates from the task index. On the seeded state it must give exactly what it gives without the index
// (every task read; pinned by `issue-41-views-golden.test.ts`), and leaving the Completed group out changes no row.

const SORTS: TaskSort[] = ["manual", "date", "priority"];
const FILTERS: { filter: TaskFilter; text: string }[] = [
	{ filter: emptyFilter(), text: "" },
	{ filter: emptyFilter("open"), text: "" },
	{ filter: emptyFilter(), text: "call" },
	{ filter: { ...emptyFilter(), date: "next7" }, text: "" },
];

describe("buildList (issue 41)", () => {
	it("gives the same rows and Completed group with the index as without, for every view, grouping, sort, filter and held set", async () => {
		const { h, lists, tagKeys, held } = await seededState();
		const state = h.app.store.state;
		const ctx = h.app.queryContext();
		const index = h.app.tasks.lists;
		const views: TaskView[] = [
			{ kind: "inbox" },
			...lists.map((id) => ({ kind: "category" as const, id })),
			{ kind: "today" },
			{ kind: "upcoming" },
			...tagKeys.map((key) => ({ kind: "tag" as const, key })),
			{ kind: "completed" },
			{ kind: "trash" },
		];
		let compared = 0;
		for (const view of views) {
			for (const sort of SORTS) {
				for (const f of FILTERS) {
					const filter = { ...f.filter, sort };
					for (const hs of [new Set<ID>(), held]) {
						for (const groupBy of [undefined, ...groupByOptions(view.kind)]) {
							const list = buildList(state, view, ctx, filter, f.text, hs, { groupBy });
							expect(buildList(state, view, ctx, filter, f.text, hs, { groupBy, index })).toEqual(list);
							expect(buildList(state, view, ctx, filter, f.text, hs, { groupBy, completed: false, index })).toEqual({ groups: list.groups, completed: [] });
							compared++;
						}
					}
				}
			}
		}
		expect(compared).toBeGreaterThan(500);
	}, 60_000);
});
