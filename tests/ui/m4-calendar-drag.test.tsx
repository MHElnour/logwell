// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DateSpec, Task } from "../../src/domain/types";
import { type CalMount, byLabel, cal, cell, click, entries, entry, mountCal, openCalendar, press, settle } from "./m3-helpers";

// Calendar drag and drop. happy-dom has no layout, so the day columns,
// all-day cells and month cells get fake rectangles: column i is x 100 i to 100 i + 100, minute m of a
// column is y = m * 48 / 60 (HOUR_PX), the all-day row is y -100 to -50, the sticky header ends at -50.

const mounted: CalMount[] = [];
afterEach(() => {
	vi.useRealTimers();
	for (const m of mounted.splice(0)) m.unmount();
});
async function mount() {
	const m = await mountCal();
	mounted.push(m);
	return m;
}

const day = (date: string): DateSpec => ({ kind: "date", date });
const at = (date: string, time: string, tz = "Europe/Berlin"): DateSpec => ({ kind: "datetime", local: `${date}T${time}`, tz });
const rect = (left: number, top: number, right: number, bottom: number) =>
	({ left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
const y = (min: number) => (min * 48) / 60;
/** Column center x for the i-th visible day (Mon 2026-09-28 is 0). */
const colX = (i: number) => 100 * i + 50;

function stubWeek(root: HTMLElement) {
	const w = cal(root);
	w.querySelectorAll<HTMLElement>(".cp-cal-daycol").forEach((c, i) => (c.getBoundingClientRect = () => rect(100 * i, 0, 100 * i + 100, 1152)));
	w.querySelectorAll<HTMLElement>(".cp-cal-allday-cell").forEach((c, i) => (c.getBoundingClientRect = () => rect(100 * i, -100, 100 * i + 100, -50)));
	const scroller = w.querySelector<HTMLElement>(".cp-cal-scroller");
	if (scroller !== null) scroller.getBoundingClientRect = () => rect(0, -1000, 700, 2000);
	const sticky = w.querySelector<HTMLElement>(".cp-cal-sticky");
	if (sticky !== null) sticky.getBoundingClientRect = () => rect(0, -1000, 700, -50);
}

function stubMonth(root: HTMLElement) {
	cal(root)
		.querySelectorAll<HTMLElement>(".cp-cal-cell")
		.forEach((c, i) => (c.getBoundingClientRect = () => rect(100 * (i % 7), 100 * Math.floor(i / 7), 100 * (i % 7) + 100, 100 * Math.floor(i / 7) + 100)));
}

function ptr(type: string, x: number, yy: number, init: Record<string, unknown> = {}): Event {
	const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: yy, button: 0 });
	Object.defineProperty(ev, "pointerId", { value: 1 });
	Object.defineProperty(ev, "pointerType", { value: init.pointerType ?? "mouse" });
	if (init.button !== undefined) Object.defineProperty(ev, "button", { value: init.button });
	return ev;
}

type Pt = { x: number; y: number };
const down = (el: Element, p: Pt, init?: Record<string, unknown>) => el.dispatchEvent(ptr("pointerdown", p.x, p.y, init));
const move = (el: Element, p: Pt) => el.dispatchEvent(ptr("pointermove", p.x, p.y));
const up = (el: Element, p: Pt) => el.dispatchEvent(ptr("pointerup", p.x, p.y));

/** Press, move away in two steps, release, then the click a real browser sends. */
async function drag(el: Element, from: Pt, to: Pt, opts: { release?: boolean } = {}) {
	down(el, from);
	move(el, { x: from.x + 6, y: from.y + 6 });
	move(el, to);
	await settle();
	if (opts.release === false) return;
	up(el, to);
	(el as HTMLElement).click();
	await settle();
}

const task = (m: CalMount, title: string): Task => {
	const t = [...m.h.app.store.state.tasks.values()].find((x) => x.title === title);
	if (t === undefined) throw new Error(`no task ${title}`);
	return t;
};
const details = (m: CalMount) => cal(m.root).querySelector(".cp-details");
const ghost = (m: CalMount) => cal(m.root).querySelector<HTMLElement>(".cp-cal-ghost");

async function seed(m: CalMount) {
	const T = m.h.app.tasks;
	await T.create({ title: "Dentist", scheduled: day("2026-10-01") });
	await T.create({ title: "Standup", scheduled: at("2026-10-01", "19:00"), plannedDurationMin: 45 });
	await T.create({ title: "Quick call", scheduled: at("2026-10-02", "09:00") });
	await T.create({ title: "Report", deadline: day("2026-10-03") });
	await settle();
}

async function weekReady(m: CalMount) {
	await seed(m);
	await openCalendar(m);
	stubWeek(m.root);
}

/** Thursday 2026-10-01 is column 3 of the Monday-first week, Friday 4, Saturday 5. */
const THU = 3;
const FRI = 4;
const SAT = 5;

