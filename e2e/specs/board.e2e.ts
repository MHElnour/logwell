// The board in the real app.
// Tasks are seeded through the app services with dates relative to the real today. Every DOM read is
// scoped to the visible Tasks section (background tabs keep hidden copies). Drags use the real pointer.
import { browser, expect } from "@wdio/globals";
import { at as timedIn } from "../../tests/persistence/fixtures";
import {
	appToday,
	appZone,
	boardColumn,
	centerOf,
	columnCardIds,
	createTask,
	detachAppLeaves,
	dragPointer,
	freshDatabase,
	getTask,
	listRowIds,
	plusDays,
	rectOf,
	setLayout,
	showSidebarView,
	storedOrder,
	type ViewportPoint,
	visibleTasksSection,
	waitForStableRect,
} from "../helpers";

/** Scrolls an element into view horizontally and vertically (a board column beyond the right edge). */
async function bringIntoView(el: WebdriverIO.Element | ChainablePromiseElement): Promise<void> {
	const element = await el;
	await browser.execute((e) => (e as unknown as HTMLElement).scrollIntoView({ block: "nearest", inline: "nearest" }), element);
	await waitForStableRect(el);
}

/** The point just inside the top of an element, horizontally centered. */
async function topOf(el: WebdriverIO.Element | ChainablePromiseElement, inset = 4): Promise<ViewportPoint> {
	const r = await rectOf(el);
	return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + inset) };
}

/** A point on a card's title line (not its checkbox), where a press starts a drag. */
async function grabPoint(card: WebdriverIO.Element | ChainablePromiseElement): Promise<ViewportPoint> {
	const r = await rectOf(card.$(".cp-board-title"));
	return { x: Math.round(r.left + Math.min(r.width / 2, 40)), y: Math.round(r.top + r.height / 2) };
}

async function scrollTopOf(selector: string): Promise<number> {
	return browser.execute((sel) => {
		const el = Array.from(document.querySelectorAll<HTMLElement>(sel)).find((e) => e.offsetParent !== null);
		return el?.scrollTop ?? -1;
	}, selector);
}

