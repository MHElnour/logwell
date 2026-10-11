import { describe, expect, it } from "vitest";
import { CREATE_TAG_LABEL } from "../../src/app/CategoryService";
import { makeTask } from "../persistence/fixtures";
import { appHarness } from "./harness";

// Lists, sections and tags rule 26: creating `home/calls` creates the tag `home` first when it is missing, in the same
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
