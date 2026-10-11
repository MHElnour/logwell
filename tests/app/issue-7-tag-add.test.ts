import { describe, expect, it } from "vitest";
import { CREATE_TAG_LABEL } from "../../src/app/CategoryService";
import { appHarness } from "./harness";

// New tag (Lists, sections and tags rule 23b): a name, an optional top-level parent and a color, in one write with
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
		expect(tag).toMatchObject({ key: "garden", displayName: "Garden", color: "green" });
		expect(h.app.store.undoLabel).toBe(CREATE_TAG_LABEL);
		expect(await h.app.store.undo()).toBe(CREATE_TAG_LABEL);
		expect(h.app.store.state.tags.has("garden")).toBe(false);
	});

	it("null color means no color", async () => {
		const h = await seeded();
		expect((await h.app.tags.add("Plain", null, null)).color).toBeNull();
	});

	it("creates under an implicit parent with the parent's casing; the parent stays implicit", async () => {
		const h = await seeded();
		const tag = await h.app.tags.add("Garden", "home", "red");
		expect(tag).toMatchObject({ key: "home/garden", displayName: "Home/Garden" });
		expect(h.app.store.state.tags.has("home")).toBe(false);
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

	it("the plain create keeps its label and stays lenient for an existing key", async () => {
		const h = await seeded();
		const tag = await h.app.tags.create("ERRANDS");
		expect(tag.displayName).toBe("Errands");
		await h.app.tags.create("Fresh");
		expect(h.app.store.undoLabel).toBe(CREATE_TAG_LABEL);
	});
});
