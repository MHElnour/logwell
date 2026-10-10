import { describe, expect, it } from "vitest";
import { TickTickError } from "../../src/app/ports";
import type { SyncLink } from "../../src/domain/types";
import type { TtTaskCreate } from "../../src/domain/ticktick/types";
import { makeReadOnly, makeWritable } from "./harness";
import { linkedList, type SyncHarness, syncHarness } from "./sync-harness";

// A repeating TickTick series is never deleted; a create whose link write failed is
// linked whatever its TickTick status; every list's failure is reported; the open count follows TickTick's status.

async function oneTask(): Promise<SyncHarness & { listId: string; projectId: string; id: string; ttId: string }> {
	const s = await syncHarness();
	const { listId, projectId } = await linkedList(s);
	const { task } = await s.h.app.tasks.create({ title: "Call the bank", categoryId: listId });
	await s.sync.sync();
	s.tick();
	return Object.assign(s, { listId, projectId, id: task.id, ttId: s.ttIdOf("Call the bank") });
}

const DAILY = "RRULE:FREQ=DAILY;INTERVAL=1";

describe("a repeating TickTick series is never deleted (third review #1)", () => {
	it("made repeating in TickTick, then deleted in Logwell before the next sync: only the link goes", async () => {
		const s = await oneTask();
		s.tt.edit(s.ttId, { repeatFlag: DAILY });
		await s.h.app.tasks.delete(s.id);
		await s.sync.sync();
		expect(s.tt.count("deleteTask")).toBe(0);
		expect(s.tt.live(s.projectId)).toHaveLength(1);
		expect(s.link("task", s.id)).toBeUndefined();
	});

	it("made repeating in TickTick, then moved to a list that is not linked: only the link goes", async () => {
		const s = await oneTask();
		const home = await s.h.app.categories.create("Home");
		s.tt.edit(s.ttId, { repeatFlag: DAILY });
		await s.h.app.tasks.update(s.id, { categoryId: home.id });
		await s.sync.sync();
		expect(s.tt.count("deleteTask")).toBe(0);
		expect(s.tt.live(s.projectId)).toHaveLength(1);
		expect(s.link("task", s.id)).toBeUndefined();
	});

	it("the delete step itself drops a delete of a repeating copy that planning queued by mistake", async () => {
		const s = await oneTask();
		s.tt.edit(s.ttId, { repeatFlag: DAILY });
		const link = s.link("task", s.id)!;
		const engine = s.sync as unknown as { applyPull: (...args: unknown[]) => { deletes: SyncLink[] } };
		const plan = engine.applyPull.bind(s.sync);
		engine.applyPull = (...args: unknown[]) => {
			const p = plan(...args);
			p.deletes.push(link);
			return p;
		};
		await s.sync.sync();
		expect(s.tt.count("deleteTask")).toBe(0);
		expect(s.tt.get(s.ttId)?.repeatFlag).toBe(DAILY);
		expect(s.link("task", s.id)).toBeUndefined();
	});
});

describe("a create whose link write failed (third review #2)", () => {
	it("is linked even after its TickTick copy was completed, and completes in Logwell", async () => {
		const s = await syncHarness();
		const { listId, projectId } = await linkedList(s);
		const { task } = await s.h.app.tasks.create({ title: "Buy milk", categoryId: listId });
		await s.h.saveNow();
		const saved = s.h.dbText();
		const create = s.tt.createTask.bind(s.tt);
		s.tt.createTask = async (input: TtTaskCreate) => {
			const made = await create(input);
			await makeReadOnly(s.h);
			return made;
		};
		await expect(s.sync.sync()).rejects.toThrow();
		s.tt.createTask = create;
		await makeWritable(s.h, saved);
		const copy = s.tt.findByTitle("Buy milk")!;
		s.tt.edit(copy.id, { status: 2 });
		s.tick();
		expect((await s.sync.sync()).ok).toBe(true);
		expect(s.tt.count("createTask")).toBe(1);
		expect(s.tt.live(projectId)).toHaveLength(1);
		expect(s.link("task", task.id)?.ttId).toBe(copy.id);
		expect(s.h.app.store.state.tasks.get(task.id)?.status).toBe("completed");
	});

	it("is linked even when the copy fell out of the completed window: one lookup by its id", async () => {
		const s = await syncHarness();
		const { listId } = await linkedList(s);
		const { task } = await s.h.app.tasks.create({ title: "Buy milk", categoryId: listId });
		await s.h.saveNow();
		const saved = s.h.dbText();
		const create = s.tt.createTask.bind(s.tt);
		s.tt.createTask = async (input: TtTaskCreate) => {
			const made = await create(input);
			await makeReadOnly(s.h);
			return made;
		};
		await expect(s.sync.sync()).rejects.toThrow();
		s.tt.createTask = create;
		await makeWritable(s.h, saved);
		const copy = s.tt.findByTitle("Buy milk")!;
		s.tt.edit(copy.id, { status: 2 });
		// Completed long before the last pull: outside the window the completed list is read for.
		s.tt.tasks.set(copy.id, { ...s.tt.tasks.get(copy.id)!, completedTime: "2026-09-01T00:00:00.000+0000" });
		s.tick();
		expect((await s.sync.sync()).ok).toBe(true);
		expect(s.tt.calls).toContain(`getTask:${copy.id}`);
		expect(s.tt.count("createTask")).toBe(1);
		expect(s.link("task", task.id)?.ttId).toBe(copy.id);
	});
});

