// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { ACCENTS, DEFAULT_SETTINGS, sanitizeSettings } from "../../src/app/settings";
import { accentClass } from "../../src/ui/accent";
import { ICON, categoryIcon } from "../../src/ui/icons";
import { click, mountApp, q, settle } from "./app-helpers";
import { css } from "./styles-helpers";

// Design tokens' markup hooks, rail and sidebar, accent, empty states.

const iconOf = (el: Element | null) => el?.querySelector("[data-icon]")?.getAttribute("data-icon");

describe("accent setting", () => {
	it("defaults to theme and sanitizes unknown values", () => {
		expect(DEFAULT_SETTINGS.accent).toBe("theme");
		expect(sanitizeSettings({ accent: "purple" }).accent).toBe("purple");
		expect(sanitizeSettings({ accent: "hotpink" }).accent).toBe("theme");
		expect(sanitizeSettings({ accent: 3 }).accent).toBe("theme");
		expect(sanitizeSettings(null).accent).toBe("theme");
		expect([...ACCENTS]).toEqual(["theme", "purple", "blue", "green", "orange"]);
	});

	it("accentClass maps the setting to a class", () => {
		expect(accentClass({ ...DEFAULT_SETTINGS, accent: "theme" })).toBe("cp-accent-theme");
		expect(accentClass({ ...DEFAULT_SETTINGS, accent: "orange" })).toBe("cp-accent-orange");
	});

	it("puts the accent class on the app container and follows a change", async () => {
		const { host, root, rerender } = await mountApp();
		const app = () => root.querySelector(".cp-app")!;
		expect(app().classList.contains("cp-theme")).toBe(true);
		expect(app().classList.contains("cp-accent-theme")).toBe(true);
		host.settings = () => ({ ...DEFAULT_SETTINGS, accent: "green" });
		await rerender();
		expect(app().classList.contains("cp-accent-green")).toBe(true);
		expect(app().classList.contains("cp-accent-theme")).toBe(false);
	});
});

describe("rail", () => {
	it("shows only the built sections with the spec icons and labels", async () => {
		const { root } = await mountApp();
		const buttons = [...root.querySelectorAll<HTMLElement>(".cp-rail button")];
		expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(["Tasks", "Calendar", "Focus", "Habits", "Matrix", "Search", "Data"]);
		expect(buttons.map(iconOf)).toEqual([ICON.railTasks, ICON.railCalendar, ICON.railFocus, ICON.railHabits, ICON.railMatrix, ICON.railSearch, ICON.railData]);
		expect([ICON.railTasks, ICON.railCalendar, ICON.railFocus, ICON.railHabits, ICON.railMatrix]).toEqual(["square-check", "calendar", "target", "flame", "layout-grid"]);
		expect(buttons[0]!.classList.contains("is-active")).toBe(true);
		expect(buttons[0]!.getAttribute("aria-pressed")).toBe("true");
		expect(buttons[1]!.classList.contains("is-active")).toBe(false);
		expect(buttons[2]!.classList.contains("is-active")).toBe(false);
	});

	it("puts Data last, at the bottom, after a flexible spacer (mockup .rail-spacer)", async () => {
		const { root } = await mountApp();
		const rail = root.querySelector<HTMLElement>(".cp-rail")!;
		const kids = [...rail.children] as HTMLElement[];
		expect(kids.map((k) => k.getAttribute("aria-label") ?? k.className)).toEqual(["Tasks", "Calendar", "Focus", "Habits", "Matrix", "Search", "cp-rail-spacer", "Data"]);
		expect(kids[6]!.getAttribute("aria-hidden")).toBe("true");
		// Keyboard order stays the DOM order, and the spacer is not focusable.
		expect(rail.querySelectorAll("button")).toHaveLength(7);
		expect(kids[7]!.getAttribute("aria-label")).toBe("Data");
		expect(css).toMatch(/\.cp-rail-spacer\s*\{[^}]*flex:\s*1 1 auto/);
	});

	it("Data keeps its active state after the spacer", async () => {
		const { root } = await mountApp();
		root.querySelector<HTMLElement>('.cp-rail [aria-label="Data"]')!.click();
		await settle();
		const data = root.querySelector<HTMLElement>('.cp-rail [aria-label="Data"]')!;
		expect(data.classList.contains("is-active")).toBe(true);
		expect(data.getAttribute("aria-pressed")).toBe("true");
	});

	it.each([
		["calendar", "Calendar", ".cp-calendar"],
		["focus", "Focus", ".cp-focus"],
		["habits", "Habits", ".cp-habits"],
		["matrix", "Matrix", ".cp-matrix"],
	] as const)("the %s section is shown only while its rail button is active, and the app handle shows it", async (id, label, root) => {
		const m = await mountApp();
		const section = () => q(m.root, root).closest<HTMLElement>(".cp-section")!;
		const button = () => q(m.root, `.cp-rail [aria-label="${label}"]`);
		expect(section().hidden).toBe(true);
		await click(button());
		expect(section().hidden).toBe(false);
		expect(button().getAttribute("aria-pressed")).toBe("true");
		expect(button().classList.contains("is-active")).toBe(true);
		await click(q(m.root, '.cp-rail [aria-label="Tasks"]'));
		expect(section().hidden).toBe(true);
		expect(button().getAttribute("aria-pressed")).toBe("false");
		m.handle.current!.showSection(id);
		await settle();
		expect(section().hidden).toBe(false);
	});
});

