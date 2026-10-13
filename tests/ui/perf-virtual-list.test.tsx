// @vitest-environment happy-dom
import { render } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ViewGroup, buildList } from "../../src/app/views";
import { emptyFilter } from "../../src/domain/queries";
import type { ID, Task } from "../../src/domain/types";
import type { JournalOp } from "../../src/persistence/journal";
import { TaskList } from "../../src/ui/TaskList";
import { VIRTUAL_THRESHOLD } from "../../src/ui/virtual";
import { type AppHarness, appHarness } from "../app/harness";
import { dragTo, focusedIndex, mountNode, pressFocused, pressKey, releaseAt, seedTasks, settle, taskId, U1Host } from "./app-helpers";
import { type FakeLayout, fakeLayout } from "./virtual-layout";
import { cssSection } from "./styles-helpers";

// A Tasks list above VIRTUAL_THRESHOLD rows draws
// only the rows near the viewport. These tests run TaskList in a `.cp-main` scroller over a fake block layout
// (virtual-layout.ts): rows 52 px, headings 30 px, a 520 px viewport (ten rows).

const ROW = 52;
const HEAD = 30;
const VIEWPORT = 520;

let layout: FakeLayout | null = null;
afterEach(() => {
	layout?.restore();
	layout = null;
});

interface Mount {
	h: AppHarness;
	host: U1Host;
	root: HTMLElement;
	main: HTMLElement;
	draw: (groups?: ViewGroup[], extra?: Partial<Parameters<typeof TaskList>[0]>) => Promise<void>;
}

async function mount(count: number, opts: { virtualize?: boolean; groups?: (all: ViewGroup[]) => ViewGroup[]; layout?: boolean } = {}): Promise<Mount> {
	const h = await appHarness();
	seedTasks(h, count);
	const host = new U1Host(h);
	const root = mountNode(null);
	if (opts.layout !== false) {
		layout = fakeLayout({
			viewport: (el) => (el.classList.contains("cp-main") ? VIEWPORT : undefined),
			height: (el) => (el.classList.contains("cp-task-row") ? ROW : el.classList.contains("cp-group-heading") ? HEAD : undefined),
		});
	}
	let selected: ID | null = null;
	const draw = async (groups?: ViewGroup[], extra: Partial<Parameters<typeof TaskList>[0]> = {}) => {
		const state = h.app.store.state;
		const ctx = h.app.queryContext();
		const all = buildList(state, { kind: "inbox" }, ctx, { ...emptyFilter("all"), sort: "manual" }, "").groups;
		render(
			<div class="cp-main">
				<TaskList
					host={host}
					state={state}
					groups={groups ?? (opts.groups === undefined ? all : opts.groups(all))}
					ctx={ctx}
					selectedId={selected}
					showCategory={false}
					emptyText=""
					label="Inbox"
					sort="manual"
					virtualize={opts.virtualize !== false}
					onSelect={(id) => (selected = id)}
					{...extra}
				/>
			</div>,
			root,
		);
		await settle();
	};
	await draw();
	return { h, host, root, main: root.querySelector<HTMLElement>(".cp-main")!, draw };
}

const rows = (m: Mount) => [...m.root.querySelectorAll<HTMLElement>(".cp-task-row")];
const drawnTitles = (m: Mount) => rows(m).map((r) => r.querySelector(".cp-task-title")!.textContent.trim());
const rowOf = (m: Mount, i: number) => m.root.querySelector<HTMLElement>(`.cp-task-row[data-task-id="${taskId(i + 1)}"]`);
/** The row's top inside the list content (the scroller's viewport top is 0 at scrollTop 0). */
const contentTop = (m: Mount, el: HTMLElement) => el.getBoundingClientRect().top - m.main.getBoundingClientRect().top + m.main.scrollTop;
const tabKey = (shiftKey = false) => new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true });
const ascending = { ...emptyFilter("all"), sort: "manual" as const };
/** `count` tasks split into two groups of `count / 2` rows, under plain headings (no heading buttons). */
const twoGroups = (all: ViewGroup[]): ViewGroup[] => {
	const entries = all[0]!.entries;
	return [
		{ key: "a", date: null, label: "First", entries: entries.slice(0, entries.length / 2) },
		{ key: "b", date: null, label: "Second", entries: entries.slice(entries.length / 2) },
	];
};
/** The first `half` tasks get `first`, the rest `second` priority (committed in one write). */
function prioritise(m: Mount, half: number, first: 0 | 1 | 2 | 3, second: 0 | 1 | 2 | 3): void {
	const data = m.h.store.data;
	const tasks = new Map(data.tasks);
	const ops: JournalOp[] = [];
	for (const t of data.tasks.values()) {
		const n = parseInt(t.id.slice(-12), 16) - 1;
		if (!t.title.startsWith("Task ")) continue;
		const v: Task = { ...t, priority: n < half ? first : second };
		tasks.set(t.id, v);
		ops.push({ c: "tasks", id: t.id, v });
	}
	m.h.store.commit({ ...data, tasks }, ops);
}
const byPriority = (m: Mount) => buildList(m.h.app.store.state, { kind: "inbox" }, m.h.app.queryContext(), ascending, "", undefined, { groupBy: "priority" }).groups;

