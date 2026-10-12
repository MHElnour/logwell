import { describe, expect, it } from "vitest";
import { mergeCollections } from "../../src/app/DataService";
import { buildBoard, buildList } from "../../src/app/views";
import { isDomainError } from "../../src/domain/errors";
import { emptyFilter } from "../../src/domain/queries";
import { INBOX_ID } from "../../src/domain/types";
import { type AppHarness, appHarness, makeReadOnly } from "./harness";

describe("sections", () => {
	// SectionService, integrity rules, grouping, import and list creation.

	async function setup() {
		const h = await appHarness();
		const list = await h.app.categories.create("Work");
		const other = await h.app.categories.create("Home");
		const s1 = await h.app.sections.create(list.id, "Todo");
		const s2 = await h.app.sections.create(list.id, "Doing");
		return { h, list, other, s1, s2 };
	}

	const task = (h: AppHarness, id: string) => h.app.store.state.tasks.get(id)!;
	const rejects = async (p: Promise<unknown>, code?: string) => {
		const err = await p.then(
			() => null,
			(e: unknown) => e,
		);
		expect(isDomainError(err, code as never)).toBe(true);
	};

	describe("SectionService (D5)", () => {
		it("creates trimmed sections in order and lists them per list", async () => {
			const { h, list, other, s1, s2 } = await setup();
			const o = await h.app.sections.create(other.id, "  Todo  ");
			expect(o.name).toBe("Todo");
			expect(o.nameKey).toBe("todo");
			expect(h.app.sections.inList(list.id).map((s) => s.id)).toEqual([s1.id, s2.id]);
			expect(h.app.sections.inList(other.id).map((s) => s.id)).toEqual([o.id]);
			expect(h.app.sections.inList(INBOX_ID)).toEqual([]);
		});

		it("rejects empty and duplicate names (case-insensitive) on create and rename", async () => {
			const { h, list, s1, s2 } = await setup();
			await rejects(h.app.sections.create(list.id, "   "), "InvalidValue");
			await rejects(h.app.sections.create(list.id, "TODO"), "DuplicateName");
			await rejects(h.app.sections.rename(s2.id, " todo "), "DuplicateName");
			await rejects(h.app.sections.rename(s2.id, ""), "InvalidValue");
			await rejects(h.app.sections.create("missing", "X"), "NotFound");
			// Renaming to its own name in another case is fine.
			const r = await h.app.sections.rename(s1.id, "TODO");
			expect(r).toMatchObject({ name: "TODO", nameKey: "todo" });
			expect(h.app.store.undoLabel).toBe("Rename section");
		});

		it("deleting a section moves its tasks and subtasks to No section in one run, and undo restores both", async () => {
			const { h, list, s1 } = await setup();
			const p = (await h.app.tasks.create({ title: "P", categoryId: list.id, sectionId: s1.id })).task;
			const sub = (await h.app.tasks.create({ title: "S", parentId: p.id })).task;
			const moved = await h.app.sections.delete(s1.id);
			expect(moved).toBe(2);
			expect(h.app.store.state.sections.has(s1.id)).toBe(false);
			expect(task(h, p.id).sectionId).toBeNull();
			expect(task(h, sub.id).sectionId).toBeNull();
			expect(h.app.store.undoLabel).toBe("Delete section");
			await h.app.store.undo();
			expect(h.app.store.state.sections.get(s1.id)).toEqual(s1);
			expect(task(h, p.id).sectionId).toBe(s1.id);
			expect(task(h, sub.id).sectionId).toBe(s1.id);
		});

		it("place reorders with a key between the neighbours, one undo entry", async () => {
			const { h, list, s1, s2 } = await setup();
			const s3 = await h.app.sections.create(list.id, "Done");
			const before = h.app.store.state.sections.get(s1.id)!.sortKey;
			const r = await h.app.sections.place(s3.id, [s3.id, s1.id, s2.id]);
			expect(r.changed).toBe(true);
			expect(h.app.sections.inList(list.id).map((s) => s.name)).toEqual(["Done", "Todo", "Doing"]);
			expect(h.app.store.state.sections.get(s1.id)!.sortKey).toBe(before);
			expect(h.app.store.undoLabel).toBe("Move section");
			expect((await h.app.sections.place(s3.id, [s3.id, s1.id, s2.id])).changed).toBe(false);
			await h.app.store.undo();
			expect(h.app.sections.inList(list.id).map((s) => s.name)).toEqual(["Todo", "Doing", "Done"]);
		});

		it("place rebalances when the other keys are equal, and rejects bad orders", async () => {
			const { h, list, other, s1, s2 } = await setup();
			await h.app.store.run("setup", (tx) => {
				tx.put("sections", { ...tx.get("sections", s2.id)!, sortKey: s1.sortKey });
			}, { undoable: false });
			const s3 = await h.app.sections.create(list.id, "Done");
			await h.app.sections.place(s3.id, [s3.id, s1.id, s2.id]);
			const keys = [s3, s1, s2].map((s) => h.app.store.state.sections.get(s.id)!.sortKey);
			expect(keys[0]! < keys[1]! && keys[1]! < keys[2]!).toBe(true);
			const o = await h.app.sections.create(other.id, "Other");
			await rejects(h.app.sections.place(s1.id, [s1.id, o.id]), "InvalidValue");
			await rejects(h.app.sections.place(s1.id, [s2.id]), "InvalidValue");
			await rejects(h.app.sections.place(s1.id, [s1.id, s1.id]), "InvalidValue");
		});

		it("every mutation throws while the database is read-only", async () => {
			const { h, list, s1 } = await setup();
			await makeReadOnly(h);
			await rejects(h.app.sections.create(list.id, "X"), "ReadOnly");
			await rejects(h.app.sections.rename(s1.id, "X"), "ReadOnly");
			await rejects(h.app.sections.delete(s1.id), "ReadOnly");
			await rejects(h.app.sections.place(s1.id, [s1.id]), "ReadOnly");
		});
	});

	describe("D4 integrity", () => {
		it("a subtask is created with its parent's section", async () => {
			const { h, list, s1 } = await setup();
			const p = (await h.app.tasks.create({ title: "P", categoryId: list.id, sectionId: s1.id })).task;
			const sub = (await h.app.tasks.create({ title: "S", parentId: p.id, sectionId: null })).task;
			expect(sub.sectionId).toBe(s1.id);
			expect(sub.categoryId).toBe(list.id);
		});

		it("create rejects a section of another list", async () => {
			const { h, other, s1 } = await setup();
			await rejects(h.app.tasks.create({ title: "X", categoryId: other.id, sectionId: s1.id }), "InvalidValue");
			await rejects(h.app.tasks.create({ title: "X", sectionId: s1.id }), "InvalidValue");
			await rejects(h.app.tasks.create({ title: "X", categoryId: other.id, sectionId: "missing" }), "NotFound");
		});

		it("setParent gives the task its new parent's section; making it top-level keeps its section", async () => {
			const { h, list, s1, s2 } = await setup();
			const p = (await h.app.tasks.create({ title: "P", categoryId: list.id, sectionId: s1.id })).task;
			const t = (await h.app.tasks.create({ title: "T", categoryId: list.id, sectionId: s2.id })).task;
			expect((await h.app.tasks.setParent(t.id, p.id)).sectionId).toBe(s1.id);
			expect((await h.app.tasks.setParent(t.id, null)).sectionId).toBe(s1.id);
		});

		it("moving a parent between sections moves its subtasks in the same write (one undo)", async () => {
			const { h, list, s1, s2 } = await setup();
			const p = (await h.app.tasks.create({ title: "P", categoryId: list.id, sectionId: s1.id })).task;
			const sub = (await h.app.tasks.create({ title: "S", parentId: p.id })).task;
			await h.app.tasks.update(p.id, { sectionId: s2.id });
			expect(task(h, sub.id).sectionId).toBe(s2.id);
			await h.app.tasks.update(p.id, { sectionId: null });
			expect(task(h, sub.id).sectionId).toBeNull();
			await h.app.store.undo();
			expect(task(h, p.id).sectionId).toBe(s2.id);
			expect(task(h, sub.id).sectionId).toBe(s2.id);
		});

		it("a move to another list clears the section of the task and its subtasks", async () => {
			const { h, list, other, s1 } = await setup();
			const p = (await h.app.tasks.create({ title: "P", categoryId: list.id, sectionId: s1.id })).task;
			const sub = (await h.app.tasks.create({ title: "S", parentId: p.id })).task;
			await h.app.tasks.update(p.id, { categoryId: other.id });
			expect(task(h, p.id)).toMatchObject({ categoryId: other.id, sectionId: null });
			expect(task(h, sub.id)).toMatchObject({ categoryId: other.id, sectionId: null });
		});

		it("a move to another list with a section of that list in the same patch applies it", async () => {
			const { h, list, other, s1 } = await setup();
			const o = await h.app.sections.create(other.id, "Mine");
			const p = (await h.app.tasks.create({ title: "P", categoryId: list.id, sectionId: s1.id })).task;
			const sub = (await h.app.tasks.create({ title: "S", parentId: p.id })).task;
			await h.app.tasks.update(p.id, { categoryId: other.id, sectionId: o.id });
			expect(task(h, p.id).sectionId).toBe(o.id);
			expect(task(h, sub.id).sectionId).toBe(o.id);
		});

		it("update and place reject a section of another list or one set on a subtask", async () => {
			const { h, list, other, s1, s2 } = await setup();
			const o = await h.app.sections.create(other.id, "Mine");
			const p = (await h.app.tasks.create({ title: "P", categoryId: list.id })).task;
			const sub = (await h.app.tasks.create({ title: "S", parentId: p.id })).task;
			await rejects(h.app.tasks.update(p.id, { sectionId: o.id }), "InvalidValue");
			await rejects(h.app.tasks.place(p.id, [p.id], { sectionId: o.id }), "InvalidValue");
			await rejects(h.app.tasks.update(sub.id, { sectionId: s1.id }), "InvalidValue");
			await rejects(h.app.tasks.place(sub.id, [sub.id], { sectionId: s2.id }), "InvalidValue");
			await rejects(h.app.tasks.update(p.id, { sectionId: "missing" }), "NotFound");
			expect(task(h, p.id).sectionId).toBeNull();
			expect(task(h, sub.id).sectionId).toBeNull();
		});

		it("place with a sectionId moves a card to a section column and orders it, in one run", async () => {
			const { h, list, s1 } = await setup();
			const a = (await h.app.tasks.create({ title: "A", categoryId: list.id, sectionId: s1.id })).task;
			const b = (await h.app.tasks.create({ title: "B", categoryId: list.id, sectionId: s1.id })).task;
			const c = (await h.app.tasks.create({ title: "C", categoryId: list.id })).task;
			const r = await h.app.tasks.place(c.id, [a.id, c.id, b.id], { sectionId: s1.id });
			expect(r.changed).toBe(true);
			expect(task(h, c.id).sectionId).toBe(s1.id);
			const order = [a, b, c].map((t) => task(h, t.id)).sort((x, y) => (x.sortKey < y.sortKey ? -1 : 1)).map((t) => t.title);
			expect(order).toEqual(["A", "C", "B"]);
			expect(h.app.store.undoLabel).toBe("Move task");
			await h.app.store.undo();
			expect(task(h, c.id).sectionId).toBeNull();
		});

		it("deleting a list deletes its sections, clears the tasks' sections, and undo restores everything", async () => {
			const { h, list, s1, s2 } = await setup();
			const p = (await h.app.tasks.create({ title: "P", categoryId: list.id, sectionId: s1.id })).task;
			const sub = (await h.app.tasks.create({ title: "S", parentId: p.id })).task;
			await h.app.categories.delete(list.id);
			expect(h.app.store.state.sections.size).toBe(0);
			expect(task(h, p.id)).toMatchObject({ categoryId: INBOX_ID, sectionId: null });
			expect(task(h, sub.id)).toMatchObject({ categoryId: INBOX_ID, sectionId: null });
			await h.app.store.undo();
			expect([...h.app.store.state.sections.keys()].sort()).toEqual([s1.id, s2.id].sort());
			expect(task(h, p.id)).toMatchObject({ categoryId: list.id, sectionId: s1.id });
			expect(task(h, sub.id)).toMatchObject({ categoryId: list.id, sectionId: s1.id });
		});

		it("restoring a task whose section is gone sets sectionId to null; an existing section is kept", async () => {
			const { h, list, s1, s2 } = await setup();
			const a = (await h.app.tasks.create({ title: "A", categoryId: list.id, sectionId: s1.id })).task;
			const b = (await h.app.tasks.create({ title: "B", categoryId: list.id, sectionId: s2.id })).task;
			const sub = (await h.app.tasks.create({ title: "Sub", parentId: a.id })).task;
			const ea = await h.app.tasks.delete(a.id);
			const eb = await h.app.tasks.delete(b.id);
			await h.app.sections.delete(s1.id);
			await h.app.tasks.restore(ea.batchId);
			await h.app.tasks.restore(eb.batchId);
			expect(task(h, a.id).sectionId).toBeNull();
			expect(task(h, sub.id).sectionId).toBeNull();
			expect(task(h, b.id).sectionId).toBe(s2.id);
		});

		it("a trashed task whose section is deleted through SectionService.delete is restored with sectionId null", async () => {
			const { h, list, s1 } = await setup();
			const a = (await h.app.tasks.create({ title: "A", categoryId: list.id, sectionId: s1.id })).task;
			const e = await h.app.tasks.delete(a.id);
			// Delete only touches live tasks: the trashed record still names the section.
			expect(await h.app.sections.delete(s1.id)).toBe(0);
			expect(h.app.store.state.trash.get(e.batchId)?.tasks[0]?.sectionId).toBe(s1.id);
			await h.app.tasks.restore(e.batchId);
			expect(task(h, a.id).categoryId).toBe(list.id);
			expect(task(h, a.id).sectionId).toBeNull();
		});

		it("a subtask restored without its parent in Trash takes the live parent's section", async () => {
			const { h, list, s1, s2 } = await setup();
			const p = (await h.app.tasks.create({ title: "P", categoryId: list.id, sectionId: s1.id })).task;
			const sub = (await h.app.tasks.create({ title: "S", parentId: p.id })).task;
			const e = await h.app.tasks.delete(sub.id);
			await h.app.tasks.update(p.id, { sectionId: s2.id });
			await h.app.tasks.restore(e.batchId);
			expect(task(h, sub.id).sectionId).toBe(s2.id);
		});
	});

	describe("D7 grouping and D6 board", () => {
		it("an Inbox or list view returns No section first, then each section by sortKey, empty ones included", async () => {
			const { h, list, s1, s2 } = await setup();
			await h.app.tasks.create({ title: "Loose", categoryId: list.id });
			const a = (await h.app.tasks.create({ title: "In doing", categoryId: list.id, sectionId: s2.id })).task;
			await h.app.tasks.create({ title: "Its sub", parentId: a.id });
			await h.app.tasks.create({ title: "Inbox task" });
			const ctx = h.app.queryContext();
			const groups = buildList(h.app.store.state, { kind: "category", id: list.id }, ctx, emptyFilter(), "", undefined, { groupBy: "section" }).groups;
			expect(groups.map((g) => [g.section, g.entries.map((e) => e.task.title)])).toEqual([
				[{ id: null, name: "No section" }, ["Loose"]],
				[{ id: s1.id, name: "Todo" }, []],
				[{ id: s2.id, name: "Doing" }, ["In doing", "Its sub"]],
			]);
			const inbox = buildList(h.app.store.state, { kind: "inbox" }, ctx, emptyFilter(), "", undefined, { groupBy: "section" }).groups;
			expect(inbox.map((g) => [g.section, g.entries.length])).toEqual([[{ id: null, name: "No section" }, 1]]);
			// Other views are untouched.
			expect(buildList(h.app.store.state, { kind: "today" }, ctx, emptyFilter(), "").groups.every((g) => g.section === undefined)).toBe(true);
		});

		it("the board has a No section column, then a column per section, each with its own completed group", async () => {
			const { h, list, s1, s2 } = await setup();
			const a = (await h.app.tasks.create({ title: "A", categoryId: list.id, sectionId: s1.id })).task;
			await h.app.tasks.create({ title: "A sub", parentId: a.id });
			const d = (await h.app.tasks.create({ title: "Done one", categoryId: list.id, sectionId: s2.id })).task;
			await h.app.tasks.complete(d.id);
			const ctx = h.app.queryContext();
			const cols = buildBoard(h.app.store.state, { kind: "category", id: list.id }, ctx, emptyFilter(), "");
			expect(cols.map((c) => [c.id, c.title, c.sectionId, c.acceptsDrop])).toEqual([
				["none", "No section", null, true],
				[s1.id, "Todo", s1.id, true],
				[s2.id, "Doing", s2.id, true],
			]);
			expect(cols[1]!.cards.map((c) => [c.entry.task.title, c.subtasks.map((s) => s.task.title)])).toEqual([["A", ["A sub"]]]);
			expect(cols.map((c) => c.completed.map((e) => e.task.title))).toEqual([[], [], ["Done one"]]);
			const inbox = buildBoard(h.app.store.state, { kind: "inbox" }, ctx, emptyFilter(), "");
			expect(inbox.map((c) => c.id)).toEqual(["none"]);
			expect(inbox[0]!.sectionId).toBeNull();
		});
	});

	describe("D8 export and import", () => {
		it("Replace all reproduces the sections and the task section ids", async () => {
			const { h, list, s1 } = await setup();
			await h.app.tasks.create({ title: "T", categoryId: list.id, sectionId: s1.id });
			const exported = h.app.data.exportJson();
			const target = await appHarness();
			const preview = target.app.data.previewImport(exported);
			if (!preview.ok) throw new Error(preview.message);
			expect(preview.preview.counts.sections).toBe(2);
			await target.app.data.importReplace(preview.preview);
			expect(target.app.store.state.sections).toEqual(h.app.store.state.sections);
			expect(target.app.store.state.tasks).toEqual(h.app.store.state.tasks);
		});

		it("a merge import adds sections by id and keeps valid section ids", async () => {
			const { h, list, s1 } = await setup();
			const t = (await h.app.tasks.create({ title: "T", categoryId: list.id, sectionId: s1.id })).task;
			const exported = h.app.data.exportJson();
			const target = await appHarness();
			const preview = target.app.data.previewImport(exported);
			if (!preview.ok) throw new Error(preview.message);
			expect(preview.preview.changes.filter((c) => c.collection === "sections" && c.kind === "add")).toHaveLength(2);
			await target.app.data.importMerge(preview.preview);
			expect(target.app.store.state.sections.size).toBe(2);
			expect(target.app.store.state.tasks.get(t.id)!.sectionId).toBe(s1.id);
		});

		it("a merge clears a sectionId that names a missing section or a section of another list, and aligns subtasks", async () => {
			const { h, list, other, s1 } = await setup();
			const foreign = await h.app.sections.create(other.id, "Foreign");
			const p = (await h.app.tasks.create({ title: "P", categoryId: list.id, sectionId: s1.id })).task;
			const sub = (await h.app.tasks.create({ title: "S", parentId: p.id })).task;
			const cur = h.app.store.state;
			const bad = (id: string, sectionId: string | null) => ({ ...cur.tasks.get(id)!, sectionId, modifiedAt: "2099-01-01T00:00:00.000Z" });
			const incoming = {
				...cur,
				tasks: new Map([
					[p.id, bad(p.id, foreign.id)],
					[sub.id, bad(sub.id, "missing")],
				]),
			};
			const merged = mergeCollections(cur, incoming, "2099-01-02T00:00:00.000Z");
			expect(merged.tasks.get(p.id)!.sectionId).toBeNull();
			expect(merged.tasks.get(sub.id)!.sectionId).toBeNull();
			expect(merged.sections.size).toBe(3);
		});
	});

	describe("D9 CategoryService.create", () => {
		it("keeps the palette rule without a color, and an explicit color or null otherwise, in one run", async () => {
			const h = await appHarness();
			const first = await h.app.categories.create("One");
			expect(first.color).toBe("red");
			const withIcon = await h.app.categories.create("Two", "book", "blue");
			expect(withIcon).toMatchObject({ icon: "book", color: "blue" });
			const none = await h.app.categories.create("Three", null, null);
			expect(none.color).toBeNull();
			expect(h.app.store.undoLabel).toBe("Create category");
			await h.app.store.undo();
			expect(h.app.store.state.categories.has(none.id)).toBe(false);
			await rejects(h.app.categories.create("Bad", null, "mauve" as never), "InvalidValue");
		});
	});
});

