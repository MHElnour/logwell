import { describe, expect, it } from "vitest";
import { EDIT_TAG_LABEL } from "../../src/app/CategoryService";
import { TAG_FLAT_PARENT_MESSAGE, TAG_REPEAT_MESSAGE } from "../../src/domain/tags";
import type { Tag, Task } from "../../src/domain/types";
import { type AppHarness, appHarness } from "./harness";

// Edit a tag (Lists, sections and tags rule 24): rename, move under a top-level tag or to the top, and recolor in one
// write with one Undo. Every record holding a moving key moves in that write: the tag and its children, live tasks
// and trashed tasks.

const JAN = "2026-01-01T00:00:00.000Z";

async function seeded(): Promise<AppHarness & { ids: Record<string, string> }> {
	const h = await appHarness();
	await h.app.store.run("Seed", (tx) => {
		const put = (key: string, displayName: string, color: Tag["color"] = null) => tx.put("tags", { key, displayName, color, createdAt: JAN, modifiedAt: JAN });
		put("home", "Home", "red");
		put("home/calls", "Home/Calls", "blue");
		put("home/garden", "Home/Garden");
		put("errands", "Errands");
		put("work/desk", "Work/Desk");
	});
	const ids: Record<string, string> = {};
	for (const [title, tagKeys] of [
		["Ring mum", ["home/calls", "errands"]],
		["Weed", ["home/garden"]],
		["Tidy", ["home"]],
		["Shop", ["errands"]],
		["Old call", ["home/calls"]],
	] as const) {
		ids[title] = (await h.app.tasks.create({ title, tagKeys: [...tagKeys] })).task.id;
	}
	await h.app.tasks.delete(ids["Old call"]!);
	h.clock.advance(60_000);
	return Object.assign(h, { ids });
}

const task = (h: AppHarness, id: string): Task => h.app.store.state.tasks.get(id)!;
const trashed = (h: AppHarness): Task[] => [...h.app.store.state.trash.values()].flatMap((e) => e.tasks);
const snapshot = (h: AppHarness) => {
	const s = h.app.store.state;
	return { tags: new Map(s.tags), tasks: new Map(s.tasks), trash: new Map(s.trash) };
};

