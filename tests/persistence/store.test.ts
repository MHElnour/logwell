import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isDomainError } from "../../src/domain/errors";
import { SAVE_DEBOUNCE_MS, SAVE_MAX_DELAY_MS } from "../../src/persistence/CpbaseStore";
import { parseDbText, serializeDb } from "../../src/persistence/serializer";
import { settle } from "../helpers";
import { BACKUP_ROOT, DB_PATH, descendant, emptyDbText, harness, load, makeTask, withTask } from "./fixtures";
import { CURRENT_SCHEMA_VERSION } from "../../src/persistence/schema";

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
