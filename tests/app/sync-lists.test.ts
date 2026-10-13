import { describe, expect, it, vi } from "vitest";
import { SyncService } from "../../src/app/SyncService";
import { TICKTICK_KEEP_LABEL, TICKTICK_LINKS_LABEL, TICKTICK_SYNC_LABEL, TICKTICK_TRASH_LABEL } from "../../src/app/syncModel";
import { type Category, INBOX_ID, type SyncLink, syncLinkId, type Task } from "../../src/domain/types";
import { linkedList, oneSyncedTask, syncHarness, type SyncHarness } from "./sync-harness";
import { fieldHashes } from "../../src/domain/ticktick/mapping";
import { createEmptyDb } from "../../src/persistence/schema";
import { serializeDb } from "../../src/persistence/serializer";
import { FakeTickTick } from "./fake-ticktick";
import { appHarness, expectDomainError } from "./harness";
import { load, makeTask } from "../persistence/fixtures";
import { FakeClock } from "../helpers";
import { TickTickError } from "../../src/app/ports";
import { InboxAliasApi } from "../../src/app/tickTickInbox";
import type { TtTask } from "../../src/domain/ticktick/types";
import { rule } from "../domain/recurrence-fixtures";

describe("first sync (SYNC-03)", () => {
	// Linking a list and its first sync.

	const DAY = { startDate: "2026-10-07T22:00:00.000+0000", dueDate: "2026-10-07T22:00:00.000+0000", isAllDay: true, timeZone: "Europe/Berlin" };

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

	it("#136: a preview whose TickTick read fails is a failed result naming the list, as a failed first sync is", async () => {
		const s = await syncHarness();
		const list = await s.h.app.categories.create("Work");
		const p = s.tt.addProject("Work");
		s.tt.fail("getProjectData", new TickTickError("server", "TickTick: server error (HTTP 500)", { status: 500 }));
		const plan = await s.sync.planFirstSync(list.id, p.id);
		expect(plan).toMatchObject({ ok: false, error: { kind: "server", listId: list.id, listName: "Work" } });
		s.tt.fail("getProjectData", new TickTickError("server", "TickTick: server error (HTTP 500)", { status: 500 }));
		const first = await s.sync.applyFirstSync(list.id, p.id);
		expect(first.error).toEqual("error" in plan ? plan.error : null);
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
		expect(s.h.app.store.undoLabel).toBe("Create list");
	});

	it("refuses a note project, a linked list and a project linked to another list (SYNC-02)", async () => {
		const s = await syncHarness();
		const { listId, projectId } = await linkedList(s, "Work");
		const other = await s.h.app.categories.create("Home");
		const notes = s.tt.addProject("Notes", "NOTE");
		const fresh = s.tt.addProject("Fresh");
		await expectDomainError(s.sync.planFirstSync(other.id, notes.id));
		await expectDomainError(s.sync.applyFirstSync(other.id, projectId));
		await expectDomainError(s.sync.applyFirstSync(listId, fresh.id));
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

describe("the open-task cap of a synced list", () => {
	// A synced list holds at most 999 open tasks. Adding, moving in or reopening a task that would be
	// the 1000th open task is refused; completed tasks do not count; a list with more than 999 open tasks cannot be
	// linked. Pulls are never refused: TickTick enforces its own limit.

	const NOW = "2026-10-01T09:59:00.000Z";
	const WORK = "00000000-0000-4000-8000-00000000000a";
	const HOME = "00000000-0000-4000-8000-00000000000b";
	const FULL = "Can't add the task: Work is synced with TickTick and already has 999 open tasks.";

	const uuid = (n: number) => `00000001-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
	const list = (id: string, name: string, sortKey: string): Category => ({
		id,
		name,
		icon: null,
		color: null,
		nameKey: name.toLowerCase(),
		isInbox: false,
		sortKey,
		createdAt: NOW,
		modifiedAt: NOW,
	});
	const listLink = (listId: string, projectId: string): SyncLink => ({
		kind: "list",
		logwellId: listId,
		ttId: projectId,
		ttProjectId: null,
		etag: null,
		base: {},
		noteBySync: false,
		lastPulledAt: NOW,
		modifiedAt: NOW,
	});

	interface Spec {
		/** Open tasks in Work. */
		open: number;
		/** Completed tasks in Work. */
		completed?: number;
		/** Open tasks in Home (not linked). */
		home?: number;
		/** Whether Work is linked (default true). */
		linked?: boolean;
	}

	/** A database with Work (linked unless told otherwise) and Home. */
	function capDb(spec: Spec): string {
		const db = createEmptyDb({ dbId: "db-1", revision: "r-000000000000", deviceId: "d-other", now: NOW });
		const categories = new Map(db.categories);
		categories.set(WORK, list(WORK, "Work", "V1"));
		categories.set(HOME, list(HOME, "Home", "V2"));
		const tasks = new Map<string, Task>();
		let n = 0;
		const add = (categoryId: string, title: string, patch: Partial<Task> = {}) => {
			const t = makeTask(uuid(n), { title, categoryId, sortKey: `V${n.toString(36).padStart(4, "0")}`, ...patch });
			tasks.set(t.id, t);
			n++;
		};
		for (let i = 0; i < spec.open; i++) add(WORK, `Open ${i}`);
		for (let i = 0; i < (spec.completed ?? 0); i++) add(WORK, `Done ${i}`, { status: "completed", completedAt: NOW });
		for (let i = 0; i < (spec.home ?? 0); i++) add(HOME, `Home ${i}`);
		const syncLinks = new Map<string, SyncLink>();
		if (spec.linked !== false) syncLinks.set(`list:${WORK}`, listLink(WORK, "p-work"));
		return serializeDb({ ...db, categories, tasks, syncLinks });
	}

	const refused = (p: Promise<unknown>) => expectDomainError(p, "SyncedListFull", FULL);

	const openIn = (h: { app: { store: { state: { tasks: ReadonlyMap<string, Task> } } } }, listId: string) =>
		[...h.app.store.state.tasks.values()].filter((t) => t.categoryId === listId && t.status === "open").length;

	describe("SYNC-13: the 999 open-task cap of a synced list", () => {
		it("refuses a new task in a synced list that has 999 open tasks, and writes nothing", async () => {
			const h = await appHarness({ initial: capDb({ open: 999 }) });
			const before = h.app.store.state;
			await refused(h.app.tasks.create({ title: "One more", categoryId: WORK }));
			expect(h.app.store.state).toBe(before);
			expect(h.app.store.canUndo).toBe(false);
		});

		it("completed tasks do not count: the 999th open task is added, the 1000th is not", async () => {
			const h = await appHarness({ initial: capDb({ open: 998, completed: 40 }) });
			await h.app.tasks.create({ title: "The 999th", categoryId: WORK });
			expect(openIn(h, WORK)).toBe(999);
			await refused(h.app.tasks.create({ title: "The 1000th", categoryId: WORK }));
		});

		it("a list that is not synced has no cap", async () => {
			const h = await appHarness({ initial: capDb({ open: 999, linked: false }) });
			await h.app.tasks.create({ title: "One more", categoryId: WORK });
			expect(openIn(h, WORK)).toBe(1000);
		});

		it("refuses a subtask of a task in the full list", async () => {
			const h = await appHarness({ initial: capDb({ open: 999 }) });
			await refused(h.app.tasks.create({ title: "Sub", parentId: uuid(0) }));
		});

		it("refuses a move into the full list (category change), the subtasks counted with their parent", async () => {
			const h = await appHarness({ initial: capDb({ open: 999, home: 1 }) });
			const homeTask = uuid(999);
			await refused(h.app.tasks.update(homeTask, { categoryId: WORK }));
			expect(h.app.store.state.tasks.get(homeTask)?.categoryId).toBe(HOME);

			const h2 = await appHarness({ initial: capDb({ open: 997, home: 1 }) });
			const parent = uuid(997);
			await h2.app.tasks.create({ title: "Sub 1", parentId: parent });
			await h2.app.tasks.create({ title: "Sub 2", parentId: parent });
			// 997 + the parent + 2 subtasks = 1000.
			await refused(h2.app.tasks.update(parent, { categoryId: WORK }));
			expect(openIn(h2, WORK)).toBe(997);
		});

		it("refuses a drop into the full list (place with a list change)", async () => {
			const h = await appHarness({ initial: capDb({ open: 999, home: 1 }) });
			const homeTask = uuid(999);
			await refused(h.app.tasks.place(homeTask, [homeTask], { categoryId: WORK }));
			expect(h.app.store.state.tasks.get(homeTask)?.categoryId).toBe(HOME);
		});

		it("refuses making a task of another list a subtask of a task in the full list", async () => {
			const h = await appHarness({ initial: capDb({ open: 999, home: 1 }) });
			await refused(h.app.tasks.setParent(uuid(999), uuid(0)));
		});

		it("refuses reopening a task in the full list; one below the cap reopens", async () => {
			const h = await appHarness({ initial: capDb({ open: 999, completed: 1 }) });
			const done = uuid(999);
			await refused(h.app.tasks.reopen(done));
			expect(h.app.store.state.tasks.get(done)?.status).toBe("completed");
			await h.app.tasks.complete(uuid(0));
			await h.app.tasks.reopen(done);
			expect(openIn(h, WORK)).toBe(999);
		});

		it("refuses a duplicate and a restore from Trash into the full list", async () => {
			const h = await appHarness({ initial: capDb({ open: 999 }) });
			await refused(h.app.tasks.duplicate(uuid(0)));
			const trashed = await h.app.tasks.delete(uuid(1));
			await h.app.tasks.create({ title: "Takes its place", categoryId: WORK });
			await refused(h.app.tasks.restore(trashed.batchId));
		});

		it("edits that add no open task still work in a full list, and in a list over the cap", async () => {
			const h = await appHarness({ initial: capDb({ open: 1005 }) });
			await h.app.tasks.update(uuid(0), { title: "Renamed" });
			await h.app.tasks.complete(uuid(1));
			await h.app.tasks.place(uuid(2), [uuid(3), uuid(2)]);
			expect(h.app.store.state.tasks.get(uuid(0))?.title).toBe("Renamed");
			await refused(h.app.tasks.reopen(uuid(1)));
		});

		it("follows undo and a reload: the count is never stale", async () => {
			const h = await appHarness({ initial: capDb({ open: 998 }) });
			await h.app.tasks.create({ title: "The 999th", categoryId: WORK });
			await h.app.store.undo();
			await h.app.tasks.create({ title: "Again the 999th", categoryId: WORK });
			await refused(h.app.tasks.create({ title: "The 1000th", categoryId: WORK }));
			// A reload from outside with one open task fewer.
			h.app.store.notifyReloaded();
			await h.app.tasks.complete(uuid(0));
			await h.app.tasks.create({ title: "Fits after the completion", categoryId: WORK });
		});
	});

	describe("SYNC-13: linking and pulling", () => {
		it("a list with more than 999 open tasks cannot be linked; 999 can", async () => {
			const s = await syncHarness(capDb({ open: 1000, linked: false }));
			const project = s.tt.addProject("Work");
			const msg = "Can't link the list: Work has more than 999 open tasks, the most a list synced with TickTick can hold.";
			await expect(s.sync.planFirstSync(WORK, project.id)).rejects.toThrow(msg);
			await expect(s.sync.applyFirstSync(WORK, project.id)).rejects.toThrow(msg);
			expect(s.link("list", WORK)).toBeUndefined();

			const ok = await syncHarness(capDb({ open: 999, completed: 5, linked: false }));
			const p2 = ok.tt.addProject("Work");
			await expect(ok.sync.planFirstSync(WORK, p2.id)).resolves.toMatchObject({ toTickTick: 999 });
		});

		it("a pull is never refused by the cap: a task added in TickTick to a full list comes in", async () => {
			const clock = new FakeClock(NOW);
			const tt = new FakeTickTick(clock);
			const project = tt.addProject("Work");
			const db = createEmptyDb({ dbId: "db-1", revision: "r-000000000000", deviceId: "d-other", now: NOW });
			const categories = new Map(db.categories);
			categories.set(WORK, list(WORK, "Work", "V1"));
			const tasks = new Map<string, Task>();
			const syncLinks = new Map<string, SyncLink>([[`list:${WORK}`, listLink(WORK, project.id)]]);
			for (let i = 0; i < 999; i++) {
				const t = makeTask(uuid(i), { title: `Open ${i}`, categoryId: WORK, sortKey: `V${i.toString(36).padStart(4, "0")}` });
				tasks.set(t.id, t);
				const made = tt.add(project.id, { title: t.title });
				const base = fieldHashes({ title: t.title, status: "open", priority: 0, date: null, parent: null, section: null, tags: [] });
				syncLinks.set(`task:${t.id}`, { kind: "task", logwellId: t.id, ttId: made.id, ttProjectId: project.id, etag: made.etag ?? null, base, noteBySync: false, lastPulledAt: null, modifiedAt: NOW });
			}
			const s = await syncHarness(serializeDb({ ...db, categories, tasks, syncLinks }), tt);
			tt.add(project.id, { title: "Added in TickTick" });
			const r = await s.sync.sync();
			expect(r.ok).toBe(true);
			expect(s.tasks("Added in TickTick")).toHaveLength(1);
			expect(openIn(s.h, WORK)).toBe(1000);
			await refused(s.h.app.tasks.create({ title: "Local one", categoryId: WORK }));
		});
	});
});

describe("deletions", () => {
	// Deletions both ways and the confirmation threshold.

	async function withTasks(n: number): Promise<SyncHarness & { listId: string; projectId: string; ids: string[] }> {
		const s = await syncHarness();
		const { listId, projectId } = await linkedList(s);
		const ids: string[] = [];
		for (let i = 1; i <= n; i++) ids.push((await s.h.app.tasks.create({ title: `Errand ${i}`, categoryId: listId })).task.id);
		await s.sync.sync();
		s.tick();
		return Object.assign(s, { listId, projectId, ids });
	}

	describe("deleted in Logwell (SYNC-08)", () => {
		it("deletes the TickTick task without asking; a task restored from Trash is created there again", async () => {
			const s = await withTasks(1);
			const ttId = s.ttIdOf("Errand 1");
			const entry = await s.h.app.tasks.delete(s.ids[0]!);
			const r = await s.sync.sync();
			expect(r.ok).toBe(true);
			expect(s.tt.count("deleteTask")).toBe(1);
			expect(s.tt.live(s.projectId)).toHaveLength(0);
			expect(s.link("task", s.ids[0]!)).toBeUndefined();
			s.tick();
			await s.h.app.tasks.restore(entry.batchId);
			await s.sync.sync();
			const again = s.tt.live(s.projectId);
			expect(again.map((t) => t.title)).toEqual(["Errand 1"]);
			expect(again[0]?.id).not.toBe(ttId);
		});
	});

	describe("removed by an undo", () => {
		it("undoing the create of a synced task deletes its TickTick copy on the next sync", async () => {
			const s = await withTasks(1);
			const { task } = await s.h.app.tasks.create({ title: "Buy milk", categoryId: s.listId });
			await s.sync.sync();
			s.tick();
			const ttId = s.ttIdOf("Buy milk");
			expect(await s.h.app.store.undo()).toBe("Create task");
			await s.sync.sync();
			expect(s.tt.calls).toContain(`deleteTask:${ttId}`);
			expect(s.link("task", task.id)).toBeUndefined();
			expect(s.tt.live(s.projectId).map((t) => t.title)).toEqual(["Errand 1"]);
		});

		it("a pendingDelete marking that fails is retried at the start of the next sync", async () => {
			const s = await oneSyncedTask("Buy milk");
			const store = s.h.app.store;
			const run = store.run.bind(store);
			let failOnce = true;
			const failing: typeof store.run = (label, fn, options) => {
				if (failOnce && label === TICKTICK_LINKS_LABEL) {
					failOnce = false;
					return Promise.reject(new Error("the write failed"));
				}
				return run(label, fn, options);
			};
			store.run = failing;
			await store.undo();
			await new Promise((r) => setTimeout(r, 0));
			expect(failOnce).toBe(false);
			expect(s.link("task", s.id)?.pendingDelete).toBeUndefined();
			await s.sync.sync();
			expect(s.tt.calls).toContain(`deleteTask:${s.ttId}`);
			expect(s.link("task", s.id)).toBeUndefined();
			expect(s.tt.live(s.projectId)).toHaveLength(0);
		});
	});

	describe("a deleted linked list", () => {
		it("#110: deleting a linked list unlinks it; its tasks, now in an Inbox that does not sync, are deleted in TickTick", async () => {
			const s = await withTasks(1);
			const id = s.ids[0]!;
			const section = await s.h.app.sections.create(s.listId, "Calls");
			await s.h.app.tasks.update(id, { sectionId: section.id });
			await s.sync.sync();
			s.tick();
			const ttId = s.ttIdOf("Errand 1");
			expect(s.link("section", section.id)).toBeDefined();
			await s.h.app.categories.delete(s.listId);
			expect([...s.h.app.store.state.syncLinks.values()].filter((l) => l.kind !== "task")).toEqual([]);
			const r = await s.sync.sync();
			expect(r.ok).toBe(true);
			expect(s.tt.calls).toContain(`deleteTask:${ttId}`);
			expect(s.tt.live(s.projectId)).toHaveLength(0);
			expect(s.task("Errand 1")).toMatchObject({ id, categoryId: INBOX_ID });
			expect(s.h.app.store.state.syncLinks.size).toBe(0);
			// The TickTick list is free for another list.
			const other = await s.h.app.categories.create("Errands");
			expect((await s.sync.applyFirstSync(other.id, s.projectId)).ok).toBe(true);
		});

		it("#110: the tasks of a deleted linked list move in TickTick to a linked Inbox, once", async () => {
			const s = await syncHarness();
			const inbox = s.tt.addInbox();
			await s.sync.applyFirstSync(INBOX_ID, "inbox");
			const { listId, projectId } = await linkedList(s);
			await s.h.app.tasks.create({ title: "Errand 1", categoryId: listId });
			await s.sync.sync();
			s.tick();
			const ttId = s.ttIdOf("Errand 1");
			s.tt.edit(ttId, { priority: 5 });
			await s.h.app.categories.delete(listId);
			const r = await s.sync.sync();
			expect(r.ok).toBe(true);
			expect(s.tt.get(ttId)?.projectId).toBe(inbox.id);
			expect(s.tt.live(projectId)).toHaveLength(0);
			expect(s.link("task", s.task("Errand 1").id)).toMatchObject({ ttId, ttProjectId: "inbox" });
			// TickTick's edit since the last sync came in; nothing was created twice.
			expect(s.task("Errand 1").priority).toBe(1);
			s.tick();
			await s.sync.sync();
			expect(s.tt.live(inbox.id).map((t) => t.title)).toEqual(["Errand 1"]);
			expect(s.tasks("Errand 1")).toHaveLength(1);
		});

		it("#110: when the deleted list's TickTick list is gone too, only the links of its tasks go", async () => {
			const s = await withTasks(1);
			await s.h.app.categories.delete(s.listId);
			s.tt.projects.delete(s.projectId);
			const r = await s.sync.sync();
			expect(r.ok).toBe(true);
			expect(s.h.app.store.state.syncLinks.size).toBe(0);
			expect(s.tasks("Errand 1")).toHaveLength(1);
		});

		it("#110: undoing the delete links the list again, and nothing changes in TickTick", async () => {
			const s = await withTasks(1);
			const before = s.link("list", s.listId);
			await s.h.app.categories.delete(s.listId);
			await s.h.app.store.undo();
			expect(s.link("list", s.listId)).toEqual(before);
			const r = await s.sync.sync();
			expect(r.ok).toBe(true);
			expect(s.tt.count("deleteTask")).toBe(0);
			expect(s.tt.live(s.projectId).map((t) => t.title)).toEqual(["Errand 1"]);
		});

		it("#110: a list link left by a list deleted with an earlier version goes at the next sync, and its tasks follow", async () => {
			const s = await withTasks(1);
			const ttId = s.ttIdOf("Errand 1");
			// The delete as an earlier version wrote it: the tasks move to the Inbox, the links stay.
			await s.h.app.store.run("seed", (tx) => {
				for (const t of tx.all("tasks")) tx.put("tasks", { ...t, categoryId: INBOX_ID });
				tx.remove("categories", s.listId);
			});
			const r = await s.sync.sync();
			expect(r.ok).toBe(true);
			expect(s.tt.calls).toContain(`deleteTask:${ttId}`);
			expect(s.h.app.store.state.syncLinks.size).toBe(0);
		});
	});

	describe("a TickTick list that no longer exists", () => {
		it("#111: its linked list is skipped with a failure naming it, its tasks and links stay, and the other lists keep syncing", async () => {
			const s = await withTasks(2);
			const home = await linkedList(s, "Home");
			await s.h.app.tasks.create({ title: "Water plants", categoryId: home.listId });
			await s.sync.sync();
			s.tick();
			const ofWork = () => [...s.h.app.store.state.syncLinks.values()].filter((l) => l.logwellId === s.listId || l.ttProjectId === s.projectId);
			const before = ofWork();
			s.tt.projects.delete(s.projectId);
			// A new task in the other list, and a task moved from it into the list whose TickTick list is gone.
			await s.h.app.tasks.create({ title: "Buy soil", categoryId: home.listId });
			await s.h.app.tasks.update(s.task("Water plants").id, { categoryId: s.listId });
			const r = await s.sync.sync();
			expect(r.ok).toBe(false);
			expect(r.failures).toEqual([{ listId: s.listId, listName: "Work", kind: "list-gone", message: 'The TickTick list linked to "Work" no longer exists.', retryAfterSec: null }]);
			expect(s.tt.live(home.projectId).map((t) => t.title).sort()).toEqual(["Buy soil", "Water plants"]);
			expect(s.tt.count("deleteTask")).toBe(0);
			expect(s.tasks("Errand 1")).toHaveLength(1);
			expect(ofWork()).toEqual(before);
			// Unlinked, it no longer stops the sync.
			await s.sync.unlinkList(s.listId);
			expect((await s.sync.sync()).ok).toBe(true);
		});
	});

	describe("order of the push", () => {
		it("deletes before it creates: a refused create does not block a deletion", async () => {
			const s = await withTasks(1);
			const ttId = s.ttIdOf("Errand 1");
			await s.h.app.tasks.delete(s.ids[0]!);
			await s.h.app.tasks.create({ title: "One too many", categoryId: s.listId });
			s.tt.fail("createTask", new TickTickError("bad-response", "TickTick: unexpected answer (HTTP 400)", { status: 400 }));
			const r = await s.sync.sync();
			expect(r.error).toMatchObject({ kind: "bad-response" });
			expect(s.tt.calls).toContain(`deleteTask:${ttId}`);
			expect(s.link("task", s.ids[0]!)).toBeUndefined();
		});
	});

	describe("a list at TickTick's open-task limit", () => {
		it("sends what frees room first: deletes, then completions, then the creates fit", async () => {
			const s = await withTasks(99);
			s.tt.openLimit = 99;
			await s.h.app.tasks.complete(s.ids[0]!);
			await s.h.app.tasks.complete(s.ids[1]!);
			await s.h.app.tasks.delete(s.ids[2]!);
			for (const title of ["New 1", "New 2", "New 3"]) await s.h.app.tasks.create({ title, categoryId: s.listId });
			const from = s.tt.calls.length;
			const r = await s.sync.sync();
			expect(r.ok).toBe(true);
			const calls = s.tt.calls.slice(from).map((c) => c.split(":")[0]);
			const firstCreate = calls.indexOf("createTask");
			expect(calls.indexOf("deleteTask")).toBeLessThan(calls.indexOf("batchTasks"));
			expect(calls.indexOf("batchTasks")).toBeLessThan(firstCreate);
			expect(calls.filter((c) => c === "createTask")).toHaveLength(3);
			expect(s.tt.live(s.projectId).filter((t) => (t.status ?? 0) === 0)).toHaveLength(99);
		});

		it("#137: a server error on a list at 99 open tasks names the free plan as the likely cause, with TickTick's reason", async () => {
			const s = await withTasks(99);
			s.tt.openLimit = 99;
			await s.h.app.tasks.create({ title: "New 1", categoryId: s.listId });
			const r = await s.sync.sync();
			expect(r.error?.kind).toBe("list-limit");
			expect(r.error?.message).toMatch(/refused the change \(.+\)\. It has 99 open tasks, and TickTick's free plan allows 99 per list, so that limit is the likely cause; on a paid plan it is a TickTick error\.$/u);
		});

		it("a refused create leaves the frees already sent", async () => {
			const s = await withTasks(99);
			s.tt.openLimit = 99;
			await s.h.app.tasks.complete(s.ids[0]!);
			await s.h.app.tasks.create({ title: "New 1", categoryId: s.listId });
			await s.h.app.tasks.create({ title: "New 2", categoryId: s.listId });
			const r = await s.sync.sync();
			expect(r.error).toMatchObject({ kind: "list-limit", listId: s.listId });
			expect(s.tt.get(s.ttIdOf("Errand 1"))?.status).toBe(2);
			expect(s.tt.live(s.projectId).filter((t) => t.title.startsWith("New"))).toHaveLength(1);
		});
	});

	describe("a purge while a push is in flight", () => {
		it("keeps pendingDelete: the end of the sync does not overwrite the link of a task that is gone", async () => {
			const s = await withTasks(2);
			const ttId = s.ttIdOf("Errand 1");
			await s.h.app.tasks.update(s.ids[0]!, { title: "Errand 1 renamed" });
			let release!: () => void;
			let reached!: () => void;
			const atBatch = new Promise<void>((r) => (reached = r));
			s.tt.onCall = (m) => {
				if (m !== "batchTasks") return;
				reached();
				return new Promise<void>((r) => (release = r));
			};
			const running = s.sync.sync();
			await atBatch;
			const entry = await s.h.app.tasks.delete(s.ids[0]!);
			await s.h.app.tasks.purge(entry.batchId);
			release();
			await running;
			expect(s.link("task", s.ids[0]!)?.pendingDelete).toBe(true);
			s.tt.onCall = null;
			s.tick();
			await s.sync.sync();
			expect(s.tt.calls).toContain(`deleteTask:${ttId}`);
			expect(s.link("task", s.ids[0]!)).toBeUndefined();
		});
	});

	describe("purged from Trash before a sync (SYNC-08)", () => {
		it("marks the link pendingDelete in the purge command; the next sync deletes the TickTick copy", async () => {
			const s = await withTasks(2);
			const ttId = s.ttIdOf("Errand 1");
			const entry = await s.h.app.tasks.delete(s.ids[0]!);
			await s.h.app.tasks.purge(entry.batchId);
			expect(s.link("task", s.ids[0]!)?.pendingDelete).toBe(true);
			const r = await s.sync.sync();
			expect(r.ok).toBe(true);
			expect(s.tt.calls).toContain(`deleteTask:${ttId}`);
			expect(s.link("task", s.ids[0]!)).toBeUndefined();
			expect(s.tt.live(s.projectId).map((t) => t.title)).toEqual(["Errand 2"]);
		});

		it("does the same for Empty trash and for expired entries", async () => {
			const s = await withTasks(3);
			await s.h.app.tasks.delete(s.ids[0]!);
			await s.h.app.tasks.emptyTrash();
			expect(s.link("task", s.ids[0]!)?.pendingDelete).toBe(true);
			await s.h.app.tasks.delete(s.ids[1]!);
			s.tick(31 * 24 * 3600 * 1000);
			expect(await s.h.app.tasks.purgeExpired()).toBe(1);
			expect(s.link("task", s.ids[1]!)?.pendingDelete).toBe(true);
			await s.sync.sync();
			expect(s.tt.live(s.projectId).map((t) => t.title)).toEqual(["Errand 3"]);
			expect(s.link("task", s.ids[0]!)).toBeUndefined();
			expect(s.link("task", s.ids[1]!)).toBeUndefined();
		});
	});

	describe("missing from TickTick (SYNC-08)", () => {
		it("moves fewer than 5 missing tasks of a list to Trash and removes their links", async () => {
			const s = await withTasks(6);
			for (const t of ["Errand 1", "Errand 2", "Errand 3", "Errand 4"]) s.tt.remove(s.ttIdOf(t));
			const r = await s.sync.sync();
			expect(r.ok).toBe(true);
			expect(r.needsConfirmation).toEqual([]);
			expect(s.h.app.store.state.tasks.size).toBe(2);
			expect([...s.h.app.store.state.trash.values()].flatMap((e) => e.tasks.map((t) => t.title)).sort()).toEqual(["Errand 1", "Errand 2", "Errand 3", "Errand 4"]);
			for (const id of s.ids.slice(0, 4)) expect(s.link("task", id)).toBeUndefined();
			// A background pull is not on the undo stack.
			expect(s.h.app.store.undoLabel).not.toBe(TICKTICK_SYNC_LABEL);
		});

		it("asks first for 5 or more: nothing applied, links kept; the confirmed Move to Trash is one undo step", async () => {
			const s = await withTasks(6);
			for (const id of s.ids.slice(0, 5)) s.tt.remove(s.link("task", id)!.ttId);
			const r = await s.sync.sync();
			expect(r.ok).toBe(true);
			expect(r.needsConfirmation).toHaveLength(1);
			expect(r.needsConfirmation[0]).toMatchObject({ listId: s.listId, reason: "many" });
			expect(r.needsConfirmation[0]!.tasks.map((t) => t.title).sort()).toEqual(["Errand 1", "Errand 2", "Errand 3", "Errand 4", "Errand 5"]);
			expect(s.h.app.store.state.tasks.size).toBe(6);
			expect(s.h.app.store.state.trash.size).toBe(0);
			for (const id of s.ids) expect(s.link("task", id)).toBeDefined();
			const w = await s.sync.trashMissing(s.listId, r.needsConfirmation[0]!.tasks.map((t) => t.id));
			expect(w).toEqual({ wrote: true, label: TICKTICK_TRASH_LABEL });
			expect(TICKTICK_TRASH_LABEL).not.toBe(TICKTICK_SYNC_LABEL);
			expect(s.h.app.store.state.tasks.size).toBe(1);
			expect(s.h.app.store.undoLabel).toBe(TICKTICK_TRASH_LABEL);
			for (const id of s.ids.slice(0, 5)) expect(s.link("task", id)).toBeUndefined();
			// Undo brings them back unlinked; the next sync creates them in TickTick again.
			expect(await s.h.app.store.undo()).toBe(TICKTICK_TRASH_LABEL);
			expect(s.h.app.store.state.tasks.size).toBe(6);
			s.tick();
			await s.sync.sync();
			expect(s.tt.live(s.projectId)).toHaveLength(6);
			for (const id of s.ids) expect(s.link("task", id)).toBeDefined();
		});

		it("asks first when a project comes back empty, even for one task", async () => {
			const s = await withTasks(2);
			for (const id of s.ids) s.tt.remove(s.link("task", id)!.ttId);
			const r = await s.sync.sync();
			expect(r.needsConfirmation).toHaveLength(1);
			expect(r.needsConfirmation[0]).toMatchObject({ listId: s.listId, reason: "emptied" });
			expect(s.h.app.store.state.tasks.size).toBe(2);
			// Each was looked up: neither completed nor won't do.
			expect(s.tt.count("getTask")).toBe(2);
		});

		it("#119: a task gone from TickTick goes to Trash alone; its subtasks that are not gone stay as top-level tasks", async () => {
			const s = await withTasks(3);
			const [p, q] = s.ids as [string, string, string];
			const qTt = s.ttIdOf("Errand 2");
			// Q made a subtask in Logwell and not sent yet; R a new subtask never sent.
			await s.h.app.tasks.setParent(q, p);
			const r = await s.h.app.tasks.create({ title: "New step", parentId: p });
			s.tt.remove(s.ttIdOf("Errand 1"));
			await s.sync.sync();
			expect([...s.h.app.store.state.trash.values()].flatMap((e) => e.tasks.map((t) => t.title))).toEqual(["Errand 1"]);
			expect(s.h.app.store.state.tasks.get(q)).toMatchObject({ parentId: null, categoryId: s.listId });
			expect(s.h.app.store.state.tasks.get(r.task.id)).toMatchObject({ parentId: null, categoryId: s.listId });
			s.tick();
			await s.sync.sync();
			expect(s.tt.count("deleteTask")).toBe(0);
			expect(s.tt.get(qTt)).toMatchObject({ title: "Errand 2", status: 0 });
			expect(s.tt.live(s.projectId).map((t) => t.id)).toContain(qTt);
			expect(s.tt.findByTitle("New step")?.parentId ?? "").toBe("");
		});

		it("#119: the confirmed Move to Trash keeps a subtask that is not gone, as a top-level task, and Undo nests it again", async () => {
			const s = await withTasks(6);
			for (const id of s.ids.slice(0, 5)) s.tt.remove(s.link("task", id)!.ttId);
			const res = await s.sync.sync();
			expect(res.needsConfirmation[0]!.tasks).toHaveLength(5);
			// Added while the question is open.
			const sub = await s.h.app.tasks.create({ title: "Keep me", parentId: s.ids[0]! });
			await s.sync.trashMissing(s.listId, res.needsConfirmation[0]!.tasks.map((t) => t.id));
			expect(s.h.app.store.state.tasks.get(sub.task.id)).toMatchObject({ parentId: null, categoryId: s.listId });
			expect(await s.h.app.store.undo()).toBe(TICKTICK_TRASH_LABEL);
			expect(s.h.app.store.state.tasks.get(sub.task.id)?.parentId).toBe(s.ids[0]);
		});

		it("#123: an open task TickTick left out of its list's data, unchanged there, is not gone: no Trash, no second copy", async () => {
			const s = await withTasks(3);
			const ttId = s.ttIdOf("Errand 1");
			s.tt.omitted.add(ttId);
			const r = await s.sync.sync();
			expect(r.ok).toBe(true);
			expect(r.needsConfirmation).toEqual([]);
			expect(s.tt.count("getTask")).toBe(1);
			expect(s.h.app.store.state.trash.size).toBe(0);
			expect(s.link("task", s.ids[0]!)?.ttId).toBe(ttId);
			// A Logwell edit still goes up while it is left out.
			s.tick();
			await s.h.app.tasks.update(s.ids[0]!, { priority: 1 });
			await s.sync.sync();
			expect(s.tt.get(ttId)?.priority).toBe(5);
			s.tt.omitted.delete(ttId);
			s.tick();
			await s.sync.sync();
			expect(s.tasks("Errand 1")).toHaveLength(1);
			expect(s.h.app.store.state.trash.size).toBe(0);
		});

		it("keeps a deleted task's note", async () => {
			const s = await withTasks(1);
			s.h.notes.files.set("Task notes/Errand 1.md", "my notes");
			await s.h.app.tasks.linkNote(s.ids[0]!, "Task notes/Errand 1.md");
			await s.sync.sync();
			s.tick();
			const other = await s.h.app.tasks.create({ title: "Stays", categoryId: s.listId });
			await s.sync.sync();
			s.tick();
			s.tt.remove(s.ttIdOf("Errand 1"));
			await s.sync.sync();
			expect(s.h.app.store.state.tasks.has(other.task.id)).toBe(true);
			const trashed = [...s.h.app.store.state.trash.values()][0]?.tasks[0];
			expect(trashed?.descriptionNote?.path).toBe("Task notes/Errand 1.md");
			expect(s.h.notes.files.get("Task notes/Errand 1.md")).toBe("my notes");
		});
	});
});

describe("the Inbox", () => {
	// TickTick's Inbox is linked under the alias `inbox`, but its tasks carry the real id
	// `inbox<digits>`. The engine must treat both as one project: no duplicate import, moves, completions, deletes.

	async function withInbox(): Promise<SyncHarness & { inboxId: string }> {
		const s = await syncHarness();
		const inbox = s.tt.addInbox();
		return Object.assign(s, { inboxId: inbox.id });
	}

	async function linkInbox(s: SyncHarness) {
		const r = await s.sync.applyFirstSync(INBOX_ID, "inbox");
		s.tick();
		return r;
	}

	describe("the Inbox as a linked list", () => {
		it("a first sync of an empty Inbox with an empty list links it and fails nothing", async () => {
			const s = await withInbox();
			const r = await linkInbox(s);
			expect(r.ok).toBe(true);
			expect(r.failures).toEqual([]);
			expect(s.link("list", INBOX_ID)?.ttId).toBe("inbox");
			const again = await s.sync.sync();
			expect(again.ok).toBe(true);
			expect(s.tt.calls.filter((c) => c.startsWith("getProjectData"))).toEqual(["getProjectData:inbox", "getProjectData:inbox", "getProjectData:inbox"]);
		});

		it("previews an Inbox that already has tasks, counting them once", async () => {
			const s = await withInbox();
			s.tt.add(s.inboxId, { title: "Call the bank" });
			await s.h.app.tasks.create({ title: "Pay rent" });
			const plan = await s.sync.planFirstSync(INBOX_ID, "inbox");
			expect(plan).toMatchObject({ toLogwell: 1, toTickTick: 1 });
		});

		it("imports the tasks of the Inbox once, whatever spelling their project id has", async () => {
			const s = await withInbox();
			s.tt.add(s.inboxId, { title: "Call the bank" });
			s.tt.add(s.inboxId, { title: "Book the dentist" });
			await linkInbox(s);
			expect(s.tasks("Call the bank")).toHaveLength(1);
			expect(s.tasks("Book the dentist")).toHaveLength(1);
			expect(s.link("task", s.task("Call the bank").id)?.ttProjectId).toBe("inbox");
			for (let i = 0; i < 3; i++) {
				s.tick();
				await s.sync.sync();
			}
			expect(s.h.app.store.state.tasks.size).toBe(2);
			expect(s.tt.live(s.inboxId)).toHaveLength(2);
		});

		it("sends a Logwell Inbox task to an empty Inbox, then keeps working with the real id", async () => {
			const s = await withInbox();
			await s.h.app.tasks.create({ title: "Pay rent" });
			await linkInbox(s);
			expect(s.tt.live(s.inboxId).map((t) => t.title)).toEqual(["Pay rent"]);
			// An edit and a new task after the real id was seen.
			s.tick();
			await s.h.app.tasks.update(s.task("Pay rent").id, { title: "Pay the rent" });
			await s.h.app.tasks.create({ title: "Buy milk" });
			const r = await s.sync.sync();
			expect(r.ok).toBe(true);
			expect(s.tt.live(s.inboxId).map((t) => t.title).sort()).toEqual(["Buy milk", "Pay the rent"]);
			expect(s.h.app.store.state.tasks.size).toBe(2);
		});

		it("one round trip: an edit, a completion, a delete and a move each way, as for any linked list", async () => {
			const s = await withInbox();
			for (const title of ["Call the bank", "Book the dentist", "Pay rent", "Buy milk", "Water plants", "Fix the bike"]) s.tt.add(s.inboxId, { title });
			await linkInbox(s);
			const { listId, projectId } = await linkedList(s, "Work");
			const sync = async () => {
				s.tick();
				expect((await s.sync.sync()).ok).toBe(true);
			};

			// An edit made in TickTick is pulled and not pushed back.
			s.tt.edit(s.ttIdOf("Call the bank"), { title: "Call the bank today" });
			await sync();
			expect(s.tasks("Call the bank today")).toHaveLength(1);
			expect(s.tt.count("updateTask")).toBe(0);

			// A completion each way.
			s.tt.edit(s.ttIdOf("Call the bank today"), { status: 2 });
			await s.h.app.tasks.complete(s.task("Book the dentist").id);
			await sync();
			expect(s.task("Call the bank today").status).toBe("completed");
			expect(s.tt.findByTitle("Book the dentist")?.status).toBe(2);
			expect(s.tt.calls.filter((c) => c.startsWith("listCompleted"))).toContain("listCompleted:inbox");

			// A delete each way: deleted in TickTick, trashed in Logwell.
			const gone = s.ttIdOf("Pay rent");
			const deleted = s.ttIdOf("Buy milk");
			await s.h.app.tasks.delete(s.task("Buy milk").id);
			s.tt.remove(gone);
			await sync();
			expect(s.tasks("Pay rent")).toHaveLength(0);
			expect(s.tt.live(s.inboxId).map((t) => t.id)).not.toContain(deleted);
			await sync();

			// A move into another linked list each way, and both back.
			await s.h.app.tasks.update(s.task("Water plants").id, { categoryId: listId });
			s.tt.moveTo(s.ttIdOf("Fix the bike"), projectId);
			await sync();
			expect(s.tt.findByTitle("Water plants")?.projectId).toBe(projectId);
			expect(s.task("Fix the bike").categoryId).toBe(listId);
			expect(s.link("task", s.task("Water plants").id)?.ttProjectId).toBe(projectId);
			await s.h.app.tasks.update(s.task("Water plants").id, { categoryId: INBOX_ID });
			s.tt.moveTo(s.ttIdOf("Fix the bike"), s.inboxId);
			await sync();
			expect(s.tt.findByTitle("Water plants")?.projectId).toBe(s.inboxId);
			expect(s.task("Fix the bike").categoryId).toBe(INBOX_ID);
			expect(s.link("task", s.task("Fix the bike").id)?.ttProjectId).toBe("inbox");

			// Nothing came in or went up twice.
			expect(s.h.app.store.state.tasks.size).toBe(4);
			expect(s.tt.live(s.inboxId).map((t) => t.title).sort()).toEqual(["Book the dentist", "Call the bank today", "Fix the bike", "Water plants"]);
		});

		it("a project listed under an Inbox id is not a second project", async () => {
			const s = await withInbox();
			await linkInbox(s);
			const api = new InboxAliasApi(s.tt);
			expect((await api.listProjects()).map((p) => p.id)).toEqual([]);
			expect(s.h.app.store.state.syncLinks.has(syncLinkId("list", INBOX_ID))).toBe(true);
		});

		it("refuses to link the Inbox twice, in either spelling", async () => {
			const s = await withInbox();
			await linkInbox(s);
			const other = await s.h.app.categories.create("Work");
			await expect(s.sync.planFirstSync(other.id, "inbox")).rejects.toThrow("already linked to another list");
		});
	});

	describe("InboxAliasApi", () => {
		function spy() {
			const tt = new FakeTickTick({ now: () => new Date("2026-10-01T10:00:00Z") });
			const inbox = tt.addInbox();
			return { tt, inbox, api: new InboxAliasApi(tt) };
		}

		it("returns the alias for every id, tasks, columns and project included", async () => {
			const { tt, inbox, api } = spy();
			tt.add(inbox.id, { title: "A" });
			tt.addColumn(inbox.id, "Later");
			const data = await api.getProjectData("inbox");
			expect(data.project.id).toBe("inbox");
			expect(data.tasks.map((t) => t.projectId)).toEqual(["inbox"]);
			expect(data.columns.map((c) => c.projectId)).toEqual(["inbox"]);
			expect((await api.getProjectData(inbox.id)).tasks[0]!.projectId).toBe("inbox");
		});

		it("sends a create with no project while the real id is unknown, and the real id afterwards", async () => {
			const { tt, inbox, api } = spy();
			const first = await api.createTask({ projectId: "inbox", title: "A" });
			expect(first.projectId).toBe("inbox");
			expect(tt.tasks.get([...tt.tasks.keys()][0]!)?.projectId).toBe(inbox.id);
			await api.updateTask({ id: first.id, projectId: "inbox", title: "A2" });
			await api.deleteTask("inbox", first.id);
			expect(tt.calls.filter((c) => c.startsWith("updateTask") || c.startsWith("deleteTask"))).toHaveLength(2);
		});

		it("leaves ids of other projects as they are", async () => {
			const { tt, api } = spy();
			const work = tt.addProject("Work");
			const made = await api.createTask({ projectId: work.id, title: "A" });
			expect(made.projectId).toBe(work.id);
			expect((await api.getProjectData(work.id)).project.id).toBe(work.id);
		});
	});

	/** A new engine over the same store: what a reload leaves (the real Inbox id is not known yet). */
	function reloaded(s: SyncHarness): SyncService {
		return new SyncService(s.h.app.store, s.h.app.tasks, s.h.app.sections, { zone: () => "Europe/Berlin" }, s.tt);
	}

	describe("the Inbox's real id is not known yet (probed against the real API)", () => {
		it("a Logwell Inbox with a section is pushed into an empty TickTick Inbox: the task first, then the column", async () => {
			const s = await withInbox();
			const sec = await s.h.app.sections.create(INBOX_ID, "Errands");
			await s.h.app.tasks.create({ title: "Call the bank", sectionId: sec.id });
			const r = await s.sync.applyFirstSync(INBOX_ID, "inbox");
			expect(r.ok).toBe(true);
			expect(r.failures).toEqual([]);
			const made = s.tt.findByTitle("Call the bank")!;
			expect(made.projectId).toBe(s.inboxId);
			const column = [...s.tt.columns.values()].find((c) => c.name === "Errands")!;
			expect(column.projectId).toBe(s.inboxId);
			expect(made.columnId).toBe(column.id);
			// The alias never went to the column call.
			expect(s.tt.calls.filter((c) => c.startsWith("createColumn"))).toEqual(["createColumn:Errands"]);
			// And the next sync has nothing to do: no duplicate, no section change.
			s.tick();
			const again = await s.sync.sync();
			expect(again.ok).toBe(true);
			expect(again.pushed).toBe(0);
			expect(s.tt.live(s.inboxId)).toHaveLength(1);
			expect(s.task("Call the bank").sectionId).toBe(sec.id);
		});

		it("a second task of the same section reuses the column", async () => {
			const s = await withInbox();
			const sec = await s.h.app.sections.create(INBOX_ID, "Errands");
			await s.h.app.tasks.create({ title: "Call the bank", sectionId: sec.id });
			await s.h.app.tasks.create({ title: "Pay rent", sectionId: sec.id });
			expect((await s.sync.applyFirstSync(INBOX_ID, "inbox")).ok).toBe(true);
			expect([...s.tt.columns.values()].filter((c) => c.name === "Errands")).toHaveLength(1);
			const column = [...s.tt.columns.values()][0]!;
			expect(s.tt.live(s.inboxId).map((t) => t.columnId)).toEqual([column.id, column.id]);
		});

		it("a failed column follow-up leaves the task linked as not sectioned, and the next sync sets the column", async () => {
			const s = await withInbox();
			const sec = await s.h.app.sections.create(INBOX_ID, "Errands");
			await s.h.app.tasks.create({ title: "Call the bank", sectionId: sec.id });
			s.tt.fail("createColumn", new TickTickError("network", "TickTick: no answer (network error)."));
			const first = await s.sync.applyFirstSync(INBOX_ID, "inbox");
			expect(first.ok).toBe(false);
			expect(s.tt.live(s.inboxId)).toHaveLength(1);
			expect(s.link("task", s.task("Call the bank").id)).toBeDefined();
			s.tick();
			const next = await s.sync.sync();
			expect(next.ok).toBe(true);
			expect(s.tt.live(s.inboxId)).toHaveLength(1);
			expect(s.tt.findByTitle("Call the bank")?.columnId).toBeDefined();
			expect(s.task("Call the bank").sectionId).toBe(sec.id);
		});

		it("moving a task into an empty Inbox and editing it in one sync works after a reload", async () => {
			const s = await withInbox();
			const { listId } = await linkedList(s, "Work");
			await s.h.app.tasks.create({ title: "Call the bank", categoryId: listId });
			await s.sync.sync();
			expect((await s.sync.applyFirstSync(INBOX_ID, "inbox")).ok).toBe(true);
			s.tick();
			const fresh = reloaded(s);
			await s.h.app.tasks.update(s.task("Call the bank").id, { categoryId: INBOX_ID, title: "Call the bank today" });
			const r = await fresh.sync();
			expect(r.ok).toBe(true);
			expect(r.failures).toEqual([]);
			expect(s.tt.findByTitle("Call the bank today")?.projectId).toBe(s.inboxId);
			expect(s.tt.calls.filter((c) => c.startsWith("batchTasks")).length).toBeGreaterThan(0);
		});

		it("deleting a completed Inbox task after a reload with no open task in the Inbox works", async () => {
			const s = await withInbox();
			s.tt.add(s.inboxId, { title: "Pay rent" });
			await s.sync.applyFirstSync(INBOX_ID, "inbox");
			s.tick();
			await s.h.app.tasks.complete(s.task("Pay rent").id);
			await s.sync.sync();
			const ttId = s.ttIdOf("Pay rent");
			expect(s.tt.tasks.get(ttId)?.status).toBe(2);
			s.tick(30 * 24 * 3600_000);
			await s.sync.sync();
			s.tick(30 * 24 * 3600_000);
			const fresh = reloaded(s);
			await s.h.app.tasks.delete(s.task("Pay rent").id);
			const r = await fresh.sync();
			expect(r.ok).toBe(true);
			expect(r.failures).toEqual([]);
			expect(s.tt.tasks.get(ttId)?.deleted).toBe(true);
			expect(s.h.app.store.state.syncLinks.has(syncLinkId("task", ttId))).toBe(false);
		});

		it("a batch update never carries the alias, and a column is never created with it", async () => {
			const s = await withInbox();
			s.tt.add(s.inboxId, { title: "Call the bank" });
			await linkInbox(s);
			const batch = vi.spyOn(s.tt, "batchTasks");
			await s.h.app.tasks.update(s.task("Call the bank").id, { title: "Call the bank today" });
			s.tick();
			expect((await reloaded(s).sync()).ok).toBe(true);
			expect(batch).toHaveBeenCalled();
			for (const [b] of batch.mock.calls) for (const u of b.update ?? []) expect(u.projectId).toBe(s.inboxId);
		});

		it("an account whose default list is not the Inbox: the created task is moved to the Inbox at once", async () => {
			const s = await withInbox();
			const other = s.tt.addProject("Tasks");
			s.tt.noProjectGoesTo = other.id;
			await s.h.app.tasks.create({ title: "Pay rent" });
			const r = await s.sync.applyFirstSync(INBOX_ID, "inbox");
			expect(r.ok).toBe(true);
			const made = s.tt.findByTitle("Pay rent")!;
			expect(made.projectId).toBe(s.inboxId);
			expect(s.tt.live(other.id)).toHaveLength(0);
			expect(s.link("task", s.task("Pay rent").id)?.ttProjectId).toBe("inbox");
			s.tick();
			expect((await s.sync.sync()).pushed).toBe(0);
			expect(s.tt.live(s.inboxId)).toHaveLength(1);
		});

		it("when that move fails the stray copy is deleted, the write fails for the list and nothing is linked", async () => {
			const s = await withInbox();
			const other = s.tt.addProject("Tasks");
			s.tt.noProjectGoesTo = other.id;
			await s.h.app.tasks.create({ title: "Pay rent" });
			s.tt.fail("moveTasks", new TickTickError("server", "TickTick: server error"));
			const r = await s.sync.applyFirstSync(INBOX_ID, "inbox");
			expect(r.ok).toBe(false);
			expect(s.link("task", s.task("Pay rent").id)).toBeUndefined();
			expect(s.tt.live(other.id)).toHaveLength(0);
			expect(s.tt.live(s.inboxId)).toHaveLength(0);
			// The next sync creates it again, once.
			s.tick();
			expect((await s.sync.sync()).ok).toBe(true);
			expect(s.tt.live(s.inboxId).map((t) => t.title)).toEqual(["Pay rent"]);
		});
	});

	describe("a list link written with the real Inbox id by an early build", () => {
		it("is rewritten to the alias, and the sync then behaves as for a link to the alias", async () => {
			const s = await withInbox();
			s.tt.add(s.inboxId, { title: "Call the bank" });
			await s.h.app.tasks.create({ title: "Pay rent" });
			// Link as an early build did: the real id as the project.
			await s.h.app.store.run("test links", (tx) => {
				tx.put("syncLinks", { kind: "list", logwellId: INBOX_ID, ttId: s.inboxId, ttProjectId: null, etag: null, base: {}, noteBySync: false, lastPulledAt: null, modifiedAt: tx.now });
			}, { undoable: false });
			const first = await s.sync.sync();
			expect(first.ok).toBe(true);
			expect(s.link("list", INBOX_ID)?.ttId).toBe("inbox");
			for (let i = 0; i < 2; i++) {
				s.tick();
				expect((await s.sync.sync()).ok).toBe(true);
			}
			expect([...s.h.app.store.state.tasks.values()].map((t) => t.title).sort()).toEqual(["Call the bank", "Pay rent"]);
			expect(s.tt.live(s.inboxId).map((t) => t.title).sort()).toEqual(["Call the bank", "Pay rent"]);
			for (const l of s.h.app.store.state.syncLinks.values()) expect(l.ttProjectId === null || l.ttProjectId === "inbox").toBe(true);
		});

		it("is the same project as the alias when linking", async () => {
			const s = await withInbox();
			await linkInbox(s);
			const other = await s.h.app.categories.create("Work");
			await expect(s.sync.planFirstSync(other.id, s.inboxId)).rejects.toThrow("already linked to another list");
			// And a first sync given the real id stores the alias.
			const s2 = await withInbox();
			await s2.sync.applyFirstSync(INBOX_ID, s2.inboxId);
			expect(s2.link("list", INBOX_ID)?.ttId).toBe("inbox");
		});
	});

	describe("the Inbox wrapper respects a stopped sync", () => {
		async function movedIntoInboxAfterReload() {
			const s = await withInbox();
			const work = s.tt.addProject("Work");
			const wl = await s.h.app.categories.create("Work");
			await s.sync.applyFirstSync(wl.id, work.id);
			await linkInbox(s);
			await s.h.app.tasks.create({ title: "Call the bank", categoryId: wl.id });
			s.tick();
			await s.sync.sync();
			// A new engine (as after a reload) does not know the Inbox's real id yet.
			const fresh = new SyncService(s.h.app.store, s.h.app.tasks, s.h.app.sections, { zone: () => "Europe/Berlin" }, s.tt);
			await s.h.app.tasks.update(s.task("Call the bank").id, { categoryId: INBOX_ID, title: "Call the bank today" });
			s.tt.calls.length = 0;
			s.tick();
			return { s, fresh };
		}

		it("sends nothing after stop() while it learns the Inbox's real id", async () => {
			const { s, fresh } = await movedIntoInboxAfterReload();
			s.tt.onCall = (m) => {
				if (m === "getTask") fresh.stop();
			};
			const r = await fresh.sync();
			const afterLookup = s.tt.calls.slice(s.tt.calls.findIndex((c) => c.startsWith("getTask")) + 1);
			expect(afterLookup).toEqual([]);
			expect(r.ok).toBe(false);
		});

		it("stops learning the real id on a rate limit instead of trying more tasks", async () => {
			const { s, fresh } = await movedIntoInboxAfterReload();
			s.tt.fail("getTask", new TickTickError("rate-limited", "TickTick: too many requests.", { retryAfterSec: 60 }));
			const r = await fresh.sync();
			expect(r.ok).toBe(false);
			expect(s.tt.calls.filter((c) => c.startsWith("getTask"))).toHaveLength(1);
			expect(s.tt.calls.some((c) => c.startsWith("batchTasks"))).toBe(false);
		});
	});
});

describe("first sync backup and Keep", () => {
	// The first sync takes a `pre-sync` backup before it writes, and Keep for tasks
	// missing from TickTick: with 5 or more in a list they stay in Logwell only (link mode `localOnly`); for a project
	// that came back empty, Keep unlinks the list.

	const TITLES = ["Errand 1", "Errand 2", "Errand 3", "Errand 4", "Errand 5"];

	/** Work linked with the five errands and "Stays" synced, then the errands deleted in TickTick. */
	async function missingFive(s: SyncHarness) {
		const { listId, projectId } = await linkedList(s);
		for (const title of [...TITLES, "Stays"]) await s.h.app.tasks.create({ title, categoryId: listId });
		expect((await s.sync.sync()).ok).toBe(true);
		s.tick();
		const ttIds = TITLES.map((t) => s.ttIdOf(t));
		for (const id of ttIds) s.tt.remove(id);
		const r = await s.sync.sync();
		s.tick();
		expect(r.needsConfirmation).toHaveLength(1);
		expect(r.needsConfirmation[0]!.reason).toBe("many");
		return { listId, projectId, ttIds, pending: r.needsConfirmation[0]! };
	}

	const writes = (s: SyncHarness) => ["createTask", "deleteTask", "batchTasks", "moveTasks", "updateTask"].map((m) => s.tt.count(m as never)).reduce((a, b) => a + b, 0);

	describe("first sync backup (SYNC-10)", () => {
		it("takes a pre-sync snapshot of the database as it was, before any write", async () => {
			const s = await syncHarness();
			const list = await s.h.app.categories.create("Work");
			await s.h.app.tasks.create({ title: "Mine", categoryId: list.id });
			const project = s.tt.addProject("Work");
			s.tt.add(project.id, { title: "Theirs" });
			const r = await s.sync.applyFirstSync(list.id, project.id);
			expect(r.ok).toBe(true);
			const snaps = (await s.h.store.listSnapshots()).filter((b) => b.kind === "pre-sync");
			expect(snaps).toHaveLength(1);
			const before = load((await s.h.fs.read(snaps[0]!.path))!);
			expect(before.syncLinks.size).toBe(0);
			expect([...before.tasks.values()].map((t) => t.title)).toEqual(["Mine"]);
		});

		it("writes nothing when the snapshot cannot be taken", async () => {
			const s = await syncHarness();
			const list = await s.h.app.categories.create("Work");
			const project = s.tt.addProject("Work");
			s.tt.add(project.id, { title: "Theirs" });
			const state = s.h.app.store.state;
			s.h.fs.failNextWrite((p) => p.includes("/snapshots/pre-sync-"));
			await expect(s.sync.applyFirstSync(list.id, project.id)).rejects.toThrow();
			expect(s.h.app.store.state).toBe(state);
			expect(s.tt.count("createTask")).toBe(0);
		});
	});

	describe("Keep for tasks missing from TickTick (SYNC-08, D27)", () => {
		it("keeps 5 or more missing tasks in Logwell only: links become localOnly, nothing in the undo history", async () => {
			const s = await syncHarness();
			const { listId, pending } = await missingFive(s);
			const undo = s.h.app.store.undoLabel;
			const w = await s.sync.keepMissing(listId, pending.tasks.map((t) => t.id), "many");
			expect(w).toEqual({ wrote: true, label: TICKTICK_KEEP_LABEL });
			expect(s.h.app.store.undoLabel).toBe(undo);
			for (const t of TITLES) {
				expect(s.task(t).status).toBe("open");
				expect(s.link("task", s.task(t).id)?.mode).toBe("localOnly");
			}
			expect(s.link("task", s.task("Stays").id)?.mode).toBeUndefined();
		});

		it("a kept task is never pushed, deleted, looked up, re-created or asked about again, over several syncs", async () => {
			const s = await syncHarness();
			const { listId, ttIds, pending } = await missingFive(s);
			await s.sync.keepMissing(listId, pending.tasks.map((t) => t.id), "many");
			const before = writes(s);
			const lookups = s.tt.count("getTask");

			const r1 = await s.sync.sync();
			s.tick();
			expect(r1.needsConfirmation).toEqual([]);
			// Edits in Logwell are not sent.
			await s.h.app.tasks.update(s.task("Errand 1").id, { title: "Errand one" });
			await s.h.app.tasks.complete(s.task("Errand 2").id);
			const r2 = await s.sync.sync();
			s.tick();
			expect(r2.ok).toBe(true);
			expect(r2.needsConfirmation).toEqual([]);
			expect(writes(s)).toBe(before);
			expect(s.tt.count("getTask")).toBe(lookups);

			// Deleted and purged in Logwell: nothing is deleted in TickTick; only the link goes.
			const errand3 = s.task("Errand 3").id;
			const entry = await s.h.app.tasks.delete(errand3);
			await s.sync.sync();
			s.tick();
			await s.h.app.tasks.purge(entry.batchId);
			await s.sync.idle();
			await s.sync.sync();
			s.tick();
			expect(s.tt.count("deleteTask")).toBe(0);
			expect(s.link("task", errand3)).toBeUndefined();

			// The TickTick copy of a kept task comes back there: it is not imported.
			s.tt.edit(ttIds[3]!, { deleted: false } as Partial<TtTask>);
			await s.sync.sync();
			s.tick();
			expect(s.tasks("Errand 4")).toHaveLength(1);
			expect(s.link("task", s.task("Errand 4").id)?.mode).toBe("localOnly");
			expect(writes(s)).toBe(before);
			// The other tasks of the list still sync.
			await s.h.app.tasks.update(s.task("Stays").id, { title: "Still syncs" });
			await s.sync.sync();
			expect(s.tt.findByTitle("Still syncs")).toBeDefined();
		});

		it("a kept task that becomes repeating stays localOnly, and stays so when it stops", async () => {
			const s = await syncHarness();
			const { listId, pending } = await missingFive(s);
			await s.sync.keepMissing(listId, pending.tasks.map((t) => t.id), "many");
			const id = s.task("Errand 5").id;
			await s.h.app.recurrence.setRepeat(id, rule());
			await s.sync.sync();
			s.tick();
			expect(s.link("task", id)?.mode).toBe("localOnly");
			await s.h.app.recurrence.setRepeat(id, null);
			await s.sync.sync();
			expect(s.link("task", id)?.mode).toBe("localOnly");
			expect(s.tt.count("createTask")).toBe(6);
		});

		it("for a project that came back empty, Keep unlinks the list and every task stays", async () => {
			const s = await syncHarness();
			const { listId } = await linkedList(s);
			for (const t of ["One", "Two"]) await s.h.app.tasks.create({ title: t, categoryId: listId });
			await s.sync.sync();
			s.tick();
			for (const t of ["One", "Two"]) s.tt.remove(s.ttIdOf(t));
			const r = await s.sync.sync();
			expect(r.needsConfirmation).toEqual([expect.objectContaining({ listId, reason: "emptied" })]);
			const w = await s.sync.keepMissing(listId, r.needsConfirmation[0]!.tasks.map((t) => t.id), "emptied");
			expect(w.wrote).toBe(true);
			expect(s.link("list", listId)).toBeUndefined();
			expect([...s.h.app.store.state.syncLinks.values()]).toEqual([]);
			expect(s.tasks("One")).toHaveLength(1);
			expect(s.tasks("Two")).toHaveLength(1);
			const calls = s.tt.calls.length;
			await s.sync.sync();
			expect(s.tt.calls.length).toBe(calls);
		});

		it("leaves tasks of other lists and unlinked tasks alone, and writes only links", async () => {
			const s = await syncHarness();
			const { listId, pending } = await missingFive(s);
			const home = await s.h.app.tasks.create({ title: "At home" });
			const labels: string[] = [];
			s.h.app.store.bus.on("changed", (e) => labels.push(e.label));
			await s.sync.keepMissing(listId, [...pending.tasks.map((t) => t.id), home.task.id, "missing-id"], "many");
			expect(labels).toEqual([TICKTICK_KEEP_LABEL]);
			expect(s.h.app.store.state.syncLinks.get(syncLinkId("task", home.task.id))).toBeUndefined();
			expect(TICKTICK_KEEP_LABEL).not.toBe(TICKTICK_LINKS_LABEL);
		});
	});
});

describe("a list at TickTick's open-task limit, among other lists", () => {
	// A list at TickTick's open-task limit stops only its own writes.

	/** Work holds 99 open synced tasks and one completed one; Home holds the tasks given. TickTick allows 99 open. */
	async function fullWork(home: string[]): Promise<SyncHarness & { work: { listId: string; projectId: string }; homeList: { listId: string; projectId: string }; doneId: string }> {
		const s = await syncHarness();
		const work = await linkedList(s, "Work");
		const homeList = await linkedList(s, "Home");
		let doneId = "";
		for (let i = 0; i < 100; i++) {
			const { task } = await s.h.app.tasks.create({ title: `Work ${i}`, categoryId: work.listId });
			if (i === 0) doneId = task.id;
		}
		for (const title of home) await s.h.app.tasks.create({ title, categoryId: homeList.listId });
		expect((await s.sync.sync()).ok).toBe(true);
		s.tick();
		// "Work 0" is completed on both sides: Work holds 99 open tasks.
		await s.h.app.tasks.complete(doneId);
		expect((await s.sync.sync()).ok).toBe(true);
		s.tick();
		s.tt.openLimit = 99;
		return Object.assign(s, { work, homeList, doneId });
	}

	describe("a full list stops only its own writes", () => {
		it("a refused reopen in Work does not hold back a create in Home; the refusal is reported as the limit", async () => {
			const s = await fullWork([]);
			await s.h.app.tasks.reopen(s.doneId);
			await s.h.app.tasks.create({ title: "Water the plants", categoryId: s.homeList.listId });
			const r = await s.sync.sync();
			expect(r.ok).toBe(false);
			expect(r.error).toMatchObject({ listId: s.work.listId, listName: "Work", kind: "list-limit" });
			expect(s.tt.findByTitle("Water the plants")?.projectId).toBe(s.homeList.projectId);
			expect(s.tt.get(s.ttIdOf("Work 0"))?.status).toBe(2);
		});

		it("a move into a full list does not hold back an edit in another list", async () => {
			const s = await fullWork(["Pay rent", "Buy milk"]);
			const rent = s.task("Pay rent");
			const milk = s.task("Buy milk");
			await s.h.app.tasks.update(rent.id, { categoryId: s.work.listId });
			await s.h.app.tasks.update(milk.id, { title: "Buy oat milk" });
			const r = await s.sync.sync();
			expect(r.error).toMatchObject({ listId: s.work.listId, kind: "list-limit" });
			expect(s.tt.get(s.ttIdOf("Buy oat milk"))?.title).toBe("Buy oat milk");
			expect(s.tt.get(s.ttIdOf("Pay rent"))?.projectId).toBe(s.homeList.projectId);
		});
	});
});
