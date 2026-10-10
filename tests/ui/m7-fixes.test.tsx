// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { explicitRule } from "../../src/domain/recurrence";
import { columnPatch, datePatch } from "../../src/ui/board/BoardView";
import { groupPatch } from "../../src/ui/groupDrop";
import { hasRepeatEditRequest, isPaneShown, notifyReanchored, onRepeatEditRequest, requestRepeatEdit } from "../../src/ui/repeatActions";
import { chipLabel } from "../../src/ui/quickadd/chipLabels";
import type { Chip } from "../../src/parsing";
import { cal, cell, click, entries, entry, entryName, openCalendar } from "./m3-helpers";
import { type M7Mount, FRIDAY, lastNotice, mountM7, q, rowFor, rowsFor, settle, showInbox, taskById, weeklyFriday } from "./m7-helpers";
import { checkedOf, openViewMenu, pickItem } from "./view-menu-helpers";
import { menuItem } from "./u1-helpers";

// Repeating tasks: timed series moves, re-anchor notices, selection of history rows, the
// "Edit repeat…" request, the calendar's missed occurrences and the details picker's anchor.

const mounted: M7Mount[] = [];
afterEach(() => {
	for (const m of mounted.splice(0)) m.unmount();
});
async function mount(): Promise<M7Mount> {
	const m = await mountM7();
	mounted.push(m);
	return m;
}

const timedWeekly = { kind: "datetime", local: `${FRIDAY}T07:00`, tz: "Europe/Berlin" } as const;
const create = async (m: M7Mount, title: string, extra: Record<string, unknown> = {}) =>
	(await m.h.app.tasks.create({ title, scheduled: { kind: "date", date: FRIDAY }, repeat: weeklyFriday, ...extra } as never)).task;
const contextMenu = async (m: M7Mount, row: HTMLElement) => {
	row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
	await settle();
	return m.host.menus.at(-1)!;
};
const ZONE = "Europe/Berlin";

describe("a timed series keeps its time when its date moves (D5)", () => {
	it("the board's patches move the current occurrence, keeping time and zone; a plain task is unchanged", async () => {
		const m = await mount();
		const t = await create(m, "Gym", { scheduled: timedWeekly });
		const spec = m.h.app.effectiveSchedule(taskById(m, t.id));
		expect(spec).toEqual(timedWeekly);
		expect(datePatch(t, "2026-10-12", ZONE, spec)).toEqual({ scheduled: { kind: "datetime", local: "2026-10-12T07:00", tz: ZONE } });
		// Its own current date is no change.
		expect(datePatch(t, FRIDAY, ZONE, spec)).toEqual({});
		const ctx = m.h.app.queryContext();
		const column = { id: "2026-10-12", title: "", date: "2026-10-12", acceptsDrop: true, cards: [], completed: [] };
		expect(columnPatch(t, column, ctx, spec)).toEqual({ scheduled: { kind: "datetime", local: "2026-10-12T07:00", tz: ZONE } });
		expect(groupPatch(t, { kind: "date", date: "2026-10-12" }, ctx, spec)).toEqual({ scheduled: { kind: "datetime", local: "2026-10-12T07:00", tz: ZONE } });
		// Without the schedule the series (scheduled null) would have become all-day: the bug.
		expect(datePatch(t, "2026-10-12", ZONE)).toEqual({ scheduled: { kind: "date", date: "2026-10-12" } });
		const plain = (await m.h.app.tasks.create({ title: "Plain", scheduled: { kind: "datetime", local: `${FRIDAY}T19:00`, tz: ZONE } })).task;
		expect(datePatch(plain, "2026-10-12", ZONE)).toEqual({ scheduled: { kind: "datetime", local: "2026-10-12T19:00", tz: ZONE } });
	});

	it("'Schedule for tomorrow' on a timed series re-anchors it at the same time", async () => {
		const m = await mount();
		const t = await create(m, "Gym", { scheduled: timedWeekly });
		const section = await showInbox(m);
		menuItem(await contextMenu(m, rowFor(section, "Gym")), "Schedule for tomorrow").run();
		await settle();
		const rec = taskById(m, t.id).recurrence!;
		expect(rec.anchor).toBe("2026-10-02");
		expect(rec.versions.at(-1)!.rule).toMatchObject({ time: "07:00", tz: ZONE });
		expect(m.h.app.effectiveSchedule(taskById(m, t.id))).toEqual({ kind: "datetime", local: "2026-10-02T07:00", tz: ZONE });
	});
});

