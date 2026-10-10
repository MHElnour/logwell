import type { App } from "obsidian";
import { describe, expect, it } from "vitest";
import { LocalStorageRenameQueue } from "../../src/obsidian/renameQueue";
import { collectionsOf } from "../../src/persistence/schema";
import { MemoryRenameQueue, type NoteRename, type RenameTimers } from "../../src/app/ports";
import { TaskService } from "../../src/app/TaskService";
import { sequentialIds, settle } from "../helpers";
import { DB_PATH, descendant, emptyDbText, makeTask, withTask } from "../persistence/fixtures";
import { type AppHarness, appHarness, makeReadOnly, makeWritable, reopen, waitFor } from "./harness";
import { CURRENT_SCHEMA_VERSION } from "../../src/persistence/schema";

// Rename tracking: chained renames in quick succession, queued renames across reloads and the
// memory-only rename queue.

type Rename = [oldPath: string, newPath: string, isFolder: boolean];

const CHAINS: { name: string; link: string; renames: [Rename, Rename]; final: string }[] = [
	{
		name: "file then file",
		link: "A.md",
		renames: [
			["A.md", "B.md", false],
			["B.md", "Folder/B.md", false],
		],
		final: "Folder/B.md",
	},
	{
		name: "file then folder",
		link: "Notes/A.md",
		renames: [
			["Notes/A.md", "Notes/B.md", false],
			["Notes", "Archive/Notes", true],
		],
		final: "Archive/Notes/B.md",
	},
	{
		name: "folder then file",
		link: "Notes/A.md",
		renames: [
			["Notes", "Archive", true],
			["Archive/A.md", "Archive/B.md", false],
		],
		final: "Archive/B.md",
	},
];

async function linkedTask(h: AppHarness, path: string): Promise<string> {
	h.notes.files.set(path, "");
	const { task } = await h.app.tasks.create({ title: "T" });
	await h.app.tasks.linkNote(task.id, path);
	return task.id;
}

const pathOf = (h: AppHarness, id: string) => h.app.store.state.tasks.get(id)?.descriptionNote?.path;

describe("chained renames in quick succession (R3)", () => {
	for (const chain of CHAINS) {
		it(`writable: ${chain.name} applies both, in order`, async () => {
			const h = await appHarness();
			const id = await linkedTask(h, chain.link);
			// The second event arrives before the first rewrite has committed.
			const [first, second] = chain.renames.map(([o, n, f]) => h.app.tasks.rewriteNotePaths(o, n, f));
			expect([await first, await second]).toEqual([1, 1]);
			expect(pathOf(h, id)).toBe(chain.final);
		});

		it(`read-only: ${chain.name} is replayed in order once writable`, async () => {
			const h = await appHarness();
			const id = await linkedTask(h, chain.link);
			await h.saveNow();
			const saved = h.dbText();
			await makeReadOnly(h);
			const counts = await Promise.all(chain.renames.map(([o, n, f]) => h.app.tasks.rewriteNotePaths(o, n, f)));
			expect(counts).toEqual([0, 0]);
			await makeWritable(h, saved);
			await waitFor(() => pathOf(h, id) === chain.final);
		});
	}

	it("a rename accepted while writable that runs after the store turned read-only is queued, not thrown", async () => {
		const h = await appHarness();
		const id = await linkedTask(h, "A.md");
		await h.saveNow();
		const saved = h.dbText();
		// Hold the command queue with a slow command, so the rename runs later.
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		h.store.replaceAll = () => gate;
		const blocker = h.app.store.replaceAll(collectionsOf(h.store.data), null);
		const first = h.app.tasks.rewriteNotePaths("A.md", "B.md", false);
		await makeReadOnly(h);
		const second = h.app.tasks.rewriteNotePaths("B.md", "Folder/B.md", false);
		release();
		await blocker;
		expect([await first, await second]).toEqual([0, 0]);
		expect(pathOf(h, id)).toBe("A.md");
		await makeWritable(h, saved);
		await waitFor(() => pathOf(h, id) === "Folder/B.md");
	});
});

