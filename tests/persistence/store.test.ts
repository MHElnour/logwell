import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { isDomainError } from "../../src/domain/errors";
import { SAVE_DEBOUNCE_MS, SAVE_MAX_DELAY_MS, SAVE_RETRY_MS, type StoreEvent } from "../../src/persistence/CpbaseStore";
import { parseDbText, readHeader, revisionOf, serializeDb } from "../../src/persistence/serializer";
import { FakeClock, settle } from "../helpers";
import { BACKUP_ROOT, DB_PATH, descendant, descendants, emptyDbText, harness, type Harness, load, makeTask, withTask } from "./fixtures";
import { collectionsOf, CURRENT_SCHEMA_VERSION, HISTORY_LIMIT } from "../../src/persistence/schema";
import { bindFile, MemoryFileGateway } from "./memoryGateway";
import { type JournalEntry, replayJournal } from "../../src/persistence/journal";
import { BackupStore, dbBackupRoot, SNAPSHOT_INTERVAL_MS } from "../../src/persistence/backups";
import type { DbFile } from "../../src/persistence/gateway";

describe("CpbaseStore: open and save", () => {
	it("opens a database and takes a session snapshot", async () => {
		const h = harness();
		await h.store.open();
		expect(h.store.readOnlyState).toBeNull();
		expect(h.store.data.categories.get("inbox")?.isInbox).toBe(true);
		const snaps = await h.fs.list(`${BACKUP_ROOT}/db-1/snapshots`);
		expect(snaps.some((p) => p.includes("/hourly-"))).toBe(true);
		expect(snaps.some((p) => p.includes("/daily-20261001T"))).toBe(true);
	});

	it("debounces saves by 300 ms and appends the journal before writing", async () => {
		const h = harness();
		await h.store.open();
		const before = h.dbText();
		h.addTask(makeTask("t1"));
		h.scheduler.advance(SAVE_DEBOUNCE_MS - 1);
		await settle();
		expect(h.dbText()).toBe(before);
		h.scheduler.advance(1);
		await settle();
		const after = load(h.dbText());
		expect(after.tasks.has("t1")).toBe(true);
		expect(after.meta.baseRevision).toBe("r-000000000000");
		expect(after.meta.history).toEqual(["r-000000000000"]);
		expect(after.meta.writtenBy).toBe("d-test");
		const journal = h.fs.files.get(`${BACKUP_ROOT}/db-1/journal.ndjson`) ?? "";
		expect(journal).toContain('"id":"t1"');
		expect(h.local.getLastWritten("db-1")).toBe(after.meta.revision);
	});

	it("never waits longer than 2 s in total", async () => {
		const h = harness();
		await h.store.open();
		const before = h.dbText();
		for (let i = 0; i < 9; i++) {
			h.addTask(makeTask(`t${i}`));
			h.scheduler.advance(200);
			await settle();
		}
		expect(h.dbText()).toBe(before);
		h.addTask(makeTask("t9"));
		h.scheduler.advance(SAVE_MAX_DELAY_MS - 1800);
		await settle();
		expect(load(h.dbText()).tasks.size).toBe(10);
	});

	it("ignores the modify event of its own write", async () => {
		const h = harness();
		await h.store.open();
		h.addTask(makeTask("t1"));
		await h.saveNow();
		h.events.length = 0;
		await h.store.handleExternalChange();
		expect(h.events).toEqual([]);
	});
});

describe("CpbaseStore: external changes", () => {
	it("B39: fast-forwards a descendant version when nothing is pending", async () => {
		const h = harness();
		await h.store.open();
		h.fs.files.set(DB_PATH, descendant(h.dbText(), (d) => withTask(d, makeTask("remote")).next, "r-remote"));
		await h.store.handleExternalChange();
		expect(h.store.data.tasks.has("remote")).toBe(true);
		expect(h.store.data.meta.revision).toBe("r-remote");
		expect(h.events.some((e) => e.type === "conflict")).toBe(false);
		expect(h.events.some((e) => e.type === "loaded" && e.cause === "external")).toBe(true);
	});

	it("B40: a fork with pending local edits keeps a conflict copy and loads theirs", async () => {
		const h = harness();
		await h.store.open();
		h.addTask(makeTask("mine"));
		h.fs.files.set(DB_PATH, descendant(h.dbText(), (d) => withTask(d, makeTask("theirs")).next, "r-theirs"));
		await h.store.handleExternalChange();
		expect(h.store.data.tasks.has("theirs")).toBe(true);
		expect(h.store.data.tasks.has("mine")).toBe(false);
		const conflict = h.events.find((e) => e.type === "conflict");
		if (conflict?.type !== "conflict") throw new Error("no conflict event");
		expect(h.fs.files.get(conflict.path)).toContain('"id":"mine"');
		// The incoming version is never overwritten by the pending save.
		h.scheduler.advance(SAVE_MAX_DELAY_MS);
		await settle();
		expect(load(h.dbText()).meta.revision).toBe("r-theirs");

		await h.store.keepMine(conflict.path);
		const written = load(h.dbText());
		expect(written.tasks.has("mine")).toBe(true);
		expect(written.meta.history).toContain("r-theirs");
		expect(await h.store.listConflicts()).toEqual([]);
	});

	it("B40: an unrelated version is a fork even without pending edits", async () => {
		const h = harness();
		await h.store.open();
		h.addTask(makeTask("saved"));
		await h.saveNow();
		h.fs.files.set(DB_PATH, descendant(emptyDbText(), (d) => d, "r-elsewhere"));
		await h.store.handleExternalChange();
		expect(h.events.some((e) => e.type === "conflict")).toBe(true);
		expect(h.store.data.tasks.has("saved")).toBe(false);
		const [copy] = await h.store.listConflicts();
		expect(h.fs.files.get(copy!.path)).toContain('"id":"saved"');
	});
});

