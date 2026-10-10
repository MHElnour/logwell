import { describe, expect, it } from "vitest";
import { isDomainError } from "../../src/domain/errors";
import { SAVE_MAX_DELAY_MS, type StoreEvent } from "../../src/persistence/CpbaseStore";
import { MemoryFileGateway, bindFile } from "./memoryGateway";
import { type JournalEntry, replayJournal } from "../../src/persistence/journal";
import { HISTORY_LIMIT } from "../../src/persistence/schema";
import { readHeader, serializeDb } from "../../src/persistence/serializer";
import { settle } from "../helpers";
import {
	BACKUP_ROOT,
	DB_PATH,
	type Harness,
	descendant,
	descendants,
	emptyDbText,
	harness,
	load,
	makeTask,
	withTask,
} from "./fixtures";

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

describe("review #1: saves are compare-and-swap", () => {
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

describe("review #2: a capped history is not a fork", () => {
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

describe("review #3: journal replay after a failed write", () => {
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

describe("review #4: commands during an external reload", () => {
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

describe("review #6: damage that arrives while the app is open", () => {
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

describe("review #7: repairs keep the original text", () => {
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

describe("review #13: opening does not force a snapshot or reset the journal", () => {
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

describe("review #14: the store refuses commits after close", () => {
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

describe("review #15: CRLF header", () => {
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

describe("review #20: no save retries against a deleted file", () => {
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
