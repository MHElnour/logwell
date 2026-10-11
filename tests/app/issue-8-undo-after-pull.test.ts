import { describe, expect, it } from "vitest";
import { linkedList, type SyncHarness, syncHarness } from "./sync-harness";

// An Undo never leaves a task holding a tag key with no tag (Data and safety; Lists, sections and tags rule 24). A
// TickTick pull is not an undo step, so a task it brings in may use a tag that a later Undo would remove: that Undo is
// refused, nothing changes, and the entry is dropped (rule 17), so the next Undo takes the one below.

async function setup(): Promise<SyncHarness & { listId: string; projectId: string }> {
	const s = await syncHarness();
	const { listId, projectId } = await linkedList(s);
	return Object.assign(s, { listId, projectId });
}

async function pullTask(s: SyncHarness & { projectId: string }, title: string, tags: string[]): Promise<void> {
	s.tick();
	s.tt.add(s.projectId, { title, tags });
	const r = await s.sync.sync();
	if (!r.ok) throw new Error("sync failed");
	expect(s.task(title).tagKeys).toEqual(tags);
}

describe("Undo after a pull that uses the tag", () => {
	it("a rename's Undo is refused when a pulled task uses the new name; nothing changes and the entry below is next", async () => {
		const s = await setup();
		const store = s.h.app.store;
		await s.h.app.tags.create("Calls");
		await s.h.app.tasks.create({ title: "Ring mum", categoryId: s.listId, tagKeys: ["calls"] });
		await s.sync.sync();
		// An unrelated write right below the edit, which the rename and the syncs do not touch.
		const errands = await s.h.app.categories.create("Errands");
		const below = store.undoLabel;
		expect(below).toBe("Create category");
		await s.h.app.tags.edit("calls", { name: "Phone", parentKey: null, color: null });
		await s.sync.sync();
		await pullTask(s, "Call the bank", ["phone"]);
		const state = store.state;
		await expect(store.undo()).rejects.toMatchObject({ code: "UndoConflict", message: 'Cannot undo "Edit tag": a task now uses this tag.' });
		expect(store.state).toBe(state);
		expect(store.undoLabel).toBe(below);
		expect(await store.undo()).toBe(below);
		expect(store.state.categories.has(errands.id)).toBe(false);
		expect(store.state.tags.has("phone")).toBe(true);
	});

	it("a New tag's Undo is refused when a pulled task uses it; the tag keeps its color", async () => {
		const s = await setup();
		await s.h.app.tags.add("Phone", null, "red");
		await pullTask(s, "Call the bank", ["phone"]);
		await expect(s.h.app.store.undo()).rejects.toMatchObject({ code: "UndoConflict", message: 'Cannot undo "Create tag": a task now uses this tag.' });
		expect(s.h.app.store.state.tags.get("phone")?.color).toBe("red");
	});

	it("a Create task with a new tag: refused when a pulled task uses the tag, undone when none does", async () => {
		const s = await setup();
		await s.h.app.tasks.create({ title: "Ring mum", categoryId: s.listId, newTags: ["Phone"] });
		await pullTask(s, "Call the bank", ["phone"]);
		await expect(s.h.app.store.undo()).rejects.toMatchObject({ code: "UndoConflict", message: 'Cannot undo "Create task": a task now uses this tag.' });
		expect(s.task("Ring mum").tagKeys).toEqual(["phone"]);

		const t = await setup();
		await t.h.app.tasks.create({ title: "Ring mum", newTags: ["Phone"] });
		expect(await t.h.app.store.undo()).toBe("Create task");
		expect(t.h.app.store.state.tags.has("phone")).toBe(false);
		expect(t.tasks("Ring mum")).toEqual([]);
	});

	it("a pulled task with another tag does not stop the rename's Undo", async () => {
		const s = await setup();
		await s.h.app.tags.create("Calls");
		await s.h.app.tasks.create({ title: "Ring mum", categoryId: s.listId, tagKeys: ["calls"] });
		await s.sync.sync();
		await s.h.app.tags.edit("calls", { name: "Phone", parentKey: null, color: null });
		await s.sync.sync();
		await pullTask(s, "Water plants", ["garden"]);
		expect(await s.h.app.store.undo()).toBe("Edit tag");
		expect(s.h.app.store.state.tags.has("calls")).toBe(true);
		expect(s.h.app.store.state.tags.has("phone")).toBe(false);
		expect(s.task("Ring mum").tagKeys).toEqual(["calls"]);
	});
});