describe("at or below the threshold", () => {
	it("renders exactly the markup it renders without windowing", async () => {
		const plain = await mount(VIRTUAL_THRESHOLD, { virtualize: false });
		const windowed = await mount(VIRTUAL_THRESHOLD);
		expect(rows(windowed)).toHaveLength(VIRTUAL_THRESHOLD);
		expect(windowed.root.querySelector(".cp-virtual-spacer")).toBeNull();
		// The element IDs come from a page-wide counter, so they differ between two mounts.
		const markup = (m: Mount) => m.root.innerHTML.replace(/cp-list-\d+/g, "cp-list-N");
		expect(markup(windowed)).toBe(markup(plain));
	});

	it("Search and the Calendar do not opt in: a long list there draws every row", async () => {
		const m = await mount(400, { virtualize: false });
		expect(rows(m)).toHaveLength(400);
	});
});

describe("above the threshold", () => {
	it("draws only the rows near the viewport, and spacers keep the full height", async () => {
		const m = await mount(2000);
		const drawn = rows(m);
		expect(drawn.length).toBeGreaterThan(VIEWPORT / ROW);
		expect(drawn.length).toBeLessThan(40);
		expect(drawnTitles(m)[0]).toBe("Task 0");
		expect(layout!.contentHeight(m.main)).toBe(2000 * ROW);
		// The listbox and its rows keep their roles and labels; the spacers are hidden from assistive technology.
		const box = m.root.querySelector(".cp-task-rows")!;
		expect(box.getAttribute("role")).toBe("listbox");
		expect(drawn.every((r) => r.getAttribute("role") === "option" && r.parentElement === box)).toBe(true);
		expect([...box.querySelectorAll(".cp-virtual-spacer")].every((s) => s.getAttribute("aria-hidden") === "true")).toBe(true);
	});

	it("each drawn row tells assistive technology its listbox's size and its position; at the threshold rows carry neither", async () => {
		const plain = await mount(VIRTUAL_THRESHOLD);
		expect(plain.root.querySelector("[aria-setsize], [aria-posinset]")).toBeNull();
		const m = await mount(600, {
			groups: (all) => [
				{ key: "a", date: null, label: "First", entries: all[0]!.entries.slice(0, 300) },
				{ key: "b", date: null, label: "Second", entries: all[0]!.entries.slice(300, 500) },
				{ key: "c", date: null, label: "Third", entries: all[0]!.entries.slice(500) },
			],
		});
		await layout!.scrollTo(m.main, 2 * HEAD + 495 * ROW);
		const check = (i: number, size: number, pos: number) => {
			const el = rowOf(m, i);
			expect(el, `row ${i}`).not.toBeNull();
			expect(el!.getAttribute("aria-setsize"), `row ${i}`).toBe(String(size));
			expect(el!.getAttribute("aria-posinset"), `row ${i}`).toBe(String(pos));
		};
		check(495, 200, 196);
		check(499, 200, 200);
		check(500, 100, 1);
		check(505, 100, 6);
		expect(rows(m).every((r) => r.hasAttribute("aria-setsize") && r.hasAttribute("aria-posinset"))).toBe(true);
	});

	it("scrolling draws the rows at the new position, each at its true offset", async () => {
		const m = await mount(2000);
		await layout!.scrollTo(m.main, 1000 * ROW);
		expect(rowOf(m, 0)).toBeNull();
		for (const i of [995, 1000, 1009]) {
			const el = rowOf(m, i);
			expect(el, `row ${i}`).not.toBeNull();
			expect(contentTop(m, el!)).toBe(i * ROW);
		}
		expect(layout!.contentHeight(m.main)).toBe(2000 * ROW);
		await layout!.scrollTo(m.main, 2000 * ROW);
		expect(rowOf(m, 1999)).not.toBeNull();
		expect(contentTop(m, rowOf(m, 1999)!)).toBe(1999 * ROW);
	});

	it("a group far below the viewport draws no row until it is reached; its heading stays", async () => {
		const m = await mount(600, {
			groups: (all) => [
				{ key: "a", date: null, label: "First", entries: all[0]!.entries.slice(0, 300) },
				{ key: "b", date: null, label: "Second", entries: all[0]!.entries.slice(300) },
			],
		});
		const headings = [...m.root.querySelectorAll(".cp-group-heading")].map((e) => e.textContent);
		expect(headings).toEqual(["First300", "Second300"]);
		expect(rowOf(m, 300)).toBeNull();
		await layout!.scrollTo(m.main, HEAD + 300 * ROW);
		expect(rowOf(m, 300)).not.toBeNull();
		expect(contentTop(m, rowOf(m, 300)!)).toBe(2 * HEAD + 300 * ROW);
		// The first group's rows went once the viewport left it.
		expect(rowOf(m, 0)).toBeNull();
		expect(rows(m).length).toBeLessThan(60);
	});
});