describe("failures of every list are reported (third review #3)", () => {
	it("a whole-push stop keeps the failures of lists that stopped before it", async () => {
		const s = await syncHarness();
		const work = await linkedList(s, "Work");
		const home = await linkedList(s, "Home");
		const y = (await s.h.app.tasks.create({ title: "Y", categoryId: work.listId })).task;
		await s.sync.sync();
		s.tick();
		await s.h.app.tasks.delete(y.id);
		await s.h.app.tasks.create({ title: "N", categoryId: home.listId });
		s.tt.fail("deleteTask", new TickTickError("server", "TickTick: server error (HTTP 500)", { status: 500 }));
		s.tt.fail("createTask", new TickTickError("network", "TickTick: no answer (network error)."));
		const r = await s.sync.sync();
		expect(r.ok).toBe(false);
		expect(r.failures.map((f) => [f.listName, f.kind])).toEqual([
			["Work", "server"],
			["Home", "network"],
		]);
	});
});

describe("the open count follows TickTick's status (third review #4)", () => {
	it("a task completed in TickTick, reopened and moved in Logwell counts once", async () => {
		const s = await syncHarness();
		const work = await linkedList(s, "Work");
		const home = await linkedList(s, "Home");
		const x = (await s.h.app.tasks.create({ title: "X", categoryId: work.listId })).task;
		for (let i = 0; i < 97; i++) await s.h.app.tasks.create({ title: `Home ${i}`, categoryId: home.listId });
		await s.sync.sync();
		s.tick();
		await s.h.app.tasks.complete(x.id);
		await s.sync.sync();
		s.tick();
		await s.h.app.tasks.reopen(x.id);
		await s.h.app.tasks.update(x.id, { categoryId: home.listId });
		await s.h.app.tasks.create({ title: "One more", categoryId: home.listId });
		// Home holds 97 + X = 98 open tasks when the create goes up: a 500 then is not the 99-task limit.
		s.tt.fail("createTask", new TickTickError("server", "TickTick: server error (HTTP 500)", { status: 500 }));
		const r = await s.sync.sync();
		expect(s.tt.calls).toContain(`moveTasks:${s.ttIdOf("X")}`);
		expect(r.error).toMatchObject({ listName: "Home", kind: "server" });
	});
});

describe("a copy the pull did not see is looked up before it is deleted", () => {
	/** "Call the bank" is completed in TickTick long before the last pull, then purged in Logwell. */
	async function purgedUnseen(patch: { repeatFlag?: string }): Promise<SyncHarness & { listId: string; projectId: string; id: string; ttId: string }> {
		const s = await oneTask();
		s.tt.edit(s.ttId, { status: 2, ...patch });
		s.tt.tasks.set(s.ttId, { ...s.tt.tasks.get(s.ttId)!, completedTime: "2026-09-01T00:00:00.000+0000" });
		const entry = await s.h.app.tasks.delete(s.id);
		await s.h.app.tasks.purge(entry.batchId);
		expect(s.link("task", s.id)?.pendingDelete).toBe(true);
		return s;
	}

	it("a completed repeating series is never deleted: only the link goes", async () => {
		const s = await purgedUnseen({ repeatFlag: DAILY });
		const r = await s.sync.sync();
		expect(r.ok).toBe(true);
		expect(s.tt.calls).toContain(`getTask:${s.ttId}`);
		expect(s.tt.count("deleteTask")).toBe(0);
		expect(s.tt.get(s.ttId)?.repeatFlag).toBe(DAILY);
		expect(s.link("task", s.id)).toBeUndefined();
	});

	it("a plain copy is deleted as before", async () => {
		const s = await purgedUnseen({});
		expect((await s.sync.sync()).ok).toBe(true);
		expect(s.tt.calls).toContain(`getTask:${s.ttId}`);
		expect(s.tt.calls).toContain(`deleteTask:${s.ttId}`);
		expect(s.link("task", s.id)).toBeUndefined();
	});

	it("a copy that is not found is already gone: no delete, the link goes", async () => {
		const s = await purgedUnseen({});
		s.tt.tasks.delete(s.ttId);
		expect((await s.sync.sync()).ok).toBe(true);
		expect(s.tt.count("deleteTask")).toBe(0);
		expect(s.link("task", s.id)).toBeUndefined();
	});

	it("a lookup that fails deletes nothing, keeps the link for the next sync and reports the list", async () => {
		const s = await purgedUnseen({});
		s.tt.fail("getTask", new TickTickError("server", "TickTick: server error (HTTP 500)", { status: 500 }));
		const r = await s.sync.sync();
		expect(r.ok).toBe(false);
		expect(r.failures).toEqual([expect.objectContaining({ listId: s.listId, kind: "server" })]);
		expect(s.tt.count("deleteTask")).toBe(0);
		expect(s.link("task", s.id)?.pendingDelete).toBe(true);
		s.tick();
		expect((await s.sync.sync()).ok).toBe(true);
		expect(s.tt.calls).toContain(`deleteTask:${s.ttId}`);
		expect(s.link("task", s.id)).toBeUndefined();
	});
});

