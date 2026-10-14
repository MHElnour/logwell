// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DateSpec } from "../../src/domain/types";
import { LABEL_PEEK_PX } from "../../src/ui/calendar/geometry";
import { checkedOf, menuTitles, openViewMenu, pickItem, viewButton } from "./view-menu-helpers";
import { type AppMount, at, byLabel, click, day, dragTo, expectLabelsResolve, keydown, mountApp, q, recordNotices, settle, strayAriaLabels } from "./app-helpers";
import { cal, cell, entries, entry, entryName, openCalendar, stubWeek, title, weekDates } from "./calendar-helpers";
import { fmtMin, monthTitle, shiftAnchor, weekTitle } from "../../src/ui/calendar/format";

describe("calendar section", () => {
	// The calendar section. Needs the real src/domain/calendar.ts.

	afterEach(() => {
		vi.useRealTimers();
	});

	const iconOf = (el: Element | null) => el?.querySelector("[data-icon]")?.getAttribute("data-icon");

	async function seed(m: AppMount) {
		const T = m.h.app.tasks;
		await T.create({ title: "Dentist", scheduled: day("2026-10-01") });
		await T.create({ title: "Standup", scheduled: at("2026-10-01", "19:00"), plannedDurationMin: 45 });
		await T.create({ title: "Quick call", scheduled: at("2026-10-02", "09:00") });
		await T.create({ title: "Report", deadline: day("2026-10-03") });
		await T.create({ title: "Old", scheduled: day("2026-09-29") });
		await T.create({ title: "Late report", deadline: day("2026-09-30") });
		await T.create({ title: "Earlier", scheduled: at("2026-10-01", "08:00"), plannedDurationMin: 30 });
		const done = await T.create({ title: "Done", scheduled: day("2026-10-01") });
		await T.complete(done.task.id);
		await settle();
	}

	const buttons = (root: HTMLElement) => [...cal(root).querySelectorAll<HTMLButtonElement>(".cp-cal-header button")];
	const modeButton = (root: HTMLElement, label: "Week" | "Month") => buttons(root).find((b) => b.textContent === label)!;

	describe("rail and section state", () => {
		it("keeps mode, anchor, selection and the unscheduled drawer while switching sections", async () => {
			const m = await mountApp();
			await seed(m);
			await openCalendar(m);
			await click(byLabel(cal(m.root), "Next week"));
			await click(modeButton(m.root, "Month"));
			await click(byLabel(cal(m.root), "Next month"));
			expect(title(m.root)).toBe("November 2026");
			await click(m.root.querySelector('.cp-rail [aria-label="Tasks"]'));
			await click(m.root.querySelector('.cp-rail [aria-label="Search"]'));
			await click(byLabel(m.root, "Calendar"));
			expect(title(m.root)).toBe("November 2026");
			expect(modeButton(m.root, "Month").getAttribute("aria-pressed")).toBe("true");

			await click(byLabel(cal(m.root), "Today"));
			await click(modeButton(m.root, "Week"));
			await click(entry(cal(m.root), "Dentist"));
			expect(cal(m.root).querySelector(".cp-details")).not.toBeNull();
			await click(m.root.querySelector('.cp-rail [aria-label="Tasks"]'));
			await click(byLabel(m.root, "Calendar"));
			expect(cal(m.root).querySelector<HTMLTextAreaElement>(".cp-details-title")?.value).toBe("Dentist");
		});

		it("keeps the view menu choices while switching sections", async () => {
			const m = await mountApp();
			await openCalendar(m);
			let menu = await openViewMenu(m, cal(m.root));
			expect(checkedOf(menu, "Show completed")).toBe(false);
			await pickItem(m, menu, "Show completed");
			await click(m.root.querySelector('.cp-rail [aria-label="Tasks"]'));
			await click(byLabel(m.root, "Calendar"));
			menu = await openViewMenu(m, cal(m.root));
			expect(checkedOf(menu, "Show completed")).toBe(true);
		});
	});

	describe("header navigation", () => {
		it("title and buttons: week mode", async () => {
			const m = await mountApp();
			await openCalendar(m);
			expect(title(m.root)).toBe("Sep 28 – Oct 4, 2026");
			for (const label of ["Previous week", "Next week", "Today"]) {
				const b = byLabel(cal(m.root), label)!;
				expect(b.tagName).toBe("BUTTON");
			}
			expect(iconOf(byLabel(cal(m.root), "Previous week"))).toBeTruthy();
			expect(modeButton(m.root, "Week").getAttribute("aria-pressed")).toBe("true");
			expect(modeButton(m.root, "Month").getAttribute("aria-pressed")).toBe("false");
			await click(byLabel(cal(m.root), "Next week"));
			expect(title(m.root)).toBe("Oct 5 – Oct 11, 2026");
			await click(byLabel(cal(m.root), "Previous week"));
			await click(byLabel(cal(m.root), "Previous week"));
			expect(title(m.root)).toBe("Sep 21 – Sep 27, 2026");
			await click(byLabel(cal(m.root), "Today"));
			expect(title(m.root)).toBe("Sep 28 – Oct 4, 2026");
		});

		it("rapid clicks are not lost", async () => {
			const m = await mountApp();
			await openCalendar(m);
			const next = byLabel(cal(m.root), "Next week")!;
			next.click();
			next.click();
			next.click();
			await settle();
			expect(title(m.root)).toBe("Oct 19 – Oct 25, 2026");
		});

		it("month mode: October 2026, then November and back, Today returns", async () => {
			const m = await mountApp();
			await openCalendar(m);
			await click(modeButton(m.root, "Month"));
			expect(title(m.root)).toBe("October 2026");
			await click(byLabel(cal(m.root), "Next month"));
			expect(title(m.root)).toBe("November 2026");
			await click(byLabel(cal(m.root), "Previous month"));
			await click(byLabel(cal(m.root), "Previous month"));
			expect(title(m.root)).toBe("September 2026");
			await click(byLabel(cal(m.root), "Today"));
			expect(title(m.root)).toBe("October 2026");
		});

		// The week of Oct 1, 2026 and the October grid start on the week start's day (Mon Sep 28, Sun Sep 27, Sat Sep 26).
		it.each([
			["MO", "Mon", "2026-09-28", "Sep 28 – Oct 4, 2026", "2026-10-26"],
			["SU", "Sun", "2026-09-27", "Sep 27 – Oct 3, 2026", "2026-11-01"],
			["SA", "Sat", "2026-09-26", "Sep 26 – Oct 2, 2026", "2026-10-31"],
		] as const)("week start %s: the week and the month grid, prev, next and Today", async (weekStart, dow, first, weekTitleText, novFirst) => {
			const m = await mountApp({ weekStart });
			await openCalendar(m);
			expect(title(m.root)).toBe(weekTitleText);
			const dates = weekDates(m.root);
			expect(dates).toHaveLength(7);
			expect(dates[0]).toBe(first);
			expect(cal(m.root).querySelector(".cp-cal-dayhead .cp-cal-dow")!.textContent).toBe(dow);
			await click(byLabel(cal(m.root), "Next week"));
			expect(weekDates(m.root)[0]).not.toBe(first);
			await click(byLabel(cal(m.root), "Today"));
			expect(weekDates(m.root)[0]).toBe(first);
			// The month view starts its rows on the same day.
			await click(modeButton(m.root, "Month"));
			const firstDate = () => cal(m.root).querySelector(".cp-cal-cell")!.getAttribute("data-date");
			const head = () => [...cal(m.root).querySelectorAll(".cp-cal-month-head > *")].map((e) => e.textContent);
			expect(title(m.root)).toBe("October 2026");
			expect(head()).toHaveLength(7);
			expect(head()[0]).toBe(dow);
			expect(firstDate()).toBe(first);
			await click(byLabel(cal(m.root), "Next month"));
			expect(title(m.root)).toBe("November 2026");
			expect(head()[0]).toBe(dow);
			expect(firstDate()).toBe(novFirst);
			await click(byLabel(cal(m.root), "Previous month"));
			await click(byLabel(cal(m.root), "Previous month"));
			expect(title(m.root)).toBe("September 2026");
			expect(head()[0]).toBe(dow);
			await click(byLabel(cal(m.root), "Today"));
			expect(title(m.root)).toBe("October 2026");
			expect(firstDate()).toBe(first);
			expect(cal(m.root).querySelector(".cp-cal-cell.is-today")?.getAttribute("data-date")).toBe("2026-10-01");
		});
	});

	describe("week view", () => {
		it("lays out seven columns, today's header, the all-day row and 24 hour rows", async () => {
			const m = await mountApp();
			await openCalendar(m);
			expect(weekDates(m.root)).toEqual(["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
			const heads = [...cal(m.root).querySelectorAll<HTMLElement>(".cp-cal-dayhead")];
			expect(heads.filter((h) => h.classList.contains("is-today")).map((h) => h.getAttribute("data-date"))).toEqual(["2026-10-01"]);
			expect(cal(m.root).querySelectorAll(".cp-cal-allday-cell")).toHaveLength(7);
			expect(cal(m.root).querySelectorAll(".cp-cal-daycol")).toHaveLength(7);
			expect(cal(m.root).querySelectorAll(".cp-cal-hour-label")).toHaveLength(24);
			// Header and all-day row live in the sticky block, the grid scrolls under it.
			const sticky = cal(m.root).querySelector(".cp-cal-sticky")!;
			expect(sticky.querySelector(".cp-cal-dayhead")).not.toBeNull();
			expect(sticky.querySelector(".cp-cal-allday-cell")).not.toBeNull();
			expect(sticky.querySelector(".cp-cal-daycol")).toBeNull();
		});

		it("places date-only, timed, no-duration, deadline, past and missed entries", async () => {
			const m = await mountApp();
			await seed(m);
			await openCalendar(m);
			const r = m.root;

			const dentist = entry(cell(r, "allday-cell", "2026-10-01"), "Dentist");
			expect(dentist.classList.contains("is-allday")).toBe(true);
			expect(dentist.classList.contains("is-past")).toBe(false);

			const standup = entry(cell(r, "daycol", "2026-10-01"), "Standup");
			expect(standup.classList.contains("is-block")).toBe(true);
			expect(standup.style.getPropertyValue("--cp-start")).toBe("1140");
			expect(standup.style.getPropertyValue("--cp-len")).toBe("45");
			expect(standup.style.getPropertyValue("--cp-col")).toBe("0");
			expect(standup.style.getPropertyValue("--cp-cols")).toBe("1");
			expect(standup.classList.contains("is-noduration")).toBe(false);
			expect(standup.textContent).toContain("19:00");

			const quick = entry(cell(r, "daycol", "2026-10-02"), "Quick call");
			expect(quick.classList.contains("is-noduration")).toBe(true);
			expect(quick.style.getPropertyValue("--cp-start")).toBe("540");
			expect(quick.style.getPropertyValue("--cp-len")).toBe("30");
			expect(quick.querySelector(".cp-cal-noduration")?.textContent).toBe("no duration");

			const report = entry(cell(r, "allday-cell", "2026-10-03"), "Report");
			expect(report.classList.contains("is-deadline")).toBe(true);
			expect(iconOf(report)).toBe("flag");
			expect(report.classList.contains("is-missed")).toBe(false);

			const old = entry(cell(r, "allday-cell", "2026-09-29"), "Old");
			expect(old.classList.contains("is-past")).toBe(true);
			const earlier = entry(cell(r, "daycol", "2026-10-01"), "Earlier");
			expect(earlier.classList.contains("is-past")).toBe(true);
			expect(standup.classList.contains("is-past")).toBe(false);

			const late = entry(cell(r, "allday-cell", "2026-09-30"), "Late report");
			expect(late.classList.contains("is-deadline")).toBe(true);
			expect(late.classList.contains("is-missed")).toBe(true);
		});

		it("hides completed entries by default and shows them struck through with Show completed", async () => {
			const m = await mountApp();
			await seed(m);
			await openCalendar(m);
			expect(entries(cal(m.root), "Done")).toHaveLength(0);
			await pickItem(m, await openViewMenu(m, cal(m.root)), "Show completed");
			const done = entry(cell(m.root, "allday-cell", "2026-10-01"), "Done");
			expect(done.classList.contains("is-completed")).toBe(true);
			expect(entryName(done)).toContain("completed");
			// Switching it off again hides the entry.
			await pickItem(m, await openViewMenu(m, cal(m.root)), "Show completed");
			expect(entries(cal(m.root), "Done")).toHaveLength(0);
		});

		it("the view menu offers Lists, Tags and Show completed, and no date or status filter", async () => {
			const m = await mountApp();
			await openCalendar(m);
			expect(cal(m.root).querySelector(".cp-filter-bar")).toBeNull();
			const menu = await openViewMenu(m, cal(m.root));
			expect(menuTitles(menu)).toEqual(["Lists…", "Tags…", "Show completed"]);
			// The tasks list has no filter bar either: sort and Show completed live in its menu.
			await click(m.root.querySelector('.cp-rail [aria-label="Tasks"]'));
			expect(m.root.querySelector(".cp-tasks .cp-filter-bar")).toBeNull();
		});

		it("Lists narrows the calendar (category) and the button shows a dot", async () => {
			const m = await mountApp();
			const study = await m.h.app.categories.create("Study", null);
			await m.h.app.tasks.create({ title: "Essay", categoryId: study.id, scheduled: day("2026-10-02") });
			await m.h.app.tasks.create({ title: "Chore", scheduled: day("2026-10-02") });
			await openCalendar(m);
			expect(entries(cal(m.root), "Essay")).toHaveLength(1);
			expect(entries(cal(m.root), "Chore")).toHaveLength(1);
			expect(viewButton(cal(m.root))!.querySelector(".cp-view-dot")).toBeNull();
			const lists = (await pickItem(m, await openViewMenu(m, cal(m.root)), "Lists…"))!;
			expect(checkedOf(lists, "Study")).toBe(false);
			const again = (await pickItem(m, lists, "Study"))!;
			// The submenu shows itself again with the pick checked, so several lists can be picked in a row.
			expect(checkedOf(again, "Study")).toBe(true);
			expect(entries(cal(m.root), "Essay")).toHaveLength(1);
			expect(entries(cal(m.root), "Chore")).toHaveLength(0);
			expect(viewButton(cal(m.root))!.querySelector(".cp-view-dot")).not.toBeNull();
			await pickItem(m, again, "Study");
			expect(entries(cal(m.root), "Chore")).toHaveLength(1);
			expect(viewButton(cal(m.root))!.querySelector(".cp-view-dot")).toBeNull();
		});

		it("Tags narrows the calendar", async () => {
			const m = await mountApp();
			await m.h.app.tags.create("focus", "red");
			await m.h.app.tasks.create({ title: "Tagged", tagKeys: ["focus"], scheduled: day("2026-10-02") });
			await m.h.app.tasks.create({ title: "Plain", scheduled: day("2026-10-02") });
			await openCalendar(m);
			const tags = (await pickItem(m, await openViewMenu(m, cal(m.root)), "Tags…"))!;
			await pickItem(m, tags, "@focus");
			expect(entries(cal(m.root), "Tagged")).toHaveLength(1);
			expect(entries(cal(m.root), "Plain")).toHaveLength(0);
			expect(viewButton(cal(m.root))!.querySelector(".cp-view-dot")).not.toBeNull();
		});

		it("the Lists menu stays reachable from the keyboard: the ⋯ button is a focusable button", async () => {
			const m = await mountApp();
			await openCalendar(m);
			const btn = viewButton(cal(m.root))!;
			expect(btn.tagName).toBe("BUTTON");
			expect(btn.tabIndex).toBeGreaterThanOrEqual(0);
			expect(btn.getAttribute("aria-haspopup")).toBe("menu");
			expect(cal(m.root).querySelector(".cp-cal-header")!.contains(btn)).toBe(true);
		});

		it("blocks and pills take the list color, or the accent when the list has none", async () => {
			const m = await mountApp();
			const study = await m.h.app.categories.create("Study", null);
			await m.h.app.categories.setColor(study.id, "purple");
			await m.h.app.tasks.create({ title: "Essay", categoryId: study.id, scheduled: at("2026-10-02", "10:00"), plannedDurationMin: 60 });
			await m.h.app.tasks.create({ title: "Chore", scheduled: at("2026-10-02", "13:00"), plannedDurationMin: 60 });
			await openCalendar(m);
			expect(entry(cal(m.root), "Essay").classList.contains("cp-hue-purple")).toBe(true);
			const chore = entry(cal(m.root), "Chore");
			expect([...chore.classList].some((c) => c.startsWith("cp-hue-") && c !== "cp-hue-none")).toBe(false);
		});

		it("overlapping blocks share the day in columns", async () => {
			const m = await mountApp();
			await m.h.app.tasks.create({ title: "A", scheduled: at("2026-10-02", "14:00"), plannedDurationMin: 60 });
			await m.h.app.tasks.create({ title: "B", scheduled: at("2026-10-02", "14:30"), plannedDurationMin: 60 });
			await openCalendar(m);
			const col = cell(m.root, "daycol", "2026-10-02");
			const a = entry(col, "A");
			const b = entry(col, "B");
			expect(a.style.getPropertyValue("--cp-cols")).toBe("2");
			expect(b.style.getPropertyValue("--cp-cols")).toBe("2");
			expect([a, b].map((e) => e.style.getPropertyValue("--cp-col")).sort()).toEqual(["0", "1"]);
		});

		it("splits a block that crosses midnight into two entries", async () => {
			const m = await mountApp();
			await m.h.app.tasks.create({ title: "Late night", scheduled: at("2026-10-02", "23:30"), plannedDurationMin: 60 });
			await openCalendar(m);
			const first = entry(cell(m.root, "daycol", "2026-10-02"), "Late night");
			const second = entry(cell(m.root, "daycol", "2026-10-03"), "Late night");
			expect(first.style.getPropertyValue("--cp-start")).toBe("1410");
			expect(first.style.getPropertyValue("--cp-len")).toBe("30");
			expect(entryName(first)).toBe("Late night, Fri Oct 2, 23:30–00:30");
			expect(second.style.getPropertyValue("--cp-start")).toBe("0");
			expect(second.style.getPropertyValue("--cp-len")).toBe("30");
			expect(entryName(second)).toBe("Late night, Sat Oct 3, 00:00–00:30, continued");
			expect(first.getAttribute("data-task-id")).toBe(second.getAttribute("data-task-id"));
		});

		it("a task in another zone is shown in the display zone", async () => {
			const m = await mountApp();
			await m.h.app.tasks.create({
				title: "Overseas",
				scheduled: { kind: "datetime", local: "2026-10-02T09:00", tz: "America/New_York" },
				plannedDurationMin: 60,
			});
			await openCalendar(m);
			const block = entry(cell(m.root, "daycol", "2026-10-02"), "Overseas");
			expect(block.style.getPropertyValue("--cp-start")).toBe(String(15 * 60)); // 09:00 EDT is 15:00 in Berlin
		});

		it("marks the skipped hour on the spring-forward day and the repeated hour on the fall-back day", async () => {
			const m = await mountApp();
			m.h.clock.set("2026-03-29T10:00:00Z");
			await m.rerender();
			await openCalendar(m);
			await click(byLabel(cal(m.root), "Today"));
			const skipped = cell(m.root, "daycol", "2026-03-29").querySelector<HTMLElement>(".cp-cal-skipped")!;
			expect(skipped.textContent).toContain("Skipped (daylight saving)");
			expect(skipped.style.getPropertyValue("--cp-start")).toBe("120");
			expect(skipped.style.getPropertyValue("--cp-len")).toBe("60");
			expect(cell(m.root, "daycol", "2026-03-28").querySelector(".cp-cal-skipped")).toBeNull();
			expect(cal(m.root).querySelectorAll(".cp-cal-skipped")).toHaveLength(1);

			m.h.clock.set("2026-10-25T10:00:00Z");
			await m.rerender();
			await click(byLabel(cal(m.root), "Today"));
			const repeated = cell(m.root, "daycol", "2026-10-25").querySelector<HTMLElement>(".cp-cal-repeated")!;
			expect(repeated.textContent).toContain("Repeated hour");
			expect(repeated.textContent).toContain("×2");
			expect(repeated.style.getPropertyValue("--cp-start")).toBe("120");
			expect(cal(m.root).querySelectorAll(".cp-cal-repeated")).toHaveLength(1);
			expect(cal(m.root).querySelector(".cp-cal-skipped")).toBeNull();
		});

		it("draws the now line in today's column only, and it follows the clock each minute", async () => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
			const m = await mountApp();
			await openCalendar(m);
			const lines = cal(m.root).querySelectorAll<HTMLElement>(".cp-cal-now");
			expect(lines).toHaveLength(1);
			expect(lines[0]!.closest(".cp-cal-daycol")!.getAttribute("data-date")).toBe("2026-10-01");
			expect(lines[0]!.style.getPropertyValue("--cp-start")).toBe("720"); // 12:00 in Berlin
			m.h.clock.advance(90 * 60_000);
			vi.advanceTimersByTime(60_000);
			await settle();
			expect(cal(m.root).querySelector<HTMLElement>(".cp-cal-now")!.style.getPropertyValue("--cp-start")).toBe("810");
			await click(byLabel(cal(m.root), "Next week"));
			expect(cal(m.root).querySelector(".cp-cal-now")).toBeNull();
		});

		it("a timed entry turns past once its end passes", async () => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
			const m = await mountApp();
			await m.h.app.tasks.create({ title: "Soon", scheduled: at("2026-10-01", "13:00"), plannedDurationMin: 30 });
			await openCalendar(m);
			expect(entry(cal(m.root), "Soon").classList.contains("is-past")).toBe(false);
			m.h.clock.advance(61 * 60_000); // 13:01 in Berlin: the task is running
			vi.advanceTimersByTime(60_000);
			await settle();
			expect(entry(cal(m.root), "Soon").classList.contains("is-past")).toBe(false);
			m.h.clock.advance(30 * 60_000);
			vi.advanceTimersByTime(60_000);
			await settle();
			expect(entry(cal(m.root), "Soon").classList.contains("is-past")).toBe(true);
		});

		it("clears its timers on unmount", async () => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
			const m = await mountApp();
			await openCalendar(m);
			expect(vi.getTimerCount()).toBeGreaterThan(0);
			vi.advanceTimersByTime(60_000); // the aligned timeout has fired and started the interval
			await settle();
			m.unmount();
			expect(vi.getTimerCount()).toBe(0);
		});

		it("aligns the tick to the next minute boundary, then ticks every minute", async () => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
			const m = await mountApp();
			m.h.clock.set("2026-10-01T10:00:20Z");
			await m.rerender();
			const hidden = vi.getTimerCount();
			await openCalendar(m);
			expect(vi.getTimerCount()).toBe(hidden + 1); // one timeout to the boundary
			const line = () => cal(m.root).querySelector<HTMLElement>(".cp-cal-now")!.style.getPropertyValue("--cp-start");
			expect(line()).toBe("720");
			m.h.clock.set("2026-10-01T10:01:00Z");
			vi.advanceTimersByTime(39_999);
			await settle();
			expect(line()).toBe("720"); // not yet
			vi.advanceTimersByTime(1);
			await settle();
			expect(line()).toBe("721"); // on the boundary
			expect(vi.getTimerCount()).toBe(hidden + 1); // now one interval
			m.h.clock.set("2026-10-01T10:02:00Z");
			vi.advanceTimersByTime(60_000);
			await settle();
			expect(line()).toBe("722");
		});

		it("pauses the tick while the section is hidden and resumes with an immediate update", async () => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
			const m = await mountApp();
			const hidden = vi.getTimerCount();
			await openCalendar(m);
			vi.advanceTimersByTime(60_000);
			await settle();
			expect(vi.getTimerCount()).toBe(hidden + 1);
			await click(m.root.querySelector('.cp-rail [aria-label="Tasks"]'));
			expect(vi.getTimerCount()).toBe(hidden);
			vi.advanceTimersByTime(5 * 60_000);
			await settle();
			expect(vi.getTimerCount()).toBe(hidden);
			m.h.clock.set("2026-10-01T10:30:00Z");
			await click(byLabel(m.root, "Calendar"));
			expect(cal(m.root).querySelector<HTMLElement>(".cp-cal-now")!.style.getPropertyValue("--cp-start")).toBe("750"); // 12:30 Berlin, no wait for a tick
			expect(vi.getTimerCount()).toBe(hidden + 1);
		});

		it("does no layout work while hidden and catches up when shown", async () => {
			const m = await mountApp();
			await m.h.app.tasks.create({ title: "Early bird", scheduled: day("2026-10-01") });
			// Never shown: the calendar did not even lay out the task.
			expect(entries(cal(m.root), "Early bird")).toHaveLength(0);
			await openCalendar(m);
			expect(entries(cal(m.root), "Early bird")).toHaveLength(1);
			await click(m.root.querySelector('.cp-rail [aria-label="Tasks"]'));
			await m.h.app.tasks.create({ title: "While away", scheduled: day("2026-10-01") });
			await settle();
			expect(entries(cal(m.root), "While away")).toHaveLength(0);
			await click(byLabel(m.root, "Calendar"));
			expect(entries(cal(m.root), "While away")).toHaveLength(1);
			expect(entries(cal(m.root), "Early bird")).toHaveLength(1);
		});


		it("scrolls to 07:00, or one hour before now when that is later, when first shown", async () => {
			const m = await mountApp();
			await openCalendar(m);
			const scroller = () => cal(m.root).querySelector<HTMLElement>(".cp-cal-scroller")!;
			expect(scroller().scrollTop).toBe(11 * 48 - LABEL_PEEK_PX); // now 12:00 in Berlin
			m.unmount();

			const early = await mountApp();
			early.h.clock.set("2026-10-01T03:00:00Z"); // 05:00 in Berlin
			await early.rerender();
			await openCalendar(early);
			expect(cal(early.root).querySelector<HTMLElement>(".cp-cal-scroller")!.scrollTop).toBe(7 * 48 - LABEL_PEEK_PX);
		});

		it("keeps the scroll position while another section is shown", async () => {
			const m = await mountApp();
			await openCalendar(m);
			const scroller = () => cal(m.root).querySelector<HTMLElement>(".cp-cal-scroller")!;
			scroller().scrollTop = 200;
			scroller().dispatchEvent(new Event("scroll"));
			await click(m.root.querySelector('.cp-rail [aria-label="Tasks"]'));
			scroller().scrollTop = 0; // a hidden element loses its offset
			scroller().dispatchEvent(new Event("scroll"));
			await click(byLabel(m.root, "Calendar"));
			expect(scroller().scrollTop).toBe(200);
		});
	});

	describe("month view", () => {
		async function openMonth(m: AppMount) {
			await openCalendar(m);
			await click(modeButton(m.root, "Month"));
		}

		it("renders whole weeks with a weekday header, faint outside days and today marked", async () => {
			const m = await mountApp();
			await openMonth(m);
			expect([...cal(m.root).querySelectorAll(".cp-cal-month-head > *")].map((e) => e.textContent)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
			const cells = [...cal(m.root).querySelectorAll<HTMLElement>(".cp-cal-cell")];
			expect(cells).toHaveLength(35);
			expect(cells[0]!.getAttribute("data-date")).toBe("2026-09-28");
			expect(cells.filter((c) => c.classList.contains("is-out")).map((c) => c.getAttribute("data-date"))).toEqual([
				"2026-09-28",
				"2026-09-29",
				"2026-09-30",
				"2026-11-01",
			]);
			expect(cells.filter((c) => c.classList.contains("is-today")).map((c) => c.getAttribute("data-date"))).toEqual(["2026-10-01"]);
			expect(cell(m.root, "cell", "2026-10-01").querySelector(".cp-cal-daynum")!.textContent).toBe("1");
		});

		it("shows the count, three titles and +k more; the day number and +k more open that week", async () => {
			const m = await mountApp();
			for (const [i, t] of ["09:00", "10:00", "11:00", "12:00", "13:00"].entries()) {
				await m.h.app.tasks.create({ title: `Task ${i + 1}`, scheduled: at("2026-10-14", t), plannedDurationMin: 30 });
			}
			await openMonth(m);
			const c = cell(m.root, "cell", "2026-10-14");
			expect(c.querySelector(".cp-cal-count")!.textContent).toBe("5");
			const shown = [...c.querySelectorAll<HTMLButtonElement>(".cp-cal-entry")];
			expect(shown.map((b) => entryName(b))).toEqual([
				"Task 1, Wed Oct 14, 09:00–09:30",
				"Task 2, Wed Oct 14, 10:00–10:30",
				"Task 3, Wed Oct 14, 11:00–11:30",
			]);
			const more = c.querySelector<HTMLButtonElement>(".cp-cal-more")!;
			expect(more.tagName).toBe("BUTTON");
			expect(more.textContent).toBe("+2 more");
			await click(more);
			expect(modeButton(m.root, "Week").getAttribute("aria-pressed")).toBe("true");
			expect(title(m.root)).toBe("Oct 12 – Oct 18, 2026");
			expect(weekDates(m.root)).toContain("2026-10-14");
			expect(entries(cal(m.root), "Task 5")).toHaveLength(1);

			await click(modeButton(m.root, "Month"));
			await click(cell(m.root, "cell", "2026-10-21").querySelector(".cp-cal-daynum"));
			expect(modeButton(m.root, "Week").getAttribute("aria-pressed")).toBe("true");
			expect(title(m.root)).toBe("Oct 19 – Oct 25, 2026");
		});

		it("a cell with at most three entries has no +k more and no count above zero when empty", async () => {
			const m = await mountApp();
			await m.h.app.tasks.create({ title: "Solo", scheduled: day("2026-10-02") });
			await openMonth(m);
			expect(cell(m.root, "cell", "2026-10-02").querySelector(".cp-cal-more")).toBeNull();
			expect(cell(m.root, "cell", "2026-10-02").querySelector(".cp-cal-count")!.textContent).toBe("1");
			expect(cell(m.root, "cell", "2026-10-05").querySelector(".cp-cal-count")).toBeNull();
		});

		it("entries are buttons that open the details", async () => {
			const m = await mountApp();
			await m.h.app.tasks.create({ title: "Solo", scheduled: day("2026-10-02") });
			await openMonth(m);
			const b = entry(cell(m.root, "cell", "2026-10-02"), "Solo");
			expect(b.tagName).toBe("BUTTON");
			await click(b);
			expect(cal(m.root).querySelector<HTMLTextAreaElement>(".cp-details-title")?.value).toBe("Solo");
		});
	});

	describe("entries, details and the unscheduled drawer", () => {
		it("Enter, Space and click on an entry select the task and open the shared details", async () => {
			const m = await mountApp();
			await seed(m);
			await openCalendar(m);
			const details = () => cal(m.root).querySelector<HTMLTextAreaElement>(".cp-details-title")?.value;
			expect(details()).toBeUndefined();

			const standup = entry(cal(m.root), "Standup");
			expect(standup.tagName).toBe("BUTTON");
			expect(keydown(standup, "Enter").defaultPrevented).toBe(true);
			await settle();
			expect(details()).toBe("Standup");
			expect(entry(cal(m.root), "Standup").classList.contains("is-selected")).toBe(true);

			expect(keydown(entry(cal(m.root), "Dentist"), " ").defaultPrevented).toBe(true);
			await settle();
			expect(details()).toBe("Dentist");

			await click(entry(cal(m.root), "Report"));
			expect(details()).toBe("Report");
			// The same pane component as the task list: a close button and the drawer class.
			expect(cal(m.root).querySelector("aside.cp-details-pane .cp-details-close")).not.toBeNull();
			await click(cal(m.root).querySelector(".cp-details-close"));
			expect(details()).toBeUndefined();
		});

		it("rescheduling in the details moves the same task's block", async () => {
			const m = await mountApp();
			const { task } = await m.h.app.tasks.create({ title: "Standup", scheduled: at("2026-10-01", "19:00"), plannedDurationMin: 45 });
			await openCalendar(m);
			await click(entry(cal(m.root), "Standup"));
			await click(cal(m.root).querySelector(".cp-due-chip"));
			const input = (label: string) => cal(m.root).querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
			input("Scheduled date").value = "2026-10-02";
			input("Scheduled date").dispatchEvent(new Event("change", { bubbles: true }));
			await settle();
			input("Scheduled time").value = "10:30";
			input("Scheduled time").dispatchEvent(new Event("change", { bubbles: true }));
			await settle();

			expect(m.h.app.store.state.tasks.size).toBe(1);
			const moved = entry(cell(m.root, "daycol", "2026-10-02"), "Standup");
			expect(moved.getAttribute("data-task-id")).toBe(task.id);
			expect(moved.style.getPropertyValue("--cp-start")).toBe("630");
			expect(entries(cell(m.root, "daycol", "2026-10-01"), "Standup")).toHaveLength(0);
		});

		it("completing a task from the details removes it from the open calendar", async () => {
			const m = await mountApp();
			const { task } = await m.h.app.tasks.create({ title: "Standup", scheduled: day("2026-10-01") });
			await openCalendar(m);
			expect(entries(cal(m.root), "Standup")).toHaveLength(1);
			await click(entry(cal(m.root), "Standup"));
			// The checkbox in the details pane, not a direct service call.
			const check = cal(m.root).querySelector<HTMLInputElement>('.cp-details-top input[type="checkbox"]');
			expect(check?.getAttribute("aria-label")).toBe('Complete "Standup"');
			await click(check);
			expect(m.h.app.store.state.tasks.get(task.id)?.status).toBe("completed");
			expect(entries(cal(m.root), "Standup")).toHaveLength(0);
		});

		it("the unscheduled drawer lists open tasks without a schedule and opens their details", async () => {
			const m = await mountApp();
			await m.h.app.tasks.create({ title: "Someday" });
			await m.h.app.tasks.create({ title: "Planned", scheduled: day("2026-10-02") });
			const done = await m.h.app.tasks.create({ title: "Finished" });
			await m.h.app.tasks.complete(done.task.id);
			await openCalendar(m);
			expect(cal(m.root).querySelector(".cp-cal-unscheduled")).toBeNull();
			const toggle = byLabel(cal(m.root), "Unscheduled")!;
			expect(toggle.tagName).toBe("BUTTON");
			expect(toggle.getAttribute("aria-pressed")).toBe("false");
			await click(toggle);
			expect(toggle.getAttribute("aria-pressed")).toBe("true");
			const drawer = cal(m.root).querySelector<HTMLElement>(".cp-cal-unscheduled")!;
			const rows = [...drawer.querySelectorAll<HTMLElement>(".cp-task-row")];
			expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining("Someday")]);
			await click(rows[0]);
			expect(cal(m.root).querySelector<HTMLTextAreaElement>(".cp-details-title")?.value).toBe("Someday");
			await click(toggle);
			expect(cal(m.root).querySelector(".cp-cal-unscheduled")).toBeNull();
		});

		it("a deadline-only task is a flag in the grid and a row in the drawer, and the toggle counts the drawer's rows", async () => {
			const m = await mountApp();
			await m.h.app.tasks.create({ title: "Someday" });
			await m.h.app.tasks.create({ title: "Report", deadline: day("2026-10-03") });
			await m.h.app.tasks.create({ title: "Planned", scheduled: day("2026-10-02") });
			await openCalendar(m);
			const flags = entries(cal(m.root), "Report");
			expect(flags).toHaveLength(1);
			expect(flags[0]!.classList.contains("is-deadline")).toBe(true);
			const toggle = byLabel(cal(m.root), "Unscheduled")!;
			expect(toggle.querySelector(".cp-count-pill")?.textContent).toBe("2");
			await click(toggle);
			const titles = [...cal(m.root).querySelectorAll(".cp-cal-unscheduled .cp-task-row .cp-task-title")].map((r) => r.textContent.trim());
			expect(titles.sort()).toEqual(["Report", "Someday"]);
		});

		it("has a visible close button that closes the drawer and returns focus to the toggle", async () => {
			const m = await mountApp();
			await openCalendar(m);
			const toggle = byLabel(cal(m.root), "Unscheduled")!;
			await click(toggle);
			const close = cal(m.root).querySelector<HTMLButtonElement>(".cp-cal-unscheduled .cp-cal-unscheduled-close")!;
			expect(close.tagName).toBe("BUTTON");
			expect(close.getAttribute("aria-label")).toBe("Close unscheduled tasks");
			await click(close);
			expect(cal(m.root).querySelector(".cp-cal-unscheduled")).toBeNull();
			expect(toggle.getAttribute("aria-pressed")).toBe("false");
			expect(document.activeElement).toBe(toggle);
		});

		it("Escape inside the drawer closes it, keeps the calendar open and does not leak the key", async () => {
			const m = await mountApp();
			await m.h.app.tasks.create({ title: "Someday" });
			await openCalendar(m);
			const toggle = byLabel(cal(m.root), "Unscheduled")!;
			await click(toggle);
			const row = cal(m.root).querySelector<HTMLElement>(".cp-cal-unscheduled .cp-task-row")!;
			const seen: string[] = [];
			m.root.addEventListener("keydown", (e) => seen.push(e.key));
			expect(keydown(row, "Escape").defaultPrevented).toBe(true);
			await settle();
			expect(cal(m.root).querySelector(".cp-cal-unscheduled")).toBeNull();
			expect(seen).toEqual([]);
			expect(document.activeElement).toBe(toggle);
			expect(cal(m.root).closest<HTMLElement>(".cp-section")!.hidden).toBe(false);
		});

		it("closing the details brings the unscheduled drawer back (it only hides while details are open)", async () => {
			const m = await mountApp();
			await m.h.app.tasks.create({ title: "Someday" });
			await openCalendar(m);
			await click(byLabel(cal(m.root), "Unscheduled"));
			await click(cal(m.root).querySelector(".cp-cal-unscheduled .cp-task-row"));
			// CSS hides the drawer below 1200 px while details are open; the state keeps it open.
			expect(cal(m.root).classList.contains("has-details")).toBe(true);
			expect(byLabel(cal(m.root), "Unscheduled")!.getAttribute("aria-pressed")).toBe("true");
			await click(cal(m.root).querySelector(".cp-details-close"));
			expect(cal(m.root).classList.contains("has-details")).toBe(false);
			expect(cal(m.root).querySelector(".cp-cal-unscheduled")).not.toBeNull();
		});

		it("keeps the drawers below the header: --cp-cal-drawer-top follows the header's bottom edge", async () => {
			const observers: { cb: () => void; targets: Element[] }[] = [];
			class FakeRO {
				readonly rec: { cb: () => void; targets: Element[] };
				constructor(cb: () => void) {
					this.rec = { cb, targets: [] };
					observers.push(this.rec);
				}
				observe(el: Element) {
					this.rec.targets.push(el);
				}
				disconnect() {}
				unobserve() {}
			}
			let headerHeight = 72;
			const proto = HTMLElement.prototype;
			const desc = (name: string) => Object.getOwnPropertyDescriptor(proto, name);
			const savedH = desc("offsetHeight");
			const savedT = desc("offsetTop");
			Object.defineProperty(proto, "offsetHeight", {
				configurable: true,
				get(this: HTMLElement) {
					return this.classList.contains("cp-cal-header") ? headerHeight : 0;
				},
			});
			Object.defineProperty(proto, "offsetTop", {
				configurable: true,
				get(this: HTMLElement) {
					return this.classList.contains("cp-cal-header") ? 28 : 0;
				},
			});
			vi.stubGlobal("ResizeObserver", FakeRO);
			try {
				const m = await mountApp();
				await openCalendar(m);
				expect(cal(m.root).style.getPropertyValue("--cp-cal-drawer-top")).toBe("100px");
				// The header wraps onto a second line: the observer fires and the offset follows.
				headerHeight = 120;
				for (const o of observers) o.cb();
				expect(cal(m.root).style.getPropertyValue("--cp-cal-drawer-top")).toBe("148px");
				expect(observers.some((o) => o.targets.some((t) => t.classList.contains("cp-cal-header")))).toBe(true);
			} finally {
				vi.unstubAllGlobals();
				if (savedH) Object.defineProperty(proto, "offsetHeight", savedH);
				else delete (proto as unknown as Record<string, unknown>).offsetHeight;
				if (savedT) Object.defineProperty(proto, "offsetTop", savedT);
				else delete (proto as unknown as Record<string, unknown>).offsetTop;
			}
		});

		it("shows a friendly line when nothing is unscheduled", async () => {
			const m = await mountApp();
			await openCalendar(m);
			await click(byLabel(cal(m.root), "Unscheduled"));
			expect(cal(m.root).querySelector(".cp-cal-unscheduled .cp-empty-text")).not.toBeNull();
		});
	});

	describe("time range on DST days", () => {
		// The clock is set a day earlier, in the same week, so no block is overdue.
		// The display zone is Europe/Berlin: spring forward 2026-03-29 at 02:00 (to 03:00), fall back
		// 2026-10-25 at 03:00 (to 02:00). The visible range is the real elapsed one, not wall arithmetic.
		const berlin = (date: string, time: string): DateSpec => ({ kind: "datetime", local: `${date}T${time}`, tz: "Europe/Berlin" });
		async function dstMount(now: string) {
			const m = await mountApp();
			m.h.clock.set(now);
			await m.rerender();
			return m;
		}
		/** The anchor was set at mount time; Today jumps to the week of the new clock. */
		async function show(m: AppMount) {
			await openCalendar(m);
			await click(byLabel(cal(m.root), "Today"));
		}

		it("spring forward: 01:30 + 60 min reads 01:30-03:30", async () => {
			const m = await dstMount("2026-03-28T08:00:00Z");
			await m.h.app.tasks.create({ title: "Early", scheduled: berlin("2026-03-29", "01:30"), plannedDurationMin: 60 });
			await show(m);
			const b = entry(cell(m.root, "daycol", "2026-03-29"), "Early");
			expect(entryName(b)).toBe("Early, Sun Mar 29, 01:30–03:30");
			expect(b.querySelector(".cp-cal-entry-time")?.textContent).toBe("01:30–03:30");
		});

		it("fall back: 01:30 + 120 min reads 01:30-02:30 (the end is after the repeated hour)", async () => {
			const m = await dstMount("2026-10-24T08:00:00Z");
			await m.h.app.tasks.create({ title: "Late", scheduled: berlin("2026-10-25", "01:30"), plannedDurationMin: 120 });
			await show(m);
			const b = entry(cell(m.root, "daycol", "2026-10-25"), "Late");
			expect(entryName(b)).toBe("Late, Sun Oct 25, 01:30–02:30");
			expect(b.querySelector(".cp-cal-entry-time")?.textContent).toBe("01:30–02:30");
		});

		it("a block that crosses midnight into a spring-forward day names its real end on both halves", async () => {
			const m = await dstMount("2026-03-28T08:00:00Z");
			await m.h.app.tasks.create({ title: "Night", scheduled: berlin("2026-03-28", "23:30"), plannedDurationMin: 180 });
			await show(m);
			expect(entryName(entry(cell(m.root, "daycol", "2026-03-28"), "Night"))).toBe("Night, Sat Mar 28, 23:30–03:30");
			expect(entryName(entry(cell(m.root, "daycol", "2026-03-29"), "Night"))).toBe("Night, Sun Mar 29, 00:00–03:30, continued");
		});
	});

	describe("accessible names", () => {
		it("names every kind of entry with title, date, time and flags", async () => {
			const m = await mountApp();
			await seed(m);
			await openCalendar(m);
			const nameIn = (container: HTMLElement, text: string) => entryName(entry(container, text));
			const r = m.root;
			expect(nameIn(cell(r, "daycol", "2026-10-01"), "Standup")).toBe("Standup, Thu Oct 1, 19:00–19:45");
			expect(nameIn(cell(r, "allday-cell", "2026-10-01"), "Dentist")).toBe("Dentist, Thu Oct 1, all day");
			expect(nameIn(cell(r, "daycol", "2026-10-02"), "Quick call")).toBe("Quick call, Fri Oct 2, 09:00, no duration");
			expect(nameIn(cell(r, "allday-cell", "2026-10-03"), "Report")).toBe("Report, Sat Oct 3, deadline");
			expect(nameIn(cell(r, "allday-cell", "2026-09-29"), "Old")).toBe("Old, Tue Sep 29, all day, overdue");
			expect(nameIn(cell(r, "allday-cell", "2026-09-30"), "Late report")).toBe("Late report, Wed Sep 30, deadline, missed deadline");
			expect(nameIn(cell(r, "daycol", "2026-10-01"), "Earlier")).toBe("Earlier, Thu Oct 1, 08:00–08:30, overdue");
		});

		it("DOM order: the all-day row left to right, then each day's blocks by start", async () => {
			const m = await mountApp();
			await m.h.app.tasks.create({ title: "Mon all-day", scheduled: day("2026-09-28") });
			await m.h.app.tasks.create({ title: "Wed all-day", scheduled: day("2026-09-30") });
			await m.h.app.tasks.create({ title: "Tue late", scheduled: at("2026-09-29", "15:00"), plannedDurationMin: 30 });
			await m.h.app.tasks.create({ title: "Tue early", scheduled: at("2026-09-29", "08:00"), plannedDurationMin: 30 });
			await m.h.app.tasks.create({ title: "Mon block", scheduled: at("2026-09-28", "12:00"), plannedDurationMin: 30 });
			await openCalendar(m);
			const order = [...cal(m.root).querySelectorAll<HTMLButtonElement>(".cp-cal-week .cp-cal-entry")].map((b) => entryName(b).split(",")[0]);
			expect(order).toEqual(["Mon all-day", "Wed all-day", "Mon block", "Tue early", "Tue late"]);
		});

		it("containers carry no aria-label and every aria-labelledby resolves (week, month, drawer)", async () => {
			const m = await mountApp();
			await seed(m);
			await openCalendar(m);
			await click(byLabel(cal(m.root), "Unscheduled"));
			expect(cal(m.root).querySelectorAll("[aria-labelledby]").length).toBeGreaterThan(0);
			expect(strayAriaLabels(cal(m.root))).toEqual([]);
			expectLabelsResolve(cal(m.root));
			await click(modeButton(m.root, "Month"));
			await click(entry(cal(m.root), "Dentist"));
			expect(strayAriaLabels(cal(m.root))).toEqual([]);
			expectLabelsResolve(cal(m.root));
			expect(strayAriaLabels(m.root)).toEqual([]);
		});

		it("icon buttons in the header have ARIA labels and the mode toggle is labelled", async () => {
			const m = await mountApp();
			await openCalendar(m);
			for (const b of buttons(m.root)) {
				expect(b.getAttribute("aria-label") !== null || (b.textContent ?? "").trim() !== "", `unnamed button ${b.className}`).toBe(true);
			}
			const group = cal(m.root).querySelector<HTMLElement>(".cp-cal-mode")!;
			expect(group.hasAttribute("aria-label")).toBe(false);
			expect(document.getElementById(group.getAttribute("aria-labelledby")!)?.textContent).toBe("Calendar view");
		});
	});

	describe("all-day row limit", () => {
		const allday = (root: HTMLElement) => cal(root).querySelector<HTMLElement>(".cp-cal-allday")!;
		const dayCell = (root: HTMLElement, date = "2026-10-01") => cell(root, "allday-cell", date);
		const names = (el: HTMLElement) => [...el.querySelectorAll<HTMLButtonElement>(".cp-cal-entry")].map((b) => entryName(b).split(",")[0]);
		const moreBtn = (el: HTMLElement) => el.querySelector<HTMLButtonElement>(".cp-cal-allday-more");
		const lessBtn = (el: HTMLElement) => el.querySelector<HTMLButtonElement>(".cp-cal-allday-less");

		async function six(m: AppMount) {
			for (let i = 1; i <= 6; i++) await m.h.app.tasks.create({ title: `Chore ${i}`, scheduled: day("2026-10-01") });
			await settle();
		}

		it("shows at most three entries per cell and a real +k more button with an accessible name", async () => {
			const m = await mountApp();
			await six(m);
			await openCalendar(m);
			const c = dayCell(m.root);
			expect(names(c)).toHaveLength(3);
			const more = moreBtn(c)!;
			expect(more.tagName).toBe("BUTTON");
			expect(more.getAttribute("type")).toBe("button");
			expect(more.textContent).toBe("+3 more");
			expect(more.getAttribute("aria-label")).toBe("Show 3 more all-day items");
			expect(more.getAttribute("aria-expanded")).toBe("false");
			expect(allday(m.root).classList.contains("is-expanded")).toBe(false);
			expect(lessBtn(c)).toBeNull();
		});

		it("shows exactly three entries without a control", async () => {
			const m = await mountApp();
			for (let i = 1; i <= 3; i++) await m.h.app.tasks.create({ title: `Chore ${i}`, scheduled: day("2026-10-01") });
			await openCalendar(m);
			expect(names(dayCell(m.root))).toHaveLength(3);
			expect(moreBtn(dayCell(m.root))).toBeNull();
			expect(allday(m.root).querySelector(".cp-cal-allday-more, .cp-cal-allday-less")).toBeNull();
		});

		it("counts deadline flags as entries (dates first, then deadlines)", async () => {
			const m = await mountApp();
			await m.h.app.tasks.create({ title: "Date 1", scheduled: day("2026-10-02") });
			await m.h.app.tasks.create({ title: "Date 2", scheduled: day("2026-10-02") });
			await m.h.app.tasks.create({ title: "Flag 1", deadline: day("2026-10-02") });
			await m.h.app.tasks.create({ title: "Flag 2", deadline: day("2026-10-02") });
			await m.h.app.tasks.create({ title: "Flag 3", deadline: day("2026-10-02") });
			await openCalendar(m);
			const c = dayCell(m.root, "2026-10-02");
			expect(names(c)).toEqual(["Date 1", "Date 2", "Flag 1"]);
			expect(moreBtn(c)!.getAttribute("aria-label")).toBe("Show 2 more all-day items");
			expect(entries(cal(m.root), "Flag 2")).toHaveLength(0);
		});

		it("uses the singular for one hidden item", async () => {
			const m = await mountApp();
			for (let i = 1; i <= 4; i++) await m.h.app.tasks.create({ title: `Chore ${i}`, scheduled: day("2026-10-01") });
			await openCalendar(m);
			expect(moreBtn(dayCell(m.root))!.getAttribute("aria-label")).toBe("Show 1 more all-day item");
		});

		it("expands the whole row on click, shows every entry and a Show less control, and collapses again", async () => {
			const m = await mountApp();
			await six(m);
			await m.h.app.tasks.create({ title: "Other 1", scheduled: day("2026-10-02") });
			await openCalendar(m);
			await click(moreBtn(dayCell(m.root)));
			const c = dayCell(m.root);
			expect(allday(m.root).classList.contains("is-expanded")).toBe(true);
			expect(names(c)).toEqual(["Chore 1", "Chore 2", "Chore 3", "Chore 4", "Chore 5", "Chore 6"]);
			expect(moreBtn(c)).toBeNull();
			const less = lessBtn(c)!;
			expect(less.tagName).toBe("BUTTON");
			expect(less.textContent).toBe("Show less");
			expect(less.getAttribute("aria-expanded")).toBe("true");
			expect(names(dayCell(m.root, "2026-10-02"))).toEqual(["Other 1"]);
			// Every hidden entry is a focusable button once shown.
			for (const b of c.querySelectorAll<HTMLButtonElement>(".cp-cal-entry")) {
				expect(b.tagName).toBe("BUTTON");
				expect(b.getAttribute("tabindex")).toBeNull();
				expect(b.hidden).toBe(false);
			}
			await click(less);
			expect(allday(m.root).classList.contains("is-expanded")).toBe(false);
			expect(names(dayCell(m.root))).toEqual(["Chore 1", "Chore 2", "Chore 3"]);
			expect(moreBtn(dayCell(m.root))).not.toBeNull();
			expect(lessBtn(dayCell(m.root))).toBeNull();
		});

		it("expands every overflowing cell at once", async () => {
			const m = await mountApp();
			await six(m);
			for (let i = 1; i <= 5; i++) await m.h.app.tasks.create({ title: `Late ${i}`, scheduled: day("2026-10-03") });
			await openCalendar(m);
			expect(allday(m.root).querySelectorAll(".cp-cal-allday-more")).toHaveLength(2);
			await click(moreBtn(dayCell(m.root, "2026-10-03")));
			expect(names(dayCell(m.root))).toHaveLength(6);
			expect(names(dayCell(m.root, "2026-10-03"))).toHaveLength(5);
			expect(allday(m.root).querySelectorAll(".cp-cal-allday-less")).toHaveLength(2);
		});

		it("keeps the keyboard in place: focus moves to the Show less control and back to +k more", async () => {
			const m = await mountApp();
			await six(m);
			await openCalendar(m);
			const more = moreBtn(dayCell(m.root))!;
			more.focus();
			more.click();
			await settle();
			expect(document.activeElement).toBe(lessBtn(dayCell(m.root)));
			(document.activeElement as HTMLElement).click();
			await settle();
			expect(document.activeElement).toBe(moreBtn(dayCell(m.root)));
		});

		it("an expanded entry opens the details like any other", async () => {
			const m = await mountApp();
			await six(m);
			await openCalendar(m);
			await click(moreBtn(dayCell(m.root)));
			await click(entry(dayCell(m.root), "Chore 6"));
			expect(cal(m.root).querySelector<HTMLTextAreaElement>(".cp-details-title")?.value).toBe("Chore 6");
		});

		it("keeps the expanded state across section and mode switches, and starts collapsed", async () => {
			const m = await mountApp();
			await six(m);
			await openCalendar(m);
			expect(allday(m.root).classList.contains("is-expanded")).toBe(false);
			await click(moreBtn(dayCell(m.root)));
			await click(m.root.querySelector('.cp-rail [aria-label="Tasks"]'));
			await click(byLabel(m.root, "Calendar"));
			expect(allday(m.root).classList.contains("is-expanded")).toBe(true);
			expect(names(dayCell(m.root))).toHaveLength(6);
			await click(modeButton(m.root, "Month"));
			await click(modeButton(m.root, "Week"));
			expect(allday(m.root).classList.contains("is-expanded")).toBe(true);
			expect(names(dayCell(m.root))).toHaveLength(6);
		});

		it("keeps the expanded state when the week changes and the new week has fewer entries", async () => {
			const m = await mountApp();
			await six(m);
			await openCalendar(m);
			await click(moreBtn(dayCell(m.root)));
			await click(byLabel(cal(m.root), "Next week"));
			expect(allday(m.root).querySelector(".cp-cal-allday-less")).toBeNull();
			await click(byLabel(cal(m.root), "Previous week"));
			expect(names(dayCell(m.root))).toHaveLength(6);
		});

		it("the month view keeps its own three-title limit", async () => {
			const m = await mountApp();
			await six(m);
			await openCalendar(m);
			await click(modeButton(m.root, "Month"));
			expect(cell(m.root, "cell", "2026-10-01").querySelector(".cp-cal-allday-more")).toBeNull();
			expect(cell(m.root, "cell", "2026-10-01").querySelector(".cp-cal-more")!.textContent).toBe("+3 more");
		});
	});

	describe("short timed blocks", () => {
		async function block(m: AppMount, title: string, time: string, minutes?: number) {
			await m.h.app.tasks.create({ title, scheduled: at("2026-10-02", time), ...(minutes === undefined ? {} : { plannedDurationMin: minutes }) });
			await openCalendar(m);
			return entry(cell(m.root, "daycol", "2026-10-02"), title);
		}

		it("marks blocks shorter than 45 minutes as single-line", async () => {
			const m = await mountApp();
			await m.h.app.tasks.create({ title: "Ten", scheduled: at("2026-10-02", "08:00"), plannedDurationMin: 10 });
			await m.h.app.tasks.create({ title: "Thirty", scheduled: at("2026-10-02", "09:00"), plannedDurationMin: 30 });
			await m.h.app.tasks.create({ title: "Forty four", scheduled: at("2026-10-02", "10:00"), plannedDurationMin: 44 });
			await m.h.app.tasks.create({ title: "Forty five", scheduled: at("2026-10-02", "11:00"), plannedDurationMin: 45 });
			await m.h.app.tasks.create({ title: "Hour", scheduled: at("2026-10-02", "12:00"), plannedDurationMin: 60 });
			await openCalendar(m);
			const col = cell(m.root, "daycol", "2026-10-02");
			const short = (t: string) => entry(col, t).classList.contains("is-short");
			expect(["Ten", "Thirty", "Forty four", "Forty five", "Hour"].map(short)).toEqual([true, true, true, false, false]);
		});

		it("treats a no-duration block (30 min on the grid) as short and keeps its text", async () => {
			const m = await mountApp();
			const b = await block(m, "Quick", "09:00");
			expect(b.classList.contains("is-short")).toBe(true);
			expect(b.querySelector(".cp-cal-noduration")?.textContent).toBe("no duration");
			expect(b.querySelector(".cp-cal-entry-text")?.textContent).toBe("Quick");
		});

		it("uses the visible length, so the short piece of a block split at midnight is single-line", async () => {
			const m = await mountApp();
			await m.h.app.tasks.create({ title: "Night", scheduled: at("2026-10-02", "23:30"), plannedDurationMin: 90 });
			await openCalendar(m);
			expect(entry(cell(m.root, "daycol", "2026-10-02"), "Night").classList.contains("is-short")).toBe(true);
			expect(entry(cell(m.root, "daycol", "2026-10-03"), "Night").classList.contains("is-short")).toBe(false);
		});

		it("leaves the accessible name and the time text unchanged", async () => {
			const m = await mountApp();
			const b = await block(m, "Brief", "09:00", 20);
			expect(entryName(b)).toBe("Brief, Fri Oct 2, 09:00–09:20");
			expect(b.querySelector(".cp-cal-entry-time")?.textContent).toBe("09:00–09:20");
			expect(b.hasAttribute("aria-label")).toBe(false);
		});

		it("does not mark all-day or month entries", async () => {
			const m = await mountApp();
			await m.h.app.tasks.create({ title: "Day", scheduled: day("2026-10-02") });
			await openCalendar(m);
			expect(cal(m.root).querySelector(".cp-cal-allday .is-short")).toBeNull();
		});
	});
});

