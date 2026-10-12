import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DB_PATH, harness, makeTask } from "./fixtures";

// A 0.8.0 device (schema 4) that finds a v5 file opens it read-only and never writes it,
// so it cannot drop the TickTick links it does not know. It becomes writable again when the file returns to
// v4. The schema constant is stubbed to 4, as 0.8.0 saw it.
vi.mock("../../src/persistence/schema", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/persistence/schema")>()),
	CURRENT_SCHEMA_VERSION: 4,
}));

const V5 = readFileSync(join(import.meta.dirname, "..", "fixtures", "schema-v5.cpbase"), "utf8");

/** The v5 fixture as a v4 device writes its next revision: no syncLinks collection. */
function asV4(text: string): string {
	const stripped = text.replace(/,\n"syncLinks":\[[\s\S]*\]\n\}\n$/u, "\n}\n");
	if (stripped === text) throw new Error("the fixture has no syncLinks collection");
	return stripped
		.replace('"schemaVersion":5', '"schemaVersion":4')
		.replace('"revision":"r-a0b1c2d3e4f5","baseRevision":"r-9a2b3c4d5e6f"', '"revision":"r-b1c2d3e4f5a6","baseRevision":"r-a0b1c2d3e4f5"')
		.replace('"r-9a2b3c4d5e6f"],', '"r-9a2b3c4d5e6f","r-a0b1c2d3e4f5"],');
}

describe("CpbaseStore as the schema 4 reader", () => {
	it("opens v5 text read-only and never writes it", async () => {
		const h = harness(V5);
		await h.store.open();
		expect(h.store.readOnlyState).toEqual({ reason: "newer-schema", version: 5 });
		expect(h.store.data.tasks.size).toBeGreaterThan(0);
		expect(() => h.addTask(makeTask("t1"))).toThrow(/read-only/);
		await h.store.flush();
		h.scheduler.advance(60_000);
		expect(h.dbText()).toBe(V5);
		expect(h.fs.writes.filter((p) => p === DB_PATH)).toEqual([]);
	});

	it("an external modify to another v5 version stays read-only and is never written", async () => {
		const h = harness(V5);
		await h.store.open();
		const other = V5.replace('"revision":"r-a0b1c2d3e4f5"', '"revision":"r-aaaabbbbcccc"').replace('"title":"Gym"', '"title":"Gym class"');
		h.fs.files.set(DB_PATH, other);
		await h.store.handleExternalChange();
		expect(h.store.readOnlyState).toEqual({ reason: "newer-schema", version: 5 });
		expect([...h.store.data.tasks.values()].some((t) => t.title === "Gym class")).toBe(true);
		await h.store.flush();
		h.scheduler.advance(60_000);
		expect(h.dbText()).toBe(other);
		expect(h.fs.writes.filter((p) => p === DB_PATH)).toEqual([]);
	});

	it("becomes writable when the file returns to v4 without sync links", async () => {
		const h = harness(V5);
		await h.store.open();
		h.fs.files.set(DB_PATH, asV4(V5));
		h.events.length = 0;
		await h.store.handleExternalChange();
		expect(h.store.readOnlyState).toBeNull();
		expect(h.events.map((e) => e.type)).toEqual(expect.arrayContaining(["writable", "loaded"]));
		h.addTask(makeTask("after"));
		await h.saveNow();
		expect(h.dbText()).toContain('"schemaVersion":4');
		expect(h.dbText()).toContain('"id":"after"');
	});
});