describe("week: move a timed block (D11)", () => {
	it("moves to another day and slot, keeps the duration, one update and one undo entry", async () => {
		const m = await mount();
		await weekReady(m);
		const update = vi.spyOn(m.h.app.tasks, "update");
		const undoNotice = vi.spyOn(m.host, "notifyUndo");
		const id = task(m, "Standup").id;
		const block = entry(cal(m.root), "Standup", ".cp-cal-daycol");
		// 60 px is 75 minutes: 19:00 + 75 = 20:15.
		await drag(block, { x: colX(THU), y: y(19 * 60 + 10) }, { x: colX(FRI), y: y(19 * 60 + 10) + 60 });
		expect(update).toHaveBeenCalledTimes(1);
		const after = task(m, "Standup");
		expect(after.id).toBe(id);
		expect(after.scheduled).toEqual(at("2026-10-02", "20:15"));
		expect(after.plannedDurationMin).toBe(45);
		expect(undoNotice).toHaveBeenCalledWith('Moved "Standup".', "Edit task", expect.any(Number));
		expect(details(m)).toBeNull();
		await expect(m.host.undoButtons.at(-1)!()).resolves.toBe(true);
		expect(task(m, "Standup").scheduled).toEqual(at("2026-10-01", "19:00"));
	});

	it("shows the ghost with its time, dims the original and marks the target column while moving", async () => {
		const m = await mount();
		await weekReady(m);
		const block = entry(cal(m.root), "Standup", ".cp-cal-daycol");
		await drag(block, { x: colX(THU), y: 900 }, { x: colX(FRI), y: 960 }, { release: false });
		const g = ghost(m)!;
		expect(g.textContent).toBe("20:15–21:00");
		expect(g.closest<HTMLElement>(".cp-cal-daycol")!.dataset.date).toBe("2026-10-02");
		expect(g.style.getPropertyValue("--cp-start")).toBe("1215");
		expect(g.style.getPropertyValue("--cp-len")).toBe("45");
		expect(block.classList.contains("is-dragging")).toBe(true);
		expect(cell(cal(m.root), "daycol", "2026-10-02").classList.contains("is-drop-target")).toBe(true);
		expect(cal(m.root).classList.contains("is-dragging")).toBe(true);
		up(block, { x: colX(FRI), y: 960 });
		await settle();
		expect(ghost(m)).toBeNull();
		expect(cal(m.root).querySelector(".is-dragging")).toBeNull();
		expect(cal(m.root).querySelector(".is-drop-target")).toBeNull();
	});

	it("re-anchors a task stored in another zone to the display zone", async () => {
		const m = await mount();
		await seed(m);
		// 09:00 in New York (EDT) is 15:00 in Berlin on the same Thursday.
		await m.h.app.tasks.create({ title: "Overseas", scheduled: at("2026-10-01", "09:00", "America/New_York"), plannedDurationMin: 60 });
		await openCalendar(m);
		stubWeek(m.root);
		const update = vi.spyOn(m.h.app.tasks, "update");
		const block = entry(cal(m.root), "Overseas", ".cp-cal-daycol");
		await drag(block, { x: colX(THU), y: y(15 * 60 + 10) }, { x: colX(FRI), y: y(15 * 60 + 10) });
		expect(update).toHaveBeenCalledTimes(1);
		expect(task(m, "Overseas").scheduled).toEqual(at("2026-10-02", "15:00"));
	});

	it("a drop that changes nothing writes nothing", async () => {
		const m = await mount();
		await weekReady(m);
		const update = vi.spyOn(m.h.app.tasks, "update");
		const undoNotice = vi.spyOn(m.host, "notifyUndo");
		const block = entry(cal(m.root), "Standup", ".cp-cal-daycol");
		// Past the 4 px threshold but 5 px is 6 minutes, which snaps back to 19:00.
		await drag(block, { x: colX(THU), y: 900 }, { x: colX(THU), y: 905 });
		expect(update).not.toHaveBeenCalled();
		expect(undoNotice).not.toHaveBeenCalled();
		expect(task(m, "Standup").scheduled).toEqual(at("2026-10-01", "19:00"));
		expect(details(m)).toBeNull();
	});

	it("clamps at 23:45", async () => {
		const m = await mount();
		await weekReady(m);
		const block = entry(cal(m.root), "Standup", ".cp-cal-daycol");
		await drag(block, { x: colX(THU), y: 900 }, { x: colX(THU), y: 900 + 600 });
		expect(task(m, "Standup").scheduled).toEqual(at("2026-10-01", "23:45"));
	});

	it("either half of a split block moves the whole task", async () => {
		const m = await mount();
		await seed(m);
		await m.h.app.tasks.create({ title: "Night shift", scheduled: at("2026-10-01", "23:00"), plannedDurationMin: 120 });
		await openCalendar(m);
		stubWeek(m.root);
		const halves = entries(cal(m.root), "Night shift", ".cp-cal-daycol");
		expect(halves).toHaveLength(2);
		const continued = halves.find((b) => b.closest<HTMLElement>(".cp-cal-daycol")!.dataset.date === "2026-10-02")!;
		// Drag the Friday half to Saturday: the whole task moves one day.
		await drag(continued, { x: colX(FRI), y: 20 }, { x: colX(SAT), y: 20 });
		expect(task(m, "Night shift").scheduled).toEqual(at("2026-10-02", "23:00"));
		expect(task(m, "Night shift").plannedDurationMin).toBe(120);
	});

	it("Escape restores the original, does not reach a parent key handler and does not open the details", async () => {
		const m = await mount();
		await weekReady(m);
		const update = vi.spyOn(m.h.app.tasks, "update");
		const parentKeys = vi.fn();
		cal(m.root).addEventListener("keydown", parentKeys);
		const block = entry(cal(m.root), "Standup", ".cp-cal-daycol");
		await drag(block, { x: colX(THU), y: 900 }, { x: colX(FRI), y: 960 }, { release: false });
		expect(ghost(m)).not.toBeNull();
		const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
		block.dispatchEvent(esc);
		await settle();
		expect(parentKeys).not.toHaveBeenCalled();
		expect(ghost(m)).toBeNull();
		expect(block.classList.contains("is-dragging")).toBe(false);
		up(block, { x: colX(FRI), y: 960 });
		block.click();
		await settle();
		expect(update).not.toHaveBeenCalled();
		expect(details(m)).toBeNull();
		expect(task(m, "Standup").scheduled).toEqual(at("2026-10-01", "19:00"));
	});

	it("a press under the threshold still opens the details", async () => {
		const m = await mount();
		await weekReady(m);
		const update = vi.spyOn(m.h.app.tasks, "update");
		const block = entry(cal(m.root), "Standup", ".cp-cal-daycol");
		down(block, { x: 350, y: 900 });
		move(block, { x: 352, y: 901 });
		up(block, { x: 352, y: 901 });
		block.click();
		await settle();
		expect(ghost(m)).toBeNull();
		expect(details(m)).not.toBeNull();
		expect(update).not.toHaveBeenCalled();
	});

	it("ignores touch and the right button", async () => {
		const m = await mount();
		await weekReady(m);
		const block = entry(cal(m.root), "Standup", ".cp-cal-daycol");
		down(block, { x: 350, y: 900 }, { pointerType: "touch" });
		move(block, { x: 450, y: 960 });
		await settle();
		expect(ghost(m)).toBeNull();
		down(block, { x: 350, y: 900 }, { button: 2 });
		move(block, { x: 450, y: 960 });
		await settle();
		expect(ghost(m)).toBeNull();
	});

	it("Enter and Space still open the details", async () => {
		const m = await mount();
		await weekReady(m);
		press(entry(cal(m.root), "Standup", ".cp-cal-daycol"), "Enter");
		await settle();
		expect(details(m)).not.toBeNull();
	});

	it("an unmount cancels an active drag", async () => {
		const m = await mount();
		await weekReady(m);
		const update = vi.spyOn(m.h.app.tasks, "update");
		const block = entry(cal(m.root), "Standup", ".cp-cal-daycol");
		await drag(block, { x: colX(THU), y: 900 }, { x: colX(FRI), y: 960 }, { release: false });
		m.unmount();
		mounted.splice(mounted.indexOf(m), 1);
		up(block, { x: colX(FRI), y: 960 });
		await settle();
		expect(update).not.toHaveBeenCalled();
	});
});

