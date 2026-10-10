import { describe, expect, it } from "vitest";
import { BackupStore, dbBackupRoot } from "../../src/persistence/backups";
import { SAVE_MAX_DELAY_MS, SAVE_RETRY_MS, type StoreEvent } from "../../src/persistence/CpbaseStore";
import { HISTORY_LIMIT, collectionsOf } from "../../src/persistence/schema";
import { serializeDb } from "../../src/persistence/serializer";
import { FakeClock, settle } from "../helpers";
import { BACKUP_ROOT, DB_PATH, type Harness, descendant, emptyDbText, harness, load, makeTask, withTask } from "./fixtures";
import { MemoryFileGateway } from "./memoryGateway";

// Regression tests for save retries, recovered lineage, snapshot order, conflict copy
// names, safe backup paths, reload snapshots and the explicit-replace paths.

const revisionOf = (h: Harness): string => load(h.dbText()).meta.revision;

/** Every stored path that is neither the database nor inside db-1's backup folder. */
function strayPaths(h: Harness): string[] {
	return [...h.fs.files.keys()].filter((p) => p !== DB_PATH && (!p.startsWith(`${BACKUP_ROOT}/db-1/`) || p.includes("..")));
}

function conflictPath(events: StoreEvent[]): string {
	const e = events.find((x) => x.type === "conflict");
	if (e?.type !== "conflict") throw new Error("no conflict event");
	return e.path;
}

describe("R1: a save that keeps failing compare-and-swap never stalls silently", () => {
	it("restoring while the file already holds our own revision keeps saving (incl. on close)", async () => {
		const h = harness();
		await h.store.open();
		h.addTask(makeTask("saved"));
		await h.saveNow();
		const good = h.dbText();
		h.fs.files.set(DB_PATH, `<<<<<<< HEAD\n${good}=======\n${good}>>>>>>> other\n`);
		await h.store.handleExternalChange();
		expect(h.store.readOnlyState?.reason).toBe("damaged");
		// `git checkout --ours`, then "Restore backup" before the modify event is handled.
		h.fs.files.set(DB_PATH, good);
		await h.store.restoreRecovered();
		await h.store.handleExternalChange(); // the late modify event
		expect(h.store.readOnlyState).toBeNull();
		expect(h.store.isDirty).toBe(false);
		h.addTask(makeTask("after"));
		await h.saveNow();
		expect(load(h.dbText()).tasks.has("after")).toBe(true);
		h.addTask(makeTask("on-close"));
		await h.store.close();
		expect(load(h.dbText()).tasks.has("on-close")).toBe(true);
	});

	it("a file that refuses every write surfaces one save error and keeps retrying", async () => {
		// Pathological: the compare-and-swap reports the current text (our own
		// revision) yet never writes. The store must neither loop nor go quiet.
		const h = harness(undefined, undefined, (file) => ({
			read: () => file.read(),
			write: async () => ({ written: false, current: (await file.read()) ?? "" }),
		}));
		await h.store.open();
		h.addTask(makeTask("x"));
		await h.saveNow();
		const errors = () => h.events.filter((e) => e.type === "save-error");
		expect(errors()).toHaveLength(1);
		expect(h.store.isDirty).toBe(true);
		expect(h.scheduler.pending).toBeGreaterThan(0);
		h.scheduler.advance(SAVE_RETRY_MS);
		await settle();
		expect(errors()).toHaveLength(1);
		expect(h.scheduler.pending).toBeGreaterThan(0);
	});
});

describe("R2: recovered history includes the replayed journal revisions", () => {
	async function threeSaves() {
		const a = harness();
		await a.store.open();
		const revs = [revisionOf(a)];
		const texts = [a.dbText()];
		for (const id of ["t1", "t2", "t3"]) {
			a.addTask(makeTask(id));
			await a.saveNow();
			revs.push(revisionOf(a));
			texts.push(a.dbText());
		}
		return { a, revs, texts };
	}

	it("recoverLatest and recoverRevision give a contiguous lineage", async () => {
		const { a, revs } = await threeSaves();
		const [r0, j1, j2, j3] = revs as [string, string, string, string];
		const latest = await a.store.recoverLatest();
		expect(latest?.data.meta).toMatchObject({ revision: j3, baseRevision: j2 });
		expect(latest?.data.meta.history.slice(-3)).toEqual([r0, j1, j2]);
		const j2Text = await a.store.recoverRevision(j2);
		expect(load(j2Text!).meta).toMatchObject({ revision: j2, baseRevision: j1, history: [r0, j1] });
	});

	it("an idle device on a replayed revision fast-forwards to the restored file", async () => {
		const { a, texts } = await threeSaves();
		// Device B synced the first journaled revision and is idle.
		const b = harness(texts[1]);
		await b.store.open();
		a.fs.files.set(DB_PATH, a.dbText().slice(0, 80));
		const a2 = a.newStore();
		await a2.open();
		await a2.restoreRecovered();
		b.fs.files.set(DB_PATH, a.dbText());
		b.events.length = 0;
		await b.store.handleExternalChange();
		expect(b.events.map((e) => e.type)).not.toContain("conflict");
		expect(b.store.data.tasks.has("t3")).toBe(true);
	});

	// replaceAll (import, keepMine, restoreSnapshot) keeps the current meta, so
	// its write extends the lineage like any save.
	it("restoreSnapshot continues the lineage, so an idle device fast-forwards", async () => {
		const h = harness();
		await h.store.open();
		h.addTask(makeTask("x"));
		await h.saveNow();
		const idle = harness(h.dbText());
		await idle.store.open();
		const [snap] = await h.store.listSnapshots();
		await h.store.restoreSnapshot(snap!.path);
		const meta = load(h.dbText()).meta;
		expect(meta.history.length).toBeLessThanOrEqual(HISTORY_LIMIT);
		idle.fs.files.set(DB_PATH, h.dbText());
		await idle.store.handleExternalChange();
		expect(idle.events.map((e) => e.type)).not.toContain("conflict");
		expect(idle.store.data.meta.revision).toBe(meta.revision);
	});
});

