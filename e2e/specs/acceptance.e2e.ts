// The acceptance suite: every acceptance scenario, end to end.
// NOT RUN: written in a cloud session (it cannot open Obsidian). Expect first-run fixes locally.
//
// ONE vault, ONE database: `freshDatabase()` runs once in `before`, so the scenarios run in order on the state
// the earlier ones left, ("the full acceptance suite passes in one test vault"). Each `it` is one
// scenario and finds its own tasks by ID, never "the only task", and starts from whatever view is on screen:
// it opens the section it needs, and `afterEach` closes modals, menus and Quick Add and puts the clock back.
//
// The steps are those of the specs that cover each scenario on its own: notes.e2e.ts (tasks, notes, subtasks),
// quick-add.e2e.ts (Quick Add), m3-calendar.e2e.ts (complete and reschedule), m6-habits.e2e.ts (habits),
// m5-focus.e2e.ts (focus recovery) and m4-matrix.e2e.ts (matrix drag), plus a recurring part (a weekly series completed
// three times, then edited, keeps its three done rows). Keep the mouse off the Obsidian window during the matrix drag.
import { browser, expect } from "@wdio/globals";
import {
	allTasks,
	appToday,
	appZone,
	categoryCount,
	centerOf,
	clickModalButton,
	closeNotices,
	clickRowCheckbox,
	closeLeftoverMenus,
	closeOpenModals,
	closeQuickAdd,
	createHabit,
	createRepeating,
	createTask,
	DB_PATH,
	domClick,
	dragPointer,
	flush,
	freshDatabase,
	getHabit,
	getTask,
	habitCheckins,
	habitRow,
	markdownCount,
	openQuickAdd,
	plusDays,
	readVaultFile,
	restoreClock,
	restoreMenus,
	shiftClock,
	showInbox,
	showSidebarView,
	useDomMenus,
	visibleCalendar,
	visibleHabits,
	visibleMatrix,
	visibleTasksSection,
	waitForStableRect,
	WEEKLY_RULE,
} from "../helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

const byId = async (title: string): Promise<Record<string, unknown>[]> => (await allTasks()).filter((t) => t.title === title);

/** After a Quick Add save: the modal has closed. */
async function modalClosed(): Promise<void> {
	await browser.waitUntil(async () => !(await browser.$(".checkpoint-quick-add-modal").isExisting()), {
		timeout: 5000,
		timeoutMsg: "Quick Add did not close after saving",
	});
}

async function waitForTask(title: string): Promise<Record<string, unknown>> {
	let found: Record<string, unknown> | undefined;
	await browser.waitUntil(
		async () => {
			found = (await byId(title))[0];
			return found !== undefined;
		},
		{ timeout: 5000, timeoutMsg: `no task "${title}" was saved` },
	);
	return found!;
}

/** Opens the app on Inbox, clicks the task's row, and returns the visible Tasks section (notes.e2e.ts). */
async function openTaskDetails(id: string): Promise<WebdriverIO.Element> {
	const section = await visibleTasksSection();
	await showInbox(section);
	const row = section.$(`.cp-task-row[data-task-id="${id}"]:not([data-occurrence])`);
	await row.waitForExist({ timeout: 5000 });
	await domClick(row);
	await section.$(".cp-details").waitForExist({ timeout: 5000 });
	return section;
}

// -- calendar helpers (m3-calendar.e2e.ts) -----------------------------------------------------------------

async function entriesOf(taskId: string): Promise<number> {
	return browser.execute((id) => {
		const root = Array.from(document.querySelectorAll<HTMLElement>(".cp-calendar")).find((e) => e.offsetParent !== null);
		return root?.querySelectorAll(`.cp-cal-entry[data-task-id="${id}"]`).length ?? 0;
	}, taskId);
}

async function clickInCalendar(selector: string): Promise<void> {
	const found = await browser.execute((sel) => {
		const root = Array.from(document.querySelectorAll<HTMLElement>(".cp-calendar")).find((e) => e.offsetParent !== null);
		const el = root?.querySelector<HTMLElement>(sel);
		if (el === null || el === undefined) return false;
		el.click();
		return true;
	}, selector);
	if (!found) throw new Error(`no ${selector} in the visible calendar`);
}

