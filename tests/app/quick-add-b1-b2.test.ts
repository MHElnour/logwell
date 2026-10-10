import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, sanitizeSettings } from "../../src/app/settings";
import { appHarness } from "./harness";

describe("B1: dateLocale setting", () => {
	it("defaults to en and keeps en-GB", () => {
		expect(DEFAULT_SETTINGS.dateLocale).toBe("en");
		expect(sanitizeSettings({ dateLocale: "en-GB" }).dateLocale).toBe("en-GB");
	});
	it("drops invalid values", () => {
		expect(sanitizeSettings({ dateLocale: "de" }).dateLocale).toBe("en");
		expect(sanitizeSettings({ dateLocale: 3 }).dateLocale).toBe("en");
		expect(sanitizeSettings(null).dateLocale).toBe("en");
	});
});

describe("B2 / TAG-02: newTags on create", () => {
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

	it("resolves existing keys case-insensitively without duplicating (B16)", async () => {
		const h = await appHarness();
		await h.app.tags.create("Work");
		const { task } = await h.app.tasks.create({ title: "x", newTags: ["WORK", "work"], tagKeys: ["work"] });
		expect(task.tagKeys).toEqual(["work"]);
		expect(h.app.store.state.tags.size).toBe(1);
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