describe("R6: recovery does not trust another device's clock", () => {
	it("picks the snapshot this device wrote last, not the newest header writtenAt", async () => {
		const base = load(emptyDbText());
		// Device B wrote the file with a clock 2 h ahead.
		const h = harness(serializeDb({ ...base, meta: { ...base.meta, revision: "r-bbbbbbbbbbbb", writtenAt: "2026-10-01T12:00:00.000Z" } }));
		await h.store.open();
		h.addTask(makeTask("a1"));
		await h.saveNow();
		h.clock.advance(61 * 60 * 1000);
		h.addTask(makeTask("a2"));
		await h.saveNow();
		h.fs.files.set(DB_PATH, h.dbText().slice(0, 60));
		const s2 = h.newStore();
		await s2.open();
		expect([...s2.data.tasks.keys()].sort()).toEqual(["a1", "a2"]);
	});

	it("lists snapshots by this device's file stamp", async () => {
		const fs = new MemoryFileGateway();
		const clock = new FakeClock();
		const backups = new BackupStore(fs, "root", clock);
		const text = (revision: string, writtenAt: string) => {
			const d = load(emptyDbText());
			return serializeDb({ ...d, meta: { ...d.meta, revision, writtenAt } });
		};
		await backups.writeSnapshot("hourly", text("r-first", "2026-10-01T23:00:00.000Z"));
		clock.advance(1000);
		await backups.writeSnapshot("hourly", text("r-second", "2026-10-01T01:00:00.000Z"));
		await backups.writeSnapshot("daily", text("r-second", "2026-10-01T01:00:00.000Z"));
		const list = await backups.listSnapshots();
		expect(list.map((s) => s.revision)).toEqual(["r-second", "r-second", "r-first"]);
	});
});

describe("R7: conflict copy name matches its content", () => {
	it("a commit during an idle-fork copy renames the copy to the new revision", async () => {
		const h = harness();
		await h.store.open();
		h.addTask(makeTask("x"));
		await h.saveNow();
		h.fs.files.set(DB_PATH, descendant(emptyDbText(), (d) => withTask(d, makeTask("theirs")).next, "r-other0000001"));
		const write = h.fs.write.bind(h.fs);
		let injected = false;
		h.fs.write = async (path, data) => {
			if (!injected && path.includes("/conflicts/")) {
				injected = true;
				h.addTask(makeTask("during"));
			}
			await write(path, data);
		};
		await h.store.handleExternalChange();
		const conflicts = await h.store.listConflicts();
		expect(conflicts).toHaveLength(1);
		const [c] = conflicts;
		const content = load(h.fs.files.get(c!.path)!);
		expect(c!.revision).toBe(content.meta.revision);
		expect(content.tasks.has("during")).toBe(true);
		expect(c!.path).toBe(conflictPath(h.events));
	});
});

