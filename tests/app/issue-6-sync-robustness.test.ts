import { describe, expect, it } from "vitest";
import { TickTickError } from "../../src/app/ports";
import { LOOKUP_MAX, TICKTICK_SYNC_LABEL } from "../../src/app/SyncService";
import { TICKTICK_COMPLETED_MAX } from "../../src/domain/ticktick/types";
import { linkedList, type SyncHarness, syncHarness } from "./sync-harness";

// Errors, partly applied writes, single flight, undo and a crash between the content and the
// bookkeeping commands.

async function oneTask(): Promise<SyncHarness & { listId: string; projectId: string; id: string; ttId: string }> {
	const s = await syncHarness();
	const { listId, projectId } = await linkedList(s);
	const { task } = await s.h.app.tasks.create({ title: "Call the bank", categoryId: listId });
	await s.sync.sync();
	s.tick();
	return Object.assign(s, { listId, projectId, id: task.id, ttId: s.ttIdOf("Call the bank") });
}

const server = (maybePartial = false) => new TickTickError("server", "TickTick: server error (HTTP 500)", { status: 500, maybePartial });

describe("errors (SYNC-12)", () => {
	it("a project that fails to load stops the sync with the list and the reason, writing nothing", async () => {
		const s = await oneTask();
		s.tt.edit(s.ttId, { title: "Pulled" });
		await s.h.app.tasks.create({ title: "New", categoryId: s.listId });
		const state = s.h.app.store.state;
		s.tt.fail("getProjectData", server());
		const r = await s.sync.sync();
		expect(r.ok).toBe(false);
		expect(r.error).toMatchObject({ listId: s.listId, listName: "Work", kind: "server" });
		expect(s.h.app.store.state).toBe(state);
		expect(s.tt.count("createTask")).toBe(1);
	});

	it("429 stops with rate-limited and its Retry-After", async () => {
		const s = await oneTask();
		s.tt.fail("getProjectData", new TickTickError("rate-limited", "TickTick: too many requests (HTTP 429)", { status: 429, retryAfterSec: 30 }));
		const r = await s.sync.sync();
		expect(r.error).toMatchObject({ kind: "rate-limited", retryAfterSec: 30 });
	});

	it("a failed push leaves the link untouched and pushes again next time", async () => {
		const s = await oneTask();
		const link = s.link("task", s.id);
		await s.h.app.tasks.update(s.id, { title: "Call the bank at nine" });
		s.tt.fail("batchTasks", new TickTickError("unauthorized", "TickTick: the API token was refused (HTTP 401)", { status: 401 }));
		const r = await s.sync.sync();
		expect(r.error).toMatchObject({ kind: "unauthorized", listId: s.listId });
		expect(s.link("task", s.id)).toBe(link);
		expect(s.tt.get(s.ttId)?.title).toBe("Call the bank");
		s.tick();
		expect((await s.sync.sync()).ok).toBe(true);
		expect(s.tt.get(s.ttId)?.title).toBe("Call the bank at nine");
	});

	it("a full completed list never reads as gone: the rest of the pull is applied and nothing goes to Trash", async () => {
		const s = await oneTask();
		// Linked tasks completed in TickTick in one instant: the cut answer lacks more of them than can be looked up.
		const ids: string[] = [];
		for (let i = 0; i < TICKTICK_COMPLETED_MAX + LOOKUP_MAX + 1; i++) ids.push(s.tt.add(s.projectId, { title: `Done ${i}` }).id);
		expect((await s.sync.sync()).ok).toBe(true);
		s.tick();
		for (const id of ids) s.tt.edit(id, { status: 2 });
		s.tick();
		s.tt.edit(s.ttId, { title: "Pulled" });
		const r = await s.sync.sync();
		expect(r.error).toBeNull();
		expect(r.needsConfirmation).toEqual([]);
		expect(s.h.app.store.state.trash.size).toBe(0);
		expect(s.h.app.store.state.tasks.get(s.id)?.title).toBe("Pulled");
	});

	it("a partly applied create is re-read: no duplicate on either side", async () => {
		const s = await oneTask();
		await s.h.app.tasks.create({ title: "Buy milk", categoryId: s.listId });
		s.tt.fail("createTask", server(true), { applyFirst: true });
		const r = await s.sync.sync();
		expect(r.error).toMatchObject({ kind: "server" });
		expect(s.tt.live(s.projectId).filter((t) => t.title === "Buy milk")).toHaveLength(1);
		s.tick();
		expect((await s.sync.sync()).ok).toBe(true);
		expect(s.tasks("Buy milk")).toHaveLength(1);
		expect(s.tt.live(s.projectId).filter((t) => t.title === "Buy milk")).toHaveLength(1);
		expect(s.ttIdOf("Buy milk")).toBe(s.tt.findByTitle("Buy milk")?.id);
	});

	it("links each new task in its own command right after TickTick answers", async () => {
		const s = await oneTask();
		const first = await s.h.app.tasks.create({ title: "Buy milk", categoryId: s.listId });
		await s.h.app.tasks.create({ title: "Pay rent", categoryId: s.listId });
		let creates = 0;
		let linkedWhileSecondInFlight = false;
		s.tt.onCall = (m) => {
			if (m === "createTask" && ++creates === 2) linkedWhileSecondInFlight = s.link("task", first.task.id) !== undefined;
		};
		expect((await s.sync.sync()).ok).toBe(true);
		expect(creates).toBe(2);
		expect(linkedWhileSecondInFlight).toBe(true);
	});

	it("links pulled tasks and sections before any push: a throw mid-push does not import them twice (deep review #2)", async () => {
		const s = await oneTask();
		const col = s.tt.addColumn(s.projectId, "Errands");
		s.tt.add(s.projectId, { title: "Imported", columnId: col.id });
		await s.h.app.tasks.create({ title: "Goes up", categoryId: s.listId });
		s.tt.onCall = (m) => {
			if (m === "createTask") throw new Error("the store turned read-only");
		};
		await expect(s.sync.sync()).rejects.toThrow("read-only");
		const imported = s.task("Imported");
		expect(s.link("task", imported.id)?.ttId).toBe(s.tt.findByTitle("Imported")?.id);
		expect(s.link("section", imported.sectionId ?? "")?.ttId).toBe(col.id);
		s.tt.onCall = null;
		s.tick();
		expect((await s.sync.sync()).ok).toBe(true);
		expect(s.tasks("Imported")).toHaveLength(1);
		expect(s.h.app.store.state.sections.size).toBe(1);
		expect(s.tt.live(s.projectId).filter((t) => t.title === "Goes up")).toHaveLength(1);
	});

	it("records a merged pull even when the push fails: a retry makes no second conflict copy (deep review #3)", async () => {
		const s = await oneTask();
		await s.h.app.tasks.update(s.id, { title: "Call the bank (Logwell)" });
		s.tt.edit(s.ttId, { title: "Phone the bank" });
		s.tt.fail("batchTasks", new TickTickError("rate-limited", "TickTick: too many requests (HTTP 429)", { status: 429, retryAfterSec: 10 }));
		expect((await s.sync.sync()).error).toMatchObject({ kind: "rate-limited" });
		s.tick();
		expect((await s.sync.sync()).ok).toBe(true);
		expect(s.tasks("Phone the bank (TickTick)")).toHaveLength(1);
		expect(s.tt.get(s.ttId)?.title).toBe("Call the bank (Logwell)");
		s.tick();
		await s.sync.sync();
		expect(s.tasks("Phone the bank (TickTick)")).toHaveLength(1);
	});

	it("a partly applied batch heals on the next sync without a conflict copy", async () => {
		const s = await oneTask();
		await s.h.app.tasks.update(s.id, { title: "Call the bank at nine" });
		s.tt.fail("batchTasks", server(true), { applyFirst: true });
		await s.sync.sync();
		const link = s.link("task", s.id);
		s.tick();
		const n = s.tt.count("batchTasks");
		await s.sync.sync();
		expect(s.tasks("Call the bank at nine (TickTick)")).toHaveLength(0);
		expect(s.tt.count("batchTasks")).toBe(n);
		expect(s.link("task", s.id)).not.toBe(link);
		expect(s.link("task", s.id)?.etag).toBe(s.tt.get(s.ttId)?.etag);
	});
});

