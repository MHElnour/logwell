// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DateSpec } from "../../src/domain/types";
import { makeReadOnly } from "../app/harness";
import { BOARD_MOVE_EVENT, routeBoardMove } from "../../src/ui/board/keys";
import {
	type CalMount,
	board,
	cardTitles,
	click,
	columnEl,
	columnTitles,
	dragTo,
	item,
	modeButton,
	mountBoard,
	openBoard,
	press,
	releaseAt,
	settle,
	sidebarItem,
	stubBoardRects,
} from "./board-helpers";

// The board view and its drag. Today is 2026-10-01 (Europe/Berlin).

const mounted: CalMount[] = [];
afterEach(() => {
	for (const m of mounted.splice(0)) m.unmount();
});
async function mount() {
	const m = await mountBoard();
	mounted.push(m);
	return m;
}

const day = (date: string): DateSpec => ({ kind: "date", date });
const at = (date: string, time: string): DateSpec => ({ kind: "datetime", local: `${date}T${time}`, tz: "Europe/Berlin" });
const taskOf = (m: CalMount, title: string) => [...m.h.app.store.state.tasks.values()].find((t) => t.title === title)!;
const undoDepth = (m: CalMount) => (m.h.app.store as unknown as { undoStack: unknown[] }).undoStack.length;

async function seed(m: CalMount) {
	const T = m.h.app.tasks;
	await T.create({ title: "Late", scheduled: day("2026-09-30") });
	const today = await T.create({ title: "Report", scheduled: at("2026-10-01", "19:00") });
	await T.create({ title: "Draft", parentId: today.task.id, scheduled: at("2026-10-01", "19:00") });
	await T.create({ title: "Review", parentId: today.task.id, scheduled: at("2026-10-01", "19:00") });
	await T.create({ title: "Lunch", scheduled: day("2026-10-01") });
	await T.create({ title: "Tomorrow A", scheduled: at("2026-10-02", "09:30") });
	await T.create({ title: "Tomorrow B", scheduled: day("2026-10-02") });
	await T.create({ title: "Inbox thing" });
	const done = await T.create({ title: "Finished", scheduled: day("2026-10-02") });
	await T.complete(done.task.id);
	// The just-completed task lingers among the open cards for a moment (useLingering).
	await new Promise((r) => setTimeout(r, 600));
	await settle();
}

describe("the List | Board switch (D2)", () => {
	it("is in Today, Upcoming, Inbox and lists, remembered per view, and absent in Tags, Completed and Trash", async () => {
		const m = await mount();
		await seed(m);
		await m.h.app.categories.create("Work", "briefcase");
		await m.h.app.tags.create("urgent", "red");
		await settle();
		const group = () => m.root.querySelector(".cp-tasks .cp-mode-switch");
		expect(modeButton(m.root, "List")!.getAttribute("aria-pressed")).toBe("true");
		expect(modeButton(m.root, "Board")!.getAttribute("aria-pressed")).toBe("false");
		expect(board(m.root)).toBeNull();
		await click(modeButton(m.root, "Board"));
		expect(board(m.root)).not.toBeNull();
		expect(modeButton(m.root, "Board")!.getAttribute("aria-pressed")).toBe("true");
		expect(m.root.querySelector(".cp-tasks .cp-task-list")).toBeNull();
		// Inbox keeps its own mode (the list).
		await click(sidebarItem(m.root, "Inbox"));
		expect(group()).not.toBeNull();
		expect(board(m.root)).toBeNull();
		await click(sidebarItem(m.root, "Today"));
		expect(board(m.root)).not.toBeNull();
		for (const name of ["Upcoming", "Work"]) {
			await click(sidebarItem(m.root, name));
			expect(group(), name).not.toBeNull();
		}
		for (const name of ["@urgent", "Completed", "Trash"]) {
			await click(sidebarItem(m.root, name.replace("@", "")));
			expect(group(), name).toBeNull();
		}
		// The mode survives a section switch.
		await click(sidebarItem(m.root, "Today"));
		await click(m.root.querySelector('.cp-rail [aria-label="Calendar"]'));
		await click(m.root.querySelector('.cp-rail [aria-label="Tasks"]'));
		expect(board(m.root)).not.toBeNull();
		await click(modeButton(m.root, "List"));
		expect(board(m.root)).toBeNull();
	});
});

