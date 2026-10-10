import { describe, expect, it } from "vitest";
import { syncLinkId } from "../../src/domain/types";
import { linkedList, type SyncHarness, syncHarness } from "./sync-harness";

// Edits both ways, the per-field merge, conflicts, completion, moves, sections, subtasks and
// what never syncs.

const WEEKLY = { rule: { freq: "weekly" as const, interval: 1, weekdays: null, monthly: null, afterCompletion: false, time: null, tz: null } };

/** A linked list holding one synced task "Call the bank". */
async function oneTask(): Promise<SyncHarness & { listId: string; projectId: string; id: string; ttId: string }> {
	const s = await syncHarness();
	const { listId, projectId } = await linkedList(s);
	const { task } = await s.h.app.tasks.create({ title: "Call the bank", categoryId: listId });
	await s.sync.sync();
	s.tick();
	return Object.assign(s, { listId, projectId, id: task.id, ttId: s.ttIdOf("Call the bank") });
}

const pushes = (s: SyncHarness) => s.tt.count("batchTasks") + s.tt.count("updateTask") + s.tt.count("createTask");

describe("edits (SYNC-07)", () => {
	it("pulls a TickTick edit without an undo entry and without touching the link of other tasks", async () => {
		const s = await oneTask();
		s.tt.edit(s.ttId, { title: "Call the bank today", priority: 3 });
		const undoBefore = s.h.app.store.undoLabel;
		const before = pushes(s);
		const r = await s.sync.sync();
		expect(r.ok).toBe(true);
		expect(s.h.app.store.state.tasks.get(s.id)).toMatchObject({ title: "Call the bank today", priority: 2 });
		expect(s.h.app.store.undoLabel).toBe(undoBefore);
		expect(pushes(s)).toBe(before);
		expect(s.link("task", s.id)?.etag).toBe(s.tt.get(s.ttId)?.etag);
	});

	it("pushes a Logwell edit as a partial batch update; the task record is not touched by bookkeeping", async () => {
		const s = await oneTask();
		await s.h.app.tasks.update(s.id, { priority: 1, deadline: { kind: "date", date: "2026-10-09" } });
		const record = s.h.app.store.state.tasks.get(s.id);
		await s.sync.sync();
		expect(s.tt.get(s.ttId)).toMatchObject({ priority: 5, isAllDay: true, dueDate: "2026-10-09T00:00:00+0200" });
		expect(s.tt.count("batchTasks")).toBe(1);
		expect(s.h.app.store.state.tasks.get(s.id)).toBe(record);
		expect(s.link("task", s.id)?.etag).toBe(s.tt.get(s.ttId)?.etag);
		// Nothing left to do.
		const n = pushes(s);
		s.tick();
		await s.sync.sync();
		expect(pushes(s)).toBe(n);
	});

	it("merges different fields changed on both sides", async () => {
		const s = await oneTask();
		await s.h.app.tasks.update(s.id, { title: "Call the bank at nine" });
		s.tt.edit(s.ttId, { priority: 5 });
		await s.sync.sync();
		expect(s.h.app.store.state.tasks.get(s.id)).toMatchObject({ title: "Call the bank at nine", priority: 1 });
		expect(s.tt.get(s.ttId)).toMatchObject({ title: "Call the bank at nine", priority: 5 });
		expect(s.tasks("Call the bank (TickTick)")).toHaveLength(0);
	});

	it("keeps Logwell's value on a same-field conflict and makes TickTick's version a synced copy", async () => {
		const s = await oneTask();
		await s.h.app.tasks.update(s.id, { title: "Call the bank (Logwell)" });
		s.tt.edit(s.ttId, { title: "Phone the bank", priority: 3 });
		await s.sync.sync();
		expect(s.h.app.store.state.tasks.get(s.id)).toMatchObject({ title: "Call the bank (Logwell)", priority: 2 });
		expect(s.tt.get(s.ttId)?.title).toBe("Call the bank (Logwell)");
		const copy = s.task("Phone the bank (TickTick)");
		expect(copy).toMatchObject({ categoryId: s.listId, priority: 2, status: "open" });
		// Synced like any new task.
		expect(s.tt.findByTitle("Phone the bank (TickTick)")?.projectId).toBe(s.projectId);
		expect(s.link("task", copy.id)).toBeDefined();
	});

	it("only refreshes the link when both sides hold the same value", async () => {
		const s = await oneTask();
		await s.h.app.tasks.update(s.id, { title: "Same" });
		s.tt.edit(s.ttId, { title: "Same" });
		const n = pushes(s);
		await s.sync.sync();
		expect(pushes(s)).toBe(n);
		expect(s.tasks("Same (TickTick)")).toHaveLength(0);
		expect(s.link("task", s.id)?.etag).toBe(s.tt.get(s.ttId)?.etag);
	});

	it("moves the date that was sent: the deadline, and the schedule when equal (SYNC-05)", async () => {
		const s = await oneTask();
		await s.h.app.tasks.update(s.id, { scheduled: { kind: "date", date: "2026-10-05" }, deadline: { kind: "date", date: "2026-10-09" } });
		await s.sync.sync();
		s.tick();
		s.tt.edit(s.ttId, { startDate: "2026-10-10T22:00:00.000+0000", dueDate: "2026-10-10T22:00:00.000+0000", isAllDay: true, timeZone: "Europe/Berlin" });
		await s.sync.sync();
		expect(s.h.app.store.state.tasks.get(s.id)).toMatchObject({
			scheduled: { kind: "date", date: "2026-10-05" },
			deadline: { kind: "date", date: "2026-10-11" },
		});
	});
});

