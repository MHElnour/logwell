import { describe, expect, it } from "vitest";
import { TICKTICK_KEEP_LABEL, TICKTICK_LINKS_LABEL } from "../../src/app/SyncService";
import type { TtTask } from "../../src/domain/ticktick/types";
import { syncLinkId } from "../../src/domain/types";
import { rule } from "../domain/recurrence-fixtures";
import { load } from "../persistence/fixtures";
import { linkedList, type SyncHarness, syncHarness } from "./sync-harness";

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

const writes = (s: SyncHarness) => ["createTask", "deleteTask", "batchTasks", "moveTasks", "updateTask", "completeTask"].map((m) => s.tt.count(m as never)).reduce((a, b) => a + b, 0);

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
