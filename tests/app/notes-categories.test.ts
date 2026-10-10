import { describe, expect, it } from "vitest";
import { INBOX_ID } from "../../src/domain/types";
import { readHeader } from "../../src/persistence/serializer";
import { settle } from "../helpers";
import { DB_PATH } from "../persistence/fixtures";
import { appHarness, makeReadOnly, waitFor } from "./harness";

describe("description notes (NOTE-01..10)", () => {
	it("AS-02 / NOTE-03: storage holds the path and link time, never the note text", async () => {
		const h = await appHarness();
		h.notes.files.set("Plan.md", "SECRET-BODY-TEXT with checklist\n- [ ] not a subtask");
		const { task } = await h.app.tasks.create({ title: "Plan things" });
		await h.app.tasks.linkNote(task.id, "Plan.md");
		await h.saveNow();
		const file = h.dbText();
		expect(file).toContain('"path":"Plan.md"');
		expect(file).not.toContain("SECRET-BODY-TEXT");
		// Checkboxes in the note never become subtasks.
		expect(h.app.store.state.tasks.size).toBe(1);
		for (const path of h.fs.files.keys()) expect(h.fs.files.get(path)).not.toContain("SECRET-BODY-TEXT");
	});

	it("NOTE-02 / B45: create names the note from the sanitized title and avoids collisions", async () => {
		const h = await appHarness();
		h.notes.files.set("Task notes/Plan ab.md", "existing");
		const { task } = await h.app.tasks.create({ title: "Plan: a/b" });
		const path = await h.app.tasks.createDescriptionNote(task.id);
		expect(path).toBe("Task notes/Plan ab (2).md");
		expect(h.notes.files.get("Task notes/Plan ab.md")).toBe("existing");
		expect(h.app.store.state.tasks.get(task.id)?.descriptionNote?.path).toBe(path);
	});

	it("AS-04 / NOTE-06 / NOTE-10: renames update references; renaming the task never renames the note", async () => {
		const h = await appHarness();
		h.notes.files.set("Plan.md", "");
		const { task } = await h.app.tasks.create({ title: "Plan", notePath: "Plan.md" });
		await h.app.tasks.update(task.id, { title: "Renamed" });
		expect(h.app.store.state.tasks.get(task.id)?.descriptionNote?.path).toBe("Plan.md");
		expect(await h.app.tasks.rewriteNotePaths("Plan.md", "Plan v2.md", false)).toBe(1);
		// Idempotent: the duplicate event of a folder rename is harmless.
		expect(await h.app.tasks.rewriteNotePaths("Plan.md", "Plan v2.md", false)).toBe(0);
		const t = h.app.store.state.tasks.get(task.id)!;
		expect(t.id).toBe(task.id);
		expect(t.descriptionNote?.path).toBe("Plan v2.md");
	});

	it("NOTE-06: a folder rename rewrites every reference by prefix, including trashed tasks", async () => {
		const h = await appHarness();
		const a = (await h.app.tasks.create({ title: "A", notePath: "Notes/a.md" })).task;
		const b = (await h.app.tasks.create({ title: "B", notePath: "Notes/sub/b.md" })).task;
		await h.app.tasks.delete(b.id);
		await h.app.tasks.rewriteNotePaths("Notes", "Archive/Notes", true);
		expect(h.app.store.state.tasks.get(a.id)?.descriptionNote?.path).toBe("Archive/Notes/a.md");
		const trashed = [...h.app.store.state.trash.values()][0]!.tasks[0]!;
		expect(trashed.descriptionNote?.path).toBe("Archive/Notes/sub/b.md");
	});

	it("NOTE-06 / review #8: renames that arrive while read-only are replayed in order once writable", async () => {
		const h = await appHarness();
		const { task } = await h.app.tasks.create({ title: "Plan", notePath: "Notes/Plan.md" });
		await h.saveNow();
		const saved = h.dbText();
		await makeReadOnly(h);
		// A file rename, then a rename of its folder. Neither event comes again.
		expect(await h.app.tasks.rewriteNotePaths("Notes/Plan.md", "Notes/Plan v2.md", false)).toBe(0);
		expect(await h.app.tasks.rewriteNotePaths("Notes", "Archive", true)).toBe(0);
		expect(h.app.store.state.tasks.get(task.id)?.descriptionNote?.path).toBe("Notes/Plan.md");

		// The file is repaired outside Obsidian (another revision of the same database).
		const revision = readHeader(saved)!.revision;
		h.fs.files.set(DB_PATH, saved.replace(`"revision":"${revision}"`, '"revision":"r-repaired0001"'));
		await h.store.handleExternalChange();
		expect(h.app.store.readOnlyState).toBeNull();
		h.app.store.notifyStatus(); // DbSession does this on the store's "writable" event.
		await waitFor(() => h.app.store.state.tasks.get(task.id)?.descriptionNote?.path === "Archive/Plan v2.md");

		// Replaying is idempotent: a second status event changes nothing.
		const before = h.app.store.state;
		h.app.store.notifyStatus();
		await settle();
		expect(h.app.store.state).toBe(before);
	});

	it("review #17: no note is created while read-only or for a missing task", async () => {
		const h = await appHarness();
		const { task } = await h.app.tasks.create({ title: "Plan" });
		await expect(h.app.tasks.createDescriptionNote("missing")).rejects.toMatchObject({ code: "NotFound" });
		await makeReadOnly(h);
		await expect(h.app.tasks.createDescriptionNote(task.id)).rejects.toMatchObject({ code: "ReadOnly" });
		expect(h.notes.writes).toEqual([]);
	});

	it("AS-06 / NOTE-07 / NOTE-08: unlink leaves the file; a missing note does not block the task", async () => {
		const h = await appHarness();
		h.notes.files.set("Shared.md", "x");
		const a = (await h.app.tasks.create({ title: "A", notePath: "Shared.md" })).task;
		const b = (await h.app.tasks.create({ title: "B", notePath: "Shared.md" })).task;
		// Shared notes are shown as "Also linked from".
		expect(h.app.tasks.alsoLinkedFrom(a.id).map((t) => t.id)).toEqual([b.id]);
		await h.app.tasks.unlinkNote(a.id);
		expect(h.notes.files.has("Shared.md")).toBe(true);
		h.notes.files.delete("Shared.md");
		expect(h.app.tasks.noteExists("Shared.md")).toBe(false);
		await h.app.tasks.complete(b.id);
		expect(h.app.store.state.tasks.get(b.id)?.status).toBe("completed");
		expect(h.app.store.state.tasks.get(b.id)?.descriptionNote?.path).toBe("Shared.md");
	});

	it("NOTE-07: suggests a relink only when exactly one note has the same basename", async () => {
		const h = await appHarness();
		const { task } = await h.app.tasks.create({ title: "A", notePath: "Old/Plan.md" });
		h.notes.files.set("New/Plan.md", "");
		expect(h.app.tasks.relinkSuggestion(task.id)).toBe("New/Plan.md");
		h.notes.files.set("Other/Plan.md", "");
		expect(h.app.tasks.relinkSuggestion(task.id)).toBeNull();
	});
});

