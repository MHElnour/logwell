// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ARCHIVE_LABEL, CHECKIN_LABEL, DELETE_CHECKIN_LABEL, DELETE_HABIT_LABEL, EDIT_CHECKIN_LABEL, RESTORE_LABEL, UNCHECK_LABEL } from "../../src/app/HabitService";
import { makeReadOnly } from "../app/harness";
import { click, expectLabelsResolve, fill, keydown, lastNotice, menuItem, q, qa, settle, strayAriaLabels, text } from "./app-helpers";
import { type HabitMount, input, mountHabits, openHabits, rowOf, seedMockup } from "./habits-helpers";
import { parseAmount, plusLabel } from "../../src/ui/habits/format";
import { render } from "preact";
import { act } from "preact/test-utils";
import { useClockTime } from "../../src/ui/hooks";
import type { UiHost } from "../../src/ui/host";
import { Settings } from "luxon";

describe("Habits page", () => {
	// The Habits page in its main states.
	// The harness clock is the FakeClock; seedMockup moves it to Sunday 2026-10-04, 20:30 in Europe/Berlin.

	/** The mockup's habits are in place and the page is open. */
	async function page() {
		const m = await mountHabits();
		const habits = await seedMockup(m.h);
		await m.rerender();
		const el = await openHabits(m);
		return { m, habits, el };
	}

	const select = async (el: ParentNode, name: string) => click(q(rowOf(el, name), ".cp-habit-name"));
	/** The Undo notice carries the label the store holds, so pressing Undo works. */
	const labelIsStoreLabel = (m: HabitMount) => expect(lastNotice(m)?.label).toBe(m.h.app.store.undoLabel);

	describe("the rail, the empty state and the dialog entry points", () => {
		it("shows the first-visit state with four example chips that open the dialog prefilled and never create a habit", async () => {
			const m = await mountHabits();
			const el = await openHabits(m);
			expect(text(q(el, "h2"))).toBe("Habits");
			expect(text(q(el, ".cp-habit-empty h3"))).toBe("Build a habit, one day at a time");
			expect(qa(el, ".cp-habit-examples button").map(text)).toEqual(["Read 30 min a day", "Drink 8 glasses", "Meditate", "Gym 3 times a week"]);
			await click(qa(el, ".cp-habit-examples button")[0]);
			expect(m.dialogs).toHaveLength(1);
			const d = m.dialogs[0]!;
			expect(d.title).toBe("New habit");
			expect(d.submit).toBe("Create habit");
			expect(d.initial).toMatchObject({ name: "Read", goal: { type: "quantity", target: 30, unit: "min", period: "day" }, schedule: { kind: "daily" } });
			await click(qa(el, ".cp-habit-examples button")[3]);
			expect(m.dialogs[1]!.initial).toMatchObject({ name: "Gym", goal: { type: "binary", target: 3, period: "week" }, schedule: { kind: "weekly" } });
			expect(m.h.app.habits.list()).toHaveLength(0);
		});

		it("New habit opens an empty dialog; saving creates the habit, selects it and shows an Undo notice with the store label", async () => {
			const m = await mountHabits();
			const el = await openHabits(m);
			await click(q(el, ".cp-habits-head button"));
			const d = m.dialogs[0]!;
			expect(d.initial).toBeNull();
			expect(d.defaultColor).toBe("red");
			expect(await d.save(input({ name: "Stretch", goal: { type: "binary", target: 1, unit: null, period: "day" } }))).toBeNull();
			await settle();
			expect(m.h.app.habits.list().map((h) => h.name)).toEqual(["Stretch"]);
			expect(m.gestures.n).toBe(0);
			expect(text(q(el, ".cp-habit-detail h3"))).toBe("Stretch");
			expect(lastNotice(m)).toEqual({ message: "Created Stretch.", label: "New habit" });
			labelIsStoreLabel(m);
		});

		it("saving with a reminder on asks for the notification permission in that click; a refusal keeps the dialog open with the message", async () => {
			const m = await mountHabits();
			const el = await openHabits(m);
			await click(q(el, ".cp-habits-head button"));
			const d = m.dialogs[0]!;
			expect(await d.save(input({ name: "", reminder: { time: "20:00" } }))).toBe("Enter a name.");
			expect(m.gestures.n).toBe(1);
			expect(m.h.app.habits.list()).toHaveLength(0);
			expect(await d.save(input({ reminder: { time: "20:00" } }))).toBeNull();
			expect(m.gestures.n).toBe(2);
			await d.save(input({ name: "No reminder" }));
			expect(m.gestures.n).toBe(2);
		});
	});

	describe("the page in its states", () => {
		it("heads the page with the date and how many scheduled habits are done", async () => {
			const { el } = await page();
			expect(text(q(el, ".cp-habits-title"))).toBe("Habits");
			expect(text(q(el, ".cp-habits-sub"))).toBe("Sunday, Oct 4 · 1 of 4 done today");
			expect(text(q(el, ".cp-habits-head button"))).toBe("New habit");
		});

		it("groups habits under Morning, Afternoon, Evening and Anytime with 'n of m' and hides empty groups", async () => {
			const { m, el } = await page();
			const heads = qa(el, ".cp-habit-group-heading").map((h) => [text(q(h, ".cp-habit-group-name")), text(q(h, ".cp-habit-group-count")).replace(/^·\s*/u, "")]);
			expect(heads).toEqual([
				["Morning", "1 of 1"],
				["Afternoon", "0 of 1"],
				["Evening", "0 of 1"],
				["Anytime", "0 of 1"],
			]);
			// The group is named by its heading, with the count read as "· 1 of 1".
			const g = q(el, '.cp-habit-group[data-time-of-day="morning"]');
			expect(g.getAttribute("role")).toBe("group");
			expect(text(el.ownerDocument.getElementById(g.getAttribute("aria-labelledby")!))).toBe("Morning · 1 of 1");
			expect(qa(g, ".cp-habit-name").map(text)).toEqual(["Meditate"]);
			await m.h.app.habits.archive(m.h.app.habits.list().find((h) => h.name === "Meditate")!.id);
			await settle();
			expect(qa(el, ".cp-habit-group").map((x) => x.dataset.timeOfDay)).toEqual(["afternoon", "evening", "anytime"]);
		});

		it("shows the Now badge on the group of the clock time, moving with the clock and the Evening time setting", async () => {
			const { m, el } = await page();
			const now = () => qa(el, ".cp-habit-now").map((b) => b.closest<HTMLElement>(".cp-habit-group")!.dataset.timeOfDay);
			// 20:30 in Berlin, Evening time 20:00.
			expect(now()).toEqual(["evening"]);
			m.h.clock.set("2026-10-04T08:00:00.000Z");
			await m.rerender();
			expect(now()).toEqual(["morning"]);
			m.h.clock.set("2026-10-04T11:30:00.000Z");
			await m.rerender();
			expect(now()).toEqual(["afternoon"]);
			m.h.clock.set("2026-10-04T02:30:00.000Z");
			await m.rerender();
			// Before 05:00 it is still Evening; the Morning group exists but is not "now".
			expect(now()).toEqual(["evening"]);
			// Anytime never shows it.
			expect(qa(el, '.cp-habit-group[data-time-of-day="anytime"] .cp-habit-now')).toHaveLength(0);
		});

		it("moves the Evening start with the Evening time setting", async () => {
			const m = await mountHabits();
			const base = m.host.settings.bind(m.host);
			m.host.settings = () => ({ ...base(), eveningTime: "18:00" });
			await seedMockup(m.h);
			m.h.clock.set("2026-10-04T15:30:00.000Z"); // 17:30 in Berlin
			await m.rerender();
			const el = await openHabits(m);
			const now = () => qa(el, ".cp-habit-now").map((b) => b.closest<HTMLElement>(".cp-habit-group")!.dataset.timeOfDay);
			expect(now()).toEqual(["afternoon"]);
			m.h.clock.set("2026-10-04T16:00:00.000Z"); // 18:00
			await m.rerender();
			expect(now()).toEqual(["evening"]);
		});

		it("draws each row: icon color, name, streak with the flame, meta, bell, progress bar", async () => {
			const { el } = await page();
			const read = rowOf(el, "Read");
			expect(q(read, ".cp-habit-icon").className).toContain("cp-hue-purple");
			expect(q(read, ".cp-habit-icon [data-icon]").getAttribute("data-icon")).toBe("book-open");
			expect(text(q(read, ".cp-habit-streak"))).toBe("5 days");
			expect(q(read, ".cp-habit-streak [data-icon]").getAttribute("data-icon")).toBe("flame");
			expect(text(q(read, ".cp-habit-progress"))).toBe("20 of 30 min");
			expect(text(q(read, ".cp-habit-bell"))).toBe("20:00");
			expect(q(read, ".cp-habit-bar i").style.width).toBe("67%");
			// Done-or-not shows the schedule; a weekly habit its week; no streak at 0; no bell without a reminder.
			expect(text(q(rowOf(el, "Meditate"), ".cp-habit-progress"))).toBe("every day");
			expect(text(q(rowOf(el, "Gym"), ".cp-habit-progress"))).toBe("1 of 3 this week");
			expect(rowOf(el, "Gym").querySelector(".cp-habit-streak")).toBeNull();
			expect(rowOf(el, "Gym").querySelector(".cp-habit-bell")).toBeNull();
			expect(rowOf(el, "Gym").querySelector(".cp-habit-bar")).toBeNull();
			expect(text(q(rowOf(el, "Walk"), ".cp-habit-progress"))).toBe("Mon, Wed, Fri");
		});

		it("shows the control of each goal type and state", async () => {
			const { m, el } = await page();
			// Done or not: a round check, pressed when checked.
			const meditate = q<HTMLButtonElement>(rowOf(el, "Meditate"), ".cp-habit-check");
			expect(meditate.getAttribute("aria-pressed")).toBe("true");
			expect(rowOf(el, "Meditate").classList.contains("is-done")).toBe(true);
			const gym = q<HTMLButtonElement>(rowOf(el, "Gym"), ".cp-habit-check");
			expect(gym.getAttribute("aria-pressed")).toBe("false");
			// Count: "5 / 8" and +1.
			const water = rowOf(el, "Drink water");
			expect(text(q(water, ".cp-habit-count"))).toBe("5 / 8");
			expect(q(water, ".cp-habit-plus").getAttribute("aria-label")).toBe("Add one to Drink water");
			expect(text(q(water, ".cp-habit-plus"))).toBe("+1");
			expect(water.querySelector(".cp-habit-met")).toBeNull();
			// Amount: a number field with the unit and Add; the placeholder is a third of the target.
			const read = rowOf(el, "Read");
			const field = q<HTMLInputElement>(read, ".cp-habit-amount input");
			expect(field.getAttribute("inputmode")).toBe("decimal");
			expect(field.getAttribute("aria-label")).toBe("Min to add");
			expect(field.placeholder).toBe("10");
			expect(text(q(read, ".cp-habit-unit"))).toBe("min");
			expect(text(q(read, ".cp-habit-add"))).toBe("Add");
			// Not scheduled: text, no control.
			const walk = rowOf(el, "Walk");
			expect(text(q(walk, ".cp-habit-ctl"))).toBe("Not scheduled today");
			expect(walk.querySelector("button.cp-habit-check, input, .cp-habit-plus")).toBeNull();
			// A met count keeps its control and shows the green check mark.
			for (let i = 0; i < 3; i++) await m.h.app.habits.add(m.h.app.habits.list().find((h) => h.name === "Drink water")!.id, "2026-10-04", 1);
			await settle();
			expect(text(q(rowOf(el, "Drink water"), ".cp-habit-count"))).toBe("8 / 8");
			// The mark is not a labelled non-control: the icon is hidden from assistive tech and the words are text.
			const met = q(rowOf(el, "Drink water"), ".cp-habit-met");
			expect(met.hasAttribute("role")).toBe(false);
			expect(met.hasAttribute("aria-label")).toBe(false);
			expect(q(met, '[aria-hidden="true"] [data-icon]')).not.toBeNull();
			expect(text(q(met, ".cp-sr-only"))).toBe("Goal met");
			expect(rowOf(el, "Drink water").querySelector(".cp-habit-plus")).not.toBeNull();
			expect(rowOf(el, "Drink water").classList.contains("is-done")).toBe(true);
			// A met amount keeps its field too.
			await m.h.app.habits.add(m.h.app.habits.list().find((h) => h.name === "Read")!.id, "2026-10-04", 10);
			await settle();
			expect(q(rowOf(el, "Read"), ".cp-habit-met")).not.toBeNull();
			expect(rowOf(el, "Read").querySelector(".cp-habit-amount input")).not.toBeNull();
			expect(text(q(el, ".cp-habits-sub"))).toBe("Sunday, Oct 4 · 3 of 4 done today");
		});

		it("selects the first habit on screen by default, and the habit of a click", async () => {
			const { el } = await page();
			expect(text(q(el, ".cp-habit-detail h3"))).toBe("Meditate");
			expect(rowOf(el, "Meditate").classList.contains("is-selected")).toBe(true);
			await select(el, "Read");
			expect(text(q(el, ".cp-habit-detail h3"))).toBe("Read");
			expect(rowOf(el, "Read").classList.contains("is-selected")).toBe(true);
			expect(rowOf(el, "Meditate").classList.contains("is-selected")).toBe(false);
			expect(q(rowOf(el, "Read"), ".cp-habit-name").getAttribute("aria-current")).toBe("true");
		});
	});

	describe("the week strip and backfilling", () => {
		it("shows the seven days ending today with a ring share and a spoken label", async () => {
			const { el } = await page();
			const days = qa<HTMLButtonElement>(el, ".cp-habit-day");
			expect(days).toHaveLength(7);
			expect(days.map((d) => d.getAttribute("aria-label"))).toEqual([
				"Mon 28, 0% of habits done",
				"Tue 29, 25% of habits done",
				"Wed 30, 40% of habits done",
				"Thu 1, 50% of habits done",
				"Fri 2, 60% of habits done",
				"Sat 3, 50% of habits done",
				"Sun 4, 25% of habits done",
			]);
			expect(text(q(days[6]!, ".cp-habit-day-name"))).toBe("Today");
			expect(days[6]!.classList.contains("is-today")).toBe(true);
			expect(days.every((d) => !d.disabled)).toBe(true);
			const ring = q(days[1]!, ".cp-habit-ring-bar");
			expect(Number(ring.getAttribute("stroke-dashoffset"))).toBeCloseTo(2 * Math.PI * 16 * 0.75, 3);
			// The strip is a group named by a hidden label.
			const strip = q(el, ".cp-habit-week");
			expect(strip.hasAttribute("aria-label")).toBe(false);
			expect(text(el.ownerDocument.getElementById(strip.getAttribute("aria-labelledby")!))).toBe("This week");
		});

		it("a day without scheduled habits has an empty ring and says so", async () => {
			const m = await mountHabits();
			m.h.clock.set("2026-10-04T08:00:00.000Z");
			await m.h.app.habits.create(input({ name: "Gym", goal: { type: "binary", target: 1, unit: null, period: "day" }, schedule: { kind: "weekdays", days: ["MO"] } }));
			m.h.clock.set("2026-10-06T08:00:00.000Z");
			await m.rerender();
			const el = await openHabits(m);
			const days = qa<HTMLButtonElement>(el, ".cp-habit-day");
			// Oct 4 (Sun) is the habit's first day but not scheduled; Oct 5 is Monday.
			expect(days.map((d) => d.getAttribute("aria-label"))).toContain("Sun 4, no habits scheduled");
			expect(Number(q(days[4]!, ".cp-habit-ring-bar").getAttribute("stroke-dashoffset"))).toBeGreaterThan(100);
		});

		it("clicking a past day shows that day's list; Today and the selected day return", async () => {
			const { m, el } = await page();
			const days = () => qa<HTMLButtonElement>(el, ".cp-habit-day");
			await click(days()[5]);
			expect(text(q(el, ".cp-habits-sub"))).toBe("Saturday, Oct 3 · 2 of 4 done");
			expect(days()[5]!.getAttribute("aria-pressed")).toBe("true");
			expect(days()[5]!.classList.contains("is-selected")).toBe(true);
			expect(days()[6]!.getAttribute("aria-pressed")).toBe("false");
			// The Now badge belongs to today's list only; Walk has no control on a Saturday.
			expect(el.querySelector(".cp-habit-now")).toBeNull();
			expect(text(q(rowOf(el, "Walk"), ".cp-habit-ctl"))).toBe("Not scheduled Saturday");
			expect(text(q(rowOf(el, "Read"), ".cp-habit-progress"))).toBe("30 of 30 min");
			expect(q(rowOf(el, "Meditate"), ".cp-habit-check").getAttribute("aria-pressed")).toBe("true");
			await click(days()[5]);
			expect(text(q(el, ".cp-habits-sub"))).toBe("Sunday, Oct 4 · 1 of 4 done today");
			await click(days()[2]);
			expect(text(q(el, ".cp-habits-sub"))).toBe("Wednesday, Sep 30 · 2 of 5 done");
			await click(days()[6]);
			expect(text(q(el, ".cp-habits-sub"))).toBe("Sunday, Oct 4 · 1 of 4 done today");
			expect(m.host.messages).toEqual([]);
		});

		it("hides habits on days before they started", async () => {
			const { el } = await page();
			const days = qa<HTMLButtonElement>(el, ".cp-habit-day");
			await click(days[0]);
			expect(qa(el, ".cp-habit-name").map(text)).toContain("Read");
			// Every habit started on Monday the 28th: the day before has nothing, but it is outside the strip.
			expect(text(q(el, ".cp-habits-sub"))).toBe("Monday, Sep 28 · 0 of 5 done");
		});

		it("every write on a past day carries that date: amount, +1, check", async () => {
			const { m, el, habits } = await page();
			const index = () => m.h.app.habits.index();
			await click(qa(el, ".cp-habit-day")[3]); // Thursday Oct 1
			const field = q<HTMLInputElement>(rowOf(el, "Read"), ".cp-habit-amount input");
			fill(field, "10");
			await click(q(rowOf(el, "Read"), ".cp-habit-add"));
			expect(index().byDate(habits.read.id).get("2026-10-01")!.map((c) => c.value)).toEqual([30, 10]);
			expect(index().byDate(habits.read.id).get("2026-10-04")!.map((c) => c.value)).toEqual([20]);
			await click(q(rowOf(el, "Drink water"), ".cp-habit-plus"));
			expect(index().byDate(habits.water.id).get("2026-10-01")!.map((c) => c.value)).toEqual([1]);
			await click(q(rowOf(el, "Gym"), ".cp-habit-check"));
			expect(index().byDate(habits.gym.id).get("2026-10-01")).toHaveLength(1);
			expect(index().byDate(habits.gym.id).get("2026-10-04")).toBeUndefined();
		});

		it("through the page: yesterday keeps the goal it had when the target changes today", async () => {
			const m = await mountHabits();
			m.h.clock.set("2026-10-03T08:00:00.000Z");
			await m.h.app.habits.create(input());
			m.h.clock.set("2026-10-04T08:00:00.000Z");
			await m.rerender();
			const el = await openHabits(m);
			await click(qa(el, ".cp-habit-day")[5]); // yesterday
			for (const v of ["20", "10"]) {
				fill(q<HTMLInputElement>(rowOf(el, "Read"), ".cp-habit-amount input"), v);
				await click(q(rowOf(el, "Read"), ".cp-habit-add"));
			}
			expect(text(q(rowOf(el, "Read"), ".cp-habit-progress"))).toBe("30 of 30 min");
			// Edit the 10 to 5 in the log: not met any more.
			Object.assign(m.host, { prompt: async () => ({ value: "5" }) });
			const entries = qa(el, ".cp-habit-entry");
			expect(entries.map((e) => text(q(e, ".cp-habit-entry-value")).replace(/\d\d:\d\d|added later/u, "").trim())).toEqual(["+10 min", "+20 min"]);
			await click(q(entries[0]!, 'button[aria-label="Edit check-in"]'));
			expect(text(q(rowOf(el, "Read"), ".cp-habit-progress"))).toBe("25 of 30 min");
			// Edit the habit's target to 20 (a new version from today).
			await click(q(el, '.cp-habit-detail [aria-label="Edit habit"]'));
			const d = m.dialogs[0]!;
			expect(d.title).toBe("Edit habit");
			expect(d.submit).toBe("Save");
			expect(d.initial?.goal).toEqual({ type: "quantity", target: 30, unit: "min", period: "day" });
			expect(await d.save({ ...d.initial!, goal: { ...d.initial!.goal, target: 20 } })).toBeNull();
			await settle();
			// Yesterday is still measured against 30 (25 of 30), today against 20.
			expect(text(q(rowOf(el, "Read"), ".cp-habit-progress"))).toBe("25 of 30 min");
			expect(rowOf(el, "Read").classList.contains("is-done")).toBe(false);
			await click(qa(el, ".cp-habit-day")[6]);
			expect(text(q(rowOf(el, "Read"), ".cp-habit-progress"))).toBe("0 of 20 min");
			fill(q<HTMLInputElement>(rowOf(el, "Read"), ".cp-habit-amount input"), "20");
			await click(q(rowOf(el, "Read"), ".cp-habit-add"));
			expect(rowOf(el, "Read").classList.contains("is-done")).toBe(true);
			expect(m.h.app.habits.list()[0]!.versions.map((v) => [v.effectiveFrom, v.goal.target])).toEqual([
				["2026-10-03", 30],
				["2026-10-04", 20],
			]);
		});
	});

	describe("writes from the controls (every Undo notice carries the store's label)", () => {
		it("toggles a check on and off, and the Undo of the notice restores it", async () => {
			const { m, el, habits } = await page();
			const gym = () => q<HTMLButtonElement>(rowOf(el, "Gym"), ".cp-habit-check");
			await click(gym());
			expect(lastNotice(m)).toEqual({ message: "Checked in Gym.", label: CHECKIN_LABEL });
			labelIsStoreLabel(m);
			expect(gym().getAttribute("aria-pressed")).toBe("true");
			expect(text(q(rowOf(el, "Gym"), ".cp-habit-progress"))).toBe("2 of 3 this week");
			// Press the notice's Undo for real, as the host's button does.
			await expect(m.host.undoButtons.at(-1)!()).resolves.toBe(true);
			await settle();
			expect(gym().getAttribute("aria-pressed")).toBe("false");
			expect(m.h.app.habits.index().byDate(habits.gym.id).get("2026-10-04")).toBeUndefined();
			// Off: the notice and its label.
			await click(q(rowOf(el, "Meditate"), ".cp-habit-check"));
			expect(lastNotice(m)).toEqual({ message: "Removed the check-in.", label: UNCHECK_LABEL });
			labelIsStoreLabel(m);
			expect(q(rowOf(el, "Meditate"), ".cp-habit-check").getAttribute("aria-pressed")).toBe("false");
			await expect(m.host.undoButtons.at(-1)!()).resolves.toBe(true);
			await settle();
			expect(q(rowOf(el, "Meditate"), ".cp-habit-check").getAttribute("aria-pressed")).toBe("true");
		});

		it("two quick clicks on the check do on then off, never two check-ins", async () => {
			const { m, el, habits } = await page();
			const gym = q<HTMLButtonElement>(rowOf(el, "Gym"), ".cp-habit-check");
			gym.click();
			gym.click();
			await settle();
			expect(m.h.app.habits.index().byDate(habits.gym.id).get("2026-10-04")).toBeUndefined();
			expect(m.h.app.habits.index().active(habits.gym.id)).toHaveLength(1);
			expect(m.notices.map((n) => n.message)).toEqual(["Checked in Gym.", "Removed the check-in."]);
		});

		it("+1 adds a check-in each time: 5 / 8 becomes 7 / 8", async () => {
			const { m, el } = await page();
			const plus = () => q<HTMLButtonElement>(rowOf(el, "Drink water"), ".cp-habit-plus");
			await click(plus());
			await click(plus());
			expect(text(q(rowOf(el, "Drink water"), ".cp-habit-count"))).toBe("7 / 8");
			expect(m.notices.map((n) => n.message)).toEqual(["Checked in Drink water.", "Checked in Drink water."]);
			labelIsStoreLabel(m);
			expect(lastNotice(m)!.label).toBe(CHECKIN_LABEL);
		});

		it("Add and Enter submit the amount; the field clears; a wrong amount is told and nothing is written; a refused one stays in the field", async () => {
			const { m, el, habits } = await page();
			const field = () => q<HTMLInputElement>(rowOf(el, "Read"), ".cp-habit-amount input");
			const add = () => q(rowOf(el, "Read"), ".cp-habit-add");
			fill(field(), "10");
			await click(add());
			expect(text(q(rowOf(el, "Read"), ".cp-habit-progress"))).toBe("30 of 30 min");
			expect(field().value).toBe("");
			expect(lastNotice(m)).toEqual({ message: "Checked in Read.", label: CHECKIN_LABEL });
			fill(field(), "2,5");
			keydown(field(), "Enter");
			await settle();
			expect(text(q(rowOf(el, "Read"), ".cp-habit-progress"))).toBe("32.5 of 30 min");
			const before = m.notices.length;
			for (const bad of ["", "abc", "0", "-3"]) {
				fill(field(), bad);
				await click(add());
			}
			expect(m.notices).toHaveLength(before);
			expect(m.host.messages.filter((x) => x === "Enter an amount above 0.")).toHaveLength(4);
			expect(m.h.app.habits.index().active(habits.read.id)).toHaveLength(8);
			// A value the service refuses (too big) is shown by the host and kept in the field.
			fill(field(), "2000000");
			await click(add());
			expect(m.host.messages.at(-1)).toMatch(/at most 1,000,000/u);
			expect(field().value).toBe("2000000");
			// The refusal frees the button: the next amount is written.
			fill(field(), "4");
			await click(add());
			expect(field().value).toBe("");
			expect(m.h.app.habits.index().active(habits.read.id).at(-1)!.value).toBe(4);
		});

		it("a read-only database keeps the controls and shows the failure instead of an Undo notice", async () => {
			const { m, el } = await page();
			await makeReadOnly(m.h);
			await settle();
			const before = m.notices.length;
			await click(q(rowOf(el, "Gym"), ".cp-habit-check"));
			expect(m.notices).toHaveLength(before);
			expect(m.host.messages.length).toBeGreaterThan(0);
			expect(q(rowOf(el, "Gym"), ".cp-habit-check").getAttribute("aria-pressed")).toBe("false");
			// The ref is back in step with the store: the next click tries to check in again, not to remove.
			await click(q(rowOf(el, "Gym"), ".cp-habit-check"));
			expect(m.host.messages.filter((x) => /remove/iu.test(x))).toEqual([]);
		});
	});

	describe("the detail of the selected habit", () => {
		it("shows the goal in words, the four tiles and the buttons", async () => {
			const { el } = await page();
			await select(el, "Read");
			const d = q(el, ".cp-habit-detail");
			expect(d.tagName).toBe("ASIDE");
			expect(text(q(d, "h3"))).toBe("Read");
			expect(text(q(d, ".cp-habit-detail-title p"))).toBe("30 min a day · every day · since Sep 28");
			expect(qa(d, ".cp-habit-tile").map((t) => [text(q(t, ".cp-habit-tile-k")), text(q(t, ".cp-habit-tile-v"))])).toEqual([
				["Current streak", "5 days"],
				["Best streak", "5 days"],
				["This month", "3 of 4 days"],
				["Total", "2h 50m"],
			]);
			expect(q(d, ".cp-habit-tile").classList.contains("is-fire")).toBe(true);
			expect(qa(d, ":scope > .cp-habit-detail-head button").map((b) => b.getAttribute("aria-label"))).toEqual(["Edit habit", "More: archive, delete"]);
			expect(d.hasAttribute("aria-label")).toBe(false);
			expect(text(el.ownerDocument.getElementById(d.getAttribute("aria-labelledby")!))).toBe("Read");
		});

		it("words other goal types: times a week, counts and totals", async () => {
			const { el } = await page();
			await select(el, "Gym");
			expect(text(q(el, ".cp-habit-detail-title p"))).toBe("3 times a week · any days · since Sep 28");
			const tiles = qa(el, ".cp-habit-tile").map((t) => text(q(t, ".cp-habit-tile-v")));
			expect(tiles).toEqual(["0 weeks", "0 weeks", "0 of 0 weeks", "1 day"]);
			await select(el, "Drink water");
			expect(text(q(el, ".cp-habit-detail-title p"))).toBe("8 glasses a day · every day · since Sep 28");
			expect(text(qa(el, ".cp-habit-tile-v").at(-1))).toBe("5 glasses");
			await select(el, "Walk");
			expect(text(q(el, ".cp-habit-detail-title p"))).toBe("once a day · Mon, Wed, Fri · since Sep 28");
		});

		it("draws the month calendar from the habit's week start with the statuses, the legend and the arrows", async () => {
			const { m, el } = await page();
			await select(el, "Read");
			const title = () => text(q(el, ".cp-habit-month-title"));
			expect(title()).toBe("October 2026");
			expect(qa(el, ".cp-habit-wd").map(text)).toEqual(["M", "T", "W", "T", "F", "S", "S"]);
			// Thursday the 1st: three blanks before it and one after the 31st (a Saturday) to finish the week.
			expect(qa(el, ".cp-habit-cal > *").slice(7, 10).every((c) => c.classList.contains("is-blank"))).toBe(true);
			expect(qa(el, ".cp-habit-cal .is-blank")).toHaveLength(4);
			const cell = (label: string) => {
				const found = qa(el, ".cp-habit-cell").find((c) => c.querySelector(".cp-sr-only")?.textContent === label);
				if (found === undefined) throw new Error(`no calendar cell reads "${label}"`);
				return found;
			};
			expect(cell("Oct 1, goal met").classList.contains("is-met")).toBe(true);
			expect(cell("Oct 4, some progress").classList.contains("is-part")).toBe(true);
			expect(cell("Oct 4, some progress").classList.contains("is-today")).toBe(true);
			expect(cell("Oct 5, upcoming").classList.contains("is-fut")).toBe(true);
			expect(cell("Oct 31, upcoming")).toBeDefined();
			expect(text(cell("Oct 1, goal met")).startsWith("1")).toBe(true);
			expect(cell("Oct 1, goal met").hasAttribute("aria-label")).toBe(false);
			expect(cell("Oct 1, goal met").hasAttribute("role")).toBe(false);
			expect(qa(el, ".cp-habit-legend span").map(text)).toEqual(["Goal met", "Some progress", "Missed"]);
			// Back to September: the 28th was missed, the days before the habit are not days of it.
			const prev = q<HTMLButtonElement>(el, 'button[aria-label="Previous month"]');
			const next = q<HTMLButtonElement>(el, 'button[aria-label="Next month"]');
			expect(next.disabled).toBe(true);
			await click(prev);
			expect(title()).toBe("September 2026");
			expect(cell("Sep 28, missed").classList.contains("is-miss")).toBe(true);
			expect(cell("Sep 29, goal met")).toBeDefined();
			expect(cell("Sep 27, before the habit started").classList.contains("is-off")).toBe(true);
			expect(q<HTMLButtonElement>(el, 'button[aria-label="Previous month"]').disabled).toBe(true);
			await click(q(el, 'button[aria-label="Next month"]'));
			expect(title()).toBe("October 2026");
			// The week start of the habit's version heads the columns (Sunday first).
			expect(m.h.app.habits.list()).toHaveLength(5);
		});

		it("starts the calendar's columns on Sunday for a habit made with that week start", async () => {
			const m = await mountHabits();
			const settings = { weekStart: "SU" as const };
			(m.h.app as unknown as { settings: { weekStart: () => string } }).settings.weekStart = () => settings.weekStart;
			m.h.clock.set("2026-10-04T08:00:00.000Z");
			await m.h.app.habits.create(input({ goal: { type: "binary", target: 1, unit: null, period: "day" } }));
			await m.rerender();
			const el = await openHabits(m);
			expect(qa(el, ".cp-habit-wd").map(text)).toEqual(["S", "M", "T", "W", "T", "F", "S"]);
			// 2026-10-01 is a Thursday: four blanks before it with Sunday first.
			expect(qa(el, ".cp-habit-cal .is-blank")).toHaveLength(4);
		});

		it("lists check-ins newest first with the time or 'added later', and 50 at a time", async () => {
			const { m, el, habits } = await page();
			await select(el, "Read");
			const rows = qa(el, ".cp-habit-entry").map((e) => [text(q(e, ".cp-habit-entry-day")), text(q(e, ".cp-habit-entry-value"))]);
			expect(rows).toEqual([
				["Today", "+20 min20:30"],
				["Yesterday", "+30 minadded later"],
				["Fri, Oct 2", "+30 minadded later"],
				["Thu, Oct 1", "+30 minadded later"],
				["Wed, Sep 30", "+30 minadded later"],
				["Tue, Sep 29", "+30 minadded later"],
			]);
			// A done-or-not entry reads ✓ and cannot be edited; a count entry reads +1.
			await select(el, "Meditate");
			expect(qa(el, ".cp-habit-entry-value").map((e) => text(e)[0])).toEqual(Array(5).fill("✓"));
			expect(qa<HTMLButtonElement>(el, 'button[aria-label="Edit check-in"]').every((b) => b.disabled)).toBe(true);
			expect(qa<HTMLButtonElement>(el, 'button[aria-label="Delete check-in"]').every((b) => !b.disabled)).toBe(true);
			await select(el, "Drink water");
			expect(qa(el, ".cp-habit-entry-value").map((e) => text(e).slice(0, 2))).toEqual(Array(5).fill("+1"));
			// Fifty at a time.
			for (let i = 0; i < 52; i++) await m.h.app.habits.add(habits.water.id, "2026-10-04", 1);
			await settle();
			expect(qa(el, ".cp-habit-entry")).toHaveLength(50);
			await click(q(el, ".cp-habit-more"));
			expect(qa(el, ".cp-habit-entry")).toHaveLength(57);
			expect(el.querySelector(".cp-habit-more")).toBeNull();
		});

		it("edits and deletes a check-in through the log; each notice carries the store label", async () => {
			const { m, el, habits } = await page();
			await select(el, "Read");
			const entry = () => qa(el, ".cp-habit-entry")[0]!;
			let asked: unknown[] = [];
			Object.assign(m.host, {
				prompt: async (...a: unknown[]) => {
					asked = a;
					return { value: "25" };
				},
			});
			await click(q(entry(), 'button[aria-label="Edit check-in"]'));
			expect(asked[0]).toBe("Edit check-in");
			expect((asked[1] as { value: string }[])[0]!.value).toBe("20");
			expect(text(q(entry(), ".cp-habit-entry-value")).startsWith("+25 min")).toBe(true);
			expect(lastNotice(m)).toEqual({ message: "Edited the check-in.", label: EDIT_CHECKIN_LABEL });
			labelIsStoreLabel(m);
			// A cancelled prompt and an unchanged value write nothing.
			const n = m.notices.length;
			Object.assign(m.host, { prompt: async () => null });
			await click(q(entry(), 'button[aria-label="Edit check-in"]'));
			Object.assign(m.host, { prompt: async () => ({ value: "25" }) });
			await click(q(entry(), 'button[aria-label="Edit check-in"]'));
			expect(m.notices).toHaveLength(n);
			Object.assign(m.host, { prompt: async () => ({ value: "nope" }) });
			await click(q(entry(), 'button[aria-label="Edit check-in"]'));
			expect(m.notices).toHaveLength(n);
			expect(m.host.messages.at(-1)).toBe("Enter an amount above 0.");
			await click(q(entry(), 'button[aria-label="Delete check-in"]'));
			expect(lastNotice(m)).toEqual({ message: "Deleted the check-in.", label: DELETE_CHECKIN_LABEL });
			labelIsStoreLabel(m);
			expect(m.h.app.habits.index().active(habits.read.id)).toHaveLength(5);
			await expect(m.host.undoButtons.at(-1)!()).resolves.toBe(true);
			await settle();
			expect(qa(el, ".cp-habit-entry")).toHaveLength(6);
		});

		it("has more: archive and delete in a menu; Archive hides the habit and tells it", async () => {
			const { m, el, habits } = await page();
			await select(el, "Read");
			await click(q(el, '[aria-label="More: archive, delete"]'));
			const menu = m.host.menus.at(-1)!;
			expect(menu.map((i) => (i === "separator" ? "-" : i.title))).toEqual(["Archive", "-", "Delete habit…"]);
			expect(menuItem(menu, "Delete habit…")).toMatchObject({ warning: true });
			menuItem(menu, "Archive").run();
			await settle();
			expect(lastNotice(m)).toEqual({ message: "Archived Read.", label: ARCHIVE_LABEL });
			labelIsStoreLabel(m);
			expect(qa(el, ".cp-habit-name").map(text)).not.toContain("Read");
			expect(m.h.app.habits.list().find((h) => h.id === habits.read.id)!.archivedAt).not.toBeNull();
			// The selection moved to a habit that is still shown.
			expect(text(q(el, ".cp-habit-detail h3"))).not.toBe("Read");
		});

		it("Delete asks first with the check-in count, then deletes the habit and its check-ins with Undo", async () => {
			const { m, el, habits } = await page();
			await select(el, "Read");
			const asked: unknown[][] = [];
			Object.assign(m.host, {
				choose: async (...a: unknown[]) => {
					asked.push(a);
					return null;
				},
			});
			await click(q(el, '[aria-label="More: archive, delete"]'));
			menuItem(m.host.menus.at(-1), "Delete habit…").run();
			await settle();
			expect(asked[0]![1]).toBe('Delete "Read" and its 6 check-ins? Archive keeps the history.');
			expect(m.h.app.habits.list()).toHaveLength(5);
			// Dismissed: nothing deleted. Confirmed: gone, with the notice.
			Object.assign(m.host, { choose: async () => true });
			menuItem(m.host.menus.at(-1), "Delete habit…").run();
			await settle();
			expect(m.h.app.habits.list().map((h) => h.id)).not.toContain(habits.read.id);
			expect(lastNotice(m)).toEqual({ message: "Deleted Read and its 6 check-ins.", label: DELETE_HABIT_LABEL });
			labelIsStoreLabel(m);
			expect(m.h.app.habits.index().active(habits.read.id)).toHaveLength(0);
			await expect(m.host.undoButtons.at(-1)!()).resolves.toBe(true);
			await settle();
			expect(m.h.app.habits.list().map((h) => h.id)).toContain(habits.read.id);
			expect(m.h.app.habits.index().active(habits.read.id)).toHaveLength(6);
			expect(qa(el, ".cp-habit-name").map(text)).toContain("Read");
		});

		it("Edit opens the dialog prefilled; saving shows a notice and keeps the selection", async () => {
			const { m, el } = await page();
			await select(el, "Read");
			await click(q(el, '[aria-label="Edit habit"]'));
			const d = m.dialogs.at(-1)!;
			expect(d.initial).toMatchObject({ name: "Read", icon: "book-open", color: "purple", timeOfDay: "evening", reminder: { time: "20:00" } });
			expect(await d.save({ ...d.initial!, name: "Read more" })).toBeNull();
			await settle();
			expect(lastNotice(m)).toEqual({ message: "Saved Read more.", label: "Edit habit" });
			labelIsStoreLabel(m);
			expect(text(q(el, ".cp-habit-detail h3"))).toBe("Read more");
			// Nothing changed: no write and no notice.
			const n = m.notices.length;
			expect(await d.save({ ...d.initial!, name: "Read more" })).toBeNull();
			expect(m.notices).toHaveLength(n);
		});
	});

	describe("archived habits", () => {
		it("hides the footer button when nothing is archived and counts archived habits otherwise", async () => {
			const { m, el, habits } = await page();
			expect(el.querySelector(".cp-habits-foot")).toBeNull();
			await m.h.app.habits.archive(habits.walk.id);
			await settle();
			expect(text(q(el, ".cp-habits-foot button"))).toBe("Archived habits (1)");
			// Archived habits leave the groups, the counts and the strip shares.
			expect(qa(el, ".cp-habit-name").map(text)).not.toContain("Walk");
		});

		it("shows the archived list with Restore, and the detail of an archived habit without check-in controls", async () => {
			const { m, el, habits } = await page();
			await m.h.app.habits.archive(habits.read.id);
			await settle();
			await click(q(el, ".cp-habits-foot button"));
			expect(text(q(el, ".cp-habits-sub"))).toBe("Archived habits");
			expect(el.querySelector(".cp-habit-week")).toBeNull();
			const rows = qa(el, ".cp-habit-row");
			expect(rows.map((r) => text(q(r, ".cp-habit-name")))).toEqual(["Read"]);
			expect(text(q(rows[0]!, ".cp-habit-restore"))).toBe("Restore");
			expect(rows[0]!.querySelector(".cp-habit-amount, .cp-habit-check, .cp-habit-plus")).toBeNull();
			expect(text(q(el, ".cp-habit-detail h3"))).toBe("Read");
			// The log of an archived habit is shown, but cannot be changed (the service refuses).
			expect(qa(el, ".cp-habit-entry")).toHaveLength(6);
			expect(el.querySelector('.cp-habit-entry [aria-label="Delete check-in"]')).toBeNull();
			await click(q(el, '[aria-label="More: archive, delete"]'));
			const menu = m.host.menus.at(-1)!;
			expect(menu.map((i) => (i === "separator" ? "-" : i.title))).toEqual(["Restore", "-", "Delete habit…"]);
			await click(q(rows[0]!, ".cp-habit-restore"));
			expect(lastNotice(m)).toEqual({ message: "Restored Read.", label: RESTORE_LABEL });
			labelIsStoreLabel(m);
			// The last archived habit is back: the page leaves the archived list by itself.
			expect(el.querySelector(".cp-habits-foot")).toBeNull();
			expect(qa(el, ".cp-habit-name").map(text)).toContain("Read");
		});

		it("the footer button returns from the archived list", async () => {
			const { m, el, habits } = await page();
			await m.h.app.habits.archive(habits.walk.id);
			await settle();
			await click(q(el, ".cp-habits-foot button"));
			expect(text(q(el, ".cp-habits-foot button"))).toBe("Back to habits");
			await click(q(el, ".cp-habits-foot button"));
			expect(el.querySelector(".cp-habit-week")).not.toBeNull();
		});

		it("says so when every habit is archived", async () => {
			const { m, el } = await page();
			for (const h of m.h.app.habits.list()) await m.h.app.habits.archive(h.id);
			await settle();
			expect(text(q(el, ".cp-habit-none"))).toMatch(/^No active habits/u);
			expect(text(q(el, ".cp-habits-foot button"))).toBe("Archived habits (5)");
			expect(el.querySelector(".cp-habit-detail")).toBeNull();
		});
	});

	describe("showHabit and the handle", () => {
		it("opens the section with the habit selected, an archived one in the archived list", async () => {
			const { m, el, habits } = await page();
			await click(m.root.querySelector('.cp-rail [aria-label="Tasks"]'));
			m.handle.current!.showHabit(habits.water.id);
			await settle();
			expect(q(el, ".cp-habit-detail h3").textContent).toBe("Drink water");
			expect(el.closest<HTMLElement>(".cp-section")!.hidden).toBe(false);
			await m.h.app.habits.archive(habits.gym.id);
			await settle();
			m.handle.current!.showHabit(habits.gym.id);
			await settle();
			expect(text(q(el, ".cp-habits-sub"))).toBe("Archived habits");
			expect(text(q(el, ".cp-habit-detail h3"))).toBe("Gym");
		});

		it("focusControl focuses the row's control after the render: the amount field, the check, or the name when there is none", async () => {
			const { m, el, habits } = await page();
			await click(m.root.querySelector('.cp-rail [aria-label="Tasks"]'));
			m.handle.current!.showHabit(habits.read.id, true);
			await settle();
			expect(el.ownerDocument.activeElement).toBe(q(rowOf(el, "Read"), ".cp-habit-amount input"));
			m.handle.current!.showHabit(habits.gym.id, true);
			await settle();
			expect(el.ownerDocument.activeElement).toBe(q(rowOf(el, "Gym"), ".cp-habit-check"));
			m.handle.current!.showHabit(habits.walk.id, true);
			await settle();
			expect(el.ownerDocument.activeElement).toBe(q(rowOf(el, "Walk"), ".cp-habit-name"));
			// Without the flag focus stays where it is.
			(el.ownerDocument.activeElement as HTMLElement).blur();
			m.handle.current!.showHabit(habits.read.id);
			await settle();
			expect(el.ownerDocument.activeElement).not.toBe(q(rowOf(el, "Read"), ".cp-habit-amount input"));
		});
	});

	describe("pending writes and the first month", () => {
		it("a second Enter or click on Add while the first write is pending is ignored, and the field clears only after success", async () => {
			const { m, el, habits } = await page();
			const real = m.h.app.habits.add.bind(m.h.app.habits);
			let release!: () => void;
			const gate = new Promise<void>((r) => (release = r));
			let calls = 0;
			m.h.app.habits.add = async (...args: Parameters<typeof real>) => {
				calls++;
				await gate;
				return real(...args);
			};
			const field = () => q<HTMLInputElement>(rowOf(el, "Read"), ".cp-habit-amount input");
			fill(field(), "10");
			keydown(field(), "Enter");
			keydown(field(), "Enter");
			await click(q(rowOf(el, "Read"), ".cp-habit-add"));
			await settle();
			expect(calls).toBe(1);
			// Still pending: the amount stays in the field.
			expect(field().value).toBe("10");
			release();
			await settle();
			expect(calls).toBe(1);
			expect(m.h.app.habits.index().byDate(habits.read.id).get("2026-10-04")!.map((c) => c.value)).toEqual([20, 10]);
			expect(field().value).toBe("");
			expect(m.notices.filter((n) => n.message === "Checked in Read.")).toHaveLength(1);
			// Free again: a later amount is written.
			fill(field(), "5");
			await click(q(rowOf(el, "Read"), ".cp-habit-add"));
			expect(calls).toBe(2);
			expect(m.h.app.habits.index().byDate(habits.read.id).get("2026-10-04")!.map((c) => c.value)).toEqual([20, 10, 5]);
		});

		it("a habit that started later than the shown month shows its own first month, with Previous disabled and Next following today", async () => {
			const { m, el } = await page();
			await select(el, "Read");
			await click(q(el, 'button[aria-label="Previous month"]'));
			expect(text(q(el, ".cp-habit-month-title"))).toBe("September 2026");
			m.h.clock.set("2026-11-12T10:00:00.000Z");
			await m.h.app.habits.create(input({ name: "Late" }));
			await m.rerender();
			// Read is September-based, so the shared month still shows September for it.
			expect(text(q(el, ".cp-habit-month-title"))).toBe("September 2026");
			await select(el, "Late");
			expect(text(q(el, ".cp-habit-detail h3"))).toBe("Late");
			expect(text(q(el, ".cp-habit-month-title"))).toBe("November 2026");
			expect(q<HTMLButtonElement>(el, 'button[aria-label="Previous month"]').disabled).toBe(true);
			expect(q<HTMLButtonElement>(el, 'button[aria-label="Next month"]').disabled).toBe(true);
			expect(qa(el, ".cp-habit-cell:not(.is-blank)").length).toBe(30);
		});
	});

	describe("accessibility", () => {
		it("names every container with aria-labelledby (never aria-label) and resolves every reference", async () => {
			const { m, el, habits } = await page();
			// A met count and a met amount show the goal-met mark; the log and a detail are open for the selected habit.
			for (let i = 0; i < 3; i++) await m.h.app.habits.add(habits.water.id, "2026-10-04", 1);
			await m.h.app.habits.add(habits.read.id, "2026-10-04", 10);
			await settle();
			expect(el.querySelectorAll(".cp-habit-met").length).toBeGreaterThan(0);
			// Only real controls carry an aria-label (Obsidian turns any other one into a hover tooltip).
			expect(strayAriaLabels(el, ["button", "input", "select", "a"])).toEqual([]);
			expectLabelsResolve(el);
		});

		it("keeps every control a real button or input in the tab order and the toggles aria-pressed", async () => {
			const { el } = await page();
			for (const b of el.querySelectorAll<HTMLElement>(".cp-habit-check, .cp-habit-day")) {
				expect(b.tagName).toBe("BUTTON");
				expect(b.hasAttribute("aria-pressed")).toBe(true);
				expect(b.tabIndex).toBeGreaterThanOrEqual(0);
			}
			for (const b of el.querySelectorAll<HTMLElement>("button")) {
				expect(b.textContent.trim() !== "" || b.hasAttribute("aria-label"), b.className).toBe(true);
			}
			expect(qa(el, ".cp-habit-row").every((r) => r.querySelector("button.cp-habit-name") !== null)).toBe(true);
		});
	});

	describe("global search", () => {
		async function search(m: HabitMount, query: string): Promise<HTMLElement> {
			await click(m.root.querySelector('.cp-rail [aria-label="Search"]'));
			const box = q<HTMLInputElement>(m.root, '.cp-search input[type="search"]');
			fill(box, query);
			await settle();
			return q(m.root, ".cp-search");
		}

		it("shows a Habits group between Lists and Tasks; a result opens the Habits page on that habit", async () => {
			const { m, habits } = await page();
			await m.h.app.categories.create("Reading list", "book-open");
			await m.h.app.tasks.create({ title: "Read the report" });
			await m.h.app.habits.archive(habits.walk.id);
			await settle();
			const el = await search(m, "read");
			// The box says habits are searched too.
			const box = q<HTMLInputElement>(el, 'input[type="search"]');
			expect(box.placeholder).toBe("Search tasks, lists and habits");
			expect(box.getAttribute("aria-label")).toBe("Search tasks, lists and habits");
			const groups = qa(el, "section.cp-search-group").map((g) => text(el.ownerDocument.getElementById(g.getAttribute("aria-labelledby")!)));
			expect(groups).toEqual(["Lists", "Habits", "Tasks"]);
			const habitGroup = qa(el, "section.cp-search-group")[1]!;
			expect(habitGroup.hasAttribute("aria-label")).toBe(false);
			expect(qa(habitGroup, "button").map(text)).toEqual(["Read"]);
			await click(q(habitGroup, "button"));
			const section = q(m.root, ".cp-habits").closest<HTMLElement>(".cp-section")!;
			expect(section.hidden).toBe(false);
			expect(text(q(m.root, ".cp-habit-detail h3"))).toBe("Read");
		});

		it("includes archived habits with an Archived tag, and no group when nothing matches", async () => {
			const { m, habits } = await page();
			await m.h.app.habits.archive(habits.walk.id);
			await settle();
			const el = await search(m, "walk");
			const g = q(el, "section.cp-search-group");
			expect(text(q(g, "li"))).toBe("WalkArchived");
			await click(q(g, "button"));
			expect(text(q(m.root, ".cp-habits-sub"))).toBe("Archived habits");
			expect(text(q(m.root, ".cp-habit-detail h3"))).toBe("Walk");
			const blank = await search(m, "");
			expect(text(q(blank, ".cp-empty-text"))).toBe("Type to search task titles, list names and habit names.");
			const none = await search(m, "zzzz");
			expect(none.querySelector(".cp-search-habits")).toBeNull();
		});
	});
});