describe("sidebar", () => {
	it("the ☰ button collapses the sidebar on a wide view and brings it back", async () => {
		const { root } = await mountApp();
		const tasks = root.querySelector<HTMLElement>(".cp-tasks")!;
		const toggle = root.querySelector<HTMLButtonElement>(".cp-sidebar-toggle")!;
		expect(toggle.getAttribute("aria-label")).toBe("Hide lists");
		toggle.click();
		await settle();
		expect(tasks.classList.contains("is-sidebar-collapsed")).toBe(true);
		expect(toggle.getAttribute("aria-label")).toBe("Show lists");
		toggle.click();
		await settle();
		expect(tasks.classList.contains("is-sidebar-collapsed")).toBe(false);
	});

	it("the toggle is not hidden on wide views, and a collapsed sidebar is hidden by CSS", async () => {
		expect(css).toMatch(/\.cp-tasks\.is-sidebar-collapsed \.cp-sidebar-pane\s*\{[^}]*display:\s*none/);
		expect(css).not.toMatch(/\.cp-sidebar-toggle,\s*\n\.checkpoint-view \.cp-details-close\s*\{\s*display:\s*none/);
	});

	it("uses the spec icons for the fixed entries", async () => {
		const { root } = await mountApp();
		const item = (text: string) => [...root.querySelectorAll<HTMLElement>(".cp-sidebar-item")].find((e) => e.textContent?.includes(text))!;
		expect(iconOf(item("Today"))).toBe("sun");
		expect(iconOf(item("Upcoming"))).toBe("calendar-days");
		expect(iconOf(item("Inbox"))).toBe("inbox");
		expect(iconOf(item("Completed"))).toBe("circle-check");
		expect(iconOf(item("Trash"))).toBe("trash-2");
	});

	it("marks the active item and gives counts a tabular class", async () => {
		const { root } = await mountApp();
		const active = root.querySelectorAll(".cp-sidebar-item.is-active");
		expect(active.length).toBe(1);
		expect(active[0]!.getAttribute("aria-current")).toBe("page");
		expect(active[0]!.textContent).toContain("Today");
	});

	it("section header has a labelled add button", async () => {
		const { root } = await mountApp();
		const head = root.querySelector(".cp-sidebar-heading")!;
		expect(head.textContent).toContain("Lists");
		const add = head.querySelector("button")!;
		expect(add.getAttribute("aria-label")).toBe("New list");
		expect(iconOf(add)).toBe("plus");
		expect(add.classList.contains("cp-sidebar-add")).toBe(true);
	});

	it("renders category icons: lucide name, legacy emoji, default list", async () => {
		const { h, root } = await mountApp();
		await h.app.categories.create("Study", "book-open");
		await h.app.categories.create("Fun", "🎮");
		await h.app.categories.create("Plain", null);
		await settle();
		const row = (name: string) => [...root.querySelectorAll<HTMLElement>(".cp-sidebar-item")].find((e) => e.textContent?.includes(name))!;
		expect(iconOf(row("Study"))).toBe("book-open");
		expect(row("Fun").querySelector(".cp-emoji")?.textContent).toBe("🎮");
		expect(row("Fun").querySelector("[data-icon]")).toBeNull();
		expect(iconOf(row("Plain"))).toBe("list");
	});

	it("categoryIcon classifies stored icons", () => {
		expect(categoryIcon("book-open")).toEqual({ kind: "lucide", name: "book-open" });
		expect(categoryIcon("📖")).toEqual({ kind: "emoji", text: "📖" });
		expect(categoryIcon(null)).toEqual({ kind: "lucide", name: "list" });
		expect(categoryIcon("")).toEqual({ kind: "lucide", name: "list" });
	});

	it("shows a colored dot for tags", async () => {
		const { h, root } = await mountApp();
		const t = await h.app.tags.create("urgent");
		await h.app.tags.setColor(t.key, "red");
		await settle();
		expect(root.querySelector(".cp-sidebar-item .cp-tag-dot.cp-tag-red")).not.toBeNull();
	});
});

describe("empty states", () => {
	it("render a large icon and one line in the trash and in search", async () => {
		const { root } = await mountApp();
		const trash = [...root.querySelectorAll<HTMLElement>(".cp-sidebar-item")].find((e) => e.textContent?.includes("Trash"))!;
		trash.click();
		await settle();
		const empty = [...root.querySelectorAll<HTMLElement>(".cp-empty-state")].find((e) => e.textContent?.includes("Trash is empty"))!;
		expect(empty.querySelector(".cp-empty-icon")).not.toBeNull();
		expect(iconOf(empty)).toBe("trash-2");
		expect(empty.querySelector(".cp-empty-text")?.textContent).toBe("Trash is empty.");

		root.querySelector<HTMLElement>('.cp-rail [aria-label="Search"]')!.click();
		await settle();
		const search = root.querySelector<HTMLElement>(".cp-search .cp-empty-state")!;
		expect(iconOf(search)).toBe("search");
		expect(search.querySelector(".cp-empty-text")).not.toBeNull();
	});

	it("render in an empty task list", async () => {
		const { root } = await mountApp();
		const e = root.querySelector<HTMLElement>(".cp-tasks .cp-empty-state")!;
		expect(e.querySelector(".cp-empty-icon")).not.toBeNull();
		expect(e.querySelector(".cp-empty-text")).not.toBeNull();
	});
});

describe("main header", () => {
	it("search header carries the title and a result count pill once a query is typed", async () => {
		const { h, root } = await mountApp();
		await h.app.tasks.create({ title: "Alpha beta" });
		root.querySelector<HTMLElement>('.cp-rail [aria-label="Search"]')!.click();
		await settle();
		expect(root.querySelector(".cp-search .cp-main-title")!.textContent).toBe("Search");
		expect(root.querySelector(".cp-search .cp-count-pill")).toBeNull();
		const input = root.querySelector<HTMLInputElement>('.cp-search input[type="search"]')!;
		input.value = "alpha";
		input.dispatchEvent(new Event("input", { bubbles: true }));
		await settle();
		expect(root.querySelector(".cp-search .cp-count-pill")?.textContent).toBe("1");
	});
});

describe("undo shortcut", () => {
	const ctrlZ = (el: Element) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }));

	it("undoes from the list but ignores events inside popovers and the add bar", async () => {
		const { h, root } = await mountApp();
		await h.app.tasks.create({ title: "Undoable" });
		await settle();
		const dateTool = root.querySelector<HTMLElement>('.cp-qa-tool[data-tool="date"]')!;
		dateTool.click();
		await settle();
		const pop = root.querySelector<HTMLElement>(".cp-qa-pop, .cp-pop")!;
		expect(pop).not.toBeNull();
		expect(ctrlZ(dateTool)).toBe(true); // not prevented
		expect(ctrlZ(pop.querySelector("button")!)).toBe(true);
		await settle();
		expect(h.app.store.state.tasks.size).toBe(1);
		expect(ctrlZ(root.querySelector(".cp-tasks")!)).toBe(false); // handled
		await settle();
		expect(h.app.store.state.tasks.size).toBe(0);
	});
});