describe("calendar titles and navigation", () => {
	it("week titles", () => {
		expect(weekTitle(["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"])).toBe("Sep 28 – Oct 4, 2026");
		expect(weekTitle(["2026-12-28", "2026-12-29", "2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02", "2027-01-03"])).toBe("Dec 28, 2026 – Jan 3, 2027");
	});

	it("month titles", () => {
		expect(monthTitle("2026-10-14")).toBe("October 2026");
		expect(monthTitle("2027-01-01")).toBe("January 2027");
	});

	it("shifts by a week or a month; month steps land on today when it is in that month", () => {
		expect(shiftAnchor("2026-10-01", "week", 1, "2026-10-01")).toBe("2026-10-08");
		expect(shiftAnchor("2026-10-01", "week", -1, "2026-10-01")).toBe("2026-09-24");
		expect(shiftAnchor("2026-10-14", "month", 1, "2026-10-01")).toBe("2026-11-01");
		expect(shiftAnchor("2026-10-14", "month", -1, "2026-10-01")).toBe("2026-09-01");
		expect(shiftAnchor("2026-11-01", "month", -1, "2026-10-01")).toBe("2026-10-01");
		expect(shiftAnchor("2026-12-01", "month", 1, "2026-10-01")).toBe("2027-01-01");
		expect(shiftAnchor("2026-01-31", "month", 1, "2026-10-01")).toBe("2026-02-01");
	});

	it("formats minutes as HH:mm, wrapping 24:00", () => {
		expect(fmtMin(0)).toBe("00:00");
		expect(fmtMin(1140)).toBe("19:00");
		expect(fmtMin(1440)).toBe("00:00");
		expect(fmtMin(1470)).toBe("00:30");
	});
});