/** Sets an input of the calendar's details pane the way typing would, and fires the events the form listens to. */
async function setDetailsInput(label: string, value: string): Promise<void> {
	const found = await browser.execute(
		(l, v) => {
			const root = Array.from(document.querySelectorAll<HTMLElement>(".cp-calendar")).find((e) => e.offsetParent !== null);
			const input = root?.querySelector<HTMLInputElement>(`.cp-details-pane input[aria-label="${l}"]`);
			if (input === null || input === undefined) return false;
			input.value = v;
			input.dispatchEvent(new Event("input", { bubbles: true }));
			input.dispatchEvent(new Event("change", { bubbles: true }));
			return true;
		},
		label,
		value,
	);
	if (!found) throw new Error(`no details input "${label}"`);
}

// -- matrix helpers (m4-matrix.e2e.ts) ---------------------------------------------------------------------

async function quadrantOfCard(id: string): Promise<string> {
	return browser.execute((taskId) => {
		const root = Array.from(document.querySelectorAll<HTMLElement>(".cp-matrix")).find((e) => e.offsetParent !== null);
		return root?.querySelector<HTMLElement>(`.cp-task-row[data-task-id="${taskId}"]`)?.closest<HTMLElement>(".cp-matrix-q")?.dataset.quadrant ?? "";
	}, id);
}

// -- focus helpers (m5-focus.e2e.ts) -----------------------------------------------------------------------

async function visibleFocus(): Promise<WebdriverIO.Element> {
	await browser.executeObsidian(async ({ plugins }) => {
		await (plugins as any).logwell.openApp("focus");
	});
	let found: WebdriverIO.Element | undefined;
	await browser.waitUntil(
		async () => {
			found = undefined;
			for (const el of await browser.$$(".cp-focus")) if (await el.isDisplayed()) found = el;
			return found !== undefined;
		},
		{ timeout: 5000, timeoutMsg: "no visible Focus section" },
	);
	return found!;
}

async function focusRecords(): Promise<{ taskId: string | null; status: string; focusedSec: number; gaps: string[] }[]> {
	return browser.executeObsidian(({ plugins }) => {
		const app = (plugins as any).logwell.session.app;
		const out = [...app.store.state.focusSessions.values()].map((s: any) => ({
			taskId: s.taskId as string | null,
			status: s.status as string,
			focusedSec: Math.round(
				(s.segments.reduce((sum: number, g: any) => sum + Date.parse(g.end) - Date.parse(g.start), 0) +
					s.unobserved.filter((g: any) => g.resolution === "included").reduce((sum: number, g: any) => sum + Date.parse(g.end) - Date.parse(g.start), 0)) /
					1000,
			),
			gaps: s.unobserved.map((g: any) => g.resolution as string),
			startedAt: s.startedAt as string,
		}));
		out.sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1));
		return out;
	});
}

async function timerState(): Promise<{ needsRecovery: boolean } | null> {
	return browser.executeObsidian(({ plugins }) => {
		const t = (plugins as any).logwell.session.app.focus.timer();
		return t === null ? null : { needsRecovery: t.needsRecovery as boolean };
	});
}

/** Ends any running focus, so a failed scenario does not leave a timer for the next one. */
async function stopFocus(): Promise<void> {
	await browser.executeObsidian(async ({ plugins }) => {
		const app = (plugins as any).logwell?.session?.app;
		if (app === undefined || app.focus.timer() === null) return;
		if (app.focus.timer().needsRecovery) await app.focus.resolveRecovery("discard");
		else await app.focus.stop();
	});
}

// -- habit helpers (m6-habits.e2e.ts) ----------------------------------------------------------------------

const QUANTITY = { type: "quantity", target: 30, unit: "min", period: "day" } as const;

async function setModalInput(selector: string, value: string): Promise<void> {
	await browser.execute(
		(sel, v) => {
			const input = document.querySelector<HTMLInputElement>(`.modal ${sel}`);
			if (input === null) throw new Error(`no modal input ${sel}`);
			input.value = v;
			input.dispatchEvent(new Event("input", { bubbles: true }));
			input.dispatchEvent(new Event("change", { bubbles: true }));
		},
		selector,
		value,
	);
}

