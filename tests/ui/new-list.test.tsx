// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { paletteColor, type TagColor } from "../../src/domain/types";
import { buildNewListForm, NEW_LIST_ICON_LIMIT } from "../../src/obsidian/modals";
import type { MenuSpec, NewListOptions, NewListValues } from "../../src/ui/host";
import { type AppMount, click, contextMenu, fill, mountApp, mountNode, q as qIn, settle, sidebarItem } from "./app-helpers";

// The one-step "New list" dialog. The form is plain DOM (buildNewListForm), so it is tested
// without Obsidian's Modal; the sidebar test drives the real call through a scripted host.

const ICONS: string[] = ["lucide-book-open", "lucide-book", "lucide-briefcase", "lucide-home", ...Array.from({ length: 300 }, (_, i) => `lucide-zz-${i}`)];

function form(defaultColor: TagColor | null = null, result: string | null = null) {
	const container = mountNode(null);
	const onSubmit = vi.fn<(v: NewListValues) => Promise<string | null>>(async () => result);
	const onCancel = vi.fn();
	const setIcon = (el: HTMLElement, icon: string) => el.setAttribute("data-icon", icon);
	const f = buildNewListForm(container, { setIcon, iconIds: () => ICONS, defaultColor, onSubmit, onCancel });
	const q = <T extends HTMLElement>(sel: string) => qIn<T>(container, sel);
	const type = fill;
	const submit = () => q("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
	const icons = () => [...container.querySelectorAll<HTMLButtonElement>(".cp-icon-choice")];
	const colors = () => [...container.querySelectorAll<HTMLButtonElement>(".cp-color-choice")];
	return { container, f, q, type, submit, icons, colors, onSubmit, onCancel };
}

describe("New list form", () => {
	it("has a name, a searchable icon grid and a color row of 8 colors plus default, as aria-pressed buttons", () => {
		const t = form();
		expect(t.q("input.cp-new-list-name").getAttribute("aria-label")).toBe("List name");
		expect(t.q("input.cp-icon-filter").getAttribute("aria-label")).toBe("Search icons");
		expect(t.colors().map((b) => b.getAttribute("aria-label"))).toEqual(["Default", "Red", "Orange", "Yellow", "Green", "Cyan", "Blue", "Purple", "Pink"]);
		expect(t.colors().map((b) => b.getAttribute("aria-pressed"))).toEqual(["true", ...Array<string>(8).fill("false")]);
		// The groups are named by a visible label, not an aria-label.
		for (const g of t.container.querySelectorAll('[role="group"]')) {
			expect(g.hasAttribute("aria-label")).toBe(false);
			expect(t.container.querySelector(`#${g.getAttribute("aria-labelledby")}`)!.textContent).not.toBe("");
		}
	});

	it("creates with the name, the picked icon and the picked color", () => {
		const t = form();
		t.type(t.q("input.cp-new-list-name"), "  Study  ");
		t.type(t.q("input.cp-icon-filter"), "book");
		expect(t.icons().map((b) => b.getAttribute("data-icon"))).toEqual(["book-open", "book"]);
		t.icons()[0]!.click();
		expect(t.icons()[0]!.getAttribute("aria-pressed")).toBe("true");
		t.colors()[6]!.click();
		expect(t.colors().map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "false", "false", "false", "false", "false", "true", "false", "false"]);
		t.submit();
		expect(t.onSubmit).toHaveBeenCalledWith({ name: "Study", icon: "book-open", color: "blue" });
	});

	it("without a pick the icon is none and the color is default", () => {
		const t = form();
		t.type(t.q("input.cp-new-list-name"), "Plain");
		t.submit();
		expect(t.onSubmit).toHaveBeenCalledWith({ name: "Plain", icon: null, color: null });
	});

	it("an empty name shows an inline error and does not submit", () => {
		const t = form();
		t.submit();
		expect(t.onSubmit).not.toHaveBeenCalled();
		expect(t.q(".cp-new-list-error").hidden).toBe(false);
		expect(t.q(".cp-new-list-error").getAttribute("role")).toBe("alert");
		expect(t.q("input.cp-new-list-name").getAttribute("aria-invalid")).toBe("true");
	});

	it("searches all icons, draws a bounded grid, and Cancel dismisses", () => {
		const t = form();
		t.type(t.q("input.cp-icon-filter"), "zz");
		expect(t.icons()).toHaveLength(NEW_LIST_ICON_LIMIT);
		t.type(t.q("input.cp-icon-filter"), "nothing-like-this");
		expect(t.icons()).toHaveLength(0);
		expect(t.container.textContent).toContain("No icons match.");
		[...t.container.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!.click();
		expect(t.onCancel).toHaveBeenCalled();
	});

	it("the grid has one tab stop and arrow keys, Home and End move inside it; pressing the chosen icon again clears it", () => {
		const t = form();
		t.type(t.q("input.cp-icon-filter"), "book");
		const [a, b] = t.icons();
		expect(a!.tabIndex).toBe(0);
		expect(b!.tabIndex).toBe(-1);
		a!.focus();
		a!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
		expect(document.activeElement).toBe(b);
		expect(b!.tabIndex).toBe(0);
		b!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }));
		expect(document.activeElement).toBe(a);
		a!.click();
		a!.click();
		expect(a!.getAttribute("aria-pressed")).toBe("false");
		t.type(t.q("input.cp-new-list-name"), "X");
		t.submit();
		expect(t.onSubmit).toHaveBeenCalledWith({ name: "X", icon: null, color: null });
	});

	it("Enter in the icon search does not submit the form", () => {
		const t = form();
		const e = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
		t.q("input.cp-icon-filter").dispatchEvent(e);
		expect(e.defaultPrevented).toBe(true);
	});
});