describe("categories (CAT-01..07)", () => {
	it("CAT-01 / B15: Inbox cannot be deleted but can be renamed", async () => {
		const h = await appHarness();
		await expect(h.app.categories.delete(INBOX_ID)).rejects.toMatchObject({ code: "InboxProtected" });
		await h.app.categories.update(INBOX_ID, { name: "Capture" });
		expect(h.app.store.state.categories.get(INBOX_ID)?.name).toBe("Capture");
	});

	it("CAT-03: names are unique case-insensitively", async () => {
		const h = await appHarness();
		await h.app.categories.create("Study");
		await expect(h.app.categories.create("study")).rejects.toMatchObject({ code: "DuplicateCategoryName" });
		await expect(h.app.categories.create("  ")).rejects.toMatchObject({ code: "CategoryNameRequired" });
	});

	it("CAT-05: rename keeps the ID and the membership", async () => {
		const h = await appHarness();
		const cat = await h.app.categories.create("Study", "📖");
		const { task } = await h.app.tasks.create({ title: "x", categoryId: cat.id });
		await h.app.categories.update(cat.id, { name: "Learning" });
		expect(h.app.store.state.tasks.get(task.id)?.categoryId).toBe(cat.id);
		expect(h.app.store.state.categories.get(cat.id)?.name).toBe("Learning");
	});

	it("CAT-06 / B14: delete moves the tasks to Inbox; undo restores the category and memberships", async () => {
		const h = await appHarness();
		const cat = await h.app.categories.create("Study");
		const t1 = (await h.app.tasks.create({ title: "1", categoryId: cat.id })).task;
		const t2 = (await h.app.tasks.create({ title: "2", categoryId: cat.id })).task;
		await h.app.tasks.complete(t2.id);
		expect(h.app.categories.taskCount(cat.id)).toBe(2);
		expect(await h.app.categories.delete(cat.id)).toBe(2);
		expect(h.app.store.state.tasks.get(t1.id)?.categoryId).toBe(INBOX_ID);
		await h.app.store.undo();
		expect(h.app.store.state.categories.get(cat.id)?.name).toBe("Study");
		expect(h.app.store.state.tasks.get(t1.id)?.categoryId).toBe(cat.id);
		expect(h.app.store.state.tasks.get(t2.id)?.categoryId).toBe(cat.id);
	});

	it("reorders categories", async () => {
		const h = await appHarness();
		const a = await h.app.categories.create("A");
		const b = await h.app.categories.create("B");
		await h.app.categories.move(b.id, -1);
		expect(h.app.categories.list().map((c) => c.name)).toEqual(["Inbox", "B", "A"]);
		await h.app.categories.move(b.id, -1);
		expect(h.app.categories.list().map((c) => c.name)).toEqual(["B", "Inbox", "A"]);
		expect(a.id).toBeDefined();
	});
});