describe("keyboard", () => {
	it("ArrowDown walks every row, drawing and scrolling each into view, and ArrowUp walks back", async () => {
		const m = await mount(400);
		rowOf(m, 0)!.focus();
		for (let i = 1; i < 400; i++) {
			await pressFocused("ArrowDown");
			if (focusedIndex() !== i) throw new Error(`ArrowDown ${i}: focus is on ${focusedIndex()}`);
			const top = contentTop(m, rowOf(m, i)!);
			if (top < m.main.scrollTop || top + ROW > m.main.scrollTop + VIEWPORT) throw new Error(`ArrowDown ${i}: the row is out of view`);
		}
		// Far fewer rows are drawn than the list has.
		expect(rows(m).length).toBeLessThan(60);
		await pressFocused("ArrowDown");
		expect(focusedIndex()).toBe(399);
		for (let i = 398; i >= 0; i--) {
			await pressFocused("ArrowUp");
			if (focusedIndex() !== i) throw new Error(`ArrowUp ${i}: focus is on ${focusedIndex()}`);
		}
		expect(m.main.scrollTop).toBe(0);
	}, 30_000);

	it("a focused row scrolled far out of view stays drawn and focused; ArrowDown then goes to the next row", async () => {
		const m = await mount(2000);
		const five = rowOf(m, 5)!;
		five.focus();
		await layout!.scrollTo(m.main, 1500 * ROW);
		expect(rowOf(m, 5)).toBe(five);
		expect(document.activeElement).toBe(five);
		expect(contentTop(m, five)).toBe(5 * ROW);
		expect(rowOf(m, 1500)).not.toBeNull();
		await pressKey(five, "ArrowDown");
		expect(focusedIndex()).toBe(6);
		// Focusing it scrolled it into view, like any focused row.
		expect(m.main.scrollTop).toBeLessThanOrEqual(6 * ROW);
	});

	it("Tab from a row whose next row is not drawn goes to that row; Shift+Tab to the previous one", async () => {
		const m = await mount(2000);
		const five = rowOf(m, 5)!;
		five.focus();
		await layout!.scrollTo(m.main, 1500 * ROW);
		const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
		five.dispatchEvent(tab);
		await settle();
		expect(tab.defaultPrevented).toBe(true);
		expect(focusedIndex()).toBe(6);
		await layout!.scrollTo(m.main, 1500 * ROW);
		const back = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
		document.activeElement!.dispatchEvent(back);
		await settle();
		expect(focusedIndex()).toBe(5);
		// Between two drawn neighbours the browser's own Tab order is left alone.
		const plain = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
		document.activeElement!.dispatchEvent(plain);
		expect(plain.defaultPrevented).toBe(false);
	});

	it("ArrowDown from the last row of a group goes to the first row of the next group, drawn or not", async () => {
		const m = await mount(600, {
			groups: (all) => [
				{ key: "a", date: null, label: "First", entries: all[0]!.entries.slice(0, 300) },
				{ key: "b", date: null, label: "Second", entries: all[0]!.entries.slice(300) },
			],
		});
		await layout!.scrollTo(m.main, 290 * ROW);
		rowOf(m, 299)!.focus();
		// Scroll away so neither the row nor the next group's first row would be drawn without the pin.
		await layout!.scrollTo(m.main, 0);
		expect(rowOf(m, 300)).toBeNull();
		await pressKey(document.activeElement!, "ArrowDown");
		expect(focusedIndex()).toBe(300);
		await pressKey(document.activeElement!, "ArrowUp");
		expect(focusedIndex()).toBe(299);
	});

	it("Tab out of a group's last row goes to the next group's first row when it is not drawn; Shift+Tab comes back", async () => {
		const m = await mount(600, {
			groups: (all) => [
				{ key: "a", date: null, label: "First", entries: all[0]!.entries.slice(0, 300) },
				{ key: "b", date: null, label: "Second", entries: all[0]!.entries.slice(300) },
			],
		});
		await layout!.scrollTo(m.main, 290 * ROW);
		rowOf(m, 299)!.focus();
		// Far into the second group: it draws rows there, but not its first one.
		await layout!.scrollTo(m.main, 2 * HEAD + 450 * ROW);
		expect(rowOf(m, 300)).toBeNull();
		expect(rowOf(m, 450)).not.toBeNull();
		const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
		document.activeElement!.dispatchEvent(tab);
		await settle();
		expect(tab.defaultPrevented).toBe(true);
		expect(focusedIndex()).toBe(300);
		// Back up into the first group, whose last row is no longer drawn once the viewport is far away.
		await layout!.scrollTo(m.main, 0);
		await layout!.scrollTo(m.main, 2 * HEAD + 450 * ROW);
		expect(rowOf(m, 299)).toBeNull();
		const back = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
		document.activeElement!.dispatchEvent(back);
		await settle();
		expect(back.defaultPrevented).toBe(true);
		expect(focusedIndex()).toBe(299);
	});

	it("Tab out of a section's last row is left to the browser: the next section's heading buttons come first", async () => {
		const m = await mount(400);
		const s = await m.h.app.sections.create("inbox", "Later");
		for (const e of buildList(m.h.app.store.state, { kind: "inbox" }, m.h.app.queryContext(), { ...emptyFilter("all"), sort: "manual" }, "").groups[0]!.entries.slice(200)) {
			await m.h.app.tasks.update(e.task.id, { sectionId: s.id });
		}
		const groups = buildList(m.h.app.store.state, { kind: "inbox" }, m.h.app.queryContext(), { ...emptyFilter("all"), sort: "manual" }, "", undefined, { groupBy: "section" }).groups;
		await m.draw(groups, { sections: { categoryId: "inbox", hasAny: true, collapsed: () => false, onToggle: () => undefined, addRequest: 0 } });
		await layout!.scrollTo(m.main, 190 * ROW);
		rowOf(m, 199)!.focus();
		await layout!.scrollTo(m.main, 2 * HEAD + 350 * ROW);
		const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
		document.activeElement!.dispatchEvent(tab);
		expect(tab.defaultPrevented).toBe(false);
		// Shift+Tab from the section's first row: its own heading's buttons come before it.
		await layout!.scrollTo(m.main, 2 * HEAD + 195 * ROW);
		rowOf(m, 200)!.focus();
		const back = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
		document.activeElement!.dispatchEvent(back);
		expect(back.defaultPrevented).toBe(false);
	});

	it("Shift+Tab from the first row of the first listbox and Tab from the last row of the last listbox are left to the browser", async () => {
		const m = await mount(600, { groups: twoGroups });
		const first = rowOf(m, 0)!;
		first.focus();
		// Far from the viewport, so nothing next to it is drawn either.
		await layout!.scrollTo(m.main, 2 * HEAD + 450 * ROW);
		expect(rowOf(m, 0)).toBe(first);
		const back = tabKey(true);
		first.dispatchEvent(back);
		expect(back.defaultPrevented).toBe(false);
		expect(document.activeElement).toBe(first);
		await layout!.scrollTo(m.main, 2 * HEAD + 600 * ROW);
		const last = rowOf(m, 599)!;
		last.focus();
		await layout!.scrollTo(m.main, 0);
		expect(rowOf(m, 599)).toBe(last);
		const forward = tabKey();
		last.dispatchEvent(forward);
		expect(forward.defaultPrevented).toBe(false);
		expect(document.activeElement).toBe(last);
	});

	it("Shift+Tab and Tab at the two ends of a list with one listbox are left to the browser", async () => {
		const m = await mount(400);
		rowOf(m, 0)!.focus();
		const back = tabKey(true);
		document.activeElement!.dispatchEvent(back);
		expect(back.defaultPrevented).toBe(false);
		await layout!.scrollTo(m.main, 400 * ROW);
		rowOf(m, 399)!.focus();
		const forward = tabKey();
		document.activeElement!.dispatchEvent(forward);
		expect(forward.defaultPrevented).toBe(false);
	});

	it("in a read-only database Tab out of a group's last row still reaches the next group's first row, drawn on demand", async () => {
		const m = await mount(600, { groups: twoGroups });
		await m.draw(undefined, { readOnly: true });
		await layout!.scrollTo(m.main, 290 * ROW);
		rowOf(m, 299)!.focus();
		await layout!.scrollTo(m.main, 2 * HEAD + 450 * ROW);
		expect(rowOf(m, 300)).toBeNull();
		const tab = tabKey();
		document.activeElement!.dispatchEvent(tab);
		await settle();
		expect(tab.defaultPrevented).toBe(true);
		expect(focusedIndex()).toBe(300);
		await layout!.scrollTo(m.main, 0);
		await layout!.scrollTo(m.main, 2 * HEAD + 450 * ROW);
		expect(rowOf(m, 299)).toBeNull();
		const back = tabKey(true);
		document.activeElement!.dispatchEvent(back);
		await settle();
		expect(back.defaultPrevented).toBe(true);
		expect(focusedIndex()).toBe(299);
	});

	it("in a read-only database the section heading's disabled buttons do not stand in the way, its toggle still does", async () => {
		const m = await mount(400);
		const s = await m.h.app.sections.create("inbox", "Later");
		for (const e of buildList(m.h.app.store.state, { kind: "inbox" }, m.h.app.queryContext(), ascending, "").groups[0]!.entries.slice(200)) {
			await m.h.app.tasks.update(e.task.id, { sectionId: s.id });
		}
		const groups = buildList(m.h.app.store.state, { kind: "inbox" }, m.h.app.queryContext(), ascending, "", undefined, { groupBy: "section" }).groups;
		await m.draw(groups, { readOnly: true, sections: { categoryId: "inbox", hasAny: true, collapsed: () => false, onToggle: () => undefined, addRequest: 0 } });
		const heading = m.root.querySelectorAll<HTMLElement>(".cp-section-heading")[1]!;
		expect(heading.querySelector<HTMLButtonElement>(".cp-section-add")!.disabled).toBe(true);
		expect(heading.querySelector<HTMLButtonElement>(".cp-section-toggle")!.disabled).toBe(false);
		await layout!.scrollTo(m.main, 190 * ROW);
		rowOf(m, 199)!.focus();
		await layout!.scrollTo(m.main, 2 * HEAD + 350 * ROW);
		// The next stop is the section's toggle, which the browser reaches (the disabled buttons are skipped by it).
		const tab = tabKey();
		document.activeElement!.dispatchEvent(tab);
		expect(tab.defaultPrevented).toBe(false);
		// Past the toggle, the browser's Tab lands on the section's first row: it is drawn when focus gets there.
		await layout!.scrollTo(m.main, 2 * HEAD + 195 * ROW);
		expect(rowOf(m, 200)).not.toBeNull();
	});

	it("rapid keys build on the row the last key went to, not on the event target", async () => {
		const m = await mount(2000);
		const five = rowOf(m, 5)!;
		five.focus();
		await layout!.scrollTo(m.main, 1500 * ROW);
		// Two keys before any render: the second starts from where the first was sent.
		five.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
		five.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
		await settle();
		expect(focusedIndex()).toBe(7);
	});

	it("keeps the focused row's element while the window jumps (no re-insert, so focus and capture survive)", async () => {
		const m = await mount(2000);
		const five = rowOf(m, 5)!;
		five.focus();
		const box = five.parentElement!;
		const moves: Node[] = [];
		const insertBefore = box.insertBefore.bind(box);
		const appendChild = box.appendChild.bind(box);
		box.insertBefore = <N extends Node>(n: N, ref: Node | null) => (moves.push(n), insertBefore(n, ref));
		box.appendChild = <N extends Node>(n: N) => (moves.push(n), appendChild(n));
		for (const y of [300, 900, 7000, 52000, 104000, 20000, 0]) await layout!.scrollTo(m.main, y);
		// Rows came and went around it (the spy sees Preact's inserts), but the focused one was never moved.
		expect(moves.length).toBeGreaterThan(100);
		expect(moves).not.toContain(five);
		expect(rowOf(m, 5)).toBe(five);
		expect(document.activeElement).toBe(five);
	});
});

