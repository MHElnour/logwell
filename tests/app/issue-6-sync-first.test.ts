import { describe, expect, it } from "vitest";
import { TICKTICK_SYNC_LABEL } from "../../src/app/SyncService";
import { isDomainError } from "../../src/domain/errors";
import { syncLinkId } from "../../src/domain/types";
import { linkedList, syncHarness } from "./sync-harness";

// Linking a list and its first sync.

const DAY = { startDate: "2026-10-07T22:00:00.000+0000", dueDate: "2026-10-07T22:00:00.000+0000", isAllDay: true, timeZone: "Europe/Berlin" };

describe("first sync (SYNC-03)", () => {
	it("previews how many tasks each side will get: open, syncable, not repeating", async () => {
		const s = await syncHarness();
		const list = await s.h.app.categories.create("Work");
		const p = s.tt.addProject("Work");
		s.tt.add(p.id, { title: "Call the bank" });
		s.tt.add(p.id, { title: "Shopping notes", kind: "NOTE" });
		s.tt.add(p.id, { title: "Water the plants", repeatFlag: "RRULE:FREQ=WEEKLY;INTERVAL=1" });
		s.tt.add(p.id, { title: "Old one", status: 2 });
		await s.h.app.tasks.create({ title: "Pay rent", categoryId: list.id });
		await s.h.app.tasks.create({ title: "Buy milk", categoryId: list.id });
		const done = await s.h.app.tasks.create({ title: "Done", categoryId: list.id });
		await s.h.app.tasks.complete(done.task.id);
		await s.h.app.tasks.create({
			title: "Weekly",
			categoryId: list.id,
			repeat: { rule: { freq: "weekly", interval: 1, weekdays: null, monthly: null, afterCompletion: false, time: null, tz: null } },
		});
		const plan = await s.sync.planFirstSync(list.id, p.id);
		expect(plan).toMatchObject({ toLogwell: 1, toTickTick: 2 });
		// A preview writes nothing.
		expect(s.h.app.store.state.syncLinks.size).toBe(0);
	});

	it("fills an empty Logwell list from TickTick: tasks, sections, subtasks, dates, priority", async () => {
		const s = await syncHarness();
		const list = await s.h.app.categories.create("Work");
		const p = s.tt.addProject("Work");
		const col = s.tt.addColumn(p.id, "Errands");
		const parent = s.tt.add(p.id, { title: "Call the bank", priority: 5, columnId: col.id, ...DAY });
		s.tt.add(p.id, { title: "Find the account number", parentId: parent.id });
		const r = await s.sync.applyFirstSync(list.id, p.id);
		expect(r.ok).toBe(true);
		const bank = s.task("Call the bank");
		expect(bank).toMatchObject({ categoryId: list.id, priority: 1, status: "open" });
		expect(bank.scheduled).toEqual({ kind: "date", date: "2026-10-08" });
		expect(bank.deadline).toEqual({ kind: "date", date: "2026-10-08" });
		const section = s.h.app.store.state.sections.get(bank.sectionId ?? "");
		expect(section?.name).toBe("Errands");
		expect(s.link("section", section!.id)?.ttId).toBe(col.id);
		const sub = s.task("Find the account number");
		expect(sub.parentId).toBe(bank.id);
		expect(s.link("task", bank.id)).toMatchObject({ ttId: parent.id, ttProjectId: p.id, etag: s.tt.get(parent.id)?.etag });
		expect(s.link("list", list.id)).toMatchObject({ ttId: p.id, ttProjectId: null });
		// Nothing goes back up.
		expect(s.tt.count("createTask") + s.tt.count("batchTasks") + s.tt.count("updateTask")).toBe(0);
	});

	it("fills an empty TickTick project from Logwell, open tasks only, one createTask each", async () => {
		const s = await syncHarness();
		const list = await s.h.app.categories.create("Work");
		const sec = await s.h.app.sections.create(list.id, "Errands");
		const parent = await s.h.app.tasks.create({ title: "Call the bank", categoryId: list.id, sectionId: sec.id, priority: 2, deadline: { kind: "date", date: "2026-10-08" } });
		await s.h.app.tasks.create({ title: "Find the account number", parentId: parent.task.id });
		const done = await s.h.app.tasks.create({ title: "Done already", categoryId: list.id });
		await s.h.app.tasks.complete(done.task.id);
		const p = s.tt.addProject("Work");
		const r = await s.sync.applyFirstSync(list.id, p.id);
		expect(r.ok).toBe(true);
		expect(s.tt.count("createTask")).toBe(2);
		const bank = s.tt.get(s.ttIdOf("Call the bank"))!;
		expect(bank).toMatchObject({ projectId: p.id, priority: 3, isAllDay: true, dueDate: "2026-10-08T00:00:00+0200" });
		expect(s.tt.columns.get(bank.columnId ?? "")?.name).toBe("Errands");
		expect(s.link("section", sec.id)?.ttId).toBe(bank.columnId);
		const sub = s.tt.get(s.ttIdOf("Find the account number"))!;
		expect(sub.parentId).toBe(bank.id);
		expect(s.tt.findByTitle("Done already")).toBeUndefined();
		expect(s.link("task", done.task.id)).toBeUndefined();
		// The link holds the etag TickTick answered with; the task record is untouched.
		expect(s.link("task", parent.task.id)?.etag).toBe(bank.etag);
		expect(s.task("Call the bank").modifiedAt).toBe(parent.task.modifiedAt);
	});

	it("copies both ways when both sides have tasks, with no matching", async () => {
		const s = await syncHarness();
		const list = await s.h.app.categories.create("Work");
		await s.h.app.tasks.create({ title: "Buy milk", categoryId: list.id });
		const p = s.tt.addProject("Work");
		s.tt.add(p.id, { title: "Buy milk" });
		s.tt.add(p.id, { title: "Call the bank" });
		expect(await s.sync.planFirstSync(list.id, p.id)).toMatchObject({ toLogwell: 2, toTickTick: 1 });
		await s.sync.applyFirstSync(list.id, p.id);
		expect(s.tasks("Buy milk")).toHaveLength(2);
		expect(s.tasks("Call the bank")).toHaveLength(1);
		expect(s.tt.live(p.id).filter((t) => t.title === "Buy milk")).toHaveLength(2);
		// A second sync changes nothing.
		s.tick();
		const calls = s.tt.calls.length;
		const state = s.h.app.store.state;
		const r = await s.sync.sync();
		expect(r.ok).toBe(true);
		expect(s.h.app.store.state.tasks).toBe(state.tasks);
		expect(s.tt.calls.slice(calls).every((c) => c.startsWith("getProjectData") || c.startsWith("listCompleted"))).toBe(true);
	});

	it("is not undoable (D26): the newest undo entry stays the user's own", async () => {
		const s = await syncHarness();
		const list = await s.h.app.categories.create("Work");
		const p = s.tt.addProject("Work");
		s.tt.add(p.id, { title: "Call the bank" });
		s.tt.add(p.id, { title: "Buy milk" });
		const r = await s.sync.applyFirstSync(list.id, p.id);
		expect(r.content).toEqual({ wrote: true, label: TICKTICK_SYNC_LABEL });
		// The newest undo entry is still the user's own (creating the list); nothing of the sync is on the stack.
		expect(s.h.app.store.undoLabel).toBe("Create category");
	});

	it("refuses a note project, a linked list and a project linked to another list (SYNC-02)", async () => {
		const s = await syncHarness();
		const { listId, projectId } = await linkedList(s, "Work");
		const other = await s.h.app.categories.create("Home");
		const notes = s.tt.addProject("Notes", "NOTE");
		const fresh = s.tt.addProject("Fresh");
		const code = async (p: Promise<unknown>) => {
			const err = await p.then(() => null, (e: unknown) => e);
			expect(isDomainError(err)).toBe(true);
		};
		await code(s.sync.planFirstSync(other.id, notes.id));
		await code(s.sync.applyFirstSync(other.id, projectId));
		await code(s.sync.applyFirstSync(listId, fresh.id));
		expect(s.h.app.store.state.syncLinks.has(syncLinkId("list", other.id))).toBe(false);
	});

	it("unlinking keeps every task on both sides and removes the list's links", async () => {
		const s = await syncHarness();
		const { listId, projectId } = await linkedList(s);
		await s.h.app.tasks.create({ title: "Buy milk", categoryId: listId });
		await s.sync.sync();
		expect(s.tt.live(projectId)).toHaveLength(1);
		const r = await s.sync.unlinkList(listId);
		expect(r.wrote).toBe(true);
		expect(s.h.app.store.state.syncLinks.size).toBe(0);
		expect(s.tasks("Buy milk")).toHaveLength(1);
		expect(s.tt.live(projectId)).toHaveLength(1);
		expect(s.h.app.store.undoLabel).not.toBe(r.label);
	});
});
