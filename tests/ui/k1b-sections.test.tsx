// @vitest-environment happy-dom
import { render } from "preact";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildView } from "../../src/app/views";
import { emptyFilter } from "../../src/domain/queries";
import { INBOX_ID, type Task } from "../../src/domain/types";
import { cancelMoveToSection, moveToSection, taskMenu } from "../../src/ui/actions";
import { AddSectionField } from "../../src/ui/AddSectionField";
import { TaskList } from "../../src/ui/TaskList";
import { makeReadOnly } from "../app/harness";
import { type CalMount, board, cardTitles, click, columnEl, columnEls, columnTitles, dragTo, item, modeButton, mountBoard, openBoard, press, settle, sidebarItem, stubBoardRects } from "./k1a-helpers";
import { U1Host } from "./u1-helpers";
import { openViewMenu as openMenuAt, pickItem } from "./view-menu-helpers";

// Sections in the list view and on the board.
// Today is 2026-10-01 (Europe/Berlin).

const mounted: CalMount[] = [];
const containers: HTMLElement[] = [];
beforeAll(() => {
	(HTMLElement.prototype as unknown as { createDiv: (o: { cls: string }) => HTMLElement }).createDiv = function (this: HTMLElement, o) {
		const el = this.ownerDocument.createElement("div");
		el.className = o.cls;
		this.appendChild(el);
		return el;
	};
});
afterEach(() => {
	for (const m of mounted.splice(0)) m.unmount();
	for (const c of containers.splice(0)) {
		render(null, c);
		c.remove();
	}
});
async function mount() {
	const m = await mountBoard();
	mounted.push(m);
	return m;
}

const taskOf = (m: CalMount, title: string): Task => [...m.h.app.store.state.tasks.values()].find((t) => t.title === title)!;
const sectionOf = (m: CalMount, name: string) => [...m.h.app.store.state.sections.values()].find((s) => s.name === name)!;
const sectionNames = (m: CalMount) => m.h.app.sections.inList(INBOX_ID).map((s) => s.name);

/** Inbox with sections Alpha (A1, A2), Beta (empty) and the unsectioned N1. */
async function seed(m: CalMount) {
	const alpha = await m.h.app.sections.create(INBOX_ID, "Alpha");
	await m.h.app.sections.create(INBOX_ID, "Beta");
	await m.h.app.tasks.create({ title: "N1" });
	await m.h.app.tasks.create({ title: "A1", sectionId: alpha.id });
	await m.h.app.tasks.create({ title: "A2", sectionId: alpha.id });
	await settle();
}

const headings = (m: CalMount) =>
	[...m.root.querySelectorAll(".cp-tasks .cp-section-heading")].map((h) => `${h.querySelector(".cp-section-toggle span[id]")!.textContent}:${h.querySelector(".cp-group-count")!.textContent}`);
const rowTitles = (m: CalMount) => [...m.root.querySelectorAll(".cp-tasks .cp-task-row .cp-task-title")].map((t) => t.textContent.trim());
const byLabel = (root: ParentNode, label: string) => root.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
type Menu = Exclude<U1Host["menus"][number][number], "separator">;
const menuItems = (host: U1Host): Menu[] => host.menus.at(-1)!.flatMap((i) => (i === "separator" ? [] : [i]));
const menuRun = (host: U1Host, title: string) => menuItems(host).find((i) => i.title === title)!.run();

async function openViewMenu(m: CalMount) {
	m.host.menus.length = 0;
	await click(byLabel(m.root.querySelector(".cp-tasks")!, "View options"));
}
/** Inbox groups by nothing until asked; the section headings show under "Group by: Section". */
async function inboxBySection(m: CalMount) {
	await click(sidebarItem(m.root, "Inbox"));
	const menu = await openMenuAt(m, m.root.querySelector(".cp-tasks")!);
	const second = await pickItem(m, menu, "Group by…");
	await pickItem(m, second!, "Section");
}
const typeInto = async (input: HTMLInputElement, text: string) => {
	input.value = text;
	input.dispatchEvent(new Event("input", { bubbles: true }));
	await settle();
};
const key = async (el: Element, k: string) => {
	el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
	await settle();
};