describe("R8: file header values never reach a path unchecked", () => {
	it("a traversal dbId makes the file damaged and writes nothing", async () => {
		const h = harness(emptyDbText("../../../../outside"));
		await h.store.open();
		expect(h.store.readOnlyState?.reason).toBe("damaged");
		expect([...h.fs.files.keys()].filter((p) => p !== DB_PATH)).toEqual([]);
	});

	it("a traversal dbId falls back to the known database's backups", async () => {
		const h = harness(emptyDbText("..%2F../x/../../outside"));
		h.local.knownDbId = "db-1";
		await h.store.open();
		expect(h.store.readOnlyState?.reason).toBe("damaged");
		expect(strayPaths(h)).toEqual([]);
		expect((await h.store.listConflicts()).length).toBe(1);
	});

	it("an unsafe known dbId from local state is not used", async () => {
		const h = harness("<<<<<<< not a database");
		h.local.knownDbId = "../../outside";
		await h.store.open();
		expect([...h.fs.files.keys()].filter((p) => p !== DB_PATH)).toEqual([]);
	});

	it("an external file with a traversal dbId or revision goes read-only without new paths", async () => {
		for (const [dbId, revision] of [
			["../../../../outside", "r-ok0000000001"],
			["db-1", "../../../../outside"],
		] as const) {
			const h = harness();
			await h.store.open();
			const d = load(h.dbText());
			h.fs.files.set(DB_PATH, serializeDb({ ...d, meta: { ...d.meta, dbId, revision, history: [d.meta.revision] } }));
			await h.store.handleExternalChange();
			expect(h.store.readOnlyState?.reason).toBe("damaged");
			expect(strayPaths(h)).toEqual([]);
		}
	});

	it("BackupStore keeps every path inside its root", async () => {
		const fs = new MemoryFileGateway();
		const backups = new BackupStore(fs, "root/db-1", new FakeClock());
		const path = await backups.writeConflict("x", "../../../evil");
		expect(path.startsWith("root/db-1/conflicts/")).toBe(true);
		expect(path).not.toContain("..");
		await expect(backups.read("root/db-1/../../outside.cpbase")).rejects.toThrow();
		await expect(backups.read("elsewhere/file.cpbase")).rejects.toThrow();
		await expect(backups.resolveConflict("root/db-1/conflicts/../../../x.cpbase")).rejects.toThrow();
		expect(dbBackupRoot("root", "db-1")).toBe("root/db-1");
		expect(() => dbBackupRoot("root", "../outside")).toThrow();
		expect(() => dbBackupRoot("root", "")).toThrow();
	});
});

describe("R9: snapshots after an external reload do not evict hourly snapshots", () => {
	it("five git pulls within minutes keep the hourly snapshots", async () => {
		const h = harness();
		await h.store.open();
		h.addTask(makeTask("t0"));
		await h.saveNow();
		h.clock.advance(61 * 60 * 1000);
		h.addTask(makeTask("t1"));
		await h.saveNow();
		const hourly = async () => (await h.store.listSnapshots()).filter((s) => s.kind === "hourly").map((s) => s.path);
		const before = await hourly();
		expect(before).toHaveLength(2);
		for (let i = 0; i < 7; i++) {
			h.clock.advance(5 * 60 * 1000);
			h.fs.files.set(DB_PATH, descendant(h.dbText(), (d) => d, `r-pull${String(i).padStart(8, "0")}`));
			await h.store.handleExternalChange();
			h.addTask(makeTask(`p${i}`));
			await h.saveNow();
		}
		expect(await hourly()).toEqual(before);
		const reloads = (await h.store.listSnapshots()).filter((s) => s.kind === "reload");
		expect(reloads).toHaveLength(5);
	});
});

describe("explicit replacement: commands that arrive meanwhile are never lost", () => {
	it("a commit during the pre-restore snapshot ends up in that snapshot", async () => {
		const h = harness();
		await h.store.open();
		h.addTask(makeTask("before"));
		await h.saveNow();
		const write = h.fs.write.bind(h.fs);
		let injected = false;
		h.fs.write = async (path, data) => {
			if (!injected && path.includes("/pre-restore-")) {
				injected = true;
				h.addTask(makeTask("during"));
			}
			await write(path, data);
		};
		await h.store.replaceAll(collectionsOf(load(emptyDbText())), "pre-restore");
		const [pre] = (await h.store.listSnapshots()).filter((s) => s.kind === "pre-restore");
		const backup = load(h.fs.files.get(pre!.path)!);
		expect([...backup.tasks.keys()].sort()).toEqual(["before", "during"]);
		expect(h.store.data.tasks.size).toBe(0);
		h.scheduler.advance(SAVE_MAX_DELAY_MS);
		await settle();
		expect(load(h.dbText()).tasks.size).toBe(0);
	});

	it("a commit during the replacing write is applied to the new state and saved", async () => {
		const h = harness();
		await h.store.open();
		h.addTask(makeTask("old"));
		await h.saveNow();
		const write = h.fs.write.bind(h.fs);
		let injected = false;
		h.fs.write = async (path, data) => {
			if (!injected && path === DB_PATH) {
				injected = true;
				h.addTask(makeTask("late"));
			}
			await write(path, data);
		};
		await h.store.replaceAll(collectionsOf(load(emptyDbText())), "pre-restore");
		h.scheduler.advance(SAVE_MAX_DELAY_MS);
		await settle();
		expect([...load(h.dbText()).tasks.keys()]).toEqual(["late"]);
	});

	it("a commit during restoreRecovered's write is saved", async () => {
		const h = harness();
		await h.store.open();
		h.addTask(makeTask("kept"));
		await h.saveNow();
		h.fs.files.set(DB_PATH, "<<<<<<< HEAD\nbroken\n");
		await h.store.handleExternalChange();
		const write = h.fs.write.bind(h.fs);
		let injected = false;
		h.fs.write = async (path, data) => {
			if (!injected && path === DB_PATH) {
				injected = true;
				h.addTask(makeTask("late"));
			}
			await write(path, data);
		};
		await h.store.restoreRecovered();
		h.scheduler.advance(SAVE_MAX_DELAY_MS);
		await settle();
		expect([...load(h.dbText()).tasks.keys()].sort()).toEqual(["kept", "late"]);
	});
});