describe("queued renames survive a reload (per database)", () => {
	const linked = makeTask("t1", { descriptionNote: { path: "A.md", linkedAt: "2026-10-01T09:00:00.000Z" } });
	const supported = descendant(emptyDbText(), (d) => withTask(d, linked).next, "r-base00000001");
	const newer = supported.replace(`"schemaVersion":${CURRENT_SCHEMA_VERSION}`, '"schemaVersion":7');

	it("a rename seen while the schema was newer is applied after a plugin update and reload", async () => {
		const renames = new MemoryRenameQueue();
		const h = await appHarness({ initial: newer, renames });
		expect(h.app.store.readOnlyState?.reason).toBe("newer-schema");
		expect(await h.app.tasks.rewriteNotePaths("A.md", "B.md", false)).toBe(0);
		expect(renames.load("db-1")).toEqual([{ oldPath: "A.md", newPath: "B.md", isFolder: false }]);

		// The plugin update: the same database now loads (modelled by a supported file).
		h.fs.files.set(DB_PATH, supported);
		const h2 = await reopen(h, renames);
		expect(h2.app.store.readOnlyState).toBeNull();
		expect(pathOf(h2, "t1")).toBe("B.md");
		expect(renames.load("db-1")).toEqual([]);
		await h2.saveNow(h2.store);
		expect(h2.dbText()).toContain('"path":"B.md"');
	});

	it("replay is idempotent: references already rewritten elsewhere stay as they are", async () => {
		const renames = new MemoryRenameQueue();
		renames.save("db-1", [
			{ oldPath: "A.md", newPath: "B.md", isFolder: false },
			{ oldPath: "B.md", newPath: "C.md", isFolder: false },
		]);
		// Another device already applied both renames.
		const done = descendant(supported, (d) => withTask(d, { ...linked, descriptionNote: { path: "C.md", linkedAt: linked.createdAt } }).next, "r-done00000001");
		const h = await appHarness({ initial: done, renames });
		const before = h.app.store.state;
		await h.app.tasks.resumeRenames();
		await settle();
		expect(h.app.store.state).toBe(before);
		expect(renames.load("db-1")).toEqual([]);
		// Resuming twice changes nothing either.
		await h.app.tasks.resumeRenames();
		expect(pathOf(h, "t1")).toBe("C.md");
	});

	it("queues are kept per database", async () => {
		const renames = new MemoryRenameQueue();
		renames.save("db-other", [{ oldPath: "A.md", newPath: "X.md", isFolder: false }]);
		const h = await appHarness({ initial: supported, renames });
		await h.app.tasks.resumeRenames();
		expect(pathOf(h, "t1")).toBe("A.md");
		expect(renames.load("db-other")).toHaveLength(1);
	});
});

describe("LocalStorageRenameQueue", () => {
	it("round-trips per dbId through JSON, clears on empty and ignores malformed entries", () => {
		const storage = new Map<string, string>();
		const app = {
			loadLocalStorage: (k: string): unknown => (storage.has(k) ? JSON.parse(storage.get(k)!) : null),
			saveLocalStorage: (k: string, v: unknown) => (v === null ? storage.delete(k) : storage.set(k, JSON.stringify(v))),
		} as unknown as App;
		const q = new LocalStorageRenameQueue(app);
		q.save("db-1", [{ oldPath: "A.md", newPath: "B.md", isFolder: false }]);
		expect(new LocalStorageRenameQueue(app).load("db-1")).toEqual([{ oldPath: "A.md", newPath: "B.md", isFolder: false }]);
		expect(q.load("db-2")).toEqual([]);
		q.save("db-1", []);
		expect(storage.size).toBe(0);
		storage.set("checkpoint-pending-renames-db-3", JSON.stringify([{ oldPath: "A.md" }, 5, { oldPath: "X", newPath: "Y", isFolder: true }]));
		expect(q.load("db-3")).toEqual([{ oldPath: "X", newPath: "Y", isFolder: true }]);
	});
});

// Writes of the rename queue are throttled: rewriting the whole queue for every queued and
// drained rename would make a folder rename (one event per child) cost O(n^2) bytes.

/** A rename queue that counts what it is asked to write. */
class CountingQueue extends MemoryRenameQueue {
	writes = 0;
	bytes = 0;

	override save(dbId: string, renames: readonly NoteRename[]): void {
		this.writes++;
		this.bytes += JSON.stringify(renames).length;
		super.save(dbId, renames);
	}
}

const burst = (h: AppHarness, n: number): Promise<number>[] =>
	Array.from({ length: n }, (_, i) => h.app.tasks.rewriteNotePaths(`Projects/Big/note ${i}.md`, `Archive/Big/note ${i}.md`, false));

/** Timers the test fires by hand, so the throttle window is deterministic. */
class ManualTimers implements RenameTimers {
	private fn: (() => void) | null = null;

	set(fn: () => void): unknown {
		this.fn = fn;
		return 1;
	}

	clear(): void {
		this.fn = null;
	}

	get active(): boolean {
		return this.fn !== null;
	}

	fire(): void {
		const fn = this.fn;
		this.fn = null;
		fn?.();
	}
}

/** A rename service over the harness's store that uses the given queue and timers. */
function serviceWith(h: AppHarness, queue: CountingQueue, timers: RenameTimers): TaskService {
	return new TaskService(h.app.store, sequentialIds("n"), h.app.settings, h.notes, queue, timers);
}