describe("list view headings (D7, answers 1 and 4)", () => {
	it("shows No section first, then each section with its count; an empty section keeps its heading", async () => {
		const m = await mount();
		await seed(m);
		await inboxBySection(m);
		expect(headings(m)).toEqual(["No section:1", "Alpha:2", "Beta:0"]);
		expect(rowTitles(m)).toEqual(["N1", "A1", "A2"]);
		// The group is named by its heading text, never by an aria-label.
		const group = m.root.querySelector<HTMLElement>('.cp-tasks .cp-section-group[data-section-id="' + sectionOf(m, "Alpha").id + '"]')!;
		expect(group.hasAttribute("aria-label")).toBe(false);
		expect(m.root.querySelector(`#${group.getAttribute("aria-labelledby")}`)!.textContent).toBe("Alpha");
	});

	it("a list without sections keeps its plain look: no heading at all", async () => {
		const m = await mount();
		await m.h.app.tasks.create({ title: "Lonely" });
		await click(sidebarItem(m.root, "Inbox"));
		expect(m.root.querySelector(".cp-tasks .cp-section-heading")).toBeNull();
		expect(rowTitles(m)).toEqual(["Lonely"]);
	});

	it("collapses a section; the state is kept per section across view switches", async () => {
		const m = await mount();
		await seed(m);
		await inboxBySection(m);
		const toggle = () => [...m.root.querySelectorAll<HTMLButtonElement>(".cp-tasks .cp-section-toggle")].find((b) => b.textContent.includes("Alpha"))!;
		expect(toggle().getAttribute("aria-expanded")).toBe("true");
		await click(toggle());
		expect(toggle().getAttribute("aria-expanded")).toBe("false");
		expect(rowTitles(m)).toEqual(["N1"]);
		expect(headings(m)).toEqual(["No section:1", "Alpha:2", "Beta:0"]);
		await click(sidebarItem(m.root, "Today"));
		await inboxBySection(m);
		expect(rowTitles(m)).toEqual(["N1"]);
		await click(toggle());
		expect(rowTitles(m)).toEqual(["N1", "A1", "A2"]);
	});

	it('the "+" opens Quick Add with the list and the section preset; No section presets none', async () => {
		const m = await mount();
		await seed(m);
		const quickAdd = vi.spyOn(m.host, "quickAdd");
		await inboxBySection(m);
		await click(byLabel(m.root, "Add task to Alpha"));
		expect(quickAdd).toHaveBeenLastCalledWith({ categoryId: INBOX_ID, sectionId: sectionOf(m, "Alpha").id });
		await click(byLabel(m.root, "Add task to No section"));
		expect(quickAdd).toHaveBeenLastCalledWith({ categoryId: INBOX_ID, sectionId: null });
	});

	it("the ⋯ menu offers Rename and Delete; No section has none", async () => {
		const m = await mount();
		await seed(m);
		await inboxBySection(m);
		expect(byLabel(m.root, "Options for section No section")).toBeNull();
		m.host.menus.length = 0;
		await click(byLabel(m.root, "Options for section Alpha"));
		expect(menuItems(m.host).map((i) => i.title)).toEqual(["Rename", "Move left", "Move right", "Delete"]);
	});

	it("Rename asks for a name; a duplicate is an error notice and changes nothing", async () => {
		const m = await mount();
		await seed(m);
		await inboxBySection(m);
		(m.host as { prompt: unknown }).prompt = async () => ({ name: "Gamma" });
		await click(byLabel(m.root, "Options for section Alpha"));
		menuRun(m.host, "Rename");
		await settle();
		expect(sectionNames(m)).toEqual(["Gamma", "Beta"]);
		(m.host as { prompt: unknown }).prompt = async () => ({ name: "beta" });
		await click(byLabel(m.root, "Options for section Gamma"));
		menuRun(m.host, "Rename");
		await settle();
		expect(sectionNames(m)).toEqual(["Gamma", "Beta"]);
		expect(m.host.messages.at(-1)).toMatch(/already|exists/i);
	});

	it("Delete moves the tasks to No section and shows an Undo notice that restores both", async () => {
		const m = await mount();
		await seed(m);
		const undo = vi.spyOn(m.host, "notifyUndo");
		await inboxBySection(m);
		await click(byLabel(m.root, "Options for section Alpha"));
		menuRun(m.host, "Delete");
		await settle();
		expect(sectionNames(m)).toEqual(["Beta"]);
		expect(taskOf(m, "A1").sectionId).toBeNull();
		expect(headings(m)).toEqual(["No section:3", "Beta:0"]);
		expect(undo).toHaveBeenCalledTimes(1);
		expect((undo.mock.calls[0] as unknown[])[1]).toBe("Delete section");
		expect(await m.h.app.store.undo()).toBe("Delete section");
		await settle();
		expect(sectionNames(m)).toEqual(["Alpha", "Beta"]);
		expect(taskOf(m, "A1").sectionId).toBe(sectionOf(m, "Alpha").id);
	});
});

