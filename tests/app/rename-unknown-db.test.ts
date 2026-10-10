import { describe, expect, it } from "vitest";
import { type NoteRename, type RenameQueuePort } from "../../src/app/ports";
import { settle } from "../helpers";
import { DB_PATH, descendant, emptyDbText, makeTask, withTask } from "../persistence/fixtures";
import { type AppHarness, appHarness, makeWritable, waitFor } from "./harness";
import { CURRENT_SCHEMA_VERSION } from "../../src/persistence/schema";

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
