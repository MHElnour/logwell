import { describe, expect, it } from "vitest";
import type { SyncLink } from "../../src/domain/types";
import { CURRENT_SCHEMA_VERSION, type DbData } from "../../src/persistence/schema";
import { DB_PATH, descendant, harness, makeTask } from "./fixtures";

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

describe("CpbaseStore: a v4 file arriving externally (issue #6)", () => {
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