describe("week: resize (D12)", () => {
	const handle = (b: Element) => b.querySelector<HTMLElement>(".cp-cal-resize");

	it("sets the duration from the snapped end, keeps the start, and is one update", async () => {
		const m = await mount();
		await weekReady(m);
		const update = vi.spyOn(m.h.app.tasks, "update");
		const undoNotice = vi.spyOn(m.host, "notifyUndo");
		const h = handle(entry(cal(m.root), "Standup", ".cp-cal-daycol"))!;
		// The block ends at 19:45; drag the edge to 20:30, so the duration is 90.
		await drag(h, { x: colX(THU), y: y(19 * 60 + 45) - 2 }, { x: colX(THU), y: y(20 * 60 + 30) });
		expect(update).toHaveBeenCalledTimes(1);
		const after = task(m, "Standup");
		expect(after.plannedDurationMin).toBe(90);
		expect(after.scheduled).toEqual(at("2026-10-01", "19:00"));
		expect(undoNotice).toHaveBeenCalledWith('Changed the length of "Standup".', "Edit task", expect.any(Number));
		expect(details(m)).toBeNull();
	});

	it("shows the ghost with the new range while resizing", async () => {
		const m = await mount();
		await weekReady(m);
		const h = handle(entry(cal(m.root), "Standup", ".cp-cal-daycol"))!;
		await drag(h, { x: colX(THU), y: y(19 * 60 + 45) - 2 }, { x: colX(THU), y: y(20 * 60 + 30) }, { release: false });
		expect(ghost(m)!.textContent).toBe("19:00–20:30");
		expect(ghost(m)!.classList.contains("is-resize")).toBe(true);
		up(h, { x: colX(THU), y: y(20 * 60 + 30) });
		await settle();
	});

	it("is at least 15 minutes and clamps at 24:00", async () => {
		const m = await mount();
		await weekReady(m);
		const h = () => handle(entry(cal(m.root), "Standup", ".cp-cal-daycol"))!;
		await drag(h(), { x: colX(THU), y: y(19 * 60 + 45) - 2 }, { x: colX(THU), y: y(18 * 60) });
		expect(task(m, "Standup").plannedDurationMin).toBe(15);
		stubWeek(m.root);
		await drag(h(), { x: colX(THU), y: y(19 * 60 + 15) - 2 }, { x: colX(THU), y: y(30 * 60) });
		expect(task(m, "Standup").plannedDurationMin).toBe(5 * 60 + 0);
	});

	it("a block without a duration gains one", async () => {
		const m = await mount();
		await weekReady(m);
		expect(task(m, "Quick call").plannedDurationMin).toBeNull();
		const h = handle(entry(cal(m.root), "Quick call", ".cp-cal-daycol"))!;
		// Drawn 30 minutes tall (09:00 to 09:30); drag the edge to 10:00.
		await drag(h, { x: colX(FRI), y: y(9 * 60 + 30) - 2 }, { x: colX(FRI), y: y(10 * 60) });
		expect(task(m, "Quick call").plannedDurationMin).toBe(60);
		expect(task(m, "Quick call").scheduled).toEqual(at("2026-10-02", "09:00"));
	});

	it("no half of a block that runs past midnight has a handle; the handle is decorative", async () => {
		const m = await mount();
		await seed(m);
		await m.h.app.tasks.create({ title: "Night shift", scheduled: at("2026-10-01", "23:00"), plannedDurationMin: 120 });
		await openCalendar(m);
		const halves = entries(cal(m.root), "Night shift", ".cp-cal-daycol");
		expect(halves).toHaveLength(2);
		for (const half of halves) expect(handle(half)).toBeNull();
		// A block that ends exactly at midnight does not continue: it keeps its handle.
		await m.h.app.tasks.create({ title: "Late", scheduled: at("2026-10-02", "23:00"), plannedDurationMin: 60 });
		await settle();
		expect(handle(entry(cal(m.root), "Late", ".cp-cal-daycol"))).not.toBeNull();
		const h = handle(entry(cal(m.root), "Standup", ".cp-cal-daycol"))!;
		expect(h.getAttribute("aria-hidden")).toBe("true");
		expect(h.hasAttribute("tabindex")).toBe(false);
		expect(h.hasAttribute("aria-label")).toBe(false);
		// Date entries and deadline flags have none either.
		expect(cal(m.root).querySelector(".cp-cal-allday-cell .cp-cal-resize")).toBeNull();
	});
});

