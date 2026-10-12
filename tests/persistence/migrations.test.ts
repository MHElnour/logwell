import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Recurrence, Task } from "../../src/domain/types";
import { loadText } from "../../src/persistence/CpbaseStore";
import { MIGRATIONS, type Migration, planMigration, runMigrations } from "../../src/persistence/migrations";
import { CURRENT_SCHEMA_VERSION, type DbData, inboxCategory } from "../../src/persistence/schema";
import { parseDbText, serializeDb } from "../../src/persistence/serializer";
import { validateDb } from "../../src/persistence/validate";
import { DB_PATH, descendant, harness, makeTask } from "./fixtures";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");

/** The text of an older fixture as the v3 serializer writes it: an empty sections collection after categories. */
const withEmptySections = (text: string): string => text.replace('\n],\n"tags":[', '\n],\n"sections":[],\n"tags":[');
/** The text of an older fixture as the v5 serializer writes it: an empty syncLinks collection after trash. */
const withEmptySyncLinks = (text: string): string => {
	if (!text.endsWith("\n}\n")) throw new Error("the fixture's last line changed");
	return `${text.slice(0, -"\n}\n".length)},\n"syncLinks":[]\n}\n`;
};
/**
 * Habits are typed without a schema bump (still v3). The frozen fixtures' one habit was written by the
 * opaque writer (sorted keys, an explicit `"archivedAt":null`); the typed writer puts it in its key order
 * and leaves the default out. Only this line changes; the fixtures stay frozen.
 */
const OPAQUE_HABIT =
	'{"id":"h-7c1a0000-0000-4000-8000-000000000001","archivedAt":null,"createdAt":"2026-10-01T09:00:00.000Z","modifiedAt":"2026-10-01T09:00:00.000Z","name":"Read","sortKey":"V","versions":';
const TYPED_HABIT =
	'{"id":"h-7c1a0000-0000-4000-8000-000000000001","name":"Read","sortKey":"V","createdAt":"2026-10-01T09:00:00.000Z","modifiedAt":"2026-10-01T09:00:00.000Z","versions":';
const withTypedHabits = (text: string): string => {
	if (!text.includes(OPAQUE_HABIT)) throw new Error("the fixture's habit line changed");
	return text.replace(OPAQUE_HABIT, TYPED_HABIT);
};
const V2_STEP = MIGRATIONS.filter((m) => m.from === 1);

describe("schema fixtures (spec §17.3)", () => {
	it("the frozen v1 sample loads, validates and re-serializes byte-identically", () => {
		const text = readFileSync(join(FIXTURES, "schema-v1.cpbase"), "utf8");
		const r = loadText(text, "2026-10-01T10:00:00.000Z");
		if (r.kind !== "ok") throw new Error(`fixture did not load: ${JSON.stringify(r)}`);
		expect(r.issues).toEqual([]);
		expect(r.data.tasks.size).toBe(3);
		expect(r.data.trash.size).toBe(1);
		expect(r.data.tasks.get("0b9f6c1e-6a52-4c39-9a7c-5f2f0f4f8a11")?.descriptionNote?.path).toBe(
			"Task notes/Python study plan.md",
		);
		// Collections typed later round-trip without loss (habits included).
		expect(r.data.habits.size).toBe(1);
		// The v1 file is migrated on load; apart from the header version and the new empty
		// sections collection the bytes are unchanged (priority 0, color null and
		// sectionId null are defaults and are left out on write).
		expect(r.migratedFrom).toBe(1);
		expect(serializeDb(r.data)).toBe(withEmptySyncLinks(withTypedHabits(withEmptySections(text.replace('"schemaVersion":1', `"schemaVersion":${CURRENT_SCHEMA_VERSION}`)))));
	});
});

