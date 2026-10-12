// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { covers, itemOffsets, rangeIn, renderIndices, VIRTUAL_THRESHOLD, windowPlan } from "../../src/ui/virtual";
import { render } from "preact";
import type { Task } from "../../src/domain/types";
import type { JournalOp } from "../../src/persistence/journal";
import { CalendarSection, initialCalendarState } from "../../src/ui/CalendarSection";
import { type AppHarness, appHarness } from "../app/harness";
import { makeTask } from "../persistence/fixtures";
import { settle } from "./matrix-helpers";
import { U1Host } from "./app-helpers";
import { type FakeLayout, fakeLayout } from "./virtual-layout";

describe("windowing math", () => {
	// The windowing math behind VirtualRows.

	const uniform = (n: number, size: number, gap = 0) => itemOffsets(n, () => size, gap);

	describe("itemOffsets", () => {
		it("starts each item after the sizes and gaps before it", () => {
			const o = itemOffsets(3, (i) => [10, 20, 30][i]!, 4);
			expect([...o]).toEqual([0, 14, 38, 72]);
		});

		it("is a single zero for no items", () => {
			expect([...itemOffsets(0, () => 52, 8)]).toEqual([0]);
		});
	});

	describe("rangeIn", () => {
		const o = uniform(100, 50);

		it("finds the items that intersect the band", () => {
			expect(rangeIn(o, 0, 120)).toEqual({ start: 0, end: 3 });
			expect(rangeIn(o, 125, 260)).toEqual({ start: 2, end: 6 });
			// An item that only touches the band's top edge is outside it.
			expect(rangeIn(o, 100, 150)).toEqual({ start: 2, end: 3 });
		});

		it("clamps a band that reaches past either end", () => {
			expect(rangeIn(o, -500, 75)).toEqual({ start: 0, end: 2 });
			expect(rangeIn(o, 4900, 9000)).toEqual({ start: 98, end: 100 });
			expect(rangeIn(o, -100, 99999)).toEqual({ start: 0, end: 100 });
		});

		it("is empty for a band above or below every item", () => {
			const above = rangeIn(o, -900, -10);
			expect(above.end - above.start).toBe(0);
			const below = rangeIn(o, 6000, 7000);
			expect(below.end - below.start).toBe(0);
			expect(rangeIn(uniform(0, 50), 0, 100)).toEqual({ start: 0, end: 0 });
		});
	});

	describe("renderIndices", () => {
		it("adds pinned items outside the range, sorted and without duplicates", () => {
			expect(renderIndices({ start: 10, end: 13 }, [40, 11, 2, 40, -1, 99], 50)).toEqual([2, 10, 11, 12, 40]);
		});

		it("is only the pins for an empty range", () => {
			expect(renderIndices({ start: 5, end: 5 }, [7], 10)).toEqual([7]);
			expect(renderIndices({ start: 5, end: 5 }, [], 10)).toEqual([]);
		});
	});

	describe("windowPlan", () => {
		it("puts a spacer before, between and after the drawn items, so every item keeps its offset", () => {
			const o = uniform(10, 50);
			expect(windowPlan(o, 0, [3, 4, 8])).toEqual([
				{ kind: "spacer", after: 0, height: 150 },
				{ kind: "item", index: 3 },
				{ kind: "item", index: 4 },
				{ kind: "spacer", after: 5, height: 150 },
				{ kind: "item", index: 8 },
				{ kind: "spacer", after: 9, height: 50 },
			]);
		});

		it("needs no spacer when every item is drawn", () => {
			expect(windowPlan(uniform(3, 50), 0, [0, 1, 2])).toEqual([0, 1, 2].map((index) => ({ kind: "item", index })));
		});

		it("is one spacer of the full height when nothing is drawn", () => {
			expect(windowPlan(uniform(4, 50, 8), 8, [])).toEqual([{ kind: "spacer", after: 0, height: 4 * 50 + 3 * 8 }]);
		});

		it("subtracts the flex gaps a spacer adds around itself", () => {
			// Items of 40 with 8 px gaps: item 2 starts at 96. A spacer, its gap and item 2 must land there.
			const o = uniform(5, 40, 8);
			const plan = windowPlan(o, 8, [2]);
			expect(plan).toEqual([
				{ kind: "spacer", after: 0, height: 88 },
				{ kind: "item", index: 2 },
				{ kind: "spacer", after: 3, height: 88 },
			]);
			// Flow: spacer 88 + gap 8 = 96 (item 2's top); item 2 ends at 136, + gap 8 + spacer 88 = 232 = the full height.
			expect(88 + 8).toBe(o[2]);
			expect(o[3]! - 8 + 8 + 88).toBe(o[5]! - 8);
		});

		it("an empty list has no parts", () => {
			expect(windowPlan(uniform(0, 50), 0, [])).toEqual([]);
		});
	});

	describe("covers", () => {
		it("is true when the needed range lies inside the drawn one", () => {
			expect(covers({ start: 0, end: 30 }, { start: 5, end: 20 })).toBe(true);
			expect(covers({ start: 5, end: 30 }, { start: 4, end: 20 })).toBe(false);
			expect(covers({ start: 5, end: 30 }, { start: 6, end: 31 })).toBe(false);
		});

		it("an empty need is always covered; a need is never covered by an empty range", () => {
			expect(covers({ start: 3, end: 3 }, { start: 9, end: 9 })).toBe(true);
			expect(covers({ start: 3, end: 3 }, { start: 3, end: 4 })).toBe(false);
		});
	});
});

describe("the Unscheduled drawer", () => {
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

	describe("#66: the Unscheduled drawer's rows", () => {
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
});