describe("columns and cards (D3, D4)", () => {
	it("Today has Overdue and Today; the board is built from the store", async () => {
		const m = await mount();
		await seed(m);
		await openBoard(m, "Today");
		expect(columnTitles(m.root)).toEqual(["Overdue", "Today"]);
		expect(cardTitles(m.root, "overdue")).toEqual(["Late"]);
		expect(cardTitles(m.root, "today")).toEqual(["Report", "Lunch"]);
		expect(columnEl(m.root, "overdue").querySelector(".cp-board-add")).toBeNull();
		expect(columnEl(m.root, "today").querySelector(".cp-board-col-count")!.textContent).toBe("2");
		// The meta line: the date in color.
		expect(item(m.root, "Late").querySelector(".cp-meta-date.is-overdue")).not.toBeNull();
		expect(item(m.root, "Lunch").querySelector(".cp-meta-date.is-today")).not.toBeNull();
	});

	it("Upcoming has one column per day from tomorrow, empty days included, and Inbox has No section", async () => {
		const m = await mount();
		await seed(m);
		await openBoard(m, "Upcoming");
		const titles = columnTitles(m.root);
		expect(titles[0]).toBe("Friday, Tomorrow");
		expect(titles[1]).toBe("Saturday, Oct 3");
		expect(titles).toHaveLength(14);
		expect(cardTitles(m.root, "2026-10-02")).toEqual(["Tomorrow A", "Tomorrow B"]);
		expect(cardTitles(m.root, "2026-10-03")).toEqual([]);
		expect(columnEl(m.root, "2026-10-03").querySelector(".cp-board-empty")).not.toBeNull();
		expect(item(m.root, "Tomorrow A").querySelector(".cp-meta-date.is-tomorrow")).not.toBeNull();
		await click(sidebarItem(m.root, "Inbox"));
		await click(modeButton(m.root, "Board"));
		expect(columnTitles(m.root)).toEqual(["No section"]);
		expect(cardTitles(m.root, "none")).toContain("Inbox thing");
	});

	it("nests subtasks in the parent's card with a chevron that collapses them, and shows each column's Completed group", async () => {
		const m = await mount();
		await seed(m);
		await openBoard(m, "Today");
		const card = item(m.root, "Report").closest<HTMLElement>(".cp-board-card")!;
		expect([...card.querySelectorAll(".cp-board-item.is-sub .cp-board-title")].map((e) => e.textContent.trim())).toEqual(["Draft", "Review"]);
		expect(card.querySelectorAll(".cp-board-item.is-sub .cp-task-checkbox")).toHaveLength(2);
		expect(item(m.root, "Report").querySelector(".cp-meta-subtasks")!.textContent.trim()).toBe("0/2");
		const chevron = item(m.root, "Report").querySelector<HTMLButtonElement>(".cp-board-chevron")!;
		expect(chevron.getAttribute("aria-label")).toBe("Collapse subtasks");
		await click(chevron);
		expect(card.querySelector(".cp-board-subs")).toBeNull();
		expect(chevron.isConnected ? chevron.getAttribute("aria-label") : "Expand subtasks").toBe("Expand subtasks");
		await click(item(m.root, "Report").querySelector(".cp-board-chevron"));
		expect(card.querySelector(".cp-board-subs")).not.toBeNull();
		// Selecting a card opens the details, as from a row.
		await click(item(m.root, "Lunch"));
		expect(m.root.querySelector<HTMLTextAreaElement>(".cp-tasks .cp-details-title")?.value).toBe("Lunch");
		// The Completed group is collapsed with its count.
		await click(sidebarItem(m.root, "Upcoming"));
		await click(modeButton(m.root, "Board"));
		const toggle = columnEl(m.root, "2026-10-02").querySelector<HTMLButtonElement>(".cp-completed-toggle")!;
		expect(toggle.textContent.trim()).toBe("Completed · 1");
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		await click(toggle);
		expect(columnEl(m.root, "2026-10-02").querySelector(".cp-completed-group .cp-task-row")).not.toBeNull();
	});

	it("a column's + opens Quick Add on that day and in that list", async () => {
		const m = await mount();
		await seed(m);
		const calls: unknown[] = [];
		m.host.quickAdd = (p?: unknown) => void calls.push(p);
		await openBoard(m, "Upcoming");
		await click(columnEl(m.root, "2026-10-03").querySelector(".cp-board-add"));
		expect(calls.at(-1)).toMatchObject({ date: "2026-10-03" });
		await click(sidebarItem(m.root, "Inbox"));
		await click(modeButton(m.root, "Board"));
		await click(columnEl(m.root, "none").querySelector(".cp-board-add"));
		expect(calls.at(-1)).toMatchObject({ date: null });
	});
});

