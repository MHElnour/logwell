// Group by in List mode in the real app. Tasks are seeded through the app services. Every DOM
// read is scoped to the visible Tasks section (background tabs keep hidden copies). Native menus are off (DOM
// menus), as in the sections spec. Drags use the real pointer.
import { browser, expect } from "@wdio/globals";
import {
	appToday,
	appZone,
	centerOf,
	closeQuickAdd,
	dragPointer,
	flush,
	freshDatabase,
	getTask,
	groupKeys,
	plusDays,
	rectOf,
	restoreMenus,
	setGroupBy,
	showSidebarView,
	useDomMenus,
	createTask,
	visibleTasksSection,
	waitForStableRect,
} from "../helpers";

async function detachAppLeaves(): Promise<void> {
	await browser.executeObsidian(({ app }) => {
		app.workspace.detachLeavesOfType("checkpoint-app");
	});
}

/** Opens a view (its sidebar entry) and returns the visible Tasks section. */
async function openView(name: string): Promise<WebdriverIO.Element> {
	const section = await visibleTasksSection();
	await showSidebarView(section, name);
	return section;
}

async function waitForKeys(section: WebdriverIO.Element, keys: string[]): Promise<void> {
	await browser.waitUntil(async () => (await groupKeys(section)).join("|") === keys.join("|"), {
		timeout: 5000,
		timeoutMsg: `the groups are not ${keys.join(", ")}`,
	});
}

/** Drags a row onto the lower part of another row. */
async function dragRowOnto(section: WebdriverIO.Element, moving: string, target: string): Promise<void> {
	const row = section.$(`.cp-task-row[data-task-id="${moving}"]`);
	const other = section.$(`.cp-task-row[data-task-id="${target}"]`);
	await row.waitForExist({ timeout: 5000 });
	await other.waitForExist({ timeout: 5000 });
	await waitForStableRect(other);
	await dragPointer(
		async () => centerOf(row.$(".cp-task-title")),
		async () => {
			const r = await rectOf(other);
			return { x: Math.round(r.left + r.width / 2), y: Math.round(r.bottom - 3) };
		},
	);
}

/** The newest notice with an Undo button has this text. */
async function undoNoticeText(): Promise<string> {
	return browser.execute(() => {
		const notices = Array.from(document.querySelectorAll<HTMLElement>(".notice")).filter((n) => Array.from(n.querySelectorAll("button")).some((b) => b.textContent === "Undo"));
		return notices.at(-1)?.textContent ?? "";
	});
}

describe("Group by", function () {
	let wasNative: boolean | undefined;

	before(async function () {
		wasNative = await useDomMenus();
	});

	after(async function () {
		await restoreMenus(wasNative);
	});

	beforeEach(async function () {
		await freshDatabase();
		await detachAppLeaves();
	});

	afterEach(async function () {
		await browser.releaseActions();
		await closeQuickAdd();
	});

	it("dragging a row to another priority group sets the priority and shows an Undo notice", async function () {
		const high = await createTask("High one", { priority: 1 });
		const low = await createTask("Low one", { priority: 3 });
		const section = await openView("Inbox");
		await setGroupBy("Priority");
		await waitForKeys(section, ["priority:1", "priority:3"]);
		await dragRowOnto(section, low, high);
		await browser.waitUntil(async () => (await getTask(low))?.priority === 1, { timeout: 5000, timeoutMsg: "the drop did not set High" });
		expect((await getTask(high))!.priority).toBe(1);
		await section.$(`[data-group-key="priority:1"] .cp-task-row[data-task-id="${low}"]`).waitForExist({ timeout: 5000, timeoutMsg: "the row is not under High" });
		expect(await undoNoticeText()).toContain('Moved "Low one" to High.');
		await flush();
	});

	it("dragging a row to another date group moves it to that day and keeps its time", async function () {
		const today = await appToday();
		const first = plusDays(today, 2);
		const second = plusDays(today, 4);
		const anchor = await createTask("On the earlier day", { scheduled: { kind: "date", date: first } });
		const timed = await createTask("Timed", { scheduled: { kind: "datetime", local: `${second}T09:30`, tz: await appZone() } });
		const before = (await getTask(timed))!.scheduled as { local: string; tz: string };
		const section = await openView("Inbox");
		await setGroupBy("Date");
		await waitForKeys(section, [first, second]);
		await dragRowOnto(section, timed, anchor);
		await browser.waitUntil(async () => ((await getTask(timed))?.scheduled as { local: string } | null)?.local?.startsWith(first) === true, {
			timeout: 5000,
			timeoutMsg: "the drop did not move the task to the earlier day",
		});
		const after = (await getTask(timed))!.scheduled as { local: string; tz: string };
		expect(after.local.slice(0, 10)).toBe(first);
		expect(after.local.slice(11)).toBe(before.local.slice(11));
		expect(after.tz).toBe(before.tz);
		await section.$(`[data-group-key="${first}"] .cp-task-row[data-task-id="${timed}"]`).waitForExist({ timeout: 5000, timeoutMsg: "the row is not under the earlier day" });
		expect(await undoNoticeText()).toContain('Moved "Timed" to');
	});
});
