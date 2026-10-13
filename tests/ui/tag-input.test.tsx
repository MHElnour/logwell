// @vitest-environment happy-dom
import { render } from "preact";
import { describe, expect, it } from "vitest";
import { normalizeTagKey } from "../../src/domain/tags";
import { TagInput } from "../../src/ui/TagInput";
import { type AppHarness, appHarness } from "../app/harness";
import { mountNode, q, settle, typeInto } from "./app-helpers";

/** The tag field on a real app (`seed` runs on the harness first), recording what it reports. */
async function mountTagInput(seed?: (h: AppHarness) => Promise<unknown>, value: string[] = []) {
	const h = await appHarness();
	await seed?.(h);
	const errors: unknown[] = [];
	const changes: string[][] = [];
	const root = mountNode(<TagInput app={h.app} value={value} onChange={(k) => changes.push(k)} onError={(e) => errors.push(e)} normalize={normalizeTagKey} />);
	await settle();
	return { h, errors, changes, root };
}

/** Types into the field and returns it. */
async function typeTag(root: HTMLElement, value: string): Promise<HTMLInputElement> {
	const input = q<HTMLInputElement>(root, "input[type=text]");
	await typeInto(input, value);
	return input;
}

const buttons = (root: HTMLElement) => [...root.querySelectorAll("button")].map((b) => b.textContent);
const homeCalls = (h: AppHarness) => h.app.tags.create("Home/Calls");

describe("a tag by its own name", () => {
	// The tag field finds a child tag by its own name and shows tags by their own name (#11).

	const mount = (value: string[] = []) => mountTagInput(homeCalls, value);

	describe("TagInput: a tag by its own name", () => {
		it("typing the name offers Add and Enter adds the child tag; no new tag is made", async () => {
			const m = await mount();
			const input = await typeTag(m.root, "calls");
			expect(buttons(m.root)).toEqual(["Add"]);
			input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
			await settle();
			expect(m.changes).toEqual([["home/calls"]]);
			expect(m.h.app.tags.list().map((t) => t.key)).toEqual(["home", "home/calls"]);
		});

		it("the Add button adds the child tag", async () => {
			const m = await mount();
			await typeTag(m.root, "@CALLS");
			m.root.querySelector<HTMLButtonElement>("button")!.click();
			await settle();
			expect(m.changes).toEqual([["home/calls"]]);
		});

		it("the full path still adds the tag", async () => {
			const m = await mount();
			await typeTag(m.root, "home/calls");
			expect(buttons(m.root)).toEqual(["Add"]);
		});

		it("another parent's path is refused with the name only", async () => {
			const m = await mount();
			await typeTag(m.root, "work/calls");
			expect(buttons(m.root)).toEqual([]);
			expect(m.root.querySelector(".cp-hint")?.textContent).toBe('The name "Calls" is already used by another tag.');
		});

		it("chips and suggestions show the tag's own name", async () => {
			const m = await mount(["home/calls"]);
			expect(m.root.querySelector(".cp-chip")?.textContent).toContain("@Calls");
			expect(m.root.querySelector(".cp-chip")?.textContent).not.toContain("Home");
			expect(m.root.querySelector(".cp-chip-remove")?.getAttribute("aria-label")).toBe("Remove tag Calls");
			render(null, m.root);
			render(<TagInput app={m.h.app} value={[]} onChange={() => undefined} onError={() => undefined} normalize={normalizeTagKey} />, m.root);
			await settle();
			const options = [...m.root.querySelectorAll<HTMLOptionElement>("datalist option")];
			expect(options.map((o) => o.value)).toEqual(["Calls", "Home"]);
			// The full path is the option's label, so typing `home/` still finds the tag.
			expect(options.map((o) => o.getAttribute("label"))).toEqual(["Home/Calls", "Home"]);
		});
	});
});

