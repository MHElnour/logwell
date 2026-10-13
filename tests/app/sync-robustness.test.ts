import { describe, expect, it, vi } from "vitest";
import { TickTickError } from "../../src/app/ports";
import { TICKTICK_SYNC_LABEL } from "../../src/app/syncModel";
import { type SyncLink, syncLinkId } from "../../src/domain/types";
import { rule } from "../domain/recurrence-fixtures";
import { makeReadOnly, makeWritable } from "./harness";
import { failedLink, linkedList, oneSyncedTask, pushes, type SyncedTask, type SyncHarness, syncHarness } from "./sync-harness";

// Errors, partly applied writes, single flight, undo, crashes, failed link writes and what a delete or move in
// Logwell does to the TickTick copy. The failure points and link states are tables: one row per case.

const server = (maybePartial = false) => new TickTickError("server", "TickTick: server error (HTTP 500)", { status: 500, maybePartial });
const DAILY = "RRULE:FREQ=DAILY;INTERVAL=1";

describe("errors, single flight, undo and crashes", () => {
	describe("errors (SYNC-12)", () => {
		it.each([
			["a server error", () => server(), { kind: "server" }],
			["a 429, with its Retry-After", () => new TickTickError("rate-limited", "TickTick: too many requests (HTTP 429)", { status: 429, retryAfterSec: 30 }), { kind: "rate-limited", retryAfterSec: 30 }],
		])("a project that fails to load with %s stops the sync with the list and the reason, writing nothing", async (_, error, reason) => {
			const s = await oneSyncedTask();
			s.tt.edit(s.ttId, { title: "Pulled" });
			await s.h.app.tasks.create({ title: "New", categoryId: s.listId });
			const state = s.h.app.store.state;
			s.tt.fail("getProjectData", error());
			const r = await s.sync.sync();
			expect(r.ok).toBe(false);
			expect(r.error).toMatchObject({ listId: s.listId, listName: "Work", ...reason });
			expect(s.h.app.store.state).toBe(state);
			expect(s.tt.count("createTask")).toBe(1);
		});

		it("a failed push leaves the link untouched and pushes again next time", async () => {
			const s = await oneSyncedTask();
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

		it("a partly applied create is re-read: no duplicate on either side", async () => {
			const s = await oneSyncedTask();
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
			const s = await oneSyncedTask();
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
			const s = await oneSyncedTask();
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
			const s = await oneSyncedTask();
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
	});

	describe("single flight (SYNC-10)", () => {
		it("#137: returns the running sync and queues nothing itself (the scheduler runs a trigger once after it)", async () => {
			const s = await oneSyncedTask();
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
			expect(s.tt.count("getProjectData") - before).toBe(1);
		});
	});

	describe("undo", () => {
		it("a pull is not undoable (D26): it writes under the sync's label and Cmd+Z undoes the user's prior edit", async () => {
			const s = await oneSyncedTask();
			const other = await s.h.app.tasks.create({ title: "Buy milk", categoryId: s.listId });
			await s.sync.sync();
			s.tick();
			await s.h.app.tasks.update(other.task.id, { title: "Buy oat milk" });
			s.tt.edit(s.ttId, { title: "Pulled title", priority: 5 });
			const undoBefore = s.h.app.store.undoLabel;
			const r = await s.sync.sync();
			expect(r.content).toEqual({ wrote: true, label: TICKTICK_SYNC_LABEL });
			expect(s.h.app.store.undoLabel).toBe(undoBefore);
			expect(await s.h.app.store.undo()).toBe("Edit task");
			expect(s.h.app.store.state.tasks.get(other.task.id)?.title).toBe("Buy milk");
			expect(s.h.app.store.state.tasks.get(s.id)?.title).toBe("Pulled title");
		});
	});

	describe("a value both sides already hold, with a stale link: the sync only refreshes the link", () => {
		/** Puts the links back as they were, as if the bookkeeping command after the content never ran (a crash). */
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

		/** Each makes the base stale and returns the title a wrong conflict copy would carry. */
		it.each<[string, (s: SyncedTask) => Promise<string>]>([
			[
				"both sides changed the title to the same value",
				async (s) => {
					await s.h.app.tasks.update(s.id, { title: "Same" });
					s.tt.edit(s.ttId, { title: "Same" });
					return "Same";
				},
			],
			[
				"a partly applied batch: TickTick took the edit but answered with an error",
				async (s) => {
					await s.h.app.tasks.update(s.id, { title: "Call the bank at nine" });
					s.tt.fail("batchTasks", server(true), { applyFirst: true });
					await s.sync.sync();
					s.tick();
					return "Call the bank at nine";
				},
			],
			[
				"a pulled edit whose bookkeeping was lost in a crash",
				async (s) => {
					const links = s.h.app.store.state.syncLinks;
					s.tt.edit(s.ttId, { title: "Pulled title" });
					await s.sync.sync();
					await dropBookkeeping(s, links);
					s.tick();
					return "Pulled title";
				},
			],
			[
				"a pushed edit whose bookkeeping was lost in a crash",
				async (s) => {
					const links = s.h.app.store.state.syncLinks;
					await s.h.app.tasks.update(s.id, { priority: 1 });
					await s.sync.sync();
					await dropBookkeeping(s, links);
					s.tick();
					return "Call the bank";
				},
			],
		])("%s", async (_, stale) => {
			const s = await oneSyncedTask();
			const title = await stale(s);
			const link = s.link("task", s.id);
			const n = pushes(s);
			expect((await s.sync.sync()).ok).toBe(true);
			expect(pushes(s)).toBe(n);
			expect(s.tasks(`${title} (TickTick)`)).toHaveLength(0);
			expect(s.link("task", s.id)).not.toBe(link);
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

describe("the TickTick copy after a delete, purge or move in Logwell", () => {
	// A plain copy is deleted; a repeating TickTick series never is, only the link goes; a copy the pull did not see is
	// looked up first. Each row ends with the next sync; a later sync brings neither copy back.

	/** "Call the bank" completed in TickTick long before the last pull, so the pull does not see it. */
	function completedUnseen(s: SyncedTask, patch: { repeatFlag?: string } = {}): void {
		s.tt.edit(s.ttId, { status: 2, ...patch });
		s.tt.tasks.set(s.ttId, { ...s.tt.tasks.get(s.ttId)!, completedTime: "2026-09-01T00:00:00.000+0000" });
	}

	async function purge(s: SyncedTask): Promise<void> {
		const entry = await s.h.app.tasks.delete(s.id);
		await s.h.app.tasks.purge(entry.batchId);
		expect(s.link("task", s.id)?.pendingDelete).toBe(true);
	}

	async function moveToUnlinked(s: SyncedTask): Promise<void> {
		const home = await s.h.app.categories.create("Home");
		await s.h.app.tasks.update(s.id, { categoryId: home.id });
	}

	/** Made repeating in Logwell (excluded), synced, then trashed: nothing happens while it is in Trash. */
	async function excludedInTrash(s: SyncedTask): Promise<{ batchId: string }> {
		await s.h.app.recurrence.setRepeat(s.id, rule({ freq: "weekly" }));
		await s.sync.sync();
		s.tick();
		const entry = await s.h.app.tasks.delete(s.id);
		await s.sync.sync();
		expect(s.link("task", s.id)?.mode).toBe("excluded");
		expect(s.tt.count("deleteTask")).toBe(0);
		return entry;
	}

	interface Copy {
		/** What happens to the TickTick copy. */
		copy: "deleted" | "kept" | "gone";
		/** It is looked up by its id first. */
		lookup?: true;
		/** Logwell tasks named "Call the bank" afterwards. */
		tasks: 0 | 1;
	}

	it.each<[string, (s: SyncedTask) => Promise<void>, Copy]>([
		["a plain copy whose task moved to a list that is not linked is deleted; the Logwell task stays", moveToUnlinked, { copy: "deleted", tasks: 1 }],
		[
			"a copy made repeating in TickTick, its task then deleted in Logwell before the next sync: only the link goes",
			async (s) => {
				s.tt.edit(s.ttId, { repeatFlag: DAILY });
				await s.h.app.tasks.delete(s.id);
			},
			{ copy: "kept", tasks: 0 },
		],
		[
			"a copy made repeating in TickTick, its task then moved to a list that is not linked: only the link goes",
			async (s) => {
				s.tt.edit(s.ttId, { repeatFlag: DAILY });
				await moveToUnlinked(s);
			},
			{ copy: "kept", tasks: 1 },
		],
		[
			"an excluded task purged in Logwell: a plain TickTick copy is deleted there",
			async (s) => {
				const entry = await excludedInTrash(s);
				await s.h.app.tasks.purge(entry.batchId);
				s.tick();
			},
			{ copy: "deleted", tasks: 0 },
		],
		[
			"an excluded task purged in Logwell: a repeating TickTick copy only loses its link",
			async (s) => {
				s.tt.edit(s.ttId, { repeatFlag: DAILY });
				const entry = await excludedInTrash(s);
				await s.h.app.tasks.purge(entry.batchId);
				s.tick();
			},
			{ copy: "kept", tasks: 0 },
		],
		[
			"a completed repeating series the pull did not see, purged: looked up, never deleted, only the link goes",
			async (s) => {
				completedUnseen(s, { repeatFlag: DAILY });
				await purge(s);
			},
			{ copy: "kept", lookup: true, tasks: 0 },
		],
		[
			"a completed plain copy the pull did not see, purged: looked up, then deleted",
			async (s) => {
				completedUnseen(s);
				await purge(s);
			},
			{ copy: "deleted", lookup: true, tasks: 0 },
		],
		[
			"a completed copy the pull did not see and TickTick no longer has, purged: no delete, the link goes",
			async (s) => {
				completedUnseen(s);
				await purge(s);
				s.tt.tasks.delete(s.ttId);
			},
			{ copy: "gone", tasks: 0 },
		],
	])("%s", async (_, act, want) => {
		const s = await oneSyncedTask();
		await act(s);
		const copy = s.tt.get(s.ttId);
		expect((await s.sync.sync()).ok).toBe(true);
		if (want.lookup) expect(s.tt.calls).toContain(`getTask:${s.ttId}`);
		if (want.copy === "deleted") {
			expect(s.tt.calls).toContain(`deleteTask:${s.ttId}`);
			expect(s.tt.live(s.projectId)).toEqual([]);
		} else {
			expect(s.tt.count("deleteTask")).toBe(0);
			expect(s.tt.get(s.ttId)).toEqual(copy);
		}
		expect(s.link("task", s.id)).toBeUndefined();
		s.tick();
		expect((await s.sync.sync()).ok).toBe(true);
		expect(s.tasks("Call the bank")).toHaveLength(want.tasks);
	});

	// White-box: the only way to reach the guard of the delete step is to have planning queue a delete it never would.
	it("the delete step itself drops a delete of a repeating copy that planning queued by mistake", async () => {
		const s = await oneSyncedTask();
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

	it("a lookup that fails deletes nothing, keeps the link for the next sync and reports the list", async () => {
		const s = await oneSyncedTask();
		completedUnseen(s);
		await purge(s);
		s.tt.fail("getTask", server());
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

describe("a create whose link write failed", () => {
	// "Buy milk" reached TickTick, but the store turned read-only before its link was written (`failedLink`). The next
	// sync pairs the answered create with what was sent, whatever happened to either copy since: it is never sent or
	// imported twice.

	it.each<[string, (s: SyncedTask) => Promise<unknown> | void, (s: SyncedTask) => Promise<void> | void]>([
		[
			"is linked by the next sync, not imported or created again",
			() => undefined,
			(s) => {
				expect(s.tasks("Buy milk")).toHaveLength(1);
				expect(s.tt.live(s.projectId).filter((t) => t.title === "Buy milk")).toHaveLength(1);
				expect(s.ttIdOf("Buy milk")).toBe(s.ttId);
			},
		],
		[
			"is linked even after its TickTick copy was completed, and completes in Logwell",
			(s) => s.tt.edit(s.ttId, { status: 2 }),
			(s) => {
				expect(s.tt.count("createTask")).toBe(1);
				expect(s.tt.live(s.projectId)).toHaveLength(1);
				expect(s.link("task", s.id)?.ttId).toBe(s.ttId);
				expect(s.h.app.store.state.tasks.get(s.id)?.status).toBe("completed");
			},
		],
		[
			"is linked even when the copy fell out of the completed window: one lookup by its id",
			(s) => {
				s.tt.edit(s.ttId, { status: 2 });
				// Completed long before the last pull: outside the window the completed list is read for.
				s.tt.tasks.set(s.ttId, { ...s.tt.tasks.get(s.ttId)!, completedTime: "2026-09-01T00:00:00.000+0000" });
			},
			(s) => {
				expect(s.tt.calls).toContain(`getTask:${s.ttId}`);
				expect(s.tt.count("createTask")).toBe(1);
				expect(s.link("task", s.id)?.ttId).toBe(s.ttId);
			},
		],
		[
			"keeps a Logwell edit made after the failed link write and pushes it (P9)",
			(s) => s.h.app.tasks.update(s.id, { title: "Buy oat milk", priority: 1 }),
			(s) => {
				expect(s.h.app.store.state.tasks.get(s.id)).toMatchObject({ title: "Buy oat milk", priority: 1 });
				expect(s.tt.get(s.ttId)).toMatchObject({ title: "Buy oat milk", priority: 5 });
				expect(s.tasks("Buy milk (TickTick)")).toHaveLength(0);
				expect(s.link("task", s.id)?.ttId).toBe(s.ttId);
			},
		],
		[
			"keeps a Logwell completion made after the failed link write and pushes it (P9b)",
			(s) => s.h.app.tasks.complete(s.id),
			(s) => {
				expect(s.h.app.store.state.tasks.get(s.id)?.status).toBe("completed");
				expect(s.tt.get(s.ttId)?.status).toBe(2);
			},
		],
		[
			"a same-field change on both sides follows the conflict rule",
			async (s) => {
				await s.h.app.tasks.update(s.id, { title: "Buy oat milk" });
				s.tt.edit(s.ttId, { title: "Buy soy milk" });
			},
			(s) => {
				expect(s.h.app.store.state.tasks.get(s.id)?.title).toBe("Buy oat milk");
				expect(s.tt.get(s.ttId)?.title).toBe("Buy oat milk");
				expect(s.tasks("Buy soy milk (TickTick)")).toHaveLength(1);
			},
		],
		[
			"a Logwell task in Trash: the copy is not imported, and is deleted by the next sync (P10)",
			(s) => s.h.app.tasks.delete(s.id),
			async (s) => {
				expect(s.h.app.store.state.tasks.size).toBe(0);
				expect(s.link("task", s.id)?.ttId).toBe(s.ttId);
				s.tick();
				await s.sync.sync();
				expect(s.tt.calls).toContain(`deleteTask:${s.ttId}`);
				expect(s.tt.live(s.projectId)).toHaveLength(0);
				expect(s.link("task", s.id)).toBeUndefined();
			},
		],
		[
			"a Logwell task purged meanwhile: the copy is not imported, and is deleted by the next sync",
			async (s) => {
				const entry = await s.h.app.tasks.delete(s.id);
				await s.h.app.tasks.purge(entry.batchId);
			},
			async (s) => {
				expect(s.h.app.store.state.tasks.size).toBe(0);
				expect(s.link("task", s.id)?.pendingDelete).toBe(true);
				s.tick();
				await s.sync.sync();
				expect(s.tt.calls).toContain(`deleteTask:${s.ttId}`);
				expect(s.tt.live(s.projectId)).toHaveLength(0);
			},
		],
	])("%s", async (_, meanwhile, check) => {
		const s = await failedLink();
		await meanwhile(s);
		expect((await s.sync.sync()).ok).toBe(true);
		await check(s);
	});

	it("#122: is linked after Obsidian restarts: this device remembers it, and neither side gets a second copy", async () => {
		const s = await failedLink();
		expect((await s.restart().sync()).ok).toBe(true);
		expect(s.tt.count("createTask")).toBe(1);
		expect(s.tt.live(s.projectId)).toHaveLength(1);
		expect(s.tasks("Buy milk")).toHaveLength(1);
		expect(s.link("task", s.id)?.ttId).toBe(s.ttId);
		// Linked, it is forgotten: a later restart sends nothing again.
		s.tick();
		expect((await s.restart().sync()).ok).toBe(true);
		expect(s.tt.count("createTask")).toBe(1);
		expect(s.tasks("Buy milk")).toHaveLength(1);
	});

	it("#122: is kept when the command that would link it fails, and linked by the next sync", async () => {
		const s = await failedLink();
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
		await makeWritable(s.h, s.saved, "r-repaired0002");
		s.tick();
		expect((await s.sync.sync()).ok).toBe(true);
		expect(s.tt.count("createTask")).toBe(1);
		expect(s.tt.live(s.projectId)).toHaveLength(1);
		expect(s.tasks("Buy milk")).toHaveLength(1);
		expect(s.link("task", s.id)?.ttId).toBe(s.ttId);
	});
});

describe("list failures", () => {
	it("a whole-push stop keeps the failures of lists that stopped before it", async () => {
		const s = await syncHarness();
		const work = await linkedList(s, "Work");
		const home = await linkedList(s, "Home");
		const y = (await s.h.app.tasks.create({ title: "Y", categoryId: work.listId })).task;
		await s.sync.sync();
		s.tick();
		await s.h.app.tasks.delete(y.id);
		await s.h.app.tasks.create({ title: "N", categoryId: home.listId });
		s.tt.fail("deleteTask", server());
		s.tt.fail("createTask", new TickTickError("network", "TickTick: no answer (network error)."));
		const r = await s.sync.sync();
		expect(r.ok).toBe(false);
		expect(r.failures.map((f) => [f.listName, f.kind])).toEqual([
			["Work", "server"],
			["Home", "network"],
		]);
	});

	it("the open count follows TickTick's status: a task completed in TickTick, reopened and moved in Logwell counts once", async () => {
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
		s.tt.fail("createTask", server());
		const r = await s.sync.sync();
		expect(s.tt.calls).toContain(`moveTasks:${s.ttIdOf("X")}`);
		expect(r.error).toMatchObject({ listName: "Home", kind: "server" });
	});
});

describe("stopping between requests", () => {
	// `stop()` (a session closing) stops the sync between two requests: at most the request already in flight
	// completes, what TickTick answered is still linked, and nothing else is sent or pulled.

	const creates = (calls: string[]) => calls.filter((c) => c.startsWith("createTask")).length;

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