describe("drag (D6)", () => {
	it("moves a card to another day: same id, new date, time kept, placed, one undo entry, an Undo notice", async () => {
		const m = await mount();
		await seed(m);
		await openBoard(m, "Upcoming");
		const rects = stubBoardRects(m.root);
		const a = taskOf(m, "Tomorrow A");
		const before = undoDepth(m);
		// Drop in the empty Oct 3 column.
		await dragTo(item(m.root, "Tomorrow A"), rects.card("Tomorrow A"), rects.columns["2026-10-03"]!);
		const moved = m.h.app.store.state.tasks.get(a.id)!;
		expect(moved.scheduled).toEqual(at("2026-10-03", "09:30"));
		expect(undoDepth(m)).toBe(before + 1);
		expect(m.h.app.store.undoLabel).toBe("Move task");
		expect(m.host.messages.at(-1)).toBe('Moved "Tomorrow A" to Saturday, Oct 3.');
		expect(cardTitles(m.root, "2026-10-03")).toEqual(["Tomorrow A"]);
		await m.h.app.store.undo();
		expect(m.h.app.store.state.tasks.get(a.id)!.scheduled).toEqual(at("2026-10-02", "09:30"));
	});

	it("places the card at its drop position within a column (the same day: no date change)", async () => {
		const m = await mount();
		await seed(m);
		await openBoard(m, "Upcoming");
		const rects = stubBoardRects(m.root);
		const a = taskOf(m, "Tomorrow A");
		const dated = a.scheduled;
		// Below the middle of Tomorrow B: A goes last.
		await dragTo(item(m.root, "Tomorrow A"), rects.card("Tomorrow A"), { x: 150, y: 50 + 60 + 50 });
		expect(cardTitles(m.root, "2026-10-02")).toEqual(["Tomorrow B", "Tomorrow A"]);
		expect(m.h.app.store.state.tasks.get(a.id)!.scheduled).toEqual(dated);
		expect(m.host.messages.at(-1)).toBe('Moved "Tomorrow A".');
	});

	it("moves a card from Overdue to Today and keeps its place order", async () => {
		const m = await mount();
		await seed(m);
		await openBoard(m, "Today");
		const rects = stubBoardRects(m.root);
		await dragTo(item(m.root, "Late"), rects.card("Late"), { x: 450, y: 700 });
		expect(taskOf(m, "Late").scheduled).toEqual(day("2026-10-01"));
		expect(cardTitles(m.root, "today")).toEqual(["Report", "Lunch", "Late"]);
		expect(columnTitles(m.root)).toEqual(["Today"]);
	});

	it("refuses a drop on Overdue", async () => {
		const m = await mount();
		await seed(m);
		await openBoard(m, "Today");
		const rects = stubBoardRects(m.root);
		const before = undoDepth(m);
		await dragTo(item(m.root, "Lunch"), rects.card("Lunch"), { x: 150, y: 400 });
		expect(taskOf(m, "Lunch").scheduled).toEqual(day("2026-10-01"));
		expect(undoDepth(m)).toBe(before);
		expect(m.host.messages.some((x) => x.startsWith("Moved"))).toBe(false);
	});

	it("refuses a nested subtask dropped on another column, and reorders it among its siblings", async () => {
		const m = await mount();
		await seed(m);
		await openBoard(m, "Upcoming");
		// A parent with two subtasks on Oct 4.
		const p = await m.h.app.tasks.create({ title: "Parent", scheduled: day("2026-10-04") });
		await m.h.app.tasks.create({ title: "Sub one", parentId: p.task.id, scheduled: day("2026-10-04") });
		await m.h.app.tasks.create({ title: "Sub two", parentId: p.task.id, scheduled: day("2026-10-04") });
		await settle();
		const rects = stubBoardRects(m.root);
		const one = taskOf(m, "Sub one");
		const before = undoDepth(m);
		await dragTo(item(m.root, "Sub one"), rects.card("Sub one"), rects.columns["2026-10-05"]!);
		expect(taskOf(m, "Sub one").scheduled).toEqual(day("2026-10-04"));
		expect(undoDepth(m)).toBe(before);
		// Within the card: below Sub two.
		const two = rects.card("Sub two");
		await dragTo(item(m.root, "Sub one"), rects.card("Sub one"), { x: two.x, y: two.y + 15 });
		const subs = [...columnEl(m.root, "2026-10-04").querySelectorAll(".cp-board-item.is-sub .cp-board-title")].map((e) => e.textContent.trim());
		expect(subs).toEqual(["Sub two", "Sub one"]);
		expect(m.h.app.store.state.tasks.get(one.id)!.scheduled).toEqual(day("2026-10-04"));
		expect(undoDepth(m)).toBe(before + 1);
	});

	it("Escape cancels the drag", async () => {
		const m = await mount();
		await seed(m);
		await openBoard(m, "Upcoming");
		const rects = stubBoardRects(m.root);
		const before = undoDepth(m);
		await dragTo(item(m.root, "Tomorrow A"), rects.card("Tomorrow A"), rects.columns["2026-10-03"]!, false);
		expect(board(m.root).querySelector(".cp-board-ghost")).not.toBeNull();
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		await settle();
		expect(board(m.root).querySelector(".cp-board-ghost")).toBeNull();
		await releaseAt(item(m.root, "Tomorrow A"), rects.columns["2026-10-03"]!);
		expect(taskOf(m, "Tomorrow A").scheduled).toEqual(at("2026-10-02", "09:30"));
		expect(undoDepth(m)).toBe(before);
	});

	it("a short press is a click that opens the details", async () => {
		const m = await mount();
		await seed(m);
		await openBoard(m, "Upcoming");
		const el = item(m.root, "Tomorrow B");
		const down = (type: string, x: number, y: number) =>
			el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
		down("pointerdown", 100, 100);
		down("pointermove", 101, 101);
		down("pointerup", 101, 101);
		await click(el);
		expect(board(m.root).querySelector(".cp-board-ghost")).toBeNull();
		expect(m.root.querySelector<HTMLTextAreaElement>(".cp-tasks .cp-details-title")?.value).toBe("Tomorrow B");
	});

	it("under another sort a card can change day but is not placed", async () => {
		const m = await mount();
		await seed(m);
		await openBoard(m, "Upcoming");
		const a = taskOf(m, "Tomorrow A");
		const keyBefore = a.sortKey;
		// Same day, other sort: nothing happens.
		m.host.menus.length = 0;
		await click(m.root.querySelector('.cp-tasks [aria-label="View options"]'));
		const sort = m.host.menus.at(-1)!.flatMap((i) => (i === "separator" ? [] : [i])).find((i) => i.title === "Sort: by priority");
		expect(sort).toBeDefined();
		sort!.run();
		await settle();
		const r2 = stubBoardRects(m.root);
		await dragTo(item(m.root, "Tomorrow A"), r2.card("Tomorrow A"), r2.columns["2026-10-03"]!);
		expect(m.h.app.store.state.tasks.get(a.id)!.scheduled).toEqual(at("2026-10-03", "09:30"));
		expect(m.h.app.store.state.tasks.get(a.id)!.sortKey).toBe(keyBefore);
	});
});