describe('"Add section" in the view menu (answer 6)', () => {
	it("is in Inbox and lists, not in Today", async () => {
		const m = await mount();
		await openViewMenu(m);
		expect(menuItems(m.host).map((i) => i.title)).not.toContain("Add section");
		await inboxBySection(m);
		await openViewMenu(m);
		expect(menuItems(m.host).map((i) => i.title)).toContain("Add section");
	});

	it("opens a name field at the bottom of the list; Enter creates, the field closes", async () => {
		const m = await mount();
		await seed(m);
		await inboxBySection(m);
		await openViewMenu(m);
		menuRun(m.host, "Add section");
		await settle();
		const input = m.root.querySelector<HTMLInputElement>(".cp-tasks .cp-section-name-input")!;
		expect(input).not.toBeNull();
		expect(document.activeElement).toBe(input);
		await typeInto(input, "Gamma");
		await key(input, "Enter");
		expect(sectionNames(m)).toEqual(["Alpha", "Beta", "Gamma"]);
		expect(m.root.querySelector(".cp-tasks .cp-section-name-input")).toBeNull();
		expect(headings(m)).toEqual(["No section:1", "Alpha:2", "Beta:0", "Gamma:0"]);
	});

	it("Escape closes only the field: the selection and the view stay", async () => {
		const m = await mount();
		await seed(m);
		await inboxBySection(m);
		await click(m.root.querySelector(".cp-tasks .cp-task-row"));
		expect(m.root.querySelector(".cp-tasks .cp-details")).not.toBeNull();
		await openViewMenu(m);
		menuRun(m.host, "Add section");
		await settle();
		const input = m.root.querySelector<HTMLInputElement>(".cp-tasks .cp-section-name-input")!;
		await typeInto(input, "Half typed");
		const bubbled = vi.fn();
		m.root.addEventListener("keydown", bubbled);
		await key(input, "Escape");
		expect(m.root.querySelector(".cp-tasks .cp-section-name-input")).toBeNull();
		expect(bubbled).not.toHaveBeenCalled();
		expect(m.root.querySelector(".cp-tasks .cp-details")).not.toBeNull();
		expect(sectionNames(m)).toEqual(["Alpha", "Beta"]);
	});

	it("a duplicate name (ignoring case) shows an inline error and keeps the field", async () => {
		const m = await mount();
		await seed(m);
		await inboxBySection(m);
		await openViewMenu(m);
		menuRun(m.host, "Add section");
		await settle();
		const input = m.root.querySelector<HTMLInputElement>(".cp-tasks .cp-section-name-input")!;
		await typeInto(input, "ALPHA");
		await key(input, "Enter");
		const error = m.root.querySelector(".cp-tasks .cp-section-error")!;
		expect(error.getAttribute("role")).toBe("alert");
		expect(error.textContent).toMatch(/already|exists/i);
		expect(input.getAttribute("aria-invalid")).toBe("true");
		expect(sectionNames(m)).toEqual(["Alpha", "Beta"]);
		await typeInto(input, "Delta");
		expect(m.root.querySelector(".cp-tasks .cp-section-error")).toBeNull();
	});

	it("is absent while the database is read-only, and the heading buttons are disabled", async () => {
		const m = await mount();
		await seed(m);
		await inboxBySection(m);
		await makeReadOnly(m.h);
		m.h.app.store.bus.emit("status", undefined);
		await settle();
		await openViewMenu(m);
		expect(menuItems(m.host).map((i) => i.title)).not.toContain("Add section");
		expect(byLabel(m.root, "Add task to Alpha")!.disabled).toBe(true);
		expect(byLabel(m.root, "Options for section Alpha")!.disabled).toBe(true);
	});
});

describe('"Move to section…" (answer 5)', () => {
	it("is only offered for a top-level task of a list that has sections", async () => {
		const m = await mount();
		const plain = await m.h.app.tasks.create({ title: "Plain" });
		const titles = (t: Task) => taskMenu(m.host, t, "2026-10-01", () => undefined, document.body).flatMap((i) => (i === "separator" ? [] : [i.title]));
		expect(titles(plain.task)).not.toContain("Move to section…");
		await seed(m);
		const sub = await m.h.app.tasks.create({ title: "Sub", parentId: taskOf(m, "A1").id });
		expect(titles(taskOf(m, "N1"))).toContain("Move to section…");
		expect(titles(sub.task)).not.toContain("Move to section…");
	});

	it("opens a second menu with No section and the sections, the current one checked, and moves the task", async () => {
		const m = await mount();
		await seed(m);
		const a1 = taskOf(m, "A1");
		const entry = taskMenu(m.host, a1, "2026-10-01", () => undefined, document.body).find((i) => i !== "separator" && i.title === "Move to section…");
		expect(entry).toBeDefined();
		m.host.menus.length = 0;
		moveToSection(m.host, a1, document.body);
		await new Promise((r) => setTimeout(r, 5));
		expect(menuItems(m.host).map((i) => `${i.title}:${i.checked}`)).toEqual(["No section:false", "Alpha:true", "Beta:false"]);
		menuRun(m.host, "Beta");
		await settle();
		expect(taskOf(m, "A1").sectionId).toBe(sectionOf(m, "Beta").id);
		menuRun(m.host, "No section");
		await settle();
		expect(taskOf(m, "A1").sectionId).toBeNull();
	});
});

