import { describe, expect, it } from "vitest";
import { BackupStore } from "../../src/persistence/backups";
import type { StoreEvent } from "../../src/persistence/CpbaseStore";
import type { DbFile } from "../../src/persistence/gateway";
import { MemoryFileGateway } from "./memoryGateway";
import { FakeClock } from "../helpers";
import { DB_PATH, type Harness, descendant, emptyDbText, harness, load, makeTask, withTask } from "./fixtures";
import { CURRENT_SCHEMA_VERSION } from "../../src/persistence/schema";

// Regression tests for future-stamped snapshots, close() with pending changes,
// rollbacks and a newer-schema file that becomes valid. The import check and
// the command-queue routing are in tests/app/review3.test.ts.

describe("N2: a snapshot stamped in the future (clock jumped back) never outranks later ones", () => {
	async function clockJump(): Promise<Harness> {
		const h = harness();
		await h.store.open(); // S0 stamped 2026-10-01
		h.clock.set("2027-10-01T10:00:00.000Z"); // wrong clock
		h.addTask(makeTask("a1"));
		await h.saveNow(); // S1 stamped 2027, holds a1
		h.clock.set("2026-10-01T11:00:00.000Z"); // corrected
		h.addTask(makeTask("a2"));
		await h.saveNow();
		await h.store.close();
		const s2 = h.newStore();
		await s2.open();
		h.addTask(makeTask("a3"), s2);
		await h.saveNow(s2);
		await s2.close();
		return h;
	}

	it("recovery returns the latest data after the clock was corrected", async () => {
		const h = await clockJump();
		h.fs.files.set(DB_PATH, h.dbText().slice(0, 60));
		const s3 = h.newStore();
		await s3.open();
		expect([...s3.data.tasks.keys()].sort()).toEqual(["a1", "a2", "a3"]);
	});

	it("lists snapshots stamped later than now last", async () => {
		const h = await clockJump();
		const list = await h.store.listSnapshots();
		const stamps = list.map((s) => s.stamp);
		const future = stamps.filter((s) => s.startsWith("2027"));
		expect(future.length).toBeGreaterThan(0);
		expect(stamps.slice(-future.length)).toEqual(future);
	});

	it("takes the hourly snapshot after the clock went back instead of waiting for the old time", async () => {
		const h = harness();
		await h.store.open();
		h.clock.set("2027-10-01T10:00:00.000Z");
		h.addTask(makeTask("a1"));
		await h.saveNow();
		h.clock.set("2026-10-01T11:00:00.000Z");
		h.addTask(makeTask("a2"));
		await h.saveNow();
		const real = (await h.store.listSnapshots()).filter((s) => s.kind === "hourly" && s.stamp.startsWith("2026"));
		expect(real.map((s) => s.stamp.slice(0, 15))).toContain("20261001T110000");
	});

	it("still recovers from a future-stamped snapshot when its journal is the only chain to the last write", async () => {
		const h = harness();
		await h.store.open(); // S0 (old state)
		h.clock.set("2027-10-01T10:00:00.000Z");
		h.addTask(makeTask("a1"));
		await h.saveNow(); // hourly S1 (future) holds a1, journal reset
		h.clock.set("2026-10-01T10:05:00.000Z");
		// Snapshots can no longer be written, so a2 survives only in the journal on top of S1.
		const write = h.fs.write.bind(h.fs);
		h.fs.write = async (path, data) => {
			if (path.includes("/snapshots/")) throw new Error("disk full");
			await write(path, data);
		};
		h.addTask(makeTask("a2"));
		await h.saveNow();
		h.fs.write = write;
		h.fs.files.set(DB_PATH, h.dbText().slice(0, 60));
		const s2 = h.newStore();
		await s2.open();
		expect([...s2.data.tasks.keys()].sort()).toEqual(["a1", "a2"]);
	});

	it("prunes future-stamped hourly snapshots before real ones", async () => {
		const fs = new MemoryFileGateway();
		const clock = new FakeClock("2027-10-01T10:00:00.000Z");
		const backups = new BackupStore(fs, "root", clock);
		const text = (revision: string) => emptyDbText("db-1", revision);
		for (let i = 0; i < 3; i++) {
			await backups.writeSnapshot("hourly", text(`r-future${i}`));
			clock.advance(1000);
		}
		clock.set("2026-10-01T10:00:00.000Z");
		for (let i = 0; i < 4; i++) {
			await backups.writeSnapshot("hourly", text(`r-real${i}`));
			clock.advance(1000);
		}
		await backups.prune();
		const left = (await backups.listSnapshots()).map((s) => s.revision);
		expect(left).toEqual(["r-real3", "r-real2", "r-real1", "r-real0", "r-future2"]);
	});
});

