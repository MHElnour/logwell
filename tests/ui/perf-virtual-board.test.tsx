// @vitest-environment happy-dom
import { render } from "preact";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildBoard } from "../../src/app/views";
import { emptyFilter } from "../../src/domain/queries";
import type { ID, Task } from "../../src/domain/types";
import type { JournalOp } from "../../src/persistence/journal";
import { BoardView } from "../../src/ui/board/BoardView";
import { useAppState } from "../../src/ui/hooks";
import type { UiHost } from "../../src/ui/host";
import { VIRTUAL_THRESHOLD } from "../../src/ui/virtual";
import { makeTask } from "../persistence/fixtures";
import { type AppHarness, appHarness } from "../app/harness";
import { settle } from "./matrix-helpers";
import { U1Host } from "./app-helpers";
import { type FakeLayout, fakeLayout } from "./virtual-layout";

// A board column with more than VIRTUAL_THRESHOLD
// items draws only the cards near its viewport. BoardView over the fake layout (virtual-layout.ts): a card's task
// is 60 px, a nested subtask 40 px, a column head 40 px, a column body shows 500 px; columns sit side by side.

const CARD = 60;
const SUB = 40;
const HEAD = 40;
const BODY = 500;

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
const indexOf = (id: string | undefined) => (id === undefined ? -1 : parseInt(id.slice(-12), 16) - 1);

interface Seed {
	/** Open Inbox tasks "Task 0".."Task n-1" in this manual order. */
	count: number;
	/** Section of task i (by name), or none. */
	sectionOf?: (i: number) => string | null;
	/** Parent task index of task i, for a subtask. */
	parentOf?: (i: number) => number | null;
}

async function seeded(seed: Seed): Promise<AppHarness> {
	const h = await appHarness();
	const sections = new Map<string, ID>();
	for (let i = 0; i < seed.count; i++) {
		const name = seed.sectionOf?.(i) ?? null;
		if (name !== null && !sections.has(name)) sections.set(name, (await h.app.sections.create("inbox", name)).id);
	}
	const data = h.store.data;
	const tasks = new Map(data.tasks);
	const ops: JournalOp[] = [];
	for (let i = 0; i < seed.count; i++) {
		const name = seed.sectionOf?.(i) ?? null;
		const parent = seed.parentOf?.(i) ?? null;
		const t: Task = makeTask(taskId(i + 1), {
			title: `Task ${i}`,
			sortKey: `V${i.toString(36).padStart(4, "0")}`,
			sectionId: name === null ? null : sections.get(name)!,
			parentId: parent === null ? null : taskId(parent + 1),
		});
		tasks.set(t.id, t);
		ops.push({ c: "tasks", id: t.id, v: t });
	}
	h.store.commit({ ...data, tasks }, ops);
	return h;
}

/** The Inbox board, re-rendered on every store change like the app does. */
function Board({ host, manual = true }: { host: UiHost; manual?: boolean }) {
	const state = useAppState(host);
	const ctx = host.app.queryContext();
	const columns = buildBoard(state, { kind: "inbox" }, ctx, { ...emptyFilter("all"), sort: "manual" }, "");
	return (
		<div class="cp-main is-board">
			<BoardView
				host={host}
				state={state}
				ctx={ctx}
				columns={columns}
				selectedId={null}
				showCategory={false}
				manual={manual}
				readOnly={false}
				showCompleted={true}
				addCategoryId="inbox"
				addSectionRequest={0}
				resetKey=""
				completedOpen={() => false}
				onToggleCompleted={() => undefined}
				onSelect={() => undefined}
			/>
		</div>
	);
}

interface Mount {
	h: AppHarness;
	root: HTMLElement;
	body: (column: string) => HTMLElement;
}

async function mount(seed: Seed, opts: { manual?: boolean } = {}): Promise<Mount> {
	const h = await seeded(seed);
	const host = new U1Host(h);
	const root = document.createElement("div");
	document.body.appendChild(root);
	roots.push(root);
	layout = fakeLayout({
		viewport: (el) => (el.classList.contains("cp-board-col-body") ? BODY : undefined),
		height: (el) =>
			el.classList.contains("cp-board-item") ? (el.classList.contains("is-sub") ? SUB : CARD) : el.classList.contains("cp-board-col-head") ? HEAD : undefined,
	});
	render(<Board host={host} manual={opts.manual} />, root);
	await settle();
	const body = (column: string) => root.querySelector<HTMLElement>(`.cp-board-col[data-column="${column}"] .cp-board-col-body`)!;
	return { h, root, body };
}