describe("an answered create is paired against what was sent (verification of c5655c7)", () => {
	/** "Buy milk" reaches TickTick, the link write fails (read-only), the store recovers without the link. */
	async function failedLink(): Promise<SyncHarness & { listId: string; projectId: string; id: string; ttId: string }> {
		const s = await syncHarness();
		const { listId, projectId } = await linkedList(s);
		const { task } = await s.h.app.tasks.create({ title: "Buy milk", categoryId: listId });
		await s.h.saveNow();
		const saved = s.h.dbText();
		const create = s.tt.createTask.bind(s.tt);
		s.tt.createTask = async (input: TtTaskCreate) => {
			const made = await create(input);
			await makeReadOnly(s.h);
			return made;
		};
		await expect(s.sync.sync()).rejects.toThrow();
		s.tt.createTask = create;
		await makeWritable(s.h, saved);
		s.tick();
		return Object.assign(s, { listId, projectId, id: task.id, ttId: s.tt.findByTitle("Buy milk")!.id });
	}

	it("keeps a Logwell edit made after the failed link write and pushes it (P9)", async () => {
		const s = await failedLink();
		await s.h.app.tasks.update(s.id, { title: "Buy oat milk", priority: 1 });
		expect((await s.sync.sync()).ok).toBe(true);
		expect(s.h.app.store.state.tasks.get(s.id)).toMatchObject({ title: "Buy oat milk", priority: 1 });
		expect(s.tt.get(s.ttId)).toMatchObject({ title: "Buy oat milk", priority: 5 });
		expect(s.tasks("Buy milk (TickTick)")).toHaveLength(0);
		expect(s.link("task", s.id)?.ttId).toBe(s.ttId);
	});

	it("keeps a Logwell completion made after the failed link write and pushes it (P9b)", async () => {
		const s = await failedLink();
		await s.h.app.tasks.complete(s.id);
		expect((await s.sync.sync()).ok).toBe(true);
		expect(s.h.app.store.state.tasks.get(s.id)?.status).toBe("completed");
		expect(s.tt.get(s.ttId)?.status).toBe(2);
	});

	it("a same-field change on both sides follows the conflict rule", async () => {
		const s = await failedLink();
		await s.h.app.tasks.update(s.id, { title: "Buy oat milk" });
		s.tt.edit(s.ttId, { title: "Buy soy milk" });
		await s.sync.sync();
		expect(s.h.app.store.state.tasks.get(s.id)?.title).toBe("Buy oat milk");
		expect(s.tt.get(s.ttId)?.title).toBe("Buy oat milk");
		expect(s.tasks("Buy soy milk (TickTick)")).toHaveLength(1);
	});

	it("a Logwell task in Trash: the copy is not imported, and is deleted by the next sync (P10)", async () => {
		const s = await failedLink();
		await s.h.app.tasks.delete(s.id);
		expect((await s.sync.sync()).ok).toBe(true);
		expect(s.h.app.store.state.tasks.size).toBe(0);
		expect(s.link("task", s.id)?.ttId).toBe(s.ttId);
		s.tick();
		await s.sync.sync();
		expect(s.tt.calls).toContain(`deleteTask:${s.ttId}`);
		expect(s.tt.live(s.projectId)).toHaveLength(0);
		expect(s.link("task", s.id)).toBeUndefined();
	});

	it("a Logwell task purged meanwhile: the copy is not imported, and is deleted by the next sync", async () => {
		const s = await failedLink();
		const entry = await s.h.app.tasks.delete(s.id);
		await s.h.app.tasks.purge(entry.batchId);
		expect((await s.sync.sync()).ok).toBe(true);
		expect(s.h.app.store.state.tasks.size).toBe(0);
		expect(s.link("task", s.id)?.pendingDelete).toBe(true);
		s.tick();
		await s.sync.sync();
		expect(s.tt.calls).toContain(`deleteTask:${s.ttId}`);
		expect(s.tt.live(s.projectId)).toHaveLength(0);
	});
});
