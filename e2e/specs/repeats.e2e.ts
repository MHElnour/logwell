// Repeating tasks in the real app.
// Menus need DOM menus (useDomMenus), and notices and the picker need real timing.
//
// Series are seeded through the app services where the UI is not the point. Every DOM read is scoped to the
// visible Tasks section or Calendar (background tabs keep hidden copies). Menus are Obsidian Menus, native on
// macOS by default, so the whole run asks for DOM menus. Clicks that a floating notice could cover use the DOM.
//
// Time: the plugin's clock is one shared object (`session.app.clock`); specs that need another day patch it
// with an offset (shiftClock) and put it back in `afterEach`. The drag uses the real pointer: keep the mouse
// off the Obsidian window while this runs.
import { readFileSync } from "node:fs";
import { browser, expect } from "@wdio/globals";
import {
	allTasks,
	appToday,
	centerOf,
	clickModalButton,
	clickRowCheckbox,
	clickUndoNotice,
	closeOpenModals,
	closeQuickAdd,
	createRepeating,
	createTask,
	DAILY_RULE,
	domClick,
	dragPointer,
	flush,
	freshDatabase,
	getTask,
	menuTitles,
	occurrenceRecords,
	openQuickAdd,
	openTaskContextMenu,
	pickMenuItem,
	plusDays,
	railButton,
	restoreClock,
	restoreMenus,
	shiftClock,
	showInbox,
	showSidebarView,
	undoLabel,
	useDomMenus,
	visibleCalendar,
	visibleTasksSection,
	waitForNotice,
	waitForStableRect,
	WEEKLY_RULE,
} from "../helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

const SCHEMA_V3 = readFileSync(new URL("../../tests/fixtures/schema-v3.cpbase", import.meta.url), "utf8");

interface Rule {
	freq: string;
	interval: number;
	weekdays: string[] | null;
	monthly: unknown;
	afterCompletion: boolean;
}
interface Recurrence {
	anchor: string;
	versions: { effectiveFrom: string; rule: Rule }[];
	end: { kind: string };
	endedAt: string | null;
}
const recurrenceOf = async (id: string): Promise<Recurrence | null> => ((await getTask(id))?.recurrence ?? null) as Recurrence | null;

const row = (section: WebdriverIO.Element, id: string) => section.$(`.cp-task-row[data-task-id="${id}"]:not([data-occurrence])`);

/** The date text of a list row ("Today", "Tomorrow", "Fri, Oct 9"). */
async function rowDate(section: WebdriverIO.Element, id: string): Promise<string> {
	return row(section, id).$(".cp-meta-date").getText();
}

/** Opens the details pane of a task from the Inbox and shows its fields (the date chip toggles them). */
async function openDetails(section: WebdriverIO.Element, id: string): Promise<WebdriverIO.Element> {
	await showInbox(section);
	await domClick(row(section, id));
	const pane = section.$(".cp-details");
	await pane.waitForExist({ timeout: 5000, timeoutMsg: "the details pane did not open" });
	if (!(await pane.$(".cp-details-fields").isExisting())) await domClick(pane.$(".cp-due-chip"));
	await pane.$(".cp-repeat-field").waitForExist({ timeout: 5000, timeoutMsg: "no Repeat field" });
	return pane.getElement();
}

/** Clicks the Completed group's toggle when it is collapsed, and waits for its rows. */
async function expandCompleted(section: WebdriverIO.Element): Promise<void> {
	const toggle = section.$(".cp-completed-toggle");
	await toggle.waitForExist({ timeout: 8000, timeoutMsg: "no Completed group" });
	if ((await toggle.getAttribute("aria-expanded")) !== "true") await domClick(toggle);
}

