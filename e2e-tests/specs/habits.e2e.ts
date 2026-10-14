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
	appZone,
	createHabit,
	freshDatabase,
	habitCheckins,
	habitRow,
	noticeTexts,
	railButton,
	restoreMenus,
	useDomMenus,
	visibleHabits,
} from "../helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

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

	it("a reminder shows its notice with Check in and Snooze 10 min; Check in toggles a binary habit on", async function () {
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
});
