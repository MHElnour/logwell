import { describe, expect, it } from "vitest";
import { TICKTICK_LINKS_LABEL } from "../../src/app/SyncService";
import { makeReadOnly, makeWritable } from "./harness";
import { linkedList, type SyncHarness, syncHarness } from "./sync-harness";
import type { TtTaskCreate } from "../../src/domain/ticktick/types";

// A list at TickTick's open-task limit stops only its own writes; a create whose link
// cannot be written is linked by the next sync; a failed pendingDelete marking is retried.

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

describe("a full list stops only its own writes (second review #1)", () => {
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

describe("a create whose link cannot be written (second review #2)", () => {
	it("is linked by the next sync, not imported or created again", async () => {
		const s = await syncHarness();
		const { listId, projectId } = await linkedList(s);
		await s.h.app.tasks.create({ title: "Buy milk", categoryId: listId });
		await s.h.saveNow();
		const saved = s.h.dbText();
		const create = s.tt.createTask.bind(s.tt);
		s.tt.createTask = async (input: TtTaskCreate) => {
			const made = await create(input);
			// The store turns read-only after TickTick answered, before the link is written.
			await makeReadOnly(s.h);
			return made;
		};
		await expect(s.sync.sync()).rejects.toThrow();
		s.tt.createTask = create;
		await makeWritable(s.h, saved);
		s.tick();
		expect((await s.sync.sync()).ok).toBe(true);
		expect(s.tasks("Buy milk")).toHaveLength(1);
		expect(s.tt.live(projectId).filter((t) => t.title === "Buy milk")).toHaveLength(1);
		expect(s.ttIdOf("Buy milk")).toBe(s.tt.findByTitle("Buy milk")?.id);
	});
});

describe("a pendingDelete marking that fails (second review #3)", () => {
	it("is retried at the start of the next sync", async () => {
		const s = await syncHarness();
		const { listId, projectId } = await linkedList(s);
		const { task } = await s.h.app.tasks.create({ title: "Buy milk", categoryId: listId });
		await s.sync.sync();
		s.tick();
		const ttId = s.ttIdOf("Buy milk");
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
		expect(s.link("task", task.id)?.pendingDelete).toBeUndefined();
		await s.sync.sync();
		expect(s.tt.calls).toContain(`deleteTask:${ttId}`);
		expect(s.link("task", task.id)).toBeUndefined();
		expect(s.tt.live(projectId)).toHaveLength(0);
	});
});