describe('"Move to section…" anchor and timer (#120)', () => {
	const rectAt = (left: number, bottom: number) => ({ left, bottom, top: bottom - 20, right: left + 100, width: 100, height: 20, x: left, y: bottom - 20, toJSON: () => ({}) }) as DOMRect;

	it("anchors the second menu to the element passed in, not to document.activeElement", async () => {
		const m = await mount();
		await seed(m);
		const anchor = document.createElement("div");
		document.body.appendChild(anchor);
		anchor.getBoundingClientRect = () => rectAt(100, 200);
		const elsewhere = document.createElement("button");
		document.body.appendChild(elsewhere);
		elsewhere.focus();
		elsewhere.getBoundingClientRect = () => rectAt(900, 900);
		const show = vi.spyOn(m.host, "showMenu");
		moveToSection(m.host, taskOf(m, "A1"), anchor);
		await new Promise((r) => setTimeout(r, 5));
		expect(show).toHaveBeenCalledTimes(1);
		expect(show.mock.calls[0]![0]).toEqual({ x: 124, y: 200 });
		anchor.remove();
		elsewhere.remove();
	});

	it("shows nothing when the timer was cancelled, when the anchor left the document, or after a newer call", async () => {
		const m = await mount();
		await seed(m);
		const show = vi.spyOn(m.host, "showMenu");
		const anchor = document.createElement("div");
		document.body.appendChild(anchor);
		moveToSection(m.host, taskOf(m, "A1"), anchor);
		cancelMoveToSection();
		await new Promise((r) => setTimeout(r, 5));
		expect(show).not.toHaveBeenCalled();
		moveToSection(m.host, taskOf(m, "A1"), anchor);
		anchor.remove();
		await new Promise((r) => setTimeout(r, 5));
		expect(show).not.toHaveBeenCalled();
		const live = document.createElement("div");
		document.body.appendChild(live);
		moveToSection(m.host, taskOf(m, "A1"), live);
		moveToSection(m.host, taskOf(m, "A2"), live);
		await new Promise((r) => setTimeout(r, 5));
		expect(show).toHaveBeenCalledTimes(1);
		live.remove();
	});

	it("unmounting the app clears a pending timer", async () => {
		const m = await mount();
		await seed(m);
		const show = vi.spyOn(m.host, "showMenu");
		const anchor = document.createElement("div");
		document.body.appendChild(anchor);
		moveToSection(m.host, taskOf(m, "A1"), anchor);
		m.unmount();
		mounted.splice(mounted.indexOf(m), 1);
		await new Promise((r) => setTimeout(r, 5));
		expect(show).not.toHaveBeenCalled();
		anchor.remove();
	});
});

describe("keyboard reorder of sections (#121)", () => {
	const item = (host: U1Host, title: string) => menuItems(host).find((i) => i.title === title)!;

	it("the list heading menu moves a section left or right, disabled at the ends", async () => {
		const m = await mount();
		await seed(m);
		await inboxBySection(m);
		m.host.menus.length = 0;
		await click(byLabel(m.root, "Options for section Alpha"));
		expect([item(m.host, "Move left").disabled, item(m.host, "Move right").disabled]).toEqual([true, false]);
		m.host.menus.length = 0;
		await click(byLabel(m.root, "Options for section Beta"));
		expect([item(m.host, "Move left").disabled, item(m.host, "Move right").disabled]).toEqual([false, true]);
		menuRun(m.host, "Move left");
		await settle();
		expect(sectionNames(m)).toEqual(["Beta", "Alpha"]);
		expect(m.h.app.store.undoLabel).toBe("Move section");
		expect(headings(m)).toEqual(["No section:1", "Beta:0", "Alpha:2"]);
		m.host.menus.length = 0;
		await click(byLabel(m.root, "Options for section Beta"));
		menuRun(m.host, "Move right");
		await settle();
		expect(sectionNames(m)).toEqual(["Alpha", "Beta"]);
	});

	it("the board column header menu does the same", async () => {
		const m = await mount();
		await seed(m);
		await openBoard(m, "Inbox");
		m.host.menus.length = 0;
		await click(byLabel(m.root, "Options for section Alpha"));
		expect([item(m.host, "Move left").disabled, item(m.host, "Move right").disabled]).toEqual([true, false]);
		menuRun(m.host, "Move right");
		await settle();
		expect(sectionNames(m)).toEqual(["Beta", "Alpha"]);
		expect(columnTitles(m.root)).toEqual(["No section", "Beta", "Alpha"]);
	});
});