describe("clearing a value (probed against the real API 2026-10-08)", () => {
	it("clears the date with null (an empty string is ignored there)", async () => {
		const s = await oneTask();
		await s.h.app.tasks.update(s.id, { deadline: { kind: "date", date: "2026-10-09" } });
		await s.sync.sync();
		expect(s.tt.get(s.ttId)?.dueDate).toBeDefined();
		s.tick();
		await s.h.app.tasks.update(s.id, { deadline: null });
		await s.sync.sync();
		expect(s.tt.get(s.ttId)?.dueDate).toBeUndefined();
		expect(s.tt.get(s.ttId)?.startDate).toBeUndefined();
	});

	it("clears the parent and the section with an empty string", async () => {
		const s = await oneTask();
		const sec = await s.h.app.sections.create(s.listId, "Errands");
		await s.h.app.tasks.update(s.id, { sectionId: sec.id });
		const sub = await s.h.app.tasks.create({ title: "Find the account number", parentId: s.id });
		await s.sync.sync();
		const subTt = s.ttIdOf("Find the account number");
		expect(s.tt.get(subTt)?.parentId).toBe(s.ttId);
		expect(s.tt.get(s.ttId)?.columnId).toBeDefined();
		s.tick();
		await s.h.app.tasks.setParent(sub.task.id, null);
		await s.h.app.tasks.update(s.id, { sectionId: null });
		await s.sync.sync();
		expect(s.tt.get(subTt)?.parentId).toBeUndefined();
		expect(s.tt.get(s.ttId)?.columnId).toBeUndefined();
	});
});