describe("week: all-day entries and refused drops", () => {
	it("a date entry moves between all-day cells and stays date-only", async () => {
		const m = await mount();
		await weekReady(m);
		const update = vi.spyOn(m.h.app.tasks, "update");
		const pill = entry(cal(m.root), "Dentist", ".cp-cal-allday-cell");
		await drag(pill, { x: colX(THU), y: -75 }, { x: colX(SAT), y: -75 });
		expect(update).toHaveBeenCalledTimes(1);
		expect(task(m, "Dentist").scheduled).toEqual(day("2026-10-03"));
		expect(details(m)).toBeNull();
	});

	it("marks the target all-day cell while moving", async () => {
		const m = await mount();
		await weekReady(m);
		const pill = entry(cal(m.root), "Dentist", ".cp-cal-allday-cell");
		await drag(pill, { x: colX(THU), y: -75 }, { x: colX(SAT), y: -75 }, { release: false });
		expect(cell(cal(m.root), "allday-cell", "2026-10-03").classList.contains("is-drop-target")).toBe(true);
		expect(pill.classList.contains("is-dragging")).toBe(true);
		up(pill, { x: colX(SAT), y: -75 });
		await settle();
	});

	it("refuses a timed block on the all-day row", async () => {
		const m = await mount();
		await weekReady(m);
		const update = vi.spyOn(m.h.app.tasks, "update");
		const block = entry(cal(m.root), "Standup", ".cp-cal-daycol");
		await drag(block, { x: colX(THU), y: 900 }, { x: colX(FRI), y: -75 }, { release: false });
		expect(cell(cal(m.root), "allday-cell", "2026-10-02").classList.contains("is-drop-refused")).toBe(true);
		expect(ghost(m)).toBeNull();
		up(block, { x: colX(FRI), y: -75 });
		block.click();
		await settle();
		expect(update).not.toHaveBeenCalled();
		expect(task(m, "Standup").scheduled).toEqual(at("2026-10-01", "19:00"));
		expect(cal(m.root).querySelector(".is-drop-refused")).toBeNull();
	});

	it("refuses a date entry on the hour grid", async () => {
		const m = await mount();
		await weekReady(m);
		const update = vi.spyOn(m.h.app.tasks, "update");
		const pill = entry(cal(m.root), "Dentist", ".cp-cal-allday-cell");
		await drag(pill, { x: colX(THU), y: -75 }, { x: colX(FRI), y: 500 }, { release: false });
		expect(cell(cal(m.root), "daycol", "2026-10-02").classList.contains("is-drop-refused")).toBe(true);
		up(pill, { x: colX(FRI), y: 500 });
		await settle();
		expect(update).not.toHaveBeenCalled();
		expect(task(m, "Dentist").scheduled).toEqual(day("2026-10-01"));
	});

	it("deadline flags do not drag", async () => {
		const m = await mount();
		await weekReady(m);
		const update = vi.spyOn(m.h.app.tasks, "update");
		const flag = entry(cal(m.root), "Report", ".cp-cal-allday-cell");
		down(flag, { x: colX(SAT), y: -75 });
		move(flag, { x: colX(SAT) + 20, y: -75 });
		move(flag, { x: colX(SAT) + 100, y: -75 });
		await settle();
		expect(flag.classList.contains("is-dragging")).toBe(false);
		up(flag, { x: colX(SAT) + 100, y: -75 });
		flag.click();
		await settle();
		expect(update).not.toHaveBeenCalled();
		expect(details(m)).not.toBeNull();
	});
});

