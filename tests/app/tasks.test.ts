import { describe, expect, it } from "vitest";
import { INBOX_ID, syncLinkId } from "../../src/domain/types";
import { rule } from "../domain/recurrence-fixtures";
import { settle } from "../helpers";
import { appHarness, expectDomainError } from "./harness";

describe("tasks (TASK-01..06)", () => {
	it("AS-01 / TASK-01 / B1: a title alone creates one task in Inbox and no note", async () => {
		const h = await appHarness();
		const { task } = await h.app.tasks.create({ title: "Buy milk" });
		expect(task.categoryId).toBe(INBOX_ID);
		expect(task.descriptionNote).toBeNull();
		expect(h.app.store.state.tasks.size).toBe(1);
		expect(h.notes.writes).toEqual([]);
	});

	it("TASK-02: an empty title cannot be saved, on create or edit", async () => {
		const h = await appHarness();
		await expect(h.app.tasks.create({ title: "   " })).rejects.toMatchObject({ code: "TitleRequired" });
		const { task } = await h.app.tasks.create({ title: "Keep me" });
		await expect(h.app.tasks.update(task.id, { title: " " })).rejects.toMatchObject({ code: "TitleRequired" });
		expect(h.app.store.state.tasks.get(task.id)?.title).toBe("Keep me");
	});

	it("TASK-03: every field is editable and modifiedAt updates", async () => {
		const h = await appHarness();
		const study = await h.app.categories.create("Study");
		await h.app.tags.create("learning");
		const { task } = await h.app.tasks.create({ title: "Study" });
		h.clock.advance(60_000);
		const { task: edited } = await h.app.tasks.update(task.id, {
			title: "Study Python",
			categoryId: study.id,
			tagKeys: ["learning"],
			scheduled: { kind: "datetime", local: "2026-10-02T19:00", tz: "Europe/Berlin" },
			deadline: { kind: "date", date: "2026-10-09" },
			plannedDurationMin: 45,
			urgent: true,
			important: true,
		});
		expect(edited).toMatchObject({
			id: task.id,
			title: "Study Python",
			categoryId: study.id,
			tagKeys: ["learning"],
			plannedDurationMin: 45,
			urgent: true,
			important: true,
		});
		expect(edited.modifiedAt > task.modifiedAt).toBe(true);
	});

	it("rejects unknown tags instead of creating them (TAG-02)", async () => {
		const h = await appHarness();
		await expect(h.app.tasks.create({ title: "x", tagKeys: ["nope"] })).rejects.toMatchObject({ code: "NotFound" });
		expect(h.app.store.state.tags.size).toBe(0);
	});

	it("B17: a time in the spring-forward gap is stored adjusted, with a warning", async () => {
		const h = await appHarness();
		const { task, warnings } = await h.app.tasks.create({
			title: "Early",
			scheduled: { kind: "datetime", local: "2026-03-29T02:30", tz: "Europe/Berlin" },
		});
		expect(task.scheduled).toEqual({ kind: "datetime", local: "2026-03-29T03:30", tz: "Europe/Berlin" });
		expect(warnings).toEqual(["dst-gap"]);
	});

	it("TASK-04: complete sets status and completedAt; reopen clears both; the ID stays", async () => {
		const h = await appHarness();
		const { task } = await h.app.tasks.create({ title: "A" });
		await h.app.tasks.complete(task.id);
		const done = h.app.store.state.tasks.get(task.id)!;
		expect(done.status).toBe("completed");
		expect(done.completedAt).not.toBeNull();
		const reopened = await h.app.tasks.reopen(task.id);
		expect(reopened).toMatchObject({ id: task.id, status: "open", completedAt: null });
	});

	it("TASK-06: the ID survives rename, reschedule, move, completion and relink; duplicate gets new IDs", async () => {
		const h = await appHarness();
		const cat = await h.app.categories.create("Work");
		const { task } = await h.app.tasks.create({ title: "A" });
		const sub = (await h.app.tasks.create({ title: "A.1", parentId: task.id })).task;
		await h.app.tasks.update(task.id, { title: "B", scheduled: { kind: "date", date: "2026-10-05" }, categoryId: cat.id });
		await h.app.tasks.complete(task.id, { includeSubtasks: true });
		await h.app.tasks.reopen(task.id);
		await h.app.tasks.linkNote(task.id, "a.md");
		await h.app.tasks.linkNote(task.id, "b.md");
		expect(h.app.store.state.tasks.get(task.id)?.title).toBe("B");
		const copy = await h.app.tasks.duplicate(task.id);
		expect(copy.id).not.toBe(task.id);
		expect(copy.status).toBe("open");
		expect(copy.descriptionNote?.path).toBe("b.md");
		const copySubs = [...h.app.store.state.tasks.values()].filter((t) => t.parentId === copy.id);
		expect(copySubs).toHaveLength(1);
		expect(copySubs[0]!.id).not.toBe(sub.id);
		expect(copySubs[0]!.status).toBe("open");
	});
});