describe("listbox structure (#122)", () => {
	const buttonsOutsideOptions = (root: ParentNode) =>
		[...root.querySelectorAll<HTMLElement>('[role="listbox"] button')].filter((b) => b.closest('[role="option"]') === null).map((b) => b.className || b.textContent);

	it("no heading button sits inside a listbox; a listbox holds only options; arrows still cross sections", async () => {
		const m = await mount();
		await seed(m);
		await inboxBySection(m);
		const done = taskOf(m, "A2");
		await m.h.app.tasks.complete(done.id);
		await settle();
		const tasks = m.root.querySelector(".cp-tasks")!;
		expect(tasks.querySelectorAll('[role="listbox"]').length).toBeGreaterThan(1);
		expect(tasks.querySelector('.cp-section-heading')!.closest('[role="listbox"]')).toBeNull();
		expect(buttonsOutsideOptions(tasks)).toEqual([]);
		for (const box of tasks.querySelectorAll('[role="listbox"]')) {
			expect([...box.children].every((c) => c.getAttribute("role") === "option")).toBe(true);
			expect(box.getAttribute("aria-labelledby")).not.toBeNull();
			expect(document.getElementById(box.getAttribute("aria-labelledby")!)!.textContent).not.toBe("");
		}
		const rows = [...tasks.querySelectorAll<HTMLElement>(".cp-task-row")];
		const n1 = rows.find((r) => r.textContent.includes("N1"))!;
		n1.focus();
		await key(n1, "ArrowDown");
		expect(document.activeElement).toBe(rows[rows.indexOf(n1) + 1]);
		expect(document.activeElement!.closest(".cp-section-group")!.getAttribute("data-section-id")).not.toBe("none");
	});

	it("the board has no button directly inside a listbox", async () => {
		const m = await mount();
		await seed(m);
		await openBoard(m, "Inbox");
		expect(buttonsOutsideOptions(m.root.querySelector(".cp-tasks")!)).toEqual([]);
	});
});

