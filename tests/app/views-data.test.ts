import { describe, expect, it } from "vitest";
import { exportFileName, mergeCollections } from "../../src/app/DataService";
import { buildBoard, buildList, globalSearch, linkedNotes, searchNoteContent, sidebarCounts } from "../../src/app/views";
import { emptyFilter } from "../../src/domain/queries";
import { loadText } from "../../src/persistence/CpbaseStore";
import { serializeDb } from "../../src/persistence/serializer";
import { DB_PATH, descendant, emptyDbText, load, makeTask, withTask } from "../persistence/fixtures";
import { type AppHarness, appHarness, makeReadOnly } from "./harness";
import { CURRENT_SCHEMA_VERSION } from "../../src/persistence/schema";
import type { SyncLink } from "../../src/domain/types";
import { rule } from "../domain/recurrence-fixtures";
import { settle } from "../helpers";

describe("views, export and import", () => {
	// FakeClock starts at 2026-10-01T10:00Z; the display zone is Europe/Berlin.
	const TODAY = "2026-10-01";

	describe("views (VIEW-01..03, SUB-07)", () => {
		it("Today = overdue + today, including deadlines; Upcoming groups tomorrow through the next 14 days by date", async () => {
			const h = await appHarness();
			const t = h.app.tasks;
			await t.create({ title: "Overdue", scheduled: { kind: "date", date: "2026-09-29" } });
			await t.create({ title: "Due today", deadline: { kind: "date", date: TODAY } });
			await t.create({ title: "Tonight", scheduled: { kind: "datetime", local: "2026-10-01T21:00", tz: "Europe/Berlin" } });
			await t.create({ title: "Friday", scheduled: { kind: "date", date: "2026-10-02" } });
			await t.create({ title: "Far", scheduled: { kind: "date", date: "2026-10-20" } });
			await t.create({ title: "Undated" });
			const ctx = h.app.queryContext();
			expect(ctx.today).toBe(TODAY);
			const today = buildList(h.app.store.state, { kind: "today" }, ctx, emptyFilter(), "").groups;
			expect(today.map((g) => [g.label, g.tone, g.entries.map((e) => e.task.title)])).toEqual([
				["Overdue", "overdue", ["Overdue"]],
				["Today", "today", ["Due today", "Tonight"]],
			]);
			const upcoming = buildList(h.app.store.state, { kind: "upcoming" }, ctx, emptyFilter(), "").groups;
			// No today, no overdue.
			expect(upcoming.map((g) => g.date)).toEqual(["2026-10-02"]);
			expect(upcoming.map((g) => g.tone)).toEqual(["tomorrow"]);
			expect(sidebarCounts(h.app.store.state, ctx)).toMatchObject({ today: 3, upcoming: 1 });
		});

		it("Upcoming leaves out a task that is due by today (scheduled tomorrow, deadline today or past): Today owns it", async () => {
			const h = await appHarness();
			const t = h.app.tasks;
			await t.create({ title: "Deadline today", scheduled: { kind: "date", date: "2026-10-02" }, deadline: { kind: "date", date: TODAY } });
			await t.create({ title: "Deadline past", scheduled: { kind: "date", date: "2026-10-03" }, deadline: { kind: "date", date: "2026-09-28" } });
			await t.create({ title: "Deadline later", scheduled: { kind: "date", date: "2026-10-02" }, deadline: { kind: "date", date: "2026-10-09" } });
			const done = (await t.create({ title: "Done", scheduled: { kind: "date", date: "2026-10-02" }, deadline: { kind: "date", date: TODAY } })).task;
			await t.complete(done.id);
			const state = h.app.store.state;
			const ctx = h.app.queryContext();
			const titles = (v: "today" | "upcoming") => buildList(state, { kind: v }, ctx, emptyFilter(), "").groups.flatMap((g) => g.entries.map((e) => e.task.title));
			expect(titles("upcoming")).toEqual(["Deadline later"]);
			expect(titles("today").sort()).toEqual(["Deadline past", "Deadline today"]);
			expect(sidebarCounts(state, ctx)).toMatchObject({ today: 2, upcoming: 1 });
			expect(buildList(state, { kind: "upcoming" }, ctx, emptyFilter(), "").completed).toEqual([]);
			expect(buildList(state, { kind: "today" }, ctx, emptyFilter(), "").completed.map((e) => e.task.title)).toEqual(["Done"]);
		});

		it("#125: a held overdue task completed a moment ago stays in Overdue, in the list and on the board", async () => {
			const h = await appHarness();
			const t = h.app.tasks;
			const late = (await t.create({ title: "Late", scheduled: { kind: "date", date: "2026-09-29" } })).task;
			await t.create({ title: "Lunch", scheduled: { kind: "date", date: TODAY } });
			await t.complete(late.id);
			const state = h.app.store.state;
			const ctx = h.app.queryContext();
			const held = new Set([late.id]);
			const groups = buildList(state, { kind: "today" }, ctx, emptyFilter(), "", held).groups;
			expect(groups.map((g) => [g.key, g.entries.map((e) => e.task.title)])).toEqual([
				["overdue", ["Late"]],
				["today", ["Lunch"]],
			]);
			const columns = buildBoard(state, { kind: "today" }, ctx, emptyFilter(), "", held);
			expect(columns.map((c) => [c.id, c.cards.map((card) => card.entry.task.title)])).toEqual([
				["overdue", ["Late"]],
				["today", ["Lunch"]],
			]);
			// Once the hold ends it leaves the rows for the Completed group, and the Overdue column goes.
			expect(buildList(state, { kind: "today" }, ctx, emptyFilter(), "").groups.map((g) => g.key)).toEqual(["today"]);
			expect(buildBoard(state, { kind: "today" }, ctx, emptyFilter(), "").map((c) => c.id)).toEqual(["today"]);
		});

		it("SUB-07: a scheduled subtask shows on its own date with the parent's title", async () => {
			const h = await appHarness();
			const parent = (await h.app.tasks.create({ title: "Trip" })).task;
			await h.app.tasks.create({ title: "Book hotel", parentId: parent.id, scheduled: { kind: "date", date: TODAY } });
			const today = buildList(h.app.store.state, { kind: "today" }, h.app.queryContext(), emptyFilter(), "").groups;
			expect(today).toHaveLength(1);
			expect(today[0]).toMatchObject({ label: "Today", tone: "today" });
			expect(today[0]!.entries).toMatchObject([{ task: { title: "Book hotel" }, parentTitle: "Trip" }]);
			const inbox = buildList(h.app.store.state, { kind: "inbox" }, h.app.queryContext(), emptyFilter(), "").groups;
			expect(inbox[0]!.entries.map((e) => [e.task.title, e.depth])).toEqual([
				["Trip", 0],
				["Book hotel", 1],
			]);
		});

		it("Today keeps a completed subtask under its parent only when the parent is in the view", async () => {
			const h = await appHarness();
			const T = h.app.tasks;
			const inView = (await T.create({ title: "Shown parent", scheduled: { kind: "date", date: TODAY } })).task;
			const hidden = (await T.create({ title: "Hidden parent" })).task;
			const a = (await T.create({ title: "Sub A", parentId: inView.id, scheduled: { kind: "date", date: TODAY } })).task;
			const b = (await T.create({ title: "Sub B", parentId: hidden.id, scheduled: { kind: "date", date: TODAY } })).task;
			await T.complete(a.id);
			await T.complete(b.id);
			const ctx = h.app.queryContext();
			const state = h.app.store.state;
			const open = buildList(state, { kind: "today" }, ctx, emptyFilter(), "").groups.flatMap((g) => g.entries.map((e) => e.task.title));
			expect(open).toEqual(["Shown parent", "Sub A"]);
			expect(buildList(state, { kind: "today" }, ctx, emptyFilter(), "").completed.map((e) => e.task.title)).toEqual(["Sub B"]);
		});

		it("Upcoming does the same", async () => {
			const h = await appHarness();
			const T = h.app.tasks;
			const inView = (await T.create({ title: "Shown parent", scheduled: { kind: "date", date: "2026-10-02" } })).task;
			const hidden = (await T.create({ title: "Hidden parent" })).task;
			const a = (await T.create({ title: "Sub A", parentId: inView.id, scheduled: { kind: "date", date: "2026-10-02" } })).task;
			const b = (await T.create({ title: "Sub B", parentId: hidden.id, scheduled: { kind: "date", date: "2026-10-02" } })).task;
			await T.complete(a.id);
			await T.complete(b.id);
			const ctx = h.app.queryContext();
			const state = h.app.store.state;
			const open = buildList(state, { kind: "upcoming" }, ctx, emptyFilter(), "").groups.flatMap((g) => g.entries.map((e) => e.task.title));
			expect(open).toEqual(["Shown parent", "Sub A"]);
			expect(buildList(state, { kind: "upcoming" }, ctx, emptyFilter(), "").completed.map((e) => e.task.title)).toEqual(["Sub B"]);
		});

		it("Completed is newest first; completing removes the task from Today (AS-10, list part)", async () => {
			const h = await appHarness();
			const a = (await h.app.tasks.create({ title: "A", scheduled: { kind: "date", date: TODAY } })).task;
			const b = (await h.app.tasks.create({ title: "B" })).task;
			await h.app.tasks.complete(a.id);
			h.clock.advance(1000);
			await h.app.tasks.complete(b.id);
			const ctx = h.app.queryContext();
			expect(buildList(h.app.store.state, { kind: "today" }, ctx, emptyFilter(), "").groups).toEqual([]);
			const done = buildList(h.app.store.state, { kind: "completed" }, ctx, emptyFilter(), "").groups;
			expect(done[0]!.entries.map((e) => e.task.title)).toEqual(["B", "A"]);
		});

		it("the Completed group: Today holds a task completed today even when it was overdue, not one completed yesterday (spec §7)", async () => {
			const h = await appHarness();
			const T = h.app.tasks;
			const old = (await T.create({ title: "Old", scheduled: { kind: "date", date: "2026-09-20" } })).task;
			const fresh = (await T.create({ title: "Fresh", scheduled: { kind: "date", date: "2026-09-20" } })).task;
			await T.complete(old.id);
			h.clock.advance(24 * 3600 * 1000);
			await T.complete(fresh.id);
			const ctx = { ...h.app.queryContext(), today: "2026-10-02" };
			const s = h.app.store.state;
			expect(buildList(s, { kind: "today" }, ctx, emptyFilter(), "").completed.map((e) => e.task.title)).toEqual(["Fresh"]);
			// Open rows never include them, and the views without a group have none.
			expect(buildList(s, { kind: "today" }, ctx, emptyFilter(), "").groups).toEqual([]);
			expect(buildList(s, { kind: "completed" }, ctx, emptyFilter(), "").completed).toEqual([]);
			expect(buildList(s, { kind: "trash" }, ctx, emptyFilter(), "").completed).toEqual([]);
		});

		it("buildList keeps a completed subtask under its open parent and a held task in place", async () => {
			const h = await appHarness();
			const T = h.app.tasks;
			const parent = (await T.create({ title: "Trip" })).task;
			const sub = (await T.create({ title: "Book", parentId: parent.id })).task;
			const solo = (await T.create({ title: "Solo" })).task;
			await T.complete(sub.id);
			await T.complete(solo.id);
			const ctx = h.app.queryContext();
			const s = h.app.store.state;
			const titles = (held?: Set<string>) =>
				buildList(s, { kind: "inbox" }, ctx, emptyFilter(), "", held).groups[0]!.entries.map((e) => `${e.task.title}${e.depth === 1 ? " (sub)" : ""}`);
			expect(titles()).toEqual(["Trip", "Book (sub)"]);
			expect(titles(new Set([solo.id]))).toEqual(["Trip", "Book (sub)", "Solo"]);
			expect(buildList(s, { kind: "inbox" }, ctx, emptyFilter(), "").completed.map((e) => e.task.title)).toEqual(["Solo"]);
			expect(buildList(s, { kind: "inbox" }, ctx, emptyFilter(), "", new Set([solo.id])).completed).toEqual([]);
		});

		it("sort by date orders by key date, undated last, subtasks with their parent", async () => {
			const h = await appHarness();
			const T = h.app.tasks;
			await T.create({ title: "None" });
			await T.create({ title: "Late", scheduled: { kind: "date", date: "2026-10-09" } });
			const soon = (await T.create({ title: "Soon", deadline: { kind: "date", date: "2026-10-02" } })).task;
			await T.create({ title: "Soon child", parentId: soon.id });
			const rows = buildList(h.app.store.state, { kind: "inbox" }, h.app.queryContext(), { ...emptyFilter(), sort: "date" }, "").groups[0]!.entries;
			expect(rows.map((e) => e.task.title)).toEqual(["Soon", "Soon child", "Late", "None"]);
		});

		it("VIEW-02 / VIEW-03 / SRCH-02: search and filters combine with AND", async () => {
			const h = await appHarness();
			const study = await h.app.categories.create("Study");
			await h.app.tags.create("x");
			await h.app.tags.create("y");
			await h.app.tasks.create({ title: "Read Python book", categoryId: study.id, tagKeys: ["x"] });
			await h.app.tasks.create({ title: "read news", tagKeys: ["y"], urgent: true });
			await h.app.tasks.create({ title: "Write", notePath: "n.md" });
			const ctx = h.app.queryContext();
			const s = h.app.store.state;
			const titles = (f: ReturnType<typeof emptyFilter>, text = "") =>
				globalSearch(s, text || "e", ctx, f).tasks.map((e) => e.task.title).sort();
			expect(titles(emptyFilter(), "READ")).toEqual(["Read Python book", "read news"]);
			expect(titles({ ...emptyFilter(), categoryIds: [study.id] }, "read")).toEqual(["Read Python book"]);
			expect(titles({ ...emptyFilter(), tagKeys: ["x", "y"], tagMode: "any" }, "read")).toHaveLength(2);
			expect(titles({ ...emptyFilter(), tagKeys: ["x", "y"], tagMode: "all" }, "read")).toEqual([]);
			expect(titles({ ...emptyFilter(), hasNote: "yes" })).toEqual(["Write"]);
			expect(titles({ ...emptyFilter(), quadrants: ["urgent"] }, "read")).toEqual(["read news"]);
			expect(titles({ ...emptyFilter(), date: "none" }, "read")).toHaveLength(2);
			expect(globalSearch(s, "stud", ctx, emptyFilter()).categories.map((c) => c.name)).toEqual(["Study"]);
			const inView = buildList(s, { kind: "category", id: study.id }, ctx, emptyFilter(), "python").groups;
			expect(inView[0]!.entries).toHaveLength(1);
		});

		it("SRCH-01: note-content search reads notes without storing them", async () => {
			const h = await appHarness();
			h.notes.files.set("n.md", "Contains the Needle somewhere");
			const { task } = await h.app.tasks.create({ title: "Hay", notePath: "n.md" });
			const links = linkedNotes(h.app.store.state.tasks);
			expect([...links]).toEqual([["n.md", [task.id]]]);
			const ids = await searchNoteContent(links, "needle", h.notes);
			expect([...ids]).toEqual([task.id]);
			const res = globalSearch(h.app.store.state, "needle", h.app.queryContext(), emptyFilter(), ids);
			expect(res.tasks.map((e) => e.task.id)).toEqual([task.id]);
			await h.saveNow();
			expect(h.dbText()).not.toContain("Needle");
		});

		it("SRCH-01: linkedNotes keeps its result while the links are equal; an aborted search stops reading", async () => {
			const h = await appHarness();
			h.notes.files.set("n.md", "needle");
			h.notes.files.set("m.md", "needle");
			const a = (await h.app.tasks.create({ title: "A", notePath: "n.md" })).task;
			await h.app.tasks.create({ title: "B", notePath: "m.md" });
			const first = linkedNotes(h.app.store.state.tasks);
			await h.app.tasks.update(a.id, { title: "A2" });
			expect(linkedNotes(h.app.store.state.tasks, first)).toBe(first);
			await h.app.tasks.unlinkNote(a.id);
			const second = linkedNotes(h.app.store.state.tasks, first);
			expect(second).not.toBe(first);
			expect([...second.keys()]).toEqual(["m.md"]);
			h.notes.reads.length = 0;
			const stop = new AbortController();
			stop.abort();
			await searchNoteContent(first, "needle", h.notes, stop.signal);
			expect(h.notes.reads).toEqual([]);
		});
	});

	describe("export and import (EXP-01, EXP-03)", () => {
		it("EXP-01: re-importing the export into an empty database reproduces identical records", async () => {
			const source = await appHarness();
			const cat = await source.app.categories.create("Study", "📖");
			await source.app.tags.create("learning");
			const parent = (await source.app.tasks.create({ title: "P", categoryId: cat.id, tagKeys: ["learning"] })).task;
			await source.app.tasks.create({ title: "S", parentId: parent.id, deadline: { kind: "date", date: "2026-10-09" } });
			const gone = (await source.app.tasks.create({ title: "Gone" })).task;
			await source.app.tasks.delete(gone.id);
			const exported = source.app.data.exportJson();

			const target = await appHarness();
			const preview = target.app.data.previewImport(exported);
			if (!preview.ok) throw new Error(preview.message);
			expect(preview.preview.counts).toMatchObject({ categories: 2, tags: 1, tasks: 2, trash: 1 });
			await target.app.data.importReplace(preview.preview);
			for (const c of ["categories", "tags", "tasks", "trash"] as const) {
				// Compared by ID; Map order is irrelevant.
				expect(target.app.store.state[c]).toEqual(source.app.store.state[c]);
			}
			const backups = await target.fs.list("plugin/backups/db-1/snapshots");
			expect(backups.some((p) => p.includes("/pre-import-"))).toBe(true);
			expect(exportFileName(new Date("2026-10-01T10:00:00Z"))).toBe("logwell-backup-2026-10-01.json");
		});

		it("EXP-03: merge by ID keeps the newer modifiedAt and lists overwrites first", async () => {
			const h = await appHarness();
			const a = (await h.app.tasks.create({ title: "A" })).task;
			const b = (await h.app.tasks.create({ title: "B" })).task;
			const exported = h.app.data.exportJson();
			h.clock.advance(1000);
			await h.app.tasks.update(a.id, { title: "A local newer" });
			const backupNewer = exported.replace('"title":"B"', '"title":"B backup newer"').replace(
				new RegExp(`("id":"${b.id}".*?"modifiedAt":")[^"]+`),
				"$12030-01-01T00:00:00.000Z",
			);
			const preview = h.app.data.previewImport(backupNewer);
			if (!preview.ok) throw new Error(preview.message);
			expect(preview.preview.changes.map((o) => [o.kind, o.label])).toEqual([["overwrite", "B backup newer"]]);
			await h.app.data.importMerge(preview.preview);
			expect(h.app.store.state.tasks.get(a.id)?.title).toBe("A local newer");
			expect(h.app.store.state.tasks.get(b.id)?.title).toBe("B backup newer");
		});

		it("EXP-03: the merge preview lists every record that changes, including Trash moves", async () => {
			const h = await appHarness();
			const t = (await h.app.tasks.create({ title: "T" })).task;
			const u = (await h.app.tasks.create({ title: "U" })).task;
			const bothLive = h.app.data.exportJson();
			h.clock.advance(1000);
			const localTrash = await h.app.tasks.delete(t.id);

			// The backup comes from another copy: T edited after our delete, U deleted there.
			const other = await appHarness();
			const p0 = other.app.data.previewImport(bothLive);
			if (!p0.ok) throw new Error(p0.message);
			await other.app.data.importReplace(p0.preview);
			other.clock.advance(5000);
			await other.app.tasks.update(t.id, { title: "T edited" });
			const otherTrash = await other.app.tasks.delete(u.id);
			const backup = other.app.data.exportJson();

			const preview = h.app.data.previewImport(backup);
			if (!preview.ok) throw new Error(preview.message);
			const listed = preview.preview.changes.map((c) => `${c.kind} ${c.collection} ${c.id}`).sort();
			expect(listed).toEqual(
				[
					`add tasks ${t.id}`,
					`remove tasks ${u.id}`,
					`remove trash ${localTrash.batchId}`,
					`add trash ${otherTrash.batchId}`,
				].sort(),
			);
			expect(preview.preview.changes.find((c) => c.id === u.id)?.label).toBe("U (moved to Trash)");

			// The preview matches what the merge actually does.
			const before = h.app.store.state;
			await h.app.data.importMerge(preview.preview);
			const after = h.app.store.state;
			const actual: string[] = [];
			for (const c of ["tasks", "trash", "categories", "tags"] as const) {
				const a = before[c] as ReadonlyMap<string, unknown>;
				const b = after[c] as ReadonlyMap<string, unknown>;
				for (const id of new Set([...a.keys(), ...b.keys()])) {
					if (!a.has(id)) actual.push(`add ${c} ${id}`);
					else if (!b.has(id)) actual.push(`remove ${c} ${id}`);
					else if (JSON.stringify(a.get(id)) !== JSON.stringify(b.get(id))) actual.push(`overwrite ${c} ${id}`);
				}
			}
			expect(actual.sort()).toEqual(listed);
		});

		it("export is refused while the database is read-only", async () => {
			const h = await appHarness();
			await h.app.tasks.create({ title: "A" });
			await makeReadOnly(h);
			expect(() => h.app.data.exportJson()).toThrow(expect.objectContaining({ code: "ReadOnly" }));
		});

		it("refuses a backup from a newer schema", async () => {
			const h = await appHarness();
			const text = h.app.data.exportJson().replace(`"schemaVersion":${CURRENT_SCHEMA_VERSION}`, '"schemaVersion":7');
			const r = h.app.data.previewImport(text);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.message).toMatch(/Update the plugin/);
			expect(h.app.data.previewImport("not json").ok).toBe(false);
		});

		it("merge: a deletion newer than the last edit wins over the live copy", async () => {
			const h = await appHarness();
			const a = (await h.app.tasks.create({ title: "A" })).task;
			const before = loadText(h.app.data.exportJson(), "x");
			h.clock.advance(1000);
			await h.app.tasks.delete(a.id);
			if (before.kind !== "ok") throw new Error("load");
			const merged = mergeCollections(h.app.store.state, before.data, h.app.store.now());
			expect(merged.tasks.has(a.id)).toBe(false);
			expect(merged.trash.size).toBe(1);
		});
	});

	describe("import: the preview is what gets applied", () => {
		/** A backup with task Z in Trash, deleted at 11:00. */
		function backupWithTrashedZ(): string {
			const z = makeTask("z1", { title: "Zed", modifiedAt: "2026-10-01T09:00:00.000Z" });
			const data = load(emptyDbText());
			const trash = new Map(data.trash);
			trash.set("b1", { batchId: "b1", deletedAt: "2026-10-01T11:00:00.000Z", tasks: [z] });
			return serializeDb({ ...data, trash });
		}

		/** Another device's write with Z live (an older edit), silently reloaded. */
		async function remoteWriteWithZLive(h: AppHarness): Promise<void> {
			const z = makeTask("z1", { title: "Zed", modifiedAt: "2026-10-01T09:00:00.000Z" });
			h.fs.files.set(DB_PATH, descendant(h.dbText(), (d) => withTask(d, z).next, "r-remote00001"));
			await h.store.handleExternalChange();
			expect(h.app.store.state.tasks.has("z1")).toBe(true);
		}

		it("merge refuses when the database changed after the preview; a new preview lists the change", async () => {
			const h = await appHarness();
			const pv = h.app.data.previewImport(backupWithTrashedZ());
			if (!pv.ok) throw new Error(pv.message);
			expect(pv.preview.changes.map((c) => `${c.kind} ${c.collection} ${c.id}`)).toEqual(["add trash b1"]);

			await remoteWriteWithZLive(h);
			await expect(h.app.data.importMerge(pv.preview)).rejects.toMatchObject({
				code: "StalePreview",
				message: "The database changed since the preview. Review the import again.",
			});
			// Nothing was applied: Z is still live, no Trash entry was added.
			expect(h.app.store.state.tasks.has("z1")).toBe(true);
			expect(h.app.store.state.trash.size).toBe(0);

			const again = h.app.data.previewImport(backupWithTrashedZ());
			if (!again.ok) throw new Error(again.message);
			expect(again.preview.changes.find((c) => c.id === "z1")).toMatchObject({ kind: "remove", label: "Zed (moved to Trash)" });
			await h.app.data.importMerge(again.preview);
			expect(h.app.store.state.tasks.has("z1")).toBe(false);
		});

		it("replace refuses when a local command changed the database after the preview", async () => {
			const h = await appHarness();
			const pv = h.app.data.previewImport(backupWithTrashedZ());
			if (!pv.ok) throw new Error(pv.message);
			const { task } = await h.app.tasks.create({ title: "Made while the preview was open" });
			await expect(h.app.data.importReplace(pv.preview)).rejects.toMatchObject({ code: "StalePreview" });
			expect(h.app.store.state.tasks.has(task.id)).toBe(true);
		});

		it("a save between preview and confirm does not make the preview stale", async () => {
			const h = await appHarness();
			await h.app.tasks.create({ title: "Pending save" });
			const pv = h.app.data.previewImport(backupWithTrashedZ());
			if (!pv.ok) throw new Error(pv.message);
			await h.saveNow(); // new revision in meta, same records
			await h.app.data.importMerge(pv.preview);
			expect(h.app.store.state.trash.has("b1")).toBe(true);
		});
	});

	describe("import: TickTick sync links merge by ID (EXP-03)", () => {
		const link = (kind: SyncLink["kind"], logwellId: string, ttId: string, modifiedAt: string): SyncLink => ({
			kind,
			logwellId,
			ttId,
			ttProjectId: kind === "list" ? null : "p-1",
			etag: null,
			base: {},
			noteBySync: false,
			lastPulledAt: null,
			modifiedAt,
		});
		const OLD = "2026-10-05T08:00:00.000Z";
		const NEW = "2026-10-05T09:00:00.000Z";

		it("the newer modifiedAt wins either way, a backup-only link is added, and orphaned links survive the merge", async () => {
			const h = await appHarness();
			const a = (await h.app.tasks.create({ title: "A" })).task;
			const b = (await h.app.tasks.create({ title: "B" })).task;
			const exported = h.app.data.exportJson();
			// Local: task:A is older than the backup's, list:inbox newer; an orphan only here.
			await h.app.store.run("Local links", (tx) => {
				tx.put("syncLinks", link("task", a.id, "tt-a-local", OLD));
				tx.put("syncLinks", link("list", "inbox", "p-inbox-local", NEW));
				tx.put("syncLinks", link("task", "ghost-local", "tt-ghost-local", OLD));
			});
			// Backup: task:A newer, list:inbox older, task:B only here, and an orphan only here.
			const data = load(exported);
			const backupLinks = new Map<string, SyncLink>([
				[`task:${a.id}`, link("task", a.id, "tt-a-backup", NEW)],
				["list:inbox", link("list", "inbox", "p-inbox-backup", OLD)],
				[`task:${b.id}`, link("task", b.id, "tt-b-backup", OLD)],
				["task:ghost-backup", link("task", "ghost-backup", "tt-ghost-backup", OLD)],
			]);
			const backup = serializeDb({ ...data, syncLinks: backupLinks });

			const pv = h.app.data.previewImport(backup);
			if (!pv.ok) throw new Error(pv.message);
			const linkChanges = pv.preview.changes.filter((c) => c.collection === "syncLinks").map((c) => [c.kind, c.id]);
			expect(linkChanges).toEqual(
				expect.arrayContaining([
					["overwrite", `task:${a.id}`],
					["add", `task:${b.id}`],
					["add", "task:ghost-backup"],
				]),
			);
			expect(linkChanges).toHaveLength(3);
			await h.app.data.importMerge(pv.preview);

			const links = h.app.store.state.syncLinks;
			expect(links.get(`task:${a.id}`)?.ttId).toBe("tt-a-backup");
			expect(links.get("list:inbox")?.ttId).toBe("p-inbox-local");
			expect(links.get(`task:${b.id}`)?.ttId).toBe("tt-b-backup");
			expect(links.get("task:ghost-local")?.ttId).toBe("tt-ghost-local");
			expect(links.get("task:ghost-backup")?.ttId).toBe("tt-ghost-backup");
			expect(links.size).toBe(5);
			// Saved as merged.
			await h.saveNow();
			expect(load(h.dbText()).syncLinks.size).toBe(5);
		});
	});
});

