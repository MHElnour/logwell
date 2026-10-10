// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { byLabel, click, mountCal, settle, type CalMount } from "./m3-helpers";
import { openViewMenu, pickItem } from "./view-menu-helpers";

// Section state is written with an updater, never by spreading the `ui` object a render captured: a
// menu that stays open past a later change must not bring back what that change replaced.

beforeAll(() => {
	(HTMLElement.prototype as unknown as { createDiv: (o: { cls: string }) => HTMLElement }).createDiv = function (this: HTMLElement, o) {
		const el = this.ownerDocument.createElement("div");
		el.className = o.cls;
		this.appendChild(el);
		return el;
	};
});

const mounted: CalMount[] = [];
afterEach(() => {
	for (const m of mounted.splice(0)) m.unmount();
});

const tasksEl = (m: CalMount) => m.root.querySelector<HTMLElement>(".cp-tasks")!;
const selected = (m: CalMount) =>
	[...tasksEl(m).querySelectorAll<HTMLElement>(".cp-task-row.is-selected")].map((r) => r.querySelector(".cp-task-title")!.textContent.trim());

async function twoTasks() {
	const m = await mountCal();
	mounted.push(m);
	const work = await m.h.app.categories.create("Work");
	const a = (await m.h.app.tasks.create({ title: "Alpha", categoryId: work.id })).task;
	const b = (await m.h.app.tasks.create({ title: "Beta", categoryId: work.id })).task;
	const view = { kind: "category" as const, id: work.id };
	m.handle.current!.showTasks(view, a.id);
	await settle();
	expect(selected(m)).toEqual(["Alpha"]);
	return { m, view, b };
}

describe("Tasks view menu after the selection changed", () => {
	for (const pick of ["Sort: by priority", "Add section", "Show completed"]) {
		it(`"${pick}" keeps the task selected in the meantime`, async () => {
			const { m, view, b } = await twoTasks();
			const menu = await openViewMenu(m, tasksEl(m));
			m.handle.current!.showTasks(view, b.id);
			await settle();
			expect(selected(m)).toEqual(["Beta"]);
			await pickItem(m, menu, pick);
			expect(selected(m)).toEqual(["Beta"]);
		});
	}
});

describe("Search results opening a list", () => {
	it("keeps what another change wrote to the Tasks state in the same turn", async () => {
		const m = await mountCal();
		mounted.push(m);
		const work = await m.h.app.categories.create("Work");
		const x = (await m.h.app.tasks.create({ title: "Target", categoryId: work.id })).task;
		const typeIn = async (selector: string, text: string) => {
			const input = m.root.querySelector<HTMLInputElement>(selector)!;
			input.value = text;
			input.dispatchEvent(new Event("input", { bubbles: true }));
			await settle();
		};
		await typeIn('.cp-tasks input[aria-label="Search this list"]', "zzz");
		await click(byLabel(m.root, "Search"));
		await typeIn(".cp-search input[type=search]", "Work");
		const link = [...m.root.querySelectorAll<HTMLButtonElement>(".cp-search-categories .cp-link-button")].find((b) => b.textContent.includes("Work"))!;
		// One synchronous turn: another change clears the list's search text, then the result is clicked.
		m.handle.current!.showTasks({ kind: "inbox" }, x.id);
		link.click();
		await settle();
		expect(m.root.querySelector<HTMLInputElement>('.cp-tasks input[aria-label="Search this list"]')!.value).toBe("");
		expect(tasksEl(m).querySelector(".cp-main-title")!.textContent).toContain("Work");
	});
});