describe("re-anchor notices", () => {
	/** The service answers `reanchored` the way the real service does; the real write still runs. */
	function reanchoring(m: M7Mount, reanchored: { date: string; endCleared: boolean }) {
		const orig = m.h.app.tasks.update.bind(m.h.app.tasks);
		vi.spyOn(m.h.app.tasks, "update").mockImplementation(async (...args) => ({ ...(await orig(...args)), reanchored }));
	}

	it("a Schedule for… item on a series says the series now repeats from the new date, and whether its end was removed", async () => {
		const m = await mount();
		await create(m, "Weekly review");
		reanchoring(m, { date: "2026-10-02", endCleared: true });
		const section = await showInbox(m);
		menuItem(await contextMenu(m, rowFor(section, "Weekly review")), "Schedule for tomorrow").run();
		await settle();
		expect(lastNotice(m)).toEqual({ message: '"Weekly review" now repeats from Tomorrow. Its end was removed.', label: "Edit task" });
		expect(lastNotice(m)?.label).toBe(m.h.app.store.undoLabel);
	});

	it("without endCleared the notice has no end sentence; a plain task's date change has no notice", async () => {
		const m = await mount();
		await create(m, "Weekly review");
		await m.h.app.tasks.create({ title: "Plain" });
		const section = await showInbox(m);
		reanchoring(m, { date: "2026-10-02", endCleared: false });
		menuItem(await contextMenu(m, rowFor(section, "Weekly review")), "Schedule for tomorrow").run();
		await settle();
		expect(lastNotice(m)?.message).toBe('"Weekly review" now repeats from Tomorrow.');
		vi.restoreAllMocks();
		const before = m.notices.length;
		menuItem(await contextMenu(m, rowFor(section, "Plain")), "Schedule for tomorrow").run();
		await settle();
		expect(m.notices.length).toBe(before);
	});

	it("no notice when the write changed nothing", async () => {
		const m = await mount();
		await create(m, "Weekly review");
		const orig = m.h.app.tasks.update.bind(m.h.app.tasks);
		vi.spyOn(m.h.app.tasks, "update").mockImplementation(async (...args) => ({ ...(await orig(...args)), changed: false, reanchored: { date: FRIDAY, endCleared: false } }));
		const section = await showInbox(m);
		menuItem(await contextMenu(m, rowFor(section, "Weekly review")), "Schedule for tomorrow").run();
		await settle();
		expect(m.notices).toEqual([]);
	});

	it("notifyReanchored words the date relative to today", async () => {
		const m = await mount();
		notifyReanchored(m.host, { title: "X" }, { date: FRIDAY, endCleared: false }, "Move task");
		expect(lastNotice(m)).toEqual({ message: '"X" now repeats from Fri, Oct 9.', label: "Move task" });
	});
});

describe("selection and the Edit repeat… request", () => {
	it("selecting a series marks its open row, not its Completed history rows", async () => {
		const m = await mount();
		const t = await create(m, "Weekly review");
		await m.h.app.recurrence.complete(t.id);
		const section = await showInbox(m);
		await click(section.querySelector(".cp-completed-toggle"));
		await click(rowsFor(section, "Weekly review").find((r) => r.dataset.occurrence === undefined));
		const rows = rowsFor(section, "Weekly review");
		expect(rows).toHaveLength(2);
		expect(rows.filter((r) => r.classList.contains("is-selected")).map((r) => r.dataset.occurrence)).toEqual([undefined]);
		expect(rows.find((r) => r.dataset.occurrence !== undefined)!.getAttribute("aria-selected")).toBe("false");
	});

	it("the first visible pane takes the request and it is spent; a later mount does not open the picker", async () => {
		const m = await mount();
		const t = await create(m, "Weekly review");
		const seen: string[] = [];
		const off = onRepeatEditRequest((id) => {
			seen.push(id);
			return false; // a hidden copy: declines
		});
		requestRepeatEdit(t.id);
		expect(seen).toEqual([t.id]);
		// Nobody took it: a pane mounting now (visible) still finds it, once.
		expect(hasRepeatEditRequest(t.id, false)).toBe(false);
		expect(hasRepeatEditRequest(t.id)).toBe(true);
		expect(hasRepeatEditRequest(t.id)).toBe(false);
		off();
		// A listener that takes it spends it.
		const take = onRepeatEditRequest(() => true);
		requestRepeatEdit(t.id);
		expect(hasRepeatEditRequest(t.id)).toBe(false);
		take();
	});

	it("re-selecting the task after the picker closed does not open it again", async () => {
		const m = await mount();
		const t = await create(m, "Weekly review");
		const section = await showInbox(m);
		menuItem(await contextMenu(m, rowFor(section, "Weekly review")), "Edit repeat…").run();
		await settle();
		expect(section.querySelector(".cp-details .cp-repeat-pop")).not.toBeNull();
		await click(q(section, ".cp-details-close"));
		await click(rowFor(section, "Weekly review"));
		expect(section.querySelector(".cp-details .cp-repeat-pop")).toBeNull();
		expect(hasRepeatEditRequest(t.id)).toBe(false);
	});
});