describe("unscheduled drawer rows (D11)", () => {
	async function withDrawer(m: CalMount) {
		await weekReady(m);
		await m.h.app.tasks.create({ title: "Write report", plannedDurationMin: 60 });
		await settle();
		await click(byLabel(cal(m.root), "Unscheduled"));
		stubWeek(m.root);
		return cal(m.root).querySelector<HTMLElement>(`.cp-cal-unscheduled .cp-task-row[data-task-id="${task(m, "Write report").id}"]`)!;
	}

	it("drops onto an hour slot: timed schedule at the snapped slot, duration unchanged", async () => {
		const m = await mount();
		const row = await withDrawer(m);
		const update = vi.spyOn(m.h.app.tasks, "update");
		const undoNotice = vi.spyOn(m.host, "notifyUndo");
		await drag(row, { x: 650, y: 100 }, { x: colX(FRI), y: y(12 * 60 + 35) }, { release: false });
		expect(ghost(m)!.textContent).toBe("12:30–13:30");
		up(row, { x: colX(FRI), y: y(12 * 60 + 35) });
		await settle();
		expect(update).toHaveBeenCalledTimes(1);
		const t = task(m, "Write report");
		expect(t.scheduled).toEqual(at("2026-10-02", "12:30"));
		expect(t.plannedDurationMin).toBe(60);
		expect(undoNotice).toHaveBeenCalledWith('Scheduled "Write report".', "Edit task", expect.any(Number));
	});

	it("drops onto an all-day cell: a date-only schedule", async () => {
		const m = await mount();
		const row = await withDrawer(m);
		await drag(row, { x: 650, y: 100 }, { x: colX(SAT), y: -75 });
		expect(task(m, "Write report").scheduled).toEqual(day("2026-10-03"));
		expect(task(m, "Write report").plannedDurationMin).toBe(60);
	});

	it("Escape during a drawer-row drag cancels only the drag: the drawer stays open", async () => {
		const m = await mount();
		const row = await withDrawer(m);
		const update = vi.spyOn(m.h.app.tasks, "update");
		await drag(row, { x: 650, y: 100 }, { x: colX(FRI), y: y(12 * 60) }, { release: false });
		expect(ghost(m)).not.toBeNull();
		row.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		await settle();
		expect(ghost(m)).toBeNull();
		expect(cal(m.root).querySelector(".cp-cal-unscheduled")).not.toBeNull();
		up(row, { x: colX(FRI), y: y(12 * 60) });
		await settle();
		expect(update).not.toHaveBeenCalled();
		// With no drag active, Escape closes the drawer as before.
		row.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		await settle();
		expect(cal(m.root).querySelector(".cp-cal-unscheduled")).toBeNull();
	});

	it("dropping outside the grid does nothing, and the checkbox is not a drag handle", async () => {
		const m = await mount();
		const row = await withDrawer(m);
		const update = vi.spyOn(m.h.app.tasks, "update");
		await drag(row, { x: 650, y: 100 }, { x: 900, y: 100 });
		expect(update).not.toHaveBeenCalled();
		const box = row.querySelector("button, input")!;
		down(box, { x: 650, y: 100 });
		move(box, { x: colX(FRI), y: 500 });
		await settle();
		expect(ghost(m)).toBeNull();
	});
});