// Known limitation: merge by ID compares records by their timestamp and never
// removes what only the other side lacks, so a removal is not carried by a merge. A task purged from Trash
// comes back from an older backup, and so does an occurrence record that Reopen removed. There are no
// tombstones; this test pins the behavior so a later change is deliberate.

describe("merge import and removed records", () => {
	it("an older backup brings back a purged task and a reopened occurrence", async () => {
		const h = await appHarness();
		h.clock.set("2026-10-05T10:00:00.000Z");
		const t = (await h.app.tasks.create({ title: "Gym", scheduled: { kind: "date", date: "2026-10-05" }, repeat: { rule: rule() } })).task;
		const gone = (await h.app.tasks.create({ title: "Gone" })).task;
		await h.app.tasks.complete(t.id);
		const backup = h.app.data.exportJson();

		await h.app.recurrence.reopen(t.id, "2026-10-05");
		await h.app.tasks.delete(gone.id);
		await h.app.tasks.emptyTrash();
		expect(h.app.store.state.occurrenceRecords.size).toBe(0);
		expect(h.app.store.state.tasks.has(gone.id)).toBe(false);

		const result = h.app.data.previewImport(backup);
		if (!result.ok) throw new Error(result.message);
		await h.app.data.importMerge(result.preview);
		expect(h.app.store.state.occurrenceRecords.has(`${t.id}:2026-10-05`)).toBe(true);
		expect(h.app.store.state.tasks.has(gone.id)).toBe(true);
	});
});

