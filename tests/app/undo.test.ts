import { describe, expect, it } from "vitest";
import { appHarness, makeReadOnly } from "./harness";
import type { AppStore } from "../../src/app/store";
import { type Change, Tx } from "../../src/app/tx";
import { makeTask } from "../persistence/fixtures";
import { CREATE_TAG_LABEL, EDIT_TAG_LABEL } from "../../src/app/CategoryService";
import { linkedList, type SyncHarness, syncHarness } from "./sync-harness";
import { INBOX_ID, syncLinkId } from "../../src/domain/types";

// A refusal while read-only keeps the undo entry; a conflict drops it, since the
// record can never match again, and the next undo takes the one before it.

describe("#14: a refused undo and its entry", () => {
	it("keeps the entry when the database is read-only, however often Undo is pressed", async () => {
		const h = await appHarness();
		await h.app.tasks.create({ title: "Call the bank" });
		await makeReadOnly(h);
		const store = h.app.store;
		await expect(store.undo()).rejects.toMatchObject({ code: "ReadOnly" });
		await expect(store.undo()).rejects.toMatchObject({ code: "ReadOnly" });
		expect(store.canUndo).toBe(true);
		expect(store.undoLabel).toBe("Create task");
	});

	it("keeps the entry when a notice's Undo is refused while read-only", async () => {
		const h = await appHarness();
		const store = h.app.store;
		const mark = store.undoMark();
		await h.app.tasks.create({ title: "Call the bank" });
		const undo = store.undoFor(mark, "Create task");
		await makeReadOnly(h);
		await expect(undo()).rejects.toMatchObject({ code: "ReadOnly" });
		expect(store.canUndo).toBe(true);
		expect(store.undoLabel).toBe("Create task");
	});

	it("resolves null for an empty history, also while read-only", async () => {
		const h = await appHarness();
		await makeReadOnly(h);
		await expect(h.app.store.undo()).resolves.toBeNull();
	});

	it("drops the entry on a conflict, so the next undo takes the one before it", async () => {
		const h = await appHarness();
		const store = h.app.store;
		const { task } = await h.app.tasks.create({ title: "Call the bank" });
		await h.app.tasks.update(task.id, { title: "Call the bank today" });
		// A write that is not a user action (no undo entry) replaces the record.
		await store.run(
			"Maintenance",
			(tx) => {
				const t = tx.get("tasks", task.id)!;
				tx.put("tasks", { ...t, title: "Changed outside" });
			},
			{ undoable: false },
		);
		await expect(store.undo()).rejects.toMatchObject({ code: "UndoConflict" });
		expect(store.state.tasks.get(task.id)?.title).toBe("Changed outside");
		expect(store.undoLabel).toBe("Create task");
	});
});