describe("row drag between sections (D7)", () => {
	// happy-dom has no layout: groups are boxes of a 30 px heading plus 40 px rows, one under the other.
	const rect = (left: number, top: number, right: number, bottom: number) =>
		({ left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

	async function mountList() {
		const m = await mount();
		await seed(m);
		const host = new U1Host(m.h);
		const undo = vi.spyOn(host, "notifyUndo");
		const root = document.createElement("div");
		document.body.appendChild(root);
		containers.push(root);
		const redraw = async () => {
			const state = m.h.app.store.state;
			const ctx = m.h.app.queryContext();
			const groups = buildView(state, { kind: "inbox" }, ctx, { ...emptyFilter("all"), sort: "manual" }, "", undefined, "section");
			render(
				<TaskList
					host={host}
					state={state}
					groups={groups}
					ctx={ctx}
					selectedId={null}
					showCategory={false}
					emptyText=""
					label="Inbox"
					sort="manual"
					onSelect={() => undefined}
					sections={{ categoryId: INBOX_ID, hasAny: true, collapsed: () => false, onToggle: () => undefined, addRequest: 0 }}
				/>,
				root,
			);
			await settle();
			let y = 0;
			const tops = new Map<string, number>();
			root.querySelectorAll<HTMLElement>(".cp-section-group").forEach((g) => {
				const start = y;
				y += 30;
				g.querySelector<HTMLElement>(".cp-section-heading")!.getBoundingClientRect = () => rect(0, start, 500, start + 30);
				g.querySelectorAll<HTMLElement>(".cp-task-row").forEach((r) => {
					const top = y;
					r.getBoundingClientRect = () => rect(0, top, 500, top + 40);
					tops.set(r.querySelector(".cp-task-title")!.textContent.trim(), top + 20);
					y += 40;
				});
				const end = y;
				g.getBoundingClientRect = () => rect(0, start, 500, end);
			});
			root.querySelector<HTMLElement>(".cp-task-list")!.getBoundingClientRect = () => rect(0, 0, 500, 1000);
			return tops;
		};
		return { m, root, undo, redraw, tops: await redraw() };
	}
	const rowEl = (root: HTMLElement, text: string) => [...root.querySelectorAll<HTMLElement>(".cp-task-row")].find((r) => r.querySelector(".cp-task-title")!.textContent.trim() === text)!;

	it("drops a row on another section's rows: one place call with the section, in one undo step", async () => {
		const { m, root, undo, redraw, tops } = await mountList();
		const place = vi.spyOn(m.h.app.tasks, "place");
		// N1 (No section) dropped on A2's lower half: it lands after A2 in Alpha.
		await dragTo(rowEl(root, "N1"), { x: 100, y: tops.get("N1")! }, { x: 100, y: tops.get("A2")! + 15 });
		expect(place).toHaveBeenCalledTimes(1);
		const [id, order, patch] = place.mock.calls[0]!;
		expect(id).toBe(taskOf(m, "N1").id);
		expect(order).toEqual([taskOf(m, "A1").id, taskOf(m, "A2").id, taskOf(m, "N1").id]);
		expect(patch).toEqual({ sectionId: sectionOf(m, "Alpha").id });
		expect(taskOf(m, "N1").sectionId).toBe(sectionOf(m, "Alpha").id);
		expect(undo).toHaveBeenCalledWith('Moved "N1" to Alpha.', "Move task", expect.any(Number));
		expect(await m.h.app.store.undo()).toBe("Move task");
		expect(taskOf(m, "N1").sectionId).toBeNull();
		await redraw();
	});

	it("drops a row on an empty section's heading area", async () => {
		const { m, root, tops } = await mountList();
		// Beta is the last group: below A2 and its 30 px heading.
		await dragTo(rowEl(root, "A1"), { x: 100, y: tops.get("A1")! }, { x: 100, y: tops.get("A2")! + 35 });
		expect(taskOf(m, "A1").sectionId).toBe(sectionOf(m, "Beta").id);
	});

	it("reorders inside a section without a section change", async () => {
		const { m, root, undo, tops } = await mountList();
		const place = vi.spyOn(m.h.app.tasks, "place");
		await dragTo(rowEl(root, "A2"), { x: 100, y: tops.get("A2")! }, { x: 100, y: tops.get("A1")! - 15 });
		expect(place.mock.calls[0]![2]).toEqual({});
		expect(place.mock.calls[0]![1]).toEqual([taskOf(m, "A2").id, taskOf(m, "A1").id]);
		expect(taskOf(m, "A2").sectionId).toBe(sectionOf(m, "Alpha").id);
		expect(undo).toHaveBeenCalledWith('Moved "A2".', "Move task", expect.any(Number));
	});

	it("a subtask is not dragged to another section", async () => {
		const { m, root, redraw } = await mountList();
		await m.h.app.tasks.create({ title: "Sub", parentId: taskOf(m, "A1").id });
		const tops = await redraw();
		const place = vi.spyOn(m.h.app.tasks, "place");
		await dragTo(rowEl(root, "Sub"), { x: 100, y: tops.get("Sub")! }, { x: 100, y: tops.get("N1")! });
		expect(taskOf(m, "Sub").sectionId).toBe(sectionOf(m, "Alpha").id);
		for (const call of place.mock.calls) expect(call[2]).toEqual({});
	});
});

describe("board columns (D6, answers 5 and 6)", () => {
	it("shows No section, the sections, then the faint Add section column", async () => {
		const m = await mount();
		await seed(m);
		await openBoard(m, "Inbox");
		expect(columnTitles(m.root)).toEqual(["No section", "Alpha", "Beta"]);
		expect(cardTitles(m.root, "none")).toEqual(["N1"]);
		expect(cardTitles(m.root, sectionOf(m, "Alpha").id)).toEqual(["A1", "A2"]);
		const last = board(m.root).querySelector(".cp-board-scroll")!.lastElementChild!;
		expect(last.classList.contains("cp-board-add-col")).toBe(true);
		expect(last.textContent).toContain("Add section");
		expect(columnEls(m.root).every((c) => !c.classList.contains("cp-board-add-col"))).toBe(true);
	});

	it("the column turns into a name field: Enter creates, Escape cancels only the field", async () => {
		const m = await mount();
		await seed(m);
		await openBoard(m, "Inbox");
		const open = async () => click(board(m.root).querySelector(".cp-board-add-section"));
		await open();
		const input = () => board(m.root).querySelector<HTMLInputElement>(".cp-section-name-input")!;
		expect(document.activeElement).toBe(input());
		await typeInto(input(), "Typed");
		await key(input(), "Escape");
		expect(board(m.root)).not.toBeNull();
		expect(board(m.root).querySelector(".cp-section-name-input")).toBeNull();
		expect(board(m.root).querySelector(".cp-board-add-section")).not.toBeNull();
		expect(sectionNames(m)).toEqual(["Alpha", "Beta"]);
		await open();
		await typeInto(input(), "Gamma");
		await key(input(), "Enter");
		expect(sectionNames(m)).toEqual(["Alpha", "Beta", "Gamma"]);
		expect(columnTitles(m.root)).toEqual(["No section", "Alpha", "Beta", "Gamma"]);
	});

	it("a duplicate name shows an inline error", async () => {
		const m = await mount();
		await seed(m);
		await openBoard(m, "Inbox");
		await click(board(m.root).querySelector(".cp-board-add-section"));
		const input = board(m.root).querySelector<HTMLInputElement>(".cp-section-name-input")!;
		await typeInto(input, "beta");
		await key(input, "Enter");
		expect(board(m.root).querySelector(".cp-section-error")!.textContent).toMatch(/already|exists/i);
		expect(sectionNames(m)).toEqual(["Alpha", "Beta"]);
	});

	it('the view menu\'s "Add section" opens the Add section column field', async () => {
		const m = await mount();
		await seed(m);
		await openBoard(m, "Inbox");
		await openViewMenu(m);
		menuRun(m.host, "Add section");
		await settle();
		const input = board(m.root).querySelector<HTMLInputElement>(".cp-section-name-input")!;
		expect(input).not.toBeNull();
		expect(document.activeElement).toBe(input);
	});

	it("each section header has a ⋯ menu (Rename, Delete) and a + with the section; No section has no ⋯", async () => {
		const m = await mount();
		await seed(m);
		const quickAdd = vi.spyOn(m.host, "quickAdd");
		await openBoard(m, "Inbox");
		expect(columnEl(m.root, "none").querySelector('[aria-label^="Options for section"]')).toBeNull();
		await click(byLabel(columnEl(m.root, sectionOf(m, "Beta").id), "Add task to Beta"));
		expect(quickAdd).toHaveBeenLastCalledWith({ categoryId: INBOX_ID, date: null, sectionId: sectionOf(m, "Beta").id });
		m.host.menus.length = 0;
		await click(byLabel(m.root, "Options for section Beta"));
		expect(menuItems(m.host).map((i) => i.title)).toEqual(["Rename", "Move left", "Move right", "Delete"]);
		menuRun(m.host, "Delete");
		await settle();
		expect(sectionNames(m)).toEqual(["Alpha"]);
	});

	it("dragging a card to another column moves it to that section, in one place call", async () => {
		const m = await mount();
		await seed(m);
		await openBoard(m, "Inbox");
		const place = vi.spyOn(m.h.app.tasks, "place");
		const undo = vi.spyOn(m.host, "notifyUndo");
		const r = stubBoardRects(m.root);
		const beta = sectionOf(m, "Beta");
		await dragTo(item(m.root, "A1"), r.card("A1"), r.columns[beta.id]!);
		expect(place).toHaveBeenCalledTimes(1);
		expect(place.mock.calls[0]![2]).toEqual({ sectionId: beta.id });
		expect(taskOf(m, "A1").sectionId).toBe(beta.id);
		expect(cardTitles(m.root, beta.id)).toEqual(["A1"]);
		expect(undo).toHaveBeenCalledWith('Moved "A1" to Beta.', "Move task", expect.any(Number));
		// Back to No section.
		const r2 = stubBoardRects(m.root);
		await dragTo(item(m.root, "A1"), r2.card("A1"), r2.columns["none"]!);
		expect(taskOf(m, "A1").sectionId).toBeNull();
	});

	it("a nested subtask cannot be dragged to another column", async () => {
		const m = await mount();
		await seed(m);
		await m.h.app.tasks.create({ title: "Sub", parentId: taskOf(m, "A1").id });
		await settle();
		await openBoard(m, "Inbox");
		const r = stubBoardRects(m.root);
		await dragTo(item(m.root, "Sub"), r.card("Sub"), r.columns[sectionOf(m, "Beta").id]!);
		expect(taskOf(m, "Sub").sectionId).toBe(sectionOf(m, "Alpha").id);
		await press(item(m.root, "Sub"), "ArrowRight", { altKey: true });
		expect(taskOf(m, "Sub").sectionId).toBe(sectionOf(m, "Alpha").id);
	});

	it("moving a parent card takes its subtasks along", async () => {
		const m = await mount();
		await seed(m);
		await m.h.app.tasks.create({ title: "Sub", parentId: taskOf(m, "A1").id });
		await settle();
		await openBoard(m, "Inbox");
		const r = stubBoardRects(m.root);
		await dragTo(item(m.root, "A1"), r.card("A1"), r.columns[sectionOf(m, "Beta").id]!);
		expect(taskOf(m, "Sub").sectionId).toBe(sectionOf(m, "Beta").id);
	});

	it("Alt+Right and Alt+Left move a focused top-level card to the adjacent section column", async () => {
		const m = await mount();
		await seed(m);
		await openBoard(m, "Inbox");
		const alpha = sectionOf(m, "Alpha");
		item(m.root, "N1").focus();
		await press(item(m.root, "N1"), "ArrowRight", { altKey: true });
		expect(taskOf(m, "N1").sectionId).toBe(alpha.id);
		expect(document.activeElement).toBe(item(m.root, "N1"));
		await press(document.activeElement!, "ArrowRight", { altKey: true });
		expect(taskOf(m, "N1").sectionId).toBe(sectionOf(m, "Beta").id);
		// Beta is the last column: the key does nothing more.
		await press(document.activeElement!, "ArrowRight", { altKey: true });
		expect(taskOf(m, "N1").sectionId).toBe(sectionOf(m, "Beta").id);
		await press(document.activeElement!, "ArrowLeft", { altKey: true });
		expect(taskOf(m, "N1").sectionId).toBe(alpha.id);
	});

	it("dragging a section header reorders the sections through app.sections.place", async () => {
		const m = await mount();
		await seed(m);
		await m.h.app.sections.create(INBOX_ID, "Gamma");
		await settle();
		await openBoard(m, "Inbox");
		const place = vi.spyOn(m.h.app.sections, "place");
		const undo = vi.spyOn(m.host, "notifyUndo");
		stubBoardRects(m.root);
		const head = (name: string) => columnEl(m.root, sectionOf(m, name).id).querySelector<HTMLElement>(".cp-board-col-head")!;
		// Columns are 300 wide: none 0-300, Alpha 300-600, Beta 600-900, Gamma 900-1200. Gamma's header goes left of Alpha's middle.
		await dragTo(head("Gamma"), { x: 950, y: 20 }, { x: 320, y: 20 });
		expect(place).toHaveBeenCalledTimes(1);
		const g = sectionOf(m, "Gamma").id;
		expect(place.mock.calls[0]![0]).toBe(g);
		expect(sectionNames(m)).toEqual(["Gamma", "Alpha", "Beta"]);
		expect(columnTitles(m.root)).toEqual(["No section", "Gamma", "Alpha", "Beta"]);
		expect(undo).toHaveBeenCalledWith('Moved section "Gamma".', "Move section", expect.any(Number));
		expect(await m.h.app.store.undo()).toBe("Move section");
		expect(sectionNames(m)).toEqual(["Alpha", "Beta", "Gamma"]);
	});

	it("No section can neither be dragged nor be a target", async () => {
		const m = await mount();
		await seed(m);
		await openBoard(m, "Inbox");
		const place = vi.spyOn(m.h.app.sections, "place");
		stubBoardRects(m.root);
		const none = columnEl(m.root, "none").querySelector<HTMLElement>(".cp-board-col-head")!;
		await dragTo(none, { x: 100, y: 20 }, { x: 800, y: 20 });
		expect(place).not.toHaveBeenCalled();
		// A section dragged left of "No section" stays after it.
		const head = columnEl(m.root, sectionOf(m, "Beta").id).querySelector<HTMLElement>(".cp-board-col-head")!;
		await dragTo(head, { x: 650, y: 20 }, { x: 10, y: 20 });
		expect(sectionNames(m)).toEqual(["Beta", "Alpha"]);
		expect(columnTitles(m.root)[0]).toBe("No section");
	});

	it("is read-only aware: no Add section column, disabled header buttons, no drag", async () => {
		const m = await mount();
		await seed(m);
		await openBoard(m, "Inbox");
		await makeReadOnly(m.h);
		m.h.app.store.bus.emit("status", undefined);
		await settle();
		expect(board(m.root).querySelector(".cp-board-add-col")).toBeNull();
		expect(byLabel(m.root, "Options for section Alpha")!.disabled).toBe(true);
		const place = vi.spyOn(m.h.app.sections, "place");
		stubBoardRects(m.root);
		await dragTo(columnEl(m.root, sectionOf(m, "Beta").id).querySelector<HTMLElement>(".cp-board-col-head")!, { x: 650, y: 20 }, { x: 320, y: 20 });
		expect(place).not.toHaveBeenCalled();
	});
});

describe("Quick Add with a section preset", () => {
	it("saves the task in the preset section; a typed other list leaves the section", async () => {
		const m = await mount();
		await seed(m);
		const work = await m.h.app.categories.create("Work", "briefcase");
		const { QuickAddModel } = await import("../../src/ui/quickadd/QuickAddModel");
		const alpha = sectionOf(m, "Alpha");
		const make = (preset: object) =>
			new QuickAddModel(
				{ app: m.h.app, preset, locale: () => "en", resolveNote: () => [], onSaved: () => undefined, onError: (e) => { throw e; }, keepOpen: () => false, onClose: () => undefined },
				() => undefined,
			);
		const one = make({ categoryId: INBOX_ID, sectionId: alpha.id });
		one.setInput("In alpha");
		await one.submit();
		expect(taskOf(m, "In alpha").sectionId).toBe(alpha.id);
		const two = make({ categoryId: INBOX_ID, sectionId: alpha.id });
		two.setInput("Elsewhere #Work");
		await two.submit();
		const moved = taskOf(m, "Elsewhere");
		expect(moved.categoryId).toBe(work.id);
		expect(moved.sectionId).toBeNull();
	});
});

// Flake fixes: the name field must be ready the moment it is in the DOM, and a click on
// "+ Add section" right after the board mounts must not be undone by a late mount effect.
describe("the Add section field is ready when it appears", () => {
	it("takes focus when it mounts, before any passive effect has run", async () => {
		const m = await mount();
		const container = document.createElement("div");
		document.body.appendChild(container);
		containers.push(container);
		render(<AddSectionField host={m.host} categoryId={INBOX_ID} onClose={() => undefined} />, container);
		// No settle(): useEffect would run after the next frame, which is the window the e2e race hit.
		expect(document.activeElement).toBe(container.querySelector(".cp-section-name-input"));
	});

	it("the board's Add section column opened in the first moment after the board mounts stays open", async () => {
		const m = await mount();
		await seed(m);
		await inboxBySection(m);
		modeButtonEl(m).click();
		// Poll microtasks until the column exists: no frame, so no passive effect, has run yet.
		for (let i = 0; i < 50 && board(m.root)?.querySelector(".cp-board-add-section") == null; i++) await Promise.resolve();
		const add = board(m.root)?.querySelector<HTMLElement>(".cp-board-add-section");
		expect(add).not.toBeNull();
		add!.click();
		await settle();
		expect(board(m.root).querySelector(".cp-section-name-input")).not.toBeNull();
	});
});

const modeButtonEl = (m: CalMount) => modeButton(m.root, "Board")!;
