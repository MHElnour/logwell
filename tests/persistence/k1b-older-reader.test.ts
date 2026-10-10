import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DB_PATH, harness, makeTask } from "./fixtures";

// An older device (schema 2) that finds a v3 file opens it read-only and never writes it.
// The schema constant is stubbed to 2, as a schema 2 device sees it.
vi.mock("../../src/persistence/schema", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/persistence/schema")>()),
	CURRENT_SCHEMA_VERSION: 2,
}));

const V3 = readFileSync(join(import.meta.dirname, "..", "fixtures", "schema-v3.cpbase"), "utf8");

describe("CpbaseStore as the schema 2 reader (K1b D2)", () => {
	it("opens v3 text read-only and never writes it", async () => {
		const h = harness(V3);
		await h.store.open();
		expect(h.store.readOnlyState).toEqual({ reason: "newer-schema", version: 3 });
		expect(h.store.data.sections.size).toBe(3);
		expect(() => h.addTask(makeTask("t1"))).toThrow(/read-only/);
		await h.store.flush();
		h.scheduler.advance(60_000);
		expect(h.dbText()).toBe(V3);
		expect(h.fs.writes.filter((p) => p === DB_PATH)).toEqual([]);
	});

	it("an external modify to another v3 version stays read-only and is never written", async () => {
		const h = harness(V3);
		await h.store.open();
		const other = V3.replace('"revision":"r-8f1a2b3c4d5e"', '"revision":"r-aaaabbbbcccc"').replace('"name":"Week 1"', '"name":"Week one"');
		h.fs.files.set(DB_PATH, other);
		await h.store.handleExternalChange();
		expect(h.store.readOnlyState).toEqual({ reason: "newer-schema", version: 3 });
		expect([...h.store.data.sections.values()].some((s) => s.name === "Week one")).toBe(true);
		await h.store.flush();
		h.scheduler.advance(60_000);
		expect(h.dbText()).toBe(other);
		expect(h.fs.writes.filter((p) => p === DB_PATH)).toEqual([]);
	});
});
