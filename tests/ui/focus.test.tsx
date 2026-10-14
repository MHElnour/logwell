// @vitest-environment happy-dom
import { render } from "preact";
import { describe, expect, it, vi } from "vitest";
import type { FocusSetConfig } from "../../src/domain/focus";
import { useFocus } from "../../src/ui/hooks";
import { type AppMount, click, menuItem, mountApp, mountNode, settle, unmountAll } from "./app-helpers";
import type { MenuSpec } from "../../src/ui/host";
import { makeReadOnly } from "../app/harness";
import { SetLine, stepFor } from "../../src/ui/focus/Controls";

describe("Focus page", () => {
	// The Focus page, the focus chip, the details total and the entry points.
	// The clock is the harness FakeClock (2026-10-01T10:00Z; Europe/Berlin
	// shows 12:00); the host's per-second tick is done by hand.

	const cfg = (rounds = 1, focusSec = 60): FocusSetConfig => ({ rounds, focusSec, breakSec: 60, longBreakSec: 60 });

	async function openFocus(m: AppMount): Promise<HTMLElement> {
		await click(m.root.querySelector('.cp-rail [aria-label="Focus"]'));
		return m.root.querySelector<HTMLElement>(".cp-focus")!;
	}

	async function tickFor(m: AppMount, seconds: number): Promise<void> {
		for (let i = 0; i < seconds; i++) {
			m.h.clock.advance(1000);
			await m.h.app.focus.tick();
		}
		await settle();
	}

	const buttons = (el: ParentNode) => [...el.querySelectorAll<HTMLButtonElement>("button")];
	const buttonByText = (el: ParentNode, text: string) => buttons(el).find((b) => b.textContent?.trim() === text);
	async function pressButton(el: ParentNode, text: string): Promise<void> {
		const b = buttonByText(el, text);
		if (b === undefined) throw new Error(`no button "${text}"`);
		await click(b);
	}
	/** A stepper button by its aria-label ("Increase rounds"); these are controls, so aria-label is right. */
	function step(page: HTMLElement, label: string): HTMLButtonElement {
		const b = page.querySelector<HTMLButtonElement>(`.cp-focus-settings button[aria-label="${label}"]`);
		if (b === null) throw new Error(`no stepper button "${label}"`);
		return b;
	}
	/** The shown value of one setting, found through its group label. */
	function valueOf(page: HTMLElement, label: string): string {
		const group = [...page.querySelectorAll<HTMLElement>(".cp-focus-settings [role='group']")].find((g) => g.querySelector(".cp-focus-field-label")?.textContent === label);
		return group?.querySelector(".cp-focus-value")?.textContent ?? "";
	}
	const text = (el: ParentNode, sel: string) => el.querySelector(sel)?.textContent?.trim();

	/** Runs a complete 1-round set of one minute on a task and returns after the record is written. */
	async function finishedRound(m: AppMount, taskId: string | null): Promise<void> {
		await m.h.app.focus.start(cfg(), taskId);
		await tickFor(m, 60);
	}

	describe("the page", () => {
		it("shows the idle ring with the remembered set values", async () => {
			const m = await mountApp();
			const page = await openFocus(m);
			expect(text(page, ".cp-focus-time")).toBe("25:00");
			expect(text(page, ".cp-focus-phase")).toBe("Ready");
			expect(text(page, ".cp-focus-round")).toBe("4 rounds");
			expect(buttonByText(page, "Start")).toBeDefined();
			expect(buttonByText(page, "Pause")).toBeUndefined();
		});
	});

	describe("running a set", () => {
		it("Start is a user gesture: it calls focusGesture once", async () => {
			const m = await mountApp();
			const gesture = vi.spyOn(m.host, "focusGesture");
			const page = await openFocus(m);
			await pressButton(page, "Start");
			expect(gesture).toHaveBeenCalledTimes(1);
		});

		it("Start begins a set: the ring counts down, the settings lock and the controls change", async () => {
			const m = await mountApp();
			const page = await openFocus(m);
			await pressButton(page, "Start");
			expect(m.h.app.focus.timer()).not.toBeNull();
			expect(text(page, ".cp-focus-time")).toBe("25:00");
			await tickFor(m, 5);
			expect(text(page, ".cp-focus-time")).toBe("24:55");
			expect(text(page, ".cp-focus-round")).toBe("Round 1 of 4");
			// The settings panel gives way to a static summary line while the set runs.
			expect(page.querySelector(".cp-focus-settings")).toBeNull();
			expect(text(page, ".cp-focus-setline")).toBe("4 rounds · 25m focus · 5m break");
			expect(buttonByText(page, "Start")).toBeUndefined();
			expect(buttonByText(page, "Pause")).toBeDefined();
			expect(buttonByText(page, "Finish")).toBeDefined();
			expect(buttonByText(page, "Skip")).toBeUndefined();
			expect(buttonByText(page, "Stop")).toBeDefined();
		});

		it("Pause freezes the ring and Resume continues it", async () => {
			const m = await mountApp();
			const page = await openFocus(m);
			await pressButton(page, "Start");
			await tickFor(m, 10);
			await pressButton(page, "Pause");
			expect(m.h.app.focus.timer()?.state).toBe("paused");
			m.h.clock.advance(30_000);
			await settle();
			expect(text(page, ".cp-focus-time")).toBe("24:50");
			await pressButton(page, "Resume");
			expect(m.h.app.focus.timer()?.state).toBe("running");
			await tickFor(m, 5);
			expect(text(page, ".cp-focus-time")).toBe("24:45");
		});

		it("Finish moves a focus to its break; the label says Short break, and Skip break starts the next round", async () => {
			const m = await mountApp();
			await m.h.app.focus.start(cfg(2, 600), null);
			const page = await openFocus(m);
			await tickFor(m, 70);
			await pressButton(page, "Finish");
			expect(text(page, ".cp-focus-phase")).toBe("Short break");
			expect(m.h.app.store.state.focusSessions.size).toBe(1);
			// In a break the left control says what it skips.
			expect(buttonByText(page, "Skip break")).toBeDefined();
			expect(buttonByText(page, "Skip")).toBeUndefined();
			await pressButton(page, "Skip break");
			expect(m.h.app.focus.timer()).toMatchObject({ phase: "focus", round: 2 });
		});

		it("Stop ends the set and saves the focus", async () => {
			const m = await mountApp();
			const page = await openFocus(m);
			await pressButton(page, "Start");
			await tickFor(m, 120);
			await pressButton(page, "Stop");
			expect(m.h.app.focus.timer()).toBeNull();
			expect([...m.h.app.store.state.focusSessions.values()][0]?.status).toBe("stopped");
			expect(buttonByText(page, "Start")).toBeDefined();
			// The record shows a hollow dot and a note, since it did not complete.
			expect(text(page, ".cp-focus-round-status em")).toBe("Stopped early");
			expect(page.querySelector(".cp-focus-rec .cp-focus-status-dot")?.classList.contains("is-stopped")).toBe(true);
		});

		it("shows the dots and the long-break phase", async () => {
			const m = await mountApp();
			await m.h.app.focus.start({ rounds: 5, focusSec: 60, breakSec: 60, longBreakSec: 120 }, null);
			const page = await openFocus(m);
			expect(page.querySelectorAll(".cp-focus-dot").length).toBe(5);
			expect(page.querySelectorAll(".cp-focus-dot.is-current").length).toBe(1);
			// Rounds 1-3 and their breaks, then the focus of round 4 and its long break.
			for (let r = 0; r < 3; r++) {
				await tickFor(m, 60);
				await tickFor(m, 60);
			}
			await tickFor(m, 60);
			expect(text(page, ".cp-focus-phase")).toBe("Long break");
			expect(page.querySelectorAll(".cp-focus-dot.is-done").length).toBe(4);
		});

		it("a finished set shows the summary and Start for another", async () => {
			const m = await mountApp();
			const page = await openFocus(m);
			await m.h.app.focus.start(cfg(1, 60), null);
			await tickFor(m, 60);
			expect(m.h.app.focus.timer()).toBeNull();
			expect(text(page, ".cp-focus-summary")).toContain("1 round · 1m focused");
			expect(text(page, ".cp-focus-phase")).toBe("Set done");
			expect(page.querySelector(".cp-focus-check")).not.toBeNull();
			expect(page.querySelector(".cp-focus-time")).toBeNull();
			expect(buttonByText(page, "Start again")).toBeDefined();
			// The settings are back for the next set.
			expect(page.querySelector(".cp-focus-settings")).not.toBeNull();
		});
	});

	describe("set settings", () => {
		it("saves a change through setFocusConfig, clamped to the range", async () => {
			const m = await mountApp();
			const set = vi.fn(async () => undefined);
			m.host.setFocusConfig = set;
			const page = await openFocus(m);
			expect(valueOf(page, "Rounds")).toBe("4");
			expect(valueOf(page, "Focus")).toBe("25min");
			for (let i = 0; i < 6; i++) await click(step(page, "Increase rounds"));
			expect(valueOf(page, "Rounds")).toBe("8");
			// 4 to 8 is four commits; the two clicks at the top change nothing.
			expect(set).toHaveBeenCalledTimes(4);
			expect(set).toHaveBeenLastCalledWith(expect.objectContaining({ rounds: 8 }));
			expect(step(page, "Increase rounds").getAttribute("aria-disabled")).toBe("true");
			await click(step(page, "Increase focus"));
			expect(set).toHaveBeenLastCalledWith({ rounds: 8, focusSec: 1800, breakSec: 300, longBreakSec: 900 });
			await pressButton(page, "Start");
			expect(m.h.app.focus.timer()?.config).toEqual({ rounds: 8, focusSec: 1800, breakSec: 300, longBreakSec: 900 });
		});

		it("steps by 5 minutes, and by 1 near the bottom of the range", async () => {
			const m = await mountApp();
			const set = vi.fn(async () => undefined);
			m.host.setFocusConfig = set;
			const page = await openFocus(m);
			for (let i = 0; i < 4; i++) await click(step(page, "Decrease focus"));
			expect(valueOf(page, "Focus")).toBe("5min");
			await click(step(page, "Decrease focus"));
			expect(valueOf(page, "Focus")).toBe("4min");
			for (let i = 0; i < 3; i++) await click(step(page, "Decrease focus"));
			expect(valueOf(page, "Focus")).toBe("1min");
			expect(set).toHaveBeenLastCalledWith(expect.objectContaining({ focusSec: 60 }));
			expect(valueOf(page, "Long break")).toBe("15min");
			expect(page.querySelector(".cp-focus-settings")?.textContent).toContain("After round 4, in sets over 4");
		});

		it("starts on the chosen task (also none)", async () => {
			const m = await mountApp();
			const task = (await m.h.app.tasks.create({ title: "Write report" })).task;
			await settle();
			const page = await openFocus(m);
			const pick = page.querySelector<HTMLSelectElement>(".cp-focus-task select")!;
			expect([...pick.options].map((o) => o.textContent)).toEqual(["No task", "Write report"]);
			pick.value = task.id;
			pick.dispatchEvent(new Event("change", { bubbles: true }));
			await settle();
			await pressButton(page, "Start");
			expect(m.h.app.focus.timer()?.taskId).toBe(task.id);
		});

		it("changing the task during a focus goes through startFocus (Split or Reassign), during a break it reassigns", async () => {
			const m = await mountApp();
			const a = (await m.h.app.tasks.create({ title: "A" })).task;
			const b = (await m.h.app.tasks.create({ title: "B" })).task;
			await m.h.app.focus.start(cfg(2, 60), a.id);
			const startFocus = vi.fn(async () => undefined);
			m.host.startFocus = startFocus;
			const page = await openFocus(m);
			const pick = page.querySelector<HTMLSelectElement>(".cp-focus-task select")!;
			pick.value = b.id;
			pick.dispatchEvent(new Event("change", { bubbles: true }));
			await settle();
			expect(startFocus).toHaveBeenCalledWith(b.id);
			expect(m.h.app.focus.timer()?.taskId).toBe(a.id);
			await tickFor(m, 60);
			expect(m.h.app.focus.timer()?.phase).toBe("short-break");
			pick.value = b.id;
			pick.dispatchEvent(new Event("change", { bubbles: true }));
			await settle();
			expect(m.h.app.focus.timer()?.taskId).toBe(b.id);
			expect(startFocus).toHaveBeenCalledTimes(1);
		});

		it("a cancelled change puts the picker back on the running task", async () => {
			const m = await mountApp();
			const a = (await m.h.app.tasks.create({ title: "A" })).task;
			const b = (await m.h.app.tasks.create({ title: "B" })).task;
			await m.h.app.focus.start(cfg(2, 60), a.id);
			m.host.startFocus = vi.fn(async () => undefined);
			const page = await openFocus(m);
			const pick = page.querySelector<HTMLSelectElement>(".cp-focus-task select")!;
			expect(pick.value).toBe(a.id);
			pick.value = b.id;
			pick.dispatchEvent(new Event("change", { bubbles: true }));
			await settle();
			expect(pick.value).toBe(a.id);
		});

		it("choosing No task during a focus goes through startFocus(null) too", async () => {
			const m = await mountApp();
			const a = (await m.h.app.tasks.create({ title: "A" })).task;
			await m.h.app.focus.start(cfg(2, 60), a.id);
			const startFocus = vi.fn(async () => undefined);
			m.host.startFocus = startFocus;
			const page = await openFocus(m);
			const pick = page.querySelector<HTMLSelectElement>(".cp-focus-task select")!;
			pick.value = "";
			pick.dispatchEvent(new Event("change", { bubbles: true }));
			await settle();
			expect(startFocus).toHaveBeenCalledWith(null);
			expect(m.h.app.focus.timer()?.taskId).toBe(a.id);
			expect(pick.value).toBe(a.id);
		});
	});

	describe("steppers", () => {
		it("one click commits once, and quick clicks on two fields build on each other", async () => {
			const m = await mountApp();
			const setConfig = vi.fn(async () => undefined);
			m.host.setFocusConfig = setConfig;
			const page = await openFocus(m);
			await click(step(page, "Increase rounds"));
			await settle();
			expect(setConfig).toHaveBeenCalledTimes(1);
			// Two clicks in the same tick, before the page re-renders.
			step(page, "Increase rounds").click();
			step(page, "Increase break").click();
			await settle();
			expect(setConfig).toHaveBeenCalledTimes(3);
			expect(setConfig).toHaveBeenLastCalledWith({ rounds: 6, focusSec: 1500, breakSec: 600, longBreakSec: 900 });
		});

		it("each setting is a labelled group and the buttons have labels", async () => {
			const m = await mountApp();
			const page = await openFocus(m);
			const groups = [...page.querySelectorAll<HTMLElement>(".cp-focus-settings [role='group']")];
			expect(groups.map((g) => g.querySelector(".cp-focus-field-label")?.textContent)).toEqual(["Rounds", "Focus", "Break", "Long break"]);
			for (const g of groups) {
				expect(g.hasAttribute("aria-label")).toBe(false);
				expect(page.ownerDocument.getElementById(g.getAttribute("aria-labelledby")!)).not.toBeNull();
			}
			expect([...page.querySelectorAll(".cp-focus-step")].every((b) => b.getAttribute("aria-label")?.match(/^(Decrease|Increase) /))).toBe(true);
		});
	});

	describe("selected task", () => {
		it("the handle reports the selection of the section on screen, null when nothing is selected", async () => {
			const m = await mountApp();
			const t = (await m.h.app.tasks.create({ title: "Pick me", scheduled: { kind: "date", date: "2026-10-01" } })).task;
			await settle();
			expect(m.handle.current!.selectedTaskId()).toBeNull();
			await click(m.root.querySelector(`.cp-tasks [data-task-id="${t.id}"]`));
			expect(m.handle.current!.selectedTaskId()).toBe(t.id);
			await click(m.root.querySelector('.cp-rail [aria-label="Calendar"]'));
			expect(m.handle.current!.selectedTaskId()).toBeNull();
			await click(m.root.querySelector('.cp-rail [aria-label="Tasks"]'));
			expect(m.handle.current!.selectedTaskId()).toBe(t.id);
		});
	});

	describe("accessibility", () => {
		it("announces phase changes only, never every second", async () => {
			const m = await mountApp();
			await m.h.app.focus.start(cfg(2, 60), null);
			const page = await openFocus(m);
			const live = page.querySelector<HTMLElement>('[role="status"][aria-live="polite"]')!;
			expect(live).not.toBeNull();
			const first = live.textContent;
			expect(first).toContain("Focus");
			const mutations: string[] = [];
			const observer = new MutationObserver(() => mutations.push(live.textContent ?? ""));
			observer.observe(live, { childList: true, characterData: true, subtree: true });
			await tickFor(m, 30);
			await settle();
			expect(mutations).toEqual([]);
			expect(live.textContent).toBe(first);
			await tickFor(m, 30);
			await settle();
			expect(live.textContent).toContain("Short break");
			observer.disconnect();
			expect(page.querySelector(".cp-focus-time")?.closest("[aria-live]")).toBeNull();
		});

		it("every icon button has an aria-label and container labels use aria-labelledby", async () => {
			const m = await mountApp();
			await finishedRound(m, null);
			const page = await openFocus(m);
			for (const b of page.querySelectorAll<HTMLButtonElement>("button.cp-icon-button")) {
				expect(b.getAttribute("aria-label")).toBeTruthy();
			}
			for (const el of page.querySelectorAll("section, [role='group'], ul")) expect(el.hasAttribute("aria-label")).toBe(false);
		});
	});

	describe("recovery banner", () => {
		/** Starts a ten-minute focus, "closes the app" after 30 s and reopens it ten minutes later. */
		async function interrupted(m: AppMount): Promise<void> {
			await m.h.app.focus.open();
			await m.h.app.focus.start(cfg(1, 600), null);
			await tickFor(m, 30);
			m.h.clock.advance(10 * 60_000);
			await m.h.app.focus.open();
		}

		it("shows Resume, Finish and Discard calling resolveRecovery", async () => {
			const m = await mountApp();
			await interrupted(m);
			const page = await openFocus(m);
			const banner = page.querySelector<HTMLElement>(".cp-focus-banner")!;
			expect(banner).not.toBeNull();
			expect(banner.textContent).toContain("10m");
			const spy = vi.spyOn(m.h.app.focus, "resolveRecovery");
			await pressButton(banner, "Finish and save");
			expect(spy).toHaveBeenCalledWith("finish");
			await settle();
			expect(page.querySelector(".cp-focus-banner")).toBeNull();
		});

		it("Discard asks first", async () => {
			const m = await mountApp();
			await interrupted(m);
			const page = await openFocus(m);
			const spy = vi.spyOn(m.h.app.focus, "resolveRecovery");
			await pressButton(page.querySelector<HTMLElement>(".cp-focus-banner")!, "Discard");
			expect(spy).not.toHaveBeenCalled(); // the fake host's choose() answers null (cancelled)
			m.host.choose = (async () => true) as unknown as typeof m.host.choose;
			await pressButton(page.querySelector<HTMLElement>(".cp-focus-banner")!, "Discard");
			expect(spy).toHaveBeenCalledWith("discard");
		});
	});

	describe("overview and history", () => {
		it("shows today's and all-time counts and focus time", async () => {
			const m = await mountApp();
			await finishedRound(m, null);
			await settle();
			const page = await openFocus(m);
			const heads = [...page.querySelectorAll(".cp-focus-stats thead th")].map((h) => h.textContent);
			expect(heads).toEqual(["Pomos", "Focused"]);
			const stats = [...page.querySelectorAll(".cp-focus-stat")].map((s) => [text(s, ".cp-focus-stat-label"), text(s, ".cp-focus-stat-count"), text(s, ".cp-focus-stat-value")]);
			expect(stats).toEqual([["Today", "1", "1m"], ["All time", "1", "1m"]]);
		});

		it("groups by day, newest first, then by set, with range, task, time and status", async () => {
			const m = await mountApp();
			const task = (await m.h.app.tasks.create({ title: "Write report" })).task;
			await finishedRound(m, task.id);
			m.h.clock.advance(24 * 3600_000);
			await finishedRound(m, null);
			await settle();
			const page = await openFocus(m);
			const days = [...page.querySelectorAll(".cp-focus-day")];
			expect(days.length).toBe(2);
			expect(text(days[0]!, ".cp-focus-day-name")).toBe("Today");
			expect(text(days[1]!, ".cp-focus-day-name")).toBe("Yesterday");
			// The day's focused total sits in the heading.
			expect(text(days[1]!, ".cp-focus-day-total")).toBe("1m");
			const set = days[1]!.querySelector(".cp-focus-set")!;
			expect(text(set, ".cp-focus-set-name")).toBe("Focus set · 1 of 1 round");
			expect(text(set, ".cp-focus-set-meta")).toMatch(/^\d\d:\d\d – \d\d:\d\d · done$/);
			expect(text(set, ".cp-focus-set-sum")).toBe("1m");
			expect(text(set, ".cp-focus-set-task")).toBe("Write report");
			const round = set.querySelector(".cp-focus-rec")!;
			expect(text(round, ".cp-focus-round-name")).toBe("Round 1");
			expect(text(round, ".cp-focus-round-status")).toMatch(/^\d\d:\d\d – \d\d:\d\d · Completed$/);
			expect(text(round, ".cp-focus-round-time")).toBe("1m");
			expect(text(days[0]!, ".cp-focus-set-task")).toBe("No task");
			expect(days[0]!.querySelector(".cp-focus-set-task")?.classList.contains("is-none")).toBe(true);
		});

		it("shows the live title, and the saved title with (deleted) once the task is in Trash", async () => {
			const m = await mountApp();
			const task = (await m.h.app.tasks.create({ title: "Old name" })).task;
			await finishedRound(m, task.id);
			await m.h.app.tasks.update(task.id, { title: "New name" });
			await settle();
			const page = await openFocus(m);
			expect(text(page, ".cp-focus-set-task")).toBe("New name");
			await m.h.app.tasks.delete(task.id);
			await settle();
			// The snapshot is the title when the round was saved.
			expect(text(page, ".cp-focus-set-task")).toBe("Old name (deleted)");
		});

		it("Include and Exclude a pending gap call includeGap, each with an Undo notice labelled as the store write", async () => {
			const m = await mountApp();
			await m.h.app.focus.open();
			await m.h.app.focus.start(cfg(1, 600), null);
			await tickFor(m, 30);
			m.h.clock.advance(5 * 60_000);
			await m.h.app.focus.open();
			await m.h.app.focus.resolveRecovery("finish");
			await settle();
			const page = await openFocus(m);
			const gap = page.querySelector<HTMLElement>(".cp-focus-gap")!;
			expect(gap.textContent).toContain("+5m unobserved, not counted");
			const spy = vi.spyOn(m.h.app.focus, "includeGap");
			const notify = vi.spyOn(m.host as unknown as { notifyUndo(message: string, label: string): void }, "notifyUndo");
			await pressButton(gap, "Include");
			expect(spy).toHaveBeenCalledWith(expect.any(String), 0, true);
			await settle();
			expect(text(page, ".cp-focus-round-time")).toBe("5m");
			expect(notify).toHaveBeenCalledTimes(1);
			expect(notify.mock.calls[0]![1]).toBe("Edit focus record");
			expect(m.h.app.store.undoLabel).toBe("Edit focus record");
			await pressButton(page.querySelector<HTMLElement>(".cp-focus-gap")!, "Exclude");
			expect(spy).toHaveBeenLastCalledWith(expect.any(String), 0, false);
			await settle();
			expect(notify).toHaveBeenCalledTimes(2);
			expect(notify.mock.calls[1]![1]).toBe(m.h.app.store.undoLabel);
		});

		it("Include and Exclude show an Undo notice labelled as the store write", async () => {
			const m = await mountApp();
			await m.h.app.focus.open();
			await m.h.app.focus.start(cfg(1, 600), null);
			await tickFor(m, 30);
			m.h.clock.advance(5 * 60_000);
			await m.h.app.focus.open();
			await m.h.app.focus.resolveRecovery("finish");
			await settle();
			const page = await openFocus(m);
			const notify = vi.spyOn(m.host as unknown as { notifyUndo(message: string, label: string): void }, "notifyUndo");
			await pressButton(page.querySelector<HTMLElement>(".cp-focus-gap")!, "Include");
			await settle();
			expect(notify).toHaveBeenCalledTimes(1);
			expect(notify.mock.calls[0]![1]).toBe("Edit focus record");
			expect(m.h.app.store.undoLabel).toBe("Edit focus record");
			await pressButton(page.querySelector<HTMLElement>(".cp-focus-gap")!, "Exclude");
			await settle();
			expect(notify).toHaveBeenCalledTimes(2);
			expect(notify.mock.calls[1]![1]).toBe(m.h.app.store.undoLabel);
		});

		it("the round menu offers Assign to task… when there is no task", async () => {
			const m = await mountApp();
			const task = (await m.h.app.tasks.create({ title: "Later task" })).task;
			await finishedRound(m, null);
			await settle();
			const page = await openFocus(m);
			await click(page.querySelector(".cp-focus-rec .cp-icon-button"));
			const menu = m.host.menus.at(-1)!;
			expect(menuTitles(menu)).toEqual(["Assign to task…", "Delete record"]);
			const item = menuItem(menu, "Assign to task…");
			m.host.pickTask = (async () => task.id) as unknown as typeof m.host.pickTask;
			item.run();
			await settle();
			const rec = [...m.h.app.store.state.focusSessions.values()][0]!;
			expect(rec.taskId).toBe(task.id);
			expect(text(page, ".cp-focus-set-task")).toBe("Later task");
		});
	});

	const menuTitles = (menu: MenuSpec): string[] => menu.flatMap((i) => (i === "separator" ? [] : [i.title]));

	describe("focus record tree", () => {
		/** A finished 2-round set of 60 s rounds on a task. */
		async function twoRounds(m: AppMount, taskId: string | null): Promise<void> {
			await m.h.app.focus.start(cfg(2, 60), taskId);
			await tickFor(m, 60 + 60 + 60);
		}

		it("a set shows its rounds as a tree: a heading, the task once, rounds with dots", async () => {
			const m = await mountApp();
			const task = (await m.h.app.tasks.create({ title: "Complete the long lesson on type hints" })).task;
			await twoRounds(m, task.id);
			const page = await openFocus(m);
			const sets = page.querySelectorAll(".cp-focus-set");
			expect(sets.length).toBe(1);
			expect(text(sets[0]!, ".cp-focus-set-name")).toBe("Focus set · 2 of 2 rounds");
			expect(text(sets[0]!, ".cp-focus-set-meta")).toMatch(/· done$/);
			expect(sets[0]!.querySelectorAll(".cp-focus-set-task").length).toBe(1);
			const rounds = [...sets[0]!.querySelectorAll(".cp-focus-rounds > li.cp-focus-rec")];
			expect(rounds.map((r) => text(r, ".cp-focus-round-name"))).toEqual(["Round 1", "Round 2"]);
			for (const r of rounds) {
				expect(r.querySelector(".cp-focus-status-dot")?.classList.contains("is-completed")).toBe(true);
				expect(r.querySelector(".cp-focus-round-task")).toBeNull();
			}
			expect(text(sets[0]!, ".cp-focus-set-sum")).toBe("2m");
		});

		it("a set folds with its heading button (aria-expanded), per view", async () => {
			const m = await mountApp();
			await twoRounds(m, null);
			const page = await openFocus(m);
			const head = page.querySelector<HTMLButtonElement>(".cp-focus-set-head")!;
			expect(head.getAttribute("aria-expanded")).toBe("true");
			await click(head);
			expect(head.getAttribute("aria-expanded")).toBe("false");
			expect(page.querySelector(".cp-focus-rounds")).toBeNull();
			expect(page.querySelector(".cp-focus-set-task")).toBeNull();
			// The heading keeps the summary when folded.
			expect(text(page, ".cp-focus-set-name")).toBe("Focus set · 2 of 2 rounds");
			await click(page.querySelector(".cp-focus-set-head"));
			expect(page.querySelector(".cp-focus-set-head")?.getAttribute("aria-expanded")).toBe("true");
			expect(page.querySelectorAll(".cp-focus-rec").length).toBe(2);
		});

		it("rounds with different tasks show their own task and the heading shows none", async () => {
			const m = await mountApp();
			const a = (await m.h.app.tasks.create({ title: "Task A" })).task;
			const b = (await m.h.app.tasks.create({ title: "Task B" })).task;
			await m.h.app.focus.start(cfg(1, 120), a.id);
			await tickFor(m, 60);
			await m.h.app.focus.split(b.id);
			await tickFor(m, 60);
			await settle();
			const page = await openFocus(m);
			expect(page.querySelector(".cp-focus-set-task")).toBeNull();
			const own = [...page.querySelectorAll(".cp-focus-round-task")].map((e) => e.textContent);
			expect(own).toEqual(["Task A", "Task B"]);
			// One round that was split, shown with the hollow dot.
			const dots = [...page.querySelectorAll(".cp-focus-rec .cp-focus-status-dot")].map((d) => d.className);
			expect(dots[0]).toContain("is-stopped");
			expect(dots[1]).toContain("is-completed");
		});

		it("a record without a set id shows as a set of its own", async () => {
			const m = await mountApp();
			await finishedRound(m, null);
			const rec = [...m.h.app.store.state.focusSessions.values()][0]!;
			const { setId: _s, setRounds: _r, ...old } = rec;
			await m.h.app.store.run("Edit focus record", (tx) => tx.put("focusSessions", old as typeof rec));
			await settle();
			const page = await openFocus(m);
			expect(text(page, ".cp-focus-set-name")).toBe("Focus set · 1 round");
			expect(page.querySelectorAll(".cp-focus-set").length).toBe(1);
		});

		it("the running set reads in progress; a finished early round says so with the half dot", async () => {
			const m = await mountApp();
			const page = await openFocus(m);
			await pressButton(page, "Start");
			await tickFor(m, 120);
			await pressButton(page, "Finish");
			const set = page.querySelector(".cp-focus-set")!;
			expect(text(set, ".cp-focus-set-meta")).toMatch(/· in progress$/);
			expect(text(set, ".cp-focus-round-status em")).toBe("Finished early");
			expect(set.querySelector(".cp-focus-status-dot")?.classList.contains("is-early")).toBe(true);
			expect(text(set, ".cp-focus-set-name")).toBe("Focus set · 1 of 4 rounds");
		});

		it("recovered and stopped rounds get their own dots", async () => {
			const m = await mountApp();
			await m.h.app.focus.open();
			await m.h.app.focus.start(cfg(1, 600), null);
			await tickFor(m, 30);
			m.h.clock.advance(5 * 60_000);
			await m.h.app.focus.open();
			await m.h.app.focus.resolveRecovery("finish");
			await settle();
			const page = await openFocus(m);
			expect(page.querySelector(".cp-focus-rec .cp-focus-status-dot")?.classList.contains("is-recovered")).toBe(true);
			expect(text(page, ".cp-focus-set-meta")).toMatch(/· recovered$/);
		});

		it("the legend lists four dots", async () => {
			const m = await mountApp();
			await finishedRound(m, null);
			const page = await openFocus(m);
			const legend = [...page.querySelectorAll(".cp-focus-legend span")].map((e) => [e.textContent, e.querySelector("i")?.className]);
			expect(legend).toEqual([
				["Completed", "cp-focus-status-dot is-completed"],
				["Finished early", "cp-focus-status-dot is-early"],
				["Stopped or split", "cp-focus-status-dot is-stopped"],
				["Recovered", "cp-focus-status-dot is-recovered"],
			]);
		});

		it("shows 50 rounds, whole sets only, and Show more adds the next page", async () => {
			const m = await mountApp();
			await finishedRound(m, null);
			const proto = [...m.h.app.store.state.focusSessions.values()][0]!;
			await m.h.app.store.run("Edit focus record", (tx) => {
				for (let i = 0; i < 54; i++) tx.put("focusSessions", { ...proto, id: `bulk-${i}`, setId: `bulk-set-${i}`, startedAt: new Date(Date.parse(proto.startedAt) - (i + 1) * 3600_000).toISOString() });
			});
			await settle();
			const page = await openFocus(m);
			expect(page.querySelectorAll(".cp-focus-rec").length).toBe(50);
			await pressButton(page, "Show more");
			expect(page.querySelectorAll(".cp-focus-rec").length).toBe(55);
			expect(page.querySelector(".cp-focus-more")).toBeNull();
		});
	});

	describe("round menu", () => {
		async function withTask(m: AppMount) {
			const task = (await m.h.app.tasks.create({ title: "Menu task" })).task;
			await finishedRound(m, task.id);
			await settle();
			return task;
		}
		const openMenu = async (page: HTMLElement, m: AppMount) => {
			await click(page.querySelector(".cp-focus-rec .cp-icon-button"));
			return m.host.menus.at(-1)!;
		};

		it("with a task: Change task…, Remove task, then Delete record in warning style", async () => {
			const m = await mountApp();
			await withTask(m);
			const page = await openFocus(m);
			const menu = await openMenu(page, m);
			expect(menuTitles(menu)).toEqual(["Change task…", "Remove task", "Delete record"]);
			expect(menu.indexOf("separator")).toBe(2);
			expect(menuItem(menu, "Delete record").warning).toBe(true);
		});

		type Notify = { notifyUndo(message: string, label: string): void };

		it("Change task… picks another task and Remove task clears it, each with an Undo notice labelled as the store write", async () => {
			const m = await mountApp();
			await withTask(m);
			const other = (await m.h.app.tasks.create({ title: "Other" })).task;
			const notify = vi.spyOn(m.host as unknown as Notify, "notifyUndo");
			const page = await openFocus(m);
			const pick = vi.fn(async () => other.id);
			m.host.pickTask = pick as unknown as typeof m.host.pickTask;
			menuItem(await openMenu(page, m), "Change task…").run();
			await settle();
			expect([...m.h.app.store.state.focusSessions.values()][0]?.taskId).toBe(other.id);
			expect(notify).toHaveBeenCalledTimes(1);
			expect(notify.mock.calls[0]![1]).toBe("Assign focus record");
			expect(m.h.app.store.undoLabel).toBe("Assign focus record");
			menuItem(await openMenu(page, m), "Remove task").run();
			await settle();
			expect([...m.h.app.store.state.focusSessions.values()][0]?.taskId).toBeNull();
			expect(text(page, ".cp-focus-set-task")).toBe("No task");
			expect(notify).toHaveBeenCalledTimes(2);
			expect(notify.mock.calls[1]![1]).toBe(m.h.app.store.undoLabel);
			await expect(m.host.undoButtons.at(-1)!()).resolves.toBe(true);
			await settle();
			expect([...m.h.app.store.state.focusSessions.values()][0]?.taskId).toBe(other.id);
		});

		it("Delete record removes it and the Undo notice carries the store's label; Undo brings it back", async () => {
			const m = await mountApp();
			await withTask(m);
			const notify = vi.spyOn(m.host as unknown as { notifyUndo(message: string, label: string): void }, "notifyUndo");
			const page = await openFocus(m);
			menuItem(await openMenu(page, m), "Delete record").run();
			await settle();
			expect(m.h.app.store.state.focusSessions.size).toBe(0);
			expect(page.querySelector(".cp-focus-set")).toBeNull();
			expect(notify).toHaveBeenCalledTimes(1);
			const label = notify.mock.calls[0]![1];
			expect(label).toBe("Delete focus record");
			expect(m.h.app.store.undoLabel).toBe(label);
			await expect(m.host.undoButtons.at(-1)!()).resolves.toBe(true);
			await settle();
			expect(m.h.app.store.state.focusSessions.size).toBe(1);
			expect(page.querySelectorAll(".cp-focus-set").length).toBe(1);
		});
	});

	describe("round menu while read-only", () => {
		it("offers no round actions", async () => {
			const m = await mountApp();
			await finishedRound(m, null);
			await settle();
			const page = await openFocus(m);
			expect(page.querySelector(".cp-focus-rec .cp-focus-round-more")).not.toBeNull();
			await makeReadOnly(m.h);
			m.h.app.store.notifyStatus();
			await settle();
			expect(page.querySelector(".cp-focus-rec")).not.toBeNull();
			expect(page.querySelector(".cp-focus-rec .cp-focus-round-more")).toBeNull();
		});
	});

	describe("Finish", () => {
		it("shows beside Stop during a focus round only, and moves to the break with a completed record", async () => {
			const m = await mountApp();
			const page = await openFocus(m);
			expect(buttonByText(page, "Finish")).toBeUndefined();
			await pressButton(page, "Start");
			await tickFor(m, 120);
			const names = [...page.querySelectorAll(".cp-focus-controls .cp-focus-ctl-cap")].map((e) => e.textContent);
			expect(names).toEqual(["Finish", "Pause", "Stop"]);
			await pressButton(page, "Finish");
			expect(m.h.app.focus.timer()?.phase).toBe("short-break");
			expect([...m.h.app.store.state.focusSessions.values()][0]?.status).toBe("completed");
			expect(buttonByText(page, "Finish")).toBeUndefined();
			const breakNames = [...page.querySelectorAll(".cp-focus-controls .cp-focus-ctl-cap")].map((e) => e.textContent);
			expect(breakNames).toEqual(["Skip break", "Pause", "Stop"]);
		});

		it("is hidden while the recovery banner waits", async () => {
			const m = await mountApp();
			await m.h.app.focus.start(cfg(1, 600), null);
			await tickFor(m, 30);
			m.h.clock.advance(5 * 60_000);
			await m.h.app.focus.open();
			const page = await openFocus(m);
			expect(buttonByText(page, "Finish")).toBeUndefined();
		});
	});

	describe("task entry points", () => {
		it("the details Focus button starts focus and shows the task's total", async () => {
			const m = await mountApp();
			const task = (await m.h.app.tasks.create({ title: "Deep work", scheduled: { kind: "date", date: "2026-10-01" } })).task;
			await settle();
			const startFocus = vi.fn(async () => undefined);
			m.host.startFocus = startFocus;
			await click(m.root.querySelector(".cp-tasks .cp-task-row .cp-task-title"));
			const foot = m.root.querySelector<HTMLElement>(".cp-details-foot")!;
			const button = foot.querySelector<HTMLButtonElement>(".cp-focus-button")!;
			expect(button.getAttribute("aria-disabled")).toBeNull();
			expect(foot.textContent).not.toContain("later update");
			expect(foot.querySelector(".cp-focus-total")).toBeNull();
			await click(button);
			expect(startFocus).toHaveBeenCalledWith(task.id);
			await finishedRound(m, task.id);
			expect(text(m.root.querySelector(".cp-details-foot")!, ".cp-focus-total")).toBe("1m focused");
		});

		it("a row shows a focus chip once the task has focus time, computing the totals once per state", async () => {
			const m = await mountApp();
			const one = (await m.h.app.tasks.create({ title: "Chip task", scheduled: { kind: "date", date: "2026-10-01" } })).task;
			await m.h.app.tasks.create({ title: "Plain task", scheduled: { kind: "date", date: "2026-10-01" } });
			await settle();
			const rows = () => [...m.root.querySelectorAll<HTMLElement>(".cp-tasks .cp-task-row")];
			expect(m.root.querySelector(".cp-meta-focus")).toBeNull();
			await finishedRound(m, one.id);
			const chip = rows().find((r) => r.textContent?.includes("Chip task"))!.querySelector(".cp-meta-focus")!;
			expect(chip.querySelector('[aria-hidden="true"]:not([data-icon])')?.textContent?.trim()).toBe("1m");
			expect(chip.querySelector(".cp-sr-only")?.textContent).toBe("1m focused");
			expect(rows().find((r) => r.textContent?.includes("Plain task"))!.querySelector(".cp-meta-focus")).toBeNull();
		});

		it("the row menu has Start focus", async () => {
			const m = await mountApp();
			const task = (await m.h.app.tasks.create({ title: "Menu task", scheduled: { kind: "date", date: "2026-10-01" } })).task;
			await settle();
			const startFocus = vi.fn(async () => undefined);
			m.host.startFocus = startFocus;
			m.root.querySelector(".cp-tasks .cp-task-row")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
			await settle();
			menuItem(m.host.menus.at(-1), "Start focus").run();
			expect(startFocus).toHaveBeenCalledWith(task.id);
		});
	});

	describe("useFocus", () => {
		it("unsubscribes from the bus when the component unmounts", async () => {
			const m = await mountApp();
			const offs: ReturnType<typeof vi.fn>[] = [];
			const bus = m.h.app.focus.bus;
			const original = bus.on.bind(bus);
			Object.assign(bus, {
				on: (event: never, listener: never) => {
					const off = vi.fn(original(event, listener));
					offs.push(off);
					return off;
				},
			});
			const root = document.createElement("div");
			function Probe() {
				useFocus(m.host, true);
				return <span />;
			}
			render(<Probe />, root);
			await settle();
			expect(offs.length).toBeGreaterThan(0);
			expect(offs.every((o) => o.mock.calls.length === 0)).toBe(true);
			render(null, root);
			expect(offs.every((o) => o.mock.calls.length === 1)).toBe(true);
		});
	});
});

