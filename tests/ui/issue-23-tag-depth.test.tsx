// @vitest-environment happy-dom
import { render } from "preact";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeTagKey } from "../../src/domain/tags";
import { TagInput } from "../../src/ui/TagInput";
import { appHarness } from "../app/harness";

// The manual tag input offers no "New tag" button for a key that is too deep, and says why.

let container: HTMLElement | null = null;
afterEach(() => {
	if (container !== null) render(null, container);
	container?.remove();
	container = null;
});

async function settleUi(): Promise<void> {
	for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

async function mount() {
	const h = await appHarness();
	const errors: unknown[] = [];
	const changes: string[][] = [];
	container = document.createElement("div");
	document.body.append(container);
	render(
		<TagInput app={h.app} value={[]} onChange={(k) => changes.push(k)} onError={(e) => errors.push(e)} normalize={normalizeTagKey} />,
		container,
	);
	await settleUi();
	return { h, errors, changes, root: container };
}

async function typeInto(root: HTMLElement, value: string): Promise<HTMLInputElement> {
	const input = root.querySelector<HTMLInputElement>("input[type=text]")!;
	input.value = value;
	input.dispatchEvent(new Event("input", { bubbles: true }));
	await settleUi();
	return input;
}

const buttons = (root: HTMLElement) => [...root.querySelectorAll("button")].map((b) => b.textContent);

describe("TagInput tag depth", () => {
	it("offers New tag for one slash", async () => {
		const m = await mount();
		await typeInto(m.root, "a/b");
		expect(buttons(m.root)).toEqual(["New tag: a/b"]);
		expect(m.root.querySelector(".cp-hint")).toBeNull();
	});

	it("offers no New tag for two slashes and shows the message; Enter creates nothing", async () => {
		const m = await mount();
		const input = await typeInto(m.root, "a/b/c");
		expect(buttons(m.root)).toEqual([]);
		expect(m.root.querySelector(".cp-hint")?.textContent).toBe("Tags can be nested one level deep, like work/calls.");
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		await settleUi();
		expect(m.h.app.tags.list()).toHaveLength(0);
		expect(m.changes).toEqual([]);
	});

	it("an existing deeper tag can still be added", async () => {
		const m = await mount();
		await m.h.app.store.run("Seed", (tx) =>
			tx.put("tags", { key: "a/b/c", displayName: "A/B/C", color: null, createdAt: "2026-10-01T10:00:00Z", modifiedAt: "2026-10-01T10:00:00Z" }),
		);
		await typeInto(m.root, "A/B/C");
		expect(buttons(m.root)).toEqual(["Add"]);
		expect(m.root.querySelector(".cp-hint")).toBeNull();
	});

	it("keeps the character hint for an invalid character", async () => {
		const m = await mount();
		await typeInto(m.root, "a$b");
		expect(m.root.querySelector(".cp-hint")?.textContent).toBe("Only letters, digits, hyphens (-) and underscores (_) are allowed.");
	});
});
