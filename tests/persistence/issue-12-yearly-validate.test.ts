import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Recurrence, Task } from "../../src/domain/types";
import { loadText } from "../../src/persistence/CpbaseStore";
import { MIGRATIONS, planMigration, runMigrations } from "../../src/persistence/migrations";
import { CURRENT_SCHEMA_VERSION, type DbData, inboxCategory } from "../../src/persistence/schema";
import { parseDbText, serializeDb } from "../../src/persistence/serializer";
import { validateDb } from "../../src/persistence/validate";
import { DB_PATH, descendant, harness, makeTask } from "./fixtures";

// The yearly repeat in the file (#12): it loads and round-trips, unused fields are cleared, schema 6 is a
// header-only step from 5 (Data and safety rule 2), and a v5 file arriving while memory holds a yearly
// repeat keeps a conflict copy first.

const FIXTURES = join(import.meta.dirname, "..", "fixtures");
const V6 = readFileSync(join(FIXTURES, "schema-v6.cpbase"), "utf8");
const V5 = readFileSync(join(FIXTURES, "schema-v5.cpbase"), "utf8");
const NOW = "2026-10-05T10:00:00.000Z";
const YEARLY_ID = "7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f";

const yearlyRecurrence: Recurrence = {
	anchor: "2026-03-14",
	versions: [
		{
			effectiveFrom: "2026-03-14",
			rule: { freq: "yearly", interval: 2, weekdays: null, monthly: null, afterCompletion: false, time: null, tz: null },
		},
	],
	end: { kind: "never" },
	endedAt: null,
};

describe("a yearly rule in the file (#12)", () => {
	it("the frozen v6 fixture loads with no issues and round-trips byte for byte", () => {
		const r = loadText(V6, "2026-10-07T10:00:00.000Z");
		if (r.kind !== "ok") throw new Error(`fixture did not load: ${JSON.stringify(r)}`);
		expect(r.issues).toEqual([]);
		expect(r.migratedFrom).toBeNull();
		expect(r.data.tasks.get(YEARLY_ID)?.recurrence?.versions[0]?.rule.freq).toBe("yearly");
		expect(serializeDb(r.data)).toBe(V6);
	});

	it("clears weekdays and a day of the month on a yearly rule, with an issue", () => {
		const raw = {
			format: "checkpoint-db",
			schemaVersion: CURRENT_SCHEMA_VERSION,
			dbId: "db-1",
			revision: "r-000000000001",
			categories: [inboxCategory(NOW)],
			tasks: [
				{
					id: "t1",
					title: "Renew passport",
					categoryId: "inbox",
					status: "open",
					sortKey: "V",
					createdAt: NOW,
					modifiedAt: NOW,
					recurrence: {
						anchor: "2026-03-14",
						versions: [
							{
								effectiveFrom: "2026-03-14",
								rule: { freq: "yearly", interval: 1, weekdays: ["MO"], monthly: { kind: "day", day: 3 }, afterCompletion: false, time: null, tz: null },
							},
						],
						end: { kind: "never" },
						endedAt: null,
					},
				},
			],
		};
		const { data, issues } = validateDb(raw, NOW);
		const rule = data.tasks.get("t1")?.recurrence?.versions[0]?.rule;
		expect(rule?.freq).toBe("yearly");
		expect(rule?.weekdays).toBeNull();
		expect(rule?.monthly).toBeNull();
		expect(issues).toHaveLength(2);
	});
});

