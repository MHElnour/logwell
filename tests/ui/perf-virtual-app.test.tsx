// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { LINGER_MS } from "../../src/ui/useLingering";
import { type AppHarness, appHarness } from "../app/harness";
import { type AppMount, click, mountApp, seedTasks, settle, sidebarItem, taskId } from "./app-helpers";
import { type FakeLayout, fakeLayout } from "./virtual-layout";

// The windowed-list checks that need the whole Tasks
// section (lingering, Undo, new tasks, "Search this list", selection and details, the counts), with 2,000 Inbox
// tasks over the fake layout of virtual-layout.ts (rows 52 px, a 520 px viewport).

const ROW = 52;
const VIEWPORT = 520;
const COUNT = 2000;

let layout: FakeLayout | null = null;
afterEach(() => {
	layout?.restore();
	layout = null;
});

interface Mount extends AppMount {
	main: HTMLElement;
}

async function mount(): Promise<Mount> {
	const h: AppHarness = await appHarness();
	seedTasks(h, COUNT);
	layout = fakeLayout({
		viewport: (el) => (el.classList.contains("cp-main") ? VIEWPORT : undefined),
		height: (el) => (el.classList.contains("cp-task-row") ? ROW : undefined),
	});
	const m = await mountApp({}, { harness: h });
	await click(sidebarItem(m.root, "Inbox"));
	return Object.assign(m, { main: m.root.querySelector<HTMLElement>(".cp-tasks .cp-main")! });
}

const rows = (m: Mount) => [...m.main.querySelectorAll<HTMLElement>(".cp-task-row")];
const rowOf = (m: Mount, i: number) => m.main.querySelector<HTMLElement>(`.cp-task-row[data-task-id="${taskId(i + 1)}"]`);
/** The row's top inside the list content (row 0 is at 0). */
const listTop = (m: Mount, el: HTMLElement) => el.getBoundingClientRect().top - m.main.querySelector(".cp-task-rows")!.getBoundingClientRect().top;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the Tasks section with 2,000 rows", () => {
	it("draws a window of rows; the count pill still shows every task", async () => {
		const m = await mount();
		expect(m.root.querySelector(".cp-tasks .cp-main-title")!.textContent).toBe("Inbox");
		expect(rows(m).length).toBeLessThan(40);
		expect(m.root.querySelector(".cp-count-pill")!.textContent).toBe(String(COUNT));
	});

	it("a completed row lingers for its hold time, then leaves without moving the scroll position; Undo puts it back", async () => {
		const m = await mount();
		await layout!.scrollTo(m.main, 1000 * ROW);
		const top = m.main.scrollTop;
		const row = rowOf(m, 1003)!;
		row.querySelector<HTMLInputElement>(".cp-task-checkbox")!.click();
		await settle();
		expect(m.h.app.store.state.tasks.get(taskId(1004))!.status).toBe("completed");
		// Held among the open rows, in place, for the check animation.
		expect(rowOf(m, 1003)).toBe(row);
		expect(row.classList.contains("is-completed")).toBe(true);
		expect(listTop(m, row)).toBe(1003 * ROW);
		await wait(LINGER_MS + 150);
		await settle();
		expect(rowOf(m, 1003)).toBeNull();
		expect(m.main.scrollTop).toBe(top);
		expect(listTop(m, rowOf(m, 1004)!)).toBe(1003 * ROW);
		expect(await m.h.app.store.undo()).not.toBeNull();
		await settle();
		const back = rowOf(m, 1003)!;
		expect(back).not.toBeNull();
		expect(back.classList.contains("is-completed")).toBe(false);
		expect(listTop(m, back)).toBe(1003 * ROW);
		expect(m.main.scrollTop).toBe(top);
	});

	it("a new task goes to the end as today: drawn there when the end is in view, the scroll position kept otherwise", async () => {
		const m = await mount();
		const { task } = await m.h.app.tasks.create({ title: "Fresh" });
		await settle();
		expect(m.main.querySelector(`.cp-task-row[data-task-id="${task.id}"]`)).toBeNull();
		expect(m.main.scrollTop).toBe(0);
		await layout!.scrollTo(m.main, (COUNT + 1) * ROW);
		const fresh = m.main.querySelector<HTMLElement>(`.cp-task-row[data-task-id="${task.id}"]`)!;
		expect(fresh).not.toBeNull();
		expect(listTop(m, fresh)).toBe(COUNT * ROW);
		const { task: second } = await m.h.app.tasks.create({ title: "Fresher" });
		await settle();
		expect(m.main.querySelector(`.cp-task-row[data-task-id="${second.id}"]`)).not.toBeNull();
	});

	it("Search this list filters as today; a short result draws every row, plain", async () => {
		const m = await mount();
		const search = m.root.querySelector<HTMLInputElement>(".cp-tasks .cp-view-search")!;
		search.value = "Task 199";
		search.dispatchEvent(new Event("input", { bubbles: true }));
		await settle();
		// "Task 199" and "Task 1990".."Task 1999".
		expect(rows(m).map((r) => r.querySelector(".cp-task-title")!.textContent.trim()).sort()).toEqual(
			["Task 199", ...Array.from({ length: 10 }, (_, i) => `Task 199${i}`)].sort(),
		);
		expect(m.main.querySelector(".cp-virtual-spacer")).toBeNull();
		search.value = "Task";
		search.dispatchEvent(new Event("input", { bubbles: true }));
		await settle();
		expect(rows(m).length).toBeLessThan(40);
		expect(m.main.querySelector(".cp-virtual-spacer")).not.toBeNull();
	});

	it("selecting a row far down opens its details; the row stays selected and in view, also after scrolling away and back", async () => {
		const m = await mount();
		await layout!.scrollTo(m.main, 1200 * ROW);
		const top = m.main.scrollTop;
		await click(rowOf(m, 1204));
		expect(m.root.querySelector(".cp-tasks")!.classList.contains("has-details")).toBe(true);
		expect(rowOf(m, 1204)!.classList.contains("is-selected")).toBe(true);
		expect(m.main.scrollTop).toBe(top);
		await layout!.scrollTo(m.main, 0);
		await layout!.scrollTo(m.main, top);
		expect(rowOf(m, 1204)!.classList.contains("is-selected")).toBe(true);
		expect(m.root.querySelectorAll(".cp-task-row.is-selected")).toHaveLength(1);
	});
});