describe("month view (D11)", () => {
	async function monthReady(m: CalMount) {
		await seed(m);
		await openCalendar(m);
		const toggle = [...cal(m.root).querySelectorAll<HTMLButtonElement>(".cp-cal-header button")].find((b) => b.textContent === "Month")!;
		await click(toggle);
		stubMonth(m.root);
	}
	// October 2026 grid, Monday first: Sep 28 is cell 0, so Oct 1 is cell 3 and Oct 8 is cell 10.
	const cellCenter = (i: number) => ({ x: 100 * (i % 7) + 50, y: 100 * Math.floor(i / 7) + 50 });

	it("moves a date entry to another day", async () => {
		const m = await mount();
		await monthReady(m);
		const pill = entry(cal(m.root), "Dentist", ".cp-cal-cell");
		await drag(pill, cellCenter(3), cellCenter(10));
		expect(task(m, "Dentist").scheduled).toEqual(day("2026-10-08"));
	});

	it("moves a timed entry and keeps its time of day", async () => {
		const m = await mount();
		await monthReady(m);
		const update = vi.spyOn(m.h.app.tasks, "update");
		const pill = entry(cal(m.root), "Standup", ".cp-cal-cell");
		await drag(pill, cellCenter(3), cellCenter(10), { release: false });
		expect(cell(cal(m.root), "cell", "2026-10-08").classList.contains("is-drop-target")).toBe(true);
		up(pill, cellCenter(10));
		await settle();
		expect(update).toHaveBeenCalledTimes(1);
		expect(task(m, "Standup").scheduled).toEqual(at("2026-10-08", "19:00"));
		expect(task(m, "Standup").plannedDurationMin).toBe(45);
	});

	it("dropping on the same day writes nothing; deadline flags do not drag; a short press opens details", async () => {
		const m = await mount();
		await monthReady(m);
		const update = vi.spyOn(m.h.app.tasks, "update");
		const pill = entry(cal(m.root), "Dentist", ".cp-cal-cell");
		await drag(pill, cellCenter(3), { x: cellCenter(3).x + 20, y: cellCenter(3).y });
		expect(update).not.toHaveBeenCalled();
		const flag = entry(cal(m.root), "Report", ".cp-cal-cell");
		down(flag, cellCenter(5));
		move(flag, cellCenter(6));
		move(flag, cellCenter(12));
		up(flag, cellCenter(12));
		flag.click();
		await settle();
		expect(update).not.toHaveBeenCalled();
		expect(details(m)).not.toBeNull();
	});

	it("Escape in the month restores everything", async () => {
		const m = await mount();
		await monthReady(m);
		const update = vi.spyOn(m.h.app.tasks, "update");
		const pill = entry(cal(m.root), "Dentist", ".cp-cal-cell");
		await drag(pill, cellCenter(3), cellCenter(10), { release: false });
		pill.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		await settle();
		expect(cal(m.root).querySelector(".is-drop-target")).toBeNull();
		up(pill, cellCenter(10));
		pill.click();
		await settle();
		expect(update).not.toHaveBeenCalled();
		expect(details(m)).toBeNull();
	});
});

describe("M4 fix round: off-grid and overlay drops", () => {
	it("a timed block released above the grid (header, toolbar, sticky rows) writes nothing", async () => {
		const m = await mount();
		await weekReady(m);
		const update = vi.spyOn(m.h.app.tasks, "update");
		const block = entry(cal(m.root), "Standup", ".cp-cal-daycol");
		for (const to of [{ x: colX(FRI), y: -1500 }, { x: colX(FRI), y: -500 }, { x: colX(FRI), y: -60 }, { x: colX(FRI), y: 2500 }, { x: 900, y: 900 }]) {
			await drag(block, { x: colX(THU), y: 900 }, to, { release: false });
			expect(ghost(m), JSON.stringify(to)).toBeNull();
			up(block, to);
			block.click();
			await settle();
		}
		expect(update).not.toHaveBeenCalled();
		expect(task(m, "Standup").scheduled).toEqual(at("2026-10-01", "19:00"));
	});

	for (const [name, sel] of [
		["the Unscheduled drawer", ".cp-cal-unscheduled"],
		["the details pane", ".cp-details-pane"],
	] as const) {
		it(`a drop whose point is over ${name} is refused (calendar)`, async () => {
			const m = await mount();
			await weekReady(m);
			await m.h.app.tasks.create({ title: "Write report", plannedDurationMin: 60 });
			await settle();
			await click(byLabel(cal(m.root), "Unscheduled"));
			await click(entry(cal(m.root), "Dentist", ".cp-cal-allday-cell"));
			stubWeek(m.root);
			const over = cal(m.root).querySelector<HTMLElement>(sel)!;
			expect(over).not.toBeNull();
			const doc = document as unknown as { elementFromPoint?: unknown };
			doc.elementFromPoint = () => over;
			try {
				const update = vi.spyOn(m.h.app.tasks, "update");
				const block = entry(cal(m.root), "Standup", ".cp-cal-daycol");
				await drag(block, { x: colX(THU), y: 900 }, { x: colX(FRI), y: 960 }, { release: false });
				expect(ghost(m)).toBeNull();
				up(block, { x: colX(FRI), y: 960 });
				await settle();
				const row = cal(m.root).querySelector<HTMLElement>(`.cp-cal-unscheduled .cp-task-row[data-task-id="${task(m, "Write report").id}"]`)!;
				await drag(row, { x: 650, y: 100 }, { x: colX(FRI), y: y(12 * 60) });
				expect(update).not.toHaveBeenCalled();
			} finally {
				delete doc.elementFromPoint;
			}
		});
	}
});