describe("the details picker names the current occurrence", () => {
	it("a series anchored on a Monday and due on a Friday hints from the Friday, and Weekly and Monthly store that weekday and day", async () => {
		const m = await mount();
		// Every Monday and Friday from Monday Oct 5; completing the Monday leaves Friday Oct 9 as the current occurrence.
		const t = (
			await m.h.app.tasks.create({
				title: "Review",
				scheduled: { kind: "date", date: "2026-10-05" },
				repeat: { rule: { ...weeklyFriday.rule, weekdays: ["MO", "FR"] } },
			} as never)
		).task;
		await m.h.app.recurrence.complete(t.id);
		expect(m.h.app.effectiveSchedule(taskById(m, t.id))).toEqual({ kind: "date", date: FRIDAY });
		const section = await showInbox(m);
		await click(rowFor(section, "Review"));
		await click(q(section, ".cp-details .cp-due-chip"));
		await click(q(section, ".cp-details .cp-repeat-button"));
		const opt = (id: string) => q(section, `.cp-details [data-preset="${id}"]`);
		// The series' own anchor (Monday the 5th) must not be what the hints say.
		expect(opt("weekly").querySelector("small")?.textContent).toBe("on Friday");
		expect(opt("monthly").querySelector("small")?.textContent).toBe("on the 9th");
		await click(opt("weekly"));
		expect(taskById(m, t.id).recurrence?.versions.at(-1)?.rule.weekdays).toEqual(["FR"]);
		await click(q(section, ".cp-details .cp-repeat-button"));
		await click(opt("monthly"));
		expect(taskById(m, t.id).recurrence?.versions.at(-1)?.rule).toMatchObject({ freq: "monthly", monthly: { kind: "day", day: 9 } });
	});

	it("a month-end series due on the 30th still reads, and keeps, the 31st (Quick Add 'every month' on the 31st)", async () => {
		const m = await mount();
		const monthly = { ...weeklyFriday.rule, freq: "monthly" } as const;
		const t = (await m.h.app.tasks.create({ title: "Rent", scheduled: { kind: "date", date: "2026-10-31" }, repeat: { rule: monthly } } as never)).task;
		await m.h.app.recurrence.complete(t.id);
		expect(m.h.app.effectiveSchedule(taskById(m, t.id))).toEqual({ kind: "date", date: "2026-11-30" });
		const section = await showInbox(m);
		await click(rowFor(section, "Rent"));
		await click(q(section, ".cp-details .cp-due-chip"));
		const button = q(section, ".cp-details .cp-repeat-button");
		expect(button.textContent).toBe("monthly on the 31st");
		expect(rowFor(section, "Rent").querySelector(".cp-meta-repeat-text")?.textContent).toContain("31st");
		// Custom → Done with nothing changed is no edit; in particular it never stores the 30th (Dec 30, Jan 30, Mar 30).
		await click(button);
		await click(q(section, '.cp-details [data-preset="custom"]'));
		expect(q(section, ".cp-details .cp-repeat-custom").textContent).toContain("Day 31");
		const before = JSON.stringify(taskById(m, t.id).recurrence);
		await click(q(section, ".cp-details .cp-repeat-done"));
		expect(JSON.stringify(taskById(m, t.id).recurrence)).toBe(before);
		expect(m.notices).toEqual([]);
		// Changing something else in Custom keeps the 31st.
		await click(q(section, ".cp-details .cp-repeat-button"));
		await click(q(section, '.cp-details [data-preset="custom"]'));
		await click(q(section, '.cp-details .cp-repeat-seg [data-end="count"]'));
		await click(q(section, ".cp-details .cp-repeat-done"));
		const rec = taskById(m, t.id).recurrence!;
		expect(rec.end).toEqual({ kind: "count", count: 10 });
		// The rule still means the 31st (stored as "the anchor's day" or spelled out), never the 30th.
		expect(explicitRule(rec.versions.at(-1)!.rule, rec.anchor).monthly).toEqual({ kind: "day", day: 31 });
		expect(m.h.app.effectiveSchedule(taskById(m, t.id))).toEqual({ kind: "date", date: "2026-11-30" });
	});

	it("a weekly series with no picked weekday shows its own anchor's weekday pressed in Custom, and nothing is written until Done", async () => {
		const m = await mount();
		const t = await create(m, "Weekly review");
		const section = await showInbox(m);
		await click(rowFor(section, "Weekly review"));
		await click(q(section, ".cp-details .cp-due-chip"));
		await click(q(section, ".cp-details .cp-repeat-button"));
		await click(q(section, '.cp-details [data-preset="custom"]'));
		expect(q(section, ".cp-details .cp-repeat-day[data-day='FR']").getAttribute("aria-pressed")).toBe("true");
		expect(taskById(m, t.id).recurrence?.versions.at(-1)?.rule.weekdays).toBeNull();
	});
});