// The import check against a queued external change, and routing the
// Data section's restore and conflict actions through the command queue.

describe("N1: the import's stale-preview check runs where the replacement runs", () => {
	async function previewWithExternalChange(mode: "merge" | "replace") {
		const h = await appHarness();
		const backup = serializeDb(withTask(load(emptyDbText()), makeTask("imp")).next);
		const pv = h.app.data.previewImport(backup);
		if (!pv.ok) throw new Error(pv.message);
		// The modify event for another device's write is queued in the store just
		// before the user confirms.
		h.fs.files.set(DB_PATH, descendant(h.dbText(), (d) => withTask(d, makeTask("remote")).next, "r-remote000001"));
		const ext = h.store.handleExternalChange();
		const confirm = mode === "merge" ? h.app.data.importMerge(pv.preview) : h.app.data.importReplace(pv.preview);
		const [, outcome] = await Promise.allSettled([ext, confirm]);
		await settle();
		return { h, outcome };
	}

	for (const mode of ["merge", "replace"] as const) {
		it(`${mode}: refuses with StalePreview and keeps the external change`, async () => {
			const { h, outcome } = await previewWithExternalChange(mode);
			expect(outcome.status).toBe("rejected");
			expect((outcome as PromiseRejectedResult).reason).toMatchObject({ code: "StalePreview" });
			expect([...h.app.store.state.tasks.keys()]).toEqual(["remote"]);
			expect([...load(h.dbText()).tasks.keys()]).toEqual(["remote"]);
		});
	}

	it("a refused import writes no backup snapshot and leaves the store usable", async () => {
		const { h } = await previewWithExternalChange("merge");
		expect((await h.store.listSnapshots()).filter((s) => s.kind === "pre-import")).toHaveLength(0);
		await h.app.tasks.create({ title: "still works" });
		await h.store.flush();
		expect([...load(h.dbText()).tasks.values()].map((t) => t.title).sort()).toEqual(["Task remote", "still works"]);
	});
});

