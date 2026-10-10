import { describe, expect, it } from "vitest";
import { TAG_DEPTH_MESSAGE } from "../../src/domain/tags";
import { appHarness } from "./harness";

// New tags have at most one parent level; a deeper tag already in the file keeps working.

const DEEP = {
	key: "a/b/c",
	displayName: "A/B/C",
	color: null,
	createdAt: "2026-10-01T10:00:00Z",
	modifiedAt: "2026-10-01T10:00:00Z",
} as const;

async function withDeepTag() {
	const h = await appHarness();
	await h.app.store.run("Seed", (tx) => tx.put("tags", { ...DEEP }));
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
		const tag = await h.app.tags.create("A/B/C");
		expect(tag.displayName).toBe("A/B/C");
		expect(h.app.tags.list()).toHaveLength(1);
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
