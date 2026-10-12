import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DB_PATH, harness, makeTask } from "./fixtures";

// An older device (schema 3) that finds a v4 file opens it read-only and never writes it, so it
// cannot end a repeating series it does not understand. The schema constant is stubbed to 3, as an older device saw it.
vi.mock("../../src/persistence/schema", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/persistence/schema")>()),
	CURRENT_SCHEMA_VERSION: 3,
}));

const V4 = readFileSync(join(import.meta.dirname, "..", "fixtures", "schema-v4.cpbase"), "utf8");

describe("CpbaseStore as the schema 3 reader (D1)", () => {
	it("opens v4 text read-only and never writes it", async () => {
		const h = harness(V4);
		await h.store.open();
		expect(h.store.readOnlyState).toEqual({ reason: "newer-schema", version: 4 });
		expect(h.store.data.occurrenceRecords.size).toBe(6);
		expect(() => h.addTask(makeTask("t1"))).toThrow(/read-only/);
		await h.store.flush();
		h.scheduler.advance(60_000);
		expect(h.dbText()).toBe(V4);
		expect(h.fs.writes.filter((p) => p === DB_PATH)).toEqual([]);
	});

	it("an external modify to another v4 version stays read-only and is never written", async () => {
		const h = harness(V4);
		await h.store.open();
		const other = V4.replace('"revision":"r-9a2b3c4d5e6f"', '"revision":"r-aaaabbbbcccc"').replace('"title":"Gym"', '"title":"Gym class"');
		h.fs.files.set(DB_PATH, other);
		await h.store.handleExternalChange();
		expect(h.store.readOnlyState).toEqual({ reason: "newer-schema", version: 4 });
		expect([...h.store.data.tasks.values()].some((t) => t.title === "Gym class")).toBe(true);
		await h.store.flush();
		h.scheduler.advance(60_000);
		expect(h.dbText()).toBe(other);
		expect(h.fs.writes.filter((p) => p === DB_PATH)).toEqual([]);
	});
});