describe("#39: a notice's Undo targets its own write", () => {
	// The Undo button of a notice undoes exactly the write it was shown for, never a newer
	// write that happens to run under the same store label.

	const CONFLICT = 'Cannot undo "Edit task": other changes were made since.';
	const UNBOUND = 'Cannot undo "Edit task": this change can no longer be undone here.';

	/** What a notice does: take the mark right before the write, bind its Undo right after. */
	async function noticeFor(store: AppStore, label: string, write: () => Promise<unknown>): Promise<() => Promise<boolean>> {
		const mark = store.undoMark();
		await write();
		return store.undoFor(mark, label);
	}

	async function twoTasks() {
		const h = await appHarness();
		const a = (await h.app.tasks.create({ title: "Call the bank" })).task;
		const b = (await h.app.tasks.create({ title: "Water the plants" })).task;
		const title = (id: string) => h.app.store.state.tasks.get(id)?.title;
		return { h, store: h.app.store, a, b, title };
	}

	it("refuses the first notice once a newer write ran under the same label, and undoes the newer one from its own notice", async () => {
		const { h, store, a, b, title } = await twoTasks();
		const undoFirst = await noticeFor(store, "Edit task", () => h.app.tasks.update(a.id, { title: "Call the bank today" }));
		const undoSecond = await noticeFor(store, "Edit task", () => h.app.tasks.update(b.id, { title: "Water the herbs" }));

		await expect(undoFirst()).rejects.toMatchObject({ code: "UndoConflict", message: CONFLICT });
		expect(title(a.id)).toBe("Call the bank today");
		expect(title(b.id)).toBe("Water the herbs");

		await expect(undoSecond()).resolves.toBe(true);
		expect(title(b.id)).toBe("Water the plants");
		expect(title(a.id)).toBe("Call the bank today");
	});

	it("checks inside the queue: an Undo queued behind a same-label command does not revert that command", async () => {
		const { h, store, a, b, title } = await twoTasks();
		const undoFirst = await noticeFor(store, "Edit task", () => h.app.tasks.update(a.id, { title: "Call the bank today" }));
		// The second write is queued, not yet run, when the Undo is pressed.
		const second = h.app.tasks.update(b.id, { title: "Water the herbs" });
		const undo = undoFirst();
		await second;
		await expect(undo).rejects.toMatchObject({ code: "UndoConflict" });
		expect(title(a.id)).toBe("Call the bank today");
		expect(title(b.id)).toBe("Water the herbs");
	});

	it("refuses when a same-label write ran between the write and its notice", async () => {
		const { h, store, a, b, title } = await twoTasks();
		const mark = store.undoMark();
		const first = h.app.tasks.update(a.id, { title: "Call the bank today" });
		const second = h.app.tasks.update(b.id, { title: "Water the herbs" });
		await Promise.all([first, second]);
		// The first write's notice shows only now, after the second write ran: two writes under its label.
		await expect(store.undoFor(mark, "Edit task")()).rejects.toMatchObject({ code: "UndoConflict", message: UNBOUND });
		expect(title(a.id)).toBe("Call the bank today");
		expect(title(b.id)).toBe("Water the herbs");
	});

	it("says the change can no longer be undone once its entry left the history (global Undo, reload)", async () => {
		const { h, store, a, title } = await twoTasks();
		const undoEdit = await noticeFor(store, "Edit task", () => h.app.tasks.update(a.id, { title: "Call the bank today" }));
		await store.undo();
		await expect(undoEdit()).rejects.toMatchObject({ code: "UndoConflict", message: UNBOUND });
		expect(title(a.id)).toBe("Call the bank");

		const undoAgain = await noticeFor(store, "Edit task", () => h.app.tasks.update(a.id, { title: "Call the bank now" }));
		store.notifyReloaded();
		await expect(undoAgain()).rejects.toMatchObject({ code: "UndoConflict", message: UNBOUND });
		expect(title(a.id)).toBe("Call the bank now");
	});

	it("a write under another label between the mark and the write does not stop the Undo", async () => {
		const { h, store, a, b, title } = await twoTasks();
		const mark = store.undoMark();
		// The write waits (for example behind a running sync) while another change is made.
		await h.app.tasks.delete(b.id);
		await h.app.tasks.update(a.id, { title: "Call the bank today" });
		await expect(store.undoFor(mark, "Edit task")()).resolves.toBe(true);
		expect(title(a.id)).toBe("Call the bank");
		expect(title(b.id)).toBeUndefined();
	});

	it("counts a same-label write that was already undone: the notice binds nothing", async () => {
		const { h, store, a, b, title } = await twoTasks();
		const mark = store.undoMark();
		await h.app.tasks.update(a.id, { title: "Call the bank today" });
		await store.undo();
		await h.app.tasks.update(b.id, { title: "Water the herbs" });
		await expect(store.undoFor(mark, "Edit task")()).rejects.toMatchObject({ code: "UndoConflict", message: UNBOUND });
		expect(title(a.id)).toBe("Call the bank");
		expect(title(b.id)).toBe("Water the herbs");
	});

	it("binds nothing when the mark is older than the remembered writes", async () => {
		const { h, store, a, title } = await twoTasks();
		const mark = store.undoMark();
		for (let i = 0; i < 50; i++) await h.app.tasks.create({ title: `Errand ${i}` });
		await h.app.tasks.update(a.id, { title: "Call the bank today" });
		await expect(store.undoFor(mark, "Edit task")()).rejects.toMatchObject({ code: "UndoConflict", message: UNBOUND });
		expect(title(a.id)).toBe("Call the bank today");
	});
});

// The sync calls `tx.finish()` inside its command to learn whether the pull wrote anything. That call must
// have no side effects: the base state, later writes and the store's own commit are unchanged by it.

describe("Tx.finish is pure", () => {
	it("returns the same result twice and leaves the base untouched", async () => {
		const h = await appHarness();
		const base = h.app.store.state;
		const tx = new Tx(base, "2026-10-01T10:00:00.000Z");
		tx.put("tasks", makeTask("t1"));
		const a = tx.finish();
		const b = tx.finish();
		expect(b.ops).toEqual(a.ops);
		expect(b.changes).toEqual(a.changes);
		expect(base.tasks.has("t1")).toBe(false);
		// Writes after it still count.
		tx.put("tasks", makeTask("t2"));
		expect(tx.finish().ops.map((o) => o.id).sort()).toEqual(["t1", "t2"]);
	});

	it("does not change what the store commits, undoes or emits", async () => {
		const run = async (peek: boolean) => {
			const h = await appHarness();
			const events: (readonly Change[] | undefined)[] = [];
			h.app.store.bus.on("changed", (e) => events.push(e.changes));
			await h.app.store.run("Probe", (tx) => {
				tx.put("tasks", makeTask("t1"));
				if (peek) expect(tx.finish().ops).toHaveLength(1);
				tx.put("tasks", makeTask("t2", { title: "Second" }));
			});
			return { tasks: [...h.app.store.state.tasks.keys()].sort(), undo: h.app.store.undoLabel, events: events.map((c) => c?.map((x) => x.id).sort()) };
		};
		expect(await run(true)).toEqual(await run(false));
	});
});

describe("the reference guard", () => {
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
});

