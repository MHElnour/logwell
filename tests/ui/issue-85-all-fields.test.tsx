// @vitest-environment happy-dom
import { render } from "preact";
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { QuickAddForm } from "../../src/ui/QuickAddForm";
import { appHarness } from "../app/harness";

// Issue #85: Quick Add's "All fields" lines up: a deliberate grid, the flags on a row of their own,
// the tag box and "Link existing note" spaced like the grid, the List select drawn like the inputs,
// and Time says why it is disabled.

beforeAll(() => {
	(HTMLElement.prototype as unknown as { empty: () => void }).empty = function (this: HTMLElement) {
		this.replaceChildren();
	};
});

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

let container: HTMLElement | null = null;
afterEach(() => {
	if (container !== null) render(null, container);
	container?.remove();
	container = null;
});

async function mountForm(): Promise<HTMLElement> {
	const app = (await appHarness()).app;
	container = document.createElement("div");
	document.body.appendChild(container);
	render(
		<QuickAddForm
			app={app}
			preset={{}}
			locale={() => "en"}
			weekStart={() => "MO"}
			keepOpen={() => false}
			pickNote={async () => null}
			resolveNote={() => []}
			setIcon={(el, icon) => el.setAttribute("data-icon", icon)}
			attachTokenSuggest={() => ({ isOpen: () => false, dispose: () => undefined })}
			onSaved={() => undefined}
			onError={(err) => {
				throw err;
			}}
			onClose={() => undefined}
		/>,
		container,
	);
	await settle();
	return container;
}

const fields = (root: HTMLElement) => root.querySelector<HTMLElement>(".cp-quick-add-fields")!;
const timeInput = (root: HTMLElement) => root.querySelector<HTMLInputElement>('.cp-quick-add-fields input[type="time"]')!;
const dateInput = (root: HTMLElement) => root.querySelector<HTMLInputElement>('.cp-quick-add-fields input[type="date"]')!;

describe("issue #85: All fields", () => {
	it("Time is disabled until there is a date, says so in its label, and describes why", async () => {
		const root = await mountForm();
		const time = timeInput(root);
		expect(time.disabled).toBe(true);
		const label = time.closest("label")!;
		const hint = label.querySelector<HTMLElement>(".cp-field-hint");
		expect(hint).not.toBeNull();
		expect(hint!.textContent).toContain("needs a date");
		expect(time.getAttribute("title")).toBe("Pick a date first");
		const describedBy = time.getAttribute("aria-describedby");
		expect(describedBy).not.toBeNull();
		expect(root.querySelector(`#${CSS.escape(describedBy!)}`)).toBe(hint);
	});

	it("with a date, Time is enabled and the hint is gone", async () => {
		const root = await mountForm();
		const date = dateInput(root);
		date.value = "2026-10-20";
		date.dispatchEvent(new Event("input", { bubbles: true }));
		await settle();
		const time = timeInput(root);
		expect(time.disabled).toBe(false);
		expect(time.closest("label")!.querySelector(".cp-field-hint")).toBeNull();
		expect(time.hasAttribute("aria-describedby")).toBe(false);
		// Preact clears an unset title to "", which shows no tooltip.
		expect(time.getAttribute("title") ?? "").toBe("");
	});

	it("the Urgent and Important flags are one full-width row of the grid", async () => {
		const root = await mountForm();
		const flags = fields(root).querySelector<HTMLElement>(".cp-flags")!;
		expect(flags.classList.contains("cp-field-row")).toBe(true);
		expect(flags.parentElement).toBe(fields(root));
	});

	it("the tag box and Link existing note are full rows of the grid", async () => {
		const root = await mountForm();
		const grid = fields(root);
		const tags = root.querySelector<HTMLElement>(".cp-tag-input")!;
		const note = root.querySelector<HTMLElement>(".cp-quick-add-note")!;
		expect(tags.parentElement?.classList.contains("cp-field-row")).toBe(true);
		expect(tags.parentElement?.parentElement).toBe(grid);
		expect(note.classList.contains("cp-field-row")).toBe(true);
		expect(note.parentElement).toBe(grid);
	});
});

describe("issue #85: All fields stylesheet", () => {
	const css = readFileSync("styles.css", "utf8");

	it("the modal's field grid is three columns, two in a narrow window", () => {
		expect(css).toMatch(/\.checkpoint-quick-add-modal \.cp-quick-add-fields\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
		expect(css).toMatch(/@container cp-qa-fields \(max-width: [0-9]+px\)\s*\{[^}]*\.cp-quick-add-fields\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
	});

	it("full rows span the grid", () => {
		expect(css).toMatch(/\.cp-field-row[^{]*\{[^}]*grid-column:\s*1\s*\/\s*-1/);
	});

	it("the flags row wraps and centers its checkboxes", () => {
		expect(css).toMatch(/\.checkpoint-quick-add-modal \.cp-flags\s*\{[^}]*flex-wrap:\s*wrap/);
		expect(css).toMatch(/\.checkpoint-quick-add-modal \.cp-flags\s*\{[^}]*align-items:\s*center/);
	});

	it("a List select in a field is drawn like the other inputs", () => {
		const rule = css.match(/\.cp-field select\.dropdown\s*\{([^}]*)\}/);
		expect(rule).not.toBeNull();
		expect(rule![1]).toMatch(/background-color:\s*var\(--background-modifier-form-field\)/);
		expect(rule![1]).toMatch(/border:\s*var\(--input-border-width\) solid var\(--background-modifier-border\)/);
		expect(rule![1]).toMatch(/box-shadow:\s*none/);
	});
});
