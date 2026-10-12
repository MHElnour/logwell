import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SyncLink } from "../../src/domain/types";
import { loadText } from "../../src/persistence/CpbaseStore";
import { applyOps, replayJournal } from "../../src/persistence/journal";
import { createEmptyDb, recordId } from "../../src/persistence/schema";
import { serializeDb } from "../../src/persistence/serializer";
import { CollectionError, readRecord } from "../../src/persistence/validate";
import { emptyDbText, harness, load, makeTask } from "./fixtures";

describe("sync links", () => {
	// The `syncLinks` collection (schema v5). Typed and strictly validated; orphans are kept.

	const V5 = readFileSync(join(import.meta.dirname, "..", "fixtures", "schema-v5.cpbase"), "utf8");
	const NOW = "2026-10-07T10:00:00.000Z";

	function link(kind: SyncLink["kind"], logwellId: string, patch: Partial<SyncLink> = {}): SyncLink {
		return {
			kind,
			logwellId,
			ttId: `tt-${logwellId}`,
			ttProjectId: kind === "list" ? null : "p-1",
			etag: null,
			base: {},
			noteBySync: false,
			lastPulledAt: null,
			modifiedAt: "2026-10-07T09:00:00.000Z",
			...patch,
		};
	}

	/** The empty v5 database text with these raw link records. */
	function withLinks(records: unknown[], text = emptyDbText()): string {
		const raw = JSON.parse(text) as Record<string, unknown>;
		return JSON.stringify({ ...raw, syncLinks: records });
	}

	describe("syncLinks records (SYNC-11)", () => {
		it("are keyed kind:logwellId", () => {
			expect(recordId("syncLinks", link("task", "t1"))).toBe("task:t1");
			expect(recordId("syncLinks", link("list", "inbox"))).toBe("list:inbox");
			expect(recordId("syncLinks", link("section", "s1"))).toBe("section:s1");
		});

		it("leave their defaults out on write and get them back on read", () => {
			const base = load(emptyDbText());
			const l = link("list", "inbox");
			const text = serializeDb({ ...base, syncLinks: new Map([["list:inbox", l]]) });
			expect(text).toContain('"syncLinks":[\n{"kind":"list","logwellId":"inbox","ttId":"tt-inbox","modifiedAt":"2026-10-07T09:00:00.000Z"}\n]');
			const back = load(text).syncLinks.get("list:inbox");
			expect(back).toEqual(l);
		});

		it("give each record its own default base object", () => {
			const r = loadText(V5, NOW);
			if (r.kind !== "ok") throw new Error(JSON.stringify(r));
			const list = r.data.syncLinks.get("list:inbox")!;
			const section = r.data.syncLinks.get("section:b2c3d4e5-0003-4b00-8000-00000000b003")!;
			expect(list.base).toEqual({});
			expect(list.base).not.toBe(section.base);
		});

		it("keep unknown fields and a full record round-trips", () => {
			const full = { ...link("task", "t1"), etag: "e1", base: { title: "ab12", date: "cd34" }, noteBySync: true, laterField: 7 };
			const text = withLinks([full]);
			const withTask = (t: string) => {
				const raw = JSON.parse(t) as Record<string, unknown>;
				return JSON.stringify({ ...raw, tasks: [makeTask("t1")] });
			};
			const r = loadText(withTask(text), NOW);
			if (r.kind !== "ok") throw new Error(JSON.stringify(r));
			expect(r.issues).toEqual([]);
			expect(r.data.syncLinks.get("task:t1")).toEqual(full);
			const again = serializeDb(r.data);
			expect(again).toContain('"base":{"date":"cd34","title":"ab12"},"noteBySync":true,"modifiedAt":"2026-10-07T09:00:00.000Z","laterField":7}');
		});

		it("keep a sync-created note's base text and item lines, after noteBySync, and leave them out when absent (SYNC-09)", () => {
			const withNote = { ...link("task", "t1"), noteBySync: true, noteBase: "Trip", noteItems: ["- [ ] Bring passport"] };
			const text = withLinks([withNote, link("task", "t2")]);
			const raw = JSON.parse(text) as Record<string, unknown>;
			const r = loadText(JSON.stringify({ ...raw, tasks: [makeTask("t1"), makeTask("t2")] }), NOW);
			if (r.kind !== "ok") throw new Error(JSON.stringify(r));
			expect(r.data.syncLinks.get("task:t1")).toEqual(withNote);
			expect(r.data.syncLinks.get("task:t2")).toEqual(link("task", "t2"));
			expect("noteBase" in r.data.syncLinks.get("task:t2")!).toBe(false);
			const again = serializeDb(r.data);
			expect(again).toContain('"noteBySync":true,"noteBase":"Trip","noteItems":["- [ ] Bring passport"],"modifiedAt"');
			expect(again).toContain('{"kind":"task","logwellId":"t2","ttId":"tt-t2","ttProjectId":"p-1","modifiedAt":"2026-10-07T09:00:00.000Z"}');
		});

		it.each([
			["an unknown kind", { kind: "project" }],
			["a missing logwellId", { logwellId: "" }],
			["a ttId that is not a string", { ttId: 42 }],
			["an empty ttId", { ttId: "" }],
			["a ttProjectId that is not a string", { ttProjectId: 3 }],
			["an etag that is not a string", { etag: false }],
			["a base that is a list", { base: ["a"] }],
			["a base with a non-string value", { base: { title: 1 } }],
			["a noteBySync that is not a boolean", { noteBySync: "yes" }],
			["a lastPulledAt that is not a string", { lastPulledAt: 5 }],
			["a noteBase that is not a string", { noteBase: 3 }],
			["a noteItems that is not a list", { noteItems: "- [ ] a" }],
			["a noteItems with a non-string line", { noteItems: ["- [ ] a", 2] }],
			["a missing modifiedAt", { modifiedAt: undefined }],
		])("a damaged record (%s) fails the load as a CollectionError", (_what, patch) => {
			const text = withLinks([{ ...link("list", "inbox"), ...patch }]);
			const r = loadText(text, NOW);
			expect(r.kind).toBe("failed");
			if (r.kind === "failed") {
				expect(r.failure).toBe("invalid");
				expect(r.detail).toMatch(/^syncLinks/u);
			}
			expect(() => readRecord("syncLinks", { ...link("list", "inbox"), ...patch }, "list:inbox")).toThrow(CollectionError);
		});

		it("a record that is not an object fails the load", () => {
			expect(loadText(withLinks(["task:t1"]), NOW).kind).toBe("failed");
		});

		it("a duplicate link fails the load", () => {
			const r = loadText(withLinks([link("list", "inbox"), link("list", "inbox", { ttId: "other" })]), NOW);
			expect(r.kind).toBe("failed");
			if (r.kind === "failed") expect(r.detail).toContain("duplicate ID");
		});
	});

	describe("orphaned syncLinks (kept, issue #6)", () => {
		// File sync can deliver a link before its task; dropping it would make the next sync import the task again.
		it("keeps a task link whose task is neither live nor in the Trash, with no issue", () => {
			const r = loadText(withLinks([link("task", "gone")]), NOW);
			if (r.kind !== "ok") throw new Error(JSON.stringify(r));
			expect(r.issues).toEqual([]);
			expect(r.data.syncLinks.get("task:gone")).toEqual(link("task", "gone"));
		});

		it("keeps a list link whose list is missing and a section link whose section is missing, with no issue", () => {
			const r = loadText(withLinks([link("list", "no-list"), link("section", "no-section")]), NOW);
			if (r.kind !== "ok") throw new Error(JSON.stringify(r));
			expect(r.issues).toEqual([]);
			expect([...r.data.syncLinks.keys()]).toEqual(["list:no-list", "section:no-section"]);
		});

		it("keeps a section link whose section was removed by repair (its list was missing), and reports only the section", () => {
			const raw = JSON.parse(withLinks([link("section", "s1")])) as Record<string, unknown>;
			const section = { id: "s1", categoryId: "no-list", name: "Week 1", nameKey: "week 1", sortKey: "V", createdAt: NOW, modifiedAt: NOW };
			const r = loadText(JSON.stringify({ ...raw, sections: [section] }), NOW);
			if (r.kind !== "ok") throw new Error(JSON.stringify(r));
			expect(r.data.sections.size).toBe(0);
			expect(r.data.syncLinks.has("section:s1")).toBe(true);
			expect(r.issues).toEqual([`Section "Week 1" pointed to a missing list and was removed.`]);
		});

		it("a file holding only orphaned links opens without a repair: no event, no snapshot, no rewrite", async () => {
			const text = serializeDb({
				...load(emptyDbText()),
				syncLinks: new Map([
					["task:gone", link("task", "gone")],
					["list:no-list", link("list", "no-list")],
					["section:no-section", link("section", "no-section")],
				]),
			});
			const h = harness(text);
			await h.store.open();
			expect(h.events.some((e) => e.type === "repaired")).toBe(false);
			await h.store.flush();
			expect(h.dbText()).toBe(text);
			expect(h.store.data.syncLinks.size).toBe(3);
			const snapshots = await h.fs.list("plugin/backups/db-1/snapshots");
			expect(snapshots.filter((p) => p.includes("/pre-repair-"))).toEqual([]);
		});

		it("keeps links to a live task, a trashed task, an existing list and an existing section", () => {
			const r = loadText(V5, NOW);
			if (r.kind !== "ok") throw new Error(JSON.stringify(r));
			expect(r.issues).toEqual([]);
			expect([...r.data.syncLinks.keys()]).toEqual([
				"list:inbox",
				"section:b2c3d4e5-0003-4b00-8000-00000000b003",
				"task:0b9f6c1e-6a52-4c39-9a7c-5f2f0f4f8a11",
				"task:3e2c9f41-9d85-4f6c-ad0f-8c5c3c7dbd44",
			]);
		});
	});

	describe("syncLinks in the journal", () => {
		it("an op is validated and replayed", () => {
			const data = load(emptyDbText());
			const l = link("list", "inbox", { etag: "e1" });
			const next = applyOps(data, [{ c: "syncLinks", id: "list:inbox", v: l }]);
			expect(next.syncLinks.get("list:inbox")).toEqual(l);
			const removed = applyOps(next, [{ c: "syncLinks", id: "list:inbox", v: null }]);
			expect(removed.syncLinks.size).toBe(0);
			const replayed = replayJournal(
				data,
				[{ rev: "r-1", base: data.meta.revision, at: NOW, ops: [{ c: "syncLinks", id: "list:inbox", v: l }] }],
				data.meta.revision,
			);
			expect(replayed.revision).toBe("r-1");
			expect(replayed.data.syncLinks.get("list:inbox")).toEqual(l);
		});

		it("a damaged op fails like a damaged file record", () => {
			const data = load(emptyDbText());
			expect(() => applyOps(data, [{ c: "syncLinks", id: "list:inbox", v: { ...link("list", "inbox"), kind: "folder" } }])).toThrow(
				CollectionError,
			);
		});

		it("a committed link is saved and survives a reopen", async () => {
			const h = harness();
			await h.store.open();
			const l = link("list", "inbox", { lastPulledAt: NOW });
			h.store.commit({ ...h.store.data, syncLinks: new Map([["list:inbox", l]]) }, [{ c: "syncLinks", id: "list:inbox", v: l }]);
			await h.saveNow();
			expect(load(h.dbText()).syncLinks.get("list:inbox")).toEqual(l);
		});
	});
});

