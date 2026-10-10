// Group by in List mode in the real app. Tasks are seeded through the app services. Every DOM
// read is scoped to the visible Tasks section (background tabs keep hidden copies). Native menus are off (DOM
// menus), as in the sections spec. Drags use the real pointer.
import { browser, expect } from "@wdio/globals";
import {
	appToday,
	appZone,
	centerOf,
	closeQuickAdd,
	createCategory,
	dragPointer,
	flush,
	freshDatabase,
	getTask,
	groupKeys,
	menuTitles,
	openViewMenu,
	pickMenuItem,
	plusDays,
	rectOf,
	restoreMenus,
	sectionsOf,
	setGroupBy,
	setLayout,
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

describe("Group by (G1)", function () {
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

	it("the view menu offers Group by in List mode with each view's options, and not on the board", async function () {
		const section = await openView("Inbox");
		await openViewMenu(".cp-tasks");
		expect(await menuTitles()).toContain("Group by…");
		await pickMenuItem("Group by…");
		await browser.waitUntil(async () => (await menuTitles()).includes("Section"), { timeout: 5000, timeoutMsg: "the Group by menu did not open" });
		expect(await menuTitles()).toEqual(["None", "Section", "Date", "Priority", "Tag"]);
		await pickMenuItem("None");
		await browser.waitUntil(async () => (await menuTitles()).length === 0);

		await showSidebarView(section, "Today");
		await openViewMenu(".cp-tasks");
		await pickMenuItem("Group by…");
		await browser.waitUntil(async () => (await menuTitles()).includes("List"), { timeout: 5000, timeoutMsg: "the Group by menu did not open in Today" });
		expect(await menuTitles()).toEqual(["Date", "List", "Priority", "Tag", "None"]);
		await pickMenuItem("Date");
		await browser.waitUntil(async () => (await menuTitles()).length === 0);

		await setLayout(section, "Board");
		await openViewMenu(".cp-tasks");
		expect(await menuTitles()).toEqual(["Sort: default", "Sort: by date", "Sort: by priority", "Show completed"]);
		await browser.keys("Escape");
		await browser.waitUntil(async () => (await menuTitles()).length === 0);
	});

	it("groups Inbox by priority, date, tag and section, and Today by list", async function () {
		const today = await appToday();
		const study = await createCategory("Study");
		await createTask("Urgent", { priority: 1, tagKeys: [] });
		await createTask("Whenever", { priority: 3 });
		await createTask("Late", { scheduled: { kind: "date", date: plusDays(today, -2) } });
		await createTask("Soon", { scheduled: { kind: "date", date: plusDays(today, 2) } });
		await createTask("Study today", { categoryId: study, scheduled: { kind: "date", date: today } });
		await createTask("Inbox today", { scheduled: { kind: "date", date: today } });
		const section = await openView("Inbox");
		// The default is a plain list.
		await waitForKeys(section, ["all"]);

		await setGroupBy("Priority");
		await waitForKeys(section, ["priority:1", "priority:3", "priority:0"]);

		await setGroupBy("Date");
		await waitForKeys(section, [plusDays(today, -2), today, plusDays(today, 2), "nodate"]);
		// A past date has its own red heading with a small "overdue" label.
		const past = section.$(`.cp-task-list [data-group-key="${plusDays(today, -2)}"]`);
		const label = past.$(".cp-group-overdue");
		await expect(label).toHaveText("overdue");
		const colors = await browser.execute((el) => {
			const heading = (el as unknown as HTMLElement).querySelector<HTMLElement>(".cp-group-heading")!;
			const normal = document.querySelector<HTMLElement>('.cp-task-list [data-group-key="nodate"] .cp-group-heading');
			return { heading: getComputedStyle(heading).color, normal: normal === null ? "" : getComputedStyle(normal).color };
		}, await past.getElement());
		expect(colors.heading).not.toBe(colors.normal);

		await setGroupBy("Tag");
		await waitForKeys(section, ["notag"]);

		await setGroupBy("Section");
		// No sections yet: a plain list stays until the list has a section.
		await waitForKeys(section, ["section:none"]);

		await showSidebarView(section, "Today");
		await setGroupBy("List");
		await browser.waitUntil(async () => (await groupKeys(section)).length === 2, { timeout: 5000, timeoutMsg: "Today is not grouped by list" });
		expect((await groupKeys(section))[0]).toMatch(/^list:/);
		await setGroupBy("None");
		await waitForKeys(section, ["all"]);
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

	it("Add section in the view menu switches Group by to Section and focuses the name field", async function () {
		const study = await createCategory("Study");
		await createTask("In Study", { categoryId: study });
		const section = await openView("Study");
		await waitForKeys(section, ["all"]);
		await openViewMenu(".cp-tasks");
		await pickMenuItem("Add section");
		const input = section.$(".cp-section-add-field.is-list .cp-section-name-input");
		await input.waitForExist({ timeout: 5000, timeoutMsg: "the name field did not open" });
		await browser.waitUntil(async () => (await browser.execute(() => document.activeElement?.classList.contains("cp-section-name-input") ?? false)) === true, {
			timeout: 5000,
			timeoutMsg: "the name field is not focused after the menu pick",
		});
		await input.setValue("Week 1");
		await browser.keys("Enter");
		await browser.waitUntil(async () => (await sectionsOf(study)).map((s) => s.name).join() === "Week 1", { timeout: 5000, timeoutMsg: "the section was not created" });
		await browser.waitUntil(async () => (await groupKeys(section)).length === 2, { timeout: 5000, timeoutMsg: "the section headings are not shown" });
		expect((await groupKeys(section))[0]).toBe("section:none");
		// The choice is remembered: the Group by menu has Section checked.
		await openViewMenu(".cp-tasks");
		await pickMenuItem("Group by…");
		await browser.waitUntil(async () => (await menuTitles()).includes("Section"), { timeout: 5000 });
		const isChecked = (title: string) =>
			browser.execute(
				(t) => Array.from(document.querySelectorAll<HTMLElement>(".menu .menu-item")).find((e) => e.querySelector(".menu-item-title")?.textContent === t)?.querySelector(".menu-item-icon svg") != null,
				title,
			);
		expect(await isChecked("Section")).toBe(true);
		expect(await isChecked("None")).toBe(false);
		await browser.keys("Escape");
	});
});