describe("Today groups", () => {
	it("renders Overdue and Today headings with tone classes and counts", async () => {
		const { h, root } = await mountApp();
		await h.app.tasks.create({ title: "Late", scheduled: { kind: "date", date: "2026-09-29" } });
		await h.app.tasks.create({ title: "Now", scheduled: { kind: "date", date: "2026-10-01" } });
		await settle();
		const heads = [...root.querySelectorAll<HTMLElement>(".cp-group-heading")];
		expect(heads.map((e) => e.textContent)).toEqual(["Overdue1", "Today1"]);
		expect(heads[0]!.classList.contains("is-overdue")).toBe(true);
		expect(heads[1]!.classList.contains("is-today")).toBe(true);
	});
});

describe("legacy category icons", () => {
	it("falls back to the list icon when setIcon renders nothing", async () => {
		const { h, root } = await mountApp();
		await h.app.categories.create("Old", "unknown-thing");
		await h.app.categories.create("Fine", "briefcase");
		await settle();
		const item = (text: string) => [...root.querySelectorAll<HTMLElement>(".cp-sidebar-item")].find((e) => e.textContent?.includes(text))!;
		expect(iconOf(item("Old"))).toBe("list");
		expect(iconOf(item("Fine"))).toBe("briefcase");
	});
});
