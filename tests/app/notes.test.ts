import type { App } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { LocalStorageRenameQueue } from "../../src/obsidian/renameQueue";
import { collectionsOf, CURRENT_SCHEMA_VERSION } from "../../src/persistence/schema";
import { MemoryRenameQueue, type NoteRename, type RenameQueuePort, type RenameTimers } from "../../src/app/ports";
import { TaskService } from "../../src/app/TaskService";
import { sequentialIds, settle } from "../helpers";
import { DB_PATH, descendant, emptyDbText, makeTask, withTask } from "../persistence/fixtures";
import { type AppHarness, appHarness, makeReadOnly, makeWritable, reopen, waitFor } from "./harness";
import { readHeader } from "../../src/persistence/serializer";

describe("note renames", () => {
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

		it("#134: a reloaded rename that fails is told through the session's error channel, not dropped silently", async () => {
			const renames = new MemoryRenameQueue();
			renames.save("db-1", [{ oldPath: "A.md", newPath: "B.md", isFolder: false }]);
			const h = await appHarness({ initial: supported, renames });
			const errors: unknown[] = [];
			h.app.store.bus.onListenerError = (err) => errors.push(err);
			vi.spyOn(h.app.store, "run").mockRejectedValueOnce(new Error("disk error"));
			await h.app.tasks.resumeRenames();
			expect(errors).toHaveLength(1);
			const message = (errors[0] as Error).message;
			expect(message).toContain("A.md");
			expect(message).toContain("B.md");
			expect(message).toContain("disk error");
			expect(pathOf(h, "t1")).toBe("A.md");
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

	describe("renames waiting behind a running drain are saved when the plugin closes", () => {
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

	describe("a failing rename-queue save never hangs a rename", () => {
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
});

describe("renames while a database is damaged", () => {
	// A damaged database that was never known has the placeholder
	// id "unknown". Renames seen meanwhile must not be saved under it (it names no
	// database), and must follow the real id once the database loads.

	/** A queue that records every save, so a write under any id can be asserted. */
	class RecordingQueue implements RenameQueuePort {
		readonly entries = new Map<string, NoteRename[]>();
		readonly saves: { id: string; renames: NoteRename[] }[] = [];
		load(id: string): NoteRename[] {
			return (this.entries.get(id) ?? []).map((r) => ({ ...r }));
		}
		save(id: string, renames: readonly NoteRename[]): void {
			this.saves.push({ id, renames: renames.map((r) => ({ ...r })) });
			if (renames.length === 0) this.entries.delete(id);
			else this.entries.set(id, renames.map((r) => ({ ...r })));
		}
	}

	const GARBAGE = "garbage, not a database\n";
	const AB: NoteRename = { oldPath: "A.md", newPath: "B.md", isFolder: false };
	const BC: NoteRename = { oldPath: "B.md", newPath: "C.md", isFolder: false };

	const linked = makeTask("t1", { descriptionNote: { path: "A.md", linkedAt: "2026-10-01T09:00:00.000Z" } });
	const realDb = descendant(emptyDbText("db-real", "r-base00000001"), (d) => withTask(d, linked).next, "r-real00000001");
	const pathOf = (h: AppHarness) => h.app.store.state.tasks.get("t1")?.descriptionNote?.path;

	async function damagedUnknown(queue: RecordingQueue): Promise<AppHarness> {
		const h = await appHarness({ initial: GARBAGE, renames: queue });
		expect(h.store.readOnlyState?.reason).toBe("damaged");
		expect(h.store.data.meta.dbId).toBe("unknown");
		return h;
	}

	describe("renames while a never-known database is damaged (N5)", () => {
		it("are not written to storage under the placeholder id", async () => {
			const q = new RecordingQueue();
			const h = await damagedUnknown(q);
			expect(await h.app.tasks.rewriteNotePaths("A.md", "B.md", false)).toBe(0);
			await h.app.tasks.rewriteNotePaths("B.md", "C.md", false);
			h.app.tasks.flushRenames();
			await settle();
			expect(q.saves).toEqual([]);
			expect(q.entries.size).toBe(0);
		});

		it("are applied in order once the real database loads, after the real id's saved renames", async () => {
			const q = new RecordingQueue();
			// An earlier session saved A -> B for the real database.
			q.entries.set("db-real", [AB]);
			const h = await damagedUnknown(q);
			await h.app.tasks.rewriteNotePaths("B.md", "C.md", false); // waits: read-only
			expect(q.saves).toEqual([]);

			await makeWritable(h, realDb);
			await waitFor(() => pathOf(h) === "C.md");

			// Saved first (A -> B), then the in-memory one (B -> C): any other order leaves B.md.
			expect(q.saves.map((s) => s.id)).not.toContain("unknown");
			expect(q.entries.size).toBe(0);
		});

		it("without saved renames, the in-memory ones are applied to the real database", async () => {
			const q = new RecordingQueue();
			const h = await damagedUnknown(q);
			await h.app.tasks.rewriteNotePaths("A.md", "B.md", false);
			await makeWritable(h, realDb);
			await waitFor(() => pathOf(h) === "B.md");
			expect(q.saves.map((s) => s.id)).not.toContain("unknown");
		});

		it("are saved under the real id when that database loads but cannot take them yet", async () => {
			const q = new RecordingQueue();
			const h = await damagedUnknown(q);
			await h.app.tasks.rewriteNotePaths("A.md", "B.md", false);
			await h.app.tasks.rewriteNotePaths("B.md", "C.md", false);

			// The file is repaired, but with a newer schema: loaded, still read-only.
			h.fs.files.set(DB_PATH, realDb.replace(`"schemaVersion":${CURRENT_SCHEMA_VERSION}`, '"schemaVersion":7'));
			await h.store.handleExternalChange();
			expect(h.store.readOnlyState?.reason).toBe("newer-schema");
			expect(h.store.data.meta.dbId).toBe("db-real");
			h.app.store.notifyReloaded();
			await settle();

			h.app.tasks.flushRenames();
			expect(q.saves.map((s) => s.id)).not.toContain("unknown");
			expect(q.entries.get("db-real")).toEqual([AB, BC]);
		});

		it("loading the real id's saved renames twice does not duplicate them", async () => {
			const q = new RecordingQueue();
			q.entries.set("db-real", [AB]);
			const h = await damagedUnknown(q);
			await h.app.tasks.resumeRenames(); // id still unknown: nothing is loaded
			await makeWritable(h, realDb);
			await waitFor(() => pathOf(h) === "B.md");
			await h.app.tasks.resumeRenames();
			h.app.store.notifyReloaded();
			await settle();
			expect(pathOf(h)).toBe("B.md");
			expect(q.entries.size).toBe(0);
		});
	});

	describe("a known database keeps the existing behavior", () => {
		it("a damaged database whose id is known still persists under that id", async () => {
			const q = new RecordingQueue();
			const good = await appHarness({ renames: q });
			await good.store.close();
			// The same file path later turns damaged; the id is recovered from local state.
			const h2 = await appHarness({ initial: emptyDbText("db-known"), renames: q });
			h2.fs.files.set(DB_PATH, GARBAGE);
			await h2.store.handleExternalChange();
			expect(h2.store.readOnlyState?.reason).toBe("damaged");
			expect(h2.store.data.meta.dbId).toBe("db-known");
			await h2.app.tasks.rewriteNotePaths("A.md", "B.md", false);
			h2.app.tasks.flushRenames();
			expect(q.entries.get("db-known")).toEqual([AB]);
		});
	});
});

describe("description notes (NOTE-01..10)", () => {
	it("AS-02 / NOTE-03: storage holds the path and link time, never the note text", async () => {
		const h = await appHarness();
		h.notes.files.set("Plan.md", "SECRET-BODY-TEXT with checklist\n- [ ] not a subtask");
		const { task } = await h.app.tasks.create({ title: "Plan things" });
		await h.app.tasks.linkNote(task.id, "Plan.md");
		await h.saveNow();
		const file = h.dbText();
		expect(file).toContain('"path":"Plan.md"');
		expect(file).not.toContain("SECRET-BODY-TEXT");
		// Checkboxes in the note never become subtasks.
		expect(h.app.store.state.tasks.size).toBe(1);
		for (const path of h.fs.files.keys()) expect(h.fs.files.get(path)).not.toContain("SECRET-BODY-TEXT");
	});

	it("NOTE-02 / B45: create names the note from the sanitized title and avoids collisions", async () => {
		const h = await appHarness();
		h.notes.files.set("Task notes/Plan ab.md", "existing");
		const { task } = await h.app.tasks.create({ title: "Plan: a/b" });
		const path = await h.app.tasks.createDescriptionNote(task.id);
		expect(path).toBe("Task notes/Plan ab (2).md");
		expect(h.notes.files.get("Task notes/Plan ab.md")).toBe("existing");
		expect(h.app.store.state.tasks.get(task.id)?.descriptionNote?.path).toBe(path);
	});

	it("AS-04 / NOTE-06 / NOTE-10: renames update references; renaming the task never renames the note", async () => {
		const h = await appHarness();
		h.notes.files.set("Plan.md", "");
		const { task } = await h.app.tasks.create({ title: "Plan", notePath: "Plan.md" });
		await h.app.tasks.update(task.id, { title: "Renamed" });
		expect(h.app.store.state.tasks.get(task.id)?.descriptionNote?.path).toBe("Plan.md");
		expect(await h.app.tasks.rewriteNotePaths("Plan.md", "Plan v2.md", false)).toBe(1);
		// Idempotent: the duplicate event of a folder rename is harmless.
		expect(await h.app.tasks.rewriteNotePaths("Plan.md", "Plan v2.md", false)).toBe(0);
		const t = h.app.store.state.tasks.get(task.id)!;
		expect(t.id).toBe(task.id);
		expect(t.descriptionNote?.path).toBe("Plan v2.md");
	});

	it("NOTE-06: a folder rename rewrites every reference by prefix, including trashed tasks", async () => {
		const h = await appHarness();
		const a = (await h.app.tasks.create({ title: "A", notePath: "Notes/a.md" })).task;
		const b = (await h.app.tasks.create({ title: "B", notePath: "Notes/sub/b.md" })).task;
		await h.app.tasks.delete(b.id);
		await h.app.tasks.rewriteNotePaths("Notes", "Archive/Notes", true);
		expect(h.app.store.state.tasks.get(a.id)?.descriptionNote?.path).toBe("Archive/Notes/a.md");
		const trashed = [...h.app.store.state.trash.values()][0]!.tasks[0]!;
		expect(trashed.descriptionNote?.path).toBe("Archive/Notes/sub/b.md");
	});

	it("NOTE-06: renames that arrive while read-only are replayed in order once writable", async () => {
		const h = await appHarness();
		const { task } = await h.app.tasks.create({ title: "Plan", notePath: "Notes/Plan.md" });
		await h.saveNow();
		const saved = h.dbText();
		await makeReadOnly(h);
		// A file rename, then a rename of its folder. Neither event comes again.
		expect(await h.app.tasks.rewriteNotePaths("Notes/Plan.md", "Notes/Plan v2.md", false)).toBe(0);
		expect(await h.app.tasks.rewriteNotePaths("Notes", "Archive", true)).toBe(0);
		expect(h.app.store.state.tasks.get(task.id)?.descriptionNote?.path).toBe("Notes/Plan.md");

		// The file is repaired outside Obsidian (another revision of the same database).
		const revision = readHeader(saved)!.revision;
		h.fs.files.set(DB_PATH, saved.replace(`"revision":"${revision}"`, '"revision":"r-repaired0001"'));
		await h.store.handleExternalChange();
		expect(h.app.store.readOnlyState).toBeNull();
		h.app.store.notifyStatus(); // DbSession does this on the store's "writable" event.
		await waitFor(() => h.app.store.state.tasks.get(task.id)?.descriptionNote?.path === "Archive/Plan v2.md");

		// Replaying is idempotent: a second status event changes nothing.
		const before = h.app.store.state;
		h.app.store.notifyStatus();
		await settle();
		expect(h.app.store.state).toBe(before);
	});

	it("no note is created while read-only or for a missing task", async () => {
		const h = await appHarness();
		const { task } = await h.app.tasks.create({ title: "Plan" });
		await expect(h.app.tasks.createDescriptionNote("missing")).rejects.toMatchObject({ code: "NotFound" });
		await makeReadOnly(h);
		await expect(h.app.tasks.createDescriptionNote(task.id)).rejects.toMatchObject({ code: "ReadOnly" });
		expect(h.notes.writes).toEqual([]);
	});

	it("AS-06 / NOTE-07 / NOTE-08: unlink leaves the file; a missing note does not block the task", async () => {
		const h = await appHarness();
		h.notes.files.set("Shared.md", "x");
		const a = (await h.app.tasks.create({ title: "A", notePath: "Shared.md" })).task;
		const b = (await h.app.tasks.create({ title: "B", notePath: "Shared.md" })).task;
		// Shared notes are shown as "Also linked from".
		expect(h.app.tasks.alsoLinkedFrom(a.id).map((t) => t.id)).toEqual([b.id]);
		await h.app.tasks.unlinkNote(a.id);
		expect(h.notes.files.has("Shared.md")).toBe(true);
		h.notes.files.delete("Shared.md");
		expect(h.app.tasks.noteExists("Shared.md")).toBe(false);
		await h.app.tasks.complete(b.id);
		expect(h.app.store.state.tasks.get(b.id)?.status).toBe("completed");
		expect(h.app.store.state.tasks.get(b.id)?.descriptionNote?.path).toBe("Shared.md");
	});

	it("NOTE-07: suggests a relink only when exactly one note has the same basename", async () => {
		const h = await appHarness();
		const { task } = await h.app.tasks.create({ title: "A", notePath: "Old/Plan.md" });
		h.notes.files.set("New/Plan.md", "");
		expect(h.app.tasks.relinkSuggestion(task.id)).toBe("New/Plan.md");
		h.notes.files.set("Other/Plan.md", "");
		expect(h.app.tasks.relinkSuggestion(task.id)).toBeNull();
	});
});