describe("New list form: preselected color and inline errors", () => {
	it("preselects the given color; the Default swatch means no color", async () => {
		const t = form("green");
		expect(t.colors().map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "false", "false", "false", "true", "false", "false", "false", "false"]);
		t.type(t.q("input.cp-new-list-name"), "A");
		t.submit();
		await settle();
		expect(t.onSubmit).toHaveBeenLastCalledWith({ name: "A", icon: null, color: "green" });
		t.colors()[0]!.click();
		t.submit();
		await settle();
		expect(t.onSubmit).toHaveBeenLastCalledWith({ name: "A", icon: null, color: null });
	});

	it("an error from the create call shows inline, keeps the typed values and does not dismiss", async () => {
		const t = form("red", "A list named Work already exists.");
		t.type(t.q("input.cp-new-list-name"), "Work");
		t.type(t.q("input.cp-icon-filter"), "book");
		t.icons()[0]!.click();
		t.submit();
		await settle();
		const error = t.q(".cp-new-list-error");
		expect(error.hidden).toBe(false);
		expect(error.textContent).toBe("A list named Work already exists.");
		expect(t.q<HTMLInputElement>("input.cp-new-list-name").value).toBe("Work");
		expect(t.q("input.cp-new-list-name").getAttribute("aria-invalid")).toBe("true");
		expect(t.icons()[0]!.getAttribute("aria-pressed")).toBe("true");
		expect(t.colors()[1]!.getAttribute("aria-pressed")).toBe("true");
		expect(t.onCancel).not.toHaveBeenCalled();
		// Typing clears the error.
		t.type(t.q("input.cp-new-list-name"), "Work 2");
		expect(error.hidden).toBe(true);
	});
});