describe("the set line", () => {
	it("writes the minutes as every duration is written", () => {
		const root = mountNode(<SetLine minutes={{ rounds: 2, focusMin: 90, breakMin: 5, longBreakMin: 15 }} />);
		expect(root.textContent).toBe("2 rounds · 1h 30m focus · 5m break");
		unmountAll();
	});
});

describe("focus minutes stepper", () => {
	// Issue 23: stepping the focus minutes down from a value that is not a multiple of 5 lands on the multiple of 5 below.

	/** The value one click gives, within 1..120. */
	const down = (value: number) => Math.max(1, value - stepFor(value, -1, true));
	const up = (value: number) => Math.min(120, value + stepFor(value, 1, true));

	it("steps by 5, by 1 at or below 5, and down from a value that is not a multiple of 5 to the multiple below; a field that is not coarse steps by 1", () => {
		const steps: ["down" | "up", number, number][] = [
			["down", 7, 5],
			["down", 6, 5],
			["down", 9, 5],
			["down", 11, 10],
			["down", 5, 4],
			["down", 4, 3],
			["down", 1, 1],
			["down", 25, 20],
			["down", 10, 5],
			["up", 3, 4],
			["up", 4, 5],
			["up", 5, 10],
			["up", 7, 12],
		];
		for (const [way, from, to] of steps) expect((way === "down" ? down : up)(from), `${way} from ${from}`).toBe(to);
		expect(stepFor(6, -1, false)).toBe(1);
		expect(stepFor(6, 1, false)).toBe(1);
	});
});
