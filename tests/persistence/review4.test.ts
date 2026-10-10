import { describe, expect, it, vi } from "vitest";
import { BackupStore, SNAPSHOT_INTERVAL_MS } from "../../src/persistence/backups";
import { revisionOf } from "../../src/persistence/serializer";
import { DB_PATH, descendant, harness, load, makeTask } from "./fixtures";

// Regression tests for the store: retries after a write that threw, close()
// that never rejects, and recovery that reads as few snapshots as it can.

describe("finding 1: a retry after a write that threw (header intact) is still our own write", () => {
	it("stays writable and saves the retry", async () => {
		const h = harness();
		await h.store.open();
		h.addTask(makeTask("t1"));
		h.fs.failNextWrite((p) => p === DB_PATH, 400); // torn: the header survives, the write throws
		await h.saveNow();
		expect(h.events.some((e) => e.type === "save-error")).toBe(true);
		await h.saveNow(); // the retry runs before the torn file's modify event is handled
		expect(h.store.readOnlyState).toBeNull();
		expect(h.events.some((e) => e.type === "read-only")).toBe(false);
		expect(load(h.dbText()).tasks.has("t1")).toBe(true);
		// the late modify event for the torn file changes nothing
		await h.store.handleExternalChange();
		expect(h.store.readOnlyState).toBeNull();
		expect(h.store.data.tasks.has("t1")).toBe(true);
	});

	it("survives several failed attempts before one succeeds", async () => {
		const h = harness();
		await h.store.open();
		h.addTask(makeTask("t1"));
		h.fs.failNextWrite((p) => p === DB_PATH, 400);
		h.fs.failNextWrite((p) => p === DB_PATH, 400);
		await h.saveNow();
		await h.saveNow();
		await h.saveNow();
		expect(h.store.readOnlyState).toBeNull();
		expect(h.events.some((e) => e.type === "conflict")).toBe(false);
		expect(load(h.dbText()).tasks.has("t1")).toBe(true);
	});

	it("a revision attempted before a successful write is an external change again (rollback)", async () => {
		const h = harness();
		await h.store.open();
		h.addTask(makeTask("t1"));
		h.fs.failNextWrite((p) => p === DB_PATH, 1_000_000); // the whole file lands, then the write throws
		await h.saveNow();
		const failedText = h.dbText();
		const failedRevision = revisionOf(failedText);
		h.addTask(makeTask("t2"));
		await h.saveNow(); // succeeds: the failed revision is no longer pending
		expect(revisionOf(h.dbText())).not.toBe(failedRevision);
		expect(h.store.data.tasks.has("t2")).toBe(true);
		h.fs.files.set(DB_PATH, failedText);
		await h.store.handleExternalChange();
		expect([...h.store.data.tasks.keys()]).toEqual(["t1"]);
	});
});

describe("finding 2: close() never rejects", () => {
	it("resolves and reports when the conflict copy cannot be written", async () => {
		const h = harness();
		await h.store.open();
		h.addTask(makeTask("pending"));
		h.fs.failNextWrite((p) => p === DB_PATH); // the save fails, so the edits stay pending
		const write = h.fs.write.bind(h.fs);
		h.fs.write = async (path, data) => {
			if (path.includes("/conflicts/")) throw new Error("disk full");
			await write(path, data);
		};
		await expect(h.store.close()).resolves.toBeUndefined();
		// Round 5: the lost edits get their own event, not a save error that promises a retry.
		expect(h.events.some((e) => e.type === "edits-lost" && e.message.includes("disk full"))).toBe(true);
		expect(h.events.some((e) => e.type === "pending-saved-as-conflict")).toBe(false);
	});

	it("resolves when the final save itself throws while handling a concurrent change", async () => {
		const h = harness();
		await h.store.open();
		h.addTask(makeTask("pending"));
		// another device changed the file; saving must set our edits aside, which fails
		h.fs.files.set(DB_PATH, descendant(h.dbText(), (d) => d, "r-other0000001"));
		const write = h.fs.write.bind(h.fs);
		h.fs.write = async (path, data) => {
			if (path.includes("/conflicts/")) throw new Error("disk full");
			await write(path, data);
		};
		await expect(h.store.close()).resolves.toBeUndefined();
		expect(h.events.some((e) => e.type === "edits-lost" && e.message.includes("disk full"))).toBe(true);
	});

	it("a successful conflict copy is still announced", async () => {
		const h = harness();
		await h.store.open();
		h.addTask(makeTask("pending"));
		h.fs.files.delete(DB_PATH);
		await h.store.close();
		expect(h.events.filter((e) => e.type === "pending-saved-as-conflict")).toHaveLength(1);
	});
});

describe("finding 3: recoverLatest stops at the first usable snapshot", () => {
	async function manySnapshots() {
		const h = harness();
		await h.store.open();
		for (const id of ["a", "b", "c", "d"]) {
			h.clock.advance(SNAPSHOT_INTERVAL_MS + 1000);
			h.addTask(makeTask(id));
			await h.saveNow();
		}
		// two more saves that live only in the journal on top of the newest snapshot
		h.addTask(makeTask("e"));
		await h.saveNow();
		h.addTask(makeTask("f"));
		await h.saveNow();
		await h.store.close();
		return h;
	}
	const snapshotReads = (spy: { mock: { calls: unknown[][] } }): number =>
		spy.mock.calls.filter((c) => String(c[0]).includes("/snapshots/")).length;

	it("reads one snapshot when the newest one is valid, and still reaches the last write", async () => {
		const h = await manySnapshots();
		expect((await h.store.listSnapshots()).length).toBeGreaterThanOrEqual(4);
		h.fs.files.set(DB_PATH, h.dbText().slice(0, 60));
		const spy = vi.spyOn(BackupStore.prototype, "read");
		try {
			const s2 = h.newStore();
			await s2.open();
			expect([...s2.data.tasks.keys()].sort()).toEqual(["a", "b", "c", "d", "e", "f"]);
			expect(snapshotReads(spy)).toBe(1);
		} finally {
			spy.mockRestore();
		}
	});

	it("skips an unreadable newest snapshot and reads only up to the next valid one", async () => {
		const h = await manySnapshots();
		const [newest] = await h.store.listSnapshots();
		h.fs.files.set(newest!.path, "garbage");
		h.fs.files.set(DB_PATH, h.dbText().slice(0, 60));
		const spy = vi.spyOn(BackupStore.prototype, "read");
		try {
			const s2 = h.newStore();
			await s2.open();
			expect(s2.data.tasks.has("c")).toBe(true);
			expect(snapshotReads(spy)).toBe(2);
		} finally {
			spy.mockRestore();
		}
	});
});