describe("the sidebar's + uses the dialog", () => {
	/** A scripted dialog: each entry is what the user submits; `outcomes` collects the create results. */
	const scripted = async (...submits: (NewListValues | null)[]) => {
		const m = await mountApp();
		const outcomes: (string | null)[] = [];
		const opened: NewListOptions[] = [];
		const newList = vi.fn(async (opts: NewListOptions) => {
			opened.push(opts);
			for (const v of submits.splice(0)) {
				if (v === null) return;
				const r = await opts.create(v);
				outcomes.push(r);
				if (r === null) return;
			}
		});
		(m.host as unknown as { newList: typeof newList }).newList = newList;
		return { m, newList, outcomes, opened };
	};
	const plus = (m: AppMount) => m.root.querySelector<HTMLButtonElement>('.cp-sidebar [aria-label="New list"]');
	const listNamed = (m: AppMount, name: string) => [...m.h.app.store.state.categories.values()].find((c) => c.name === name);

	it("creates the list with its icon and color in one undo step", async () => {
		const { m, newList } = await scripted({ name: "Study", icon: "book-open", color: "purple" });
		const create = vi.spyOn(m.h.app.categories, "create");
		await click(plus(m));
		expect(newList).toHaveBeenCalledTimes(1);
		expect(create).toHaveBeenCalledWith("Study", "book-open", "purple");
		expect(listNamed(m, "Study")).toMatchObject({ icon: "book-open", color: "purple" });
		expect(m.root.querySelector(".cp-sidebar")!.textContent).toContain("Study");
		expect(await m.h.app.store.undo()).toBe("Create list");
		expect(listNamed(m, "Study")).toBeUndefined();
	});

	it("the dialog preselects the next palette color; Default (null) creates a list with no color", async () => {
		const { m, opened } = await scripted({ name: "Plain", icon: null, color: null }, null);
		const create = vi.spyOn(m.h.app.categories, "create");
		const next = paletteColor([...m.h.app.store.state.categories.values()].filter((c) => !c.isInbox).length);
		await click(plus(m));
		expect(opened[0]!.defaultColor).toBe(next);
		expect(create).toHaveBeenCalledWith("Plain", null, null);
		expect(listNamed(m, "Plain")!.color).toBeNull();
	});

	it("a duplicate name returns the message to the dialog, which stays open until a valid name", async () => {
		const { m, outcomes } = await scripted({ name: "Work", icon: null, color: "red" }, { name: "Work 2", icon: null, color: "red" });
		await m.h.app.categories.create("Work");
		await click(plus(m));
		expect(outcomes).toHaveLength(2);
		expect(outcomes[0]).toMatch(/already|exists/i);
		expect(outcomes[1]).toBeNull();
		expect(listNamed(m, "Work 2")).toBeDefined();
		// The error was shown inline, not as a notice.
		expect(m.host.messages).toEqual([]);
	});

	it("dismissing the dialog creates nothing", async () => {
		const { m } = await scripted(null);
		const before = m.h.app.store.state.categories.size;
		await click(plus(m));
		await settle();
		expect(m.h.app.store.state.categories.size).toBe(before);
	});
});

describe("the list menu's Move up and Move down", () => {
	const menuOf = (m: AppMount, name: string) => contextMenu(m, sidebarItem(m.root, name));
	const moves = (menu: MenuSpec) =>
		menu.flatMap((i) => (i !== "separator" && i.title.startsWith("Move ") ? [`${i.title}${i.disabled === true ? " (off)" : ""}`] : []));

	it("#129: the Inbox offers neither; the first list cannot move up and the last cannot move down", async () => {
		const m = await mountApp();
		await m.h.app.categories.create("A");
		await m.h.app.categories.create("B");
		await m.h.app.categories.create("C");
		await settle();
		expect(moves(await menuOf(m, "Inbox"))).toEqual([]);
		expect(moves(await menuOf(m, "A"))).toEqual(["Move up (off)", "Move down"]);
		expect(moves(await menuOf(m, "B"))).toEqual(["Move up", "Move down"]);
		expect(moves(await menuOf(m, "C"))).toEqual(["Move up", "Move down (off)"]);
	});
});
