import { describe, expect, it } from "vitest";
import { CREATE_TAG_LABEL, EDIT_TAG_LABEL } from "../../src/app/CategoryService";
import { resolveTagName, TAG_DEPTH_MESSAGE, TAG_FLAT_PARENT_MESSAGE, TAG_REPEAT_MESSAGE, tagLabel, tagNamesOf } from "../../src/domain/tags";
import { type Tag, type Task } from "../../src/domain/types";
import { type AppHarness, appHarness } from "./harness";
import { makeTask } from "../persistence/fixtures";
import { buildList, sidebarCounts, viewPreset, viewTitle } from "../../src/app/views";
import { emptyFilter } from "../../src/domain/queries";

const task = (h: AppHarness, id: string): Task => h.app.store.state.tasks.get(id)!;
const trashed = (h: AppHarness): Task[] => [...h.app.store.state.trash.values()].flatMap((e) => e.tasks);
const snapshot = (h: AppHarness) => {
	const s = h.app.store.state;
	return { tags: new Map(s.tags), tasks: new Map(s.tasks), trash: new Map(s.trash) };
};

describe("Edit tag", () => {
	// Edit a tag: rename, move under a top-level tag or to the top, and recolor in one
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
			put("work", "Work");
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

		it("moves under a parent in its casing, leaving the parent as it is", async () => {
			const h = await seeded();
			const work = h.app.store.state.tags.get("work");
			expect((await h.app.tags.edit("errands", { name: "Errands", parentKey: "work", color: null })).key).toBe("work/errands");
			expect(h.app.store.state.tags.get("work/errands")!.displayName).toBe("Work/Errands");
			expect(h.app.store.state.tags.get("work")).toBe(work);
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
				tx.put("tags", { key: "a/b", displayName: "A/B", color: null, createdAt: JAN, modifiedAt: JAN });
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
});

describe("tag depth", () => {
	// New tags have at most one parent level; a deeper tag already in the file keeps working.

	const DEEP = {
		key: "a/b/c",
		displayName: "A/B/C",
		color: null,
		createdAt: "2026-10-01T10:00:00Z",
		modifiedAt: "2026-10-01T10:00:00Z",
	} as const;

	/** A deeper tag and the tags above it: every tag's parent is a record. */
	async function withDeepTag() {
		const h = await appHarness();
		await h.app.store.run("Seed", (tx) => {
			for (const [key, displayName] of [["a", "A"], ["a/b", "A/B"]] as const) tx.put("tags", { ...DEEP, key, displayName });
			tx.put("tags", { ...DEEP });
		});
		return h;
	}

	describe("TagService.create", () => {
		it("creates a tag with one slash", async () => {
			const h = await appHarness();
			const tag = await h.app.tags.create("a/b");
			expect(tag.key).toBe("a/b");
			expect(h.app.store.state.tags.has("a/b")).toBe(true);
		});

		it("refuses a key with two slashes, with the InvalidTag error and no write", async () => {
			const h = await appHarness();
			await expect(h.app.tags.create("a/b/c")).rejects.toMatchObject({ code: "InvalidTag", message: TAG_DEPTH_MESSAGE });
			await expect(h.app.tags.create("@A//B")).rejects.toMatchObject({ code: "InvalidTag", message: TAG_DEPTH_MESSAGE });
			expect(h.app.tags.list()).toHaveLength(0);
		});

		it("returns an existing deeper tag unchanged", async () => {
			const h = await withDeepTag();
			const tags = h.app.store.state.tags;
			const tag = await h.app.tags.create("A/B/C");
			expect(tag.displayName).toBe("A/B/C");
			expect(h.app.store.state.tags).toBe(tags);
		});
	});

	describe("TaskService.create with newTags", () => {
		it("refuses a new tag that is too deep and creates no task", async () => {
			const h = await appHarness();
			await expect(h.app.tasks.create({ title: "x", newTags: ["a/b/c"] })).rejects.toMatchObject({ code: "InvalidTag" });
			expect(h.app.tags.list()).toHaveLength(0);
			expect(h.app.store.state.tasks.size).toBe(0);
		});

		it("still accepts one slash, and an existing deeper tag", async () => {
			const h = await withDeepTag();
			const { task } = await h.app.tasks.create({ title: "x", newTags: ["a/b", "A/B/C"] });
			expect(task.tagKeys).toEqual(["a/b", "a/b/c"]);
		});
	});
});

describe("unique tag names", () => {
	// A tag name is used once, whatever its parent, case-insensitively, on every create path. Duplicates
	// already in a database still load and work.

	const seed = (key: string, displayName: string, createdAt = "2026-10-01T10:00:00Z") => ({ key, displayName, color: null, createdAt, modifiedAt: createdAt });

	describe("TagService.create", () => {
		it("refuses a name used under another parent, with no write", async () => {
			const h = await appHarness();
			await h.app.tags.create("Home/Calls");
			await expect(h.app.tags.create("Work/CALLS")).rejects.toMatchObject({ code: "InvalidTag", message: 'The name "Calls" is already used by another tag.' });
			await expect(h.app.tags.create("calls")).rejects.toMatchObject({ code: "InvalidTag" });
			expect(h.app.tags.list().map((t) => t.key)).toEqual(["home", "home/calls"]);
		});

		it("a refused create leaves the labels and name lookups of the committed tags unchanged", async () => {
			const h = await appHarness();
			await h.app.tags.create("Home/Calls");
			await expect(h.app.tags.create("Work/Calls")).rejects.toMatchObject({ code: "InvalidTag" });
			const tags = h.app.store.state.tags;
			expect(tagLabel(tags, "home/calls")).toBe("Calls");
			expect(resolveTagName(tagNamesOf(tags), "calls")).toBe("home/calls");
			expect(tagNamesOf(tags).count("calls")).toBe(1);
		});

		it("refuses a child whose name is a root tag", async () => {
			const h = await appHarness();
			await h.app.tags.create("Errands");
			await expect(h.app.tags.create("home/errands")).rejects.toMatchObject({ message: 'The name "Errands" is already used by another tag.' });
		});

		it("refuses a tag named like its parent", async () => {
			const h = await appHarness();
			await expect(h.app.tags.create("Calls/CALLS")).rejects.toMatchObject({ code: "InvalidTag", message: "A tag can't have the same name as its parent." });
			await expect(h.app.tasks.create({ title: "x", newTags: ["calls/calls"] })).rejects.toMatchObject({ code: "InvalidTag" });
			expect(h.app.tags.list()).toHaveLength(0);
		});

		it("still returns an existing tag in any casing or with a leading @, the parent made with a child too; the first display name stays", async () => {
			const h = await appHarness();
			const learning = await h.app.tags.create("Learning");
			expect(await h.app.tags.create("@learning")).toBe(learning);
			expect(await h.app.tags.create("LEARNING")).toBe(learning);
			expect(learning.displayName).toBe("Learning");
			expect(h.app.tags.resolve("LEARNING")).toBe("learning");
			await h.app.tags.create("Home/Calls");
			const home = h.app.store.state.tags.get("home");
			expect((await h.app.tags.create("HOME/calls")).key).toBe("home/calls");
			expect(await h.app.tags.create("Home")).toBe(home);
			expect(h.app.store.state.tags.size).toBe(3);
			expect((await h.app.tags.create("home/garden")).key).toBe("home/garden");
		});
	});

	describe("TaskService.create with newTags", () => {
		it("refuses a duplicate name and creates no task", async () => {
			const h = await appHarness();
			await h.app.tags.create("home/calls");
			await expect(h.app.tasks.create({ title: "x", newTags: ["work/calls"] })).rejects.toMatchObject({ code: "InvalidTag" });
			expect(h.app.store.state.tasks.size).toBe(0);
			expect(h.app.tags.list()).toHaveLength(2);
		});

		it("refuses two new tags of one name in one task", async () => {
			const h = await appHarness();
			await expect(h.app.tasks.create({ title: "x", newTags: ["home/calls", "work/calls"] })).rejects.toMatchObject({ code: "InvalidTag" });
			expect(h.app.tags.list()).toHaveLength(0);
		});
	});

	describe("duplicates already in a database", () => {
		it("load and keep working", async () => {
			const h = await appHarness();
			await h.app.store.run("Seed", (tx) => {
				tx.put("tags", seed("home", "Home"));
				tx.put("tags", seed("work", "Work"));
				tx.put("tags", seed("home/calls", "Home/Calls"));
				tx.put("tags", seed("work/calls", "Work/Calls", "2026-10-02T10:00:00Z"));
			});
			const { task } = await h.app.tasks.create({ title: "x", tagKeys: ["work/calls", "home/calls"] });
			expect(task.tagKeys).toEqual(["work/calls", "home/calls"]);
			await h.app.tags.setColor("work/calls", "red");
			expect(h.app.store.state.tags.get("work/calls")?.color).toBe("red");
		});
	});

	it("#137: setting a tag's color to the one it has writes nothing and leaves Undo as it was", async () => {
		const h = await appHarness();
		await h.app.tags.add("Home", null, null);
		await h.app.tags.setColor("home", "red");
		const state = h.app.store.state;
		await h.app.tasks.create({ title: "x" });
		const label = h.app.store.undoLabel;
		const after = h.app.store.state;
		await h.app.tags.setColor("home", "red");
		expect(h.app.store.state).toBe(after);
		expect(h.app.store.undoLabel).toBe(label);
		expect(state.tags.get("home")?.color).toBe("red");
	});
});

describe("New tag", () => {
	// New tag: a name, an optional top-level parent and a color, in one write with
	// Undo. Unlike Quick Add's lenient create, the dialog's create refuses a tag that already exists.

	async function seeded() {
		const h = await appHarness();
		await h.app.tags.create("Errands");
		await h.app.tags.create("Home/Calls");
		return h;
	}

	describe("TagService.add", () => {
		it("creates a top-level tag with the chosen color under the Create tag label; Undo removes it", async () => {
			const h = await seeded();
			expect(CREATE_TAG_LABEL).toBe("Create tag");
			const tag = await h.app.tags.add("Garden", null, "green");
			expect(tag).toMatchObject({ key: "garden", displayName: "Garden", color: "green", wrote: true, label: CREATE_TAG_LABEL });
			expect(h.app.store.undoLabel).toBe(CREATE_TAG_LABEL);
			expect(await h.app.store.undo()).toBe(CREATE_TAG_LABEL);
			expect(h.app.store.state.tags.has("garden")).toBe(false);
		});

		it("null color means no color", async () => {
			const h = await seeded();
			expect((await h.app.tags.add("Plain", null, null)).color).toBeNull();
		});

		it("creates under a parent made with a child, in the parent's casing, leaving the parent as it is", async () => {
			const h = await seeded();
			const home = h.app.store.state.tags.get("home");
			const tag = await h.app.tags.add("Garden", "home", "red");
			expect(tag).toMatchObject({ key: "home/garden", displayName: "Home/Garden", color: "red" });
			expect(h.app.store.state.tags.get("home")).toBe(home);
		});

		it("creates under a tag record", async () => {
			const h = await seeded();
			expect((await h.app.tags.add("Shop", "errands", null)).key).toBe("errands/shop");
		});

		it("refuses an existing tag, a name in use and a bad name, writing nothing", async () => {
			const h = await seeded();
			const before = h.app.store.state;
			await expect(h.app.tags.add("errands", null, null)).rejects.toMatchObject({ code: "InvalidTag", message: 'The name "Errands" is already used by another tag.' });
			await expect(h.app.tags.add("Calls", null, null)).rejects.toMatchObject({ code: "InvalidTag", message: 'The name "Calls" is already used by another tag.' });
			await expect(h.app.tags.add("home", null, null)).rejects.toMatchObject({ code: "InvalidTag" });
			await expect(h.app.tags.add("phone calls", null, null)).rejects.toMatchObject({ code: "InvalidTag" });
			await expect(h.app.tags.add("x".repeat(65), null, null)).rejects.toMatchObject({ code: "InvalidTag", message: "Use at most 64 characters." });
			expect(h.app.store.state).toBe(before);
		});

		it("refuses a parent that is gone or not top-level", async () => {
			const h = await seeded();
			await expect(h.app.tags.add("Garden", "gone", null)).rejects.toMatchObject({ code: "NotFound", message: "The parent tag no longer exists." });
			await expect(h.app.tags.add("Garden", "home/calls", null)).rejects.toMatchObject({ code: "InvalidTag" });
		});
	});
});

// Creating `home/calls` creates the tag `home` first when it is missing, in the same
// write, so every tag the sidebar shows is a tag record.

describe("creating a child tag creates its parent", () => {
	it("tags.create makes the parent then the child in one write with one Undo", async () => {
		const h = await appHarness();
		const mark = h.app.store.undoMark();
		const tag = await h.app.tags.create("Home/Calls");
		const tags = h.app.store.state.tags;
		expect(tag.key).toBe("home/calls");
		expect(tags.get("home")).toMatchObject({ key: "home", displayName: "Home", createdAt: tag.createdAt });
		expect(tags.get("home")!.color).not.toBeNull();
		expect(tags.get("home/calls")).toMatchObject({ displayName: "Home/Calls" });
		expect(await h.app.store.undoFor(mark, CREATE_TAG_LABEL)()).toBe(true);
		expect(h.app.store.state.tags.size).toBe(0);
		expect(h.app.store.canUndo).toBe(false);
	});

	it("an existing parent is kept as it is", async () => {
		const h = await appHarness();
		const home = await h.app.tags.create("Home", "red");
		h.clock.advance(60_000);
		await h.app.tags.create("home/Calls");
		expect(h.app.store.state.tags.get("home")).toBe(home);
		expect(h.app.store.state.tags.get("home/calls")!.displayName).toBe("Home/Calls");
	});

	it("an explicit color goes to the child; the new parent takes the palette color", async () => {
		const h = await appHarness();
		await h.app.tags.create("Home/Calls", "blue");
		const tags = h.app.store.state.tags;
		expect(tags.get("home/calls")!.color).toBe("blue");
		expect(tags.get("home")!.color).not.toBeNull();
		expect(tags.get("home")!.color).not.toBe("blue");
	});

	it("Quick Add's new tag creates the parent in the task's write", async () => {
		const h = await appHarness();
		const { task } = await h.app.tasks.create({ title: "Ring mum", newTags: ["Home/Calls"] });
		expect(task.tagKeys).toEqual(["home/calls"]);
		expect([...h.app.store.state.tags.keys()].sort()).toEqual(["home", "home/calls"]);
		await h.app.store.undo();
		expect(h.app.store.state.tags.size).toBe(0);
		expect(h.app.store.state.tasks.size).toBe(0);
	});

	it("a parent name another tag owns refuses both, and nothing is written", async () => {
		const h = await appHarness();
		await h.app.tags.create("Work/Home");
		const before = h.app.store.state;
		await expect(h.app.tags.create("Home/Calls")).rejects.toMatchObject({ code: "InvalidTag", message: 'The name "Home" is already used by another tag.' });
		await expect(h.app.tasks.create({ title: "x", newTags: ["home/calls"] })).rejects.toMatchObject({ code: "InvalidTag" });
		expect(h.app.store.state).toBe(before);
	});

	it("Undo is refused once a task written outside the history uses the new parent", async () => {
		const h = await appHarness();
		const mark = h.app.store.undoMark();
		await h.app.tags.create("Home/Calls");
		await h.app.store.run("Outside", (tx) => tx.put("tasks", makeTask("t-out", { tagKeys: ["home"] })), { undoable: false });
		await expect(h.app.store.undoFor(mark, CREATE_TAG_LABEL)()).rejects.toMatchObject({
			code: "UndoConflict",
			message: 'Cannot undo "Create tag": a task now uses this tag.',
		});
		expect(h.app.store.state.tags.has("home")).toBe(true);
	});
});

describe("deleting a parent tag", () => {
	// Deleting a parent moves its child tags to the top level (`home/calls` becomes
	// `calls`) on every task, trashed ones too, in the same write, with one Undo.

	const JAN = "2026-01-01T00:00:00.000Z";
	const DELETE_TAG = "Delete tag";

	async function seeded(): Promise<AppHarness & { ids: Record<string, string> }> {
		const h = await appHarness();
		await h.app.store.run("Seed", (tx) => {
			const put = (key: string, displayName: string, color: Tag["color"] = null) => tx.put("tags", { key, displayName, color, createdAt: JAN, modifiedAt: JAN });
			put("home", "Home", "red");
			put("home/calls", "Home/Calls", "blue");
			put("home/garden", "Home/Garden");
			put("errands", "Errands");
		});
		const ids: Record<string, string> = {};
		for (const [title, tagKeys] of [
			["Ring mum", ["home/calls", "errands"]],
			["Weed", ["home/garden"]],
			["Tidy", ["home"]],
			["Both", ["home", "home/calls"]],
			["Shop", ["errands"]],
			["Old call", ["home", "home/calls"]],
		] as const) {
			ids[title] = (await h.app.tasks.create({ title, tagKeys: [...tagKeys] })).task.id;
		}
		await h.app.tasks.delete(ids["Old call"]!);
		h.clock.advance(60_000);
		return Object.assign(h, { ids });
	}

	describe("TagService.delete of a parent", () => {
		it("moves the child tags to the top level in one write: records, live tasks and trashed tasks", async () => {
			const h = await seeded();
			const before = snapshot(h);
			const now = h.clock.now().toISOString();
			const trashedBefore = trashed(h)[0]!;
			const r = await h.app.tags.delete("home");
			expect(r.wrote).toBe(true);
			expect(r.label).toBe(DELETE_TAG);
			expect(r.moves).toEqual([
				{ from: "home/calls", to: "calls" },
				{ from: "home/garden", to: "garden" },
			]);
			const tags = h.app.store.state.tags;
			expect([...tags.keys()].sort()).toEqual(["calls", "errands", "garden"]);
			// A moved child keeps its createdAt (what it owns its name by) and color; modifiedAt is now.
			expect(tags.get("calls")).toEqual({ key: "calls", displayName: "Calls", color: "blue", createdAt: JAN, modifiedAt: now });
			expect(tags.get("garden")).toEqual({ key: "garden", displayName: "Garden", color: null, createdAt: JAN, modifiedAt: now });
			expect(tags.get("errands")).toBe(before.tags.get("errands"));

			const ring = task(h, h.ids["Ring mum"]!);
			expect(ring.tagKeys).toEqual(["calls", "errands"]);
			expect(ring.modifiedAt).toBe(now);
			expect(task(h, h.ids["Weed"]!).tagKeys).toEqual(["garden"]);
			expect(task(h, h.ids["Tidy"]!).tagKeys).toEqual([]);
			// A task with the parent and the child ends with the child once.
			expect(task(h, h.ids["Both"]!).tagKeys).toEqual(["calls"]);
			expect(task(h, h.ids["Shop"]!)).toBe(before.tasks.get(h.ids["Shop"]!));

			// A trashed task gets the new keys and keeps its modifiedAt.
			const old = trashed(h)[0]!;
			expect(old.tagKeys).toEqual(["calls"]);
			expect(old.modifiedAt).toBe(trashedBefore.modifiedAt);
		});

		it("is one Undo entry that restores every record by identity", async () => {
			const h = await seeded();
			const before = snapshot(h);
			const mark = h.app.store.undoMark();
			await h.app.tags.delete("home");
			expect(await h.app.store.undoFor(mark, DELETE_TAG)()).toBe(true);
			const after = snapshot(h);
			expect(after).toEqual(before);
			for (const [k, t] of before.tags) expect(after.tags.get(k)).toBe(t);
			for (const [k, t] of before.tasks) expect(after.tasks.get(k)).toBe(t);
			for (const [k, e] of before.trash) expect(after.trash.get(k)).toBe(e);
			expect(h.app.store.undoLabel).not.toBe(DELETE_TAG);
		});

		it("#127: refuses to delete a parent whose child would land on an existing tag, as a rename would, and writes nothing", async () => {
			const h = await seeded();
			// Two tags of one name, side by side in a file from an older version.
			await h.app.store.run("Seed", (tx) => tx.put("tags", { key: "calls", displayName: "Calls", color: "red", createdAt: "2020-01-01T00:00:00.000Z", modifiedAt: JAN }));
			await h.app.tasks.create({ title: "Call the bank", tagKeys: ["calls"] });
			const state = h.app.store.state;
			const label = h.app.store.undoLabel;
			await expect(h.app.tags.delete("home")).rejects.toMatchObject({ code: "InvalidTag", message: 'The name "Calls" is already used by another tag.' });
			expect(h.app.store.state).toBe(state);
			expect(h.app.store.undoLabel).toBe(label);
			// Two children of one parent that would land on one key (deeper keys from an older file) are refused too.
			await h.app.store.run("Seed", (tx) => {
				for (const [key, displayName] of [["work", "Work"], ["work/desk", "Work/Desk"], ["work/old", "Work/Old"], ["work/old/desk", "Work/Old/Desk"]]) {
					tx.put("tags", { key: key!, displayName: displayName!, color: null, createdAt: JAN, modifiedAt: JAN });
				}
			});
			await expect(h.app.tags.delete("work")).rejects.toMatchObject({ code: "InvalidTag", message: 'The name "Desk" is already used by another tag.' });
			expect(h.app.store.state.tags.has("work/desk")).toBe(true);
		});

		it("a leaf delete moves nothing", async () => {
			const h = await seeded();
			const r = await h.app.tags.delete("errands");
			expect(r).toEqual({ wrote: true, label: DELETE_TAG, tasks: 2, moves: [] });
		});

		type Seeded = Awaited<ReturnType<typeof seeded>>;
		it.each<{ name: string; later: (h: Seeded) => Promise<unknown>; undo: (h: Seeded, mark: number) => Promise<unknown>; refusal: object; kept: string }>([
			{
				name: "a later write outside the history uses a moved key",
				later: (h) => h.app.store.run("Outside", (tx) => tx.put("tasks", makeTask("t-out", { tagKeys: ["calls"] })), { undoable: false }),
				undo: (h, mark) => h.app.store.undoFor(mark, DELETE_TAG)(),
				refusal: { code: "UndoConflict", message: 'Cannot undo "Delete tag": a task now uses this tag.' },
				kept: "calls",
			},
			{
				name: "a later write uses a moved key, even through a new tag of that name",
				later: (h) => h.app.tasks.create({ title: "Call the bank", tagKeys: ["calls"] }),
				undo: (h, mark) => h.app.store.undoFor(mark, DELETE_TAG)(),
				refusal: { code: "UndoConflict" },
				kept: "calls",
			},
			{
				name: "a moved task was edited",
				later: (h) => h.app.store.run("Outside", (tx) => tx.put("tasks", { ...tx.get("tasks", h.ids["Weed"]!)!, title: "Weed the beds" }), { undoable: false }),
				undo: (h) => h.app.store.undo(),
				refusal: { code: "UndoConflict", message: 'Cannot undo "Delete tag": the item changed since.' },
				kept: "garden",
			},
		])("Undo is refused once $name", async ({ later, undo, refusal, kept }) => {
			const h = await seeded();
			const mark = h.app.store.undoMark();
			await h.app.tags.delete("home");
			await later(h);
			const state = h.app.store.state;
			await expect(undo(h, mark)).rejects.toMatchObject(refusal);
			expect(h.app.store.state).toBe(state);
			expect(h.app.store.state.tags.has(kept)).toBe(true);
		});
	});
});

describe("tag views include child tags", () => {
	// A tag view includes the tasks of every descendant tag.

	async function seed() {
		const h = await appHarness();
		const t = h.app.tasks;
		await t.create({ title: "Go task", newTags: ["Programming/Go"] });
		await t.create({ title: "Python task", newTags: ["Programming/Python"] });
		await t.create({ title: "Both", newTags: ["Programming/Go", "Programming/Python"] });
		await t.create({ title: "Parent itself", newTags: ["Programming"] });
		await t.create({ title: "Lookalike", newTags: ["Programmingx"] });
		await t.create({ title: "Untagged" });
		return h;
	}

	const titles = (h: Awaited<ReturnType<typeof seed>>, key: string) =>
		buildList(h.app.store.state, { kind: "tag", key }, h.app.queryContext(), emptyFilter(), "").groups.flatMap((g) => g.entries.map((e) => e.task.title)).sort();

	describe("tag views with descendants", () => {
		it("a parent view lists its own and every descendant's tasks, not a lookalike", async () => {
			const h = await seed();
			expect(titles(h, "programming")).toEqual(["Both", "Go task", "Parent itself", "Python task"]);
		});

		it("a child view lists only its own subtree", async () => {
			const h = await seed();
			expect(titles(h, "programming/go")).toEqual(["Both", "Go task"]);
			expect(titles(h, "programmingx")).toEqual(["Lookalike"]);
		});

		it("a parent made with its first child lists that child's tasks", async () => {
			const h = await appHarness();
			await h.app.tasks.create({ title: "Go task", newTags: ["Programming/Go"] });
			expect(h.app.store.state.tags.has("programming")).toBe(true);
			expect(titles(h, "programming")).toEqual(["Go task"]);
		});

		it("the Completed group of a parent view includes completed descendant tasks", async () => {
			const h = await seed();
			const done = (await h.app.tasks.create({ title: "Done go", newTags: ["Programming/Go"] })).task;
			await h.app.tasks.complete(done.id);
			const entries = buildList(h.app.store.state, { kind: "tag", key: "programming" }, h.app.queryContext(), emptyFilter(), "").completed;
			expect(entries.map((e) => e.task.title)).toEqual(["Done go"]);
			expect(buildList(h.app.store.state, { kind: "tag", key: "programming/python" }, h.app.queryContext(), emptyFilter(), "").completed).toEqual([]);
		});

		it("counts include descendants, each task once", async () => {
			const h = await seed();
			const counts = sidebarCounts(h.app.store.state, h.app.queryContext()).tags;
			expect(counts.get("programming")).toBe(4);
			expect(counts.get("programming/go")).toBe(2);
			expect(counts.get("programming/python")).toBe(2);
			expect(counts.get("programmingx")).toBe(1);
		});

		it("a tag view is titled by the tag's own name, and Quick Add from it presets that tag, a parent's too", async () => {
			const h = await appHarness();
			await h.app.tasks.create({ title: "Go task", newTags: ["Programming/Go"] });
			const state = h.app.store.state;
			expect(viewTitle({ kind: "tag", key: "programming" }, state)).toBe("@Programming");
			expect(viewTitle({ kind: "tag", key: "programming/go" }, state)).toBe("@Go");
			const ctx = h.app.queryContext();
			expect(viewPreset({ kind: "tag", key: "programming" }, ctx).addTagKeys).toEqual(["programming"]);
			expect(viewPreset({ kind: "tag", key: "programming/go" }, ctx).addTagKeys).toEqual(["programming/go"]);
		});
	});
});

describe("tags", () => {
	it("a task stores a set of tag keys; delete removes the key everywhere", async () => {
		const h = await appHarness();
		await h.app.tags.create("a");
		await h.app.tags.create("b");
		const { task } = await h.app.tasks.create({ title: "x", tagKeys: ["a", "b", "a"] });
		expect(task.tagKeys).toEqual(["a", "b"]);
		expect(await h.app.tags.delete("a")).toEqual({ wrote: true, label: "Delete tag", tasks: 1, moves: [] });
		expect(h.app.store.state.tasks.get(task.id)?.tagKeys).toEqual(["b"]);
	});

	it("deleting a tag also strips it from tasks in Trash", async () => {
		const h = await appHarness();
		await h.app.tags.create("a");
		await h.app.tags.create("b");
		const { task } = await h.app.tasks.create({ title: "x", tagKeys: ["a", "b"] });
		const entry = await h.app.tasks.delete(task.id);
		await h.app.tags.delete("a");
		expect(h.app.store.state.trash.get(entry.batchId)?.tasks[0]?.tagKeys).toEqual(["b"]);
		await h.app.tasks.restore(entry.batchId);
		expect(h.app.store.state.tasks.get(task.id)?.tagKeys).toEqual(["b"]);
		// Later tag edits work on the restored task.
		await h.app.tasks.update(task.id, { tagKeys: [] });
		expect(h.app.store.state.tasks.get(task.id)?.tagKeys).toEqual([]);
	});

	it("restore drops tag keys that no longer exist", async () => {
		const h = await appHarness();
		await h.app.tags.create("b");
		const { task } = await h.app.tasks.create({ title: "x", tagKeys: ["b"] });
		const entry = await h.app.tasks.delete(task.id);
		// A trash entry that still names a deleted tag (an older version or a merge import).
		const data = h.store.data;
		const ghost = { ...entry, tasks: [{ ...entry.tasks[0]!, tagKeys: ["ghost", "b"] }] };
		const trash = new Map(data.trash);
		trash.set(entry.batchId, ghost);
		h.store.commit({ ...data, trash }, [{ c: "trash", id: entry.batchId, v: ghost }]);
		await h.app.tasks.restore(entry.batchId);
		expect(h.app.store.state.tasks.get(task.id)?.tagKeys).toEqual(["b"]);
	});
});

describe("newTags on create", () => {
	it("creates the tags and the task in one commit with one undo entry", async () => {
		const h = await appHarness();
		const { task } = await h.app.tasks.create({ title: "Pay rent", newTags: ["Home Stuff".replace(" ", "-"), "urgent"] });
		expect(task.tagKeys.sort()).toEqual(["home-stuff", "urgent"]);
		expect([...h.app.store.state.tags.keys()].sort()).toEqual(["home-stuff", "urgent"]);
		expect(h.app.store.state.tags.get("home-stuff")?.displayName).toBe("Home-Stuff");
		expect(h.app.store.undoLabel).toBe("Create task");
		await h.app.store.undo();
		expect(h.app.store.state.tasks.size).toBe(0);
		expect(h.app.store.state.tags.size).toBe(0);
		expect(h.app.store.canUndo).toBe(false);
	});

	it("resolves existing keys case-insensitively without duplicating, a child's too", async () => {
		const h = await appHarness();
		await h.app.tags.create("Work");
		await h.app.tags.create("home/calls");
		const { task } = await h.app.tasks.create({ title: "x", newTags: ["WORK", "work", "Home/Calls"], tagKeys: ["work"] });
		expect(task.tagKeys).toEqual(["work", "home/calls"]);
		expect(h.app.store.state.tags.size).toBe(3);
		expect(h.app.store.state.tags.get("work")?.displayName).toBe("Work");
	});

	it("keeps the first display name when the same new tag repeats", async () => {
		const h = await appHarness();
		const { task } = await h.app.tasks.create({ title: "x", newTags: ["Foo", "FOO"] });
		expect(task.tagKeys).toEqual(["foo"]);
		expect(h.app.store.state.tags.get("foo")?.displayName).toBe("Foo");
	});

	it("an invalid name rejects the command and writes nothing", async () => {
		const h = await appHarness();
		await expect(h.app.tasks.create({ title: "x", newTags: ["good", "bad tag!"] })).rejects.toMatchObject({ code: "InvalidTag" });
		expect(h.app.store.state.tasks.size).toBe(0);
		expect(h.app.store.state.tags.size).toBe(0);
		expect(h.app.store.canUndo).toBe(false);
	});

	it("a failing task (empty title) creates no tag", async () => {
		const h = await appHarness();
		await expect(h.app.tasks.create({ title: " ", newTags: ["ok"] })).rejects.toMatchObject({ code: "TitleRequired" });
		expect(h.app.store.state.tags.size).toBe(0);
	});
});
