// @vitest-environment happy-dom
import { render } from "preact";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeTagKey } from "../../src/domain/tags";
import { TagInput } from "../../src/ui/TagInput";
import { appHarness } from "../app/harness";

// The tag field holds a new name to 64 characters and says why with the New tag dialog's words (Lists, sections and
// tags rule 21); an existing longer tag can still be added.

let container: HTMLElement | null = null;
afterEach(() => {
	if (container !== null) render(null, container);
	container?.remove();
	container = null;
});

async function settleUi(): Promise<void> {
	for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

async function mount(seed?: (h: Awaited<ReturnType<typeof appHarness>>) => Promise<void>) {
	const h = await appHarness();
	await seed?.(h);
	container = document.createElement("div");
	document.body.append(container);
	render(<TagInput app={h.app} value={[]} onChange={() => undefined} onError={() => undefined} normalize={normalizeTagKey} />, container);
	await settleUi();
	return { h, root: container };
}

async function typeInto(root: HTMLElement, value: string): Promise<HTMLInputElement> {
	const input = root.querySelector<HTMLInputElement>("input[type=text]")!;
	input.value = value;
	input.dispatchEvent(new Event("input", { bubbles: true }));
	await settleUi();
	return input;
}

const buttons = (root: HTMLElement) => [...root.querySelectorAll("button")].map((b) => b.textContent);
const hint = (root: HTMLElement) => root.querySelector(".cp-hint")?.textContent ?? null;

describe("TagInput name length and wording", () => {
	it("offers New tag for 64 characters, not for 65, and says why; Enter creates nothing", async () => {
		const m = await mount();
		await typeInto(m.root, "a".repeat(64));
		expect(buttons(m.root)).toEqual([`New tag: ${"a".repeat(64)}`]);
		const input = await typeInto(m.root, "a".repeat(65));
		expect(buttons(m.root)).toEqual([]);
		expect(hint(m.root)).toBe("Use at most 64 characters.");
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		await settleUi();
		expect(m.h.app.tags.list()).toHaveLength(0);
	});

	it("a long new child name is refused too", async () => {
		const m = await mount();
		await typeInto(m.root, `home/${"a".repeat(65)}`);
		expect(hint(m.root)).toBe("Use at most 64 characters.");
	});

	it("an existing longer tag can still be added", async () => {
		const long = "b".repeat(70);
		const m = await mount(async (h) => {
			await h.app.store.run("Seed", (tx) => tx.put("tags", { key: long, displayName: long, color: null, createdAt: tx.now, modifiedAt: tx.now }));
		});
		await typeInto(m.root, long);
		expect(buttons(m.root)).toEqual(["Add"]);
		expect(hint(m.root)).toBeNull();
	});

	it("uses the dialog's words for spaces and other characters", async () => {
		const m = await mount();
		await typeInto(m.root, "phone calls");
		expect(hint(m.root)).toBe("Use one word: spaces are not allowed. Try a hyphen, like phone-calls.");
		await typeInto(m.root, "a$b");
		expect(hint(m.root)).toBe("Only letters, digits, hyphens (-) and underscores (_) are allowed.");
	});
});