describe("sync link flags", () => {
	// `pendingDelete` and `mode` on a sync link. Optional, left out on write when false or "sync", so a file
	// without them (the frozen v5 fixture) reads and writes back unchanged; no schema bump.

	const link = (patch: Partial<SyncLink>): SyncLink => ({
		kind: "task",
		logwellId: "t1",
		ttId: "tt1",
		ttProjectId: "p1",
		etag: "e1",
		base: { title: "abcd1234" },
		noteBySync: false,
		lastPulledAt: null,
		modifiedAt: "2026-10-01T10:00:00.000Z",
		...patch,
	});

	function text(l: SyncLink): string {
		const db = createEmptyDb({ dbId: "db-1", revision: "r-000000000000", deviceId: "d-1", now: "2026-10-01T10:00:00.000Z" });
		return serializeDb({ ...db, syncLinks: new Map([["task:t1", l]]) });
	}

	describe("sync link flags (issue #6)", () => {
		it("omits false and the default mode, and reads them back unset, exactly as a link without them", () => {
			const t = text(link({ pendingDelete: false, mode: "sync" }));
			expect(t).not.toContain("pendingDelete");
			expect(t).not.toContain('"mode"');
			expect(load(t).syncLinks.get("task:t1")).toEqual(link({}));
		});

		it("writes pendingDelete and the mode before modifiedAt and reads them back", () => {
			const t = text(link({ pendingDelete: true, mode: "excluded" }));
			expect(t).toContain('"pendingDelete":true,"mode":"excluded","modifiedAt"');
			expect(load(t).syncLinks.get("task:t1")).toMatchObject({ pendingDelete: true, mode: "excluded" });
			expect(serializeDb(load(t))).toBe(t);
		});

		it("round-trips the localOnly mode", () => {
			const t = text(link({ mode: "localOnly" }));
			expect(t).toContain('"mode":"localOnly","modifiedAt"');
			expect(load(t).syncLinks.get("task:t1")).toEqual(link({ mode: "localOnly" }));
			expect(serializeDb(load(t))).toBe(t);
		});

		it("refuses a pendingDelete that is not a boolean", () => {
			const t = text(link({ pendingDelete: true })).replace('"pendingDelete":true', '"pendingDelete":"yes"');
			expect(() => load(t)).toThrow();
		});

		it("refuses an unknown mode or one that is not a string", () => {
			const t = text(link({ mode: "excluded" }));
			expect(() => load(t.replace('"mode":"excluded"', '"mode":"paused"'))).toThrow();
			expect(() => load(t.replace('"mode":"excluded"', '"mode":true'))).toThrow();
			expect(() => load(t.replace('"mode":"excluded"', '"mode":null'))).toThrow();
		});
	});
});
