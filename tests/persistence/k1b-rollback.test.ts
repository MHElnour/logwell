import { describe, expect, it } from "vitest";
import type { Section } from "../../src/domain/types";
import { CURRENT_SCHEMA_VERSION, type DbData } from "../../src/persistence/schema";
import { applyOps } from "../../src/persistence/journal";
import { DB_PATH, descendant, harness, makeTask } from "./fixtures";

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

describe("CpbaseStore: a v2 file arriving externally (K1b #116)", () => {
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