describe("TagService.edit: rename", () => {
	it("renames a leaf: the record moves with createdAt kept, live and trashed tasks follow, one Undo restores all", async () => {
		const h = await seeded();
		const before = snapshot(h);
		const trashedBefore = trashed(h).find((t) => t.title === "Old call")!;
		const r = await h.app.tags.edit("home/calls", { name: "Phone", parentKey: "home", color: "blue" });
		expect(r).toEqual({ wrote: true, label: EDIT_TAG_LABEL, key: "home/phone" });
		expect(EDIT_TAG_LABEL).toBe("Edit tag");
		const tags = h.app.store.state.tags;
		expect(tags.has("home/calls")).toBe(false);
		expect(tags.get("home/phone")).toMatchObject({ key: "home/phone", displayName: "Home/Phone", color: "blue", createdAt: JAN });
		expect(tags.get("home/phone")!.modifiedAt).not.toBe(JAN);
		const ring = task(h, h.ids["Ring mum"]!);
		expect(ring.tagKeys).toEqual(["home/phone", "errands"]);
		expect(ring.modifiedAt).not.toBe(before.tasks.get(ring.id)!.modifiedAt);
		// Untouched tasks keep their records.
		expect(task(h, h.ids["Weed"]!)).toBe(before.tasks.get(h.ids["Weed"]!));
		// A trashed task gets the new key and keeps its modifiedAt.
		const old = trashed(h).find((t) => t.title === "Old call")!;
		expect(old.tagKeys).toEqual(["home/phone"]);
		expect(old.modifiedAt).toBe(trashedBefore.modifiedAt);

		expect(await h.app.store.undo()).toBe(EDIT_TAG_LABEL);
		expect(snapshot(h)).toEqual(before);
		expect(h.app.store.canUndo).toBe(true); // the seed writes are still there; the edit was one entry
		expect(h.app.store.undoLabel).not.toBe(EDIT_TAG_LABEL);
	});

	it("renaming a parent renames its children's paths and their tasks", async () => {
		const h = await seeded();
		const r = await h.app.tags.edit("home", { name: "House", parentKey: null, color: "red" });
		expect(r.key).toBe("house");
		const tags = h.app.store.state.tags;
		expect([...tags.keys()].filter((k) => k.startsWith("ho")).sort()).toEqual(["house", "house/calls", "house/garden"]);
		expect(tags.get("house/calls")).toMatchObject({ displayName: "House/Calls", color: "blue", createdAt: JAN });
		expect(task(h, h.ids["Ring mum"]!).tagKeys).toEqual(["house/calls", "errands"]);
		expect(task(h, h.ids["Weed"]!).tagKeys).toEqual(["house/garden"]);
		expect(task(h, h.ids["Tidy"]!).tagKeys).toEqual(["house"]);
		expect(trashed(h).find((t) => t.title === "Old call")!.tagKeys).toEqual(["house/calls"]);
	});

	it("a casing change keeps the key and the tasks, and updates the children's display paths", async () => {
		const h = await seeded();
		const tasksBefore = h.app.store.state.tasks;
		const r = await h.app.tags.edit("home", { name: "HOME", parentKey: null, color: "red" });
		expect(r).toMatchObject({ wrote: true, key: "home" });
		expect(h.app.store.state.tags.get("home")!.displayName).toBe("HOME");
		expect(h.app.store.state.tags.get("home/calls")!.displayName).toBe("HOME/Calls");
		expect(h.app.store.state.tasks).toBe(tasksBefore);
	});

	it("a recolor alone writes the tag only", async () => {
		const h = await seeded();
		const tasksBefore = h.app.store.state.tasks;
		await h.app.tags.edit("errands", { name: "Errands", parentKey: null, color: "purple" });
		expect(h.app.store.state.tags.get("errands")!.color).toBe("purple");
		expect(h.app.store.state.tasks).toBe(tasksBefore);
	});

	it("a no-op edit writes nothing and adds no Undo entry", async () => {
		const h = await seeded();
		const state = h.app.store.state;
		const label = h.app.store.undoLabel;
		const mark = h.app.store.undoMark();
		const r = await h.app.tags.edit("home/calls", { name: "Calls", parentKey: "home", color: "blue" });
		expect(r).toEqual({ wrote: false, label: EDIT_TAG_LABEL, key: "home/calls" });
		expect(h.app.store.state).toBe(state);
		expect(h.app.store.undoLabel).toBe(label);
		expect(h.app.store.undoMark()).toBe(mark);
	});

	it("an Undo after a later edit of a renamed task is refused", async () => {
		const h = await seeded();
		const mark = h.app.store.undoMark();
		await h.app.tags.edit("errands", { name: "Chores", parentKey: null, color: null });
		const undo = h.app.store.undoFor(mark, EDIT_TAG_LABEL);
		await h.app.tasks.update(h.ids["Shop"]!, { title: "Shop for food" });
		const before = snapshot(h);
		const state = h.app.store.state;
		await expect(undo()).rejects.toMatchObject({ code: "UndoConflict" });
		// Nothing changed, and the entry is still there: once the later edit is undone, the notice's Undo works.
		expect(h.app.store.state).toBe(state);
		expect(snapshot(h)).toEqual(before);
		await h.app.store.undo();
		expect(h.app.store.undoLabel).toBe(EDIT_TAG_LABEL);
		expect(await undo()).toBe(true);
		expect(h.app.store.state.tags.has("errands")).toBe(true);
		expect(task(h, h.ids["Shop"]!).tagKeys).toEqual(["errands"]);
	});
});

describe("TagService.edit: a flat key from an older file", () => {
	it("a key with an empty segment takes no parent, but can be recolored and renamed", async () => {
		const h = await seeded();
		await h.app.store.run("Seed", (tx) => tx.put("tags", { key: "a//b", displayName: "A//B", color: null, createdAt: JAN, modifiedAt: JAN }));
		const state = h.app.store.state;
		await expect(h.app.tags.edit("a//b", { name: "A//B", parentKey: "home", color: null })).rejects.toMatchObject({
			code: "InvalidTag",
			message: TAG_FLAT_PARENT_MESSAGE,
		});
		expect(h.app.store.state).toBe(state);
		expect((await h.app.tags.edit("a//b", { name: "A//B", parentKey: null, color: "green" })).key).toBe("a//b");
		expect((await h.app.tags.edit("a//b", { name: "Ab", parentKey: null, color: "green" })).key).toBe("ab");
	});
});