describe("Alt+Arrow (D7)", () => {
	it("Alt+Right moves a card to the next day column, focus stays on it, and Alt+Left back", async () => {
		const m = await mount();
		await seed(m);
		await openBoard(m, "Upcoming");
		const a = taskOf(m, "Tomorrow A");
		item(m.root, "Tomorrow A").focus();
		await press(item(m.root, "Tomorrow A"), "ArrowRight", { altKey: true });
		expect(m.h.app.store.state.tasks.get(a.id)!.scheduled).toEqual(at("2026-10-03", "09:30"));
		expect(cardTitles(m.root, "2026-10-03")).toEqual(["Tomorrow A"]);
		expect(document.activeElement).toBe(item(m.root, "Tomorrow A"));
		expect(board(m.root).querySelector('[role="status"]')!.textContent).toContain("Saturday, Oct 3");
		await press(document.activeElement!, "ArrowLeft", { altKey: true });
		expect(m.h.app.store.state.tasks.get(a.id)!.scheduled).toEqual(at("2026-10-02", "09:30"));
		expect(document.activeElement).toBe(item(m.root, "Tomorrow A"));
	});

	it("Alt+Down reorders one place and keeps focus; Alt+Left in Today does not enter Overdue", async () => {
		const m = await mount();
		await seed(m);
		await openBoard(m, "Upcoming");
		item(m.root, "Tomorrow A").focus();
		await press(item(m.root, "Tomorrow A"), "ArrowDown", { altKey: true });
		expect(cardTitles(m.root, "2026-10-02")).toEqual(["Tomorrow B", "Tomorrow A"]);
		expect(document.activeElement).toBe(item(m.root, "Tomorrow A"));
		await click(sidebarItem(m.root, "Today"));
		await click(modeButton(m.root, "Board"));
		item(m.root, "Lunch").focus();
		const before = undoDepth(m);
		await press(item(m.root, "Lunch"), "ArrowLeft", { altKey: true });
		expect(undoDepth(m)).toBe(before);
		expect(cardTitles(m.root, "overdue")).toEqual(["Late"]);
	});

	it("the view's Scope route sends the key to the focused card, and ignores a focus elsewhere", async () => {
		const m = await mount();
		await seed(m);
		await openBoard(m, "Upcoming");
		const a = taskOf(m, "Tomorrow A");
		const evt = () => new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, cancelable: true });
		const outside = document.createElement("button");
		document.body.appendChild(outside);
		outside.focus();
		expect(routeBoardMove(m.root, evt())).toBe(false);
		outside.remove();
		item(m.root, "Tomorrow A").focus();
		expect(BOARD_MOVE_EVENT).toBe("cp-board-move");
		expect(routeBoardMove(m.root, evt())).toBe(true);
		await settle();
		expect(m.h.app.store.state.tasks.get(a.id)!.scheduled).toEqual(at("2026-10-03", "09:30"));
		expect(document.activeElement).toBe(item(m.root, "Tomorrow A"));
	});
});

