import { describe, expect, it } from "vitest";
import { syncLinkId } from "../../src/domain/types";
import { linkedList, oneSyncedTask, pushes, quiet } from "./sync-harness";

// Edits both ways, the per-field merge, conflicts, completion, moves, sections, subtasks and
// what never syncs. What a delete, purge or move in Logwell does to the TickTick copy, and a value that is the same on
// both sides, are tables in sync-robustness.test.ts.

const WEEKLY = { rule: { freq: "weekly" as const, interval: 1, weekdays: null, monthly: null, afterCompletion: false, time: null, tz: null } };

describe("edits (SYNC-07)", () => {
	it("pulls a TickTick edit without an undo entry and without touching the link of other tasks", async () => {
		const s = await oneSyncedTask();
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
		const s = await oneSyncedTask();
		await s.h.app.tasks.update(s.id, { priority: 1, deadline: { kind: "date", date: "2026-10-09" } });
		const record = s.h.app.store.state.tasks.get(s.id);
		await s.sync.sync();
		expect(s.tt.get(s.ttId)).toMatchObject({ priority: 5, isAllDay: true, dueDate: "2026-10-09T00:00:00+0200" });
		expect(s.tt.count("batchTasks")).toBe(1);
		expect(s.h.app.store.state.tasks.get(s.id)).toBe(record);
		expect(s.link("task", s.id)?.etag).toBe(s.tt.get(s.ttId)?.etag);
		// Nothing left to do.
		await quiet(s);
	});

	it("merges different fields changed on both sides", async () => {
		const s = await oneSyncedTask();
		await s.h.app.tasks.update(s.id, { title: "Call the bank at nine" });
		s.tt.edit(s.ttId, { priority: 5 });
		await s.sync.sync();
		expect(s.h.app.store.state.tasks.get(s.id)).toMatchObject({ title: "Call the bank at nine", priority: 1 });
		expect(s.tt.get(s.ttId)).toMatchObject({ title: "Call the bank at nine", priority: 5 });
		expect(s.tasks("Call the bank (TickTick)")).toHaveLength(0);
	});

	it("keeps Logwell's value on a same-field conflict and makes TickTick's version a synced copy", async () => {
		const s = await oneSyncedTask();
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

	it("#121: the copy of a version completed in TickTick is completed, and not sent there as a new open task", async () => {
		const s = await oneSyncedTask();
		await s.h.app.tasks.update(s.id, { title: "Call the bank (Logwell)" });
		s.tt.edit(s.ttId, { title: "Phone the bank", status: 2 });
		await s.sync.sync();
		expect(s.h.app.store.state.tasks.get(s.id)).toMatchObject({ title: "Call the bank (Logwell)", status: "completed" });
		expect(s.task("Phone the bank (TickTick)").status).toBe("completed");
		expect(s.tt.findByTitle("Phone the bank (TickTick)")).toBeUndefined();
		expect(s.tt.get(s.ttId)).toMatchObject({ title: "Call the bank (Logwell)", status: 2 });
		s.tick();
		await s.sync.sync();
		expect(s.tt.findByTitle("Phone the bank (TickTick)")).toBeUndefined();
		expect(s.tasks("Phone the bank (TickTick)")).toHaveLength(1);
	});

	it("#108: keeps the other values TickTick changed when one of them is refused", async () => {
		const s = await oneSyncedTask();
		const home = await linkedList(s, "Home");
		await s.h.app.tasks.update(s.id, { categoryId: home.listId });
		// A column of the list the task just left in Logwell: refused there.
		const doing = s.tt.addColumn(s.projectId, "Doing");
		s.tt.edit(s.ttId, { title: "Call the bank now", priority: 5, columnId: doing.id });
		const r = await s.sync.sync();
		expect(r.ok).toBe(true);
		expect(s.h.app.store.state.tasks.get(s.id)).toMatchObject({ title: "Call the bank now", priority: 1, categoryId: home.listId, sectionId: null });
		expect(s.tt.get(s.ttId)).toMatchObject({ title: "Call the bank now", priority: 5, projectId: home.projectId });
		expect(s.tasks("Call the bank now (TickTick)")).toHaveLength(0);
	});

	it("moves the date that was sent: the deadline, and the schedule when equal (SYNC-05)", async () => {
		const s = await oneSyncedTask();
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
	it("#120: a date cleared in TickTick clears both dates in Logwell and is not sent back", async () => {
		const s = await oneSyncedTask();
		await s.h.app.tasks.update(s.id, { scheduled: { kind: "date", date: "2026-10-12" }, deadline: { kind: "date", date: "2026-10-16" } });
		await s.sync.sync();
		expect(s.tt.get(s.ttId)?.dueDate).toBe("2026-10-16T00:00:00+0200");
		s.tick();
		s.tt.edit(s.ttId, { startDate: undefined, dueDate: undefined });
		const n = pushes(s);
		await s.sync.sync();
		expect(s.h.app.store.state.tasks.get(s.id)).toMatchObject({ scheduled: null, deadline: null });
		expect(s.tt.get(s.ttId)?.dueDate).toBeUndefined();
		expect(s.tt.get(s.ttId)?.startDate).toBeUndefined();
		expect(pushes(s)).toBe(n);
	});

	it("clears the date with null (an empty string is ignored there)", async () => {
		const s = await oneSyncedTask();
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
		const s = await oneSyncedTask();
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
		const s = await oneSyncedTask();
		await s.h.app.tasks.complete(s.id);
		await s.sync.sync();
		expect(s.tt.get(s.ttId)?.status).toBe(2);
		s.tick();
		await s.h.app.tasks.reopen(s.id);
		await s.sync.sync();
		expect(s.tt.get(s.ttId)?.status).toBe(0);
	});

	it("pulls a TickTick completion from the completed list", async () => {
		const s = await oneSyncedTask();
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
		const s = await oneSyncedTask();
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
		const s = await oneSyncedTask();
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

	it.each([
		["takes it out of its parent", { parentId: "" }],
		["still names its old parent", {}],
	])("#109: a subtask moved to another linked list in TickTick that %s stays there as a top-level task", async (_, patch) => {
		const s = await oneSyncedTask();
		const home = await linkedList(s, "Home");
		const sub = await s.h.app.tasks.create({ title: "Find the account number", parentId: s.id });
		await s.sync.sync();
		s.tick();
		const subTt = s.ttIdOf("Find the account number");
		s.tt.moveTo(subTt, home.projectId);
		s.tt.edit(subTt, patch);
		const r = await s.sync.sync();
		expect(r.ok).toBe(true);
		expect(s.h.app.store.state.tasks.get(sub.task.id)).toMatchObject({ categoryId: home.listId, parentId: null });
		expect(s.h.app.store.state.tasks.get(s.id)?.categoryId).toBe(s.listId);
		expect(s.tt.get(subTt)?.projectId).toBe(home.projectId);
		expect(s.tt.get(subTt)?.parentId ?? "").toBe("");
		expect(s.link("task", sub.task.id)?.ttProjectId).toBe(home.projectId);
		// Settled: the next sync moves nothing.
		s.tick();
		await s.sync.sync();
		expect(s.tt.count("moveTasks")).toBe(0);
		expect(s.tt.get(subTt)?.projectId).toBe(home.projectId);
	});

	it("#109: a subtask given another parent in Logwell keeps it when TickTick moves it to another list", async () => {
		const s = await oneSyncedTask();
		const home = await linkedList(s, "Home");
		const other = await s.h.app.tasks.create({ title: "Pay rent", categoryId: s.listId });
		const sub = await s.h.app.tasks.create({ title: "Find the account number", parentId: s.id });
		await s.sync.sync();
		s.tick();
		const subTt = s.ttIdOf("Find the account number");
		await s.h.app.tasks.setParent(sub.task.id, other.task.id);
		s.tt.moveTo(subTt, home.projectId);
		await s.sync.sync();
		expect(s.h.app.store.state.tasks.get(sub.task.id)).toMatchObject({ categoryId: s.listId, parentId: other.task.id });
		expect(s.tt.get(subTt)).toMatchObject({ projectId: s.projectId, parentId: s.ttIdOf("Pay rent") });
	});

	it("creates a Logwell section for a new column and pushes a Logwell section as a column", async () => {
		const s = await oneSyncedTask();
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
		const s = await oneSyncedTask();
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
		const s = await oneSyncedTask();
		s.tt.add(s.projectId, { title: "Water the plants", repeatFlag: "RRULE:FREQ=WEEKLY;INTERVAL=1" });
		s.tt.add(s.projectId, { title: "Shopping notes", kind: "NOTE" });
		await s.sync.sync();
		expect(s.tasks("Water the plants")).toHaveLength(0);
		expect(s.tasks("Shopping notes")).toHaveLength(0);
	});

	it("excludes a synced task that becomes repeating: its TickTick copy is left and never imported", async () => {
		const s = await oneSyncedTask();
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

	it("never deletes the TickTick copy of an excluded task while it is trashed or moved out", async () => {
		const s = await oneSyncedTask();
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

	it("resumes an excluded task that stops repeating with Logwell's values as the new base", async () => {
		const s = await oneSyncedTask();
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
		const s = await oneSyncedTask();
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

	it("leaves a link whose Logwell task has not arrived untouched", async () => {
		const s = await oneSyncedTask();
		const orphan = { kind: "task" as const, logwellId: "missing-task", ttId: "tt-x", ttProjectId: s.projectId, etag: "e0", base: { title: "x" }, noteBySync: false, lastPulledAt: null, modifiedAt: "2026-10-01T00:00:00.000Z" };
		await s.h.app.store.run("seed", (tx) => tx.put("syncLinks", orphan), { undoable: false });
		const r = await s.sync.sync();
		expect(r.ok).toBe(true);
		expect(s.h.app.store.state.syncLinks.get(syncLinkId("task", "missing-task"))).toBe(orphan);
		expect(s.tt.count("deleteTask") + s.tt.count("getTask")).toBe(0);
	});
});
