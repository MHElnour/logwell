import { describe, expect, it } from "vitest";
import { CREATE_TAG_LABEL } from "../../src/app/CategoryService";
import { linkedList, type SyncHarness, syncHarness } from "./sync-harness";

// An Undo never leaves a tag under a parent tag that no longer exists (Lists, sections and tags rules 25 and 29). A
// TickTick pull is not an undo step, so it may nest a new tag under a parent that a later Undo would remove: that Undo
// is refused and nothing changes.

async function setup(): Promise<SyncHarness & { listId: string; projectId: string }> {
	const s = await syncHarness();
	const { listId, projectId } = await linkedList(s);
	return Object.assign(s, { listId, projectId });
}

/** Pulls a TickTick task tagged "errands", a TickTick tag nested under "home", so Logwell nests it as `home/errands`. */
async function pullErrandsUnderHome(s: SyncHarness & { projectId: string }): Promise<void> {
	s.tick();
	s.tt.addTag("errands", "Errands", "home");
	s.tt.add(s.projectId, { title: "Buy stamps", tags: ["errands"] });
	const r = await s.sync.sync();
	if (!r.ok) throw new Error("sync failed");
	expect(s.task("Buy stamps").tagKeys).toEqual(["home/errands"]);
}

describe("Undo after a pull that nests a tag under the new parent", () => {
	it("a New tag's Undo is refused while a pulled tag sits under it", async () => {
		const s = await setup();
		const store = s.h.app.store;
		const mark = store.undoMark();
		await s.h.app.tags.add("Home", null, "red");
		await s.sync.sync();
		await pullErrandsUnderHome(s);
		const state = store.state;
		await expect(store.undoFor(mark, CREATE_TAG_LABEL)()).rejects.toMatchObject({
			code: "UndoConflict",
			message: 'Cannot undo "Create tag": a tag now sits under this tag.',
		});
		expect(store.state).toBe(state);
		expect([...store.state.tags.keys()].sort()).toEqual(["home", "home/errands"]);
	});

	it("a Create task that made a parent and child tag: its Undo is refused while a pulled tag sits under the parent", async () => {
		const s = await setup();
		const store = s.h.app.store;
		await s.h.app.tasks.create({ title: "Ring mum", categoryId: s.listId, newTags: ["Home/Calls"] });
		await s.sync.sync();
		await pullErrandsUnderHome(s);
		const state = store.state;
		await expect(store.undo()).rejects.toMatchObject({ code: "UndoConflict", message: 'Cannot undo "Create task": a tag now sits under this tag.' });
		expect(store.state).toBe(state);
		expect([...store.state.tags.keys()].sort()).toEqual(["home", "home/calls", "home/errands"]);
	});

	it("an Undo that removes a parent together with all its children still goes through", async () => {
		const s = await setup();
		await s.h.app.tags.create("Home/Calls");
		expect(await s.h.app.store.undo()).toBe(CREATE_TAG_LABEL);
		expect(s.h.app.store.state.tags.size).toBe(0);
	});
});
