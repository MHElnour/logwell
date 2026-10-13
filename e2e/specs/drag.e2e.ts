// Calendar drag in the real app.
// Tasks are seeded through the app services with dates relative to the real today. Every DOM read is
// scoped to the visible calendar (background tabs keep hidden copies). The e2e window is about 1024 px
// wide, so details and the unscheduled drawer float over the grid.
import { browser, expect } from "@wdio/globals";
import {
	type ViewportPoint,
	appToday,
	appWeekStart,
	appZone,
	centerOf,
	createTask,
	dragPointer,
	freshDatabase,
	getTask,
	rectOf,
	visibleCalendar,
	waitForStableRect,
	weekDatesOf,
} from "../helpers";

const HOUR_PX = 48;

/** Scrolls the week grid so 08:00 is at its top, then waits a frame. */
async function scrollGridTo8(): Promise<void> {
	await browser.execute((px) => {
		const root = Array.from(document.querySelectorAll<HTMLElement>(".cp-calendar")).find((e) => e.offsetParent !== null);
		const el = root?.querySelector<HTMLElement>(".cp-cal-scroller");
		if (el !== null && el !== undefined) el.scrollTop = 8 * px;
	}, HOUR_PX);
	await browser.pause(150);
}

async function column(calendar: WebdriverIO.Element, date: string): Promise<WebdriverIO.Element> {
	return calendar.$(`.cp-cal-daycol[data-date="${date}"]`).getElement();
}

/** The viewport point at `minutes` past midnight, in the middle of a day column. */
async function slotPoint(calendar: WebdriverIO.Element, date: string, minutes: number): Promise<ViewportPoint> {
	const r = await rectOf(await column(calendar, date));
	return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + (minutes / 60) * HOUR_PX) };
}

async function detachAppLeaves(): Promise<void> {
	await browser.executeObsidian(({ app }) => {
		app.workspace.detachLeavesOfType("checkpoint-app");
	});
}

describe("Calendar drag", function () {
	let zone = "";
	let days: string[] = [];

	/** A 09:00 block of 60 minutes on the second day of the week. */
	async function seedBlock(): Promise<string> {
		return createTask("Drag me", { scheduled: { kind: "datetime", local: `${days[1]}T09:00`, tz: zone }, plannedDurationMin: 60 });
	}

	async function openCalendar(): Promise<WebdriverIO.Element> {
		const calendar = await visibleCalendar();
		await scrollGridTo8();
		return calendar;
	}

	beforeEach(async function () {
		await freshDatabase();
		await detachAppLeaves();
		zone = await appZone();
		days = weekDatesOf(await appToday(), await appWeekStart());
	});

	afterEach(async function () {
		await browser.releaseActions();
	});

	it("moves a timed block to another day and slot: stored local time and zone, same ID", async function () {
		const id = await seedBlock();
		const calendar = await openCalendar();
		const block = calendar.$(`.cp-cal-entry[data-task-id="${id}"]`);
		await block.waitForExist({ timeout: 5000 });
		await waitForStableRect(block);
		// Press near the top of the block (the bottom edge is the resize handle). Next column, 2.5 hours
		// lower: 09:00 becomes 11:30. Both points are measured right before the press.
		await dragPointer(
			async () => {
				const r = await rectOf(block);
				return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 10) };
			},
			async (from) => ({ x: (await slotPoint(calendar, days[2]!, 0)).x, y: from.y + 2.5 * HOUR_PX }),
		);
		await browser.waitUntil(async () => ((await getTask(id))?.scheduled as { local?: string } | null)?.local === `${days[2]}T11:30`, {
			timeout: 5000,
			timeoutMsg: "the block did not move to the next day at 11:30",
		});
		const task = await getTask(id);
		expect(task!.id).toBe(id);
		expect(task!.scheduled).toEqual({ kind: "datetime", local: `${days[2]}T11:30`, tz: zone });
		expect(task!.plannedDurationMin).toBe(60);
		// The drop is a drag, not a click: no details, no ghost left behind.
		await expect(calendar.$(".cp-details-pane")).not.toExist();
		await expect(calendar.$(".cp-cal-ghost")).not.toExist();
		await browser.waitUntil(async () => (await calendar.$(`.cp-cal-daycol[data-date="${days[2]}"] .cp-cal-entry[data-task-id="${id}"]`).isExisting()), {
			timeout: 5000,
			timeoutMsg: "the block did not render in its new column",
		});
	});

	it("resizes a block to 90 minutes with the bottom handle and writes only the duration", async function () {
		const id = await seedBlock();
		const calendar = await openCalendar();
		const handle = calendar.$(`.cp-cal-entry[data-task-id="${id}"] .cp-cal-resize`);
		await handle.waitForExist({ timeout: 5000 });
		await waitForStableRect(handle);
		// End at 10:30 (column top plus 10.5 hours): 09:00 + 90 minutes.
		await dragPointer(
			() => centerOf(handle),
			async (from) => ({ x: from.x, y: Math.round((await rectOf(await column(calendar, days[1]!))).top + 10.5 * HOUR_PX) }),
		);
		await browser.waitUntil(async () => (await getTask(id))?.plannedDurationMin === 90, { timeout: 5000, timeoutMsg: "the duration did not become 90 minutes" });
		const task = await getTask(id);
		expect(task!.scheduled).toEqual({ kind: "datetime", local: `${days[1]}T09:00`, tz: zone });
		await expect(calendar.$(".cp-details-pane")).not.toExist();
	});

	it("drops an unscheduled drawer row onto a slot: a timed schedule at the snapped time", async function () {
		const id = await createTask("From the drawer");
		const calendar = await openCalendar();
		// A DOM click: an undo notice from an earlier step can float over the header's right end.
		await browser.execute(() => {
			const root = Array.from(document.querySelectorAll<HTMLElement>(".cp-calendar")).find((e) => e.offsetParent !== null);
			root?.querySelector<HTMLElement>(".cp-cal-unscheduled-toggle")?.click();
		});
		const row = calendar.$(`.cp-cal-unscheduled .cp-task-row[data-task-id="${id}"] .cp-task-title`);
		await row.waitForExist({ timeout: 5000, timeoutMsg: "the drawer has no row for the task" });
		await waitForStableRect(row);
		// The first column is clear of the drawer, which floats at the right at this width. 10:00 sharp.
		await dragPointer(() => centerOf(row), () => slotPoint(calendar, days[0]!, 10 * 60));
		await browser.waitUntil(async () => (await getTask(id))?.scheduled !== null, { timeout: 5000, timeoutMsg: "the drop did not schedule the task" });
		const task = await getTask(id);
		expect(task!.id).toBe(id);
		expect(task!.scheduled).toEqual({ kind: "datetime", local: `${days[0]}T10:00`, tz: zone });
		await expect(calendar.$(".cp-details-pane")).not.toExist();
	});
});