describe("M4 fix round: scrolling, notices and styles", () => {
	it("the dragged element survives the re-renders a drag causes (ghost state, is-dragging)", async () => {
		const m = await mount();
		await weekReady(m);
		const block = entry(cal(m.root), "Standup", ".cp-cal-daycol");
		const h = block.querySelector<HTMLElement>(".cp-cal-resize")!;
		await drag(block, { x: colX(THU), y: 900 }, { x: colX(FRI), y: 960 }, { release: false });
		expect(block.isConnected).toBe(true);
		expect(entry(cal(m.root), "Standup", ".cp-cal-daycol")).toBe(block);
		up(block, { x: colX(THU), y: 900 });
		await settle();
		await drag(h, { x: colX(THU), y: y(19 * 60 + 45) - 2 }, { x: colX(THU), y: y(20 * 60) }, { release: false });
		expect(h.isConnected).toBe(true);
		up(h, { x: colX(THU), y: y(20 * 60) });
		await settle();
	});

	it("the vertical delta includes how far the grid scrolled during the drag", async () => {
		const m = await mount();
		await weekReady(m);
		const scroller = cal(m.root).querySelector<HTMLElement>(".cp-cal-scroller")!;
		scroller.scrollTop = 200;
		const block = entry(cal(m.root), "Standup", ".cp-cal-daycol");
		down(block, { x: colX(THU), y: 900 });
		move(block, { x: colX(THU), y: 910 });
		// One hour of scrolling (48 px) with the pointer still at the same place: 19:00 moves to 20:00.
		scroller.scrollTop = 248;
		move(block, { x: colX(THU), y: 910 });
		up(block, { x: colX(THU), y: 910 });
		await settle();
		// 10 px is 12.5 minutes (snaps to 15), plus 60 from the scroll: 20:15.
		expect(task(m, "Standup").scheduled).toEqual(at("2026-10-01", "20:15"));
	});

	it("a drop that the service resolves to the current value warns but offers no Undo", async () => {
		const m = await mount();
		await weekReady(m);
		const t = task(m, "Standup");
		// What update returns when the patch normalizes to the stored value (nothing written, no undo entry).
		expect((await m.h.app.tasks.update(t.id, { plannedDurationMin: t.plannedDurationMin })).changed).toBe(false);
		const update = vi.spyOn(m.h.app.tasks, "update").mockResolvedValue({ task: t, warnings: ["dst-gap"], changed: false });
		const notify = vi.spyOn(m.host, "notify");
		const undoNotice = vi.spyOn(m.host, "notifyUndo");
		const block = entry(cal(m.root), "Standup", ".cp-cal-daycol");
		await drag(block, { x: colX(THU), y: y(19 * 60 + 10) }, { x: colX(FRI), y: y(19 * 60 + 10) });
		expect(update).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith("Adjusted for daylight saving");
		expect(undoNotice).not.toHaveBeenCalled();
	});

	it("a drop into the gap from another day stores 03:30, warns, and does offer Undo", async () => {
		const m = await mount();
		m.h.clock.set("2026-03-28T08:00:00Z");
		await m.rerender();
		await m.h.app.tasks.create({ title: "Spring", scheduled: at("2026-03-28", "10:00"), plannedDurationMin: 60 });
		await openCalendar(m);
		await click(byLabel(cal(m.root), "Today"));
		stubWeek(m.root);
		const notify = vi.spyOn(m.host, "notify");
		const undoNotice = vi.spyOn(m.host, "notifyUndo");
		const block = entry(cal(m.root), "Spring", ".cp-cal-daycol");
		await drag(block, { x: colX(5), y: y(10 * 60 + 10) }, { x: colX(6), y: y(2 * 60 + 40) });
		expect(task(m, "Spring").scheduled).toEqual(at("2026-03-29", "03:30"));
		expect(notify).toHaveBeenCalledWith("Adjusted for daylight saving");
		expect(undoNotice).toHaveBeenCalledTimes(1);
	});

	it("the ghost sits under the sticky header and the resize handle leaves room to move short blocks", () => {
		const css = readFileSync(join(process.cwd(), "styles.css"), "utf8");
		const z = (sel: string) => Number(new RegExp(`${sel.replace(/[.]/g, "\\.")} \\{[^}]*?z-index: (\\d+)`).exec(css)?.[1]);
		expect(z(".checkpoint-view .cp-cal-ghost")).toBeLessThan(z(".checkpoint-view .cp-cal-sticky"));
		expect(z(".checkpoint-view .cp-cal-ghost")).toBeGreaterThan(2);
		expect(/\.cp-cal-entry \.cp-cal-resize \{[^}]*height: min\(8px, 33%\)/.test(css)).toBe(true);
	});
});

