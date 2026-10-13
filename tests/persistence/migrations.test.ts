import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadText } from "../../src/persistence/CpbaseStore";
import { MIGRATIONS, type Migration, planMigration, runMigrations } from "../../src/persistence/migrations";
import { CURRENT_SCHEMA_VERSION, type DbData, inboxCategory } from "../../src/persistence/schema";
import { parseDbText, serializeDb } from "../../src/persistence/serializer";
import { validateDb } from "../../src/persistence/validate";
import { DB_PATH, harness } from "./fixtures";

// The frozen schema fixtures (tests/fixtures/schema-v*.cpbase) and the migration steps. A file from an older schema
// arriving while Logwell is open is in external-versions.test.ts.

const fixture = (version: number) => readFileSync(join(import.meta.dirname, "..", "fixtures", `schema-v${version}.cpbase`), "utf8");
const SNAPSHOTS = "plugin/backups/5c2e8a40-1b7d-4f3e-9a51-0d6c2f1e7b90/snapshots";
const NOW = "2026-10-05T10:00:00.000Z";

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
const atCurrent = (text: string, version: number) => text.replace(`"schemaVersion":${version}`, `"schemaVersion":${CURRENT_SCHEMA_VERSION}`);

const GYM = "4f5a6b7c-8d9e-4fa0-b1c2-d3e4f5a6b7c8";
const RENT = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d";
const NEWS = "6b7c8d9e-0f1a-4b2c-9d3e-4f5a6b7c8d9e";

interface Frozen {
	version: number;
	/** The text it serializes to once loaded: the version moved, later empty collections added, typed habits. */
	written: (text: string) => string;
	/** The typed values that version brought. */
	read: (data: DbData) => void;
}