describe("tags (TAG-01..04)", () => {
	it("B16: @Learning resolves to the existing learning tag; display name comes from the first creation", async () => {
		const h = await appHarness();
		const first = await h.app.tags.create("Learning");
		const again = await h.app.tags.create("@learning");
		expect(again).toBe(first);
		expect(first.displayName).toBe("Learning");
		expect(h.app.store.state.tags.size).toBe(1);
		expect(h.app.tags.resolve("LEARNING")).toBe("learning");
	});

	it("TAG-01: a task stores a set of tag keys; delete removes the key everywhere", async () => {
		const h = await appHarness();
		await h.app.tags.create("a");
		await h.app.tags.create("b");
		const { task } = await h.app.tasks.create({ title: "x", tagKeys: ["a", "b", "a"] });
		expect(task.tagKeys).toEqual(["a", "b"]);
		expect(await h.app.tags.delete("a")).toEqual({ wrote: true, label: "Delete tag", tasks: 1 });
		expect(h.app.store.state.tasks.get(task.id)?.tagKeys).toEqual(["b"]);
	});

	it("review #9: deleting a tag also strips it from tasks in Trash", async () => {
		const h = await appHarness();
		await h.app.tags.create("a");
		await h.app.tags.create("b");
		const { task } = await h.app.tasks.create({ title: "x", tagKeys: ["a", "b"] });
		const entry = await h.app.tasks.delete(task.id);
		await h.app.tags.delete("a");
		expect(h.app.store.state.trash.get(entry.batchId)?.tasks[0]?.tagKeys).toEqual(["b"]);
		await h.app.tasks.restore(entry.batchId);
		expect(h.app.store.state.tasks.get(task.id)?.tagKeys).toEqual(["b"]);
		// Later tag edits work on the restored task.
		await h.app.tasks.update(task.id, { tagKeys: [] });
		expect(h.app.store.state.tasks.get(task.id)?.tagKeys).toEqual([]);
	});

	it("review #9: restore drops tag keys that no longer exist", async () => {
		const h = await appHarness();
		await h.app.tags.create("b");
		const { task } = await h.app.tasks.create({ title: "x", tagKeys: ["b"] });
		const entry = await h.app.tasks.delete(task.id);
		// A trash entry that still names a deleted tag (an older version or a merge import).
		const data = h.store.data;
		const ghost = { ...entry, tasks: [{ ...entry.tasks[0]!, tagKeys: ["ghost", "b"] }] };
		const trash = new Map(data.trash);
		trash.set(entry.batchId, ghost);
		h.store.commit({ ...data, trash }, [{ c: "trash", id: entry.batchId, v: ghost }]);
		await h.app.tasks.restore(entry.batchId);
		expect(h.app.store.state.tasks.get(task.id)?.tagKeys).toEqual(["b"]);
	});
});