describe("v5 to v6 migration (#12)", () => {
	const step = MIGRATIONS.find((m) => m.from === 5);

	it("the schema is version 6 and the steps are 1 to 5", () => {
		expect(CURRENT_SCHEMA_VERSION).toBe(6);
		expect(MIGRATIONS.map((m) => m.from)).toEqual([1, 2, 3, 4, 5]);
		expect(step).toBeDefined();
	});

	it("changes the header only", () => {
		const parsed = parseDbText(V5);
		if (!parsed.ok) throw new Error("fixture unreadable");
		expect(runMigrations(parsed.raw, [step!])).toEqual({ ...parsed.raw, schemaVersion: 6 });
	});

	it("opening the v5 fixture migrates it to v6 and changes only the version", async () => {
		const h = harness(V5);
		await h.store.open();
		expect(h.events.filter((e) => e.type === "migrated")).toEqual([{ type: "migrated", from: 5, to: 6 }]);
		const written = h.fs.files.get(DB_PATH) ?? "";
		expect(written).toContain('"schemaVersion":6');
		const r = loadText(V5, "2026-10-07T10:00:00.000Z");
		if (r.kind !== "ok") throw new Error("did not load");
		expect(r.issues).toEqual([]);
		expect(serializeDb(r.data)).toBe(V5.replace('"schemaVersion":5', '"schemaVersion":6'));
	});

	it("an older reader (target version 5) treats v6 as newer, so it is read-only", () => {
		expect(planMigration(6, MIGRATIONS, 5)).toEqual({ kind: "newer", version: 6 });
		expect(planMigration(5, MIGRATIONS, 5)).toEqual({ kind: "current" });
	});
});

/** A descendant of `base` as a schema 5 device writes it: no yearly repeat. */
function asV5(base: string, revision: string): string {
	const strip = (d: DbData): DbData => {
		const tasks = new Map<string, Task>();
		for (const [id, t] of d.tasks) if (!t.recurrence?.versions.some((v) => v.rule.freq === "yearly")) tasks.set(id, t);
		return { ...d, tasks };
	};
	return descendant(base, strip, revision).replace(/"schemaVersion":\d+/u, '"schemaVersion":5');
}

describe("CpbaseStore: a v5 file arriving externally (#12)", () => {
	it("is migrated with no conflict when memory holds no yearly repeat", async () => {
		const h = harness();
		await h.store.open();
		h.addTask(makeTask("t0"));
		await h.saveNow();
		h.fs.files.set(DB_PATH, asV5(h.dbText(), "r-v5-remote"));
		h.events.length = 0;
		await h.store.handleExternalChange();
		expect(h.events).toContainEqual({ type: "migrated", from: 5, to: 6 });
		expect(h.events.some((e) => e.type === "conflict")).toBe(false);
		expect(h.store.readOnlyState).toBeNull();
	});

	it("keeps a conflict copy first when memory holds a yearly repeat", async () => {
		const h = harness();
		await h.store.open();
		h.addTask(makeTask("y1", { title: "Renew passport", recurrence: yearlyRecurrence }));
		await h.saveNow();
		h.fs.files.set(DB_PATH, asV5(h.dbText(), "r-v5-remote"));
		h.events.length = 0;
		await h.store.handleExternalChange();
		const conflict = h.events.find((e) => e.type === "conflict");
		if (conflict?.type !== "conflict") throw new Error("no conflict event");
		expect(h.fs.files.get(conflict.path)).toContain('"freq":"yearly"');
		expect(h.store.data.tasks.has("y1")).toBe(false);
		expect(h.events).toContainEqual({ type: "migrated", from: 5, to: 6 });
	});

	it("keeps a conflict copy for a yearly repeat in the Trash too", async () => {
		const h = harness();
		await h.store.open();
		const trashed = makeTask("y2", { title: "Renew passport", recurrence: yearlyRecurrence });
		const entry = { batchId: "b1", deletedAt: NOW, tasks: [trashed] };
		h.store.commit({ ...h.store.data, trash: new Map([["b1", entry]]) }, [{ c: "trash", id: "b1", v: entry }]);
		await h.saveNow();
		const v5 = descendant(h.dbText(), (d) => ({ ...d, trash: new Map() }), "r-v5-remote").replace(/"schemaVersion":\d+/u, '"schemaVersion":5');
		h.fs.files.set(DB_PATH, v5);
		h.events.length = 0;
		await h.store.handleExternalChange();
		expect(h.events.some((e) => e.type === "conflict")).toBe(true);
	});
});