// One row per frozen fixture: every older file must open unchanged.
const FROZEN: Frozen[] = [
	{
		version: 1,
		written: (t) => withEmptySyncLinks(withTypedHabits(withEmptySections(atCurrent(t, 1)))),
		read: (d) => {
			expect(d.tasks.size).toBe(3);
			expect(d.trash.size).toBe(1);
			expect(d.tasks.get("0b9f6c1e-6a52-4c39-9a7c-5f2f0f4f8a11")?.descriptionNote?.path).toBe("Task notes/Python study plan.md");
			expect(d.habits.size).toBe(1);
			// v2's priority and color are defaults: 0 and null everywhere, trashed tasks included.
			for (const t of d.tasks.values()) expect(t.priority).toBe(0);
			for (const e of d.trash.values()) for (const t of e.tasks) expect(t.priority).toBe(0);
			for (const c of d.categories.values()) expect(c.color).toBeNull();
		},
	},
	{
		version: 2,
		written: (t) => withEmptySyncLinks(withTypedHabits(withEmptySections(atCurrent(t, 2)))),
		read: (d) => {
			expect(d.categories.get("5e0d1c2b-3a49-4f58-8e67-7d6c5b4a3921")?.color).toBe("purple");
			expect([...d.tasks.values()].map((t) => t.priority).sort()).toEqual([0, 1, 1, 2, 3]);
			expect(d.trash.size).toBe(1);
			expect(d.sections.size).toBe(0);
			for (const t of d.tasks.values()) expect(t.sectionId).toBeNull();
			for (const e of d.trash.values()) for (const t of e.tasks) expect(t.sectionId).toBeNull();
		},
	},
	{
		version: 3,
		written: (t) => withEmptySyncLinks(withTypedHabits(atCurrent(t, 3))),
		read: (d) => {
			// Tasks in and out of sections, subtasks and trashed tasks included.
			expect(d.sections.size).toBe(3);
			const sectionOf = (id: string) => d.tasks.get(id)?.sectionId;
			expect(sectionOf("0b9f6c1e-6a52-4c39-9a7c-5f2f0f4f8a11")).toBe("a1b2c3d4-0001-4a00-8000-00000000a001");
			expect(sectionOf("1c0a7d2f-7b63-4d4a-8b8d-6a3a1a5b9b22")).toBe("a1b2c3d4-0001-4a00-8000-00000000a001");
			expect(sectionOf("2d1b8e30-8c74-4e5b-9c9e-7b4b2b6cac33")).toBe("b2c3d4e5-0003-4b00-8000-00000000b003");
			expect(sectionOf("9c3d4e5f-6a7b-4c8d-ae9f-1a2b3c4d5e6f")).toBeNull();
			expect([...d.trash.values()].flatMap((e) => e.tasks)[0]?.sectionId).toBe("b2c3d4e5-0003-4b00-8000-00000000b003");
			expect(d.sections.get("a1b2c3d4-0002-4a00-8000-00000000a002")).toMatchObject({ categoryId: "5e0d1c2b-3a49-4f58-8e67-7d6c5b4a3921", name: "Week 2", nameKey: "week 2" });
		},
	},
	{
		version: 4,
		written: (t) => withEmptySyncLinks(atCurrent(t, 4)),
		read: (d) => {
			expect(d.syncLinks.size).toBe(0);
			const gym = d.tasks.get(GYM)?.recurrence;
			expect(gym?.anchor).toBe("2026-09-28");
			expect(gym?.versions.map((v) => v.rule.weekdays)).toEqual([["MO", "WE", "FR"], ["TU", "TH"]]);
			expect(gym?.versions[0]?.rule).toMatchObject({ freq: "weekly", interval: 1, time: "07:00", tz: "Europe/Berlin", afterCompletion: false });
			expect(d.tasks.get(GYM)?.scheduled).toBeNull();
			const rent = d.tasks.get(RENT)?.recurrence;
			expect(rent?.end).toEqual({ kind: "count", count: 12 });
			expect(rent?.versions[0]?.rule).toMatchObject({ freq: "monthly", monthly: { kind: "day", day: 31 }, afterCompletion: true });
			expect(d.tasks.get(NEWS)?.recurrence?.endedAt).toBe("2026-10-03T09:00:00.000Z");
			expect(d.occurrenceRecords.size).toBe(6);
			expect(d.occurrenceRecords.get(`${GYM}:2026-09-30`)).toEqual({ taskId: GYM, occurrenceDate: "2026-09-30", status: "skipped", resolvedAt: "2026-10-02T06:00:00.000Z", auto: true, completedOn: null });
			expect(d.occurrenceRecords.get(`${GYM}:2026-10-05`)).toMatchObject({ status: "skipped", auto: false });
			expect(d.occurrenceRecords.get(`${RENT}:2026-08-31`)).toMatchObject({ status: "done", completedOn: "2026-09-01", auto: false });
		},
	},
	{
		version: 5,
		written: (t) => atCurrent(t, 5),
		read: (d) => {
			// One link of each kind as typed values, unknown fields kept.
			expect(d.syncLinks.size).toBe(4);
			expect(d.syncLinks.get("list:inbox")).toEqual({
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
			expect(d.syncLinks.get("section:b2c3d4e5-0003-4b00-8000-00000000b003")).toMatchObject({ kind: "section", ttId: "6710c0de0000000000000003", ttProjectId: "inbox118000001" });
			expect(d.syncLinks.get("task:0b9f6c1e-6a52-4c39-9a7c-5f2f0f4f8a11")).toEqual({
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
			expect(d.syncLinks.has("task:3e2c9f41-9d85-4f6c-ad0f-8c5c3c7dbd44")).toBe(true);
		},
	},
	{
		version: 6,
		written: (t) => t,
		read: (d) => expect(d.tasks.get("7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f")?.recurrence?.versions[0]?.rule.freq).toBe("yearly"),
	},
];

describe.each(FROZEN)("the frozen v$version fixture", ({ version, written, read }) => {
	const text = fixture(version);
	const loaded = () => {
		const r = loadText(text, "2026-10-07T10:00:00.000Z");
		if (r.kind !== "ok") throw new Error(`fixture did not load: ${JSON.stringify(r)}`);
		return r;
	};

	it("loads with no issues and writes back byte for byte (only the version and later empty collections change)", () => {
		const r = loaded();
		expect(r.issues).toEqual([]);
		expect(r.migratedFrom).toBe(version === CURRENT_SCHEMA_VERSION ? null : version);
		expect(serializeDb(r.data)).toBe(written(text));
	});

	it("reads its records as typed values", () => {
		read(loaded().data);
	});
});

describe("opening an older file", () => {
	it("writes a pre-migration snapshot of the original text first, then the current file, and notifies once", async () => {
		const text = fixture(4);
		const h = harness(text);
		await h.store.open();
		expect(h.events.filter((e) => e.type === "migrated")).toEqual([{ type: "migrated", from: 4, to: CURRENT_SCHEMA_VERSION }]);
		expect(h.store.readOnlyState).toBeNull();
		const pre = (await h.fs.list(SNAPSHOTS)).filter((p) => p.includes("/pre-migration-"));
		expect(pre).toHaveLength(1);
		expect(h.fs.files.get(pre[0]!)).toBe(text);
		// The snapshot is written before the migrated file.
		const snapshotWrite = h.fs.writes.indexOf(pre[0]!);
		const dbWrite = h.fs.writes.indexOf(DB_PATH);
		expect(snapshotWrite).toBeGreaterThanOrEqual(0);
		expect(dbWrite).toBeGreaterThan(snapshotWrite);
		const out = h.fs.files.get(DB_PATH) ?? "";
		expect(out).toContain(`"schemaVersion":${CURRENT_SCHEMA_VERSION}`);
		// Apart from the header (new revision, history, writer) and the empty syncLinks, the records are the v4 text's.
		const body = (t: string) => t.slice(t.indexOf("\n"));
		expect(body(out)).toBe(body(withEmptySyncLinks(text)));
	});

	it("a v1 file runs every step in one load: one snapshot, one notice from 1 to the current schema", async () => {
		const h = harness(fixture(1));
		await h.store.open();
		expect(h.events.filter((e) => e.type === "migrated")).toEqual([{ type: "migrated", from: 1, to: CURRENT_SCHEMA_VERSION }]);
		expect((await h.fs.list(SNAPSHOTS)).filter((p) => p.includes("/pre-migration-"))).toHaveLength(1);
	});

	it("reopening the migrated file does not migrate, snapshot or notify again", async () => {
		const h = harness(fixture(4));
		await h.store.open();
		const again = harness(h.fs.files.get(DB_PATH) ?? "");
		await again.store.open();
		expect(again.events.filter((e) => e.type === "migrated")).toEqual([]);
		expect((await again.fs.list(SNAPSHOTS)).filter((p) => p.includes("/pre-migration-"))).toEqual([]);
	});

	it("the current fixture opens without a migration, a snapshot or a notice", async () => {
		const text = fixture(6);
		const h = harness(text);
		await h.store.open();
		expect(h.events.filter((e) => e.type === "migrated")).toEqual([]);
		expect(h.store.readOnlyState).toBeNull();
		expect(h.fs.files.get(DB_PATH)).toBe(text);
	});

	it("a file with a newer schema (current + 1) stays read-only and is not written", async () => {
		const newer = fixture(1).replace('"schemaVersion":1', `"schemaVersion":${CURRENT_SCHEMA_VERSION + 1}`);
		expect(loadText(newer, "2026-10-01T10:00:00.000Z").kind).toBe("newer");
		const h = harness(newer);
		await h.store.open();
		expect(h.store.readOnlyState).not.toBeNull();
		expect(h.fs.files.get(DB_PATH)).toBe(newer);
	});
});

// The steps that change records. The header-only steps (3 to 4 and 5 to 6) are proved by the fixtures' byte round
// trips above.

describe("the migration steps", () => {
	it("#12: the schema is version 6 and the steps are 1 to 5", () => {
		expect(CURRENT_SCHEMA_VERSION).toBe(6);
		expect(MIGRATIONS.map((m) => m.from)).toEqual([1, 2, 3, 4, 5]);
	});

	describe("v1 to v2 (PRI-01, D1)", () => {
		const step = MIGRATIONS.filter((m) => m.from === 1);

		it("adds priority 0 to every task (including trashed ones) and color null to every category, nothing else", () => {
			const parsed = parseDbText(fixture(1));
			if (!parsed.ok) throw new Error("fixture unreadable");
			const migrated = runMigrations(parsed.raw, step);
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

		it("validates the new fields: a bad priority is rejected, a bad category color is cleared with an issue", () => {
			const v2 = fixture(1).replace('"schemaVersion":1', '"schemaVersion":2');
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

	describe("v2 to v3 (D2)", () => {
		const step = MIGRATIONS.find((m) => m.from === 2)!;

		it("adds sectionId null to every task, trashed ones too, and changes nothing else", () => {
			const parsed = parseDbText(fixture(2));
			if (!parsed.ok) throw new Error("fixture unreadable");
			const migrated = runMigrations(parsed.raw, [step]);
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
			const once = runMigrations(raw, [step]);
			expect(once.tasks).toEqual([{ id: "a", sectionId: "s1" }, { id: "b", sectionId: null }]);
			expect(once.trash).toEqual([{ batchId: "x", tasks: [{ id: "c", sectionId: "s2" }, { id: "d", sectionId: null }] }]);
			expect(runMigrations({ ...once, schemaVersion: 2 }, [step])).toEqual(once);
		});
	});

	describe("v4 to v5 (SYNC-11)", () => {
		const step = MIGRATIONS.find((m) => m.from === 4)!;

		it("adds an empty syncLinks collection and changes nothing else", () => {
			const parsed = parseDbText(fixture(4));
			if (!parsed.ok) throw new Error("fixture unreadable");
			expect(runMigrations(parsed.raw, [step])).toEqual({ ...parsed.raw, schemaVersion: 5, syncLinks: [] });
		});

		it("is idempotent and keeps existing links", () => {
			const raw = { schemaVersion: 4, tasks: [], syncLinks: [{ kind: "list", logwellId: "inbox" }] };
			const once = runMigrations(raw, [step]);
			expect(once).toEqual({ ...raw, schemaVersion: 5 });
			expect(runMigrations({ ...once, schemaVersion: 4 }, [step])).toEqual(once);
		});
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
		const v0 = fixture(1).replace('"schemaVersion":1', '"schemaVersion":0');
		const toV1: Migration = {
			from: 0,
			describe: "test step",
			migrate: (raw) => ({ ...raw, tags: [...(raw.tags as object[]), { key: "migrated", displayName: "migrated", createdAt: "x", modifiedAt: "x" }] }),
		};
		const h = harness(v0, [toV1, ...MIGRATIONS]);
		await h.store.open();
		expect(h.events.find((e) => e.type === "migrated")).toEqual({ type: "migrated", from: 0, to: CURRENT_SCHEMA_VERSION });
		const pre = (await h.fs.list(SNAPSHOTS)).find((p) => p.includes("/pre-migration-"));
		expect(pre).toBeDefined();
		expect(h.fs.files.get(pre!)).toBe(v0);
		const out = h.fs.files.get(DB_PATH) ?? "";
		expect(out).toContain(`"schemaVersion":${CURRENT_SCHEMA_VERSION}`);
		expect(out).toContain('"key":"migrated"');
	});
});

describe("a yearly rule in the file", () => {
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
