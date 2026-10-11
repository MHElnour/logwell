// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { newTagProblem } from "../../src/domain/tags";
import type { Tag, TagColor } from "../../src/domain/types";
import { buildTagForm } from "../../src/obsidian/tagDialog";
import type { TagDialogValues } from "../../src/ui/host";

// The New tag / Edit tag form (Lists, sections and tags rule 23b). Plain DOM, tested without Obsidian's Modal: the name
// is checked as typed through the caller's check, the first problem shows, and the submit button stays off until the
// name is valid.

const HINT = "Each tag name can be used only once in Logwell. Use letters, digits, hyphens (-) and underscores (_).";
const TS = "2026-10-01T10:00:00Z";
const tags = new Map<string, Tag>(
	[
		["calls", "Calls"],
		["home", "Home"],
		["home/garden", "Home/Garden"],
	].map(([key, displayName]) => [key!, { key: key!, displayName: displayName!, color: null, createdAt: TS, modifiedAt: TS }]),
);

function form(
	options: { initial?: TagDialogValues; submitLabel?: "Create" | "Save"; parentLock?: string | null; except?: string | null; result?: string | null } = {},
) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const onSubmit = vi.fn<(v: TagDialogValues) => Promise<string | null>>(async () => options.result ?? null);
	const onCancel = vi.fn();
	const f = buildTagForm(container, {
		submitLabel: options.submitLabel ?? "Create",
		initial: options.initial ?? { name: "", parent: null, color: "orange" },
		parents: [
			{ key: "calls", label: "Calls" },
			{ key: "home", label: "Home" },
		],
		parentLock: options.parentLock ?? null,
		check: (name, parent) => newTagProblem(tags, name, parent, options.except ?? null),
		onSubmit,
		onCancel,
	});
	const q = <T extends HTMLElement>(sel: string) => container.querySelector<T>(sel)!;
	const name = () => q<HTMLInputElement>("input.cp-new-list-name");
	const select = () => q<HTMLSelectElement>("select");
	const error = () => q(".cp-new-list-error");
	const submitButton = () => q<HTMLButtonElement>('button[type="submit"]');
	const type = (v: string) => {
		name().value = v;
		name().dispatchEvent(new Event("input", { bubbles: true }));
	};
	const pick = (v: string) => {
		select().value = v;
		select().dispatchEvent(new Event("change", { bubbles: true }));
	};
	const submit = () => q("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
	const colors = () => [...container.querySelectorAll<HTMLButtonElement>(".cp-color-choice")];
	return { container, f, q, name, select, error, submitButton, type, pick, submit, colors, onSubmit, onCancel };
}