// What a person may type as an amount, and the "+1" button's name.

describe("parseAmount", () => {
	it("takes digits with a point or a decimal comma and at most 6 decimals", () => {
		expect(parseAmount("10")).toBe(10);
		expect(parseAmount(" 1.5 ")).toBe(1.5);
		expect(parseAmount("1,5")).toBe(1.5);
		expect(parseAmount("2,25")).toBe(2.25);
		expect(parseAmount("0,000001")).toBe(0.000001);
		expect(parseAmount("007")).toBe(7);
		expect(parseAmount("30")).toBe(30);
		expect(parseAmount("2.5")).toBe(2.5);
		expect(parseAmount("0.5")).toBe(0.5);
		expect(parseAmount("2,5")).toBe(2.5);
		expect(parseAmount("0.25")).toBe(0.25);
	});

	it("refuses a thousands separator, exponents, prefixes, signs, zero, empty and words", () => {
		for (const bad of ["10,000", "10.000", "1,000", "1.000", "0.001", "1e3", "1E3", "0x10", "", "  ", "abc", "0", "0,0", "-3", "+3", "1.", ".5", "1,5,5", "1.5.5", "1 000", "Infinity", "NaN", "1,0000001"]) {
			expect(parseAmount(bad), JSON.stringify(bad)).toBeNull();
		}
	});

	it("a separator followed by other than exactly three digits is a decimal", () => {
		expect(parseAmount("1,50")).toBe(1.5);
		expect(parseAmount("1,5000")).toBe(1.5);
		expect(parseAmount("1.5000")).toBe(1.5);
	});
});

