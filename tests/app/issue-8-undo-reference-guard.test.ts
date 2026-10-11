import { describe, expect, it } from "vitest";
import { EDIT_TAG_LABEL } from "../../src/app/CategoryService";
import { makeTask } from "../persistence/fixtures";
import { appHarness } from "./harness";

// The store's Undo refuses to remove a tag that a task or a trashed task holds after the write being undone, when the
// key came there through a write that is not an undo step. Checked on the state after the revert, so the write's own
// tasks (restored to their old keys, or removed with it) never count.

async function renamedParent() {
	const h = await appHarness();
	await h.app.tags.create("Home/Child1");
	await h.app.tags.create("Home");
	const mark = h.app.store.undoMark();
	await h.app.tags.edit("home", { name: "House", parentKey: null, color: null });
	return { h, mark };
}

describe("Undo reference guard", () => {
	it("refuses when a task got a moved child key outside the undo history", async () => {
		const { h, mark } = await renamedParent();
		const store = h.app.store;
		await store.run("Outside", (tx) => tx.put("tasks", makeTask("t-out", { tagKeys: ["house/child1"] })), { undoable: false });
		const state = store.state;
		await expect(store.undo()).rejects.toMatchObject({ code: "UndoConflict", message: 'Cannot undo "Edit tag": a task now uses this tag.' });
		expect(store.state).toBe(state);
		// The entry is gone: the notice's Undo can no longer undo it.
		await expect(store.undoFor(mark, EDIT_TAG_LABEL)()).rejects.toMatchObject({
			code: "UndoConflict",
			message: 'Cannot undo "Edit tag": this change can no longer be undone here.',
		});
	});

	it("the notice's Undo surfaces the same refusal", async () => {
		const { h, mark } = await renamedParent();
		const store = h.app.store;
		const undo = store.undoFor(mark, EDIT_TAG_LABEL);
		await store.run("Outside", (tx) => tx.put("tasks", makeTask("t-out", { tagKeys: ["house"] })), { undoable: false });
		await expect(undo()).rejects.toMatchObject({ code: "UndoConflict", message: 'Cannot undo "Edit tag": a task now uses this tag.' });
		expect(store.state.tags.has("house")).toBe(true);
	});

	it("refuses when a trashed task holds the key", async () => {
		const { h } = await renamedParent();
		const store = h.app.store;
		await store.run(
			"Outside",
			(tx) => tx.put("trash", { batchId: "b-out", deletedAt: tx.now, tasks: [makeTask("t-trash", { tagKeys: ["house/child1"] })] }),
			{ undoable: false },
		);
		await expect(store.undo()).rejects.toMatchObject({ code: "UndoConflict", message: 'Cannot undo "Edit tag": a task now uses this tag.' });
		expect(store.state.tags.has("house/child1")).toBe(true);
	});

	it("the write's own rekeyed tasks do not count", async () => {
		const h = await appHarness();
		await h.app.tags.create("Calls");
		const { task } = await h.app.tasks.create({ title: "Ring mum", tagKeys: ["calls"] });
		await h.app.tasks.delete((await h.app.tasks.create({ title: "Old call", tagKeys: ["calls"] })).task.id);
		await h.app.tags.edit("calls", { name: "Phone", parentKey: null, color: null });
		expect(await h.app.store.undo()).toBe(EDIT_TAG_LABEL);
		expect(h.app.store.state.tasks.get(task.id)!.tagKeys).toEqual(["calls"]);
		expect(h.app.store.state.tags.has("phone")).toBe(false);
	});
});
