import { describe, expect, it } from "vitest";
import { buildList, sidebarCounts, viewPreset, viewTitle } from "../../src/app/views";
import { emptyFilter } from "../../src/domain/queries";
import { appHarness } from "./harness";

// A tag view includes the tasks of every descendant tag.

async function seed() {
	const h = await appHarness();
	const t = h.app.tasks;
	await t.create({ title: "Go task", newTags: ["Programming/Go"] });
	await t.create({ title: "Python task", newTags: ["Programming/Python"] });
	await t.create({ title: "Both", newTags: ["Programming/Go", "Programming/Python"] });
	await t.create({ title: "Parent itself", newTags: ["Programming"] });
	await t.create({ title: "Lookalike", newTags: ["Programmingx"] });
	await t.create({ title: "Untagged" });
	return h;
}

const titles = (h: Awaited<ReturnType<typeof seed>>, key: string) =>
	buildList(h.app.store.state, { kind: "tag", key }, h.app.queryContext(), emptyFilter(), "").groups.flatMap((g) => g.entries.map((e) => e.task.title)).sort();

describe("tag views with descendants", () => {
	it("a parent view lists its own and every descendant's tasks, not a lookalike", async () => {
		const h = await seed();
		expect(titles(h, "programming")).toEqual(["Both", "Go task", "Parent itself", "Python task"]);
	});

	it("a child view lists only its own subtree", async () => {
		const h = await seed();
		expect(titles(h, "programming/go")).toEqual(["Both", "Go task"]);
		expect(titles(h, "programmingx")).toEqual(["Lookalike"]);
	});

	it("an implicit parent (no tag record) still lists its descendants' tasks", async () => {
		const h = await appHarness();
		await h.app.tasks.create({ title: "Go task", newTags: ["Programming/Go"] });
		expect(h.app.store.state.tags.has("programming")).toBe(false);
		expect(titles(h, "programming")).toEqual(["Go task"]);
	});

	it("the Completed group of a parent view includes completed descendant tasks", async () => {
		const h = await seed();
		const done = (await h.app.tasks.create({ title: "Done go", newTags: ["Programming/Go"] })).task;
		await h.app.tasks.complete(done.id);
		const entries = buildList(h.app.store.state, { kind: "tag", key: "programming" }, h.app.queryContext(), emptyFilter(), "").completed;
		expect(entries.map((e) => e.task.title)).toEqual(["Done go"]);
		expect(buildList(h.app.store.state, { kind: "tag", key: "programming/python" }, h.app.queryContext(), emptyFilter(), "").completed).toEqual([]);
	});

	it("counts include descendants, each task once, with implicit parents counted", async () => {
		const h = await seed();
		const counts = sidebarCounts(h.app.store.state, h.app.queryContext()).tags;
		expect(counts.get("programming")).toBe(4);
		expect(counts.get("programming/go")).toBe(2);
		expect(counts.get("programming/python")).toBe(2);
		expect(counts.get("programmingx")).toBe(1);
	});

	it("a tag view is titled by the tag's own name, and Quick Add from it presets no tag", async () => {
		const h = await appHarness();
		await h.app.tasks.create({ title: "Go task", newTags: ["Programming/Go"] });
		const state = h.app.store.state;
		expect(viewTitle({ kind: "tag", key: "programming" }, state)).toBe("@Programming");
		expect(viewTitle({ kind: "tag", key: "programming/go" }, state)).toBe("@Go");
		const ctx = h.app.queryContext();
		expect(viewPreset({ kind: "tag", key: "programming" }, ctx, state).addTagKeys).toEqual([]);
		expect(viewPreset({ kind: "tag", key: "programming/go" }, ctx, state).addTagKeys).toEqual(["programming/go"]);
	});
});