describe("plusLabel", () => {
	it("names the habit, whatever its unit", () => {
		expect(plusLabel("Drink water")).toBe("Add one to Drink water");
		expect(plusLabel("Push-ups")).toBe("Add one to Push-ups");
	});
});

describe("the clock of the Now badge", () => {
	// The clock the Habits page's "Now" badge reads.

	let now = new Date("2026-10-04T18:30:10.000Z");
	const host = { app: { clock: { now: () => now } } } as unknown as UiHost;

	function Probe(props: { zone: string; seen: string[] }) {
		const time = useClockTime(host, props.zone);
		props.seen.push(time);
		return <span class="t">{time}</span>;
	}

	let root: HTMLElement;
	beforeEach(() => {
		vi.useFakeTimers();
		now = new Date("2026-10-04T18:30:10.000Z");
		root = document.createElement("div");
		document.body.appendChild(root);
	});
	afterEach(async () => {
		await act(() => render(null, root));
		root.remove();
		vi.useRealTimers();
	});

	describe("useClockTime", () => {
		it("reads the wall time in the zone and re-renders when the minute changes, not before", async () => {
			const seen: string[] = [];
			await act(() => render(<Probe zone="Europe/Berlin" seen={seen} />, root));
			expect(root.textContent).toBe("20:30");
			const renders = seen.length;
			// Same minute: the poll runs but nothing re-renders.
			now = new Date("2026-10-04T18:30:40.000Z");
			await act(() => {
				vi.advanceTimersByTime(30_000);
			});
			expect(seen).toHaveLength(renders);
			// The next minute: the next poll re-renders with the new time.
			now = new Date("2026-10-04T18:31:05.000Z");
			await act(() => {
				vi.advanceTimersByTime(30_000);
			});
			expect(root.textContent).toBe("20:31");
			expect(seen.length).toBeGreaterThan(renders);
		});

		it("#100: reads the wall time with the digits 0 to 9 on a device whose language writes other digits", async () => {
			const before = Settings.defaultLocale;
			Settings.defaultLocale = "ar-EG";
			try {
				await act(() => render(<Probe zone="Europe/Berlin" seen={[]} />, root));
				expect(root.textContent).toBe("20:30");
			} finally {
				Settings.defaultLocale = before;
			}
		});

		it("clears its interval when the component unmounts", async () => {
			const seen: string[] = [];
			const base = vi.getTimerCount();
			await act(() => render(<Probe zone="Europe/Berlin" seen={seen} />, root));
			expect(vi.getTimerCount()).toBe(base + 1);
			await act(() => render(null, root));
			expect(vi.getTimerCount()).toBe(base);
			// A later minute does not render a removed component.
			const renders = seen.length;
			now = new Date("2026-10-04T18:45:00.000Z");
			await act(() => {
				vi.advanceTimersByTime(60_000);
			});
			expect(seen).toHaveLength(renders);
		});
	});
});