const cards = (m: Mount, column: string) => [...m.body(column).querySelectorAll<HTMLElement>(".cp-board-card")];
const cardOf = (m: Mount, i: number) => m.root.querySelector<HTMLElement>(`.cp-board-card[data-task-id="${taskId(i + 1)}"]`);
const itemOf = (m: Mount, i: number) => m.root.querySelector<HTMLElement>(`.cp-board-item[data-task-id="${taskId(i + 1)}"]`);
const focusedIndex = () => indexOf((document.activeElement as HTMLElement | null)?.dataset?.taskId);
/** A card's top inside its column's content. */
const contentTop = (body: HTMLElement, el: HTMLElement) => el.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop;
const key = async (k: string, init: KeyboardEventInit = {}) => {
	document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
	await new Promise((r) => setTimeout(r, 0));
};
const pointer = (el: HTMLElement, type: string, x: number, y: number) =>
	el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: "mouse", button: 0, isPrimary: true }));

describe("board columns", () => {
	it("a column at the threshold draws every card", async () => {
		const m = await mount({ count: VIRTUAL_THRESHOLD });
		expect(cards(m, "none")).toHaveLength(VIRTUAL_THRESHOLD);
		expect(m.root.querySelector(".cp-virtual-spacer")).toBeNull();
	});

	it("a long column draws only the cards near its viewport, keeping its full height", async () => {
		const m = await mount({ count: 400 });
		expect(cards(m, "none").length).toBeLessThan(40);
		expect(layout!.contentHeight(m.body("none"))).toBe(400 * CARD);
		await layout!.scrollTo(m.body("none"), 300 * CARD);
		expect(cardOf(m, 0)).toBeNull();
		expect(contentTop(m.body("none"), cardOf(m, 305)!)).toBe(305 * CARD);
	});

	it("a column crossing the threshold while scrolled keeps its scroll position and the cards under it", async () => {
		// 30 cards with two subtasks (140 px each), then 60 plain cards (60 px): 150 items, drawn in full.
		const m = await mount({ count: 150, parentOf: (i) => (i < 90 && i % 3 !== 0 ? i - (i % 3) : null) });
		const body = m.body("none");
		expect(m.root.querySelector(".cp-virtual-spacer")).toBeNull();
		const height = 30 * (CARD + 2 * SUB) + 60 * CARD;
		expect(layout!.contentHeight(body)).toBe(height);
		await layout!.scrollTo(body, 6000);
		const atTop = () => cards(m, "none").find((c) => contentTop(body, c) <= body.scrollTop && contentTop(body, c) + c.getBoundingClientRect().height > body.scrollTop)?.dataset.taskId;
		const before = atTop();
		expect(indexOf(before)).toBe(120);
		// One more card at the end: 151 items, so the column windows now.
		await m.h.app.tasks.create({ title: "Task 150" });
		await settle();
		expect(m.root.querySelector(".cp-virtual-spacer")).not.toBeNull();
		expect(body.scrollTop).toBe(6000);
		// Every card that was drawn keeps its measured height (only the new one, not drawn yet, is an estimate).
		expect(layout!.contentHeight(body)).toBeGreaterThan(height);
		expect(atTop()).toBe(before);
		expect(contentTop(body, cardOf(m, 120)!)).toBe(6000);
	});

	it("a column leaving windowing while scrolled keeps the card at the top of its viewport where it was", async () => {
		// 30 cards with two subtasks (140 px each), then 61 plain cards (60 px): 151 items, windowed. The cards above the
		// viewport were never drawn, so the windowed layout counts them as the average height; plain, they are real.
		const m = await mount({ count: 151, parentOf: (i) => (i < 90 && i % 3 !== 0 ? i - (i % 3) : null) });
		const body = m.body("none");
		expect(m.root.querySelector(".cp-virtual-spacer")).not.toBeNull();
		await layout!.scrollTo(body, 5000);
		await layout!.scrollTo(body, 5025);
		const atTop = () => cards(m, "none").find((c) => contentTop(body, c) + c.getBoundingClientRect().height > body.scrollTop)!;
		const before = atTop();
		const offset = contentTop(body, before) - body.scrollTop;
		expect(offset).toBeLessThan(0);
		// The last card goes: 150 items, so every card is drawn at its real height.
		await m.h.app.tasks.delete(taskId(151));
		await settle();
		expect(m.root.querySelector(".cp-virtual-spacer")).toBeNull();
		expect(cards(m, "none")).toHaveLength(150 - 60);
		expect(layout!.contentHeight(body)).toBe(30 * (CARD + 2 * SUB) + 60 * CARD);
		const after = atTop();
		expect(after.dataset.taskId).toBe(before.dataset.taskId);
		expect(contentTop(body, after) - body.scrollTop).toBe(offset);
	});

	it("each drawn card and subtask tells its column's size and its position; a plain column's cards carry neither", async () => {
		const plain = await mount({ count: VIRTUAL_THRESHOLD });
		expect(plain.root.querySelector("[aria-setsize], [aria-posinset]")).toBeNull();
		// 100 cards with two subtasks each: 300 options in the column.
		const m = await mount({ count: 300, parentOf: (i) => (i % 3 === 0 ? null : i - (i % 3)) });
		const check = (i: number, pos: number) => {
			const el = itemOf(m, i);
			expect(el, `item ${i}`).not.toBeNull();
			expect(el!.getAttribute("aria-setsize"), `item ${i}`).toBe("300");
			expect(el!.getAttribute("aria-posinset"), `item ${i}`).toBe(String(pos));
		};
		check(0, 1);
		check(1, 2);
		check(2, 3);
		check(3, 4);
		await layout!.scrollTo(m.body("none"), 60 * (CARD + 2 * SUB));
		check(180, 181);
		check(182, 183);
		const items = [...m.body("none").querySelectorAll(".cp-board-item")];
		expect(items.every((r) => r.hasAttribute("aria-setsize") && r.hasAttribute("aria-posinset"))).toBe(true);
		// The card's wrapper is not an option; only the items are.
		expect(m.body("none").querySelector(".cp-board-card[aria-setsize]")).toBeNull();
	});

	it("subtasks count towards the threshold and stay inside their card", async () => {
		// 100 cards with two subtasks each: 300 items.
		const m = await mount({ count: 300, parentOf: (i) => (i % 3 === 0 ? null : i - (i % 3)) });
		expect(cards(m, "none").length).toBeLessThan(30);
		expect(layout!.contentHeight(m.body("none"))).toBe(100 * (CARD + 2 * SUB));
		expect(cardOf(m, 3)!.querySelectorAll(".cp-board-item.is-sub")).toHaveLength(2);
	});
});

