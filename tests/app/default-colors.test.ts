import { describe, expect, it } from "vitest";
import { INBOX_ID, TAG_COLORS, paletteColor } from "../../src/domain/types";
import { appHarness } from "./harness";

// Defaults: new lists and tags rotate through the theme
// palette so the sidebar is colorful out of the box. The user can still change or clear it.

describe("paletteColor", () => {
	it("rotates red, orange, yellow, green, cyan, blue, purple, pink and wraps", () => {
		expect(TAG_COLORS).toEqual(["red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink"]);
		expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 16].map(paletteColor)).toEqual([
			"red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink", "red", "orange", "red",
		]);
	});
});

describe("default list colors", () => {
	it("new lists rotate through the palette; Inbox does not count", async () => {
		const h = await appHarness();
		const made: (string | null)[] = [];
		for (const name of ["A", "B", "C", "D", "E", "F", "G", "H", "I"]) made.push((await h.app.categories.create(name)).color);
		expect(made).toEqual(["red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink", "red"]);
		expect(h.app.store.state.categories.get(INBOX_ID)?.color).toBeNull();
	});

	it("is based on how many lists exist, so a deleted list's color is reused", async () => {
		const h = await appHarness();
		const a = await h.app.categories.create("A");
		await h.app.categories.create("B");
		await h.app.categories.delete(a.id);
		expect((await h.app.categories.create("C")).color).toBe("orange");
	});

	it("the user can still change it or clear it", async () => {
		const h = await appHarness();
		const c = await h.app.categories.create("A");
		expect((await h.app.categories.setColor(c.id, "pink")).color).toBe("pink");
		expect((await h.app.categories.setColor(c.id, null)).color).toBeNull();
	});
});

describe("default tag colors", () => {
	it("explicit tag creation rotates by the number of tags", async () => {
		const h = await appHarness();
		const colors: (string | null)[] = [];
		for (const n of ["one", "two", "three"]) colors.push((await h.app.tags.create(n)).color);
		expect(colors).toEqual(["red", "orange", "yellow"]);
	});

	it("an explicit color (or none) is kept", async () => {
		const h = await appHarness();
		expect((await h.app.tags.create("blue-one", "blue")).color).toBe("blue");
		expect((await h.app.tags.create("plain", null)).color).toBeNull();
	});

	it("tags created by Quick Add (new tags on a task) get one too, once each", async () => {
		const h = await appHarness();
		await h.app.tags.create("first");
		await h.app.tasks.create({ title: "Pay", newTags: ["second", "third", "second"] });
		const by = (k: string) => h.app.store.state.tags.get(k)?.color;
		expect([by("first"), by("second"), by("third")]).toEqual(["red", "orange", "yellow"]);
	});

	it("an existing tag keeps its color when named again", async () => {
		const h = await appHarness();
		await h.app.tags.create("keep");
		await h.app.tags.setColor("keep", "cyan");
		await h.app.tags.create("keep");
		await h.app.tasks.create({ title: "x", newTags: ["keep"] });
		expect(h.app.store.state.tags.get("keep")?.color).toBe("cyan");
	});
});