describe("drag and drop", () => {
	it("reorders a row far down: the drop index comes from the data, the dragged row stays drawn", async () => {
		const m = await mount(2000);
		const place = vi.spyOn(m.h.app.tasks, "place");
		const zero = rowOf(m, 0)!;
		await dragTo(zero, { x: 100, y: ROW / 2 }, { x: 100, y: 300 }, false);
		expect(zero.classList.contains("is-dragging")).toBe(true);
		// Auto-scroll (or the wheel) takes the list far down while the pointer is held.
		await layout!.scrollTo(m.main, 995 * ROW);
		expect(zero.isConnected).toBe(true);
		const target = rowOf(m, 1000)!;
		const y = target.getBoundingClientRect().top + ROW * 0.75;
		zero.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 100, clientY: y, pointerId: 1, pointerType: "mouse", button: 0 }));
		await releaseAt(zero, { x: 100, y });
		expect(place).toHaveBeenCalledTimes(1);
		const order = place.mock.calls[0]![1];
		expect(order).toHaveLength(2000);
		expect(order.indexOf(taskId(1))).toBe(1000);
		expect(order[999]).toBe(taskId(1001));
	});

	it("a Completed history row of an open repeating task (same task id) does not stand in for its open row", async () => {
		const m = await mount(400);
		// Task 1 stands for a daily repeating task near the top; its done date shows in the open Completed group at
		// the end, as a history row with the same data-task-id (and a data-occurrence).
		const state = m.h.app.store.state;
		const repeating = state.tasks.get(taskId(2))!;
		const history = { task: repeating, depth: 0 as const, parentTitle: null, schedule: null, occurrence: { date: "2026-10-05", status: "done" as const } };
		await m.draw(undefined, { completed: { entries: [history], open: true, onToggle: () => undefined, resetKey: "" } });
		await layout!.scrollTo(m.main, 400 * ROW);
		// The open row is not drawn; the history row is.
		expect(rowOf(m, 1)).not.toBeNull();
		expect(rowOf(m, 1)!.dataset.occurrence).toBe("2026-10-05");
		const place = vi.spyOn(m.h.app.tasks, "place");
		const dragged = rowOf(m, 395)!;
		const from = dragged.getBoundingClientRect().top + ROW / 2;
		await dragTo(dragged, { x: 100, y: from }, { x: 100, y: from - 20 }, false);
		// A few rows up: the top quarter of row 391, so the row lands right before it.
		const y = rowOf(m, 391)!.getBoundingClientRect().top + ROW * 0.25;
		dragged.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 100, clientY: y, pointerId: 1, pointerType: "mouse", button: 0 }));
		const line = m.root.querySelector<HTMLElement>(".cp-reorder-line")!;
		const list = m.root.querySelector<HTMLElement>(".cp-task-list")!;
		expect(parseFloat(line.style.top)).toBe(rowOf(m, 391)!.getBoundingClientRect().top - list.getBoundingClientRect().top);
		await releaseAt(dragged, { x: 100, y });
		expect(place).toHaveBeenCalledTimes(1);
		const order = place.mock.calls[0]![1];
		expect(order).toHaveLength(400);
		expect(order.indexOf(taskId(396))).toBe(391);
		expect(order[390]).toBe(taskId(391));
		expect(order[392]).toBe(taskId(392));
	});

	it("draws the drop line at the target row while the list is windowed", async () => {
		const m = await mount(2000);
		const zero = rowOf(m, 0)!;
		await dragTo(zero, { x: 100, y: ROW / 2 }, { x: 100, y: 3 * ROW + 10 }, false);
		const line = m.root.querySelector<HTMLElement>(".cp-reorder-line")!;
		expect(line.hidden).toBe(false);
		// Below row 3's middle? No: above it, so the line is at row 3's top.
		expect(parseFloat(line.style.top)).toBe(3 * ROW);
		await releaseAt(zero, { x: 100, y: 3 * ROW + 10 });
		expect(m.root.querySelector(".cp-reorder-line")).toBeNull();
	});

	it("moves a row into a section far down (another group), placed from the data", async () => {
		const m = await mount(600, { layout: true });
		const s = await m.h.app.sections.create("inbox", "Later");
		const state = m.h.app.store.state;
		const all = buildList(state, { kind: "inbox" }, m.h.app.queryContext(), { ...emptyFilter("all"), sort: "manual" }, "", undefined, { groupBy: "section" }).groups;
		expect(all.map((g) => g.key)).toEqual(["section:none", `section:${s.id}`]);
		// Half the rows go into "Later".
		for (const e of all[0]!.entries.slice(300)) await m.h.app.tasks.update(e.task.id, { sectionId: s.id });
		const groups = () => buildList(m.h.app.store.state, { kind: "inbox" }, m.h.app.queryContext(), { ...emptyFilter("all"), sort: "manual" }, "", undefined, { groupBy: "section" }).groups;
		const sections = { categoryId: "inbox", hasAny: true, collapsed: () => false, onToggle: () => undefined, addRequest: 0 };
		await m.draw(groups(), { sections });
		const place = vi.spyOn(m.h.app.tasks, "place");
		const zero = rowOf(m, 0)!;
		await dragTo(zero, { x: 100, y: HEAD + ROW / 2 }, { x: 100, y: 200 }, false);
		await layout!.scrollTo(m.main, 2 * HEAD + 400 * ROW);
		const target = rowOf(m, 410)!;
		const y = target.getBoundingClientRect().top + ROW * 0.25;
		zero.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 100, clientY: y, pointerId: 1, pointerType: "mouse", button: 0 }));
		await releaseAt(zero, { x: 100, y });
		expect(place).toHaveBeenCalledTimes(1);
		const [id, order, patch] = place.mock.calls[0]!;
		expect(id).toBe(taskId(1));
		expect(patch).toEqual({ sectionId: s.id });
		// Before row 410: after rows 300..409 of the section.
		expect(order.indexOf(taskId(1))).toBe(110);
		expect(order).toHaveLength(301);
	});
});