describe("read-only, DST gaps, sort and Alt+Arrow on the board", () => {
	const sortByPriority = async (m: CalMount) => {
		m.host.menus.length = 0;
		await click(m.root.querySelector('.cp-tasks [aria-label="View options"]'));
		m.host.menus.at(-1)!.flatMap((i) => (i === "separator" ? [] : [i])).find((i) => i.title === "Sort: by priority")!.run();
		await settle();
	};

	it("read-only: a drag and Alt+Arrow change nothing", async () => {
		const m = await mount();
		await seed(m);
		await openBoard(m, "Upcoming");
		await makeReadOnly(m.h);
		m.h.app.store.notifyStatus();
		await settle();
		const rects = stubBoardRects(m.root);
		const a = taskOf(m, "Tomorrow A");
		const place = vi.spyOn(m.h.app.tasks, "place");
		const update = vi.spyOn(m.h.app.tasks, "update");
		await dragTo(item(m.root, "Tomorrow A"), rects.card("Tomorrow A"), rects.columns["2026-10-03"]!, false);
		expect(board(m.root).querySelector(".cp-board-ghost")).toBeNull();
		await releaseAt(item(m.root, "Tomorrow A"), rects.columns["2026-10-03"]!);
		item(m.root, "Tomorrow A").focus();
		await press(item(m.root, "Tomorrow A"), "ArrowRight", { altKey: true });
		await press(item(m.root, "Tomorrow A"), "ArrowDown", { altKey: true });
		expect(place).not.toHaveBeenCalled();
		expect(update).not.toHaveBeenCalled();
		expect(m.h.app.store.state.tasks.get(a.id)).toBe(a);
	});

	it("a drop into a DST gap day shows the warning", async () => {
		const m = await mount();
		m.h.clock.set("2026-03-27T08:00:00Z");
		await m.rerender();
		await m.h.app.tasks.create({ title: "Spring", scheduled: at("2026-03-30", "02:30") });
		await settle();
		await openBoard(m, "Upcoming");
		const rects = stubBoardRects(m.root);
		await dragTo(item(m.root, "Spring"), rects.card("Spring"), rects.columns["2026-03-29"]!);
		expect(taskOf(m, "Spring").scheduled).toEqual(at("2026-03-29", "03:30"));
		expect(m.host.messages).toContain("Adjusted for daylight saving");
	});

	it("under another sort a same-column drag draws no drop line; another column is only highlighted", async () => {
		const m = await mount();
		await seed(m);
		await openBoard(m, "Upcoming");
		await sortByPriority(m);
		const rects = stubBoardRects(m.root);
		await dragTo(item(m.root, "Tomorrow A"), rects.card("Tomorrow A"), { x: 150, y: 50 + 60 + 50 }, false);
		expect(board(m.root).querySelector(".is-drop-before, .is-drop-end")).toBeNull();
		await dragTo(item(m.root, "Tomorrow A"), rects.card("Tomorrow A"), rects.columns["2026-10-03"]!, false);
		expect(columnEl(m.root, "2026-10-03").classList.contains("is-drop-target")).toBe(true);
		expect(board(m.root).querySelector(".is-drop-before, .is-drop-end")).toBeNull();
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		await settle();
	});

	it("Alt+Arrow that cannot move reports false so the Scope lets Obsidian's key run", async () => {
		const m = await mount();
		await seed(m);
		const evt = (key: string) => new KeyboardEvent("keydown", { key, altKey: true, cancelable: true });
		await openBoard(m, "Inbox");
		item(m.root, "Inbox thing").focus();
		expect(routeBoardMove(m.root, evt("ArrowRight"))).toBe(false);
		expect(routeBoardMove(m.root, evt("ArrowLeft"))).toBe(false);
		await click(sidebarItem(m.root, "Upcoming"));
		await click(modeButton(m.root, "Board"));
		item(m.root, "Tomorrow A").focus();
		// Moving left from the first day column, and a refused target, do not act either.
		expect(routeBoardMove(m.root, evt("ArrowLeft"))).toBe(false);
		expect(routeBoardMove(m.root, evt("ArrowRight"))).toBe(true);
		await settle();
		await click(sidebarItem(m.root, "Today"));
		await click(modeButton(m.root, "Board"));
		item(m.root, "Lunch").focus();
		expect(routeBoardMove(m.root, evt("ArrowRight"))).toBe(false);
		expect(routeBoardMove(m.root, evt("ArrowLeft"))).toBe(false);
	});

	it("dropping an Overdue card with a past deadline on Today moves both dates and keeps each time", async () => {
		const m = await mount();
		await seed(m);
		await m.h.app.tasks.create({ title: "Both", scheduled: at("2026-09-30", "09:00"), deadline: at("2026-09-29", "17:00") });
		await m.h.app.tasks.create({ title: "Future deadline", scheduled: day("2026-09-30"), deadline: day("2026-10-05") });
		await settle();
		await openBoard(m, "Today");
		const rects = stubBoardRects(m.root);
		await dragTo(item(m.root, "Both"), rects.card("Both"), { x: 450, y: 700 });
		expect(taskOf(m, "Both").scheduled).toEqual(at("2026-10-01", "09:00"));
		expect(taskOf(m, "Both").deadline).toEqual(at("2026-10-01", "17:00"));
		expect(cardTitles(m.root, "today")).toContain("Both");
		const r2 = stubBoardRects(m.root);
		await dragTo(item(m.root, "Future deadline"), r2.card("Future deadline"), { x: 450, y: 700 });
		expect(taskOf(m, "Future deadline").scheduled).toEqual(day("2026-10-01"));
		expect(taskOf(m, "Future deadline").deadline).toEqual(day("2026-10-05"));
	});
});
