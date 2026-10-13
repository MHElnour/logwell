// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { INBOX_ID } from "../../src/domain/types";
import { type AppMount, click, expectLabelsResolve, labelledBy, mountApp, obsidianElement, type ObsidianElement, settle, sidebarItem, strayAriaLabels } from "./app-helpers";
import { openViewMenu, pickItem } from "./view-menu-helpers";
import { Modal } from "obsidian";
import { pickListIcon } from "../../src/obsidian/modals";

describe("aria-label tooltips", () => {
	// Regression: Obsidian shows a hover tooltip for ANY element that has an `aria-label`
	// attribute. Non-interactive containers (nav, listbox, groups, dialogs, ...) used to carry
	// aria-label for screen readers, so hovering anywhere in the sidebar showed a stray
	// "Task lists" tooltip and hovering a task row showed the list's label. Containers must
	// be named with aria-labelledby instead; aria-label stays on controls.

	const nameOf = (root: ParentNode, sel: string) => labelledBy(root.querySelector(sel)!);

	async function seed(h: AppMount["h"]) {
		const cat = await h.app.categories.create("Work", "briefcase");
		await h.app.tags.create("urgent", "red");
		await h.app.tasks.create({ title: "Today task", scheduled: { kind: "date", date: "2026-10-01" } });
		await h.app.tasks.create({ title: "Later task", categoryId: cat.id, tagKeys: ["urgent"], scheduled: { kind: "date", date: "2026-10-03" } });
		const done = await h.app.tasks.create({ title: "Done task" });
		await h.app.tasks.complete(done.task.id);
	}

	describe("no stray aria-label tooltips", () => {
		it("the sidebar, the task list and the rail carry no aria-label on containers", async () => {
			const m = await mountApp();
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
			const m = await mountApp();
			await seed(m.h);
			await click([...m.root.querySelectorAll<HTMLElement>(".cp-sidebar-item")].find((e) => e.textContent?.includes("Upcoming")));
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
			const m = await mountApp();
			await seed(m.h);
			await new Promise((r) => setTimeout(r, 600));
			await settle();
			// The ⋯ button is a control, so its aria-label is allowed; the Completed group is named by its heading.
			expect(m.root.querySelector('.cp-tasks [aria-label="View options"]')).not.toBeNull();
			await click([...m.root.querySelectorAll<HTMLElement>(".cp-sidebar-item")].find((e) => e.textContent?.includes("Inbox")));
			await click(m.root.querySelector(".cp-tasks .cp-completed-toggle"));
			expect(nameOf(m.root, ".cp-tasks .cp-completed-group")).toBe("Completed · 1");
			expect(m.root.querySelector(".cp-tasks .cp-completed-group")!.hasAttribute("aria-label")).toBe(false);
			await click([...m.root.querySelectorAll<HTMLElement>(".cp-sidebar-item")].find((e) => e.textContent?.includes("Today")));
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

		it("section headings, the board's section columns and the name field carry no stray aria-label", async () => {
			const m = await mountApp();
			await seed(m.h);
			const alpha = await m.h.app.sections.create(INBOX_ID, "Alpha");
			await m.h.app.tasks.create({ title: "In alpha", sectionId: alpha.id });
			await settle();
			await click(sidebarItem(m.root, "Inbox"));
			// The section headings show under "Group by: Section".
			const menu = await openViewMenu(m, m.root.querySelector(".cp-tasks")!);
			await pickItem(m, (await pickItem(m, menu, "Group by…"))!, "Section");
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
			await click([...m.root.querySelectorAll<HTMLElement>(".cp-tasks .cp-mode-button")].find((b) => b.textContent.trim() === "Board"));
			await click(m.root.querySelector(".cp-tasks .cp-board-add-section"));
			expect(m.root.querySelector(".cp-tasks .cp-section-name-input")).not.toBeNull();
			expect(strayAriaLabels(m.root)).toEqual([]);
			expectLabelsResolve(m.root);
		});

		it("the add-bar chip list and its open chip panel", async () => {
			const m = await mountApp();
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
			const m = await mountApp();
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

			await click([...date.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === "Duration"));
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
			const m = await mountApp();
			await seed(m.h);
			await settle();
			await click(m.root.querySelector('.cp-rail [aria-label="Matrix"]'));
			const sections = [...m.root.querySelectorAll<HTMLElement>(".cp-matrix section.cp-matrix-q")];
			expect(sections.map((s) => labelledBy(s))).toEqual(["Urgent and important", "Important, not urgent", "Urgent, not important", "Neither"]);
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
			const m = await mountApp();
			await seed(m.h);
			await settle();
			const mode = m.root.querySelector<HTMLElement>(".cp-tasks .cp-mode-switch")!;
			expect(mode.hasAttribute("aria-label")).toBe(false);
			expect(labelledBy(mode)).toBe("Layout");
			await click([...mode.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent?.trim() === "Board"));
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
});

describe("aria-label and title", () => {
	// Obsidian shows a tooltip for aria-label, so an element that also sets `title` showed two.
	// Icon buttons keep aria-label and drop title, everywhere.

	const both = (root: ParentNode) =>
		[...root.querySelectorAll<HTMLElement>("[aria-label][title]")].map((el) => `<${el.tagName.toLowerCase()} class="${el.className}" aria-label="${el.getAttribute("aria-label")}" title="${el.getAttribute("title")}">`);

	describe("no element has both aria-label and title (F7)", () => {
		it("holds in Tasks, Calendar, Matrix and Search", async () => {
			const m = await mountApp();
			const cat = await m.h.app.categories.create("Work", "briefcase");
			await m.h.app.tags.create("urgent", "red");
			const parent = await m.h.app.tasks.create({
				title: "Plan trip",
				categoryId: cat.id,
				tagKeys: ["urgent"],
				urgent: true,
				scheduled: { kind: "date", date: "2026-10-01" },
				deadline: { kind: "date", date: "2026-10-05" },
			});
			await m.h.app.tasks.create({ title: "Book hotel", parentId: parent.task.id });
			await m.h.app.tasks.create({ title: "Timed", scheduled: { kind: "datetime", local: "2026-10-01T19:00", tz: "Europe/Berlin" }, plannedDurationMin: 30 });
			await settle();

			// Tasks, with the details pane and the add bar's tools.
			expect(m.root.querySelectorAll(".cp-task-row").length).toBeGreaterThan(0);
			expect(both(m.root)).toEqual([]);
			await click(m.root.querySelector(".cp-task-row"));
			expect(m.root.querySelector(".cp-details")).not.toBeNull();
			expect(both(m.root)).toEqual([]);

			for (const section of ["Calendar", "Matrix", "Search"]) {
				await click(m.root.querySelector(`.cp-rail [aria-label="${section}"]`));
				expect(both(m.root), section).toEqual([]);
			}
			// The calendar's other mode and its Unscheduled drawer.
			await click(m.root.querySelector('.cp-rail [aria-label="Calendar"]'));
			await click(m.root.querySelector(".cp-cal-unscheduled-toggle, [aria-label='Unscheduled']"));
			expect(both(m.root), "Calendar drawer").toEqual([]);
		});
	});
});

describe("the icon picker", () => {
	// The icon picker's grid is a container: Obsidian tooltips any element with an aria-label, so
	// the grid is named through aria-labelledby (a visually hidden label), not aria-label.
	// `obsidian` is the stub from tests/app/obsidian-stub.ts; the Obsidian DOM helpers are faked.

	let opened: { contentEl: ObsidianElement }[] = [];
	beforeAll(() => {
		(Modal as unknown as { prototype: Record<string, unknown> }).prototype.open = function (this: { contentEl: ObsidianElement; modalEl: ObsidianElement; setTitle: () => void; onOpen: () => void }) {
			this.modalEl = obsidianElement();
			this.contentEl = obsidianElement();
			this.modalEl.appendChild(this.contentEl);
			document.body.appendChild(this.modalEl);
			this.setTitle = () => undefined;
			this.onOpen();
			opened.push(this);
		};
	});
	afterEach(() => {
		opened = [];
		document.body.replaceChildren();
	});

	describe("icon picker", () => {
		it("names the icon grid with aria-labelledby, not aria-label; the buttons keep theirs", () => {
			void pickListIcon({} as never, "inbox");
			const grid = opened[0]!.contentEl.querySelector<HTMLElement>(".cp-icon-grid")!;
			expect(grid.getAttribute("role")).toBe("group");
			expect(grid.hasAttribute("aria-label")).toBe(false);
			const label = document.getElementById(grid.getAttribute("aria-labelledby")!)!;
			expect(label.textContent).toBe("Icons");
			expect(label.classList.contains("cp-sr-only")).toBe(true);
			expect(label.hasAttribute("hidden")).toBe(false);
			const buttons = grid.querySelectorAll("button.cp-icon-choice[aria-label]");
			expect(buttons.length).toBeGreaterThan(0);
		});

		it("uses a unique label id per picker instance", () => {
			void pickListIcon({} as never, null);
			void pickListIcon({} as never, null);
			const ids = opened.map((m) => m.contentEl.querySelector(".cp-icon-grid")!.getAttribute("aria-labelledby"));
			expect(new Set(ids).size).toBe(2);
			const all = [...document.querySelectorAll("[id]")].map((e) => e.id);
			expect(new Set(all).size).toBe(all.length);
		});
	});
});