describe("CpbaseStore: fault injection (B37, B38, B41)", () => {
	it("B37: a truncated file loads the newest backup read-only and writes nothing", async () => {
		const h = harness();
		await h.store.open();
		h.addTask(makeTask("t1"));
		await h.saveNow();
		h.addTask(makeTask("t2"));
		await h.saveNow();
		const good = h.dbText();
		h.fs.files.set(DB_PATH, good.slice(0, Math.floor(good.length / 2)));
		const torn = h.dbText();

		const s2 = h.newStore();
		await s2.open();
		const ro = s2.readOnlyState;
		expect(ro?.reason).toBe("damaged");
		if (ro?.reason !== "damaged") return;
		expect(ro.failure).toBe("parse");
		expect(ro.recoveredFrom).not.toBeNull();
		// Snapshot + journal replay recovers both tasks.
		expect([...s2.data.tasks.keys()].sort()).toEqual(["t1", "t2"]);
		try {
			h.addTask(makeTask("t3"), s2);
			expect.unreachable();
		} catch (err) {
			expect(isDomainError(err, "ReadOnly")).toBe(true);
		}
		await s2.flush();
		expect(h.dbText()).toBe(torn);
		// A copy of the damaged file is kept for the conflict view.
		const conflicts = await s2.listConflicts();
		expect(conflicts.some((c) => h.fs.files.get(c.path) === torn)).toBe(true);

		await s2.restoreRecovered();
		expect(s2.readOnlyState).toBeNull();
		expect([...load(h.dbText()).tasks.keys()].sort()).toEqual(["t1", "t2"]);
	});

	it("B37: a torn write during save is recovered from the journal", async () => {
		const h = harness();
		await h.store.open();
		h.addTask(makeTask("t1"));
		h.fs.failNextWrite((p) => p === DB_PATH, 120);
		await h.saveNow();
		expect(h.events.some((e) => e.type === "save-error")).toBe(true);

		const s2 = h.newStore();
		await s2.open();
		expect(s2.readOnlyState?.reason).toBe("damaged");
		expect(s2.data.tasks.has("t1")).toBe(true);
	});

	it("B37: git merge markers open read-only", async () => {
		const base = emptyDbText();
		const h = harness(`<<<<<<< HEAD\n${base}=======\n${base}>>>>>>> branch\n`);
		h.local.knownDbId = "db-1";
		await h.store.open();
		const ro = h.store.readOnlyState;
		expect(ro?.reason === "damaged" && ro.failure).toBe("merge-markers");
	});

	it("a crash between the journal append and the file write leaves the old file valid", async () => {
		const h = harness();
		await h.store.open();
		const before = h.dbText();
		h.addTask(makeTask("t1"));
		h.fs.failNextWrite((p) => p === DB_PATH);
		await h.saveNow();
		expect(h.dbText()).toBe(before);
		const s2 = h.newStore();
		await s2.open();
		expect(s2.readOnlyState).toBeNull();
		// The in-memory store retries and succeeds.
		h.scheduler.advance(5000);
		await settle();
		expect(load(h.dbText()).tasks.has("t1")).toBe(true);
	});

	it("B38: a newer schema opens read-only and is never written", async () => {
		const text = emptyDbText().replace(`"schemaVersion":${CURRENT_SCHEMA_VERSION}`, '"schemaVersion":99');
		const h = harness(text);
		await h.store.open();
		expect(h.store.readOnlyState).toEqual({ reason: "newer-schema", version: 99 });
		expect(h.store.data.categories.has("inbox")).toBe(true);
		expect(() => h.addTask(makeTask("t1"))).toThrow(/read-only/);
		await h.store.flush();
		expect(h.dbText()).toBe(text);
		expect(h.fs.writes.filter((p) => p === DB_PATH)).toEqual([]);
	});

	it("B41: our last write missing from history is restored as a conflict copy", async () => {
		const h = harness();
		await h.store.open();
		h.addTask(makeTask("lost"));
		await h.saveNow();
		const lostRevision = load(h.dbText()).meta.revision;
		await h.store.close();
		// Another device's version that never saw our write replaces the file.
		h.fs.files.set(DB_PATH, descendant(emptyDbText(), (d) => d, "r-other"));
		h.events.length = 0;

		const s2 = h.newStore();
		await s2.open();
		const lost = h.events.find((e) => e.type === "lost-revision");
		expect(lost).toMatchObject({ type: "lost-revision", revision: lostRevision });
		if (lost?.type !== "lost-revision" || lost.path === null) throw new Error("not restored");
		expect(h.fs.files.get(lost.path)).toContain('"id":"lost"');
		// Shown once.
		h.events.length = 0;
		await h.newStore().open();
		expect(h.events.some((e) => e.type === "lost-revision")).toBe(false);
	});
});