describe("Board and list drag", function () {
	let today = "";
	let zone = "";

	beforeEach(async function () {
		await freshDatabase();
		await detachAppLeaves();
		today = await appToday();
		zone = await appZone();
	});

	afterEach(async function () {
		await browser.releaseActions();
	});

	const at = (date: string, time: string) => timedIn(date, time, zone);

	it("Today's board has Overdue and Today columns; dragging an overdue card to Today keeps its time", async function () {
		const id = await createTask("Late card", { scheduled: at(plusDays(today, -1), "09:30") });
		await createTask("On time card", { scheduled: { kind: "date", date: today } });
		const section = await visibleTasksSection();
		await showSidebarView(section, "Today");
		await setLayout(section, "Board");
		await boardColumn(section, "overdue").waitForExist({ timeout: 5000, timeoutMsg: "no Overdue column" });
		await boardColumn(section, "today").waitForExist({ timeout: 5000, timeoutMsg: "no Today column" });
		expect(await columnCardIds(section, "overdue")).toEqual([id]);
		const card = section.$(`.cp-board-card[data-task-id="${id}"]`);
		await waitForStableRect(card);
		const target = boardColumn(section, "today").$(".cp-board-col-body");
		await bringIntoView(target);
		await dragPointer(
			() => grabPoint(card),
			async () => {
				const r = await rectOf(target);
				return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
			},
		);
		await browser.waitUntil(async () => ((await getTask(id))?.scheduled as { local?: string } | null)?.local === `${today}T09:30`, {
			timeout: 5000,
			timeoutMsg: "the overdue card was not rescheduled to today at 09:30",
		});
		const task = await getTask(id);
		expect(task!.id).toBe(id);
		expect(task!.scheduled).toEqual(at(today, "09:30"));
		await expect(section.$(".cp-details-pane")).not.toExist();
		await boardColumn(section, "overdue").waitForExist({ timeout: 5000, reverse: true, timeoutMsg: "the empty Overdue column stayed" });
		expect(await columnCardIds(section, "today")).toContain(id);
	});

	it("an Upcoming card dragged to another day keeps its id and time and gets the new date", async function () {
		const tomorrow = plusDays(today, 1);
		const later = plusDays(today, 2);
		const id = await createTask("Move to later", { scheduled: at(tomorrow, "14:15") });
		const section = await visibleTasksSection();
		await showSidebarView(section, "Upcoming");
		await setLayout(section, "Board");
		const card = section.$(`.cp-board-card[data-task-id="${id}"]`);
		await card.waitForExist({ timeout: 5000 });
		await waitForStableRect(card);
		const target = boardColumn(section, later).$(".cp-board-col-body");
		await bringIntoView(target);
		await dragPointer(
			() => grabPoint(card),
			async () => {
				const r = await rectOf(target);
				return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
			},
		);
		await browser.waitUntil(async () => ((await getTask(id))?.scheduled as { local?: string } | null)?.local === `${later}T14:15`, {
			timeout: 5000,
			timeoutMsg: "the card did not move to the next day at 14:15",
		});
		const task = await getTask(id);
		expect(task!.id).toBe(id);
		expect(task!.scheduled).toEqual(at(later, "14:15"));
		await boardColumn(section, later).$(`.cp-board-card[data-task-id="${id}"]`).waitForExist({ timeout: 5000, timeoutMsg: "the card did not render in its new column" });
		await expect(section.$(".cp-details-pane")).not.toExist();
	});

	it("a reorder within a column persists and the list shows the same order", async function () {
		const tomorrow = plusDays(today, 1);
		const a = await createTask("Order A", { scheduled: { kind: "date", date: tomorrow } });
		const b = await createTask("Order B", { scheduled: { kind: "date", date: tomorrow } });
		const c = await createTask("Order C", { scheduled: { kind: "date", date: tomorrow } });
		const section = await visibleTasksSection();
		await showSidebarView(section, "Upcoming");
		await setLayout(section, "Board");
		await browser.waitUntil(async () => (await columnCardIds(section, tomorrow)).length === 3, { timeout: 5000, timeoutMsg: "the column lacks three cards" });
		expect(await columnCardIds(section, tomorrow)).toEqual([a, b, c]);
		const cardC = section.$(`.cp-board-card[data-task-id="${c}"]`);
		const cardA = section.$(`.cp-board-card[data-task-id="${a}"]`);
		await waitForStableRect(cardC);
		await dragPointer(
			() => grabPoint(cardC),
			async () => topOf(cardA),
		);
		await browser.waitUntil(async () => (await storedOrder([a, b, c])).join() === [c, a, b].join(), {
			timeout: 5000,
			timeoutMsg: "the reorder did not persist as C, A, B",
		});
		expect(await columnCardIds(section, tomorrow)).toEqual([c, a, b]);
		// Same day: a reorder never touches dates.
		expect((await getTask(c))!.scheduled).toEqual({ kind: "date", date: tomorrow });
		await setLayout(section, "List");
		await browser.waitUntil(async () => (await listRowIds(section)).join() === [c, a, b].join(), {
			timeout: 5000,
			timeoutMsg: "the list does not show the board order C, A, B",
		});
	});

	it("list rows reorder by drag under the Default sort", async function () {
		const r1 = await createTask("Row 1");
		const r2 = await createTask("Row 2");
		const r3 = await createTask("Row 3");
		const section = await visibleTasksSection();
		await showSidebarView(section, "Inbox");
		await browser.waitUntil(async () => (await listRowIds(section)).length === 3, { timeout: 5000, timeoutMsg: "the Inbox lacks three rows" });
		expect(await listRowIds(section)).toEqual([r1, r2, r3]);
		const first = section.$(`.cp-task-row[data-task-id="${r1}"]`);
		const last = section.$(`.cp-task-row[data-task-id="${r3}"]`);
		await waitForStableRect(last);
		await dragPointer(
			async () => centerOf(first.$(".cp-task-title")),
			async () => {
				const r = await rectOf(last);
				return { x: Math.round(r.left + r.width / 2), y: Math.round(r.bottom - 3) };
			},
		);
		await browser.waitUntil(async () => (await storedOrder([r1, r2, r3])).join() === [r2, r3, r1].join(), {
			timeout: 5000,
			timeoutMsg: "the row reorder did not persist as 2, 3, 1",
		});
		await browser.waitUntil(async () => (await listRowIds(section)).join() === [r2, r3, r1].join(), { timeout: 5000, timeoutMsg: "the list did not render 2, 3, 1" });
		await expect(section.$(".cp-details-pane")).not.toExist();
	});

	it("autoscroll: holding a card near the bottom edge scrolls its column", async function () {
		for (let i = 1; i <= 30; i++) await createTask(`Long ${String(i).padStart(2, "0")}`, { scheduled: { kind: "date", date: today } });
		const section = await visibleTasksSection();
		await showSidebarView(section, "Today");
		await setLayout(section, "Board");
		const body = boardColumn(section, "today").$(".cp-board-col-body");
		await body.waitForExist({ timeout: 5000 });
		await browser.waitUntil(async () => (await columnCardIds(section, "today")).length === 30, { timeout: 5000, timeoutMsg: "the Today column lacks 30 cards" });
		const scrollable = await browser.execute((el) => (el as unknown as HTMLElement).scrollHeight > (el as unknown as HTMLElement).clientHeight, await body.getElement());
		expect(scrollable).toBe(true);
		const card = boardColumn(section, "today").$(".cp-board-card");
		await waitForStableRect(card);
		await dragPointer(
			() => grabPoint(card),
			async (from) => {
				const r = await rectOf(body);
				return { x: from.x, y: Math.round(r.bottom - 10) };
			},
			{ release: false },
		);
		await browser.waitUntil(async () => (await scrollTopOf(".cp-board-col-body")) > 0, {
			timeout: 5000,
			interval: 100,
			timeoutMsg: "holding the drag at the bottom edge did not scroll the column",
		});
		// Cancel, so the held drag drops nothing.
		await browser.keys("Escape");
		await browser.releaseActions();
	});

	it("autoscroll: holding a row near the bottom edge scrolls the list", async function () {
		for (let i = 1; i <= 40; i++) await createTask(`Row ${String(i).padStart(2, "0")}`);
		const section = await visibleTasksSection();
		await showSidebarView(section, "Inbox");
		await browser.waitUntil(async () => (await listRowIds(section)).length === 40, { timeout: 5000, timeoutMsg: "the Inbox lacks 40 rows" });
		const first = section.$(".cp-task-row .cp-task-title");
		await waitForStableRect(first);
		await dragPointer(
			() => centerOf(first),
			async (from) => {
				const main = await rectOf(section.$(".cp-main"));
				const bottom = await browser.execute(() => window.innerHeight);
				return { x: from.x, y: Math.round(Math.min(main.bottom, bottom) - 10) };
			},
			{ release: false },
		);
		await browser.waitUntil(async () => (await scrollTopOf(".cp-main")) > 0, {
			timeout: 5000,
			interval: 100,
			timeoutMsg: "holding the drag at the bottom edge did not scroll the list",
		});
		await browser.keys("Escape");
		await browser.releaseActions();
	});

	// Obsidian's Scope tries the board's Alt+Arrow handler after the matrix one passes the key on.
	it("Alt+Right on a focused card moves it to the next day and focus stays on it", async function () {
		const tomorrow = plusDays(today, 1);
		const later = plusDays(today, 2);
		const id = await createTask("Keyboard move", { scheduled: at(tomorrow, "16:45") });
		const section = await visibleTasksSection();
		await showSidebarView(section, "Upcoming");
		await setLayout(section, "Board");
		const item = section.$(`.cp-board-item[data-task-id="${id}"]`);
		await item.waitForExist({ timeout: 5000 });
		await browser.execute((el) => (el as unknown as HTMLElement).focus(), await item.getElement());
		await browser.keys(["Alt", "ArrowRight"]);
		await browser.waitUntil(async () => ((await getTask(id))?.scheduled as { local?: string } | null)?.local === `${later}T16:45`, {
			timeout: 5000,
			timeoutMsg: "Alt+Right did not move the card to the next day at 16:45",
		});
		await boardColumn(section, later).$(`.cp-board-card[data-task-id="${id}"]`).waitForExist({ timeout: 5000, timeoutMsg: "the card is not in the next column" });
		await browser.waitUntil(
			async () => (await browser.execute(() => document.activeElement?.getAttribute("data-task-id") ?? null)) === id,
			{ timeout: 5000, timeoutMsg: "focus left the moved card" },
		);
	});
});