describe("Data section actions run on the command queue", () => {
	it("restoreSnapshot: a command issued right after runs on the restored state and is kept", async () => {
		const h = await appHarness();
		await h.app.tasks.create({ title: "old" });
		await h.store.flush();
		const [snap] = await h.store.listSnapshots();
		const changed: string[] = [];
		h.app.store.bus.on("changed", (e) => changed.push(e.label));
		const restore = h.app.store.restoreSnapshot(snap!.path);
		const create = h.app.tasks.create({ title: "after" });
		await Promise.all([restore, create]);
		await h.store.flush();
		expect([...load(h.dbText()).tasks.values()].map((t) => t.title)).toEqual(["after"]);
		expect(changed[0]).toBe("Reload");
	});

	it("restoreSnapshot clears the undo history", async () => {
		const h = await appHarness();
		await h.app.tasks.create({ title: "x" });
		await h.store.flush();
		const [snap] = await h.store.listSnapshots();
		expect(h.app.store.canUndo).toBe(true);
		await h.app.store.restoreSnapshot(snap!.path);
		expect(h.app.store.canUndo).toBe(false);
	});

	it("keepMine and keepTheirs resolve the conflict copy and notify status", async () => {
		const h = await appHarness();
		await h.app.tasks.create({ title: "mine" });
		h.fs.files.set(DB_PATH, descendant(emptyDbText(), (d) => withTask(d, makeTask("theirs")).next, "r-other0000001"));
		await h.store.handleExternalChange();
		const [c1] = await h.store.listConflicts();
		expect(c1).toBeDefined();
		let statuses = 0;
		h.app.store.bus.on("status", () => statuses++);
		await h.app.store.keepMine(c1!.path);
		expect([...h.app.store.state.tasks.values()].map((t) => t.title)).toEqual(["mine"]);
		expect(await h.store.listConflicts()).toHaveLength(0);
		expect(statuses).toBeGreaterThan(0);

		await h.app.tasks.create({ title: "more" });
		h.fs.files.set(DB_PATH, descendant(h.dbText(), (d) => withTask(d, makeTask("theirs2")).next, "r-other0000002"));
		await h.store.handleExternalChange();
		const [c2] = await h.store.listConflicts();
		await h.app.store.keepTheirs(c2!.path);
		expect(await h.store.listConflicts()).toHaveLength(0);
	});

	it("restoreRecovered writes the recovered state and notifies", async () => {
		const h = await appHarness();
		await h.app.tasks.create({ title: "kept" });
		await h.store.flush();
		h.fs.files.set(DB_PATH, "<<<<<<< HEAD\nbroken\n");
		await h.store.handleExternalChange();
		expect(h.app.store.readOnlyState?.reason).toBe("damaged");
		await h.app.store.restoreRecovered();
		expect(h.app.store.readOnlyState).toBeNull();
		expect([...load(h.dbText()).tasks.values()].map((t) => t.title)).toEqual(["kept"]);
	});
});