describe("TagService.edit: parent", () => {
	it("moves a top-level tag under a top-level tag, and a child to the top", async () => {
		const h = await seeded();
		expect((await h.app.tags.edit("errands", { name: "Errands", parentKey: "home", color: null })).key).toBe("home/errands");
		expect(h.app.store.state.tags.get("home/errands")!.displayName).toBe("Home/Errands");
		expect(task(h, h.ids["Shop"]!).tagKeys).toEqual(["home/errands"]);
		expect((await h.app.tags.edit("home/garden", { name: "Garden", parentKey: null, color: null })).key).toBe("garden");
		expect(task(h, h.ids["Weed"]!).tagKeys).toEqual(["garden"]);
	});

	it("moves under an implicit parent, which stays implicit", async () => {
		const h = await seeded();
		expect((await h.app.tags.edit("errands", { name: "Errands", parentKey: "work", color: null })).key).toBe("work/errands");
		expect(h.app.store.state.tags.get("work/errands")!.displayName).toBe("Work/Errands");
		expect(h.app.store.state.tags.has("work")).toBe(false);
	});

	it("refuses a parent for a tag with children, a parent that is not top-level, itself, or gone", async () => {
		const h = await seeded();
		const state = h.app.store.state;
		await expect(h.app.tags.edit("home", { name: "Home", parentKey: "errands", color: "red" })).rejects.toMatchObject({
			code: "InvalidTag",
			message: "A tag with child tags has no parent.",
		});
		await expect(h.app.tags.edit("errands", { name: "Errands", parentKey: "home/calls", color: null })).rejects.toMatchObject({ code: "InvalidTag" });
		await expect(h.app.tags.edit("errands", { name: "Errands", parentKey: "errands", color: null })).rejects.toMatchObject({ code: "InvalidTag" });
		await expect(h.app.tags.edit("errands", { name: "Errands", parentKey: "gone", color: null })).rejects.toMatchObject({
			code: "NotFound",
			message: "The parent tag no longer exists.",
		});
		expect(h.app.store.state).toBe(state);
	});
});

describe("TagService.edit: names", () => {
	it("refuses a name in use (no merge), a child's name, a bad name and a repeated parent name, writing nothing", async () => {
		const h = await seeded();
		const state = h.app.store.state;
		await expect(h.app.tags.edit("errands", { name: "Garden", parentKey: null, color: null })).rejects.toMatchObject({
			code: "InvalidTag",
			message: 'The name "Garden" is already used by another tag.',
		});
		await expect(h.app.tags.edit("errands", { name: "home", parentKey: null, color: null })).rejects.toMatchObject({ code: "InvalidTag" });
		await expect(h.app.tags.edit("errands", { name: "work", parentKey: null, color: null })).rejects.toMatchObject({ code: "InvalidTag" });
		await expect(h.app.tags.edit("home", { name: "Calls", parentKey: null, color: "red" })).rejects.toMatchObject({ code: "InvalidTag" });
		await expect(h.app.tags.edit("errands", { name: "two words", parentKey: null, color: null })).rejects.toMatchObject({ code: "InvalidTag" });
		await expect(h.app.tags.edit("errands", { name: "x".repeat(65), parentKey: null, color: null })).rejects.toMatchObject({ code: "InvalidTag" });
		await expect(h.app.tags.edit("home/garden", { name: "Errands", parentKey: "errands", color: null })).rejects.toMatchObject({
			code: "InvalidTag",
			message: TAG_REPEAT_MESSAGE,
		});
		expect(h.app.store.state).toBe(state);
	});

	it("a tag that is gone is NotFound", async () => {
		const h = await seeded();
		await expect(h.app.tags.edit("gone", { name: "X", parentKey: null, color: null })).rejects.toMatchObject({ code: "NotFound", message: "The tag no longer exists." });
	});
});

describe("TagService.edit: tags from older files", () => {
	it("a deeper tag keeps its parent; its children move by prefix", async () => {
		const h = await seeded();
		await h.app.store.run("Seed", (tx) => {
			tx.put("tags", { key: "a/b/c", displayName: "A/B/C", color: null, createdAt: JAN, modifiedAt: JAN });
			tx.put("tags", { key: "a", displayName: "A", color: null, createdAt: JAN, modifiedAt: JAN });
		});
		const { task: t } = await h.app.tasks.create({ title: "Deep", tagKeys: ["a/b/c"] });
		expect((await h.app.tags.edit("a/b/c", { name: "C", parentKey: "a/b", color: "green" })).key).toBe("a/b/c");
		expect((await h.app.tags.edit("a/b/c", { name: "D", parentKey: "a/b", color: "green" })).key).toBe("a/b/d");
		expect((await h.app.tags.edit("a", { name: "Z", parentKey: null, color: null })).key).toBe("z");
		expect(h.app.store.state.tags.get("z/b/d")).toMatchObject({ displayName: "Z/B/D", color: "green" });
		expect(task(h, t.id).tagKeys).toEqual(["z/b/d"]);
	});

	it("leaves saved filters untouched", async () => {
		const h = await seeded();
		const filters = h.app.store.state.savedFilters;
		await h.app.tags.edit("errands", { name: "Chores", parentKey: null, color: null });
		expect(h.app.store.state.savedFilters).toBe(filters);
	});
});