describe("board keyboard", () => {
	it("ArrowDown walks every card and nested subtask of a long column, ArrowUp walks back", async () => {
		const m = await mount({ count: 300, parentOf: (i) => (i < 30 && i % 3 !== 0 ? i - (i % 3) : null) });
		itemOf(m, 0)!.focus();
		for (let i = 1; i < 300; i++) {
			await key("ArrowDown");
			if (focusedIndex() !== i) throw new Error(`ArrowDown ${i}: focus is on ${focusedIndex()}`);
		}
		expect(cards(m, "none").length).toBeLessThan(40);
		for (let i = 298; i >= 0; i--) {
			await key("ArrowUp");
			if (focusedIndex() !== i) throw new Error(`ArrowUp ${i}: focus is on ${focusedIndex()}`);
		}
	}, 30_000);

	it("a focused card scrolled out of view stays focused; ArrowDown goes to the next card and scrolls to it", async () => {
		const m = await mount({ count: 400 });
		const five = itemOf(m, 5)!;
		five.focus();
		await layout!.scrollTo(m.body("none"), 300 * CARD);
		expect(itemOf(m, 5)).toBe(five);
		expect(document.activeElement).toBe(five);
		await key("ArrowDown");
		expect(focusedIndex()).toBe(6);
		expect(m.body("none").scrollTop).toBeLessThanOrEqual(6 * CARD);
	});

	it("Tab from a card whose next card is not drawn goes to that card", async () => {
		const m = await mount({ count: 400 });
		itemOf(m, 5)!.focus();
		await layout!.scrollTo(m.body("none"), 300 * CARD);
		const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
		document.activeElement!.dispatchEvent(tab);
		await settle();
		expect(tab.defaultPrevented).toBe(true);
		expect(focusedIndex()).toBe(6);
	});

	it("Alt+Up or Alt+Down that moves nothing keeps focus, as in a column that draws every card", async () => {
		for (const count of [10, 400]) {
			for (const manual of [true, false]) {
				const m = await mount({ count }, { manual });
				const place = vi.spyOn(m.h.app.tasks, "place");
				const update = vi.spyOn(m.h.app.tasks, "update");
				// The first card cannot go up; under another sort no card moves within its column.
				const keys: [number, string][] = manual ? [[0, "ArrowUp"], [count - 1, "ArrowDown"]] : [[0, "ArrowUp"], [5, "ArrowDown"], [5, "ArrowUp"]];
				for (const [i, k] of keys) {
					await layout!.scrollTo(m.body("none"), i * CARD);
					itemOf(m, i)!.focus();
					await key(k, { altKey: true });
					await settle();
					expect(focusedIndex(), `${count} cards, manual ${manual}, ${k} from ${i}`).toBe(i);
				}
				expect(place).not.toHaveBeenCalled();
				expect(update).not.toHaveBeenCalled();
				for (const r of roots.splice(0)) {
					render(null, r);
					r.remove();
				}
				layout?.restore();
				layout = null;
			}
		}
	});

	it("Alt+Right moves a card to the end of a long next column; it is drawn there and keeps focus", async () => {
		const m = await mount({ count: 400, sectionOf: (i) => (i < 200 ? null : "Later") });
		const later = m.root.querySelectorAll<HTMLElement>(".cp-board-col")[1]!.dataset.column!;
		itemOf(m, 0)!.focus();
		await key("ArrowRight", { altKey: true });
		await settle();
		expect(m.h.app.store.state.tasks.get(taskId(1))!.sectionId).toBe(later);
		const moved = itemOf(m, 0)!;
		expect(moved.closest<HTMLElement>(".cp-board-col")!.dataset.column).toBe(later);
		expect(document.activeElement).toBe(moved);
		// It is the column's last card, at the bottom of the column's content, and focus scrolled to it.
		const body = m.body(later);
		expect(contentTop(body, cardOf(m, 0)!)).toBe(200 * CARD);
		expect(body.scrollTop).toBe(201 * CARD - BODY);
	});
});