/** What one entry costs when serialized, with slack. A linear total stays within a small multiple of n entries. */
const ENTRY_BYTES = 120;

describe("rename bursts persist O(1) times, not once per event (N4)", () => {
	const N = 2000;

	it("writable: a synchronous burst applies every rename and writes the queue at most twice, linear in bytes", async () => {
		const q = new CountingQueue();
		const h = await appHarness({ renames: q });
		const id = await linkedTask(h, "Projects/Big/note 1500.md");
		await Promise.all(burst(h, N));
		expect(pathOf(h, id)).toBe("Archive/Big/note 1500.md");
		expect(q.writes).toBeLessThanOrEqual(2);
		expect(q.bytes).toBeLessThanOrEqual(2 * N * ENTRY_BYTES);
		expect(q.load("db-1")).toEqual([]);
	});

	it("writable: a single rename that applies at once never touches storage", async () => {
		const q = new CountingQueue();
		const h = await appHarness({ renames: q });
		const id = await linkedTask(h, "A.md");
		expect(await h.app.tasks.rewriteNotePaths("A.md", "B.md", false)).toBe(1);
		expect(pathOf(h, id)).toBe("B.md");
		expect(q.writes).toBe(0);
	});

	it("read-only: a synchronous burst is bounded to a couple of writes, and all of it is kept in order", async () => {
		const q = new CountingQueue();
		const h = await appHarness({ renames: q });
		await makeReadOnly(h);
		const counts = await Promise.all(burst(h, N));
		expect(counts.every((c) => c === 0)).toBe(true);
		await waitFor(() => q.load("db-1").length === N, 3000);
		expect(q.writes).toBeLessThanOrEqual(3);
		expect(q.bytes).toBeLessThanOrEqual(3 * N * ENTRY_BYTES);
		const saved = q.load("db-1");
		expect(saved[0]).toEqual({ oldPath: "Projects/Big/note 0.md", newPath: "Archive/Big/note 0.md", isFolder: false });
		expect(saved[N - 1]?.oldPath).toBe(`Projects/Big/note ${N - 1}.md`);
	});

	it("read-only: a burst spread over many event-loop turns writes once at once, then once per cooldown", async () => {
		const q = new CountingQueue();
		const h = await appHarness({ renames: q });
		const timers = new ManualTimers();
		const tasks = serviceWith(h, q, timers);
		await makeReadOnly(h);
		const n = 300;
		for (let i = 0; i < n; i++) {
			void tasks.rewriteNotePaths(`F/${i}.md`, `G/${i}.md`, false);
			await new Promise((r) => setImmediate(r));
		}
		// Quadratic persistence would be n writes of a growing list.
		expect(q.writes).toBe(1);
		expect(q.load("db-1")).toHaveLength(1);
		timers.fire();
		expect(q.writes).toBe(2);
		expect(q.load("db-1")).toHaveLength(n);
		expect(q.bytes).toBeLessThanOrEqual(2 * n * ENTRY_BYTES);
		// Nothing new arrived, so the next cooldown ends without a write.
		timers.fire();
		expect(q.writes).toBe(2);
		expect(timers.active).toBe(false);
	});

	it("flushRenames writes what the cooldown still holds back", async () => {
		const q = new CountingQueue();
		const h = await appHarness({ renames: q });
		const timers = new ManualTimers();
		const tasks = serviceWith(h, q, timers);
		await makeReadOnly(h);
		await Promise.all(Array.from({ length: 50 }, (_, i) => tasks.rewriteNotePaths(`F/${i}.md`, `G/${i}.md`, false)));
		expect(q.load("db-1")).toHaveLength(1); // the first write went out at once
		tasks.flushRenames();
		expect(q.load("db-1")).toHaveLength(50);
		expect(timers.active).toBe(false);
		const writes = q.writes;
		tasks.flushRenames();
		expect(q.writes).toBe(writes);
	});

	it("read-only then writable: the burst replays in order and the stored queue is cleared", async () => {
		const q = new CountingQueue();
		const h = await appHarness({ renames: q });
		const id = await linkedTask(h, "A.md");
		await h.saveNow();
		const saved = h.dbText();
		await makeReadOnly(h);
		void h.app.tasks.rewriteNotePaths("A.md", "B.md", false);
		void h.app.tasks.rewriteNotePaths("B.md", "C.md", false);
		void h.app.tasks.rewriteNotePaths("C.md", "Folder/C.md", false);
		await waitFor(() => q.load("db-1").length === 3);
		await makeWritable(h, saved);
		await waitFor(() => pathOf(h, id) === "Folder/C.md");
		await waitFor(() => q.load("db-1").length === 0);
	});

	it("a burst queued while read-only survives a reload and replays in order", async () => {
		const q = new CountingQueue();
		const h = await appHarness({ renames: q });
		const id = await linkedTask(h, "A.md");
		await h.saveNow();
		await makeReadOnly(h);
		void h.app.tasks.rewriteNotePaths("A.md", "B.md", false);
		void h.app.tasks.rewriteNotePaths("B.md", "C.md", false);
		void h.app.tasks.rewriteNotePaths("C.md", "D.md", false);
		await waitFor(() => q.load("db-1").length === 3);
		// The file is repaired and the plugin reloads.
		h.fs.files.set(DB_PATH, h.dbText().replace(/^<<<<<<< HEAD\n/, ""));
		const h2 = await reopen(h, q);
		expect(pathOf(h2, id)).toBe("D.md");
		expect(q.load("db-1")).toEqual([]);
	});
});

