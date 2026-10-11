import { describe, expect, it } from "vitest";
import type { Tag, Task } from "../../src/domain/types";
import { makeTask } from "../persistence/fixtures";
import { type AppHarness, appHarness } from "./harness";

// Lists, sections and tags rule 28: deleting a parent moves its child tags to the top level (`home/calls` becomes
// `calls`) on every task, trashed ones too, in the same write, with one Undo.

const JAN = "2026-01-01T00:00:00.000Z";
const DELETE_TAG = "Delete tag";

async function seeded(): Promise<AppHarness & { ids: Record<string, string> }> {
	const h = await appHarness();
	await h.app.store.run("Seed", (tx) => {
		const put = (key: string, displayName: string, color: Tag["color"] = null) => tx.put("tags", { key, displayName, color, createdAt: JAN, modifiedAt: JAN });
		put("home", "Home", "red");
		put("home/calls", "Home/Calls", "blue");
		put("home/garden", "Home/Garden");
		put("errands", "Errands");
	});
	const ids: Record<string, string> = {};
	for (const [title, tagKeys] of [
		["Ring mum", ["home/calls", "errands"]],
		["Weed", ["home/garden"]],
		["Tidy", ["home"]],
		["Both", ["home", "home/calls"]],
		["Shop", ["errands"]],
		["Old call", ["home", "home/calls"]],
	] as const) {
		ids[title] = (await h.app.tasks.create({ title, tagKeys: [...tagKeys] })).task.id;
	}
	await h.app.tasks.delete(ids["Old call"]!);
	h.clock.advance(60_000);
	return Object.assign(h, { ids });
}

const task = (h: AppHarness, id: string): Task => h.app.store.state.tasks.get(id)!;
const trashed = (h: AppHarness): Task[] => [...h.app.store.state.trash.values()].flatMap((e) => e.tasks);
const snapshot = (h: AppHarness) => {
	const s = h.app.store.state;
	return { tags: new Map(s.tags), tasks: new Map(s.tasks), trash: new Map(s.trash) };
};

describe("TagService.delete of a parent", () => {
	it("moves the child tags to the top level in one write: records, live tasks and trashed tasks", async () => {
		const h = await seeded();
		const before = snapshot(h);
		const now = h.clock.now().toISOString();
		const trashedBefore = trashed(h)[0]!;
		const r = await h.app.tags.delete("home");
		expect(r.wrote).toBe(true);
		expect(r.label).toBe(DELETE_TAG);
		expect(r.moves).toEqual([
			{ from: "home/calls", to: "calls" },
			{ from: "home/garden", to: "garden" },
		]);
		const tags = h.app.store.state.tags;
		expect([...tags.keys()].sort()).toEqual(["calls", "errands", "garden"]);
		// A moved child keeps its createdAt (what it owns its name by) and color; modifiedAt is now.
		expect(tags.get("calls")).toEqual({ key: "calls", displayName: "Calls", color: "blue", createdAt: JAN, modifiedAt: now });
		expect(tags.get("garden")).toEqual({ key: "garden", displayName: "Garden", color: null, createdAt: JAN, modifiedAt: now });
		expect(tags.get("errands")).toBe(before.tags.get("errands"));

		const ring = task(h, h.ids["Ring mum"]!);
		expect(ring.tagKeys).toEqual(["calls", "errands"]);
		expect(ring.modifiedAt).toBe(now);
		expect(task(h, h.ids["Weed"]!).tagKeys).toEqual(["garden"]);
		expect(task(h, h.ids["Tidy"]!).tagKeys).toEqual([]);
		// A task with the parent and the child ends with the child once.
		expect(task(h, h.ids["Both"]!).tagKeys).toEqual(["calls"]);
		expect(task(h, h.ids["Shop"]!)).toBe(before.tasks.get(h.ids["Shop"]!));

		// A trashed task gets the new keys and keeps its modifiedAt.
		const old = trashed(h)[0]!;
		expect(old.tagKeys).toEqual(["calls"]);
		expect(old.modifiedAt).toBe(trashedBefore.modifiedAt);
	});

	it("is one Undo entry that restores every record by identity", async () => {
		const h = await seeded();
		const before = snapshot(h);
		const mark = h.app.store.undoMark();
		await h.app.tags.delete("home");
		expect(await h.app.store.undoFor(mark, DELETE_TAG)()).toBe(true);
		const after = snapshot(h);
		expect(after).toEqual(before);
		for (const [k, t] of before.tags) expect(after.tags.get(k)).toBe(t);
		for (const [k, t] of before.tasks) expect(after.tasks.get(k)).toBe(t);
		for (const [k, e] of before.trash) expect(after.trash.get(k)).toBe(e);
		expect(h.app.store.undoLabel).not.toBe(DELETE_TAG);
	});

	it("a leaf delete moves nothing", async () => {
		const h = await seeded();
		const r = await h.app.tags.delete("errands");
		expect(r).toEqual({ wrote: true, label: DELETE_TAG, tasks: 2, moves: [] });
	});

	it("Undo is refused after a later write outside the history uses a moved key", async () => {
		const h = await seeded();
		const mark = h.app.store.undoMark();
		await h.app.tags.delete("home");
		await h.app.store.run("Outside", (tx) => tx.put("tasks", makeTask("t-out", { tagKeys: ["calls"] })), { undoable: false });
		const state = h.app.store.state;
		await expect(h.app.store.undoFor(mark, DELETE_TAG)()).rejects.toMatchObject({
			code: "UndoConflict",
			message: 'Cannot undo "Delete tag": a task now uses this tag.',
		});
		expect(h.app.store.state).toBe(state);
	});

	it("Undo is refused once a later write uses a moved key, even through a new tag of that name", async () => {
		const h = await seeded();
		const mark = h.app.store.undoMark();
		await h.app.tags.delete("home");
		await h.app.tasks.create({ title: "Call the bank", tagKeys: ["calls"] });
		await expect(h.app.store.undoFor(mark, DELETE_TAG)()).rejects.toMatchObject({ code: "UndoConflict" });
		expect(h.app.store.state.tags.has("calls")).toBe(true);
	});

	it("Undo is refused once a moved task was edited", async () => {
		const h = await seeded();
		await h.app.tags.delete("home");
		await h.app.store.run("Outside", (tx) => tx.put("tasks", { ...tx.get("tasks", h.ids["Weed"]!)!, title: "Weed the beds" }), { undoable: false });
		await expect(h.app.store.undo()).rejects.toMatchObject({ code: "UndoConflict", message: 'Cannot undo "Delete tag": the item changed since.' });
		expect(h.app.store.state.tags.has("garden")).toBe(true);
	});
});