const settle = async () => {
	for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeAll(() => {
	// Obsidian's createEl, which happy-dom does not have.
	(HTMLElement.prototype as unknown as { createEl: unknown }).createEl = function (this: HTMLElement, tag: string, o: { cls?: string; attr?: Record<string, string> } = {}) {
		const node = this.ownerDocument.createElement(tag);
		if (o.cls !== undefined) node.className = o.cls;
		for (const [k, v] of Object.entries(o.attr ?? {})) node.setAttribute(k, v);
		this.appendChild(node);
		return node;
	};
});
afterEach(() => document.body.replaceChildren());

describe("tag form: fields", () => {
	it("has a labelled name with maxlength 64 and the hint, a Parent select (None first) and a color row", () => {
		const t = form();
		const input = t.name();
		expect(input.getAttribute("maxlength")).toBe("64");
		expect(t.container.querySelector(`label[for="${input.id}"]`)!.textContent).toBe("Name");
		const described = input.getAttribute("aria-describedby")!.split(" ");
		expect(described.map((id) => t.container.querySelector(`#${id}`)!.textContent)).toContain(HINT);
		expect(described).toContain(t.error().id);
		expect(t.container.querySelector(`label[for="${t.select().id}"]`)!.textContent).toBe("Parent");
		expect([...t.select().options].map((o) => [o.value, o.textContent])).toEqual([
			["", "None"],
			["calls", "Calls"],
			["home", "Home"],
		]);
		expect(t.colors()).toHaveLength(9);
		// The preselected color is the one given (the next palette color for a new tag).
		expect(t.colors()[2]!.getAttribute("aria-pressed")).toBe("true");
		expect(t.submitButton().textContent).toBe("Create");
		// Containers are named by visible labels, never by aria-label.
		for (const g of t.container.querySelectorAll('[role="group"]')) expect(g.hasAttribute("aria-label")).toBe(false);
	});

	it("a locked parent is disabled with its hint", () => {
		const t = form({ submitLabel: "Save", initial: { name: "Home", parent: null, color: null }, parentLock: "A tag with child tags has no parent.", except: "home" });
		expect(t.select().disabled).toBe(true);
		const hintId = t.select().getAttribute("aria-describedby")!;
		expect(t.container.querySelector(`#${hintId}`)!.textContent).toBe("A tag with child tags has no parent.");
	});

	it("Cancel dismisses", () => {
		const t = form();
		[...t.container.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!.click();
		expect(t.onCancel).toHaveBeenCalled();
	});
});

describe("tag form: live check", () => {
	it("an empty new form has Create off and shows no message until the name is touched", () => {
		const t = form();
		expect(t.submitButton().disabled).toBe(true);
		expect(t.error().hidden).toBe(true);
		t.type("x");
		t.type("");
		expect(t.error().hidden).toBe(false);
		expect(t.error().textContent).toBe("Enter a name.");
		expect(t.name().getAttribute("aria-invalid")).toBe("true");
	});

	it("shows the first problem as typed and turns Create on for a valid name", () => {
		const t = form();
		const cases: [string, string][] = [
			["phone calls", "Use one word: spaces are not allowed. Try a hyphen, like phone-calls."],
			["home/garden", 'Pick a parent below instead of typing "/".'],
			["@calls", 'Leave out the "@"; it is added for you.'],
			["a$b", "Only letters, digits, hyphens (-) and underscores (_) are allowed."],
			["x".repeat(65), "Use at most 64 characters."],
			["CALLS", 'The name "Calls" is already used by another tag.'],
			["garden", 'The name "Garden" is already used by another tag.'],
		];
		for (const [typed, message] of cases) {
			t.type(typed);
			expect(t.error().textContent).toBe(message);
			expect(t.submitButton().disabled).toBe(true);
		}
		t.type("Phone");
		expect(t.error().hidden).toBe(true);
		expect(t.name().hasAttribute("aria-invalid")).toBe(false);
		expect(t.submitButton().disabled).toBe(false);
	});

	it("re-checks when the parent changes", () => {
		const t = form();
		t.type("calls");
		expect(t.submitButton().disabled).toBe(true);
		t.type("Home");
		t.pick("home");
		expect(t.error().textContent).toBe("A tag can't have the same name as its parent.");
		t.pick("");
		expect(t.error().textContent).toBe('The name "Home" is already used by another tag.');
	});

	it("submitting while invalid does nothing", async () => {
		const t = form();
		t.submit();
		await settle();
		expect(t.onSubmit).not.toHaveBeenCalled();
		expect(t.error().textContent).toBe("Enter a name.");
	});
});

describe("tag form: submit", () => {
	it("submits the trimmed name, the parent and the color", async () => {
		const t = form();
		t.type("  Phone  ");
		t.pick("home");
		t.colors()[0]!.click();
		t.submit();
		await settle();
		expect(t.onSubmit).toHaveBeenCalledWith({ name: "Phone", parent: "home", color: null as TagColor | null });
	});

	it("a message from the save shows inline and keeps the values; the button turns back on", async () => {
		const t = form({ result: "The parent tag no longer exists." });
		t.type("Phone");
		t.pick("home");
		t.submit();
		await settle();
		expect(t.error().textContent).toBe("The parent tag no longer exists.");
		expect(t.error().hidden).toBe(false);
		expect(t.name().value).toBe("Phone");
		expect(t.select().value).toBe("home");
		expect(t.submitButton().disabled).toBe(false);
		expect(t.onCancel).not.toHaveBeenCalled();
	});

	it("a second submit while the first runs is ignored", async () => {
		const t = form();
		let release: (v: string | null) => void = () => undefined;
		t.onSubmit.mockImplementation(() => new Promise((r) => (release = r)));
		t.type("Phone");
		t.submit();
		t.submit();
		expect(t.onSubmit).toHaveBeenCalledTimes(1);
		expect(t.submitButton().disabled).toBe(true);
		release(null);
		await settle();
	});

	it("Edit starts filled in, valid, with its own name allowed and Save on", () => {
		const t = form({ submitLabel: "Save", initial: { name: "Calls", parent: null, color: "blue" }, except: "calls" });
		expect(t.name().value).toBe("Calls");
		expect(t.submitButton().textContent).toBe("Save");
		expect(t.submitButton().disabled).toBe(false);
		expect(t.error().hidden).toBe(true);
		t.type("");
		expect(t.error().textContent).toBe("Enter a name.");
	});

	it("an edit keeps a current parent that the list does not offer", () => {
		const t = form({ submitLabel: "Save", initial: { name: "Garden", parent: "work", color: null }, except: "work/garden" });
		expect(t.select().value).toBe("work");
	});
});