describe("git merge of different records", () => {
	function hasGit(): boolean {
		try {
			execFileSync("git", ["--version"], { stdio: "ignore" });
			return true;
		} catch {
			return false;
		}
	}

	it.skipIf(!hasGit())("conflicts only on the header line, which the loader then detects", () => {
		let base = load(emptyDbText());
		for (const id of ["t1", "t3", "t5"]) base = withTask(base, makeTask(id)).next;
		const baseText = serializeDb(base);
		const ours = descendant(baseText, (d) => withTask(d, makeTask("t1", { title: "Ours" })).next, "r-ours");
		const theirs = descendant(baseText, (d) => withTask(d, makeTask("t5", { title: "Theirs" })).next, "r-theirs");

		const dir = mkdtempSync(join(tmpdir(), "cpbase-merge-"));
		const files = { ours: join(dir, "ours"), base: join(dir, "base"), theirs: join(dir, "theirs") };
		writeFileSync(files.ours, ours);
		writeFileSync(files.base, baseText);
		writeFileSync(files.theirs, theirs);
		let merged = "";
		try {
			merged = execFileSync("git", ["merge-file", "-p", files.ours, files.base, files.theirs], { encoding: "utf8" });
		} catch (err) {
			// Exit code = number of conflicts; stdout holds the merged text.
			const e = err as { status: number; stdout: string };
			expect(e.status).toBe(1);
			merged = e.stdout;
		}
		expect(readFileSync(files.base, "utf8")).toBe(baseText);
		expect(parseDbText(merged)).toMatchObject({ ok: false, reason: "merge-markers" });

		// Only the header line is in conflict: taking either side gives a valid
		// database that has both record edits.
		const lines = merged.split("\n");
		const start = lines.findIndex((l) => l.startsWith("<<<<<<<"));
		const mid = lines.findIndex((l) => l.startsWith("======="));
		const end = lines.findIndex((l) => l.startsWith(">>>>>>>"));
		expect(mid - start).toBe(2);
		expect(end - mid).toBe(2);
		const resolved = [...lines.slice(0, start), lines[start + 1], ...lines.slice(end + 1)].join("\n");
		const data = load(resolved);
		expect(data.tasks.get("t1")?.title).toBe("Ours");
		expect(data.tasks.get("t5")?.title).toBe("Theirs");
	});
});

describe("restore errors", () => {
	// The errors "Restore" and "Keep mine" show when the chosen file is gone or unreadable.

	const SNAPSHOTS = `${BACKUP_ROOT}/db-1/snapshots`;
	const CONFLICTS = `${BACKUP_ROOT}/db-1/conflicts`;

	describe("restoreSnapshot and keepMine refuse a missing or unreadable file", () => {
		it("restoreSnapshot: a missing backup file", async () => {
			const h = harness();
			await h.store.open();
			await expect(h.store.restoreSnapshot(`${SNAPSHOTS}/gone.cpbase`)).rejects.toThrow("The backup file no longer exists.");
		});

		it("restoreSnapshot: an unreadable backup file", async () => {
			const h = harness();
			await h.store.open();
			h.fs.files.set(`${SNAPSHOTS}/bad.cpbase`, "not json");
			await expect(h.store.restoreSnapshot(`${SNAPSHOTS}/bad.cpbase`)).rejects.toThrow("The backup file cannot be read.");
		});

		it("keepMine: a missing conflict copy", async () => {
			const h = harness();
			await h.store.open();
			await expect(h.store.keepMine(`${CONFLICTS}/gone.cpbase`)).rejects.toThrow("The conflict copy no longer exists.");
		});

		it("keepMine: an unreadable conflict copy, which stays in the open list", async () => {
			const h = harness();
			await h.store.open();
			h.fs.files.set(`${CONFLICTS}/bad.cpbase`, "not json");
			await expect(h.store.keepMine(`${CONFLICTS}/bad.cpbase`)).rejects.toThrow("The conflict copy cannot be read.");
			expect(h.fs.files.has(`${CONFLICTS}/bad.cpbase`)).toBe(true);
		});
	});
});

