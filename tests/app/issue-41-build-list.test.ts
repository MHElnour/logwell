import { describe, expect, it } from "vitest";
import { type TaskView, buildCompleted, buildList, buildView } from "../../src/app/views";
import { groupByOptions } from "../../src/domain/groupBy";
import { type TaskFilter, type TaskSort, emptyFilter } from "../../src/domain/queries";
import type { ID } from "../../src/domain/types";
import { seededState } from "./issue-41-seed";

// Issue 41: the Tasks section builds a view's open rows and its Completed group with one `buildList`. It must
// give exactly what `buildView` and `buildCompleted` give (both pinned by `issue-41-views-golden.test.ts`).

const SORTS: TaskSort[] = ["manual", "date", "priority"];
const FILTERS: { filter: TaskFilter; text: string }[] = [
	{ filter: emptyFilter(), text: "" },
	{ filter: emptyFilter("open"), text: "" },
	{ filter: emptyFilter(), text: "call" },
	{ filter: { ...emptyFilter(), date: "next7" }, text: "" },
];

describe("buildList (issue 41)", () => {
	it("gives the rows of buildView and the group of buildCompleted, for every view, grouping, sort, filter and held set", async () => {
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
		let compared = 0;
		for (const view of views) {
			for (const sort of SORTS) {
				for (const f of FILTERS) {
					const filter = { ...f.filter, sort };
					for (const hs of [new Set<ID>(), held]) {
						const completed = buildCompleted(state, view, ctx, filter, f.text, hs);
						for (const groupBy of [undefined, ...groupByOptions(view.kind)]) {
							const list = buildList(state, view, ctx, filter, f.text, hs, { groupBy });
							expect(list.groups).toEqual(buildView(state, view, ctx, filter, f.text, hs, groupBy));
							expect(list.completed).toEqual(completed);
							expect(buildList(state, view, ctx, filter, f.text, hs, { groupBy, completed: false })).toEqual({ groups: list.groups, completed: [] });
							compared++;
						}
					}
				}
			}
		}
		expect(compared).toBeGreaterThan(500);
	}, 60_000);
});