describe("frozen v2 fixture (migrates to v3, K1b D2, then to v4, M7 D1, then to v5, then to v6, #12)", () => {
	const text = readFileSync(join(FIXTURES, "schema-v2.cpbase"), "utf8");

	it("migrates with no issues; the output is the v2 text plus the version and empty sections and syncLinks collections", () => {
		const r = loadText(text, "2026-10-01T10:00:00.000Z");
		if (r.kind !== "ok") throw new Error(`fixture did not load: ${JSON.stringify(r)}`);
		expect(r.issues).toEqual([]);
		expect(r.migratedFrom).toBe(2);
		expect(r.data.categories.get("5e0d1c2b-3a49-4f58-8e67-7d6c5b4a3921")?.color).toBe("purple");
		expect([...r.data.tasks.values()].map((t) => t.priority).sort()).toEqual([0, 1, 1, 2, 3]);
		expect(r.data.trash.size).toBe(1);
		expect(r.data.sections.size).toBe(0);
		for (const t of r.data.tasks.values()) expect(t.sectionId).toBeNull();
		for (const e of r.data.trash.values()) for (const t of e.tasks) expect(t.sectionId).toBeNull();
		expect(serializeDb(r.data)).toBe(withEmptySyncLinks(withTypedHabits(withEmptySections(text.replace('"schemaVersion":2', '"schemaVersion":6')))));
	});

	it("opening a v2 file writes a pre-migration snapshot of the original text, then the v6 file, and notifies once", async () => {
		const h = harness(text);
		await h.store.open();
		expect(h.events.filter((e) => e.type === "migrated")).toEqual([{ type: "migrated", from: 2, to: 6 }]);
		const backups = await h.fs.list("plugin/backups/5c2e8a40-1b7d-4f3e-9a51-0d6c2f1e7b90/snapshots");
		const pre = backups.find((p) => p.includes("/pre-migration-"));
		expect(pre).toBeDefined();
		expect(h.fs.files.get(pre!)).toBe(text);
		expect(h.fs.files.get(DB_PATH) ?? "").toContain('"schemaVersion":6');
		expect(h.fs.files.get(DB_PATH) ?? "").toContain('"sections":[]');
		expect(h.fs.files.get(DB_PATH) ?? "").toContain('"syncLinks":[]');
	});
});

describe("frozen v3 fixture (K1b sections)", () => {
	const text = readFileSync(join(FIXTURES, "schema-v3.cpbase"), "utf8");

	it("migrates to v6 with no issues; the output is the v3 text with the version changed and an empty syncLinks collection", () => {
		const r = loadText(text, "2026-10-01T10:00:00.000Z");
		if (r.kind !== "ok") throw new Error(`fixture did not load: ${JSON.stringify(r)}`);
		expect(r.issues).toEqual([]);
		expect(r.migratedFrom).toBe(3);
		expect(r.data.sections.size).toBe(3);
		expect(serializeDb(r.data)).toBe(withEmptySyncLinks(withTypedHabits(text.replace('"schemaVersion":3', '"schemaVersion":6'))));
	});

	it("keeps tasks in and out of sections, subtasks and trashed tasks included", () => {
		const r = loadText(text, "2026-10-01T10:00:00.000Z");
		if (r.kind !== "ok") throw new Error("did not load");
		const sectionOf = (id: string) => r.data.tasks.get(id)?.sectionId;
		expect(sectionOf("0b9f6c1e-6a52-4c39-9a7c-5f2f0f4f8a11")).toBe("a1b2c3d4-0001-4a00-8000-00000000a001");
		expect(sectionOf("1c0a7d2f-7b63-4d4a-8b8d-6a3a1a5b9b22")).toBe("a1b2c3d4-0001-4a00-8000-00000000a001");
		expect(sectionOf("2d1b8e30-8c74-4e5b-9c9e-7b4b2b6cac33")).toBe("b2c3d4e5-0003-4b00-8000-00000000b003");
		expect(sectionOf("9c3d4e5f-6a7b-4c8d-ae9f-1a2b3c4d5e6f")).toBeNull();
		const trashed = [...r.data.trash.values()].flatMap((e) => e.tasks);
		expect(trashed[0]?.sectionId).toBe("b2c3d4e5-0003-4b00-8000-00000000b003");
		expect(r.data.sections.get("a1b2c3d4-0002-4a00-8000-00000000a002")).toMatchObject({
			categoryId: "5e0d1c2b-3a49-4f58-8e67-7d6c5b4a3921",
			name: "Week 2",
			nameKey: "week 2",
		});
	});
});