describe("drag and drop into another group", () => {
	it("a section far down: the line sits at the row under the pointer, then the drop lands there", async () => {
		const m = await mount(600);
		const s = await m.h.app.sections.create("inbox", "Later");
		for (const e of buildList(m.h.app.store.state, { kind: "inbox" }, m.h.app.queryContext(), ascending, "").groups[0]!.entries.slice(300)) {
			await m.h.app.tasks.update(e.task.id, { sectionId: s.id });
		}
		const groups = buildList(m.h.app.store.state, { kind: "inbox" }, m.h.app.queryContext(), ascending, "", undefined, { groupBy: "section" }).groups;
		await m.draw(groups, { sections: { categoryId: "inbox", hasAny: true, collapsed: () => false, onToggle: () => undefined, addRequest: 0 } });
		const place = vi.spyOn(m.h.app.tasks, "place");
		const zero = rowOf(m, 0)!;
		await dragTo(zero, { x: 100, y: HEAD + ROW / 2 }, { x: 100, y: 200 }, false);
		await layout!.scrollTo(m.main, 2 * HEAD + 400 * ROW);
		const list = m.root.querySelector<HTMLElement>(".cp-task-list")!;
		const line = m.root.querySelector<HTMLElement>(".cp-reorder-line")!;
		// Upper half of row 410: the line is at its top, and the row goes in before it.
		const target = rowOf(m, 410)!;
		const y = target.getBoundingClientRect().top + ROW * 0.25;
		zero.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 100, clientY: y, pointerId: 1, pointerType: "mouse", button: 0 }));
		expect(parseFloat(line.style.top)).toBe(2 * HEAD + 410 * ROW);
		expect(parseFloat(line.style.top)).toBe(target.getBoundingClientRect().top - list.getBoundingClientRect().top);
		// Lower half: the line moves to the top of row 411, and the row goes in after row 410.
		const below = target.getBoundingClientRect().top + ROW * 0.75;
		zero.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 100, clientY: below, pointerId: 1, pointerType: "mouse", button: 0 }));
		expect(parseFloat(line.style.top)).toBe(2 * HEAD + 411 * ROW);
		await releaseAt(zero, { x: 100, y: below });
		expect(place).toHaveBeenCalledTimes(1);
		const [id, order, patch] = place.mock.calls[0]!;
		expect(id).toBe(taskId(1));
		expect(patch).toEqual({ sectionId: s.id });
		expect(order).toHaveLength(301);
		// After rows 300..410 of the section.
		expect(order.indexOf(taskId(1))).toBe(111);
		expect(order[110]).toBe(taskId(411));
		expect(order[112]).toBe(taskId(412));
	});

	it("Group by priority: a row dropped into the other group far down lands where the pointer is, with that priority", async () => {
		const m = await mount(600);
		// Tasks 0..299 are High (the first group), 300..599 have no priority (the second).
		prioritise(m, 300, 1, 0);
		const groups = byPriority(m);
		expect(groups.map((g) => g.key)).toEqual(["priority:1", "priority:0"]);
		await m.draw(groups);
		const place = vi.spyOn(m.h.app.tasks, "place");
		const zero = rowOf(m, 0)!;
		await dragTo(zero, { x: 100, y: HEAD + ROW / 2 }, { x: 100, y: 200 }, false);
		await layout!.scrollTo(m.main, 2 * HEAD + 500 * ROW);
		expect(rowOf(m, 0)).toBe(zero);
		const list = m.root.querySelector<HTMLElement>(".cp-task-list")!;
		const line = m.root.querySelector<HTMLElement>(".cp-reorder-line")!;
		const target = rowOf(m, 500)!;
		const y = target.getBoundingClientRect().top + ROW * 0.75;
		zero.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 100, clientY: y, pointerId: 1, pointerType: "mouse", button: 0 }));
		// Lower half of row 500: the line is at the top of row 501.
		expect(parseFloat(line.style.top)).toBe(2 * HEAD + 501 * ROW);
		expect(parseFloat(line.style.top)).toBe(rowOf(m, 501)!.getBoundingClientRect().top - list.getBoundingClientRect().top);
		await releaseAt(zero, { x: 100, y });
		expect(place).toHaveBeenCalledTimes(1);
		const [id, order, patch] = place.mock.calls[0]!;
		expect(id).toBe(taskId(1));
		expect(patch).toEqual({ priority: 0 });
		expect(order).toHaveLength(301);
		// After rows 300..500 of the group.
		expect(order.indexOf(taskId(1))).toBe(201);
		expect(order[200]).toBe(taskId(501));
		expect(order[202]).toBe(taskId(502));
	});

	it("Group by priority: a row from the lower group dropped far up in the first one lands at the pointer", async () => {
		const m = await mount(600);
		prioritise(m, 300, 1, 0);
		await m.draw(byPriority(m));
		const place = vi.spyOn(m.h.app.tasks, "place");
		await layout!.scrollTo(m.main, 2 * HEAD + 550 * ROW);
		const dragged = rowOf(m, 560)!;
		const from = dragged.getBoundingClientRect().top + ROW / 2;
		await dragTo(dragged, { x: 100, y: from }, { x: 100, y: from - 20 }, false);
		await layout!.scrollTo(m.main, 0);
		expect(dragged.isConnected).toBe(true);
		const target = rowOf(m, 7)!;
		const y = target.getBoundingClientRect().top + ROW * 0.25;
		dragged.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 100, clientY: y, pointerId: 1, pointerType: "mouse", button: 0 }));
		await releaseAt(dragged, { x: 100, y });
		expect(place).toHaveBeenCalledTimes(1);
		const [id, order, patch] = place.mock.calls[0]!;
		expect(id).toBe(taskId(561));
		expect(patch).toEqual({ priority: 1 });
		expect(order).toHaveLength(301);
		// Before row 7: after rows 0..6.
		expect(order.indexOf(taskId(561))).toBe(7);
		expect(order[8]).toBe(taskId(8));
	});
});