/** A linked list "Work", for the Undo tests after a pull. */
async function setup(): Promise<SyncHarness & { listId: string; projectId: string }> {
	const s = await syncHarness();
	const { listId, projectId } = await linkedList(s);
	return Object.assign(s, { listId, projectId });
}

describe("after a pull that uses the tag", () => {
	// An Undo never leaves a task holding a tag key with no tag. A
	// TickTick pull is not an undo step, so a task it brings in may use a tag that a later Undo would remove: that Undo is
	// refused, nothing changes, and the entry is dropped, so the next Undo takes the one below.

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
			expect(below).toBe("Create list");
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
});

describe("after a pull that nests a tag", () => {
	// An Undo never leaves a tag under a parent tag that no longer exists. A
	// TickTick pull is not an undo step, so it may nest a new tag under a parent that a later Undo would remove: that Undo
	// is refused and nothing changes.

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
	});
});

describe("after a pull that uses the list or section", () => {
	// An Undo never leaves a task in a list or section that is gone, nor a section in a removed list. A task or section a
	// TickTick pull brings in is not an undo step: the Undo of the list or section it landed in is refused, nothing
	// changes, and the next Undo takes the entry below. A list link the sync wrote is no reason to refuse: the next sync
	// drops a link whose list is gone.

	async function pull(s: SyncHarness): Promise<void> {
		s.tick();
		const r = await s.sync.sync();
		if (!r.ok) throw new Error("sync failed");
	}

	/** A new list "Errands" linked to its own project, its "Create list" on top of the undo history. */
	async function newList(s: SyncHarness): Promise<{ listId: string; projectId: string }> {
		const linked = await linkedList(s, "Errands");
		expect(s.h.app.store.undoLabel).toBe("Create list");
		return linked;
	}

	/** A new section "Planning" in the linked list "Work", its "Create section" on top of the undo history. */
	async function newSection(s: SyncHarness & { listId: string }): Promise<string> {
		const section = await s.h.app.sections.create(s.listId, "Planning");
		expect(s.h.app.store.undoLabel).toBe("Create section");
		return section.id;
	}

	it.each([
		{
			name: "a pulled task in the new list refuses its Create list",
			label: "Create list",
			problem: "a task now uses this list.",
			arrange: async (s: SyncHarness & { listId: string; projectId: string }) => {
				const { listId, projectId } = await newList(s);
				s.tt.add(projectId, { title: "Buy stamps" });
				await pull(s);
				expect(s.task("Buy stamps").categoryId).toBe(listId);
			},
		},
		{
			name: "a pulled section in the new list refuses its Create list",
			label: "Create list",
			problem: "a section now sits in this list.",
			arrange: async (s: SyncHarness & { listId: string; projectId: string }) => {
				const { listId, projectId } = await newList(s);
				s.tt.addColumn(projectId, "Later");
				await pull(s);
				expect(s.h.app.sections.inList(listId).map((x) => x.name)).toEqual(["Later"]);
			},
		},
		{
			name: "a pulled task in the new section refuses its Create section",
			label: "Create section",
			problem: "a task now uses this section.",
			arrange: async (s: SyncHarness & { listId: string; projectId: string }) => {
				const sectionId = await newSection(s);
				const column = s.tt.addColumn(s.projectId, "Planning");
				s.tt.add(s.projectId, { title: "Draft the plan", columnId: column.id });
				await pull(s);
				expect(s.task("Draft the plan").sectionId).toBe(sectionId);
			},
		},
	])("#72: $name; nothing changes and the entry below is next", async ({ label, problem, arrange }) => {
		const s = await setup();
		const store = s.h.app.store;
		const below = store.undoLabel;
		await arrange(s);
		const state = store.state;
		await expect(store.undo()).rejects.toMatchObject({ code: "UndoConflict", message: `Cannot undo "${label}": ${problem}` });
		expect(store.state).toBe(state);
		expect(store.undoLabel).toBe(below);
	});

	it("#72: a task the pull moved to the Trash does not refuse the Create list; restored, it goes to Inbox", async () => {
		const s = await setup();
		const { listId } = await newList(s);
		await s.h.app.store.run("Outside", (tx) => tx.put("trash", { batchId: "b-out", deletedAt: tx.now, tasks: [makeTask("t-trash", { categoryId: listId })] }), { undoable: false });
		expect(await s.h.app.store.undo()).toBe("Create list");
		expect(s.h.app.store.state.categories.has(listId)).toBe(false);
		await s.h.app.tasks.restore("b-out");
		expect(s.h.app.store.state.tasks.get("t-trash")?.categoryId).toBe(INBOX_ID);
	});

	it("#72: with nothing pulled into it, a synced list's Create list is undone and the next sync drops its link", async () => {
		const s = await setup();
		const { listId } = await newList(s);
		expect(await s.h.app.store.undo()).toBe("Create list");
		expect(s.h.app.store.state.categories.has(listId)).toBe(false);
		await pull(s);
		expect(s.h.app.store.state.syncLinks.has(syncLinkId("list", listId))).toBe(false);
	});
});