describe("completion (SYNC-08)", () => {
	it("pushes a Logwell completion and a reopen", async () => {
		const s = await oneTask();
		await s.h.app.tasks.complete(s.id);
		await s.sync.sync();
		expect(s.tt.get(s.ttId)?.status).toBe(2);
		s.tick();
		await s.h.app.tasks.reopen(s.id);
		await s.sync.sync();
		expect(s.tt.get(s.ttId)?.status).toBe(0);
	});

	it("pulls a TickTick completion from the completed list", async () => {
		const s = await oneTask();
		s.tt.edit(s.ttId, { status: 2 });
		await s.sync.sync();
		expect(s.h.app.store.state.tasks.get(s.id)?.status).toBe("completed");
		expect(s.tt.count("getTask")).toBe(0);
		// A completed task is not looked up again on later syncs.
		s.tick();
		await s.sync.sync();
		expect(s.tt.count("getTask")).toBe(0);
	});

	it("reads won't do as completed (one getTask), and pulls a reopen", async () => {
		const s = await oneTask();
		s.tt.edit(s.ttId, { status: -1 });
		await s.sync.sync();
		expect(s.h.app.store.state.tasks.get(s.id)?.status).toBe("completed");
		expect(s.tt.count("getTask")).toBe(1);
		s.tick();
		s.tt.edit(s.ttId, { status: 0 });
		await s.sync.sync();
		expect(s.h.app.store.state.tasks.get(s.id)?.status).toBe("open");
	});
});

describe("lists, sections and subtasks (SYNC-04)", () => {
	it("moves a task found in another linked project, and pushes a Logwell move", async () => {
		const s = await oneTask();
		const home = await linkedList(s, "Home");
		s.tt.moveTo(s.ttId, home.projectId);
		const r = await s.sync.sync();
		expect(r.ok).toBe(true);
		expect(s.h.app.store.state.tasks.get(s.id)?.categoryId).toBe(home.listId);
		expect(s.link("task", s.id)?.ttProjectId).toBe(home.projectId);
		expect(s.h.app.store.state.trash.size).toBe(0);
		s.tick();
		await s.h.app.tasks.update(s.id, { categoryId: s.listId });
		await s.sync.sync();
		expect(s.tt.count("moveTasks")).toBe(1);
		expect(s.tt.get(s.ttId)?.projectId).toBe(s.projectId);
		expect(s.link("task", s.id)?.ttProjectId).toBe(s.projectId);
	});

	it("creates a Logwell section for a new column and pushes a Logwell section as a column", async () => {
		const s = await oneTask();
		const col = s.tt.addColumn(s.projectId, "Errands");
		s.tt.edit(s.ttId, { columnId: col.id });
		await s.sync.sync();
		const sectionId = s.h.app.store.state.tasks.get(s.id)?.sectionId;
		expect(s.h.app.store.state.sections.get(sectionId ?? "")?.name).toBe("Errands");
		s.tick();
		const later = await s.h.app.sections.create(s.listId, "Later");
		await s.h.app.tasks.update(s.id, { sectionId: later.id });
		await s.sync.sync();
		const column = s.tt.columns.get(s.tt.get(s.ttId)?.columnId ?? "");
		expect(column?.name).toBe("Later");
		expect(s.link("section", later.id)?.ttId).toBe(column?.id);
	});

	it("pulls a new subtask under its mapped parent and pushes a new Logwell subtask", async () => {
		const s = await oneTask();
		s.tt.add(s.projectId, { title: "Find the account number", parentId: s.ttId });
		await s.sync.sync();
		expect(s.task("Find the account number").parentId).toBe(s.id);
		s.tick();
		await s.h.app.tasks.create({ title: "Write down the reference", parentId: s.id });
		await s.sync.sync();
		expect(s.tt.findByTitle("Write down the reference")?.parentId).toBe(s.ttId);
	});
});