describe("v2 to v3 migration (K1b D2)", () => {
	const v2Text = readFileSync(join(FIXTURES, "schema-v2.cpbase"), "utf8");
	const step = MIGRATIONS.find((m) => m.from === 2);

	it("there is a step from 2", () => {
		expect(MIGRATIONS.map((m) => m.from)).toContain(2);
		expect(step).toBeDefined();
	});

	it("adds sectionId null to every task, trashed ones too, and changes nothing else", () => {
		const parsed = parseDbText(v2Text);
		if (!parsed.ok) throw new Error("fixture unreadable");
		const migrated = runMigrations(parsed.raw, [step!]);
		expect(migrated.schemaVersion).toBe(3);
		const tasks = migrated.tasks as Record<string, unknown>[];
		const trashed = (migrated.trash as { tasks: Record<string, unknown>[] }[]).flatMap((e) => e.tasks);
		expect(tasks.length).toBe(5);
		expect(trashed.length).toBe(1);
		for (const t of [...tasks, ...trashed]) expect(t.sectionId).toBeNull();
		const strip = (rows: Record<string, unknown>[]) => rows.map(({ sectionId: _x, ...rest }) => rest);
		const orig = parsed.raw as Record<string, unknown[]>;
		expect(strip(tasks)).toEqual(orig.tasks);
		expect(migrated.categories).toEqual(orig.categories);
		expect(migrated.tags).toEqual(orig.tags);
		expect(migrated.habits).toEqual(orig.habits);
	});

	it("is idempotent: an existing sectionId is left alone and a second run changes nothing", () => {
		const raw = {
			schemaVersion: 2,
			tasks: [{ id: "a", sectionId: "s1" }, { id: "b" }],
			trash: [{ batchId: "x", tasks: [{ id: "c", sectionId: "s2" }, { id: "d" }] }],
		};
		const once = runMigrations(raw, [step!]);
		expect(once.tasks).toEqual([{ id: "a", sectionId: "s1" }, { id: "b", sectionId: null }]);
		expect(once.trash).toEqual([{ batchId: "x", tasks: [{ id: "c", sectionId: "s2" }, { id: "d", sectionId: null }] }]);
		const twice = runMigrations({ ...once, schemaVersion: 2 }, [step!]);
		expect(twice).toEqual(once);
	});

	it("a v1 file runs every step in one load: one snapshot, one notice from 1 to 6", async () => {
		const v1Text = readFileSync(join(FIXTURES, "schema-v1.cpbase"), "utf8");
		const h = harness(v1Text);
		await h.store.open();
		expect(h.events.filter((e) => e.type === "migrated")).toEqual([{ type: "migrated", from: 1, to: 6 }]);
		const backups = await h.fs.list("plugin/backups/5c2e8a40-1b7d-4f3e-9a51-0d6c2f1e7b90/snapshots");
		expect(backups.filter((p) => p.includes("/pre-migration-"))).toHaveLength(1);
	});

	it("an older reader (target version 2) treats v3 as newer, so it is read-only", () => {
		expect(planMigration(3, MIGRATIONS, 2)).toEqual({ kind: "newer", version: 3 });
		expect(planMigration(2, MIGRATIONS, 2)).toEqual({ kind: "current" });
	});

	it("reopening the migrated file does not migrate or notify again", async () => {
		const h = harness(v2Text);
		await h.store.open();
		const written = h.fs.files.get(DB_PATH) ?? "";
		const again = harness(written);
		await again.store.open();
		expect(again.events.filter((e) => e.type === "migrated")).toEqual([]);
	});
});

