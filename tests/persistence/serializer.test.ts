import { describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION, type DbData, createEmptyDb } from "../../src/persistence/schema";
import { RecordLineCache, parseDbText, readHeader, serializeDb, serializeRecord } from "../../src/persistence/serializer";
import { validateDb } from "../../src/persistence/validate";
import { makeTask } from "./fixtures";

function sampleDb(order: string[]): DbData {
	const db = createEmptyDb({ dbId: "db-1", revision: "r-1", deviceId: "d-1", now: "2026-10-01T08:00:00.000Z" });
	const tasks = new Map();
	for (const id of order) tasks.set(id, makeTask(id));
	return { ...db, tasks };
}

describe("serializer", () => {
	it("writes valid JSON with one record per line, sorted by ID", () => {
		const text = serializeDb(sampleDb(["c", "a", "b"]));
		expect(() => JSON.parse(text) as unknown).not.toThrow();
		const lines = text.split("\n");
		const taskLines = lines.filter((l) => l.startsWith('{"id":"') && l.includes('"title":"Task'));
		expect(taskLines.map((l) => (JSON.parse(l.replace(/,$/, "")) as { id: string }).id)).toEqual(["a", "b", "c"]);
		expect(lines[0]!.startsWith(`{"format":"checkpoint-db","schemaVersion":${CURRENT_SCHEMA_VERSION},`)).toBe(true);
		expect(lines).toContain('"tasks":[');
		expect(lines).toContain('"habits":[],');
	});

	it("is deterministic regardless of insertion order", () => {
		expect(serializeDb(sampleDb(["c", "a", "b"]))).toBe(serializeDb(sampleDb(["b", "c", "a"])));
	});

	it("leaves out default-valued fields and restores them on read", () => {
		const line = serializeRecord("tasks", makeTask("a"));
		expect(line).not.toContain("tagKeys");
		expect(line).not.toContain("urgent");
		expect(line).not.toContain("descriptionNote");
		const parsed = parseDbText(serializeDb(sampleDb(["a"])));
		if (!parsed.ok) throw new Error("parse failed");
		const { data } = validateDb(parsed.raw, "2026-10-01T10:00:00.000Z");
		expect(data.tasks.get("a")).toEqual(makeTask("a"));
	});

	it("keeps fixed key order with nested values canonicalized", () => {
		const t = makeTask("a", {
			scheduled: { tz: "Europe/Berlin", local: "2026-10-02T19:00", kind: "datetime" } as never,
			urgent: true,
		});
		const line = serializeRecord("tasks", t);
		expect(line.indexOf('"id"')).toBeLessThan(line.indexOf('"title"'));
		expect(line).toContain('"scheduled":{"kind":"datetime","local":"2026-10-02T19:00","tz":"Europe/Berlin"}');
	});

	it("round-trips byte-identically", () => {
		const text = serializeDb(sampleDb(["a", "b"]));
		const parsed = parseDbText(text);
		if (!parsed.ok) throw new Error("parse failed");
		expect(serializeDb(validateDb(parsed.raw, "x").data)).toBe(text);
	});

	it("reads the header from the first line only", () => {
		const text = serializeDb(sampleDb(["a"]));
		expect(readHeader(text)).toMatchObject({ revision: "r-1", dbId: "db-1", schemaVersion: CURRENT_SCHEMA_VERSION });
		expect(readHeader("garbage")).toBeNull();
	});

	it("reuses cached lines for unchanged records", () => {
		const cache = new RecordLineCache();
		const db = sampleDb(["a", "b"]);
		const first = serializeDb(db, cache);
		const changed = { ...db, tasks: new Map(db.tasks).set("b", makeTask("b", { title: "Changed" })) };
		const second = serializeDb(changed, cache);
		expect(second).not.toBe(first);
		expect(second).toContain('"title":"Changed"');
		expect(cache.line("tasks", db.tasks.get("a")!)).toBe(serializeRecord("tasks", db.tasks.get("a")!));
	});

	it("detects merge markers and broken JSON", () => {
		const text = serializeDb(sampleDb(["a"]));
		expect(parseDbText(`<<<<<<< HEAD\n${text}=======\n${text}>>>>>>> other\n`)).toMatchObject({
			ok: false,
			reason: "merge-markers",
		});
		expect(parseDbText(text.slice(0, 40))).toMatchObject({ ok: false, reason: "parse" });
		expect(parseDbText('{"hello":1}')).toMatchObject({ ok: false, reason: "not-a-database" });
	});
});