describe("single flight (SYNC-10)", () => {
	it("returns the running sync and runs exactly once more after it", async () => {
		const s = await oneTask();
		let open!: () => void;
		s.tt.gate = new Promise((r) => (open = r));
		const a = s.sync.sync();
		const b = s.sync.sync();
		const c = s.sync.sync();
		expect(b).toBe(a);
		expect(c).toBe(a);
		const before = s.tt.count("getProjectData");
		s.tt.gate = null;
		open();
		await a;
		await s.sync.idle();
		expect(s.tt.count("getProjectData") - before).toBe(2);
	});
});

describe("undo", () => {
	it("a background pull is not undoable: Cmd+Z undoes the user's prior edit", async () => {
		const s = await oneTask();
		const other = await s.h.app.tasks.create({ title: "Buy milk", categoryId: s.listId });
		await s.sync.sync();
		s.tick();
		await s.h.app.tasks.update(other.task.id, { title: "Buy oat milk" });
		s.tt.edit(s.ttId, { title: "Pulled title" });
		await s.sync.sync();
		expect(await s.h.app.store.undo()).toBe("Edit task");
		expect(s.h.app.store.state.tasks.get(other.task.id)?.title).toBe("Buy milk");
		expect(s.h.app.store.state.tasks.get(s.id)?.title).toBe("Pulled title");
	});

	it("Sync now is not undoable either (D26)", async () => {
		const s = await oneTask();
		s.tt.edit(s.ttId, { title: "Pulled title", priority: 5 });
		const undoBefore = s.h.app.store.undoLabel;
		const r = await s.sync.sync();
		expect(r.content).toEqual({ wrote: true, label: TICKTICK_SYNC_LABEL });
		expect(s.h.app.store.undoLabel).toBe(undoBefore);
	});
});

