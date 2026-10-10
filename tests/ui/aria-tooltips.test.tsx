// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { INBOX_ID } from "../../src/domain/types";
import type { MenuSpec } from "../../src/ui/host";
import { mountApp } from "./quick-add.helpers";

// Regression: Obsidian shows a hover tooltip for ANY element that has an `aria-label`
// attribute. Non-interactive containers (nav, listbox, groups, dialogs, ...) used to carry
// aria-label for screen readers, so hovering anywhere in the sidebar showed a stray
// "Task lists" tooltip and hovering a task row showed the list's label. Containers must
// be named with aria-labelledby instead; aria-label stays on controls.

beforeAll(() => {
	(HTMLElement.prototype as unknown as { empty: () => void }).empty = function (this: HTMLElement) {
		this.replaceChildren();
	};
});

const mounted: { unmount: () => void }[] = [];
afterEach(() => {
	for (const m of mounted.splice(0)) m.unmount();
});
const settle = async () => {
	for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

/**
 * Where an aria-label is allowed: elements the pointer actually targets as a control, where
 * a tooltip naming the control is wanted (icon-only buttons, inputs without visible text).
 * - button, input, select, textarea, a: native interactive controls. This covers role=tab
 *   (our tabs are buttons), the task checkbox and the add-bar input.
 * - [role=img]: the "Has description note" meta icon, whose tooltip is the point.
 * Everything else (nav, div/section/ul with role listbox, group, list, tablist, dialog, ...)
 * is a container: hovering anywhere inside it would surface the tooltip, anchored to the
 * container rather than the pointer. Rows (role=option) are deliberately not on the list:
 * their text content names them.
 */
const ALLOWED = ["button", "input", "select", "textarea", "a", '[role="img"]'];

function strayAriaLabels(root: ParentNode): string[] {
	return [...root.querySelectorAll<HTMLElement>("[aria-label]")]
		.filter((el) => !ALLOWED.some((sel) => el.matches(sel)))
		.map((el) => `<${el.tagName.toLowerCase()} class="${el.className}" role="${el.getAttribute("role") ?? ""}" aria-label="${el.getAttribute("aria-label")}">`);
}

/** The accessible name that aria-labelledby resolves to, or null if it does not resolve. */
function labelledBy(el: Element): string | null {
	const ids = (el.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
	if (ids.length === 0) return null;
	const doc = el.ownerDocument;
	const parts = ids.map((id) => doc.getElementById(id)?.textContent?.trim() ?? "");
	return parts.some((p) => p === "") ? null : parts.join(" ");
}

/** Every aria-labelledby in scope resolves to non-empty text, and ids are unique per document. */
function expectLabelsResolve(root: ParentNode) {
	const ids = [...document.querySelectorAll("[id]")].map((e) => e.id);
	expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
	for (const el of root.querySelectorAll("[aria-labelledby]")) {
		expect(labelledBy(el), `unresolved aria-labelledby on <${el.tagName.toLowerCase()} class="${el.className}">`).not.toBeNull();
	}
}

const nameOf = (root: ParentNode, sel: string) => labelledBy(root.querySelector(sel)!);

async function mount() {
	const m = await mountApp();
	mounted.push(m);
	return m;
}
const click = async (el: Element | null) => {
	if (el === null) throw new Error("element not found");
	(el as HTMLElement).click();
	await settle();
};

async function seed(h: Awaited<ReturnType<typeof mount>>["h"]) {
	const cat = await h.app.categories.create("Work", "briefcase");
	await h.app.tags.create("urgent", "red");
	await h.app.tasks.create({ title: "Today task", scheduled: { kind: "date", date: "2026-10-01" } });
	await h.app.tasks.create({ title: "Later task", categoryId: cat.id, tagKeys: ["urgent"], scheduled: { kind: "date", date: "2026-10-03" } });
	const done = await h.app.tasks.create({ title: "Done task" });
	await h.app.tasks.complete(done.task.id);
}

describe("no stray aria-label tooltips", () => {
	it("the sidebar, the task list and the rail carry no aria-label on containers", async () => {
		const m = await mount();
		await seed(m.h);
		await settle();
		expect(m.root.querySelectorAll(".cp-task-row").length).toBeGreaterThan(0);
		expect(strayAriaLabels(m.root)).toEqual([]);
		expectLabelsResolve(m.root);
		// Accessibility did not regress: the landmarks keep their names.
		expect(nameOf(m.root, ".cp-rail")).toBe("Sections");
		expect(nameOf(m.root, ".cp-sidebar")).toBe("Task lists");
		expect(nameOf(m.root, ".cp-tasks .cp-task-list")).toBe("Today");
		expect(m.root.querySelector(".cp-sidebar")!.hasAttribute("aria-label")).toBe(false);
		expect(m.root.querySelector(".cp-tasks .cp-task-list")!.hasAttribute("aria-label")).toBe(false);
	});

	it("rows and groups in a grouped view and the completed group", async () => {
		const m = await mount();
		await seed(m.h);
		await click([...m.root.querySelectorAll<HTMLElement>(".cp-sidebar-item")].find((e) => e.textContent?.includes("Upcoming"))!);
		const groups = [...m.root.querySelectorAll<HTMLElement>(".cp-tasks .cp-task-group")];
		expect(groups.length).toBeGreaterThan(0);
		for (const g of groups) {
			expect(g.hasAttribute("aria-label")).toBe(false);
			expect(labelledBy(g)).toBe(g.querySelector(".cp-group-heading span")!.textContent);
		}
		expect(strayAriaLabels(m.root)).toEqual([]);
		expectLabelsResolve(m.root);
	});

	it("the view menu button, the Completed group, the details pane and search groups", async () => {
		const m = await mount();
		await seed(m.h);
		await new Promise((r) => setTimeout(r, 600));
		await settle();
		// The ⋯ button is a control, so its aria-label is allowed; the Completed group is named by its heading.
		expect(m.root.querySelector('.cp-tasks [aria-label="View options"]')).not.toBeNull();
		await click([...m.root.querySelectorAll<HTMLElement>(".cp-sidebar-item")].find((e) => e.textContent?.includes("Inbox"))!);
		await click(m.root.querySelector(".cp-tasks .cp-completed-toggle"));
		expect(nameOf(m.root, ".cp-tasks .cp-completed-group")).toBe("Completed · 1");
		expect(m.root.querySelector(".cp-tasks .cp-completed-group")!.hasAttribute("aria-label")).toBe(false);
		await click([...m.root.querySelectorAll<HTMLElement>(".cp-sidebar-item")].find((e) => e.textContent?.includes("Today"))!);
		// Details pane.
		await click(m.root.querySelector(".cp-tasks .cp-task-row"));
		expect(m.root.querySelector(".cp-tasks .cp-details")).not.toBeNull();
		expect(nameOf(m.root, ".cp-tasks .cp-details")).toBe("Task details");
		// Search section: mounted a second time next to Tasks, so ids must not collide.
		await click(m.root.querySelector('.cp-rail [aria-label="Search"]'));
		const search = m.root.querySelector<HTMLInputElement>('.cp-search input[type="search"]')!;
		search.value = "task";
		search.dispatchEvent(new Event("input", { bubbles: true }));
		await settle();
		const groups = [...m.root.querySelectorAll<HTMLElement>(".cp-search section.cp-search-group")];
		expect(groups.map((g) => labelledBy(g))).toEqual(["Tasks"]);
		expect(nameOf(m.root, ".cp-search .cp-task-list")).toBe("Search results");
		expect(m.root.querySelector(".cp-search .cp-completed-group")).not.toBeNull();
		expect(nameOf(m.root, ".cp-search .cp-completed-group")).toBe("Completed");
		expect(strayAriaLabels(m.root)).toEqual([]);
		expectLabelsResolve(m.root);
	});

	it("K1b section headings, the board's section columns and the name field carry no stray aria-label", async () => {
		const m = await mount();
		await seed(m.h);
		const alpha = await m.h.app.sections.create(INBOX_ID, "Alpha");
		await m.h.app.tasks.create({ title: "In alpha", sectionId: alpha.id });
		await settle();
		await click([...m.root.querySelectorAll<HTMLElement>(".cp-sidebar-item")].find((e) => e.textContent?.includes("Inbox"))!);
		// The section headings show under "Group by: Section".
		const menus: MenuSpec[] = [];
		(m.host as unknown as { showMenu: (at: unknown, items: MenuSpec) => void }).showMenu = (_at, items) => void menus.push(items);
		const run = async (title: string) => {
			const item = menus.at(-1)!.find((i) => i !== "separator" && i.title === title);
			if (item === undefined || item === "separator") throw new Error(`no menu item ${title}`);
			item.run();
			await settle();
		};
		await click(m.root.querySelector('.cp-tasks [aria-label="View options"]'));
		await run("Group by…");
		await run("Section");
		const groups = [...m.root.querySelectorAll<HTMLElement>(".cp-tasks .cp-section-group")];
		expect(groups.length).toBe(2);
		for (const g of groups) {
			expect(g.hasAttribute("aria-label")).toBe(false);
			expect(labelledBy(g)).toBe(g.querySelector(".cp-section-toggle span[id]")!.textContent);
		}
		// The controls keep their labels (a tooltip naming a control is wanted).
		expect(m.root.querySelector('.cp-tasks [aria-label="Add task to Alpha"]')).not.toBeNull();
		expect(m.root.querySelector('.cp-tasks [aria-label="Options for section Alpha"]')).not.toBeNull();
		expect(strayAriaLabels(m.root)).toEqual([]);
		expectLabelsResolve(m.root);
		// Board mode, with the name field open.
		await click([...m.root.querySelectorAll<HTMLElement>(".cp-tasks .cp-mode-button")].find((b) => b.textContent.trim() === "Board")!);
		await click(m.root.querySelector(".cp-tasks .cp-board-add-section"));
		expect(m.root.querySelector(".cp-tasks .cp-section-name-input")).not.toBeNull();
		expect(strayAriaLabels(m.root)).toEqual([]);
		expectLabelsResolve(m.root);
	});

	it("the add-bar chip list and its open chip panel", async () => {
		const m = await mount();
		await seed(m.h);
		const input = m.root.querySelector<HTMLInputElement>('.cp-add-bar input[aria-label="Add task"]')!;
		input.value = "Call mom tomorrow #Work";
		input.dispatchEvent(new Event("input", { bubbles: true }));
		await settle();
		expect(nameOf(m.root, ".cp-add-bar .cp-qa-chips")).toBe("Recognized items");
		await click(m.root.querySelector(".cp-add-bar .cp-qa-chip-main"));
		const panel = m.root.querySelector<HTMLElement>(".cp-add-bar .cp-qa-panel");
		expect(panel).not.toBeNull();
		expect(panel!.hasAttribute("aria-label")).toBe(false);
		expect(labelledBy(panel!)).toBe(panel!.querySelector(".cp-qa-panel-title")!.textContent);
		expect(strayAriaLabels(m.root)).toEqual([]);
		expectLabelsResolve(m.root);
	});

	it("the date popover (both tabs) and the more menu (every sub-view)", async () => {
		const m = await mount();
		await seed(m.h);
		const bar = m.root.querySelector<HTMLElement>(".cp-add-bar")!;
		const tool = (label: string) => bar.querySelector<HTMLElement>(`.cp-qa-tool[aria-label="${label}"]`);

		await click(tool("Date"));
		const date = bar.querySelector<HTMLElement>(".cp-date-pop")!;
		expect(labelledBy(date)).toBe("Date and duration");
		expect(nameOf(date, '[role="tablist"]')).toBe("Date or duration");
		const cal = date.querySelector<HTMLElement>(".cp-cal")!;
		expect(labelledBy(cal)).toBe(date.querySelector(".cp-cal-title")!.textContent);
		expect(strayAriaLabels(m.root)).toEqual([]);
		expectLabelsResolve(m.root);

		await click([...date.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === "Duration")!);
		expect(nameOf(date, ".cp-dur-presets")).toBe("Duration");
		expect(strayAriaLabels(m.root)).toEqual([]);
		expectLabelsResolve(m.root);

		await click(tool("Priority, list, tags and note"));
		const more = bar.querySelector<HTMLElement>(".cp-more-pop")!;
		expect(labelledBy(more)).toBe("Priority, list, tags and note");
		expect(nameOf(more, ".cp-pri-flags")).toBe("Priority");
		expect(strayAriaLabels(m.root)).toEqual([]);
		expectLabelsResolve(m.root);

		for (const [row, title] of [
			["list", "List"],
			["tags", "Tags"],
			["quadrant", "Matrix quadrant"],
		] as const) {
			await click(bar.querySelector(`.cp-pop-row[data-row="${row}"]`));
			expect(nameOf(bar, ".cp-pop-choices")).toBe(title);
			expect(strayAriaLabels(m.root)).toEqual([]);
			expectLabelsResolve(m.root);
			await click(bar.querySelector(".cp-pop-back"));
		}
	});

	it("the matrix: quadrants are named by aria-labelledby, only the add buttons carry aria-label", async () => {
		const m = await mount();
		await seed(m.h);
		await settle();
		await click(m.root.querySelector('.cp-rail [aria-label="Matrix"]'));
		const sections = [...m.root.querySelectorAll<HTMLElement>(".cp-matrix section.cp-matrix-q")];
		expect(sections.map((s) => labelledBy(s))).toEqual(["Urgent & important", "Important, not urgent", "Urgent, not important", "Neither"]);
		for (const s of sections) expect(s.hasAttribute("aria-label")).toBe(false);
		expect(m.root.querySelectorAll(".cp-matrix .cp-matrix-q-add[aria-label]")).toHaveLength(4);
		const lists = [...m.root.querySelectorAll<HTMLElement>(".cp-matrix .cp-task-list")];
		expect(lists.length).toBeGreaterThan(0);
		for (const l of lists) expect(l.hasAttribute("aria-label")).toBe(false);
		for (const g of m.root.querySelectorAll<HTMLElement>(".cp-matrix .cp-task-group")) expect(labelledBy(g)).not.toBeNull();
		expect(strayAriaLabels(m.root)).toEqual([]);
		expectLabelsResolve(m.root);
	});

	it("the board: columns are named by aria-labelledby, only controls carry aria-label", async () => {
		const m = await mount();
		await seed(m.h);
		await settle();
		const mode = m.root.querySelector<HTMLElement>(".cp-tasks .cp-mode-switch")!;
		expect(mode.hasAttribute("aria-label")).toBe(false);
		expect(labelledBy(mode)).toBe("Layout");
		await click([...mode.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent?.trim() === "Board")!);
		const cols = [...m.root.querySelectorAll<HTMLElement>(".cp-tasks section.cp-board-col")];
		expect(cols.map((c) => labelledBy(c))).toEqual(["Today"]);
		for (const c of cols) expect(c.hasAttribute("aria-label")).toBe(false);
		for (const l of m.root.querySelectorAll<HTMLElement>(".cp-tasks .cp-board-cards")) {
			expect(l.hasAttribute("aria-label")).toBe(false);
			expect(labelledBy(l)).not.toBeNull();
		}
		expect(m.root.querySelectorAll(".cp-tasks .cp-board-item").length).toBeGreaterThan(0);
		// The "+" is a control and keeps its label.
		expect(m.root.querySelector('.cp-board .cp-board-add[aria-label="Add task to Today"]')).not.toBeNull();
		expect(strayAriaLabels(m.root)).toEqual([]);
		expectLabelsResolve(m.root);
	});

	it("the stylesheet hides .cp-sr-only visually, not with display:none", () => {
		const css = readFileSync("styles.css", "utf8");
		const rule = /\.checkpoint-view \.cp-sr-only[^{]*\{([^}]*)\}/.exec(css)?.[1] ?? "";
		for (const decl of [
			"position: absolute",
			"width: 1px",
			"height: 1px",
			"padding: 0",
			"margin: -1px",
			"overflow: hidden",
			"clip: rect(0, 0, 0, 0)",
			"white-space: nowrap",
			"border: 0",
		]) {
			expect(rule).toContain(decl);
		}
		expect(rule).not.toMatch(/display:\s*none|visibility:\s*hidden/);
	});

	it("the stray-label check itself rejects a labelled container and accepts controls", () => {
		const host = document.createElement("div");
		const add = (tag: string, role?: string) => {
			const el = document.createElement(tag);
			el.setAttribute("aria-label", "Some label");
			if (role !== undefined) el.setAttribute("role", role);
			host.appendChild(el);
		};
		add("nav");
		add("button");
		add("span", "img");
		expect(strayAriaLabels(host)).toHaveLength(1);
	});
});
