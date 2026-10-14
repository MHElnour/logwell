// Focus in the real app.
// Tasks are seeded through the app services. Every DOM read is scoped to the visible Focus section or
// Tasks section (background tabs keep hidden copies).
//
// Time: the plugin's clock is one shared object (`session.app.clock`), so the specs move it forward in
// steps of at most 20 s and call `focus.tick()` after each step. A bigger jump would be read as a sleep
// and open the recovery prompt. The recovery test is different on purpose: a reload cannot keep a patched
// clock (the bundle is evaluated again), so that test writes a stale active timer into local storage
// while the plugin is disabled and then enables it.
import { browser, expect } from "@wdio/globals";
import { appToday, createTask, freshDatabase, restoreMenus, useDomMenus, visibleTasksSection } from "../helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

interface RecordRead {
	id: string;
	taskId: string | null;
	status: string;
	splitFrom: string | null;
	focusedSec: number;
	gaps: string[];
}

const CONFIG = { rounds: 1, focusSec: 60, breakSec: 60, longBreakSec: 60 };

/**
 * Moves the plugin clock forward by `seconds`, in steps, ticking the focus service after each.
 * The plugin's own 1 s heartbeat keeps running on the patched clock; its ticks only add real
 * milliseconds to the offset clock, never a gap larger than the 20 s steps.
 */
async function advanceClock(seconds: number): Promise<void> {
	await browser.executeObsidian(async ({ plugins }, secs) => {
		const app = (plugins as any).logwell.session.app;
		const w = window as any;
		w.__cpClock ??= { original: app.clock.now, offset: 0 };
		const state = w.__cpClock;
		let left = secs;
		while (left > 0) {
			const step = Math.min(left, 20);
			state.offset += step * 1000;
			app.clock.now = () => new Date(state.original.call(app.clock).getTime() + state.offset);
			await app.focus.tick();
			left -= step;
		}
	}, seconds);
}

/** Puts the real clock back and ends any timer, so the next test starts clean. */
async function cleanUp(): Promise<void> {
	// A prompt left open by a failed test would block the next one. Escape closes the top modal; bounded.
	for (let i = 0; i < 3; i++) {
		const open = await browser.execute(() => document.querySelectorAll(".modal-container").length);
		if (open === 0) break;
		await browser.keys("Escape");
		await browser.pause(150);
	}
	await browser.executeObsidian(async ({ plugins }) => {
		const plugin = (plugins as any).logwell;
		const app = plugin?.session?.app;
		const w = window as any;
		w.__cpMomentsOff?.();
		delete w.__cpMomentsOff;
		if (app === undefined) return;
		if (app.focus.timer() !== null) {
			// A pending recovery prompt is answered first; Stop saves the round.
			if (app.focus.timer().needsRecovery) await app.focus.resolveRecovery("discard");
			else await app.focus.stop();
		}
		if (w.__cpClock !== undefined) {
			app.clock.now = w.__cpClock.original;
			delete w.__cpClock;
		}
		delete w.__cpMoments;
	});
}

/** Records the moments the focus service reports (focus-start, break-start, set-done). */
async function recordMoments(): Promise<void> {
	await browser.executeObsidian(({ plugins }) => {
		const w = window as any;
		w.__cpMoments = [] as string[];
		w.__cpMomentsOff?.();
		w.__cpMomentsOff = (plugins as any).logwell.session.app.focus.bus.on("moment", (m: string) => w.__cpMoments.push(m));
	});
}

async function moments(): Promise<string[]> {
	return browser.executeObsidian(() => [...((window as any).__cpMoments ?? [])] as string[]);
}

async function startSet(taskId: string | null, config = CONFIG): Promise<void> {
	await browser.executeObsidian(
		async ({ plugins }, cfg, id) => {
			const r = await (plugins as any).logwell.session.app.focus.start(cfg, id);
			if (r.kind !== "started") throw new Error("focus did not start");
		},
		config,
		taskId,
	);
}

