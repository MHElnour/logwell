import { describe, expect, it } from "vitest";
import type { OccurrenceRecord, Recurrence, Section, SyncLink } from "../../src/domain/types";
import { CURRENT_SCHEMA_VERSION, type DbData } from "../../src/persistence/schema";
import { applyOps } from "../../src/persistence/journal";
import { DB_PATH, descendant, harness, makeTask } from "./fixtures";

describe("a v2 file", () => {
	// A v2 file arriving through applyExternal is migrated and announced;
	// when memory holds sections or a sectionId that the v2 file cannot hold, a
	// conflict copy keeps them first.

	const section: Section = {
		id: "sec-1",
		categoryId: "inbox",
		name: "Triage",
		nameKey: "triage",
		sortKey: "a",
		createdAt: "2026-10-01T09:00:00.000Z",
		modifiedAt: "2026-10-01T09:00:00.000Z",
	};

	/** A descendant of `base` as an older (schema 2) device writes it: no sections, no sectionId. */
	function asV2(base: string, revision: string): string {
		const strip = (d: DbData): DbData => ({
			...d,
			sections: new Map(),
			tasks: new Map([...d.tasks].map(([id, t]) => [id, { ...t, sectionId: null }])),
		});
		return descendant(base, strip, revision).replace(/"schemaVersion":\d+/u, '"schemaVersion":2');
	}

	function addSection(h: ReturnType<typeof harness>): void {
		const next = { ...h.store.data, sections: new Map([[section.id, section]]) };
		h.store.commit(next, [{ c: "sections", id: section.id, v: section }]);
	}

	describe("CpbaseStore: a v2 file arriving externally", () => {
		it("is migrated and announced with the migrated event", async () => {
			const h = harness();
			await h.store.open();
			h.fs.files.set(DB_PATH, asV2(h.dbText(), "r-v2-remote"));
			h.events.length = 0;
			await h.store.handleExternalChange();
			expect(h.events).toContainEqual({ type: "migrated", from: 2, to: CURRENT_SCHEMA_VERSION });
			expect(h.events.some((e) => e.type === "conflict")).toBe(false);
			expect(h.store.data.meta.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
		});

		it("keeps a conflict copy first when memory holds a section", async () => {
			const h = harness();
			await h.store.open();
			addSection(h);
			await h.saveNow();
			h.fs.files.set(DB_PATH, asV2(h.dbText(), "r-v2-remote"));
			h.events.length = 0;
			await h.store.handleExternalChange();
			const conflict = h.events.find((e) => e.type === "conflict");
			if (conflict?.type !== "conflict") throw new Error("no conflict event");
			expect(h.fs.files.get(conflict.path)).toContain('"name":"Triage"');
			expect(h.store.data.sections.size).toBe(0);
			expect(h.events).toContainEqual({ type: "migrated", from: 2, to: CURRENT_SCHEMA_VERSION });
		});

		it("keeps a conflict copy first when memory holds a task with a sectionId", async () => {
			const h = harness();
			await h.store.open();
			addSection(h);
			h.addTask(makeTask("t1", { sectionId: section.id }));
			await h.saveNow();
			// The older device's file has no sections either way.
			h.fs.files.set(DB_PATH, asV2(h.dbText(), "r-v2-remote"));
			h.events.length = 0;
			await h.store.handleExternalChange();
			expect(h.events.some((e) => e.type === "conflict")).toBe(true);
		});

		it("an ordinary current-schema descendant still fast-forwards with no conflict and no notice", async () => {
			const h = harness();
			await h.store.open();
			addSection(h);
			await h.saveNow();
			h.fs.files.set(DB_PATH, descendant(h.dbText(), (d) => applyOps(d, []), "r-cur-remote"));
			h.events.length = 0;
			await h.store.handleExternalChange();
			expect(h.events.some((e) => e.type === "conflict" || e.type === "migrated")).toBe(false);
		});
	});
});

describe("a v3 file", () => {
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

	describe("CpbaseStore: a v3 file arriving externally (D1)", () => {
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
});

describe("a v4 file", () => {
	// A v4 file arriving through sync is migrated and announced; when memory holds
	// TickTick links, which a v4 writer cannot have kept, a conflict copy keeps them first.

	const listLink: SyncLink = {
		kind: "list",
		logwellId: "inbox",
		ttId: "inbox118000001",
		ttProjectId: null,
		etag: null,
		base: {},
		noteBySync: false,
		lastPulledAt: "2026-10-07T07:55:00.000Z",
		modifiedAt: "2026-10-07T07:55:00.000Z",
	};

	/** A descendant of `base` as a schema 4 device writes it: no syncLinks collection. */
	function asV4(base: string, revision: string): string {
		const strip = (d: DbData): DbData => ({ ...d, syncLinks: new Map() });
		const text = descendant(base, strip, revision).replace(/"schemaVersion":\d+/u, '"schemaVersion":4');
		return text.replace(',\n"syncLinks":[]\n}\n', "\n}\n");
	}

	describe("CpbaseStore: a v4 file arriving externally", () => {
		it("is migrated and announced, with no conflict when memory holds no link", async () => {
			const h = harness();
			await h.store.open();
			h.addTask(makeTask("t0"));
			await h.saveNow();
			const v4 = asV4(h.dbText(), "r-v4-remote");
			expect(v4).not.toContain("syncLinks");
			h.fs.files.set(DB_PATH, v4);
			h.events.length = 0;
			await h.store.handleExternalChange();
			expect(h.events).toContainEqual({ type: "migrated", from: 4, to: CURRENT_SCHEMA_VERSION });
			expect(h.events.some((e) => e.type === "conflict")).toBe(false);
			expect(h.store.data.meta.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
			expect(h.store.readOnlyState).toBeNull();
		});

		it("keeps a conflict copy first when memory holds a sync link", async () => {
			const h = harness();
			await h.store.open();
			h.store.commit({ ...h.store.data, syncLinks: new Map([["list:inbox", listLink]]) }, [{ c: "syncLinks", id: "list:inbox", v: listLink }]);
			await h.saveNow();
			h.fs.files.set(DB_PATH, asV4(h.dbText(), "r-v4-remote"));
			h.events.length = 0;
			await h.store.handleExternalChange();
			const conflict = h.events.find((e) => e.type === "conflict");
			if (conflict?.type !== "conflict") throw new Error("no conflict event");
			expect(h.fs.files.get(conflict.path)).toContain('"ttId":"inbox118000001"');
			expect(h.store.data.syncLinks.size).toBe(0);
			expect(h.events).toContainEqual({ type: "migrated", from: 4, to: CURRENT_SCHEMA_VERSION });
			expect(h.store.readOnlyState).toBeNull();
		});
	});
});