describe("v3 to v4 migration (M7 D1)", () => {
	const v3Text = readFileSync(join(FIXTURES, "schema-v3.cpbase"), "utf8");
	const step = MIGRATIONS.find((m) => m.from === 3);

	it("there is a step from 3", () => {
		expect(step).toBeDefined();
	});

	it("changes no record: only the header version moves", () => {
		const parsed = parseDbText(v3Text);
		if (!parsed.ok) throw new Error("fixture unreadable");
		const migrated = runMigrations(parsed.raw, [step!]);
		expect(migrated).toEqual({ ...parsed.raw, schemaVersion: 4 });
	});

	it("is idempotent", () => {
		const raw = { schemaVersion: 3, tasks: [{ id: "a", recurrence: null }], occurrenceRecords: [] };
		const once = runMigrations(raw, [step!]);
		expect(once).toEqual({ ...raw, schemaVersion: 4 });
		expect(runMigrations({ ...once, schemaVersion: 3 }, [step!])).toEqual(once);
	});

	it("opening a v3 file writes a pre-migration snapshot of the original text, then the v6 file, and notifies once", async () => {
		const h = harness(v3Text);
		await h.store.open();
		expect(h.events.filter((e) => e.type === "migrated")).toEqual([{ type: "migrated", from: 3, to: 6 }]);
		const backups = await h.fs.list("plugin/backups/5c2e8a40-1b7d-4f3e-9a51-0d6c2f1e7b90/snapshots");
		const pre = backups.filter((p) => p.includes("/pre-migration-"));
		expect(pre).toHaveLength(1);
		expect(h.fs.files.get(pre[0]!)).toBe(v3Text);
		const written = h.fs.files.get(DB_PATH) ?? "";
		expect(written).toContain('"schemaVersion":6');
		// Apart from the header (new revision, history, writer) and the empty syncLinks, the records are the v3 text's.
		const body = (t: string) => t.slice(t.indexOf("\n"));
		expect(body(written)).toBe(body(withEmptySyncLinks(withTypedHabits(v3Text))));
	});

	it("reopening the migrated file does not migrate or notify again", async () => {
		const h = harness(v3Text);
		await h.store.open();
		const again = harness(h.fs.files.get(DB_PATH) ?? "");
		await again.store.open();
		expect(again.events.filter((e) => e.type === "migrated")).toEqual([]);
		const backups = await again.fs.list("plugin/backups/5c2e8a40-1b7d-4f3e-9a51-0d6c2f1e7b90/snapshots");
		expect(backups.filter((p) => p.includes("/pre-migration-"))).toEqual([]);
	});

	it("an older reader (target version 3) treats v4 as newer, so it is read-only", () => {
		expect(planMigration(4, MIGRATIONS, 3)).toEqual({ kind: "newer", version: 4 });
		expect(planMigration(3, MIGRATIONS, 3)).toEqual({ kind: "current" });
	});
});

