// Habits in the real app.
//
// Habits are seeded through the app services where the UI is not the point. Every DOM read is scoped to the
// visible Habits or Tasks section (background tabs keep hidden copies). Menus are Obsidian Menus, native on
// macOS by default, so the whole run asks for DOM menus.
//
// Time: the plugin's clock is one shared object (`session.app.clock`); specs that need another day or minute
// patch it with an offset and put it back in `afterEach` (the reminder step calls the host's `check()` itself,
// so no real minute has to pass).
import { browser, expect } from "@wdio/globals";
import {
	appToday,
	appZone,
	closeNotices,
	createHabit,
	createTask,
	freshDatabase,
	getHabit,
	habitCheckins,
	habitRow,
	pickMenuItem,
	plusDays,
	railButton,
	restoreMenus,
	useDomMenus,
	visibleHabits,
	visibleTasksSection,
} from "../helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

const QUANTITY = { type: "quantity", target: 30, unit: "min", period: "day" } as const;
const tidy = (text: string) => text.replace(/\s+/g, " ").trim();

/** Moves the plugin clock by `seconds` (negative goes back), keeping the original to restore. */
async function shiftClock(seconds: number): Promise<void> {
	await browser.executeObsidian(({ plugins }, secs) => {
		const app = (plugins as any).logwell.session.app;
		const w = window as any;
		w.__cpClock ??= { original: app.clock.now, offset: 0 };
		const state = w.__cpClock;
		state.offset += secs * 1000;
		app.clock.now = () => new Date(state.original.call(app.clock).getTime() + state.offset);
	}, seconds);
}

async function cleanUp(): Promise<void> {
	// A dialog or prompt left open by a failed test would block the next one. Escape closes the top modal; bounded.
	for (let i = 0; i < 3; i++) {
		const open = await browser.execute(() => document.querySelectorAll(".modal-container").length);
		if (open === 0) break;
		await browser.keys("Escape");
		await browser.pause(150);
	}
	await browser.executeObsidian(({ plugins }) => {
		const app = (plugins as any).logwell?.session?.app;
		const w = window as any;
		if (app !== undefined && w.__cpClock !== undefined) app.clock.now = w.__cpClock.original;
		delete w.__cpClock;
	});
}

/** Clicks a button of the open modal by its text with the DOM, so a floating notice cannot cover it. */
async function clickModalButton(text: string): Promise<void> {
	await browser.waitUntil(
		() =>
			browser.execute((t) => {
				const button = Array.from(document.querySelectorAll<HTMLElement>(".modal button")).find((b) => b.textContent?.trim() === t);
				if (button === undefined) return false;
				button.click();
				return true;
			}, text),
		{ timeout: 5000, timeoutMsg: `no modal button "${text}"` },
	);
}

/** Sets an input of the open modal by a CSS selector the way typing would. */
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

/** Clicks the segment button whose title is `title` in the open dialog. */
async function pickSegment(title: string): Promise<void> {
	await browser.execute((t) => {
		const b = Array.from(document.querySelectorAll<HTMLElement>(".checkpoint-habit-dialog .cp-habit-seg button")).find((x) => x.querySelector("b")?.textContent === t);
		if (b === undefined) throw new Error(`no segment ${t}`);
		b.click();
	}, title);
}

/** Clicks "Undo" on the newest notice that has one. */
async function clickUndoNotice(): Promise<void> {
	await browser.waitUntil(
		() =>
			browser.execute(() => {
				const buttons = Array.from(document.querySelectorAll<HTMLElement>(".notice .checkpoint-notice-actions button")).filter((b) => b.textContent === "Undo");
				const last = buttons[buttons.length - 1];
				if (last === undefined) return false;
				last.click();
				return true;
			}),
		{ timeout: 5000, timeoutMsg: "no Undo notice" },
	);
}

async function noticeTexts(): Promise<string[]> {
	return browser.execute(() => Array.from(document.querySelectorAll<HTMLElement>(".notice")).map((n) => n.textContent ?? ""));
}

async function undoLabel(): Promise<string | null> {
	return browser.executeObsidian(({ plugins }) => (plugins as any).logwell.session.app.store.undoLabel as string | null);
}

/** Types an amount into the row's field and presses Add. */
async function addAmount(row: ChainablePromiseElement, value: string): Promise<void> {
	await row.$(".cp-habit-amount input").setValue(value);
	await row.$(".cp-habit-add").click();
}

