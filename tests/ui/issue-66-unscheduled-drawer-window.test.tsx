// @vitest-environment happy-dom
import { render } from "preact";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Task } from "../../src/domain/types";
import type { JournalOp } from "../../src/persistence/journal";
import { CalendarSection, initialCalendarState } from "../../src/ui/CalendarSection";
import { VIRTUAL_THRESHOLD } from "../../src/ui/virtual";
import { type AppHarness, appHarness } from "../app/harness";
import { makeTask } from "../persistence/fixtures";
import { settle } from "./m4-helpers";
import { U1Host } from "./u1-helpers";
import { type FakeLayout, fakeLayout } from "./virtual-layout";

// Issue 66: the calendar's Unscheduled drawer draws only the rows near its viewport once it lists more than
// VIRTUAL_THRESHOLD tasks, with the Tasks lists' windowing (TaskList, VirtualRows). These tests run the calendar over a
// fake block layout (virtual-layout.ts): rows 52 px, the drawer a 520 px scroller (ten rows).

const ROW = 52;
const VIEWPORT = 520;

beforeAll(() => {
	(HTMLElement.prototype as unknown as { empty: () => void }).empty = function (this: HTMLElement) {
		this.replaceChildren();
	};
});

let layout: FakeLayout | null = null;
const roots: HTMLElement[] = [];
afterEach(() => {
	for (const r of roots.splice(0)) {
		render(null, r);
		r.remove();
	}
	layout?.restore();
	layout = null;
});

const taskId = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

/** `count` open tasks without a date, "Task 0".."Task n-1" in that order, committed in one write. */
async function seeded(count: number): Promise<AppHarness> {
	const h = await appHarness();
	const data = h.store.data;
	const tasks = new Map(data.tasks);
	const ops: JournalOp[] = [];
	for (let i = 0; i < count; i++) {
		const t: Task = makeTask(taskId(i + 1), { title: `Task ${i}`, sortKey: `V${i.toString(36).padStart(4, "0")}` });
		tasks.set(t.id, t);
		ops.push({ c: "tasks", id: t.id, v: t });
	}
	h.store.commit({ ...data, tasks }, ops);
	return h;
}

/** The calendar with its Unscheduled drawer open over `count` undated tasks. */
async function mount(count: number) {
	const h = await seeded(count);
	const host = new U1Host(h);
	const root = document.createElement("div");
	document.body.appendChild(root);
	roots.push(root);
	layout = fakeLayout({
		viewport: (el) => (el.classList.contains("cp-cal-unscheduled") ? VIEWPORT : undefined),
		height: (el) => (el.classList.contains("cp-task-row") ? ROW : undefined),
	});
	const ui = { ...initialCalendarState(h.app.queryContext().today), unscheduledOpen: true };
	render(<CalendarSection host={host} state={h.app.store.state} ctx={h.app.queryContext()} ui={ui} setUi={() => undefined} visible={true} />, root);
	await settle();
	const drawer = root.querySelector<HTMLElement>(".cp-cal-unscheduled")!;
	return { h, root, drawer };
}

type Mount = Awaited<ReturnType<typeof mount>>;
const rows = (m: Mount) => [...m.drawer.querySelectorAll<HTMLElement>(".cp-task-row")];
const rowOf = (m: Mount, i: number) => m.drawer.querySelector<HTMLElement>(`.cp-task-row[data-task-id="${taskId(i + 1)}"]`);
const focusedIndex = () => {
	const id = (document.activeElement as HTMLElement | null)?.dataset?.taskId;
	return id === undefined ? -1 : parseInt(id.slice(-12), 16) - 1;
};
const key = async (k: string) => {
	document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
	await new Promise((r) => setTimeout(r, 0));
};
function ptr(type: string, x: number, y: number): Event {
	const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
	Object.defineProperty(ev, "pointerId", { value: 1 });
	Object.defineProperty(ev, "pointerType", { value: "mouse" });
	return ev;
}

describe("the Unscheduled drawer's rows (issue 66)", () => {
	it(`draws only the rows near its viewport above ${VIRTUAL_THRESHOLD} tasks, and further rows as it scrolls`, async () => {
		const m = await mount(400);
		// The header still counts every task.
		expect(m.root.querySelector(".cp-cal-unscheduled-toggle")?.textContent).toContain("400");
		expect(rowOf(m, 0)).not.toBeNull();
		expect(rows(m).length).toBeGreaterThan(0);
		expect(rows(m).length).toBeLessThan(60);
		await layout!.scrollTo(m.drawer, 200 * ROW);
		await settle();
		expect(rowOf(m, 200)).not.toBeNull();
		expect(rowOf(m, 0)).toBeNull();
		expect(rows(m).length).toBeLessThan(60);
	});

	it(`draws every row at ${VIRTUAL_THRESHOLD} tasks, as before`, async () => {
		const m = await mount(VIRTUAL_THRESHOLD);
		expect(rows(m)).toHaveLength(VIRTUAL_THRESHOLD);
	});

	it("walks the windowed rows with ArrowDown, drawing each one it reaches", async () => {
		const m = await mount(400);
		rowOf(m, 0)!.focus();
		for (let i = 1; i <= 60; i++) {
			await key("ArrowDown");
			if (focusedIndex() !== i) throw new Error(`ArrowDown ${i}: focus is on ${focusedIndex()}`);
		}
		expect(rows(m).length).toBeLessThan(60);
	});

	it("drags a row drawn after a scroll out of the drawer, by its task", async () => {
		const m = await mount(400);
		await layout!.scrollTo(m.drawer, 200 * ROW);
		await settle();
		const row = rowOf(m, 205)!;
		row.dispatchEvent(ptr("pointerdown", 650, 100));
		row.dispatchEvent(ptr("pointermove", 656, 106));
		row.dispatchEvent(ptr("pointermove", 300, 200));
		await settle();
		expect(m.root.querySelector(".cp-calendar")!.classList.contains("is-dragging")).toBe(true);
		row.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		await settle();
	});
});