describe("frozen v4 fixture (M7 recurrence; migrates to v5, and v6, #12)", () => {
	const text = readFileSync(join(FIXTURES, "schema-v4.cpbase"), "utf8");
	const GYM = "4f5a6b7c-8d9e-4fa0-b1c2-d3e4f5a6b7c8";
	const RENT = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d";
	const NEWS = "6b7c8d9e-0f1a-4b2c-9d3e-4f5a6b7c8d9e";

	it("migrates to v6 with no issues; the output is the v4 text with the version changed and an empty syncLinks collection", () => {
		const r = loadText(text, "2026-10-05T10:00:00.000Z");
		if (r.kind !== "ok") throw new Error(`fixture did not load: ${JSON.stringify(r)}`);
		expect(r.issues).toEqual([]);
		expect(r.migratedFrom).toBe(4);
		expect(r.data.syncLinks.size).toBe(0);
		expect(serializeDb(r.data)).toBe(withEmptySyncLinks(text.replace('"schemaVersion":4', '"schemaVersion":6')));
	});

	it("reads the recurrence and the occurrence records as typed values", () => {
		const r = loadText(text, "2026-10-05T10:00:00.000Z");
		if (r.kind !== "ok") throw new Error("did not load");
		const gym = r.data.tasks.get(GYM)?.recurrence;
		expect(gym?.anchor).toBe("2026-09-28");
		expect(gym?.versions.map((v) => v.rule.weekdays)).toEqual([["MO", "WE", "FR"], ["TU", "TH"]]);
		expect(gym?.versions[0]?.rule).toMatchObject({ freq: "weekly", interval: 1, time: "07:00", tz: "Europe/Berlin", afterCompletion: false });
		expect(r.data.tasks.get(GYM)?.scheduled).toBeNull();
		const rent = r.data.tasks.get(RENT)?.recurrence;
		expect(rent?.end).toEqual({ kind: "count", count: 12 });
		expect(rent?.versions[0]?.rule).toMatchObject({ freq: "monthly", monthly: { kind: "day", day: 31 }, afterCompletion: true });
		expect(r.data.tasks.get(NEWS)?.recurrence?.endedAt).toBe("2026-10-03T09:00:00.000Z");
		expect(r.data.occurrenceRecords.size).toBe(6);
		expect(r.data.occurrenceRecords.get(`${GYM}:2026-09-30`)).toEqual({
			taskId: GYM,
			occurrenceDate: "2026-09-30",
			status: "skipped",
			resolvedAt: "2026-10-02T06:00:00.000Z",
			auto: true,
			completedOn: null,
		});
		expect(r.data.occurrenceRecords.get(`${GYM}:2026-10-05`)).toMatchObject({ status: "skipped", auto: false });
		expect(r.data.occurrenceRecords.get(`${RENT}:2026-08-31`)).toMatchObject({ status: "done", completedOn: "2026-09-01", auto: false });
	});

	it("opening it writes a pre-migration snapshot of the original text first, then the v6 file, and notifies once", async () => {
		const h = harness(text);
		await h.store.open();
		expect(h.events.filter((e) => e.type === "migrated")).toEqual([{ type: "migrated", from: 4, to: 6 }]);
		expect(h.store.readOnlyState).toBeNull();
		const backups = await h.fs.list("plugin/backups/5c2e8a40-1b7d-4f3e-9a51-0d6c2f1e7b90/snapshots");
		const pre = backups.filter((p) => p.includes("/pre-migration-"));
		expect(pre).toHaveLength(1);
		expect(h.fs.files.get(pre[0]!)).toBe(text);
		// The snapshot is written before the migrated file.
		const snapshotWrite = h.fs.writes.indexOf(pre[0]!);
		const dbWrite = h.fs.writes.indexOf(DB_PATH);
		expect(snapshotWrite).toBeGreaterThanOrEqual(0);
		expect(dbWrite).toBeGreaterThan(snapshotWrite);
		const written = h.fs.files.get(DB_PATH) ?? "";
		expect(written).toContain('"schemaVersion":6');
		const body = (t: string) => t.slice(t.indexOf("\n"));
		expect(body(written)).toBe(body(withEmptySyncLinks(text)));
	});
});

describe("v4 to v5 migration (SYNC-11)", () => {
	const v4Text = readFileSync(join(FIXTURES, "schema-v4.cpbase"), "utf8");
	const step = MIGRATIONS.find((m) => m.from === 4);

	it("a step from 4 exists", () => {
		expect(step).toBeDefined();
	});

	it("adds an empty syncLinks collection and changes nothing else", () => {
		const parsed = parseDbText(v4Text);
		if (!parsed.ok) throw new Error("fixture unreadable");
		const migrated = runMigrations(parsed.raw, [step!]);
		expect(migrated).toEqual({ ...parsed.raw, schemaVersion: 5, syncLinks: [] });
	});

	it("is idempotent and keeps existing links", () => {
		const raw = { schemaVersion: 4, tasks: [], syncLinks: [{ kind: "list", logwellId: "inbox" }] };
		const once = runMigrations(raw, [step!]);
		expect(once).toEqual({ ...raw, schemaVersion: 5 });
		expect(runMigrations({ ...once, schemaVersion: 4 }, [step!])).toEqual(once);
	});

	it("reopening the migrated file does not migrate, snapshot or notify again", async () => {
		const h = harness(v4Text);
		await h.store.open();
		const again = harness(h.fs.files.get(DB_PATH) ?? "");
		await again.store.open();
		expect(again.events.filter((e) => e.type === "migrated")).toEqual([]);
		const backups = await again.fs.list("plugin/backups/5c2e8a40-1b7d-4f3e-9a51-0d6c2f1e7b90/snapshots");
		expect(backups.filter((p) => p.includes("/pre-migration-"))).toEqual([]);
	});

	it("an older reader (target version 4) treats v5 as newer, so it is read-only", () => {
		expect(planMigration(5, MIGRATIONS, 4)).toEqual({ kind: "newer", version: 5 });
		expect(planMigration(4, MIGRATIONS, 4)).toEqual({ kind: "current" });
	});
});