describe("Habits", function () {
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
		await cleanUp();
	});

	it("has a Habits rail entry after Focus and shows the first-visit state with example chips", async function () {
		const rail = await railButton("Habits");
		await expect(rail).toBeDisplayed();
		await rail.click();
		const habits = await visibleHabits();
		await expect(habits.$(".cp-habit-empty h3")).toHaveText("Build a habit, one day at a time");
		await expect(habits.$$(".cp-habit-examples button")).toBeElementsArrayOfSize(4);
	});

	it("creates a quantity habit from the dialog (HAB-02, D20)", async function () {
		const habits = await visibleHabits();
		await habits.$(".cp-habits-head button").click();
		await browser.$(".checkpoint-habit-dialog").waitForExist({ timeout: 5000, timeoutMsg: "the New habit dialog did not open" });
		await setModalInput('input[type="text"]:not(.cp-habit-target):not(.cp-habit-unit-input)', "Read");
		await pickSegment("Amount");
		await setModalInput(".cp-habit-target", "30");
		await setModalInput(".cp-habit-unit-input", "min");
		await clickModalButton("Create habit");
		await browser.$(".checkpoint-habit-dialog").waitForExist({ reverse: true, timeout: 5000, timeoutMsg: "the dialog did not close" });
		await expect(habitRow(habits, "Read").$(".cp-habit-progress")).toHaveText("0 of 30 min");
		await expect(habits.$(".cp-habit-detail h3")).toHaveText("Read");
		await expect(habits.$(".cp-habit-detail-title p")).toHaveText(expect.stringContaining("30 min a day · every day"));
	});

	it("a wrong value keeps the dialog open with the message inline (D20)", async function () {
		const habits = await visibleHabits();
		await habits.$(".cp-habits-head button").click();
		await browser.$(".checkpoint-habit-dialog").waitForExist({ timeout: 5000 });
		await pickSegment("Amount");
		await clickModalButton("Create habit");
		await expect(browser.$(".checkpoint-habit-dialog .cp-habit-form-error")).toHaveText("Enter a name.");
		await expect(browser.$(".checkpoint-habit-dialog")).toExist();
		expect(await browser.executeObsidian(({ plugins }) => (plugins as any).logwell.session.app.habits.list().length as number)).toBe(0);
	});

	it("AS-11: backfill yesterday through the strip; editing the target keeps yesterday's goal (HAB-07, HAB-09)", async function () {
		// Created yesterday, so yesterday is one of its days.
		await shiftClock(-86400);
		const id = await createHabit({ name: "Read", goal: QUANTITY });
		await shiftClock(86400);
		const habits = await visibleHabits();
		const today = await appToday();
		const yesterday = plusDays(today, -1);

		// The strip: the sixth button is yesterday.
		await habits.$$(".cp-habit-day")[5].click();
		await expect(habits.$(".cp-habits-sub")).toHaveText(expect.stringContaining("done"));
		await addAmount(habitRow(habits, "Read"), "20");
		await addAmount(habitRow(habits, "Read"), "10");
		await expect(habitRow(habits, "Read").$(".cp-habit-progress")).toHaveText("30 of 30 min");
		expect(await habitCheckins(id)).toEqual([
			{ date: yesterday, value: 20 },
			{ date: yesterday, value: 10 },
		]);
		await expect(habits.$(".cp-habit-detail .cp-habit-entry-day")).toHaveText("Yesterday");
		await expect(habits.$(".cp-habit-detail .cp-habit-entry-value small")).toHaveText("added later", { ignoreCase: true });

		// Edit the 10 to 5 in the log (newest first: the 10 is the first entry).
		// The log can sit under Obsidian's status bar at the bottom of the pane; scroll it clear first.
		const editCheckin = await habits.$$('.cp-habit-detail button[aria-label="Edit check-in"]')[0];
		await browser.execute((el: HTMLElement) => el.scrollIntoView({ block: "center" }), editCheckin as unknown as HTMLElement);
		await browser.pause(200);
		await editCheckin.click();
		await browser.$(".modal").waitForExist({ timeout: 5000, timeoutMsg: "the Edit check-in prompt did not open" });
		await setModalInput('input[type="text"]', "5");
		await clickModalButton("Save");
		await expect(habitRow(habits, "Read").$(".cp-habit-progress")).toHaveText("25 of 30 min");

		// Edit the habit: target 20 applies from today.
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
		// Yesterday is still measured against 30 and is not met; today against 20.
		await expect(habitRow(habits, "Read").$(".cp-habit-progress")).toHaveText("25 of 30 min");
		await expect(habitRow(habits, "Read")).not.toHaveElementClass("is-done");
		await habits.$$(".cp-habit-day")[6].click();
		await expect(habitRow(habits, "Read").$(".cp-habit-progress")).toHaveText("0 of 20 min");
	});

	it("a binary habit toggles on and off, and Undo from the notice restores it with the store's label (HAB-06)", async function () {
		const id = await createHabit({ name: "Meditate", timeOfDay: "morning", goal: { type: "binary", target: 1, unit: null, period: "day" } });
		const habits = await visibleHabits();
		const check = () => habitRow(habits, "Meditate").$(".cp-habit-check");
		await expect(check()).toHaveAttribute("aria-pressed", "false");
		await check().click();
		await expect(check()).toHaveAttribute("aria-pressed", "true");
		expect(await undoLabel()).toBe("Check in");
		expect(await habitCheckins(id)).toHaveLength(1);
		await browser.waitUntil(async () => (await noticeTexts()).some((t) => t.includes("Checked in Meditate.")), { timeout: 5000, timeoutMsg: "no check-in notice" });

		await check().click();
		await expect(check()).toHaveAttribute("aria-pressed", "false");
		expect(await undoLabel()).toBe("Remove check-in");
		expect(await habitCheckins(id)).toHaveLength(0);

		// Undo of the removal brings the check-in back.
		await clickUndoNotice();
		await expect(check()).toHaveAttribute("aria-pressed", "true");
		expect(await habitCheckins(id)).toHaveLength(1);
	});

	it("a count habit's +1 twice reads 2 / 8 (HAB-05)", async function () {
		await createHabit({ name: "Drink water", goal: { type: "count", target: 8, unit: "glasses", period: "day" } });
		const habits = await visibleHabits();
		const row = habitRow(habits, "Drink water");
		await row.$(".cp-habit-plus").click();
		await row.$(".cp-habit-plus").click();
		await expect(row.$(".cp-habit-count")).toHaveText("2 / 8", { ignoreCase: true });
		await expect(row.$(".cp-habit-progress")).toHaveText("2 of 8 glasses");
	});

	it("Today shows the Habits block in List and the first column in Board, and folds the done habits (D12)", async function () {
		await createHabit({ name: "Meditate", timeOfDay: "morning", goal: { type: "binary", target: 1, unit: null, period: "day" } });
		await createHabit({ name: "Drink water", goal: { type: "count", target: 8, unit: "glasses", period: "day" } });
		const today = await appToday();
		await createTask("Write chapter", { scheduled: { kind: "date", date: today } });
		const tasks = await visibleTasksSection();
		await tasks.$(".cp-sidebar").$(`.//*[normalize-space(text())="Today"]`).click();

		const block = tasks.$(".cp-today-habits");
		await block.waitForExist({ timeout: 5000, timeoutMsg: "no Habits block in Today" });
		await expect(block.$("h3")).toHaveText(expect.stringContaining("Habits"));
		await habitRow(tasks, "Meditate").$(".cp-habit-check").click();
		await expect(block.$(".cp-today-habits-fold")).toHaveText(expect.stringContaining("Meditate done"));
		await expect(tasks.$(".cp-main-header .cp-count-pill")).toHaveText("1");

		// Board mode: the Habits column is the first one, before the task columns.
		await tasks.$(".cp-mode-switch").$(".//button[normalize-space()='Board']").click();
		const first = tasks.$(".cp-board-scroll > *:first-child");
		await first.waitForExist({ timeout: 5000 });
		await expect(first).toHaveElementClass("cp-board-habits");
		await expect(first.$(".cp-board-col-title")).toHaveText("Habits");
		await expect(first.$$(".cp-habit-card")).toBeElementsArrayOfSize(2);

		// Upcoming has neither.
		await tasks.$(".cp-sidebar").$(`.//*[normalize-space(text())="Upcoming"]`).click();
		await expect(tasks.$(".cp-board-habits")).not.toExist();
		await expect(tasks.$(".cp-today-habits")).not.toExist();
	});

	it("archives a habit from the ⋯ menu and restores it from the archived list (HAB-10)", async function () {
		await createHabit({ name: "Walk", goal: { type: "binary", target: 1, unit: null, period: "day" } });
		await createHabit({ name: "Read", goal: QUANTITY });
		const habits = await visibleHabits();
		await habitRow(habits, "Walk").$(".cp-habit-name").click();
		await habits.$('.cp-habit-detail button[aria-label="More: archive, delete"]').click();
		await pickMenuItem("Archive");
		await expect(habitRow(habits, "Walk")).not.toExist();
		await expect(habits.$(".cp-habits-foot button")).toHaveText("Archived habits (1)");

		await habits.$(".cp-habits-foot button").click();
		await expect(habits.$(".cp-habits-sub")).toHaveText("Archived habits");
		await expect(habitRow(habits, "Walk")).toExist();
		await habitRow(habits, "Walk").$(".cp-habit-restore").click();
		await expect(habits.$(".cp-habit-week")).toExist();
		await expect(habitRow(habits, "Walk")).toExist();
		await expect(habits.$(".cp-habits-foot")).not.toExist();
	});

	it("a reminder shows its notice with Check in and Snooze 10 min; Check in toggles a binary habit on (D10)", async function () {
		// Stay away from midnight so "one minute ahead" is still today.
		const hour = await browser.executeObsidian(({ plugins }, zone) => {
			const now = (plugins as any).logwell.session.app.clock.now() as Date;
			return Number(new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", hourCycle: "h23" }).format(now));
		}, await appZone());
		if (hour >= 22) await shiftClock(-12 * 3600);
		const time = await browser.executeObsidian(({ plugins }, zone) => {
			const next = new Date((plugins as any).logwell.session.app.clock.now().getTime() + 60_000);
			return new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(next);
		}, await appZone());
		const id = await createHabit({ name: "Stretch", reminder: { time }, goal: { type: "binary", target: 1, unit: null, period: "day" } });
		const habits = await visibleHabits();
		await expect(habitRow(habits, "Stretch").$(".cp-habit-bell")).toHaveText(time);

		// The host arms a reminder only after it saw the new time before its minute, so run its check
		// now (the plugin's 30 s tick would do this on its own), then step the clock into the reminder's minute and
		// check again. The step is computed from the clock: the reminder's minute starts at the next whole minute
		// after "now + 60 s", and 5 s into it is inside it.
		const runCheck = () => browser.executeObsidian(({ plugins }) => (plugins as any).logwell.reminderHost.check());
		await runCheck();
		const into = await browser.executeObsidian(({ plugins }) => {
			const now = (plugins as any).logwell.session.app.clock.now().getTime() as number;
			return Math.round((Math.floor((now + 60_000) / 60_000) * 60_000 - now) / 1000) + 5;
		});
		await shiftClock(into);
		await runCheck();
		await browser.waitUntil(async () => (await noticeTexts()).some((t) => t.includes("Time for Stretch")), { timeout: 5000, timeoutMsg: "no reminder notice" });
		const buttons = await browser.execute(() =>
			Array.from(document.querySelectorAll<HTMLElement>(".notice .checkpoint-notice-actions button")).map((b) => b.textContent ?? ""),
		);
		expect(buttons).toEqual(expect.arrayContaining(["Check in", "Snooze 10 min"]));
		const clickNoticeButton = (label: string) =>
			browser.execute((want) => {
				const b = Array.from(document.querySelectorAll<HTMLElement>(".notice .checkpoint-notice-actions button")).find((x) => x.textContent === want);
				b?.click();
			}, label);

		// Snooze closes the notice; ten minutes later the same reminder is due again.
		await clickNoticeButton("Snooze 10 min");
		await browser.waitUntil(async () => !(await noticeTexts()).some((t) => t.includes("Time for Stretch")), { timeout: 5000, timeoutMsg: "the notice stayed after Snooze" });
		expect(await habitCheckins(id)).toHaveLength(0);
		await shiftClock(10 * 60 + 5);
		await runCheck();
		await browser.waitUntil(async () => (await noticeTexts()).some((t) => t.includes("Time for Stretch")), { timeout: 5000, timeoutMsg: "no reminder notice after the snooze" });

		await clickNoticeButton("Check in");
		await expect(habitRow(habits, "Stretch").$(".cp-habit-check")).toHaveAttribute("aria-pressed", "true");
		expect(await habitCheckins(id)).toHaveLength(1);
	});

	it("Search finds a habit and opens it on the Habits page (D13)", async function () {
		await createHabit({ name: "Stretch", goal: { type: "binary", target: 1, unit: null, period: "day" } });
		await (await railButton("Search")).click();
		let input: WebdriverIO.Element | undefined;
		for (const el of await browser.$$('.cp-search input[type="search"]')) if (await el.isDisplayed()) input = el;
		await input!.setValue("stre");
		const result = browser.$(".cp-search .cp-search-habits button");
		await result.waitForExist({ timeout: 5000, timeoutMsg: "no habit search result" });
		await expect(result).toHaveText("Stretch");
		await result.click();
		const habits = await visibleHabits();
		await expect(habits.$(".cp-habit-detail h3")).toHaveText("Stretch");
	});
});