describe("which pane takes the Edit repeat… request", () => {
	it("isPaneShown: not inside a hidden section; Obsidian's isShown when the element has it, else a layout box", () => {
		const el = document.createElement("div");
		document.body.appendChild(el);
		expect(isPaneShown(null)).toBe(false);
		expect(isPaneShown(el)).toBe(true);
		// The fallback: no isShown, no layout box (a background tab's pane).
		el.getClientRects = () => [] as unknown as DOMRectList;
		expect(isPaneShown(el)).toBe(false);
		// With isShown the box is not asked.
		(el as HTMLElement & { isShown: () => boolean }).isShown = () => true;
		expect(isPaneShown(el)).toBe(true);
		(el as HTMLElement & { isShown: () => boolean }).isShown = () => false;
		el.getClientRects = () => [{}] as unknown as DOMRectList;
		expect(isPaneShown(el)).toBe(false);
		const hidden = document.createElement("section");
		hidden.hidden = true;
		const inner = document.createElement("div");
		hidden.appendChild(inner);
		document.body.appendChild(hidden);
		expect(isPaneShown(inner)).toBe(false);
		el.remove();
		hidden.remove();
	});

	it("a pane without a layout box (a background Logwell tab) leaves the request unspent and its picker closed", async () => {
		const m = await mount();
		const t = await create(m, "Weekly review");
		const section = await showInbox(m);
		await click(rowFor(section, "Weekly review"));
		const pane = q(section, ".cp-details");
		pane.getClientRects = () => [] as unknown as DOMRectList;
		requestRepeatEdit(t.id);
		await settle();
		expect(pane.querySelector(".cp-repeat-pop")).toBeNull();
		expect(hasRepeatEditRequest(t.id)).toBe(true);
	});
});

describe("calendar selection of a series", () => {
	it("only the current occurrence's entry is selected, not every date of the series", async () => {
		const m = await mount();
		await m.h.app.tasks.create({ title: "Chore", scheduled: { kind: "date", date: "2026-10-01" }, repeat: { rule: { ...weeklyFriday.rule, freq: "daily" } } } as never);
		await openCalendar(m);
		const week = cal(m.root);
		const chores = () => entries(week, "Chore");
		expect(chores().length).toBeGreaterThan(2);
		await click(entry(week, "Chore", `.cp-cal-allday-cell[data-date="2026-10-01"]`));
		const selected = chores().filter((e) => e.classList.contains("is-selected"));
		expect(selected).toHaveLength(1);
		expect(selected[0]!.closest("[data-date]")!.getAttribute("data-date")).toBe("2026-10-01");
	});
});

