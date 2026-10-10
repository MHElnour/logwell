// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import type { DateSpec } from "../../src/domain/types";
import { type HabitMount, click, mountHabits, q, qa, seedMockup, settle, text } from "./m6-helpers";
import { board, cardTitles, modeButton, press, sidebarItem } from "./k1a-helpers";

// Habits in Today: the block above the list, the first board column, the fold
// line, and where they do not show. The clock is Sunday 2026-10-04, 20:30 in Europe/Berlin (seedMockup).

const mounted: HabitMount[] = [];
afterEach(() => {
	for (const m of mounted.splice(0)) m.unmount();
});

async function mount(): Promise<HabitMount> {
	const m = await mountHabits();
	mounted.push(m);
	return m;
}

const day = (date: string): DateSpec => ({ kind: "date", date });
const undoDepth = (m: HabitMount) => (m.h.app.store as unknown as { undoStack: unknown[] }).undoStack.length;

/** Seeded habits and two tasks due today, with the Today view open. */
async function today() {
	const m = await mount();
	const habits = await seedMockup(m.h);
	await m.h.app.tasks.create({ title: "Lunch", scheduled: day("2026-10-04") });
	await m.h.app.tasks.create({ title: "Report", scheduled: day("2026-10-04") });
	await m.rerender();
	await click(sidebarItem(m.root, "Today"));
	return { m, habits };
}

const block = (m: HabitMount) => m.root.querySelector<HTMLElement>(".cp-tasks .cp-today-habits");
const nameOf = (el: HTMLElement) => text(el.ownerDocument.getElementById(el.getAttribute("aria-labelledby")!));
const rowNames = (el: ParentNode) => qa(el, ".cp-habit-row .cp-habit-name").map(text);

