import { describe, expect, it } from "vitest";
import { appHarness } from "./harness";

// A tag name is used once, whatever its parent, case-insensitively, on every create path. Duplicates
// already in a database still load and work.

const seed = (key: string, displayName: string, createdAt = "2026-10-01T10:00:00Z") => ({ key, displayName, color: null, createdAt, modifiedAt: createdAt });

describe("TagService.create", () => {
	it("refuses a name used under another parent, with no write", async () => {
		const h = await appHarness();
		await h.app.tags.create("Home/Calls");
		await expect(h.app.tags.create("Work/CALLS")).rejects.toMatchObject({ code: "InvalidTag", message: "A tag named Calls already exists under Home." });
		await expect(h.app.tags.create("calls")).rejects.toMatchObject({ code: "InvalidTag" });
		expect(h.app.tags.list().map((t) => t.key)).toEqual(["home/calls"]);
	});

	it("refuses a child whose name is a root tag", async () => {
		const h = await appHarness();
		await h.app.tags.create("Errands");
		await expect(h.app.tags.create("home/errands")).rejects.toMatchObject({ message: "A tag named Errands already exists." });
	});

	it("refuses a tag named like its parent", async () => {
		const h = await appHarness();
		await expect(h.app.tags.create("Calls/CALLS")).rejects.toMatchObject({ code: "InvalidTag", message: "A tag can't have the same name as its parent." });
		await expect(h.app.tasks.create({ title: "x", newTags: ["calls/calls"] })).rejects.toMatchObject({ code: "InvalidTag" });
		expect(h.app.tags.list()).toHaveLength(0);
	});

	it("still returns an existing key, and lets the implicit parent become a tag", async () => {
		const h = await appHarness();
		await h.app.tags.create("Home/Calls");
		expect((await h.app.tags.create("HOME/calls")).key).toBe("home/calls");
		expect((await h.app.tags.create("Home")).key).toBe("home");
		expect((await h.app.tags.create("home/garden")).key).toBe("home/garden");
	});
});

describe("TaskService.create with newTags", () => {
	it("refuses a duplicate name and creates no task", async () => {
		const h = await appHarness();
		await h.app.tags.create("home/calls");
		await expect(h.app.tasks.create({ title: "x", newTags: ["work/calls"] })).rejects.toMatchObject({ code: "InvalidTag" });
		expect(h.app.store.state.tasks.size).toBe(0);
		expect(h.app.tags.list()).toHaveLength(1);
	});

	it("refuses two new tags of one name in one task", async () => {
		const h = await appHarness();
		await expect(h.app.tasks.create({ title: "x", newTags: ["home/calls", "work/calls"] })).rejects.toMatchObject({ code: "InvalidTag" });
		expect(h.app.tags.list()).toHaveLength(0);
	});

	it("an existing key is reused", async () => {
		const h = await appHarness();
		await h.app.tags.create("home/calls");
		const { task } = await h.app.tasks.create({ title: "x", newTags: ["Home/Calls"] });
		expect(task.tagKeys).toEqual(["home/calls"]);
	});
});

describe("duplicates already in a database", () => {
	it("load and keep working", async () => {
		const h = await appHarness();
		await h.app.store.run("Seed", (tx) => {
			tx.put("tags", seed("home/calls", "Home/Calls"));
			tx.put("tags", seed("work/calls", "Work/Calls", "2026-10-02T10:00:00Z"));
		});
		const { task } = await h.app.tasks.create({ title: "x", tagKeys: ["work/calls", "home/calls"] });
		expect(task.tagKeys).toEqual(["work/calls", "home/calls"]);
		await h.app.tags.setColor("work/calls", "red");
		expect(h.app.store.state.tags.get("work/calls")?.color).toBe("red");
	});
});