describe("the row chip describes the rule in force today", () => {
	it("a version that starts in the future is not the chip's text", async () => {
		const m = await mount();
		const t = await create(m, "Gym");
		await m.h.app.recurrence.setRepeat(t.id, { ...weeklyFriday.rule, freq: "daily" } as never, "2026-10-20");
		const section = await showInbox(m);
		expect(rowFor(section, "Gym").querySelector(".cp-meta-repeat-text")?.textContent).toBe("every Fri");
		expect(rowFor(section, "Gym").querySelector<HTMLElement>(".cp-meta-repeat")!.title).toBe("Repeats every Fri");
	});

	it("a timed rule's time is in the chip's title", async () => {
		const m = await mount();
		await create(m, "Gym", { scheduled: timedWeekly });
		const section = await showInbox(m);
		expect(rowFor(section, "Gym").querySelector(".cp-meta-repeat-text")?.textContent).toBe("every Fri");
		expect(rowFor(section, "Gym").querySelector<HTMLElement>(".cp-meta-repeat")!.title).toBe("Repeats every Fri at 07:00");
	});
});

describe("a typed timed repeat shows its time", () => {
	it("the chip label says 'every Mon at 17:00'", () => {
		const chip = {
			id: "c",
			kind: "recurrence",
			status: "applied",
			text: "every monday at 5pm",
			span: { start: 0, end: 19 },
			rule: { freq: "weekly", interval: 1, weekdays: ["MO"], monthly: null, afterCompletion: false, time: "17:00", tz: "Europe/Berlin" },
		} as unknown as Chip;
		expect(chipLabel(chip, { zone: "Europe/Berlin", today: "2026-10-01", categories: [], tags: [] })).toBe("Repeat: every Mon at 17:00");
	});
});

describe("calendar occurrences of an overdue series", () => {
	it("the generated past dates after the current one are missed: faded and dashed with the overdue tint, named as missed", async () => {
		const m = await mount();
		// Daily from Monday Sep 28; today is Thursday Oct 1: Sep 28 is current (overdue), Sep 29 and 30 are missed.
		await m.h.app.tasks.create({ title: "Chore", scheduled: { kind: "date", date: "2026-09-28" }, repeat: { rule: { ...weeklyFriday.rule, freq: "daily" } } } as never);
		await openCalendar(m);
		const week = cal(m.root);
		const on = (date: string) => entries(cell(week, "allday-cell", date), "Chore")[0]!;
		expect([...on("2026-09-28").classList]).not.toContain("is-future");
		for (const date of ["2026-09-29", "2026-09-30"]) {
			const e = on(date);
			expect([...e.classList]).toEqual(expect.arrayContaining(["is-future", "is-past", "is-repeat"]));
			expect(entryName(e)).toContain("missed occurrence");
			expect(entryName(e)).not.toContain("overdue");
		}
		// Today and later are plain future occurrences.
		expect([...on("2026-10-01").classList]).toContain("is-future");
		expect([...on("2026-10-01").classList]).not.toContain("is-past");
		expect(entryName(on("2026-10-01"))).toContain("future occurrence");
	});

	it("a filtered calendar follows the series after an occurrence is skipped (the memo depends on the records)", async () => {
		const m = await mount();
		const work = await m.h.app.categories.create("Work");
		const t = (await m.h.app.tasks.create({ title: "Review", categoryId: work.id, scheduled: { kind: "date", date: "2026-10-01" }, repeat: { rule: { ...weeklyFriday.rule, freq: "daily" } } } as never)).task;
		await openCalendar(m);
		const lists = (await pickItem(m, await openViewMenu(m, cal(m.root)), "Lists…"))!;
		expect(checkedOf(lists, "Work")).toBeFalsy();
		await pickItem(m, lists, "Work");
		expect(entry(cal(m.root), "Review", `.cp-cal-allday-cell[data-date="2026-10-01"]`)).toBeDefined();
		await m.h.app.recurrence.skip(t.id);
		await settle();
		expect(entries(cell(cal(m.root), "allday-cell", "2026-10-01"), "Review")[0]?.classList.contains("is-skipped") ?? false).toBe(false);
		expect([...entry(cal(m.root), "Review", `.cp-cal-allday-cell[data-date="2026-10-02"]`).classList]).not.toContain("is-future");
	});
});