describe("crash between the content and the bookkeeping commands", () => {
	/** Puts the links back as they were, as if the bookkeeping command never ran. */
	async function dropBookkeeping(s: SyncHarness, links: ReadonlyMap<string, unknown>): Promise<void> {
		await s.h.app.store.run(
			"crash",
			(tx) => {
				for (const l of tx.all("syncLinks")) tx.remove("syncLinks", `${l.kind}:${l.logwellId}`);
				for (const l of links.values()) tx.put("syncLinks", l as never);
			},
			{ undoable: false },
		);
	}

	it("heals a pulled edit: same value both sides only refreshes the link", async () => {
		const s = await oneTask();
		const links = s.h.app.store.state.syncLinks;
		s.tt.edit(s.ttId, { title: "Pulled title" });
		await s.sync.sync();
		await dropBookkeeping(s, links);
		s.tick();
		const n = s.tt.count("batchTasks");
		await s.sync.sync();
		expect(s.tt.count("batchTasks")).toBe(n);
		expect(s.tasks("Pulled title (TickTick)")).toHaveLength(0);
		expect(s.link("task", s.id)?.etag).toBe(s.tt.get(s.ttId)?.etag);
	});

	it("heals a pushed edit", async () => {
		const s = await oneTask();
		const links = s.h.app.store.state.syncLinks;
		await s.h.app.tasks.update(s.id, { priority: 1 });
		await s.sync.sync();
		await dropBookkeeping(s, links);
		s.tick();
		const n = s.tt.count("batchTasks");
		await s.sync.sync();
		expect(s.tt.count("batchTasks")).toBe(n);
		expect(s.tasks("Call the bank (TickTick)")).toHaveLength(0);
		expect(s.link("task", s.id)?.etag).toBe(s.tt.get(s.ttId)?.etag);
	});
});