describe("frozen v5 fixture (sync links; migrates to v6, #12)", () => {
	const text = readFileSync(join(FIXTURES, "schema-v5.cpbase"), "utf8");

	it("migrates to v6 with no issues; the output is the v5 text with the version changed", () => {
		const r = loadText(text, "2026-10-07T10:00:00.000Z");
		if (r.kind !== "ok") throw new Error(`fixture did not load: ${JSON.stringify(r)}`);
		expect(r.issues).toEqual([]);
		expect(r.migratedFrom).toBe(5);
		expect(serializeDb(r.data)).toBe(text.replace('"schemaVersion":5', '"schemaVersion":6'));
	});

	it("reads one link of each kind as typed values, unknown fields kept", () => {
		const r = loadText(text, "2026-10-07T10:00:00.000Z");
		if (r.kind !== "ok") throw new Error("did not load");
		expect(r.data.syncLinks.size).toBe(4);
		expect(r.data.syncLinks.get("list:inbox")).toEqual({
			kind: "list",
			logwellId: "inbox",
			ttId: "inbox118000001",
			ttProjectId: null,
			etag: null,
			base: {},
			noteBySync: false,
			lastPulledAt: "2026-10-07T07:55:00.000Z",
			modifiedAt: "2026-10-07T07:55:00.000Z",
		});
		expect(r.data.syncLinks.get("section:b2c3d4e5-0003-4b00-8000-00000000b003")).toMatchObject({
			kind: "section",
			ttId: "6710c0de0000000000000003",
			ttProjectId: "inbox118000001",
		});
		expect(r.data.syncLinks.get("task:0b9f6c1e-6a52-4c39-9a7c-5f2f0f4f8a11")).toEqual({
			kind: "task",
			logwellId: "0b9f6c1e-6a52-4c39-9a7c-5f2f0f4f8a11",
			ttId: "6710c0de00000000000000a1",
			ttProjectId: "inbox118000001",
			etag: "x1y2z3w4",
			base: { note: "c4ca42", priority: "0b7e3d", title: "5d41c0" },
			noteBySync: true,
			lastPulledAt: null,
			modifiedAt: "2026-10-07T07:55:00.000Z",
			laterField: "kept",
		});
		// A link to a trashed task is kept.
		expect(r.data.syncLinks.has("task:3e2c9f41-9d85-4f6c-ad0f-8c5c3c7dbd44")).toBe(true);
	});

	it("opening it writes a pre-migration snapshot of the original text first, then the v6 file, and notifies once", async () => {
		const h = harness(text);
		await h.store.open();
		expect(h.events.filter((e) => e.type === "migrated")).toEqual([{ type: "migrated", from: 5, to: 6 }]);
		const snapshots = await h.fs.list("plugin/backups/5c2e8a40-1b7d-4f3e-9a51-0d6c2f1e7b90/snapshots");
		const pre = snapshots.filter((p) => p.includes("/pre-migration-"));
		expect(pre).toHaveLength(1);
		expect(h.fs.files.get(pre[0]!)).toBe(text);
		expect(h.fs.files.get(DB_PATH) ?? "").toContain('"schemaVersion":6');
		expect(h.store.readOnlyState).toBeNull();
	});
});

describe("frozen v6 fixture (#12, yearly repeat)", () => {
	const text = readFileSync(join(FIXTURES, "schema-v6.cpbase"), "utf8");

	it("opens without a migration, a snapshot or a notice", async () => {
		const h = harness(text);
		await h.store.open();
		expect(h.events.filter((e) => e.type === "migrated")).toEqual([]);
		expect(h.store.readOnlyState).toBeNull();
		expect(h.fs.files.get(DB_PATH)).toBe(text);
	});
});