describe("K1a: ghost of a split block (D9, F6) and autoscroll (D8)", () => {
	async function nightShift() {
		const m = await mount();
		await seed(m);
		await m.h.app.tasks.create({ title: "Night shift", scheduled: at("2026-10-01", "23:00"), plannedDurationMin: 120 });
		await openCalendar(m);
		stubWeek(m.root);
		const halves = entries(cal(m.root), "Night shift", ".cp-cal-daycol");
		const continued = halves.find((b) => b.closest<HTMLElement>(".cp-cal-daycol")!.dataset.date === "2026-10-02")!;
		const first = halves.find((b) => b !== continued)!;
		return { m, continued, first };
	}

	it("grabbing the continued half draws the ghost on the pointer's column, from midnight", async () => {
		const { m, continued } = await nightShift();
		await drag(continued, { x: colX(FRI), y: 20 }, { x: colX(SAT), y: 20 }, { release: false });
		const g = ghost(m)!;
		expect(g.closest<HTMLElement>(".cp-cal-daycol")!.dataset.date).toBe("2026-10-03");
		expect(g.style.getPropertyValue("--cp-start")).toBe("0");
		expect(g.style.getPropertyValue("--cp-len")).toBe("60");
		up(continued, { x: colX(SAT), y: 20 });
		await settle();
		expect(task(m, "Night shift").scheduled).toEqual(at("2026-10-02", "23:00"));
	});

	it("grabbing the first half still draws the ghost where the block starts", async () => {
		const { m, first } = await nightShift();
		await drag(first, { x: colX(THU), y: y(23 * 60 + 10) }, { x: colX(FRI), y: y(23 * 60 + 10) }, { release: false });
		const g = ghost(m)!;
		expect(g.closest<HTMLElement>(".cp-cal-daycol")!.dataset.date).toBe("2026-10-02");
		expect(g.style.getPropertyValue("--cp-start")).toBe("1380");
		up(first, { x: colX(FRI), y: y(23 * 60 + 10) });
		await settle();
	});

	it("scrolling under a still pointer moves the ghost and the drop (scroll event), and the autoscroller is stopped after the drop", async () => {
		const m = await mount();
		await weekReady(m);
		const scroller = cal(m.root).querySelector<HTMLElement>(".cp-cal-scroller")!;
		const block = entry(cal(m.root), "Standup", ".cp-cal-daycol");
		down(block, { x: colX(THU), y: 900 });
		move(block, { x: colX(THU), y: 910 });
		await settle();
		const before = ghost(m)!.style.getPropertyValue("--cp-start");
		scroller.scrollTop += 48;
		scroller.dispatchEvent(new Event("scroll"));
		await settle();
		expect(Number(ghost(m)!.style.getPropertyValue("--cp-start"))).toBe(Number(before) + 60);
		up(block, { x: colX(THU), y: 910 });
		await settle();
		scroller.scrollTop += 48;
		scroller.dispatchEvent(new Event("scroll"));
		await settle();
		expect(ghost(m)).toBeNull();
	});

	it("autoscrolls the week grid while the pointer rests near its bottom edge", async () => {
		const frames: FrameRequestCallback[] = [];
		const m = await mount();
		await weekReady(m);
		const scroller = cal(m.root).querySelector<HTMLElement>(".cp-cal-scroller")!;
		scroller.getBoundingClientRect = () => rect(0, 0, 700, 600);
		for (const [k, v] of [
			["scrollHeight", 2000],
			["clientHeight", 600],
		] as const) Object.defineProperty(scroller, k, { value: v, configurable: true });
		scroller.scrollTop = 100;
		window.requestAnimationFrame = (cb) => frames.push(cb);
		const block = entry(cal(m.root), "Standup", ".cp-cal-daycol");
		down(block, { x: colX(THU), y: 300 });
		move(block, { x: colX(THU), y: 310 });
		move(block, { x: colX(THU), y: 595 });
		const run = () => frames.splice(0).forEach((cb) => cb(0));
		run();
		run();
		expect(scroller.scrollTop).toBeGreaterThan(100);
		up(block, { x: colX(THU), y: 595 });
		await settle();
		const at0 = scroller.scrollTop;
		run();
		expect(scroller.scrollTop).toBe(at0);
	});
});
