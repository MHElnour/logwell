import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DB_PATH, harness, makeTask } from "./fixtures";

// A schema 5 device that finds a v6 file (#12) opens it read-only and never writes it, so it cannot
// drop the yearly repeats it does not know (Data and safety rules 2 and 14). It becomes writable again
// when the file returns to v5. The schema constant is stubbed to 5, as such a build sees it.
vi.mock("../../src/persistence/schema", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/persistence/schema")>()),
	CURRENT_SCHEMA_VERSION: 5,
}));

const V6 = readFileSync(join(import.meta.dirname, "..", "fixtures", "schema-v6.cpbase"), "utf8");
const YEARLY_LINE = /\{"id":"7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f",[^\n]*\n/u;
const YEARLY_RECORD = /,\n\{"taskId":"7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f",[^\n]*\}\n/u;

/** The v6 fixture as a schema 5 device writes its next revision: no yearly task. */
function asV5(text: string): string {
	const stripped = text.replace(YEARLY_LINE, "").replace(YEARLY_RECORD, "\n");
	if (stripped.includes('"freq":"yearly"') || stripped.includes("7c8d9e0f")) throw new Error("the fixture's yearly task changed");
	return stripped
		.replace('"schemaVersion":6', '"schemaVersion":5')
		.replace('"revision":"r-a0b1c2d3e4f5","baseRevision":"r-9a2b3c4d5e6f"', '"revision":"r-b1c2d3e4f5a6","baseRevision":"r-a0b1c2d3e4f5"')
		.replace('"r-9a2b3c4d5e6f"],', '"r-9a2b3c4d5e6f","r-a0b1c2d3e4f5"],');
}

describe("CpbaseStore as the schema 5 reader (#12)", () => {
	it("opens v6 text read-only and never writes it", async () => {
		const h = harness(V6);
		await h.store.open();
		expect(h.store.readOnlyState).toEqual({ reason: "newer-schema", version: 6 });
		expect(h.store.data.tasks.size).toBeGreaterThan(0);
		expect(() => h.addTask(makeTask("t1"))).toThrow(/read-only/);
		await h.store.flush();
		h.scheduler.advance(60_000);
		expect(h.dbText()).toBe(V6);
		expect(h.fs.writes.filter((p) => p === DB_PATH)).toEqual([]);
	});

	it("an external modify to another v6 version stays read-only and is never written", async () => {
		const h = harness(V6);
		await h.store.open();
		const other = V6.replace('"revision":"r-a0b1c2d3e4f5"', '"revision":"r-aaaabbbbcccc"').replace('"title":"Renew passport"', '"title":"Renew the passport"');
		h.fs.files.set(DB_PATH, other);
		await h.store.handleExternalChange();
		expect(h.store.readOnlyState).toEqual({ reason: "newer-schema", version: 6 });
		await h.store.flush();
		h.scheduler.advance(60_000);
		expect(h.dbText()).toBe(other);
		expect(h.fs.writes.filter((p) => p === DB_PATH)).toEqual([]);
	});

	it("becomes writable when the file returns to v5 without a yearly repeat", async () => {
		const h = harness(V6);
		await h.store.open();
		h.fs.files.set(DB_PATH, asV5(V6));
		h.events.length = 0;
		await h.store.handleExternalChange();
		expect(h.store.readOnlyState).toBeNull();
		expect(h.events.map((e) => e.type)).toEqual(expect.arrayContaining(["writable", "loaded"]));
		h.addTask(makeTask("after"));
		await h.saveNow();
		expect(h.dbText()).toContain('"schemaVersion":5');
		expect(h.dbText()).toContain('"id":"after"');
	});
});