describe("renames waiting behind a running drain are saved when the plugin closes (round 5, item 4)", () => {
	const chain: Rename[] = [
		["A.md", "B.md", false],
		["B.md", "C.md", false],
		["C.md", "Folder/C.md", false],
	];

	/** A writable burst whose first rename is stuck in the command queue, so none has been applied. */
	async function burstInProgress(q: CountingQueue) {
		const h = await appHarness({ renames: q });
		const id = await linkedTask(h, "A.md");
		await h.saveNow();
		const saved = h.dbText();
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		h.store.replaceAll = () => gate;
		const blocker = h.app.store.replaceAll(collectionsOf(h.store.data), null);
		const results = chain.map(([o, n, f]) => h.app.tasks.rewriteNotePaths(o, n, f));
		await settle();
		return { h, id, saved, release, blocker, results };
	}

	it("flushRenames stores every unapplied rename even though no save was wanted", async () => {
		const q = new CountingQueue();
		const { h, release, blocker, results } = await burstInProgress(q);
		expect(q.writes).toBe(0); // writable: nothing has been stored so far
		h.app.tasks.flushRenames();
		expect(q.load("db-1")).toEqual(chain.map(([oldPath, newPath, isFolder]) => ({ oldPath, newPath, isFolder })));
		release();
		await blocker;
		await Promise.all(results);
	});

	it("a plugin unload at that moment loses nothing: reopening replays them once, in order", async () => {
		const q = new CountingQueue();
		const { h, id, saved, release, blocker } = await burstInProgress(q);
		h.app.tasks.flushRenames();
		// The plugin unloads here: only what is in local storage and the file survives.
		const stored = q.load("db-1");
		const survivingQueue = new MemoryRenameQueue();
		survivingQueue.save("db-1", stored);
		release();
		await blocker;

		const h2 = await appHarness({ initial: saved, renames: survivingQueue });
		expect(pathOf(h2, id)).toBe("A.md");
		await h2.app.tasks.resumeRenames();
		expect(pathOf(h2, id)).toBe("Folder/C.md");
		expect(survivingQueue.load("db-1")).toEqual([]);
		// Replaying a rename that was in fact already applied changes nothing.
		survivingQueue.save("db-1", stored);
		await h2.app.tasks.resumeRenames();
		expect(pathOf(h2, id)).toBe("Folder/C.md");
	});

	it("never writes under the placeholder id", async () => {
		const q = new CountingQueue();
		const h = await appHarness({ initial: "garbage, not a database\n", renames: q });
		void h.app.tasks.rewriteNotePaths("A.md", "B.md", false);
		await settle();
		h.app.tasks.flushRenames();
		expect(q.writes).toBe(0);
	});

	it("does not clobber renames an earlier session stored and this one has not loaded yet", async () => {
		const q = new CountingQueue();
		q.save("db-1", [{ oldPath: "X.md", newPath: "Y.md", isFolder: false }]);
		const h = await appHarness({ renames: q });
		h.app.tasks.flushRenames();
		expect(q.load("db-1")).toEqual([{ oldPath: "X.md", newPath: "Y.md", isFolder: false }]);
	});

	it("with nothing waiting and nothing stored, a flush writes nothing", async () => {
		const q = new CountingQueue();
		const h = await appHarness({ renames: q });
		h.app.tasks.flushRenames();
		expect(q.writes).toBe(0);
	});
});

describe("a failing rename-queue save never hangs a rename (final gate)", () => {
	class ThrowingQueue extends MemoryRenameQueue {
		override save(): void {
			throw new Error("QuotaExceeded");
		}
	}

	it("read-only: callers still get 0 and the renames stay queued in memory", async () => {
		const h = await appHarness({ renames: new ThrowingQueue() });
		await makeReadOnly(h);
		const result = await Promise.race([
			h.app.tasks.rewriteNotePaths("A.md", "B.md", false),
			new Promise<string>((r) => setTimeout(() => r("hung"), 1000)),
		]);
		expect(result).toBe(0);
	});
});