describe("board drag", () => {
	it("places a card far down its own long column from the data, the dragged card staying drawn", async () => {
		const m = await mount({ count: 400 });
		const place = vi.spyOn(m.h.app.tasks, "place");
		const zero = itemOf(m, 0)!;
		pointer(zero, "pointerdown", 100, HEAD + CARD / 2);
		pointer(zero, "pointermove", 110, HEAD + CARD / 2 + 10);
		await settle();
		await layout!.scrollTo(m.body("none"), 300 * CARD);
		expect(zero.isConnected).toBe(true);
		const target = cardOf(m, 305)!;
		const y = target.getBoundingClientRect().top + CARD * 0.25;
		pointer(zero, "pointermove", 100, y);
		await settle();
		expect(target.querySelector(".cp-board-item")!.classList.contains("is-drop-before")).toBe(true);
		pointer(zero, "pointerup", 100, y);
		await settle();
		expect(place).toHaveBeenCalledTimes(1);
		const [id, order] = place.mock.calls[0]!;
		expect(id).toBe(taskId(1));
		expect(order).toHaveLength(400);
		// Before card 305: after cards 1..304.
		expect(order.indexOf(taskId(1))).toBe(304);
	});

	it("drops a card into another long column, placed among cards that are not drawn", async () => {
		const m = await mount({ count: 400, sectionOf: (i) => (i < 200 ? null : "Later") });
		const later = m.root.querySelectorAll<HTMLElement>(".cp-board-col")[1]!.dataset.column!;
		const place = vi.spyOn(m.h.app.tasks, "place");
		const zero = itemOf(m, 0)!;
		pointer(zero, "pointerdown", 100, HEAD + CARD / 2);
		pointer(zero, "pointermove", 110, HEAD + CARD / 2 + 10);
		await settle();
		await layout!.scrollTo(m.body(later), 150 * CARD);
		const target = cardOf(m, 350)!;
		const r = target.getBoundingClientRect();
		const x = r.left + 100;
		const y = r.top + CARD * 0.75;
		pointer(zero, "pointermove", x, y);
		await settle();
		pointer(zero, "pointerup", x, y);
		await settle();
		expect(place).toHaveBeenCalledTimes(1);
		const [id, order, patch] = place.mock.calls[0]!;
		expect(id).toBe(taskId(1));
		expect(patch).toEqual({ sectionId: later });
		expect(order).toHaveLength(201);
		// Below card 350's middle: after cards 200..350.
		expect(order.indexOf(taskId(1))).toBe(151);
	});
});
