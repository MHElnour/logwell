import { describe, expect, it } from "vitest";
import { TickTickError } from "../../src/app/ports";
import { LOOKUP_MAX, TICKTICK_SYNC_LABEL, TICKTICK_TRASH_LABEL } from "../../src/app/SyncService";
import { linkedList, type SyncHarness, syncHarness } from "./sync-harness";

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

describe("removed by an undo (deep review #4)", () => {
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
});

describe("order of the push (deep review #5)", () => {
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

describe("a list at TickTick's open-task limit (deep review #5)", () => {
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

describe("a purge while a push is in flight (deep review #6)", () => {
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

	it("looks up at most LOOKUP_MAX missing tasks per list; the rest count as missing", async () => {
		const s = await withTasks(LOOKUP_MAX + 10);
		for (const id of s.ids.slice(0, LOOKUP_MAX + 5)) s.tt.remove(s.link("task", id)!.ttId);
		const r = await s.sync.sync();
		expect(s.tt.count("getTask")).toBe(LOOKUP_MAX);
		expect(r.needsConfirmation[0]?.tasks).toHaveLength(LOOKUP_MAX + 5);
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