describe("tag depth", () => {
	// The manual tag input offers no "New tag" button for a key that is too deep, and says why.

	const mount = () => mountTagInput();

	describe("TagInput tag depth", () => {
		it("offers New tag for one slash", async () => {
			const m = await mount();
			await typeTag(m.root, "a/b");
			expect(buttons(m.root)).toEqual(["New tag: a/b"]);
			expect(m.root.querySelector(".cp-hint")).toBeNull();
		});

		it("offers no New tag for two slashes and shows the message; Enter creates nothing", async () => {
			const m = await mount();
			const input = await typeTag(m.root, "a/b/c");
			expect(buttons(m.root)).toEqual([]);
			expect(m.root.querySelector(".cp-hint")?.textContent).toBe("Tags can be nested one level deep, like work/calls.");
			input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
			await settle();
			expect(m.h.app.tags.list()).toHaveLength(0);
			expect(m.changes).toEqual([]);
		});

		it("an existing deeper tag can still be added", async () => {
			const m = await mount();
			await m.h.app.store.run("Seed", (tx) =>
				tx.put("tags", { key: "a/b/c", displayName: "A/B/C", color: null, createdAt: "2026-10-01T10:00:00Z", modifiedAt: "2026-10-01T10:00:00Z" }),
			);
			await typeTag(m.root, "A/B/C");
			expect(buttons(m.root)).toEqual(["Add"]);
			expect(m.root.querySelector(".cp-hint")).toBeNull();
		});

		it("keeps the character hint for an invalid character", async () => {
			const m = await mount();
			await typeTag(m.root, "a$b");
			expect(m.root.querySelector(".cp-hint")?.textContent).toBe("Only letters, digits, hyphens (-) and underscores (_) are allowed.");
		});
	});
});

describe("unique tag names", () => {
	// The manual tag input offers no "New tag" for a name used under another parent, and says why.

	const mount = () => mountTagInput(homeCalls);

	describe("TagInput unique tag names", () => {
		it("refuses New tag for a duplicate name with a clear message; Enter creates nothing", async () => {
			const m = await mount();
			const input = await typeTag(m.root, "Work/Calls");
			expect(buttons(m.root)).toEqual([]);
			expect(m.root.querySelector(".cp-hint")?.textContent).toBe('The name "Calls" is already used by another tag.');
			input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
			await settle();
			expect(m.h.app.tags.list()).toHaveLength(2);
			expect(m.changes).toEqual([]);
		});

		it("refuses a tag named like its parent", async () => {
			const m = await mount();
			await typeTag(m.root, "garden/Garden");
			expect(buttons(m.root)).toEqual([]);
			expect(m.root.querySelector(".cp-hint")?.textContent).toBe("A tag can't have the same name as its parent.");
		});

		it("still offers New tag for a unique name", async () => {
			const m = await mount();
			await typeTag(m.root, "home/garden");
			expect(buttons(m.root)).toEqual(["New tag: home/garden"]);
		});
	});
});

describe("name length", () => {
	// The tag field holds a new name to 64 characters and says why with the New tag dialog's words (Lists, sections and
	// tags rule 21); an existing longer tag can still be added.

	const mount = mountTagInput;
	const hint = (root: HTMLElement) => root.querySelector(".cp-hint")?.textContent ?? null;

	describe("TagInput name length and wording", () => {
		it("offers New tag for 64 characters, not for 65, and says why; Enter creates nothing", async () => {
			const m = await mount();
			await typeTag(m.root, "a".repeat(64));
			expect(buttons(m.root)).toEqual([`New tag: ${"a".repeat(64)}`]);
			const input = await typeTag(m.root, "a".repeat(65));
			expect(buttons(m.root)).toEqual([]);
			expect(hint(m.root)).toBe("Use at most 64 characters.");
			input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
			await settle();
			expect(m.h.app.tags.list()).toHaveLength(0);
		});

		it("a long new child name is refused too", async () => {
			const m = await mount();
			await typeTag(m.root, `home/${"a".repeat(65)}`);
			expect(hint(m.root)).toBe("Use at most 64 characters.");
		});

		it("an existing longer tag can still be added", async () => {
			const long = "b".repeat(70);
			const m = await mount(async (h) => {
				await h.app.store.run("Seed", (tx) => tx.put("tags", { key: long, displayName: long, color: null, createdAt: tx.now, modifiedAt: tx.now }));
			});
			await typeTag(m.root, long);
			expect(buttons(m.root)).toEqual(["Add"]);
			expect(hint(m.root)).toBeNull();
		});

		it("uses the dialog's words for spaces and other characters", async () => {
			const m = await mount();
			await typeTag(m.root, "phone calls");
			expect(hint(m.root)).toBe("Use one word: spaces are not allowed. Try a hyphen, like phone-calls.");
			await typeTag(m.root, "a$b");
			expect(hint(m.root)).toBe("Only letters, digits, hyphens (-) and underscores (_) are allowed.");
		});
	});
});