describe("subtasks (SUB-01..07, AS-09)", () => {
	async function parentWithTwo() {
		const h = await appHarness();
		const parent = (await h.app.tasks.create({ title: "Parent" })).task;
		const a = (await h.app.tasks.create({ title: "A", parentId: parent.id })).task;
		const b = (await h.app.tasks.create({ title: "B", parentId: parent.id })).task;
		return { h, parent, a, b };
	}

	it("SUB-03 / B10: completing a parent with open subtasks asks first; cancel changes nothing", async () => {
		const { h, parent } = await parentWithTwo();
		const before = h.app.store.state;
		const result = await h.app.tasks.complete(parent.id);
		expect(result).toEqual({ kind: "needs-confirmation", openSubtasks: 2 });
		expect(h.app.store.state).toBe(before);
		expect(await h.app.tasks.complete(parent.id, { includeSubtasks: true })).toEqual({ kind: "done", completed: 3, label: "Complete task" });
	});

	it("SUB-04 / B11: completing the last subtask leaves the parent open", async () => {
		const { h, parent, a, b } = await parentWithTwo();
		await h.app.tasks.complete(a.id);
		await h.app.tasks.complete(b.id);
		expect(h.app.store.state.tasks.get(parent.id)?.status).toBe("open");
	});

	it("SUB-05: reopening the parent leaves completed subtasks completed", async () => {
		const { h, parent, a } = await parentWithTwo();
		await h.app.tasks.complete(parent.id, { includeSubtasks: true });
		await h.app.tasks.reopen(parent.id);
		expect(h.app.store.state.tasks.get(a.id)?.status).toBe("completed");
	});

	it("SUB-02 / B12: moving the parent moves its subtasks in one write and one undo", async () => {
		const { h, parent, a, b } = await parentWithTwo();
		const cat = await h.app.categories.create("Study");
		await h.app.tasks.update(parent.id, { categoryId: cat.id });
		for (const id of [parent.id, a.id, b.id]) expect(h.app.store.state.tasks.get(id)?.categoryId).toBe(cat.id);
		await h.app.store.undo();
		for (const id of [parent.id, a.id, b.id]) expect(h.app.store.state.tasks.get(id)?.categoryId).toBe(INBOX_ID);
	});

	it("SUB-02: a subtask's category cannot be set on its own and follows its parent on creation", async () => {
		const { h, a } = await parentWithTwo();
		const cat = await h.app.categories.create("Study");
		await expect(h.app.tasks.update(a.id, { categoryId: cat.id })).rejects.toMatchObject({ code: "SubtaskCategory" });
	});

	it("SUB-01 / B13: no second level, and a parent cannot become a subtask", async () => {
		const { h, parent, a } = await parentWithTwo();
		await expect(h.app.tasks.create({ title: "deep", parentId: a.id })).rejects.toThrow(
			"Only one subtask level is supported",
		);
		const other = (await h.app.tasks.create({ title: "Other" })).task;
		await expect(h.app.tasks.setParent(parent.id, other.id)).rejects.toThrow("Only one subtask level is supported");
		const moved = await h.app.tasks.setParent(other.id, parent.id);
		expect(moved.parentId).toBe(parent.id);
	});

	it("#136: the delete prompts' counts (subtasks, a list's tasks) follow completions, moves and undo", async () => {
		const { h, parent, a, b } = await parentWithTwo();
		await h.app.tasks.complete(a.id);
		expect(h.app.tasks.subtaskCount(parent.id)).toBe(2);
		const other = (await h.app.tasks.create({ title: "Other" })).task;
		await h.app.tasks.setParent(other.id, parent.id);
		expect(h.app.tasks.subtaskCount(parent.id)).toBe(3);
		await h.app.store.undo();
		expect(h.app.tasks.subtaskCount(parent.id)).toBe(2);
		await h.app.tasks.delete(b.id);
		expect(h.app.tasks.subtaskCount(parent.id)).toBe(1);
		expect(h.app.tasks.subtaskCount(other.id)).toBe(0);
		const list = await h.app.categories.create("Study");
		expect(h.app.categories.taskCount(list.id)).toBe(0);
		await h.app.tasks.update(parent.id, { categoryId: list.id });
		// The parent and its remaining subtask moved together; completed tasks count too.
		expect(h.app.categories.taskCount(list.id)).toBe(2);
		expect(h.app.categories.taskCount(INBOX_ID)).toBe(1);
	});

	it("SUB-06: deleting a parent trashes its subtasks; restore brings them back together", async () => {
		const { h, parent, a, b } = await parentWithTwo();
		expect(h.app.tasks.subtaskCount(parent.id)).toBe(2);
		const entry = await h.app.tasks.delete(parent.id);
		expect(entry.tasks.map((t) => t.id)).toEqual([parent.id, a.id, b.id]);
		expect(h.app.store.state.tasks.size).toBe(0);
		expect(await h.app.tasks.restore(entry.batchId)).toBe(3);
		expect(h.app.store.state.tasks.get(a.id)?.parentId).toBe(parent.id);
		expect(h.app.store.state.trash.size).toBe(0);
	});
});