describe("write, reload and recovery", () => {
	// Regression tests for the store's write, reload and recovery paths.

	function conflictEvent(events: StoreEvent[]): Extract<StoreEvent, { type: "conflict" }> {
		const e = events.find((x) => x.type === "conflict");
		if (e?.type !== "conflict") throw new Error("no conflict event");
		return e;
	}

	function snapshotPaths(h: Harness, kind: string): string[] {
		return [...h.fs.files.keys()].filter((p) => p.startsWith(`${BACKUP_ROOT}/db-1/snapshots/${kind}-`));
	}

	function journalText(h: Harness): string {
		return h.fs.files.get(`${BACKUP_ROOT}/db-1/journal.ndjson`) ?? "";
	}

	describe("saves are compare-and-swap", () => {
		it("DbFile.write writes only when the current text is the expected one", async () => {
			const fs = new MemoryFileGateway();
			fs.files.set("a.cpbase", "old");
			const file = bindFile(fs, () => "a.cpbase");
			expect(await file.write("new", (t) => t === "other")).toEqual({ written: false, current: "old" });
			expect(fs.files.get("a.cpbase")).toBe("old");
			expect(await file.write("new", (t) => t === "old")).toEqual({ written: true });
			expect(fs.files.get("a.cpbase")).toBe("new");
		});

		it("a pending save never overwrites an external write whose modify event has not been handled", async () => {
			const h = harness();
			await h.store.open();
			h.addTask(makeTask("mine"));
			// Another device's write lands between the commit and the save.
			const theirs = descendant(h.dbText(), (d) => withTask(d, makeTask("theirs")).next, "r-theirs");
			h.fs.files.set(DB_PATH, theirs);
			await h.saveNow();

			expect(h.dbText()).toBe(theirs);
			expect(h.store.data.tasks.has("theirs")).toBe(true);
			const conflict = conflictEvent(h.events);
			expect(h.fs.files.get(conflict.path)).toContain('"id":"mine"');
			expect(h.events.some((e) => e.type === "save-error")).toBe(false);

			// The late modify event is a no-op, and nothing is written later.
			h.events.length = 0;
			await h.store.handleExternalChange();
			h.scheduler.advance(SAVE_MAX_DELAY_MS * 3);
			await settle();
			expect(h.events).toEqual([]);
			expect(h.dbText()).toBe(theirs);
		});
	});

	describe("a capped history is not a fork", () => {
		it("an idle device fast-forwards over more than 50 remote saves", async () => {
			const h = harness();
			await h.store.open();
			const remote = descendants(h.dbText(), HISTORY_LIMIT + 10, "b");
			expect(load(remote).meta.history).not.toContain(h.store.data.meta.revision);
			h.fs.files.set(DB_PATH, remote);
			await h.store.handleExternalChange();
			expect(h.events.some((e) => e.type === "conflict")).toBe(false);
			expect(h.store.data.meta.revision).toBe(load(remote).meta.revision);
			expect(await h.store.listConflicts()).toEqual([]);
		});

		it("B41 does not fire when our last write scrolled out of a long remote history", async () => {
			const h = harness();
			await h.store.open();
			h.addTask(makeTask("ours"));
			await h.saveNow();
			await h.store.close();
			h.fs.files.set(DB_PATH, descendants(h.dbText(), HISTORY_LIMIT + 10, "b"));
			h.events.length = 0;
			const s2 = h.newStore();
			await s2.open();
			expect(h.events.some((e) => e.type === "lost-revision")).toBe(false);
			expect(await s2.listConflicts()).toEqual([]);
		});

		it("a proven fork is still a fork when the history is full", async () => {
			// A shared lineage longer than the cap, then both devices diverge.
			const shared = descendants(emptyDbText(), HISTORY_LIMIT + 5, "s");
			const h = harness(shared);
			await h.store.open();
			h.addTask(makeTask("mine"));
			await h.saveNow();
			h.events.length = 0;
			h.fs.files.set(DB_PATH, descendants(shared, 3, "t"));
			await h.store.handleExternalChange();
			const conflict = conflictEvent(h.events);
			expect(h.fs.files.get(conflict.path)).toContain('"id":"mine"');
		});

		it("B41 still fires for a proven loss when the history is full", async () => {
			const shared = descendants(emptyDbText(), HISTORY_LIMIT + 5, "s");
			const h = harness(shared);
			await h.store.open();
			h.addTask(makeTask("lost"));
			await h.saveNow();
			await h.store.close();
			h.fs.files.set(DB_PATH, descendants(shared, 3, "t"));
			h.events.length = 0;
			await h.newStore().open();
			const lost = h.events.find((e) => e.type === "lost-revision");
			if (lost?.type !== "lost-revision" || lost.path === null) throw new Error("not restored");
			expect(h.fs.files.get(lost.path)).toContain('"id":"lost"');
		});
	});

	describe("journal replay after a failed write", () => {
		it("replayJournal follows the last entry for a base", () => {
			const base = load(emptyDbText());
			const entries: JournalEntry[] = [
				{ rev: "r-x", base: "r-000000000000", at: "", ops: [{ c: "tasks", id: "t1", v: makeTask("t1") }] },
				{
					rev: "r-y",
					base: "r-000000000000",
					at: "",
					ops: [
						{ c: "tasks", id: "t1", v: makeTask("t1") },
						{ c: "tasks", id: "t2", v: makeTask("t2") },
					],
				},
				{ rev: "r-z", base: "r-y", at: "", ops: [{ c: "tasks", id: "t3", v: makeTask("t3") }] },
			];
			const r = replayJournal(base, entries, "r-000000000000");
			expect(r.revision).toBe("r-z");
			expect([...r.data.tasks.keys()].sort()).toEqual(["t1", "t2", "t3"]);
		});

		it("recovery keeps every edit made after a failed write", async () => {
			const h = harness();
			await h.store.open();
			h.addTask(makeTask("t1"));
			h.fs.failNextWrite((p) => p === DB_PATH);
			await h.saveNow();
			h.addTask(makeTask("t2"));
			await h.saveNow();
			h.addTask(makeTask("t3"));
			await h.saveNow();
			expect([...load(h.dbText()).tasks.keys()].sort()).toEqual(["t1", "t2", "t3"]);

			h.fs.files.set(DB_PATH, h.dbText().slice(0, 100));
			const s2 = h.newStore();
			await s2.open();
			expect(s2.readOnlyState?.reason).toBe("damaged");
			expect([...s2.data.tasks.keys()].sort()).toEqual(["t1", "t2", "t3"]);
		});
	});

	describe("commands during an external reload", () => {
		it("a command committed while the conflict copy is written is kept in the copy", async () => {
			const h = harness();
			await h.store.open();
			h.addTask(makeTask("mine"));
			h.fs.files.set(DB_PATH, descendant(h.dbText(), (d) => withTask(d, makeTask("theirs")).next, "r-theirs"));
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
			expect(injected).toBe(true);
			const conflict = conflictEvent(h.events);
			expect(h.fs.files.get(conflict.path)).toContain('"id":"during"');
			expect(await h.store.listConflicts()).toHaveLength(1);
		});
	});

	describe("damage that arrives while the app is open", () => {
		it("offers the in-memory state as the recovery and Restore backup writes it", async () => {
			const h = harness();
			await h.store.open();
			h.addTask(makeTask("saved"));
			await h.saveNow();
			h.addTask(makeTask("pending"));
			const good = h.dbText();
			const marked = `<<<<<<< HEAD\n${good}=======\n${good}>>>>>>> other\n`;
			h.fs.files.set(DB_PATH, marked);
			await h.store.handleExternalChange();

			const ro = h.store.readOnlyState;
			expect(ro?.reason).toBe("damaged");
			if (ro?.reason !== "damaged") return;
			expect(ro.recoveredFrom).not.toBeNull();
			expect(h.store.data.tasks.has("saved")).toBe(true);
			// Nothing is written while read-only.
			h.scheduler.advance(SAVE_MAX_DELAY_MS * 3);
			await settle();
			expect(h.dbText()).toBe(marked);
			// The damaged text is kept.
			const conflicts = await h.store.listConflicts();
			expect(conflicts.some((c) => h.fs.files.get(c.path) === marked)).toBe(true);

			await h.store.restoreRecovered();
			expect(h.store.readOnlyState).toBeNull();
			expect(h.dbText()).not.toContain("<<<<<<<");
			expect([...load(h.dbText()).tasks.keys()].sort()).toEqual(["pending", "saved"]);
			expect(h.events.some((e) => e.type === "writable")).toBe(true);
		});
	});

	describe("repairs keep the original text", () => {
		function repairableText(): string {
			const data = load(emptyDbText());
			return serializeDb(withTask(data, makeTask("t1", { categoryId: "missing" })).next);
		}

		it("on open, a pre-repair snapshot holds the original text", async () => {
			const original = repairableText();
			const h = harness(original);
			await h.store.open();
			expect(h.events.some((e) => e.type === "repaired")).toBe(true);
			expect(load(h.dbText()).tasks.get("t1")?.categoryId).toBe("inbox");
			const pre = snapshotPaths(h, "pre-repair");
			expect(pre).toHaveLength(1);
			expect(h.fs.files.get(pre[0]!)).toBe(original);
		});

		it("on an external reload, a pre-repair snapshot holds the original text", async () => {
			const h = harness();
			await h.store.open();
			const incoming = descendant(h.dbText(), (d) => withTask(d, makeTask("t1", { categoryId: "missing" })).next, "r-remote");
			h.fs.files.set(DB_PATH, incoming);
			await h.store.handleExternalChange();
			expect(load(h.dbText()).tasks.get("t1")?.categoryId).toBe("inbox");
			const pre = snapshotPaths(h, "pre-repair");
			expect(pre).toHaveLength(1);
			expect(h.fs.files.get(pre[0]!)).toBe(incoming);
		});
	});

	describe("opening does not force a snapshot or reset the journal", () => {
		it("reopening an unchanged database adds no hourly snapshot", async () => {
			const h = harness();
			await h.store.open();
			await h.store.close();
			const before = snapshotPaths(h, "hourly");
			for (let i = 0; i < 5; i++) {
				h.clock.advance(60_000);
				const s = h.newStore();
				await s.open();
				await s.close();
			}
			expect(snapshotPaths(h, "hourly")).toEqual(before);
		});

		it("keeps a journal entry whose write never reached the file", async () => {
			const h = harness();
			await h.store.open();
			h.addTask(makeTask("unsaved"));
			h.fs.failNextWrite((p) => p === DB_PATH);
			await h.saveNow();
			// The app "crashes" here; the next start loads the old, valid file.
			h.clock.advance(60_000);
			await h.newStore().open();
			expect(journalText(h)).toContain('"id":"unsaved"');
		});
	});

	describe("the store refuses commits after close", () => {
		it("throws instead of dropping the change", async () => {
			const h = harness();
			await h.store.open();
			await h.store.close();
			try {
				h.addTask(makeTask("late"));
				expect.unreachable();
			} catch (err) {
				expect(isDomainError(err)).toBe(true);
			}
		});
	});

	describe("CRLF header", () => {
		it("readHeader accepts a CRLF header line", () => {
			const text = emptyDbText().replace(/\n/g, "\r\n");
			expect(readHeader(text)?.revision).toBe("r-000000000000");
		});

		it("a CRLF checkout of the same revision is a no-op", async () => {
			const h = harness();
			await h.store.open();
			h.addTask(makeTask("t1"));
			await h.saveNow();
			h.events.length = 0;
			h.fs.files.set(DB_PATH, h.dbText().replace(/\n/g, "\r\n"));
			await h.store.handleExternalChange();
			expect(h.events).toEqual([]);
			// The next save still goes through.
			h.addTask(makeTask("t2"));
			await h.saveNow();
			expect(load(h.dbText()).tasks.has("t2")).toBe(true);
		});
	});

	describe("no save retries against a deleted file", () => {
		it("stops without an error notice and keeps the changes pending", async () => {
			const h = harness();
			await h.store.open();
			h.addTask(makeTask("t1"));
			h.fs.files.delete(DB_PATH);
			await h.saveNow();
			expect(h.events.some((e) => e.type === "save-error")).toBe(false);
			expect(h.scheduler.pending).toBe(0);
			expect(h.store.isDirty).toBe(true);
			expect(h.fs.files.has(DB_PATH)).toBe(false);
		});

		it("keeps pending changes as a conflict copy when the session closes on a deleted file", async () => {
			const h = harness();
			await h.store.open();
			h.addTask(makeTask("t1"));
			h.fs.files.delete(DB_PATH);
			await h.store.close();
			const conflicts = await h.store.listConflicts();
			expect(conflicts).toHaveLength(1);
			const copy = await h.store.backupStore!.read(conflicts[0]!.path);
			expect(load(copy!).tasks.has("t1")).toBe(true);
			expect(h.fs.files.has(DB_PATH)).toBe(false);
		});
	});
});

