// @vitest-environment happy-dom
import { render } from "preact";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeTagKey } from "../../src/domain/tags";
import { TagInput } from "../../src/ui/TagInput";
import { appHarness } from "../app/harness";

// The tag field finds a child tag by its own name and shows tags by their own name (#11).

let container: HTMLElement | null = null;
afterEach(() => {
	if (container !== null) render(null, container);
	container?.remove();
	container = null;
});

async function settleUi(): Promise<void> {
	for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

async function mount(value: string[] = []) {
	const h = await appHarness();
	await h.app.tags.create("Home/Calls");
	const changes: string[][] = [];
	container = document.createElement("div");
	document.body.append(container);
	render(<TagInput app={h.app} value={value} onChange={(k) => changes.push(k)} onError={() => undefined} normalize={normalizeTagKey} />, container);
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

describe("TagInput: a tag by its own name", () => {
	it("typing the name offers Add and Enter adds the child tag; no new tag is made", async () => {
		const m = await mount();
		const input = await typeInto(m.root, "calls");
		expect(buttons(m.root)).toEqual(["Add"]);
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		await settleUi();
		expect(m.changes).toEqual([["home/calls"]]);
		expect(m.h.app.tags.list()).toHaveLength(1);
	});

	it("the Add button adds the child tag", async () => {
		const m = await mount();
		await typeInto(m.root, "@CALLS");
		m.root.querySelector<HTMLButtonElement>("button")!.click();
		await settleUi();
		expect(m.changes).toEqual([["home/calls"]]);
	});

	it("the full path still adds the tag", async () => {
		const m = await mount();
		await typeInto(m.root, "home/calls");
		expect(buttons(m.root)).toEqual(["Add"]);
	});

	it("another parent's path is refused with the name only", async () => {
		const m = await mount();
		await typeInto(m.root, "work/calls");
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
		await settleUi();
		expect([...m.root.querySelectorAll("datalist option")].map((o) => (o as HTMLOptionElement).value)).toEqual(["Calls"]);
	});
});