describe("categories (CAT-01..07)", () => {
	it("CAT-01 / B15: Inbox cannot be deleted but can be renamed", async () => {
		const h = await appHarness();
		await expect(h.app.categories.delete(INBOX_ID)).rejects.toMatchObject({ code: "InboxProtected" });
		await h.app.categories.update(INBOX_ID, { name: "Capture" });
		expect(h.app.store.state.categories.get(INBOX_ID)?.name).toBe("Capture");
	});

	it("CAT-03: names are unique case-insensitively", async () => {
		const h = await appHarness();
		await h.app.categories.create("Study");
		await expect(h.app.categories.create("study")).rejects.toMatchObject({ code: "DuplicateCategoryName" });
		await expect(h.app.categories.create("  ")).rejects.toMatchObject({ code: "CategoryNameRequired" });
	});

	it("CAT-05: rename keeps the ID and the membership", async () => {
		const h = await appHarness();
		const cat = await h.app.categories.create("Study", "📖");
		const { task } = await h.app.tasks.create({ title: "x", categoryId: cat.id });
		await h.app.categories.update(cat.id, { name: "Learning" });
		expect(h.app.store.state.tasks.get(task.id)?.categoryId).toBe(cat.id);
		expect(h.app.store.state.categories.get(cat.id)?.name).toBe("Learning");
	});

	it("CAT-06 / B14: delete moves the tasks to Inbox; undo restores the category and memberships", async () => {
		const h = await appHarness();
		const cat = await h.app.categories.create("Study");
		const t1 = (await h.app.tasks.create({ title: "1", categoryId: cat.id })).task;
		const t2 = (await h.app.tasks.create({ title: "2", categoryId: cat.id })).task;
		await h.app.tasks.complete(t2.id);
		expect(h.app.categories.taskCount(cat.id)).toBe(2);
		expect(await h.app.categories.delete(cat.id)).toBe(2);
		expect(h.app.store.state.tasks.get(t1.id)?.categoryId).toBe(INBOX_ID);
		await h.app.store.undo();
		expect(h.app.store.state.categories.get(cat.id)?.name).toBe("Study");
		expect(h.app.store.state.tasks.get(t1.id)?.categoryId).toBe(cat.id);
		expect(h.app.store.state.tasks.get(t2.id)?.categoryId).toBe(cat.id);
	});

	it("reorders categories", async () => {
		const h = await appHarness();
		const a = await h.app.categories.create("A");
		const b = await h.app.categories.create("B");
		await h.app.categories.move(b.id, -1);
		expect(h.app.categories.list().map((c) => c.name)).toEqual(["Inbox", "B", "A"]);
		await h.app.categories.move(b.id, -1);
		expect(h.app.categories.list().map((c) => c.name)).toEqual(["B", "Inbox", "A"]);
		expect(a.id).toBeDefined();
	});
});