describe("N3: close() keeps pending changes whenever the save left the store dirty", () => {
	it("writes the conflict copy and announces it even if the file was recreated meanwhile", async () => {
		let recreate: string | null = null;
		const wrap = (file: DbFile): DbFile => ({
			read: () => file.read(),
			write: async (content, expected) => {
				const r = await file.write(content, expected);
				if (!r.written && r.current === null && recreate !== null) h.fs.files.set(DB_PATH, recreate);
				return r;
			},
		});
		const h = harness(emptyDbText(), undefined, wrap);
		await h.store.open();
		h.addTask(makeTask("saved"));
		await h.saveNow();
		recreate = h.dbText();
		h.addTask(makeTask("pending"));
		h.fs.files.delete(DB_PATH);
		await h.store.close();
		const conflicts = await h.store.listConflicts();
		expect(conflicts).toHaveLength(1);
		expect(load(h.fs.files.get(conflicts[0]!.path)!).tasks.has("pending")).toBe(true);
		const e = h.events.find((x) => x.type === "pending-saved-as-conflict");
		expect(e).toEqual({ type: "pending-saved-as-conflict", path: conflicts[0]!.path });
	});

	it("announces the copy for a deleted file too, and nothing when everything was saved", async () => {
		const h = harness();
		await h.store.open();
		h.addTask(makeTask("t1"));
		h.fs.files.delete(DB_PATH);
		await h.store.close();
		expect(h.events.filter((x) => x.type === "pending-saved-as-conflict")).toHaveLength(1);

		const clean = harness();
		await clean.store.open();
		clean.addTask(makeTask("t1"));
		await clean.store.close();
		expect(clean.events.some((x) => x.type === "pending-saved-as-conflict")).toBe(false);
		expect(await clean.store.listConflicts()).toHaveLength(0);
	});
});

describe("finding 4: only the revision just written is a self-write", () => {
	async function threeSaves() {
		const h = harness();
		await h.store.open();
		const texts: string[] = [];
		for (const id of ["t1", "t2", "t3"]) {
			h.addTask(makeTask(id));
			await h.saveNow();
			texts.push(h.dbText());
		}
		h.events.length = 0;
		return { h, texts: texts as [string, string, string] };
	}
	const types = (events: StoreEvent[]) => events.map((e) => e.type);

	it("a rollback to an older own revision reloads it (no conflict while clean) and later saves keep it", async () => {
		const { h, texts } = await threeSaves();
		h.fs.files.set(DB_PATH, texts[0]);
		await h.store.handleExternalChange();
		expect([...h.store.data.tasks.keys()]).toEqual(["t1"]);
		expect(types(h.events)).not.toContain("conflict");
		h.addTask(makeTask("t4"));
		await h.saveNow();
		expect([...load(h.dbText()).tasks.keys()].sort()).toEqual(["t1", "t4"]);
	});

	it("with pending edits the rollback takes the fork path: conflict copy, rolled-back version loaded", async () => {
		const { h, texts } = await threeSaves();
		h.addTask(makeTask("pending"));
		h.fs.files.set(DB_PATH, texts[0]);
		await h.store.handleExternalChange();
		expect(types(h.events)).toContain("conflict");
		expect([...h.store.data.tasks.keys()]).toEqual(["t1"]);
		const [c] = await h.store.listConflicts();
		expect(load(h.fs.files.get(c!.path)!).tasks.has("pending")).toBe(true);
	});

	it("a rollback that arrives before its modify event is not overwritten by the next save", async () => {
		const { h, texts } = await threeSaves();
		h.fs.files.set(DB_PATH, texts[1]);
		h.addTask(makeTask("pending"));
		await h.saveNow();
		expect(h.dbText()).toBe(texts[1]);
		expect(types(h.events)).toContain("conflict");
		expect([...h.store.data.tasks.keys()].sort()).toEqual(["t1", "t2"]);
	});

	it("the current revision is still a no-op", async () => {
		const { h } = await threeSaves();
		await h.store.handleExternalChange();
		expect(types(h.events)).toEqual([]);
		expect(h.store.data.tasks.size).toBe(3);
	});
});

describe("finding 5: a newer-schema database becomes writable again when the file is valid again", () => {
	it("an external change back to a current-schema file reloads it and clears read-only", async () => {
		const base = emptyDbText();
		const h = harness(base.replace(`"schemaVersion":${CURRENT_SCHEMA_VERSION}`, '"schemaVersion":99'));
		await h.store.open();
		expect(h.store.readOnlyState?.reason).toBe("newer-schema");
		h.events.length = 0;
		h.fs.files.set(DB_PATH, descendant(base, (d) => withTask(d, makeTask("back")).next, "r-downgraded01"));
		await h.store.handleExternalChange();
		expect(h.store.readOnlyState).toBeNull();
		expect(h.store.data.tasks.has("back")).toBe(true);
		expect(h.events.map((e) => e.type)).toEqual(expect.arrayContaining(["writable", "loaded"]));
		expect(h.events.some((e) => e.type === "conflict")).toBe(false);
		h.addTask(makeTask("after"));
		await h.saveNow();
		expect([...load(h.dbText()).tasks.keys()].sort()).toEqual(["after", "back"]);
	});

	it("the same revision with the schema version lowered is not skipped as a self-write", async () => {
		const base = emptyDbText();
		const h = harness(base.replace(`"schemaVersion":${CURRENT_SCHEMA_VERSION}`, '"schemaVersion":99'));
		await h.store.open();
		h.fs.files.set(DB_PATH, base);
		await h.store.handleExternalChange();
		expect(h.store.readOnlyState).toBeNull();
	});

	it("a still-newer file stays read-only and shows what can be read", async () => {
		const base = emptyDbText();
		const h = harness(base.replace(`"schemaVersion":${CURRENT_SCHEMA_VERSION}`, '"schemaVersion":99'));
		await h.store.open();
		h.fs.files.set(DB_PATH, base.replace(`"schemaVersion":${CURRENT_SCHEMA_VERSION}`, '"schemaVersion":100'));
		await h.store.handleExternalChange();
		expect(h.store.readOnlyState?.reason).toBe("newer-schema");
	});
});
