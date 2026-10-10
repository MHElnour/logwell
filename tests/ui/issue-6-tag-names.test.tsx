// @vitest-environment happy-dom
import { render } from "preact";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeTagKey } from "../../src/domain/tags";
import { TagInput } from "../../src/ui/TagInput";
import { appHarness } from "../app/harness";

// The manual tag input offers no "New tag" for a name used under another parent, and says why.

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
	await h.app.tags.create("Home/Calls");
	const changes: string[][] = [];
	container = document.createElement("div");
	document.body.append(container);
	render(<TagInput app={h.app} value={[]} onChange={(k) => changes.push(k)} onError={() => undefined} normalize={normalizeTagKey} />, container);
	await settleUi();
	return { h, changes, root: container };
}

async function typeInto(root: HTMLElement, value: string): Promise<HTMLInputElement> {
	const input = root.querySelector<HTMLInputElement>("input[type=text]")!;
	input.value = value;
	input.dispatchEvent(new Event("input", { bubbles: true }));
	await settleUi();
	return input;
}

const buttons = (root: HTMLElement) => [...root.querySelectorAll("button")].map((b) => b.textContent);

describe("TagInput unique tag names", () => {
	it("refuses New tag for a duplicate name with a clear message; Enter creates nothing", async () => {
		const m = await mount();
		const input = await typeInto(m.root, "Work/Calls");
		expect(buttons(m.root)).toEqual([]);
		expect(m.root.querySelector(".cp-hint")?.textContent).toBe("A tag named Calls already exists under Home.");
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		await settleUi();
		expect(m.h.app.tags.list()).toHaveLength(1);
		expect(m.changes).toEqual([]);
	});

	it("refuses a tag named like its parent", async () => {
		const m = await mount();
		await typeInto(m.root, "garden/Garden");
		expect(buttons(m.root)).toEqual([]);
		expect(m.root.querySelector(".cp-hint")?.textContent).toBe("A tag can't have the same name as its parent.");
	});

	it("still offers New tag for a unique name", async () => {
		const m = await mount();
		await typeInto(m.root, "home/garden");
		expect(buttons(m.root)).toEqual(["New tag: home/garden"]);
	});
});
