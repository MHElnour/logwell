import { describe, expect, it } from "vitest";
import type { OccurrenceRecord, Recurrence } from "../../src/domain/types";
import { CURRENT_SCHEMA_VERSION, type DbData } from "../../src/persistence/schema";
import { DB_PATH, descendant, harness, makeTask } from "./fixtures";

// A v3 file arriving through sync is migrated and announced; when memory holds a
// repeating task or occurrence records, which a v3 writer cannot have kept, a conflict copy keeps them first.

const daily: Recurrence = {
	anchor: "2026-10-01",
	versions: [
		{
			effectiveFrom: "2026-10-01",
			rule: { freq: "daily", interval: 1, weekdays: null, monthly: null, afterCompletion: false, time: null, tz: null },
		},
	],
	end: { kind: "never" },
	endedAt: null,
};

const record: OccurrenceRecord = {
	taskId: "t1",
	occurrenceDate: "2026-10-01",
	status: "done",
	resolvedAt: "2026-10-01T09:00:00.000Z",
	auto: false,
	completedOn: "2026-10-01",
};

/** A descendant of `base` as a schema 3 device writes it: no recurrence, no occurrence records. */
function asV3(base: string, revision: string): string {
	const strip = (d: DbData): DbData => ({
		...d,
		occurrenceRecords: new Map(),
		tasks: new Map([...d.tasks].map(([id, t]) => [id, { ...t, recurrence: null }])),
	});
	return descendant(base, strip, revision).replace(/"schemaVersion":\d+/u, '"schemaVersion":3');
}

describe("CpbaseStore: a v3 file arriving externally (M7 D1)", () => {
	it("is migrated and announced, with no conflict when memory holds no recurrence", async () => {
		const h = harness();
		await h.store.open();
		h.addTask(makeTask("t0"));
		await h.saveNow();
		h.fs.files.set(DB_PATH, asV3(h.dbText(), "r-v3-remote"));
		h.events.length = 0;
		await h.store.handleExternalChange();
		expect(h.events).toContainEqual({ type: "migrated", from: 3, to: CURRENT_SCHEMA_VERSION });
		expect(h.events.some((e) => e.type === "conflict")).toBe(false);
		expect(h.store.data.meta.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
	});

	it("keeps a conflict copy first when memory holds a repeating task", async () => {
		const h = harness();
		await h.store.open();
		h.addTask(makeTask("t1", { recurrence: daily }));
		await h.saveNow();
		h.fs.files.set(DB_PATH, asV3(h.dbText(), "r-v3-remote"));
		h.events.length = 0;
		await h.store.handleExternalChange();
		const conflict = h.events.find((e) => e.type === "conflict");
		if (conflict?.type !== "conflict") throw new Error("no conflict event");
		expect(h.fs.files.get(conflict.path)).toContain('"anchor":"2026-10-01"');
		expect(h.store.data.tasks.get("t1")?.recurrence).toBeNull();
	});

	it("keeps a conflict copy first when memory holds an occurrence record", async () => {
		const h = harness();
		await h.store.open();
		h.addTask(makeTask("t1"));
		const next = { ...h.store.data, occurrenceRecords: new Map([["t1:2026-10-01", record]]) };
		h.store.commit(next, [{ c: "occurrenceRecords", id: "t1:2026-10-01", v: record }]);
		await h.saveNow();
		h.fs.files.set(DB_PATH, asV3(h.dbText(), "r-v3-remote"));
		h.events.length = 0;
		await h.store.handleExternalChange();
		expect(h.events.some((e) => e.type === "conflict")).toBe(true);
	});
});