describe("not synced (SYNC-06)", () => {
	it("never imports a repeating TickTick task or a note", async () => {
		const s = await oneTask();
		s.tt.add(s.projectId, { title: "Water the plants", repeatFlag: "RRULE:FREQ=WEEKLY;INTERVAL=1" });
		s.tt.add(s.projectId, { title: "Shopping notes", kind: "NOTE" });
		await s.sync.sync();
		expect(s.tasks("Water the plants")).toHaveLength(0);
		expect(s.tasks("Shopping notes")).toHaveLength(0);
	});

	it("excludes a synced task that becomes repeating: its TickTick copy is left and never imported", async () => {
		const s = await oneTask();
		await s.h.app.recurrence.setRepeat(s.id, WEEKLY.rule);
		await s.sync.sync();
		expect(s.link("task", s.id)).toMatchObject({ ttId: s.ttId, mode: "excluded" });
		expect(s.tt.get(s.ttId)).toMatchObject({ title: "Call the bank", status: 0 });
		s.tick();
		s.tt.edit(s.ttId, { title: "Edited in TickTick" });
		await s.h.app.tasks.update(s.id, { title: "Edited in Logwell" });
		await s.sync.sync();
		expect(s.tt.count("deleteTask") + s.tt.count("batchTasks") + s.tt.count("createTask")).toBe(1);
		expect(s.tasks("Edited in TickTick")).toHaveLength(0);
		expect(s.tt.get(s.ttId)?.title).toBe("Edited in TickTick");
		expect(s.tt.live(s.projectId)).toHaveLength(1);
	});

	it("never deletes the TickTick copy of an excluded task while it is trashed or moved out (deep review #1)", async () => {
		const s = await oneTask();
		const home = await s.h.app.categories.create("Home");
		const other = await s.h.app.tasks.create({ title: "Pay rent", categoryId: s.listId });
		await s.sync.sync();
		s.tick();
		const otherTt = s.ttIdOf("Pay rent");
		await s.h.app.recurrence.setRepeat(s.id, WEEKLY.rule);
		await s.h.app.recurrence.setRepeat(other.task.id, WEEKLY.rule);
		await s.sync.sync();
		s.tick();
		const entry = await s.h.app.tasks.delete(s.id);
		await s.h.app.tasks.update(other.task.id, { categoryId: home.id });
		await s.sync.sync();
		s.tick();
		await s.sync.sync();
		expect(s.link("task", s.id)?.mode).toBe("excluded");
		expect(entry.tasks[0]?.id).toBe(s.id);
		expect(s.tt.count("deleteTask")).toBe(0);
		expect(s.tt.get(s.ttId)?.title).toBe("Call the bank");
		expect(s.tt.get(otherTt)?.title).toBe("Pay rent");
		expect(s.tt.live(s.projectId)).toHaveLength(2);
		// Neither TickTick copy comes back into Logwell.
		expect(s.tasks("Call the bank")).toHaveLength(0);
		expect(s.tasks("Pay rent")).toHaveLength(1);
	});

	it("an excluded task purged in Logwell: a repeating TickTick copy only loses its link (second review #4)", async () => {
		const s = await oneTask();
		await s.h.app.recurrence.setRepeat(s.id, WEEKLY.rule);
		s.tt.edit(s.ttId, { repeatFlag: "RRULE:FREQ=DAILY;INTERVAL=1" });
		await s.sync.sync();
		s.tick();
		const entry = await s.h.app.tasks.delete(s.id);
		await s.sync.sync();
		// In Trash: nothing changes.
		expect(s.link("task", s.id)?.mode).toBe("excluded");
		await s.h.app.tasks.purge(entry.batchId);
		s.tick();
		await s.sync.sync();
		expect(s.link("task", s.id)).toBeUndefined();
		expect(s.tt.count("deleteTask")).toBe(0);
		expect(s.tt.get(s.ttId)?.repeatFlag).toBe("RRULE:FREQ=DAILY;INTERVAL=1");
		s.tick();
		await s.sync.sync();
		expect(s.h.app.store.state.tasks.size).toBe(0);
	});

	it("an excluded task purged in Logwell: a plain TickTick copy is deleted there (second review #4)", async () => {
		const s = await oneTask();
		await s.h.app.recurrence.setRepeat(s.id, WEEKLY.rule);
		await s.sync.sync();
		s.tick();
		const entry = await s.h.app.tasks.delete(s.id);
		await s.sync.sync();
		expect(s.tt.count("deleteTask")).toBe(0);
		await s.h.app.tasks.purge(entry.batchId);
		s.tick();
		await s.sync.sync();
		expect(s.tt.calls).toContain(`deleteTask:${s.ttId}`);
		expect(s.link("task", s.id)).toBeUndefined();
		expect(s.tt.live(s.projectId)).toHaveLength(0);
	});

	it("resumes an excluded task that stops repeating with Logwell's values as the new base", async () => {
		const s = await oneTask();
		await s.h.app.recurrence.setRepeat(s.id, WEEKLY.rule);
		await s.sync.sync();
		s.tick();
		s.tt.edit(s.ttId, { title: "Edited in TickTick", priority: 5 });
		await s.h.app.recurrence.setRepeat(s.id, null);
		await s.h.app.tasks.update(s.id, { title: "Edited in Logwell" });
		const before = s.h.app.store.state.tasks.get(s.id);
		await s.sync.sync();
		// Pushed, never pulled, no conflict copy.
		expect(s.h.app.store.state.tasks.get(s.id)).toBe(before);
		expect(s.tt.get(s.ttId)).toMatchObject({ title: "Edited in Logwell", priority: 0 });
		expect(s.tasks("Edited in TickTick (TickTick)")).toHaveLength(0);
		const link = s.link("task", s.id);
		expect(link?.mode).toBeUndefined();
		expect(link?.etag).toBe(s.tt.get(s.ttId)?.etag);
		// Syncs both ways again.
		s.tick();
		s.tt.edit(s.ttId, { priority: 3 });
		await s.sync.sync();
		expect(s.h.app.store.state.tasks.get(s.id)?.priority).toBe(2);
	});

	it("excludes a synced task made repeating in TickTick: neither copy changes or comes in twice", async () => {
		const s = await oneTask();
		s.tt.edit(s.ttId, { repeatFlag: "RRULE:FREQ=DAILY;INTERVAL=1", title: "Daily call" });
		await s.sync.sync();
		expect(s.link("task", s.id)?.mode).toBe("excluded");
		s.tick();
		await s.h.app.tasks.update(s.id, { priority: 1 });
		await s.sync.sync();
		expect(s.h.app.store.state.tasks.get(s.id)?.title).toBe("Call the bank");
		expect(s.tt.get(s.ttId)).toMatchObject({ title: "Daily call", priority: 0 });
		expect(s.tt.live(s.projectId)).toHaveLength(1);
		expect(s.h.app.store.state.tasks.size).toBe(1);
	});

	it("deletes the TickTick copy of a task moved to a list that is not linked; the Logwell task stays", async () => {
		const s = await oneTask();
		const home = await s.h.app.categories.create("Home");
		await s.h.app.tasks.update(s.id, { categoryId: home.id });
		await s.sync.sync();
		expect(s.tt.get(s.ttId)).toBeDefined();
		expect(s.tt.live(s.projectId)).toHaveLength(0);
		expect(s.link("task", s.id)).toBeUndefined();
		expect(s.h.app.store.state.tasks.get(s.id)?.categoryId).toBe(home.id);
	});

	it("leaves a link whose Logwell task has not arrived untouched", async () => {
		const s = await oneTask();
		const orphan = { kind: "task" as const, logwellId: "missing-task", ttId: "tt-x", ttProjectId: s.projectId, etag: "e0", base: { title: "x" }, noteBySync: false, lastPulledAt: null, modifiedAt: "2026-10-01T00:00:00.000Z" };
		await s.h.app.store.run("seed", (tx) => tx.put("syncLinks", orphan), { undoable: false });
		const r = await s.sync.sync();
		expect(r.ok).toBe(true);
		expect(s.h.app.store.state.syncLinks.get(syncLinkId("task", "missing-task"))).toBe(orphan);
		expect(s.tt.count("deleteTask") + s.tt.count("getTask")).toBe(0);
	});
});