describe("save retries, lineage and snapshots", () => {
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
});

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

describe("only the revision just written is a self-write", () => {
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

describe("a newer-schema database becomes writable again when the file is valid again", () => {
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

// Regression tests for the store: retries after a write that threw, close()
// that never rejects, and recovery that reads as few snapshots as it can.

describe("a retry after a write that threw (header intact) is still our own write", () => {
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

describe("close() never rejects", () => {
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

describe("recoverLatest stops at the first usable snapshot", () => {
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

describe("close() with edits that cannot be kept", () => {
	// When close() cannot keep unsaved edits anywhere, it says so
	// with its own event. It is not the generic save error, which promises a retry
	// that a closed store never makes.

	function failConflictWrites(h: ReturnType<typeof harness>, reason = "disk full"): void {
		const write = h.fs.write.bind(h.fs);
		h.fs.write = async (path, data) => {
			if (path.includes("/conflicts/")) throw new Error(reason);
			await write(path, data);
		};
	}

	describe("close() with edits that cannot be kept", () => {
		it("emits edits-lost with the reason when the file cannot be written and neither can the conflict copy", async () => {
			const h = harness();
			await h.store.open();
			h.addTask(makeTask("pending"));
			h.fs.failNextWrite((p) => p === DB_PATH);
			failConflictWrites(h);
			await expect(h.store.close()).resolves.toBeUndefined();
			const lost = h.events.filter((e) => e.type === "edits-lost");
			expect(lost).toHaveLength(1);
			expect(lost[0]).toMatchObject({ type: "edits-lost" });
			expect(lost[0]?.type === "edits-lost" && lost[0].message).toContain("disk full");
			expect(h.events.some((e) => e.type === "pending-saved-as-conflict")).toBe(false);
		});

		it("does not report 'could not be kept' as a save error (a closed store never retries)", async () => {
			const h = harness();
			await h.store.open();
			h.addTask(makeTask("pending"));
			h.fs.failNextWrite((p) => p === DB_PATH);
			failConflictWrites(h);
			await h.store.close();
			const saveErrors = h.events.filter((e) => e.type === "save-error");
			expect(saveErrors.some((e) => /could not be kept/i.test(e.message))).toBe(false);
			expect(h.scheduler.pending).toBe(0);
		});

		it("emits edits-lost when the final save throws on a concurrent change and the copy cannot be written", async () => {
			const h = harness();
			await h.store.open();
			h.addTask(makeTask("pending"));
			h.fs.files.set(DB_PATH, descendant(h.dbText(), (d) => d, "r-other0000001"));
			failConflictWrites(h);
			await expect(h.store.close()).resolves.toBeUndefined();
			const lost = h.events.filter((e) => e.type === "edits-lost");
			expect(lost).toHaveLength(1);
			expect(lost[0]?.type === "edits-lost" && lost[0].message).toContain("disk full");
		});

		it("emits no edits-lost when the conflict copy is written, or when nothing was pending", async () => {
			const h = harness();
			await h.store.open();
			h.addTask(makeTask("pending"));
			h.fs.files.delete(DB_PATH);
			await h.store.close();
			expect(h.events.filter((e) => e.type === "pending-saved-as-conflict")).toHaveLength(1);
			expect(h.events.some((e) => e.type === "edits-lost")).toBe(false);

			const clean = harness();
			await clean.store.open();
			await clean.store.close();
			expect(clean.events.some((e) => e.type === "edits-lost")).toBe(false);
		});

		it("emits no edits-lost when the final save succeeds", async () => {
			const h = harness();
			await h.store.open();
			h.addTask(makeTask("pending"));
			await h.store.close();
			expect(h.events.some((e) => e.type === "edits-lost" || e.type === "save-error")).toBe(false);
		});
	});
});

describe("a torn journal line", () => {
	const JOURNAL = `${BACKUP_ROOT}/db-1/journal.ndjson`;

	it("#102: later entries stay readable and the next snapshot still resets the journal", async () => {
		const h = harness();
		await h.store.open();
		h.addTask(makeTask("t1"));
		await h.saveNow();
		// The app quits in the middle of an append: the last line has no end.
		const journal = h.fs.files.get(JOURNAL) ?? "";
		h.fs.files.set(JOURNAL, journal.slice(0, journal.length - 20));
		const s = h.newStore();
		await s.open();
		h.addTask(makeTask("t2"), s);
		await h.saveNow(s);
		h.addTask(makeTask("t3"), s);
		await h.saveNow(s);
		const backups = new BackupStore(h.fs, dbBackupRoot(BACKUP_ROOT, "db-1"), h.clock);
		const ids = (await backups.readJournal()).flatMap((e) => e.ops.map((op) => op.id));
		expect(ids).toEqual(["t2", "t3"]);

		// The hourly snapshot covers every entry, so the journal is cleared.
		h.clock.advance(SNAPSHOT_INTERVAL_MS);
		h.addTask(makeTask("t4"), s);
		await h.saveNow(s);
		expect(h.fs.files.get(JOURNAL)).toBe("");

		// Damage after one more save recovers it from the snapshot and the journal.
		h.addTask(makeTask("t5"), s);
		await h.saveNow(s);
		h.fs.files.set(DB_PATH, h.dbText().slice(0, 100));
		const s2 = h.newStore();
		await s2.open();
		expect(s2.readOnlyState?.reason).toBe("damaged");
		expect([...s2.data.tasks.keys()].sort()).toEqual(["t1", "t2", "t3", "t4", "t5"]);
	});
});

describe("edits waiting to be saved when the file turns unreadable", () => {
	function conflictPathOf(events: StoreEvent[]): string {
		const e = events.find((x) => x.type === "conflict");
		if (e?.type !== "conflict") throw new Error("no conflict event");
		return e.path;
	}

	it("#101: a damaged file repaired to the other side is a conflict, and Keep mine brings the edit back", async () => {
		const h = harness();
		await h.store.open();
		h.addTask(makeTask("saved"));
		await h.saveNow();
		const good = h.dbText();
		h.addTask(makeTask("pending"));
		h.fs.files.set(DB_PATH, `<<<<<<< HEAD\n${good}=======\n${good}>>>>>>> other\n`);
		await h.store.handleExternalChange();
		expect(h.store.readOnlyState?.reason).toBe("damaged");

		// The merge is resolved to the other side, a descendant of the saved revision.
		h.fs.files.set(DB_PATH, descendant(good, (d) => withTask(d, makeTask("theirs")).next, "r-theirs"));
		await h.store.handleExternalChange();
		expect(h.store.readOnlyState).toBeNull();
		expect(h.store.data.tasks.has("theirs")).toBe(true);
		const path = conflictPathOf(h.events);
		expect(h.fs.files.get(path)).toContain('"id":"pending"');
		// One copy holds the edit; the damaged text is the other.
		expect((await h.store.listConflicts()).filter((c) => h.fs.files.get(c.path)?.includes('"id":"pending"'))).toHaveLength(1);

		await h.store.keepMine(path);
		expect([...load(h.dbText()).tasks.keys()].sort()).toEqual(["pending", "saved"]);
	});

	it("#101: a newer-schema file while an edit waits, then a valid file, is a conflict", async () => {
		const h = harness();
		await h.store.open();
		h.addTask(makeTask("saved"));
		await h.saveNow();
		const good = h.dbText();
		h.addTask(makeTask("pending"));
		const newer = descendant(good, (d) => d, "r-newer").replace(`"schemaVersion":${CURRENT_SCHEMA_VERSION}`, '"schemaVersion":99');
		h.fs.files.set(DB_PATH, newer);
		await h.store.handleExternalChange();
		expect(h.store.readOnlyState?.reason).toBe("newer-schema");
		expect(h.events.some((e) => e.type === "conflict")).toBe(false);

		h.fs.files.set(DB_PATH, descendant(good, (d) => withTask(d, makeTask("back")).next, "r-back"));
		await h.store.handleExternalChange();
		expect(h.store.readOnlyState).toBeNull();
		expect(h.store.data.tasks.has("back")).toBe(true);
		expect(h.fs.files.get(conflictPathOf(h.events))).toContain('"id":"pending"');
	});

	it("#101: closing while the file is damaged points at the copy that holds the edit", async () => {
		const h = harness();
		await h.store.open();
		h.addTask(makeTask("saved"));
		await h.saveNow();
		const good = h.dbText();
		h.addTask(makeTask("pending"));
		h.fs.files.set(DB_PATH, `<<<<<<< HEAD\n${good}=======\n${good}>>>>>>> other\n`);
		await h.store.handleExternalChange();
		await h.store.close();
		const kept = h.events.find((e) => e.type === "pending-saved-as-conflict");
		if (kept?.type !== "pending-saved-as-conflict") throw new Error("the copy was not announced");
		expect(h.fs.files.get(kept.path)).toContain('"id":"pending"');
	});

	it("#101: Restore backup writes the edit, so a later valid file is no conflict", async () => {
		const h = harness();
		await h.store.open();
		h.addTask(makeTask("saved"));
		await h.saveNow();
		const good = h.dbText();
		h.addTask(makeTask("pending"));
		h.fs.files.set(DB_PATH, `<<<<<<< HEAD\n${good}=======\n${good}>>>>>>> other\n`);
		await h.store.handleExternalChange();
		await h.store.restoreRecovered();
		h.fs.files.set(DB_PATH, descendant(h.dbText(), (d) => withTask(d, makeTask("theirs")).next, "r-theirs"));
		await h.store.handleExternalChange();
		expect(h.events.some((e) => e.type === "conflict")).toBe(false);
		expect([...h.store.data.tasks.keys()].sort()).toEqual(["pending", "saved", "theirs"]);
	});
});

describe("a version loaded over a fork is not reported missing later", () => {
	function conflictPathOf(events: StoreEvent[]): string {
		const e = events.find((x) => x.type === "conflict");
		if (e?.type !== "conflict") throw new Error("no conflict event");
		return e.path;
	}

	it("#116: after Keep theirs, the next open reports no lost revision and writes no new copy", async () => {
		const h = harness();
		await h.store.open();
		h.addTask(makeTask("mine"));
		await h.saveNow();
		h.fs.files.set(DB_PATH, descendant(emptyDbText(), (d) => withTask(d, makeTask("theirs")).next, "r-theirs"));
		await h.store.handleExternalChange();
		await h.store.keepTheirs(conflictPathOf(h.events));
		await h.store.close();
		h.events.length = 0;

		const s2 = h.newStore();
		await s2.open();
		expect(h.events.some((e) => e.type === "lost-revision")).toBe(false);
		expect(await s2.listConflicts()).toEqual([]);
		expect(s2.data.tasks.has("theirs")).toBe(true);
	});

	it("#116: with no choice made before quitting, the open copy is the only one", async () => {
		const h = harness();
		await h.store.open();
		h.addTask(makeTask("mine"));
		await h.saveNow();
		h.fs.files.set(DB_PATH, descendant(emptyDbText(), (d) => d, "r-theirs"));
		await h.store.handleExternalChange();
		await h.store.close();
		h.events.length = 0;

		const s2 = h.newStore();
		await s2.open();
		expect(h.events.some((e) => e.type === "lost-revision")).toBe(false);
		expect(await s2.listConflicts()).toHaveLength(1);
	});

	it("#116: a revision lost while Logwell was closed is still reported", async () => {
		const h = harness();
		await h.store.open();
		h.addTask(makeTask("mine"));
		await h.saveNow();
		h.fs.files.set(DB_PATH, descendant(emptyDbText(), (d) => d, "r-theirs"));
		await h.store.handleExternalChange();
		await h.store.close();
		// A later save of ours is replaced while Logwell is closed.
		const s2 = h.newStore();
		await s2.open();
		h.addTask(makeTask("later"), s2);
		await h.saveNow(s2);
		await s2.close();
		h.fs.files.set(DB_PATH, descendant(emptyDbText(), (d) => d, "r-other"));
		h.events.length = 0;

		await h.newStore().open();
		expect(h.events.some((e) => e.type === "lost-revision")).toBe(true);
	});
});

describe("the retry after a write that threw but landed", () => {
	it("#139: keeps the landed revision in history, so a device that read it fast-forwards", async () => {
		const h = harness();
		await h.store.open();
		h.addTask(makeTask("t1"));
		h.fs.failNextWrite((p) => p === DB_PATH, 1_000_000); // the whole file lands, then the write throws
		await h.saveNow();
		const landed = revisionOf(h.dbText());
		// Another device syncs the landed file and reads it.
		const other = h.newStore();
		await other.open();
		expect(other.data.meta.revision).toBe(landed);

		h.scheduler.advance(SAVE_RETRY_MS);
		await settle();
		const retried = load(h.dbText()).meta;
		expect(retried.revision).not.toBe(landed);
		expect(retried.baseRevision).toBe(landed);
		expect(retried.history).toContain(landed);

		h.events.length = 0;
		await other.handleExternalChange();
		expect(h.events.some((e) => e.type === "conflict")).toBe(false);
		expect(other.data.meta.revision).toBe(retried.revision);
	});
});

describe("two sections with one name in a list", () => {
	function withSections(text: string, ...names: string[]): string {
		const data = load(text);
		const sections = new Map(data.sections);
		names.forEach((name, i) => {
			const id = `sec-${i + 1}`;
			sections.set(id, { id, categoryId: "inbox", name, nameKey: name.toLowerCase(), sortKey: `V${i}`, createdAt: data.meta.writtenAt, modifiedAt: data.meta.writtenAt });
		});
		return serializeDb({ ...data, sections });
	}

	it("#104: opening reports the duplicate but never rewrites the file or takes a backup", async () => {
		const text = withSections(emptyDbText(), "Doing", "Doing");
		const h = harness(text);
		for (const store of [h.store, h.newStore()]) {
			await store.open();
			await store.close();
		}
		expect(h.dbText()).toBe(text);
		expect([...h.fs.files.keys()].some((p) => p.includes("/pre-repair-"))).toBe(false);
		expect(h.events.some((e) => e.type === "repaired")).toBe(false);
		const noticed = h.events.filter((e) => e.type === "noticed");
		expect(noticed).toHaveLength(2);
		expect(noticed[0]?.type === "noticed" && noticed[0].notes.join(" ")).toContain('Section "Doing" has the same name');
	});

	it("#104: an outside change that still has the duplicate is reloaded without a rewrite", async () => {
		const h = harness();
		await h.store.open();
		const incoming = withSections(descendant(h.dbText(), (d) => d, "r-remote"), "Doing", "Doing");
		h.fs.files.set(DB_PATH, incoming);
		await h.store.handleExternalChange();
		expect(h.store.data.sections.size).toBe(2);
		expect(h.dbText()).toBe(incoming);
		h.scheduler.advance(SAVE_MAX_DELAY_MS);
		await settle();
		expect(h.dbText()).toBe(incoming);
	});

	it("#104: an outside change that is repaired on reload says so", async () => {
		const h = harness();
		await h.store.open();
		h.events.length = 0;
		h.fs.files.set(DB_PATH, descendant(h.dbText(), (d) => withTask(d, makeTask("t1", { categoryId: "missing" })).next, "r-remote"));
		await h.store.handleExternalChange();
		const repaired = h.events.find((e) => e.type === "repaired");
		expect(repaired?.type === "repaired" && repaired.issues.join(" ")).toContain("Task t1");
	});
});