async function records(): Promise<RecordRead[]> {
	return browser.executeObsidian(({ plugins }) => {
		const app = (plugins as any).logwell.session.app;
		const out = [...app.store.state.focusSessions.values()].map((s: any) => ({
			id: s.id as string,
			taskId: s.taskId as string | null,
			status: s.status as string,
			splitFrom: s.splitFrom as string | null,
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
	}) as Promise<RecordRead[]>;
}

async function timerState(): Promise<{ phase: string; state: string; round: number; taskId: string | null; splitFrom: string | null; needsRecovery: boolean } | null> {
	return browser.executeObsidian(({ plugins }) => {
		const t = (plugins as any).logwell.session.app.focus.timer();
		return t === null ? null : { phase: t.phase, state: t.state, round: t.round, taskId: t.taskId, splitFrom: t.splitFrom, needsRecovery: t.needsRecovery };
	});
}

/** Opens the Focus section and returns the visible `.cp-focus` (background tabs keep hidden copies). */
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

/** Clicks a stepper button of the set settings ("Increase rounds"); a control, so it is found by its aria-label. */
async function stepSetting(focus: WebdriverIO.Element, label: string, times: number): Promise<void> {
	for (let i = 0; i < times; i++) await focus.$(`.cp-focus-settings button[aria-label="${label}"]`).click();
}

const tidy = (text: string) => text.replace(/\s+/g, " ").trim();

/** Clicks a modal button by its text with the DOM, so a floating notice cannot cover it. */
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

describe("Focus", function () {
	// The round menu is an Obsidian Menu. On macOS it is native by default (no DOM to click), so the specs
	// ask for the DOM menu for the whole run.
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

	it("a one-round set with a one-minute focus finishes: one record, a chip on the task, no break", async function () {
		const today = await appToday();
		const taskId = await createTask("Write chapter", { scheduled: { kind: "date", date: today } });
		await recordMoments();
		const focus = await visibleFocus();

		// The defaults are 4 rounds of 25 minutes: 3 steps down to one round; 4 steps of 5 and 4 of 1 down to one minute.
		await stepSetting(focus, "Decrease rounds", 3);
		await stepSetting(focus, "Decrease focus", 8);
		await focus.$(".cp-focus-task select").selectByAttribute("value", taskId);
		await focus.$("button=Start").click();

		await browser.waitUntil(async () => (await timerState()) !== null, { timeout: 5000, timeoutMsg: "the set did not start" });
		await expect(focus.$(".cp-focus-phase")).toHaveText("Focus");
		await expect(focus.$(".cp-focus-round")).toHaveText("Round 1 of 1");
		// The settings give way to a static summary line while the set runs.
		await expect(focus.$(".cp-focus-settings")).not.toExist();
		await expect(focus.$(".cp-focus-setline")).toHaveText("1 round · 1 min focus · 5 min break");

		await advanceClock(61);

		await expect(focus.$(".cp-focus-summary")).toBeDisplayed();
		expect(tidy(await focus.$(".cp-focus-summary").getText())).toContain("1 round · 1m focused");
		expect(await timerState()).toBeNull();
		// The set ends by itself: the last round has no break.
		expect(await moments()).toEqual(["focus-start", "set-done"]);

		const saved = await records();
		expect(saved).toHaveLength(1);
		expect(saved[0]).toMatchObject({ taskId, status: "completed", focusedSec: 60 });
		await expect(focus.$(".cp-focus-set .cp-focus-set-task")).toHaveText("Write chapter");

		const tasks = await visibleTasksSection();
		const chip = tasks.$(`.cp-task-row[data-task-id="${taskId}"] .cp-meta-focus`);
		await chip.waitForExist({ timeout: 5000, timeoutMsg: "no focus chip on the task row" });
		await expect(chip).toHaveText(expect.stringContaining("1m"));
	});

	it("reloading the plugin while a focus runs asks what to do with the gap; Finish keeps it pending, Include counts it", async function () {
		const taskId = await createTask("Long job");
		await startSet(taskId, { rounds: 1, focusSec: 1500, breakSec: 300, longBreakSec: 900 });
		// "Obsidian was closed": disable the plugin, age the stored timer by 13 minutes (3 focused, then
		// 10 unobserved), enable it again.
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
			// The aged JSON must still be a timer the plugin accepts, or the test would pass for the wrong reason.
			if (parse(timer) === null) throw new Error("the aged timer is not readable");
			(app as any).saveLocalStorage(key, timer);
			await (app as any).plugins.enablePlugin("logwell");
		});
		await browser.waitUntil(
			() => browser.executeObsidian(({ plugins }) => (plugins as any).logwell?.session?.app?.focus.timer()?.needsRecovery === true),
			{ timeout: 10000, timeoutMsg: "the recovered timer did not wait for an answer" },
		);

		// Dismiss the prompt; the banner on the Focus page still offers the choice.
		await clickModalButton("Decide later");
		const focus = await visibleFocus();
		const banner = focus.$(".cp-focus-banner");
		await expect(banner).toBeDisplayed();
		expect(await banner.getText()).toContain("10m");
		expect(await records()).toHaveLength(0);

		// One pending gap, and still no record.
		const gapsBefore = await browser.executeObsidian(({ plugins }) => (plugins as any).logwell.session.app.focus.timer().unobserved.length as number);
		expect(gapsBefore).toBe(1);

		await banner.$("button=Finish and save").click();
		await browser.waitUntil(async () => (await records()).length === 1, { timeout: 5000, timeoutMsg: "no record after Finish" });
		const [rec] = await records();
		expect(rec).toMatchObject({ status: "recovered", taskId, focusedSec: 180, gaps: ["pending"] });
		expect(await timerState()).toBeNull();

		await expect(focus.$(".cp-focus-rec .cp-focus-round-time")).toHaveText("3m");
		await focus.$(".cp-focus-gap").$("button=Include").click();
		await browser.waitUntil(async () => (await records())[0]?.gaps[0] === "included", { timeout: 5000 });
		await expect(focus.$(".cp-focus-rec .cp-focus-round-time")).toHaveText("13m");
		expect((await records())[0]!.focusedSec).toBeGreaterThanOrEqual(780);
	});
});