async function addAmount(row: ChainablePromiseElement, value: string): Promise<void> {
	await row.$(".cp-habit-amount input").setValue(value);
	await row.$(".cp-habit-add").click();
}

describe("Acceptance suite AS-01 to AS-13, in one vault", function () {
	let wasNative: boolean | undefined;

	before(async function () {
		wasNative = await useDomMenus();
		await freshDatabase();
	});

	after(async function () {
		await restoreMenus(wasNative);
	});

	afterEach(async function () {
		await closeOpenModals();
		await closeQuickAdd();
		await closeLeftoverMenus();
		await restoreClock();
		await stopFocus();
		await browser.execute(() => document.querySelectorAll(".notice").forEach((n) => n.remove()));
	});

	// -- Tasks and description notes ---------------------------------------------------------------------

	it("AS-01: Quick Add 'Buy milk' creates one Inbox task and no note", async function () {
		const notesBefore = await markdownCount();
		const tasksBefore = (await allTasks()).length;
		await browser.executeObsidianCommand("logwell:quick-add-task");
		const input = browser.$(".cp-quick-add-title");
		await input.waitForExist({ timeout: 5000 });
		await input.setValue("Buy milk");
		await browser.keys("Enter");
		await modalClosed();
		await flush();
		const milk = await waitForTask("Buy milk");
		expect(milk.categoryId).toBe("inbox");
		expect(milk.descriptionNote).toBeNull();
		expect((await allTasks()).length).toBe(tasksBefore + 1);
		expect(await markdownCount()).toBe(notesBefore);
		expect(await readVaultFile(DB_PATH)).toMatch(/"title":"Buy milk"[^\n]*"categoryId":"inbox"/);
	});

	it("AS-02 and AS-03: a linked note renders, is not copied, and updates live without touching the database file", async function () {
		const id = await createTask("AS-02 plan the integration");
		await browser.executeObsidian(async ({ plugins }, taskId) => {
			await (plugins as any).logwell.session.app.tasks.linkNote(taskId, "Plan.md");
		}, id);
		await flush();
		const db = await readVaultFile(DB_PATH);
		expect(db).toContain('"path":"Plan.md"');
		expect(db).not.toContain("Research and plan the integration");

		const section = await openTaskDetails(id);
		const preview = section.$(".cp-note-preview");
		await expect(preview).toHaveText(expect.stringContaining("Research and plan the integration"));

		const dbBefore = await readVaultFile(DB_PATH);
		await browser.executeObsidian(async ({ app }) => {
			const file = app.vault.getFileByPath("Plan.md");
			if (file === null) throw new Error("missing note");
			await app.vault.process(file, (t) => t.replace("Research and plan", "Edited live:"));
		});
		await browser.waitUntil(async () => (await preview.getText()).includes("Edited live:"), {
			timeout: 3000,
			timeoutMsg: "details did not update within 3 s",
		});
		expect(await readVaultFile(DB_PATH)).toBe(dbBefore);
		// Put the note back, so the purge scenario compares against the text it started with.
		await browser.executeObsidian(async ({ app }) => {
			const file = app.vault.getFileByPath("Plan.md");
			if (file === null) throw new Error("missing note");
			await app.vault.process(file, (t) => t.replace("Edited live:", "Research and plan"));
		});
	});

	it("AS-04: renaming the task and then the note keeps the ID and the reference follows", async function () {
		const id = await createTask("AS-04 original");
		await browser.executeObsidian(async ({ plugins }, taskId) => {
			const tasks = (plugins as any).logwell.session.app.tasks;
			await tasks.linkNote(taskId, "Projects/Plan.md");
			await tasks.update(taskId, { title: "AS-04 renamed task" });
		}, id);
		await browser.executeObsidian(async ({ app }) => {
			const file = app.vault.getFileByPath("Projects/Plan.md");
			if (file === null) throw new Error("missing note");
			await app.fileManager.renameFile(file, "Projects/Plan v2.md");
		});
		await browser.waitUntil(async () => ((await getTask(id))?.descriptionNote as { path?: string } | null)?.path === "Projects/Plan v2.md", {
			timeout: 5000,
			timeoutMsg: "the note path was not tracked through the rename",
		});
		const task = await getTask(id);
		expect(task?.id).toBe(id);
		expect(task?.title).toBe("AS-04 renamed task");
		const section = await openTaskDetails(id);
		await expect(section.$(".cp-description.is-linked")).toExist();
		await expect(section.$(".cp-note-name")).toHaveText("Plan v2");
	});

	it("AS-05: deleting the task and purging Trash leaves the note byte-identical", async function () {
		const original = await readVaultFile("Plan.md");
		const id = await createTask("AS-05 to delete");
		await browser.executeObsidian(async ({ plugins }, taskId) => {
			const tasks = (plugins as any).logwell.session.app.tasks;
			await tasks.linkNote(taskId, "Plan.md");
			await tasks.delete(taskId);
			await tasks.emptyTrash();
		}, id);
		await flush();
		expect(await getTask(id)).toBeNull();
		expect(await readVaultFile("Plan.md")).toBe(original);
	});

	it("AS-06: unlinking leaves the file; a deleted note leaves the other task usable with a missing state", async function () {
		const unlinked = await createTask("AS-06 unlink");
		const orphan = await createTask("AS-06 uses Other");
		const kept = await readVaultFile("Archive/Plan.md");
		await browser.executeObsidian(async ({ app, plugins }, a, b) => {
			const tasks = (plugins as any).logwell.session.app.tasks;
			await tasks.linkNote(a, "Archive/Plan.md");
			await tasks.unlinkNote(a);
			await tasks.linkNote(b, "Notes/Other.md");
			const file = app.vault.getFileByPath("Notes/Other.md");
			if (file === null) throw new Error("missing note");
			await app.vault.delete(file);
		}, unlinked, orphan);
		expect(((await getTask(unlinked))?.descriptionNote ?? null) === null).toBe(true);
		expect(await readVaultFile("Archive/Plan.md")).toBe(kept);
		const section = await openTaskDetails(orphan);
		await expect(section.$(".cp-description.is-missing")).toExist();
		await browser.executeObsidian(async ({ plugins }, taskId) => {
			await (plugins as any).logwell.session.app.tasks.complete(taskId);
		}, orphan);
		expect((await getTask(orphan))?.status).toBe("completed");
	});

	// -- Natural-language Quick Add --------------------------------------------------------------------------

	it("AS-07: dismissing the date chip keeps 'Call mom tomorrow' and no schedule", async function () {
		const modal = await openQuickAdd();
		await modal.$(".cp-quick-add-title").setValue("Call mom tomorrow");
		const chip = modal.$('.cp-qa-chip[data-kind="scheduled"]');
		await chip.waitForExist({ timeout: 5000 });
		await expect(modal.$(".cp-qa-mirror mark.cp-qa-span")).toHaveText("tomorrow");
		await chip.$(".cp-qa-chip-remove").click();
		await expect(chip).not.toExist();
		await browser.keys("Enter");
		await modalClosed();
		const task = await waitForTask("Call mom tomorrow");
		expect(task.scheduled).toBeNull();
	});

	it("AS-08: '#Hobbies' without that category blocks Enter, then Inbox saves and no category is created", async function () {
		const before = await categoryCount();
		const modal = await openQuickAdd();
		await modal.$(".cp-quick-add-title").setValue("Read #Hobbies");
		await modal.$('.cp-qa-chip[data-kind="category"]').waitForExist({ timeout: 5000 });
		await browser.keys("Enter");
		const select = modal.$(".cp-qa-panel select");
		await select.waitForExist({ timeout: 5000 });
		await expect(select).toBeFocused();
		expect(await select.getValue()).toBe("inbox");
		expect(await byId("Read")).toHaveLength(0);
		await browser.keys("Enter");
		await modalClosed();
		const task = await waitForTask("Read");
		expect(task.categoryId).toBe("inbox");
		expect(await categoryCount()).toBe(before);
	});

	// -- Subtasks ------------------------------------------------------------------------------------------------

	it("AS-09: the subtask rules: the parent prompts, completing the subtasks leaves it open, reopening it leaves them done, a move takes them along", async function () {
		const result = await browser.executeObsidian(async ({ plugins }) => {
			const app = (plugins as any).logwell.session.app;
			const study = await app.categories.create("AS-09 study");
			const parent = (await app.tasks.create({ title: "AS-09 parent" })).task;
			const a = (await app.tasks.create({ title: "AS-09 sub A", parentId: parent.id })).task;
			const b = (await app.tasks.create({ title: "AS-09 sub B", parentId: parent.id })).task;
			const prompt = await app.tasks.complete(parent.id);
			await app.tasks.complete(a.id);
			await app.tasks.complete(b.id);
			const find = (id: string) => [...app.store.state.tasks.values()].find((t: { id: string }) => t.id === id);
			const parentAfterSubs = find(parent.id).status;
			await app.tasks.complete(parent.id);
			await app.tasks.reopen(parent.id);
			const subsAfterReopen = [find(a.id).status, find(b.id).status];
			await app.tasks.update(parent.id, { categoryId: study.id });
			return { prompt, parentAfterSubs, subsAfterReopen, categories: [find(a.id).categoryId, find(b.id).categoryId], studyId: study.id };
		});
		expect(result.prompt).toEqual({ kind: "needs-confirmation", openSubtasks: 2 });
		expect(result.parentAfterSubs).toBe("open");
		expect(result.subsAfterReopen).toEqual(["completed", "completed"]);
		expect(result.categories).toEqual([result.studyId, result.studyId]);
	});

	// -- Complete and reschedule -------------------------------------------------------------------------------

	it("AS-10: completing in Today, rescheduling in the calendar form and a weekly series completed three times then edited", async function () {
		const today = await appToday();
		const zone = await appZone();

		// Part 1: completing in Today removes the task from Today, the calendar and the matrix, and adds it to Completed.
		const done = await createTask("AS-10 complete me", { scheduled: { kind: "date", date: today } });
		const tasks = await visibleTasksSection();
		await showSidebarView(tasks, "Today");
		const todayRow = tasks.$(`.cp-task-row[data-task-id="${done}"]`);
		await todayRow.waitForExist({ timeout: 5000, timeoutMsg: "the task is not in Today" });
		await visibleCalendar();
		await browser.waitUntil(async () => (await entriesOf(done)) === 1, { timeout: 6000, timeoutMsg: "no calendar entry before completing" });
		await visibleMatrix();
		await browser.waitUntil(async () => (await quadrantOfCard(done)) !== "", { timeout: 6000, timeoutMsg: "no matrix card before completing" });
		const section = await visibleTasksSection();
		await showSidebarView(section, "Today");
		await clickRowCheckbox(section, done);
		await browser.waitUntil(async () => (await getTask(done))?.status === "completed", { timeout: 5000, timeoutMsg: "the task was not completed" });
		await todayRow.waitForExist({ reverse: true, timeout: 5000, timeoutMsg: "the completed task stayed in Today" });
		await visibleCalendar();
		await browser.waitUntil(async () => (await entriesOf(done)) === 0, { timeout: 6000, timeoutMsg: "the completed task stayed on the calendar" });
		await visibleMatrix();
		await browser.waitUntil(async () => (await quadrantOfCard(done)) === "", { timeout: 6000, timeoutMsg: "the completed task stayed in the matrix" });
		const completedView = await visibleTasksSection();
		await showSidebarView(completedView, "Completed");
		await completedView.$(`.cp-task-row[data-task-id="${done}"]`).waitForExist({ timeout: 5000, timeoutMsg: "the task is not in Completed" });

		// Part 2: rescheduling in the calendar form moves it in Upcoming and keeps the same ID.
		const moved = await createTask("AS-10 move me", { scheduled: { kind: "datetime", local: `${today}T19:00`, tz: zone }, plannedDurationMin: 45 });
		const newDay = plusDays(today, 2);
		await visibleCalendar();
		await browser.waitUntil(async () => (await entriesOf(moved)) === 1, { timeout: 6000, timeoutMsg: "no calendar entry to reschedule" });
		await clickInCalendar(`.cp-cal-entry[data-task-id="${moved}"]`);
		const calendar = await visibleCalendar();
		await calendar.$(".cp-details-pane .cp-due-chip").waitForExist({ timeout: 5000 });
		await calendar.$(".cp-details-pane .cp-due-chip").click();
		await calendar.$('.cp-details-pane input[aria-label="Scheduled date"]').waitForExist({ timeout: 5000 });
		await setDetailsInput("Scheduled date", newDay);
		await browser.waitUntil(async () => ((await getTask(moved))?.scheduled as { local?: string } | undefined)?.local === `${newDay}T19:00`, {
			timeout: 5000,
			timeoutMsg: "the new date was not saved",
		});
		expect((await getTask(moved))?.id).toBe(moved);
		const upcoming = await visibleTasksSection();
		await showSidebarView(upcoming, "Upcoming");
		const upcomingRow = upcoming.$(`.cp-task-row[data-task-id="${moved}"]`);
		await upcomingRow.waitForExist({ timeout: 5000, timeoutMsg: "the task is not in Upcoming" });
		const groupKey = await browser.execute((el) => (el as unknown as HTMLElement).closest<HTMLElement>("[data-group-key]")?.dataset.groupKey ?? "", await upcomingRow.getElement());
		expect(groupKey).toBe(newDay);

		// Part 3: a weekly series completed for 3 occurrences, then rule-edited, still shows its 3 done rows.
		const series = await createRepeating("AS-10 weekly series", WEEKLY_RULE, { scheduled: { kind: "date", date: today } });
		const completeOnce = () =>
			browser.executeObsidian(async ({ plugins }, id) => {
				await (plugins as any).logwell.session.app.recurrence.complete(id);
			}, series);
		await completeOnce();
		await shiftClock(7 * 86400);
		await completeOnce();
		await shiftClock(7 * 86400);
		await completeOnce();
		// The rule edit happens after the three completions, so the clock stays two weeks on until it is done.
		const dates = [today, plusDays(today, 7), plusDays(today, 14)];
		const recordsOf = () =>
			browser.executeObsidian(({ plugins }, id) => {
				const all = [...(plugins as any).logwell.session.app.store.state.occurrenceRecords.values()] as { taskId: string; occurrenceDate: string; status: string }[];
				return all.filter((r) => r.taskId === id).map((r) => `${r.occurrenceDate}:${r.status}`).sort();
			}, series);
		expect(await recordsOf()).toEqual(dates.map((d) => `${d}:done`));

		const inbox = await visibleTasksSection();
		await showInbox(inbox);
		const toggle = inbox.$(".cp-completed-toggle");
		await toggle.waitForExist({ timeout: 8000, timeoutMsg: "no Completed group" });
		if ((await toggle.getAttribute("aria-expanded")) !== "true") await domClick(toggle);
		const historyRows = () => inbox.$$(`.cp-task-row[data-task-id="${series}"][data-occurrence]`).length;
		await browser.waitUntil(async () => (await historyRows()) === 3, { timeout: 8000, timeoutMsg: "the three done rows did not show" });

		// Edit the rule (every weekday, from today) in the details pane; the past records stay.
		const pane = inbox.$(".cp-details");
		await domClick(inbox.$(`.cp-task-row[data-task-id="${series}"]:not([data-occurrence])`));
		await pane.waitForExist({ timeout: 5000 });
		if (!(await pane.$(".cp-details-fields").isExisting())) await domClick(pane.$(".cp-due-chip"));
		await domClick(pane.$(".cp-repeat-button"));
		await domClick(pane.$('.cp-repeat-pop [data-preset="weekday"]'));
		await browser.waitUntil(
			async () => ((await getTask(series))?.recurrence as { versions: unknown[] } | null)?.versions.length === 2,
			{ timeout: 5000, timeoutMsg: "the rule edit was not stored as a new version" },
		);
		expect(await recordsOf()).toEqual(dates.map((d) => `${d}:done`));
		expect(await historyRows()).toBe(3);
		await restoreClock();
	});

	// -- Habits ------------------------------------------------------------------------------------------------------

	it("AS-11: quantity 30 with check-ins of 20 and 10, the 10 corrected to 5: not met; the target changed to 20 from today keeps yesterday against 30", async function () {
		// Created yesterday, so yesterday is one of its days.
		await shiftClock(-86400);
		const id = await createHabit({ name: "AS-11 read", goal: QUANTITY });
		await shiftClock(86400);
		const habits = await visibleHabits();
		const today = await appToday();
		const yesterday = plusDays(today, -1);

		await habits.$$(".cp-habit-day")[5].click();
		await addAmount(habitRow(habits, "AS-11 read"), "20");
		await addAmount(habitRow(habits, "AS-11 read"), "10");
		await expect(habitRow(habits, "AS-11 read").$(".cp-habit-progress")).toHaveText("30 of 30 min");
		expect(await habitCheckins(id)).toEqual([
			{ date: yesterday, value: 20 },
			{ date: yesterday, value: 10 },
		]);

		// Correct the 10 to 5 in the log (newest first: the 10 is the first entry).
		const editCheckin = await habits.$$('.cp-habit-detail button[aria-label="Edit check-in"]')[0];
		await browser.execute((el: HTMLElement) => el.scrollIntoView({ block: "center" }), editCheckin as unknown as HTMLElement);
		await browser.pause(200);
		await editCheckin.click();
		await browser.$(".modal").waitForExist({ timeout: 5000, timeoutMsg: "the Edit check-in prompt did not open" });
		await setModalInput('input[type="text"]', "5");
		await clickModalButton("Save");
		await expect(habitRow(habits, "AS-11 read").$(".cp-habit-progress")).toHaveText("25 of 30 min");
		await expect(habitRow(habits, "AS-11 read")).not.toHaveElementClass("is-done");

		// The target changes to 20 from today; yesterday is still evaluated against 30.
		await closeNotices();
		await habits.$('.cp-habit-detail button[aria-label="Edit habit"]').click();
		await browser.$(".checkpoint-habit-dialog").waitForExist({ timeout: 5000 });
		await setModalInput(".cp-habit-target", "20");
		await clickModalButton("Save");
		await browser.$(".checkpoint-habit-dialog").waitForExist({ reverse: true, timeout: 5000 });
		const stored = (await getHabit(id)) as { versions: { effectiveFrom: string; goal: { target: number } }[] };
		expect(stored.versions.map((v) => [v.effectiveFrom, v.goal.target])).toEqual([
			[yesterday, 30],
			[today, 20],
		]);
		await expect(habitRow(habits, "AS-11 read").$(".cp-habit-progress")).toHaveText("25 of 30 min");
		await expect(habitRow(habits, "AS-11 read")).not.toHaveElementClass("is-done");
	});

	// -- Focus ---------------------------------------------------------------------------------------------------------

	it("AS-12: a focus recovered after a close shows one session with about 3 min focused and 10 min pending; a second reload adds none", async function () {
		const taskId = await createTask("AS-12 long job");
		await browser.executeObsidian(
			async ({ plugins }, id) => {
				const r = await (plugins as any).logwell.session.app.focus.start({ rounds: 1, focusSec: 1500, breakSec: 300, longBreakSec: 900 }, id);
				if (r.kind !== "started") throw new Error("focus did not start");
			},
			taskId,
		);
		const before = (await focusRecords()).length;
		// "Obsidian was closed": disable the plugin, age the stored timer by 13 minutes (3 focused, then 10 unobserved), enable it.
		await browser.executeObsidian(async ({ app, plugins }) => {
			const plugin = (plugins as any).logwell;
			const parse = plugin.session.app.focus.constructor.parseTimer as (raw: unknown) => unknown;
			const key = `logwell-active-timer-${plugin.session.store.data.meta.dbId}`;
			await (app as any).plugins.disablePlugin("logwell");
			const raw = (app as any).loadLocalStorage(key);
			const timer = typeof raw === "string" ? JSON.parse(raw) : raw;
			const shift = (iso: string, ms: number) => new Date(Date.parse(iso) - ms).toISOString();
			const aged = 13 * 60_000;
			timer.startedAt = shift(timer.startedAt, aged);
			timer.segments = timer.segments.map((s: any) => ({ start: shift(s.start, aged), end: s.end === null ? null : shift(s.end, aged) }));
			timer.unobserved = timer.unobserved.map((g: any) => ({ ...g, start: shift(g.start, aged), end: shift(g.end, aged) }));
			timer.lastHeartbeat = shift(timer.lastHeartbeat, 10 * 60_000);
			if (parse(timer) === null) throw new Error("the aged timer is not readable");
			(app as any).saveLocalStorage(key, timer);
			await (app as any).plugins.enablePlugin("logwell");
		});
		await browser.waitUntil(() => browser.executeObsidian(({ plugins }) => (plugins as any).logwell?.session?.app?.focus.timer()?.needsRecovery === true), {
			timeout: 10000,
			timeoutMsg: "the recovered timer did not wait for an answer",
		});
		await clickModalButton("Decide later");
		const focus = await visibleFocus();
		const banner = focus.$(".cp-focus-banner");
		await expect(banner).toBeDisplayed();
		expect(await banner.getText()).toContain("10m");
		expect(await focusRecords()).toHaveLength(before);

		await banner.$("button=Finish and save").click();
		await browser.waitUntil(async () => (await focusRecords()).length === before + 1, { timeout: 5000, timeoutMsg: "no record after Finish" });
		const rec = (await focusRecords()).find((r) => r.taskId === taskId)!;
		expect(rec).toMatchObject({ status: "recovered", focusedSec: 180, gaps: ["pending"] });
		expect(await timerState()).toBeNull();

		// A second reload creates no second session.
		await browser.executeObsidian(async ({ app }) => {
			await (app as any).plugins.disablePlugin("logwell");
			await (app as any).plugins.enablePlugin("logwell");
		});
		await browser.executeObsidian(async ({ plugins }) => {
			await (plugins as any).logwell.ready();
		});
		expect((await focusRecords()).filter((r) => r.taskId === taskId)).toHaveLength(1);
		// The total stays 3 minutes until the user includes the gap.
		expect((await focusRecords()).find((r) => r.taskId === taskId)!.focusedSec).toBe(180);
	});

	// -- Matrix ---------------------------------------------------------------------------------------------------------

	it("AS-13: dragging a task to Urgent and important keeps its ID and sets both flags; the details and the list chips reflect it", async function () {
		const plain = await createTask("AS-13 plain");
		const before = (await allTasks()).length;
		const matrix = await visibleMatrix();
		const title = matrix.$(`.cp-task-row[data-task-id="${plain}"] .cp-task-title`);
		await title.waitForExist({ timeout: 5000, timeoutMsg: "the card did not render" });
		await browser.execute((e) => (e as unknown as HTMLElement).scrollIntoView({ block: "center", inline: "nearest" }), await title.getElement());
		await waitForStableRect(title);
		expect(await quadrantOfCard(plain)).toBe("neither");
		// Both points are measured right before the press.
		await dragPointer(
			() => centerOf(title),
			() => centerOf(matrix.$('.cp-matrix-q[data-quadrant="urgent-important"] .cp-matrix-q-body')),
		);
		await browser.waitUntil(async () => (await getTask(plain))?.important === true, { timeout: 5000, timeoutMsg: "the drop did not change the task" });
		const task = await getTask(plain);
		expect(task!.id).toBe(plain);
		expect(task!.urgent).toBe(true);
		expect(task!.important).toBe(true);
		expect((await allTasks()).length).toBe(before);
		await browser.waitUntil(async () => (await quadrantOfCard(plain)) === "urgent-important", { timeout: 5000, timeoutMsg: "the card did not move to quadrant I" });

		// The list chip and the details reflect it.
		const section = await visibleTasksSection();
		await showInbox(section);
		const row = section.$(`.cp-task-row[data-task-id="${plain}"]:not([data-occurrence])`);
		await row.waitForExist({ timeout: 5000 });
		await expect(row.$(".cp-meta-matrix")).toHaveText(expect.stringContaining("Urgent"));
		await expect(row.$(".cp-meta-matrix")).toHaveText(expect.stringContaining("Important"));
		await domClick(row);
		const pane = section.$(".cp-details");
		await pane.waitForExist({ timeout: 5000 });
		if (!(await pane.$(".cp-details-fields").isExisting())) await domClick(pane.$(".cp-due-chip"));
		const matrixSelect = await browser.execute(
			(el) => Array.from((el as unknown as HTMLElement).querySelectorAll("select")).map((s) => s.value).find((v) => v === "urgent-important") ?? "",
			await pane.getElement(),
		);
		expect(matrixSelect).toBe("urgent-important");
	});
});