describe("repeating tasks on the calendar", () => {
	// Repeating tasks on the calendar. The clock is Thursday 2026-10-01,
	// so the visible week is Mon 2026-09-28 to Sun 2026-10-04. "Weekly review" repeats every Friday from 2026-10-02.

	afterEach(() => {
		vi.useRealTimers();
	});

	const rule = { freq: "weekly", interval: 1, weekdays: null, monthly: null, afterCompletion: false, time: null, tz: null } as const;
	const timedRule = { ...rule, time: "09:00", tz: "Europe/Berlin" } as const;

	async function seed(m: AppMount, r: typeof rule | typeof timedRule = rule) {
		const task = (await m.h.app.tasks.create({ title: "Weekly review", scheduled: { kind: "date", date: "2026-10-02" }, repeat: { rule: r } } as never)).task;
		await m.h.app.tasks.create({ title: "Dentist", scheduled: { kind: "date", date: "2026-10-01" } });
		await settle();
		return task;
	}

	const classes = (el: Element) => [...el.classList];

	describe("week view", () => {
		it("draws the current occurrence solid with the repeat icon before the title, and says it repeats", async () => {
			const m = await mountApp();
			await seed(m);
			await openCalendar(m);
			const e = entry(cal(m.root), "Weekly review");
			expect(classes(e)).toContain("is-repeat");
			expect(classes(e)).not.toContain("is-future");
			expect(entryName(e)).toBe("Weekly review, Fri Oct 2, all day, repeats");
			const body = e.querySelector(".cp-cal-entry-body")!;
			expect(body.firstElementChild?.classList.contains("cp-cal-repeat")).toBe(true);
			expect(body.querySelector('.cp-cal-repeat[data-icon="repeat"]')).not.toBeNull();
			// A task that does not repeat has no icon and no repeat class.
			const plain = entry(cal(m.root), "Dentist");
			expect(classes(plain)).not.toContain("is-repeat");
			expect(plain.querySelector(".cp-cal-repeat")).toBeNull();
		});

		it("draws the next weeks' occurrences faded with a dashed edge (is-future) and names them", async () => {
			const m = await mountApp();
			await seed(m);
			await openCalendar(m);
			await click(byLabel(cal(m.root), "Next week"));
			const e = entry(cal(m.root), "Weekly review");
			expect(classes(e)).toContain("is-future");
			expect(classes(e)).toContain("is-repeat");
			expect(entryName(e)).toBe("Weekly review, Fri Oct 9, all day, repeats, future occurrence");
		});

		it("a done occurrence is struck through like a completed task", async () => {
			const m = await mountApp();
			const t = await seed(m);
			await m.h.app.recurrence.complete(t.id);
			await openCalendar(m);
			const done = entry(cal(m.root), "Weekly review");
			expect(classes(done)).toContain("is-completed");
			expect(classes(done)).not.toContain("is-future");
			expect(entryName(done)).toContain("completed");
			await click(byLabel(cal(m.root), "Next week"));
			// The new current occurrence (Oct 9) is solid.
			expect(classes(entry(cal(m.root), "Weekly review"))).not.toContain("is-future");
		});

		it("a timed series draws blocks with the icon too, and they cannot be resized or moved", async () => {
			const m = await mountApp();
			await seed(m, timedRule);
			await openCalendar(m);
			stubWeek(m.root);
			const block = entry(cal(m.root), "Weekly review", ".cp-cal-daycol");
			expect(classes(block)).toContain("is-block");
			expect(classes(block)).toContain("is-repeat");
			expect(block.querySelector(".cp-cal-repeat")).not.toBeNull();
			expect(block.querySelector(".cp-cal-resize")).toBeNull();
		});
	});

	describe("no drag", () => {
		it("pressing and dragging an all-day occurrence changes nothing and starts no drag", async () => {
			const m = await mountApp();
			const t = await seed(m);
			await openCalendar(m);
			stubWeek(m.root);
			const before = JSON.stringify(m.h.app.store.state.tasks.get(t.id));
			const notices = recordNotices(m.host);
			const e = entry(cal(m.root), "Weekly review");
			await dragTo(e, { x: 450, y: -75 }, { x: 50, y: -75 });
			expect(cal(m.root).classList.contains("is-dragging")).toBe(false);
			expect(e.classList.contains("is-dragging")).toBe(false);
			expect(cal(m.root).querySelector(".cp-cal-ghost")).toBeNull();
			expect(JSON.stringify(m.h.app.store.state.tasks.get(t.id))).toBe(before);
			expect(notices).toEqual([]);
		});

		it("a timed occurrence is not moved either", async () => {
			const m = await mountApp();
			const t = await seed(m, timedRule);
			await openCalendar(m);
			stubWeek(m.root);
			const before = JSON.stringify(m.h.app.store.state.tasks.get(t.id));
			const block = entry(cal(m.root), "Weekly review", ".cp-cal-daycol");
			await dragTo(block, { x: 450, y: 450 }, { x: 150, y: 600 });
			expect(cal(m.root).classList.contains("is-dragging")).toBe(false);
			expect(JSON.stringify(m.h.app.store.state.tasks.get(t.id))).toBe(before);
		});

		it("opens the details pane on a click, as for any task", async () => {
			const m = await mountApp();
			await seed(m);
			await openCalendar(m);
			await click(entry(cal(m.root), "Weekly review"));
			const pane = q(cal(m.root), ".cp-details");
			expect(pane.querySelector(".cp-due-chip")?.textContent).toContain("Tomorrow · every Fri");
		});
	});

	describe("month view", () => {
		it("shows every Friday: the first solid, the later ones faded; a week click shows them again", async () => {
			const m = await mountApp();
			await seed(m);
			await openCalendar(m);
			await click([...cal(m.root).querySelectorAll<HTMLButtonElement>(".cp-cal-mode button")].find((b) => b.textContent?.trim() === "Month"));
			const on = (date: string) => entries(cell(cal(m.root), "cell", date), "Weekly review");
			expect(on("2026-10-02")).toHaveLength(1);
			expect(classes(on("2026-10-02")[0]!)).not.toContain("is-future");
			for (const date of ["2026-10-09", "2026-10-16", "2026-10-23", "2026-10-30"]) {
				expect(on(date), date).toHaveLength(1);
				expect(classes(on(date)[0]!), date).toContain("is-future");
			}
			expect(on("2026-10-03")).toHaveLength(0);
			expect(on("2026-10-09")[0]!.querySelector(".cp-cal-repeat")).not.toBeNull();
		});
	});

	describe("the Unscheduled drawer", () => {
		it("lists open tasks without a date and never a repeating task", async () => {
			const m = await mountApp();
			await seed(m);
			await m.h.app.tasks.create({ title: "Someday" });
			await openCalendar(m);
			await click(cal(m.root).querySelector(".cp-cal-unscheduled-toggle, [aria-label='Unscheduled']"));
			const rows = [...cal(m.root).querySelectorAll(".cp-cal-unscheduled .cp-task-row .cp-task-title")].map((r) => r.textContent.trim());
			expect(rows).toEqual(["Someday"]);
		});
	});
});