describe("Recurrence", function () {
	let wasNative: boolean | undefined;

	before(async function () {
		wasNative = await useDomMenus();
	});

	after(async function () {
		await restoreMenus(wasNative);
	});

	beforeEach(async function () {
		await freshDatabase();
	});

	afterEach(async function () {
		await closeOpenModals();
		await closeQuickAdd();
		await restoreClock();
	});

	it("Quick Add 'Water plants every day' shows a repeat chip and saves a repeating task whose row has the chip (REC-07, D8)", async function () {
		const modal = await openQuickAdd();
		await modal.$(".cp-quick-add-title").setValue("Water plants every day");
		const chip = modal.$('.cp-qa-chip[data-kind="recurrence"]');
		await chip.waitForExist({ timeout: 5000, timeoutMsg: "no repeat chip" });
		await expect(chip).toHaveAttribute("data-status", "applied");
		await expect(chip).toHaveText(expect.stringContaining("Repeat: every day"));
		await browser.keys("Enter");
		await browser.waitUntil(async () => !(await browser.$(".checkpoint-quick-add-modal").isExisting()), { timeout: 5000, timeoutMsg: "Quick Add did not close" });
		const [task] = await allTasks();
		expect(task!.title).toBe("Water plants");
		expect(task!.scheduled).toBeNull();
		const rec = (await recurrenceOf(task!.id as string))!;
		expect(rec.versions).toHaveLength(1);
		expect(rec.versions[0]!.rule).toMatchObject({ freq: "daily", interval: 1 });
		expect(rec.anchor).toBe(await appToday());

		const section = await visibleTasksSection();
		await showInbox(section);
		const chipInRow = row(section, task!.id as string).$(".cp-meta-repeat");
		await chipInRow.waitForExist({ timeout: 5000, timeoutMsg: "no repeat chip in the row" });
		await expect(chipInRow.$(".cp-meta-repeat-text")).toHaveText("every day");
		await expect(row(section, task!.id as string).$(".cp-meta-date")).toHaveText("Today");
	});

	it("the date popover's Repeat row picks a preset and the pill saves it (D9)", async function () {
		const modal = await openQuickAdd();
		await modal.$(".cp-quick-add-title").setValue("Pay rent");
		await domClick(modal.$('.cp-qa-tool[data-tool="date"]'));
		await domClick(modal.$('.cp-pop-row[data-row="repeat"]'));
		const options = modal.$('.cp-date-pop [role="listbox"]');
		await options.waitForExist({ timeout: 5000, timeoutMsg: "the presets did not open" });
		await expect(options.$$('[role="option"]')).toBeElementsArrayOfSize(7);
		await domClick(options.$('[data-preset="monthly"]'));
		await expect(modal.$('.cp-qa-manual[data-kind="recurrence"] .cp-qa-manual-label')).toHaveText(expect.stringContaining("Repeat: monthly on the"));
		await domClick(modal.$(".cp-pop-ok"));
		// Closing the popover puts focus on its tool button: Enter there would open it again. Save from the title.
		await modal.$(".cp-quick-add-title").click();
		await browser.keys("Enter");
		await browser.waitUntil(async () => !(await browser.$(".checkpoint-quick-add-modal").isExisting()), { timeout: 5000, timeoutMsg: "Quick Add did not close" });
		const [task] = await allTasks();
		expect((await recurrenceOf(task!.id as string))!.versions[0]!.rule).toMatchObject({ freq: "monthly", interval: 1 });
	});

	it("completing from Today moves the series to its next date, with the Undo notice and its label (REC-02, D4)", async function () {
		const today = await appToday();
		const id = await createRepeating("Stretch", DAILY_RULE, { scheduled: { kind: "date", date: today } });
		const section = await visibleTasksSection();
		await showSidebarView(section, "Today");
		await row(section, id).waitForExist({ timeout: 5000, timeoutMsg: "the series is not in Today" });
		await clickRowCheckbox(section, id);
		const notice = await waitForNotice('Completed "Stretch"');
		expect(notice).toContain('Completed "Stretch" for Today.');
		expect(await undoLabel()).toBe("Complete occurrence");
		expect(await occurrenceRecords(id)).toEqual([{ date: today, status: "done", auto: false }]);
		// It left Today (its next date is tomorrow) but did not complete: the series stays open with tomorrow's date.
		await row(section, id).waitForExist({ reverse: true, timeout: 5000, timeoutMsg: "the series stayed in Today" });
		await showInbox(section);
		await expect(row(section, id).$(".cp-meta-date")).toHaveText("Tomorrow");
		expect((await getTask(id))!.status).toBe("open");

		await clickUndoNotice();
		await browser.waitUntil(async () => (await occurrenceRecords(id)).length === 0, { timeout: 5000, timeoutMsg: "Undo did not remove the record" });
		await expect(row(section, id).$(".cp-meta-date")).toHaveText("Today");
	});

	it("an overdue series completes one date and skips the others automatically (REC-03, B20)", async function () {
		const today = await appToday();
		const id = await createRepeating("Overdue chore", DAILY_RULE, { scheduled: { kind: "date", date: today } });
		// Five days later: today, +1 .. +4 are past, +5 is today.
		await shiftClock(5 * 86400);
		const section = await visibleTasksSection();
		// The app reads the clock when it renders: switching view renders it.
		await showSidebarView(section, "Upcoming");
		await showInbox(section);
		await row(section, id).waitForExist({ timeout: 5000 });
		await browser.waitUntil(async () => (await rowDate(section, id)) !== "Today", { timeout: 5000, timeoutMsg: "the row did not see the shifted clock" });
		await clickRowCheckbox(section, id);
		const notice = await waitForNotice('Completed "Overdue chore"');
		expect(notice).toContain("4 earlier dates skipped");
		const records = await occurrenceRecords(id);
		expect(records.filter((r) => r.status === "done")).toEqual([{ date: today, status: "done", auto: false }]);
		expect(records.filter((r) => r.status === "skipped")).toHaveLength(4);
		expect(records.filter((r) => r.status === "skipped").every((r) => r.auto)).toBe(true);
		await expect(row(section, id).$(".cp-meta-date")).toHaveText("Today");
	});

	it("Skip this occurrence from the row menu writes a skipped record and advances (REC-04)", async function () {
		const today = await appToday();
		const id = await createRepeating("Gym", DAILY_RULE, { scheduled: { kind: "date", date: today } });
		const section = await visibleTasksSection();
		await showInbox(section);
		await row(section, id).waitForExist({ timeout: 5000 });
		await openTaskContextMenu(section, id);
		const titles = await menuTitles();
		const at = titles.indexOf("Complete");
		expect(titles.slice(at, at + 4)).toEqual(["Complete", "Skip this occurrence", "Edit repeat…", "Stop repeating"]);
		await pickMenuItem("Skip this occurrence");
		await waitForNotice(`Skipped "Gym"`);
		expect(await occurrenceRecords(id)).toEqual([{ date: today, status: "skipped", auto: false }]);
		expect(await undoLabel()).toBe("Skip occurrence");
		await expect(row(section, id).$(".cp-meta-date")).toHaveText("Tomorrow");
	});

	it("Edit repeat… opens the details picker; weekly Monday, Wednesday and Friday is a new version from today (REC-06, B22)", async function () {
		const today = await appToday();
		const start = plusDays(today, -7);
		const id = await createRepeating("Standup", WEEKLY_RULE, { scheduled: { kind: "date", date: start } });
		const section = await visibleTasksSection();
		await showInbox(section);
		await row(section, id).waitForExist({ timeout: 5000 });
		await openTaskContextMenu(section, id);
		await pickMenuItem("Edit repeat…");
		const picker = section.$(".cp-details .cp-repeat-pop");
		await picker.waitForExist({ timeout: 5000, timeoutMsg: "Edit repeat… did not open the picker" });
		await domClick(picker.$('[data-preset="custom"]'));
		// The picker opens on the series' own weekday (the anchor's), so set exactly Mon, Wed and Fri.
		for (const d of ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]) {
			const day = picker.$(`.cp-repeat-day[data-day="${d}"]`);
			const pressed = (await day.getAttribute("aria-pressed")) === "true";
			if (pressed !== ["MO", "WE", "FR"].includes(d)) await domClick(day);
		}
		await expect(picker.$(".cp-repeat-summary")).toHaveText(expect.stringContaining("Monday, Wednesday, Friday"));
		await domClick(picker.$(".cp-repeat-done"));
		await waitForNotice(`"Standup" repeats every Mon, Wed, Fri.`);
		expect(await undoLabel()).toBe("Edit repeat");
		const rec = (await recurrenceOf(id))!;
		expect(rec.anchor).toBe(start);
		expect(rec.versions).toHaveLength(2);
		expect(rec.versions[0]).toMatchObject({ effectiveFrom: start, rule: { freq: "weekly", weekdays: null } });
		expect(rec.versions[1]).toMatchObject({ effectiveFrom: today, rule: { freq: "weekly", weekdays: ["MO", "WE", "FR"] } });
		await expect(section.$(".cp-details .cp-repeat-button")).toHaveText("every Mon, Wed, Fri");
		await expect(section.$(".cp-details .cp-due-chip")).toHaveText(expect.stringContaining("every Mon, Wed, Fri"));

		// Undo puts the earlier rule back.
		await clickUndoNotice();
		await browser.waitUntil(async () => (await recurrenceOf(id))?.versions.length === 1, { timeout: 5000, timeoutMsg: "Undo did not restore the rule" });
	});

	it("the details Repeat field: a deadline is cleared with a notice when a task starts repeating (decision 9)", async function () {
		const today = await appToday();
		const id = await createTask("Report", { scheduled: { kind: "date", date: today }, deadline: { kind: "date", date: plusDays(today, 3) } });
		const section = await visibleTasksSection();
		const pane = await openDetails(section, id);
		await domClick(pane.$(".cp-repeat-button"));
		await domClick(pane.$('.cp-repeat-pop [data-preset="weekly"]'));
		await waitForNotice("The deadline was cleared: a repeating task has no deadline.");
		expect((await getTask(id))!.deadline).toBeNull();
		await expect(pane.$('input[aria-label="Deadline date"]')).not.toExist();
	});

	it("Stop repeating asks first, then the series is a completed task and its history stays in Completed (decision 8, D7)", async function () {
		const today = await appToday();
		const id = await createRepeating("Weekly review", DAILY_RULE, { scheduled: { kind: "date", date: plusDays(today, 1) } });
		await browser.executeObsidian(async ({ plugins }, taskId) => {
			const rec = (plugins as any).logwell.session.app.recurrence;
			await rec.complete(taskId);
			await rec.complete(taskId);
		}, id);
		const section = await visibleTasksSection();
		await showInbox(section);
		await row(section, id).waitForExist({ timeout: 5000 });
		await openTaskContextMenu(section, id);
		await pickMenuItem("Stop repeating");
		await browser.$(".modal").waitForExist({ timeout: 5000, timeoutMsg: "no confirmation" });
		await expect(browser.$(".modal")).toHaveText(expect.stringContaining('Stop repeating "Weekly review"? Its history stays in Completed.'));
		await clickModalButton("Stop repeating");
		await waitForNotice('Stopped repeating "Weekly review".');
		expect(await undoLabel()).toBe("Stop repeating");
		const stopped = (await recurrenceOf(id))!;
		expect(stopped.endedAt).not.toBeNull();
		expect((await getTask(id))!.status).toBe("completed");
		// The two done dates are history rows of Completed.
		await expandCompleted(section);
		await browser.waitUntil(async () => (await section.$$(`.cp-task-row[data-task-id="${id}"][data-occurrence]`).length) === 2, {
			timeout: 8000,
			timeoutMsg: "the history rows did not show in Completed",
		});
		expect(await occurrenceRecords(id)).toHaveLength(2);
	});

	it("a Completed history row reopens its occurrence (B23)", async function () {
		const today = await appToday();
		const id = await createRepeating("Weekly review", DAILY_RULE, { scheduled: { kind: "date", date: today } });
		await browser.executeObsidian(async ({ plugins }, taskId) => {
			await (plugins as any).logwell.session.app.recurrence.complete(taskId);
		}, id);
		const section = await visibleTasksSection();
		await showInbox(section);
		await expandCompleted(section);
		const history = section.$(`.cp-task-row[data-task-id="${id}"][data-occurrence="${today}"]`);
		await history.waitForExist({ timeout: 8000, timeoutMsg: "no history row" });
		await expect(history.$(".cp-task-title")).toHaveText(expect.stringContaining("Weekly review ·"));
		await clickRowCheckbox(section, id, today);
		await waitForNotice(`Reopened "Weekly review"`);
		expect(await undoLabel()).toBe("Reopen occurrence");
		expect(await occurrenceRecords(id)).toEqual([]);
		await history.waitForExist({ reverse: true, timeout: 5000, timeoutMsg: "the history row stayed" });
		await expect(row(section, id).$(".cp-meta-date")).toHaveText("Today");
	});

	it("the calendar draws the current occurrence solid and the later ones faded and dashed, and refuses a drag (D6, decision 5)", async function () {
		const today = await appToday();
		const id = await createRepeating("Calendar series", DAILY_RULE, { scheduled: { kind: "date", date: today } });
		const calendar = await visibleCalendar();
		const entries = () =>
			browser.execute((taskId) => {
				const root = Array.from(document.querySelectorAll<HTMLElement>(".cp-calendar")).find((e) => e.offsetParent !== null);
				return Array.from(root?.querySelectorAll<HTMLElement>(`.cp-cal-entry[data-task-id="${taskId}"]`) ?? []).map((el) => ({
					date: el.closest("[data-date]")?.getAttribute("data-date") ?? "",
					classes: el.className,
					name: el.querySelector(".cp-sr-only")?.textContent ?? "",
					icon: el.querySelector(".cp-cal-repeat") !== null,
				}));
			}, id);
		await browser.waitUntil(async () => (await entries()).some((e) => e.date === today), { timeout: 6000, timeoutMsg: "no entry for today" });
		const current = (await entries()).find((e) => e.date === today)!;
		expect(current.classes).not.toContain("is-future");
		expect(current.classes).toContain("is-repeat");
		expect(current.icon).toBe(true);
		expect(current.name).toContain("repeats");
		for (const e of (await entries()).filter((x) => x.date > today)) {
			expect(e.classes).toContain("is-future");
			expect(e.name).toContain("future occurrence");
		}

		// Next week: every entry is a future occurrence.
		await domClick(calendar.$('[aria-label="Next week"]'));
		await browser.waitUntil(async () => (await entries()).length > 0 && (await entries()).every((e) => e.date > today), { timeout: 6000, timeoutMsg: "next week's entries did not render" });
		const future = (await entries())[0]!;
		const target = (await entries())[1]!;
		expect(future.classes).toContain("is-future");
		expect(target.date).not.toBe(future.date);

		// A drag from one future entry to another day changes nothing and starts no drag.
		const before = await recurrenceOf(id);
		const grab = calendar.$(`.cp-cal-allday-cell[data-date="${future.date}"] .cp-cal-entry[data-task-id="${id}"]`);
		const drop = calendar.$(`.cp-cal-allday-cell[data-date="${target.date}"]`);
		await waitForStableRect(grab);
		await dragPointer(
			() => centerOf(grab),
			() => centerOf(drop),
		);
		await browser.pause(300);
		await expect(calendar.$(".cp-cal-ghost")).not.toExist();
		expect(await recurrenceOf(id)).toEqual(before);
		expect((await getTask(id))!.scheduled).toBeNull();
	});

	it("Data > Export CSV writes eight files into a new vault folder (EXP-02, D11)", async function () {
		await createRepeating("Export me", DAILY_RULE);
		await railButton("Data").then((b) => domClick(b));
		const data = await browser.$$(".cp-data").filter((el) => el.isDisplayed());
		const button = data[0]!.$("button=Export CSV");
		await button.waitForExist({ timeout: 5000, timeoutMsg: "no Export CSV button" });
		await domClick(button);
		const notice = await waitForNotice("Exported 8 files to Logwell export");
		const folder = notice.slice(notice.indexOf("to ") + 3).trim();
		const files = await browser.executeObsidian(({ app }, path) => {
			const f = app.vault.getFolderByPath(path);
			return f === null ? [] : f.children.map((c) => c.name).sort();
		}, folder);
		expect(files).toEqual(["check-ins.csv", "focus-sessions.csv", "habits.csv", "lists.csv", "occurrences.csv", "sections.csv", "tags.csv", "tasks.csv"]);
		const tasksCsv = await browser.executeObsidian(async ({ app }, path) => app.vault.adapter.read(`${path}/tasks.csv`), folder);
		expect(tasksCsv.startsWith("\uFEFF")).toBe(true);
		expect(tasksCsv).toContain("Export me");
	});

	it("a v3 database migrates once with the notice and a snapshot, and a repeating task made there survives a reload (D1)", async function () {
		const path = "SchemaV3.cpbase";
		const text = SCHEMA_V3.replace(/"dbId":"[^"]+"/, `"dbId":"${crypto.randomUUID()}"`);
		await browser.execute(() => document.querySelectorAll(".notice").forEach((n) => n.remove()));
		const open = (p: string, content: string) =>
			browser.executeObsidian(
				async ({ app, plugins }, dbPath, body) => {
					const plugin = (plugins as any).logwell;
					await plugin.setActiveDatabase("");
					const existing = app.vault.getFileByPath(dbPath);
					if (existing === null) await app.vault.create(dbPath, body);
					else await app.vault.process(existing, () => body);
					await plugin.setActiveDatabase(dbPath);
					await plugin.ready();
				},
				p,
				content,
			);
		await open(path, text);
		await browser.waitUntil(
			async () => (await browser.execute(() => Array.from(document.querySelectorAll(".notice")).filter((n) => (n.textContent ?? "").includes("upgraded from schema 3 to 6")).length)) >= 1,
			{ timeout: 10000, timeoutMsg: "no migration notice" },
		);
		await flush();
		expect(await browser.execute(() => Array.from(document.querySelectorAll(".notice")).filter((n) => (n.textContent ?? "").includes("upgraded from schema 3 to 6")).length)).toBe(1);
		const kinds = await browser.executeObsidian(async ({ plugins }) => {
			const list = (await (plugins as any).logwell.session.store.listSnapshots()) as { kind: string }[];
			return list.map((s) => s.kind);
		});
		expect(kinds.filter((k) => k === "pre-migration")).toHaveLength(1);
		const onDisk = JSON.parse(await browser.executeObsidian(async ({ app }, p) => app.vault.adapter.read(p), path));
		expect(onDisk.schemaVersion).toBe(6);
		for (const t of onDisk.tasks) expect(t.recurrence ?? null).toBeNull();

		// A series made in the migrated database is saved and survives the plugin being reloaded.
		const today = await appToday();
		const id = await createRepeating("After upgrade", WEEKLY_RULE, { scheduled: { kind: "date", date: today } });
		await flush();
		await browser.executeObsidian(async ({ app }) => {
			await (app as any).plugins.disablePlugin("logwell");
			await (app as any).plugins.enablePlugin("logwell");
		});
		await browser.executeObsidian(async ({ plugins }) => {
			await (plugins as any).logwell.ready();
		});
		const rec = (await recurrenceOf(id))!;
		expect(rec.anchor).toBe(today);
		expect(rec.versions[0]!.rule).toMatchObject({ freq: "weekly", interval: 1 });
		const stored = JSON.parse(await browser.executeObsidian(async ({ app }, p) => app.vault.adapter.read(p), path));
		expect(stored.tasks.find((t: { id: string }) => t.id === id).recurrence.anchor).toBe(today);
		// The plain tasks of the v3 file are untouched by the reload.
		expect((await allTasks()).length).toBe(onDisk.tasks.length + 1);
	});
});