describe("trash and undo (TASK-05)", () => {
	const dailyRule = rule();
	it("delete can be undone, then purge removes records but never notes (AS-05, NOTE-08)", async () => {
		const h = await appHarness();
		h.notes.files.set("Plan v2.md", "body text");
		const { task } = await h.app.tasks.create({ title: "Plan", notePath: "Plan v2.md" });
		const mark = h.app.store.undoMark();
		await h.app.tasks.delete(task.id);
		expect(await h.app.store.undoFor(mark, "Delete task")()).toBe(true);
		expect(h.app.store.state.tasks.has(task.id)).toBe(true);
		const entry = await h.app.tasks.delete(task.id);
		await h.app.tasks.purge(entry.batchId);
		expect(h.app.store.state.trash.size).toBe(0);
		expect(h.notes.files.get("Plan v2.md")).toBe("body text");
		expect(h.notes.writes).toEqual([]);
	});

	it("purges entries older than 30 days only", async () => {
		const h = await appHarness();
		const a = (await h.app.tasks.create({ title: "Old" })).task;
		await h.app.tasks.delete(a.id);
		h.clock.advance(29 * 24 * 3600 * 1000);
		const b = (await h.app.tasks.create({ title: "New" })).task;
		await h.app.tasks.delete(b.id);
		expect(await h.app.tasks.purgeExpired()).toBe(0);
		h.clock.advance(2 * 24 * 3600 * 1000);
		expect(await h.app.tasks.purgeExpired()).toBe(1);
		expect(h.app.store.state.trash.size).toBe(1);
	});

	it("#138: a restore and a new delete queued before the hourly purge leave the task's history and TickTick link alone", async () => {
		const h = await appHarness();
		const { task } = await h.app.tasks.create({ title: "Stretch", scheduled: { kind: "date", date: "2026-10-01" }, repeat: { rule: dailyRule } });
		await h.app.tasks.complete(task.id);
		const link = { kind: "task" as const, logwellId: task.id, ttId: "tt-1", ttProjectId: "p-1", etag: "e1", base: { title: "x" }, noteBySync: false, lastPulledAt: null, modifiedAt: "2026-10-01T10:00:00.000Z" };
		await h.app.store.run("Test setup", (tx) => tx.put("syncLinks", link), { undoable: false });
		const history = [...h.app.store.state.occurrenceRecords.values()];
		expect(history).toHaveLength(1);
		const old = await h.app.tasks.delete(task.id);
		h.clock.advance(31 * 24 * 3600 * 1000);
		// Queued in this order: the purge reads the Trash after the other two are queued but before they run.
		const restored = h.app.tasks.restore(old.batchId);
		const deleted = h.app.tasks.delete(task.id);
		const purged = h.app.tasks.purgeExpired();
		await restored;
		const again = await deleted;
		expect(await purged).toBe(0);
		expect([...h.app.store.state.trash.keys()]).toEqual([again.batchId]);
		expect([...h.app.store.state.occurrenceRecords.values()]).toEqual(history);
		expect(h.app.store.state.syncLinks.get(syncLinkId("task", task.id))?.pendingDelete).toBeUndefined();
		// Restored from the new entry, the task comes back with its history.
		await h.app.tasks.restore(again.batchId);
		expect(h.app.store.state.tasks.get(task.id)?.recurrence).not.toBeNull();
		expect([...h.app.store.state.occurrenceRecords.values()]).toEqual(history);
	});

	it("one undo reverts only the newest edit; a note-path rewrite that matched no task is no undo step", async () => {
		const h = await appHarness();
		const { task } = await h.app.tasks.create({ title: "A" });
		await h.app.tasks.update(task.id, { title: "B" });
		await h.app.noteRenames.rewriteNotePaths("x", "y", false);
		await h.app.tasks.update(task.id, { urgent: true });
		await h.app.store.undo();
		expect(h.app.store.state.tasks.get(task.id)?.urgent).toBe(false);
		expect(h.app.store.state.tasks.get(task.id)?.title).toBe("B");
	});

	it("a restored subtask whose parent is gone becomes top-level in Inbox", async () => {
		const h = await appHarness();
		const cat = await h.app.categories.create("Work");
		const parent = (await h.app.tasks.create({ title: "P", categoryId: cat.id })).task;
		const sub = (await h.app.tasks.create({ title: "S", parentId: parent.id })).task;
		const subEntry = await h.app.tasks.delete(sub.id);
		await h.app.tasks.delete(parent.id);
		await h.app.categories.delete(cat.id);
		await h.app.tasks.restore(subEntry.batchId);
		expect(h.app.store.state.tasks.get(sub.id)).toMatchObject({ parentId: null, categoryId: INBOX_ID });
	});

	it("rejects all commands while read-only", async () => {
		const h = await appHarness();
		h.fs.files.set("Checkpoint.cpbase", "{broken");
		await h.store.handleExternalChange();
		await settle();
		await expectDomainError(h.app.tasks.create({ title: "x" }), "ReadOnly");
	});
});
