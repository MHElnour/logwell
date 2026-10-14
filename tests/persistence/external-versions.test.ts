import { describe, expect, it } from "vitest";
import type { OccurrenceRecord, Recurrence, Section, SyncLink, Task } from "../../src/domain/types";
import { applyOps } from "../../src/persistence/journal";
import { CURRENT_SCHEMA_VERSION, type DbData } from "../../src/persistence/schema";
import { DB_PATH, descendant, type Harness, harness, makeTask } from "./fixtures";

// A file an older device wrote, arriving through sync or git (applyExternal), is migrated and announced. When memory
// holds data that the older schema cannot hold, a conflict copy keeps it first: one row per such kind of data.

/** A descendant of `base` as a device of `version` writes it: without what that schema cannot hold. */
function asOlder(version: 2 | 3 | 4 | 5, base: string, revision: string): string {
	const strip = (d: DbData): DbData => {
		const tasks = new Map<string, Task>();
		for (const [id, t] of d.tasks) {
			if (version === 5 && t.recurrence?.versions.some((v) => v.rule.freq === "yearly")) continue;
			tasks.set(id, { ...t, ...(version === 2 ? { sectionId: null } : {}), ...(version === 3 ? { recurrence: null } : {}) });
		}
		return {
			...d,
			tasks,
			...(version === 2 ? { sections: new Map() } : {}),
			...(version === 3 ? { occurrenceRecords: new Map() } : {}),
			...(version === 4 ? { syncLinks: new Map() } : {}),
		};
	};
	const text = descendant(base, strip, revision).replace(/"schemaVersion":\d+/u, `"schemaVersion":${version}`);
	// Schema 4 has no syncLinks collection at all.
	return version === 4 ? text.replace(',\n"syncLinks":[]\n}\n', "\n}\n") : text;
}

const NOW = "2026-10-05T10:00:00.000Z";
const section: Section = { id: "sec-1", categoryId: "inbox", name: "Triage", nameKey: "triage", sortKey: "a", createdAt: NOW, modifiedAt: NOW };
const daily: Recurrence = {
	anchor: "2026-10-01",
	versions: [{ effectiveFrom: "2026-10-01", rule: { freq: "daily", interval: 1, weekdays: null, monthly: null, afterCompletion: false, time: null, tz: null } }],
	end: { kind: "never" },
	endedAt: null,
};
const yearly: Recurrence = {
	anchor: "2026-03-14",
	versions: [{ effectiveFrom: "2026-03-14", rule: { freq: "yearly", interval: 2, weekdays: null, monthly: null, afterCompletion: false, time: null, tz: null } }],
	end: { kind: "never" },
	endedAt: null,
};
const record: OccurrenceRecord = { taskId: "t1", occurrenceDate: "2026-10-01", status: "done", resolvedAt: NOW, auto: false, completedOn: "2026-10-01" };
const listLink: SyncLink = {
	kind: "list",
	logwellId: "inbox",
	ttId: "inbox118000001",
	ttProjectId: null,
	etag: null,
	base: {},
	noteBySync: false,
	lastPulledAt: NOW,
	modifiedAt: NOW,
};

function addSection(h: Harness): void {
	h.store.commit({ ...h.store.data, sections: new Map([[section.id, section]]) }, [{ c: "sections", id: section.id, v: section }]);
}

/** An older file arriving while memory holds what `seed` puts there. */
async function arriving(version: 2 | 3 | 4 | 5, seed: (h: Harness) => void, older = (base: string) => asOlder(version, base, "r-old-remote")): Promise<Harness> {
	const h = harness();
	await h.store.open();
	seed(h);
	await h.saveNow();
	h.fs.files.set(DB_PATH, older(h.dbText()));
	h.events.length = 0;
	await h.store.handleExternalChange();
	return h;
}

describe("a file from an older schema arriving externally", () => {
	it("is migrated and announced, with no conflict, when memory holds nothing that schema cannot hold", async () => {
		const h = await arriving(2, (h) => h.addTask(makeTask("t0")));
		expect(h.events).toContainEqual({ type: "migrated", from: 2, to: CURRENT_SCHEMA_VERSION });
		expect(h.events.some((e) => e.type === "conflict")).toBe(false);
		expect(h.store.data.meta.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
		expect(h.store.readOnlyState).toBeNull();
	});

	it.each<[version: 2 | 3 | 4 | 5, held: string, seed: (h: Harness) => void, inCopy: string | null, after: (h: Harness) => void, older?: (base: string) => string]>([
		[2, "a section", addSection, '"name":"Triage"', (h) => expect(h.store.data.sections.size).toBe(0)],
		[
			2,
			"a task with a sectionId",
			(h) => {
				addSection(h);
				h.addTask(makeTask("t1", { sectionId: section.id }));
			},
			null,
			() => undefined,
		],
		[3, "a repeating task", (h) => h.addTask(makeTask("t1", { recurrence: daily })), '"anchor":"2026-10-01"', (h) => expect(h.store.data.tasks.get("t1")?.recurrence).toBeNull()],
		[
			3,
			"an occurrence record",
			(h) => {
				h.addTask(makeTask("t1"));
				h.store.commit({ ...h.store.data, occurrenceRecords: new Map([["t1:2026-10-01", record]]) }, [{ c: "occurrenceRecords", id: "t1:2026-10-01", v: record }]);
			},
			null,
			() => undefined,
		],
		[
			4,
			"a sync link",
			(h) => h.store.commit({ ...h.store.data, syncLinks: new Map([["list:inbox", listLink]]) }, [{ c: "syncLinks", id: "list:inbox", v: listLink }]),
			'"ttId":"inbox118000001"',
			(h) => {
				expect(h.store.data.syncLinks.size).toBe(0);
				expect(h.store.readOnlyState).toBeNull();
			},
		],
		[5, "a yearly repeat (#12)", (h) => h.addTask(makeTask("y1", { title: "Renew passport", recurrence: yearly })), '"freq":"yearly"', (h) => expect(h.store.data.tasks.has("y1")).toBe(false)],
		[
			5,
			"a yearly repeat in the Trash (#12)",
			(h) => {
				const entry = { batchId: "b1", deletedAt: NOW, tasks: [makeTask("y2", { title: "Renew passport", recurrence: yearly })] };
				h.store.commit({ ...h.store.data, trash: new Map([["b1", entry]]) }, [{ c: "trash", id: "b1", v: entry }]);
			},
			'"freq":"yearly"',
			() => undefined,
			(base) => descendant(base, (d) => ({ ...d, trash: new Map() }), "r-old-remote").replace(/"schemaVersion":\d+/u, '"schemaVersion":5'),
		],
	])("a v%i file keeps a conflict copy first when memory holds %s", async (version, _held, seed, inCopy, after, older) => {
		const h = await arriving(version, seed, older);
		const conflict = h.events.find((e) => e.type === "conflict");
		if (conflict?.type !== "conflict") throw new Error("no conflict event");
		if (inCopy !== null) expect(h.fs.files.get(conflict.path)).toContain(inCopy);
		expect(h.events).toContainEqual({ type: "migrated", from: version, to: CURRENT_SCHEMA_VERSION });
		after(h);
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