describe("v1 to v2 migration (PRI-01, D1)", () => {
	const v1Text = readFileSync(join(FIXTURES, "schema-v1.cpbase"), "utf8");

	it("a step from 1 exists", () => {
		expect(V2_STEP).toHaveLength(1);
	});

	it("adds priority 0 to every task (including trashed ones) and color null to every category, nothing else", () => {
		const parsed = parseDbText(v1Text);
		if (!parsed.ok) throw new Error("fixture unreadable");
		const migrated = runMigrations(parsed.raw, V2_STEP);
		expect(migrated.schemaVersion).toBe(2);
		const tasks = migrated.tasks as Record<string, unknown>[];
		const trashed = (migrated.trash as { tasks: Record<string, unknown>[] }[]).flatMap((e) => e.tasks);
		expect(tasks.length + trashed.length).toBeGreaterThan(3);
		for (const t of [...tasks, ...trashed]) expect(t.priority).toBe(0);
		const cats = migrated.categories as Record<string, unknown>[];
		expect(cats.length).toBe(2);
		for (const c of cats) expect(c.color).toBeNull();
		const strip = (rows: Record<string, unknown>[], field: string) => rows.map(({ [field]: _x, ...rest }) => rest);
		const orig = parsed.raw as Record<string, unknown[]>;
		expect(strip(tasks, "priority")).toEqual(orig.tasks);
		expect(strip(cats, "color")).toEqual(orig.categories);
		expect(migrated.tags).toEqual(orig.tags);
		expect(migrated.habits).toEqual(orig.habits);
	});

	it("loading the v1 fixture gives priority 0 and color null everywhere and no repair issues", () => {
		const r = loadText(v1Text, "2026-10-01T10:00:00.000Z");
		if (r.kind !== "ok") throw new Error("did not load");
		expect(r.issues).toEqual([]);
		expect(r.data.meta.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
		for (const t of r.data.tasks.values()) expect(t.priority).toBe(0);
		for (const e of r.data.trash.values()) for (const t of e.tasks) expect(t.priority).toBe(0);
		for (const c of r.data.categories.values()) expect(c.color).toBeNull();
	});

	it("opening a v1 file writes a pre-migration snapshot of the original text, then the current file", async () => {
		const h = harness(v1Text);
		await h.store.open();
		expect(h.events.find((e) => e.type === "migrated")).toEqual({ type: "migrated", from: 1, to: CURRENT_SCHEMA_VERSION });
		const backups = await h.fs.list("plugin/backups/5c2e8a40-1b7d-4f3e-9a51-0d6c2f1e7b90/snapshots");
		const pre = backups.find((p) => p.includes("/pre-migration-"));
		expect(pre).toBeDefined();
		expect(h.fs.files.get(pre!)).toBe(v1Text);
		expect(h.fs.files.get(DB_PATH) ?? "").toContain(`"schemaVersion":${CURRENT_SCHEMA_VERSION}`);
	});

	it("a file with a newer schema (current + 1) stays read-only and is not written", async () => {
		const newer = v1Text.replace('"schemaVersion":1', `"schemaVersion":${CURRENT_SCHEMA_VERSION + 1}`);
		const r = loadText(newer, "2026-10-01T10:00:00.000Z");
		expect(r.kind).toBe("newer");
		const h = harness(newer);
		await h.store.open();
		expect(h.store.readOnlyState).not.toBeNull();
		expect(h.fs.files.get(DB_PATH)).toBe(newer);
	});

	it("validates the new fields: a bad priority is rejected, a bad category color is cleared with an issue", () => {
		const v2 = v1Text.replace('"schemaVersion":1', '"schemaVersion":2');
		const badPriority = v2.replace('"status":"open"', '"priority":7,"status":"open"');
		expect(loadText(badPriority, "2026-10-01T10:00:00.000Z").kind).toBe("failed");
		const badColor = v2.replace('"name":"Study"', '"name":"Study","color":"mauve"');
		const r = loadText(badColor, "2026-10-01T10:00:00.000Z");
		if (r.kind !== "ok") throw new Error("did not load");
		expect(r.issues.join(" ")).toContain("mauve");
		expect(r.data.categories.get("5e0d1c2b-3a49-4f58-8e67-7d6c5b4a3921")?.color).toBeNull();
		const goodColor = v2.replace('"name":"Study"', '"name":"Study","color":"blue"');
		const g = loadText(goodColor, "2026-10-01T10:00:00.000Z");
		if (g.kind !== "ok") throw new Error("did not load");
		expect(g.data.categories.get("5e0d1c2b-3a49-4f58-8e67-7d6c5b4a3921")?.color).toBe("blue");
		const goodPriority = v2.replace('"status":"open"', '"priority":2,"status":"open"');
		const p = loadText(goodPriority, "2026-10-01T10:00:00.000Z");
		if (p.kind !== "ok") throw new Error("did not load");
		expect([...p.data.tasks.values()].some((t) => t.priority === 2)).toBe(true);
	});
});

describe("migration runner (DATA-01)", () => {
	const steps: Migration[] = [
		{ from: 1, describe: "add field a", migrate: (raw) => ({ ...raw, a: true }) },
		{ from: 2, describe: "rename a to b", migrate: ({ a, ...raw }) => ({ ...raw, b: a }) },
	];

	it("plans steps in order up to the target", () => {
		const plan = planMigration(1, steps, 3);
		expect(plan.kind).toBe("migrate");
		if (plan.kind !== "migrate") return;
		expect(plan.steps.map((s) => s.from)).toEqual([1, 2]);
		expect(runMigrations({ schemaVersion: 1 }, plan.steps)).toEqual({ schemaVersion: 3, b: true });
	});

	it("reports newer, current and missing steps", () => {
		expect(planMigration(4, steps, 3)).toEqual({ kind: "newer", version: 4 });
		expect(planMigration(3, steps, 3)).toEqual({ kind: "current" });
		expect(planMigration(1, [steps[1]!], 3).kind).toBe("unsupported");
	});

	it("backs up the file before writing the migrated version", async () => {
		const v0 = readFileSync(join(FIXTURES, "schema-v1.cpbase"), "utf8").replace('"schemaVersion":1', '"schemaVersion":0');
		const toV1: Migration = {
			from: 0,
			describe: "test step",
			migrate: (raw) => ({ ...raw, tags: [...(raw.tags as object[]), { key: "migrated", displayName: "migrated", createdAt: "x", modifiedAt: "x" }] }),
		};
		const h = harness(v0, [toV1, ...MIGRATIONS]);
		await h.store.open();
		expect(h.events.find((e) => e.type === "migrated")).toEqual({ type: "migrated", from: 0, to: CURRENT_SCHEMA_VERSION });
		const backups = await h.fs.list("plugin/backups/5c2e8a40-1b7d-4f3e-9a51-0d6c2f1e7b90/snapshots");
		const pre = backups.find((p) => p.includes("/pre-migration-"));
		expect(pre).toBeDefined();
		expect(h.fs.files.get(pre!)).toBe(v0);
		const written = h.fs.files.get(DB_PATH) ?? "";
		expect(written).toContain(`"schemaVersion":${CURRENT_SCHEMA_VERSION}`);
		expect(written).toContain('"key":"migrated"');
	});
});

describe("a yearly rule in the file", () => {
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
		it("#12: the frozen v6 fixture loads with no issues and round-trips byte for byte", () => {
			const r = loadText(V6, "2026-10-07T10:00:00.000Z");
			if (r.kind !== "ok") throw new Error(`fixture did not load: ${JSON.stringify(r)}`);
			expect(r.issues).toEqual([]);
			expect(r.migratedFrom).toBeNull();
			expect(r.data.tasks.get(YEARLY_ID)?.recurrence?.versions[0]?.rule.freq).toBe("yearly");
			expect(serializeDb(r.data)).toBe(V6);
		});

		it("#12: clears weekdays and a day of the month on a yearly rule, with an issue", () => {
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

		it("#12: the schema is version 6 and the steps are 1 to 5", () => {
			expect(CURRENT_SCHEMA_VERSION).toBe(6);
			expect(MIGRATIONS.map((m) => m.from)).toEqual([1, 2, 3, 4, 5]);
			expect(step).toBeDefined();
		});

		it("#12: changes the header only", () => {
			const parsed = parseDbText(V5);
			if (!parsed.ok) throw new Error("fixture unreadable");
			expect(runMigrations(parsed.raw, [step!])).toEqual({ ...parsed.raw, schemaVersion: 6 });
		});

		it("#12: opening the v5 fixture migrates it to v6 and changes only the version", async () => {
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

		it("#12: an older reader (target version 5) treats v6 as newer, so it is read-only", () => {
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
		it("#12: is migrated with no conflict when memory holds no yearly repeat", async () => {
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

		it("#12: keeps a conflict copy first when memory holds a yearly repeat", async () => {
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

		it("#12: keeps a conflict copy for a yearly repeat in the Trash too", async () => {
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
});