describe("the Habits block in the Today list (List mode)", () => {
	it("sits between the add bar and the task list, as a group named by its heading", async () => {
		const { m } = await today();
		const b = block(m)!;
		expect(b).not.toBeNull();
		expect(b.getAttribute("role")).toBe("group");
		expect(b.hasAttribute("aria-label")).toBe(false);
		expect(nameOf(b)).toBe("Habits · 1 of 4 done");
		const bar = q(m.root, ".cp-tasks .cp-add-bar");
		const list = q(m.root, ".cp-tasks .cp-task-list");
		expect(bar.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(b.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		// The block is outside the task list, so the list keeps its own ARIA and its tasks.
		expect(list.contains(b)).toBe(false);
		expect(qa(list, ".cp-task-row")).toHaveLength(2);
	});

	it("lists the open habits with the page's controls and folds the done and unscheduled ones into one line", async () => {
		const { m } = await today();
		const b = block(m)!;
		// In time-of-day order: Gym (afternoon), Read (evening), Drink water (anytime). Meditate is done, Walk is off.
		expect(rowNames(b)).toEqual(["Gym", "Read", "Drink water"]);
		expect(text(q(b, ".cp-today-habits-fold"))).toBe("✓ Meditate done · Walk not scheduled today");
		expect(q(b, ".cp-habit-check")).not.toBeNull();
		expect(text(q(b, ".cp-habit-count"))).toBe("5 / 8");
		expect(q<HTMLInputElement>(b, ".cp-habit-amount input").placeholder).toBe("10");
		// The rows are not selectable here: the name is plain text.
		expect(b.querySelector("button.cp-habit-name")).toBeNull();
		expect(b.querySelector(".cp-habit-row")!.classList.contains("is-compact")).toBe(true);
	});

	it("opens the Habits page from 'Open habits'", async () => {
		const { m } = await today();
		await click(q(block(m)!, ".cp-today-habits-link"));
		expect(m.opened).toEqual(["habits"]);
		expect(text(q(block(m)!, ".cp-today-habits-link"))).toBe("Open habits");
	});

	it("writes through the same controls: +1 counts, the amount field adds, the check folds the habit away", async () => {
		const { m, habits } = await today();
		const b = () => block(m)!;
		const water = () => qa(b(), ".cp-habit-row").find((r) => text(q(r, ".cp-habit-name")) === "Drink water")!;
		await click(q(water(), ".cp-habit-plus"));
		expect(text(q(water(), ".cp-habit-count"))).toBe("6 / 8");
		expect(m.notices.at(-1)).toEqual({ message: "Checked in Drink water.", label: "Check in" });
		expect(m.notices.at(-1)!.label).toBe(m.h.app.store.undoLabel);
		const field = q<HTMLInputElement>(b(), ".cp-habit-amount input");
		field.value = "10";
		field.dispatchEvent(new Event("input", { bubbles: true }));
		await click(q(b(), ".cp-habit-amount .cp-habit-add"));
		expect(m.h.app.habits.index().active(habits.read.id).map((c) => c.value)).toEqual([30, 30, 30, 30, 30, 20, 10]);
		expect(nameOf(b())).toBe("Habits · 2 of 4 done");
		// Checking Gym in folds it into the line.
		await click(q(b(), ".cp-habit-check"));
		expect(rowNames(b())).not.toContain("Gym");
		expect(text(q(b(), ".cp-today-habits-fold"))).toBe("✓ Meditate, Gym, Read done · Walk not scheduled today");
		await expect(m.host.undoButtons.at(-1)!()).resolves.toBe(true);
		await settle();
		expect(rowNames(b())).toContain("Gym");
	});

	it("keeps the Today count, the sidebar badge and the empty state about tasks only (HAB-01)", async () => {
		const { m } = await today();
		expect(text(q(m.root, ".cp-tasks .cp-main-header .cp-count-pill"))).toBe("2");
		expect(text(q(sidebarItem(m.root, "Today"), ".cp-count"))).toBe("2");
		expect(qa(m.root, ".cp-tasks .cp-task-row")).toHaveLength(2);
		// With no task due, the list says so under the block.
		for (const t of m.h.app.store.state.tasks.values()) await m.h.app.tasks.complete(t.id);
		await new Promise((r) => setTimeout(r, 600));
		await settle();
		expect(text(q(m.root, ".cp-tasks .cp-main-header .cp-count-pill"))).toBe("0");
		expect(block(m)).not.toBeNull();
		expect(text(q(m.root, ".cp-tasks .cp-empty-text"))).toBe("Nothing due today.");
	});

	it("shows nothing without a habit, or when every habit is archived", async () => {
		const m = await mount();
		await click(sidebarItem(m.root, "Today"));
		expect(block(m)).toBeNull();
		await click(modeButton(m.root, "Board"));
		expect(m.root.querySelector(".cp-board-habits")).toBeNull();
		await click(modeButton(m.root, "List"));
		const habits = await seedMockup(m.h);
		await m.rerender();
		expect(block(m)).not.toBeNull();
		for (const h of [habits.read, habits.water, habits.meditate, habits.gym, habits.walk]) await m.h.app.habits.archive(h.id);
		await settle();
		expect(block(m)).toBeNull();
	});

	it("is only in Today: not in Upcoming, Inbox or a list", async () => {
		const { m } = await today();
		const cat = await m.h.app.categories.create("Work", "briefcase");
		await settle();
		for (const view of ["Upcoming", "Inbox", "Work"]) {
			await click(sidebarItem(m.root, view));
			expect(block(m), view).toBeNull();
			await click(modeButton(m.root, "Board"));
			expect(m.root.querySelector(".cp-board-habits"), view).toBeNull();
			await click(modeButton(m.root, "List"));
		}
		expect(cat.id).toBeTruthy();
		await click(sidebarItem(m.root, "Today"));
		expect(block(m)).not.toBeNull();
	});

	it("leaves a block with only a fold line when every scheduled habit is done", async () => {
		const { m, habits } = await today();
		await m.h.app.habits.toggle(habits.gym.id, "2026-10-04", true);
		await m.h.app.habits.add(habits.read.id, "2026-10-04", 10);
		for (let i = 0; i < 3; i++) await m.h.app.habits.add(habits.water.id, "2026-10-04", 1);
		await settle();
		expect(rowNames(block(m)!)).toEqual([]);
		expect(nameOf(block(m)!)).toBe("Habits · 4 of 4 done");
		expect(text(q(block(m)!, ".cp-today-habits-fold"))).toBe("✓ Meditate, Gym, Read, Drink water done · Walk not scheduled today");
	});
});

describe("the Habits column in the Today board (Board mode)", () => {
	async function openBoard() {
		const t = await today();
		await click(modeButton(t.m.root, "Board"));
		return t;
	}
	const column = (m: HabitMount) => m.root.querySelector<HTMLElement>(".cp-tasks .cp-board-col.cp-board-habits");

	it("is the first column, named by its heading, with the count and a card for each scheduled habit", async () => {
		const { m } = await openBoard();
		const col = column(m)!;
		expect(col).not.toBeNull();
		const first = q(board(m.root), ".cp-board-scroll").firstElementChild;
		expect(first).toBe(col);
		expect(col.hasAttribute("aria-label")).toBe(false);
		expect(nameOf(col)).toBe("Habits");
		expect(text(q(col, ".cp-board-col-count"))).toBe("1 of 4");
		expect(qa(col, ".cp-habit-card .cp-habit-name").map(text)).toEqual(["Meditate", "Gym", "Read", "Drink water"]);
		// Cards: a done habit says Done, the others their progress.
		const metas = qa(col, ".cp-habit-card").map((c) => text(q(c, ".cp-habit-card-meta")));
		expect(metas).toEqual(["Done", "1 of 3 this week", "20 of 30 min", "5 of 8 glasses"]);
		expect(q(qa(col, ".cp-habit-card")[0]!, ".cp-habit-check").getAttribute("aria-pressed")).toBe("true");
		expect(q(qa(col, ".cp-habit-card")[0]!, ".cp-habit-icon").className).toContain("cp-hue-pink");
	});

	it("shows '+n' for an amount: the last check-in's value, else a third of the target rounded up", async () => {
		const { m, habits } = await openBoard();
		const read = () => qa(column(m)!, ".cp-habit-card").find((c) => text(q(c, ".cp-habit-name")) === "Read")!;
		const plus = () => q(read(), ".cp-habit-plus");
		expect(text(plus())).toBe("+20");
		expect(plus().getAttribute("aria-label")).toBe("Add 20 min");
		await click(plus());
		expect(m.h.app.habits.index().active(habits.read.id).at(-1)!.value).toBe(20);
		expect(text(q(read(), ".cp-habit-card-meta"))).toBe("40 of 30 min");
		expect(m.notices.at(-1)).toEqual({ message: "Checked in Read.", label: "Check in" });
		// A habit with no check-in yet: a third of 20, rounded up.
		const fresh = await m.h.app.habits.create({
			name: "Run",
			icon: null,
			color: null,
			timeOfDay: "morning",
			reminder: null,
			goal: { type: "quantity", target: 20, unit: "min", period: "day" },
			schedule: { kind: "daily" },
		});
		await settle();
		const run = qa(column(m)!, ".cp-habit-card").find((c) => text(q(c, ".cp-habit-name")) === "Run")!;
		expect(text(q(run, ".cp-habit-plus"))).toBe("+7");
		expect(m.h.app.habits.list().some((h) => h.id === fresh.id)).toBe(true);
		// Count cards keep +1 and the check card toggles.
		const water = qa(column(m)!, ".cp-habit-card").find((c) => text(q(c, ".cp-habit-name")) === "Drink water")!;
		expect(text(q(water, ".cp-habit-plus"))).toBe("+1");
		const gym = qa(column(m)!, ".cp-habit-card").find((c) => text(q(c, ".cp-habit-name")) === "Gym")!;
		await click(q(gym, ".cp-habit-check"));
		expect(m.notices.at(-1)!.message).toBe("Checked in Gym.");
	});

	it("is not one of the board's columns: no drop target, no card of its own, and keys never enter it", async () => {
		const { m } = await openBoard();
		const col = column(m)!;
		expect(col.dataset.column).toBeUndefined();
		expect(col.dataset.sectionId).toBeUndefined();
		expect(col.querySelector(".cp-board-item, .cp-board-card")).toBeNull();
		// The task columns still list their own cards.
		expect(cardTitles(m.root, "today").sort()).toEqual(["Lunch", "Report"]);
		// Alt+Left on the first task column's card does not move it into the Habits column.
		const lunch = [...board(m.root).querySelectorAll<HTMLElement>(".cp-board-item")].find((i) => i.textContent?.includes("Lunch"))!;
		lunch.focus();
		const before = undoDepth(m);
		await press(lunch, "ArrowLeft", { altKey: true });
		expect(undoDepth(m)).toBe(before);
		expect(cardTitles(m.root, "today")).toContain("Lunch");
		expect(col.textContent).not.toContain("Lunch");
	});

	it("a press on a habit card starts no drag", async () => {
		const { m } = await openBoard();
		const card = q(column(m)!, ".cp-habit-card");
		card.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 10, clientY: 10, pointerId: 1 }));
		await settle();
		expect(board(m.root).classList.contains("is-dragging-card")).toBe(false);
	});
});