describe("collapse", () => {
	it("collapsing a section of thousands removes its rows at once and the next group draws at its new place", async () => {
		const m = await mount(2400);
		const s = await m.h.app.sections.create("inbox", "Later");
		const ids = [...m.h.app.store.state.tasks.values()].filter((t) => t.title.startsWith("Task ")).map((t) => t.id);
		for (const id of ids.slice(2000)) await m.h.app.tasks.update(id, { sectionId: s.id });
		const groups = () => buildList(m.h.app.store.state, { kind: "inbox" }, m.h.app.queryContext(), { ...emptyFilter("all"), sort: "manual" }, "", undefined, { groupBy: "section" }).groups;
		let collapsed = false;
		const sections = () => ({ categoryId: "inbox", hasAny: true, collapsed: (k: string) => collapsed && k === "section:inbox:none", onToggle: () => undefined, addRequest: 0 });
		await m.draw(groups(), { sections: sections() });
		expect(rowOf(m, 2000)).toBeNull();
		collapsed = true;
		await m.draw(groups(), { sections: sections() });
		// "No section" shows only its heading; "Later" now starts right under it and draws its first rows.
		expect(rowOf(m, 0)).toBeNull();
		const first = rowOf(m, 2000);
		expect(first).not.toBeNull();
		expect(contentTop(m, first!)).toBe(2 * HEAD);
	});
});

describe("stylesheet", () => {
	// The section's scoping and hygiene are checked with the other sections in layout-styles.test.ts.
	it("the spacer takes its height from a custom property, draws nothing and is scoped to the view", () => {
		const section = cssSection("Release B windowed lists");
		expect(section).toContain(".checkpoint-view .cp-virtual-spacer {");
		expect(section).toMatch(/height:\s*var\(--cp-virtual-h, 0\)/);
		expect(section).toMatch(/flex:\s*none/);
	});
});
