import { describe, expect, it, vi } from "vitest";
import { TickTickError } from "../../src/app/ports";
import { LOOKUP_MAX, TICKTICK_SYNC_LABEL } from "../../src/app/syncModel";
import { TICKTICK_COMPLETED_MAX, type TtTaskCreate } from "../../src/domain/ticktick/types";
import { linkedList, type SyncHarness, syncHarness } from "./sync-harness";
import { type SyncLink, syncLinkId } from "../../src/domain/types";
import { makeReadOnly, makeWritable } from "./harness";

describe("errors, single flight, undo and crashes", () => {
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

		it("links pulled tasks and sections before any push: a throw mid-push does not import them twice", async () => {
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

		it("records a merged pull even when the push fails: a retry makes no second conflict copy", async () => {
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
});

// A sync that finds nothing to do writes nothing, not even the time of its pull. Otherwise two devices
// with sync on would wake each other forever: each write reaches the other device as a reload, which syncs and
// writes again. `lastPulledAt` advances whenever the links command writes anything else, and at least once an hour;
// the next pull always asks for completions since the stored `lastPulledAt` (less the overlap), so none is missed.

describe("a sync with nothing to do", () => {
	it("runs no command and leaves the file as it is", async () => {
		const s = await syncHarness();
		const { listId } = await linkedList(s);
		await s.h.app.tasks.create({ title: "Call the bank", categoryId: listId });
		await s.sync.sync();
		s.tick();
		await s.h.store.flush();
		const text = s.h.dbText();
		const labels: string[] = [];
		s.h.app.store.bus.on("changed", (e) => labels.push(e.label));
		const pulledAt = s.link("list", listId)!.lastPulledAt;
		const r = await s.sync.sync();
		await s.h.store.flush();
		expect(r.ok).toBe(true);
		expect(labels).toEqual([]);
		expect(s.h.dbText()).toBe(text);
		expect(s.link("list", listId)!.lastPulledAt).toBe(pulledAt);
	});

	it("still advances lastPulledAt with any other link write, and once it is an hour old", async () => {
		const s = await syncHarness();
		const { listId } = await linkedList(s);
		const first = s.link("list", listId)!.lastPulledAt!;
		await s.h.app.tasks.create({ title: "Call the bank", categoryId: listId });
		await s.sync.sync();
		const second = s.link("list", listId)!.lastPulledAt!;
		expect(second > first).toBe(true);
		s.tick(30 * 60_000);
		await s.sync.sync();
		expect(s.link("list", listId)!.lastPulledAt).toBe(second);
		s.tick(31 * 60_000);
		await s.sync.sync();
		expect(s.link("list", listId)!.lastPulledAt! > second).toBe(true);
	});

	it("asks for completions since the stored lastPulledAt, so a completion during quiet syncs is pulled", async () => {
		const s = await syncHarness();
		const { listId } = await linkedList(s);
		await s.h.app.tasks.create({ title: "Call the bank", categoryId: listId });
		await s.sync.sync();
		const stored = s.link("list", listId)!.lastPulledAt!;
		const spy = vi.spyOn(s.tt, "listCompleted");
		for (let i = 0; i < 3; i++) {
			s.tick(10 * 60_000);
			await s.sync.sync();
		}
		const from = Date.parse(stored) - 5 * 60_000;
		for (const [q] of spy.mock.calls) expect(Date.parse(q.startDate.replace("+0000", "Z"))).toBeLessThanOrEqual(from);
		s.tt.edit(s.ttIdOf("Call the bank"), { status: 2 });
		s.tick();
		await s.sync.sync();
		expect(s.task("Call the bank").status).toBe("completed");
		expect(s.link("task", s.task("Call the bank").id)).toBeDefined();
		expect(syncLinkId("list", listId)).toBe(`list:${listId}`);
	});
});

describe("series, failed link writes and list failures", () => {
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

	describe("a repeating TickTick series is never deleted", () => {
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
			const engine = (s.sync as unknown as { puller: { applyPull: (...args: unknown[]) => { deletes: SyncLink[] } } }).puller;
			const plan = engine.applyPull.bind(engine);
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

	describe("a create whose link write failed", () => {
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

		it("#122: is linked after Obsidian restarts: this device remembers it, and neither side gets a second copy", async () => {
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
			s.tick();
			expect((await s.restart().sync()).ok).toBe(true);
			expect(s.tt.count("createTask")).toBe(1);
			expect(s.tt.live(projectId)).toHaveLength(1);
			expect(s.tasks("Buy milk")).toHaveLength(1);
			expect(s.link("task", task.id)?.ttId).toBe(copy.id);
			// Linked, it is forgotten: a later restart sends nothing again.
			s.tick();
			expect((await s.restart().sync()).ok).toBe(true);
			expect(s.tt.count("createTask")).toBe(1);
			expect(s.tasks("Buy milk")).toHaveLength(1);
		});

		it("#122: is kept when the command that would link it fails, and linked by the next sync", async () => {
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
			s.tick();
			// The pull pairs the copy, then the database turns read-only before its link is written.
			const store = s.h.app.store;
			const run = store.run.bind(store);
			store.run = (async (label: string, fn: never, options?: never) => {
				const out: unknown = await run(label, fn, options);
				if (label === TICKTICK_SYNC_LABEL) await makeReadOnly(s.h);
				return out;
			}) as typeof store.run;
			await expect(s.sync.sync()).rejects.toThrow();
			store.run = run;
			await makeWritable(s.h, saved, "r-repaired0002");
			s.tick();
			expect((await s.sync.sync()).ok).toBe(true);
			expect(s.tt.count("createTask")).toBe(1);
			expect(s.tt.live(projectId)).toHaveLength(1);
			expect(s.tasks("Buy milk")).toHaveLength(1);
			expect(s.link("task", task.id)?.ttId).toBe(copy.id);
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

	describe("failures of every list are reported", () => {
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

	describe("the open count follows TickTick's status", () => {
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

	describe("an answered create is paired against what was sent", () => {
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
});

describe("stopping between requests", () => {
	// `stop()` (a session closing) stops the sync between two requests: at most the request already in flight
	// completes, what TickTick answered is still linked, and nothing else is sent or pulled.

	const creates = (calls: string[]) => calls.filter((c) => c.startsWith("createTask")).length;

	describe("stopping a sync", () => {
		it("mid-push: no request after the one in flight, whose answer is still linked", async () => {
			const s = await syncHarness();
			const { listId } = await linkedList(s);
			for (const title of ["One", "Two", "Three"]) await s.h.app.tasks.create({ title, categoryId: listId });
			let release!: () => void;
			const held = new Promise<void>((r) => (release = r));
			let first = true;
			s.tt.onCall = (m) => {
				if (m !== "createTask" || !first) return undefined;
				first = false;
				return held;
			};
			const running = s.sync.sync();
			await new Promise((r) => setTimeout(r, 0));
			while (creates(s.tt.calls) === 0) await new Promise((r) => setTimeout(r, 0));
			s.sync.stop();
			const calls = s.tt.calls.length;
			release();
			const r = await running;
			expect(r.ok).toBe(false);
			expect(s.tt.calls.length).toBe(calls);
			const linked = ["One", "Two", "Three"].filter((t) => s.link("task", s.task(t).id) !== undefined);
			expect(linked).toHaveLength(1);
			expect(s.tt.findByTitle(linked[0]!)?.id).toBe(s.ttIdOf(linked[0]!));
		});

		it("#136: a sync stopped by the closing session says so as its own kind, not as a network error", async () => {
			const s = await syncHarness();
			const { projectId } = await linkedList(s);
			s.tt.add(projectId, { title: "From TickTick" });
			s.tt.onCall = (m) => {
				if (m === "listCompleted") s.sync.stop();
			};
			const r = await s.sync.sync();
			expect(r.ok).toBe(false);
			expect(r.error).toMatchObject({ kind: "stopped", message: "TickTick: sync stopped because the database is closing." });
		});

		it("mid-pull: nothing pulled is written", async () => {
			const s = await syncHarness();
			const { projectId } = await linkedList(s);
			s.tt.add(projectId, { title: "From TickTick" });
			let release!: () => void;
			const held = new Promise<void>((r) => (release = r));
			// The last request of the pull: after it the sync would write what it pulled.
			s.tt.onCall = (m) => (m === "listCompleted" ? held : undefined);
			const state = s.h.app.store.state;
			const running = s.sync.sync();
			await new Promise((r) => setTimeout(r, 0));
			s.sync.stop();
			const calls = s.tt.calls.length;
			release();
			const r = await running;
			expect(r.ok).toBe(false);
			expect(s.tt.calls.length).toBe(calls);
			expect(s.h.app.store.state).toBe(state);
			expect(s.tasks("From TickTick")).toHaveLength(0);
		});
	});
});
