// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { describeRule } from "../../src/domain/recurrence";
import { RepeatChip } from "../../src/ui/RepeatChip";
import {
	COMPLETE_OCCURRENCE_LABEL,
	REOPEN_OCCURRENCE_LABEL,
	SKIP_OCCURRENCE_LABEL,
	STOP_REPEATING_LABEL,
} from "../../src/app/RecurrenceService";
import { LINGER_MS } from "../../src/ui/useLingering";
import { click, contextMenu, lastNotice, menuItem, mountNode, q, settle } from "./app-helpers";
import { openBoard } from "./board-helpers";
import { type M7Mount, FRIDAY, mountM7, openDetails, rowFor, rowsFor, showInbox, taskById, weeklyFriday } from "./repeat-helpers";
import { menuTitles as titles } from "./view-menu-helpers";

// Repeating tasks in rows, cards and menus. The clock is Thursday
// 2026-10-01 12:00 in Europe/Berlin; 2026-10-09 is the Friday.

const dailyRule = { ...weeklyFriday.rule, freq: "daily" } as const;
const create = async (m: M7Mount, title: string, extra: Record<string, unknown> = {}) =>
	(await m.h.app.tasks.create({ title, scheduled: { kind: "date", date: FRIDAY }, repeat: weeklyFriday, ...extra } as never)).task;
const dateOf = (row: HTMLElement) => row.querySelector(".cp-meta-date")?.textContent;
const checkbox = (row: HTMLElement) => q<HTMLInputElement>(row, ".cp-task-checkbox");
const completedToggle = (root: HTMLElement) => q<HTMLButtonElement>(root, ".cp-completed-toggle");

describe("the row", () => {
	it("shows the current occurrence's date and a purple repeat chip with the rule, next to the subtask count", async () => {
		const m = await mountM7();
		const t = await create(m, "Weekly review");
		await m.h.app.tasks.create({ title: "Inbox zero", parentId: t.id });
		await m.h.app.tasks.create({ title: "Plan next week", parentId: t.id });
		await m.h.app.tasks.create({ title: "Plain" });
		const section = await showInbox(m);
		const row = rowFor(section, "Weekly review");
		const chip = q(row, ".cp-meta-repeat");
		expect(chip.querySelector('[data-icon="repeat"]')).not.toBeNull();
		expect(q(chip, ".cp-meta-repeat-text").textContent).toBe("every Fri");
		expect(chip.title).toBe("Repeats every Fri");
		expect(q(row, ".cp-meta-subtasks").textContent).toBe("0/2");
		expect(dateOf(row)).toBe("Fri, Oct 9");
		// The chip comes before the subtask count and the date.
		const meta = [...q(row, ".cp-task-meta").children].map((c) => c.className.split(" ")[0]);
		expect(meta.indexOf("cp-meta-repeat")).toBeLessThan(meta.indexOf("cp-meta-subtasks"));
		expect(meta.indexOf("cp-meta-subtasks")).toBeLessThan(meta.indexOf("cp-meta-date"));
		// A task that does not repeat looks as before.
		expect(rowFor(section, "Plain").querySelector(".cp-meta-repeat")).toBeNull();
	});

	it("words the chip title with the end", async () => {
		const m = await mountM7();
		await create(m, "Gym", { repeat: { rule: weeklyFriday.rule, end: { kind: "count", count: 4 } } });
		const row = rowFor(await showInbox(m), "Gym");
		expect(q(row, ".cp-meta-repeat").title).toBe("Repeats every Fri · ends after 4 times");
	});

	it("#135: the chip reads the rule in force on the day its row was drawn for, not the app's day", async () => {
		const m = await mountM7();
		const t = await create(m, "Weekly review");
		const rec = t.recurrence!;
		const first = rec.versions[0]!;
		// A daily rule from November on: the app's day (October 1) still has the weekly one.
		const task = { ...t, recurrence: { ...rec, versions: [first, { ...first, effectiveFrom: "2026-11-06", rule: { ...first.rule, freq: "daily" as const } }] } };
		const root = mountNode(<RepeatChip host={m.host} task={task} today="2026-11-10" />);
		expect(root.querySelector(".cp-meta-repeat-text")!.textContent).toBe(describeRule(task.recurrence, "2026-11-10"));
		expect(root.querySelector(".cp-meta-repeat-text")!.textContent).not.toBe("every Fri");
	});

	it("a board card shows the chip and the occurrence's date", async () => {
		const m = await mountM7();
		await create(m, "Weekly review");
		await openBoard(m, "Inbox");
		const item = [...m.root.querySelectorAll<HTMLElement>(".cp-tasks .cp-board-item")].find((i) => i.textContent?.includes("Weekly review"))!;
		expect(q(item, ".cp-meta-repeat-text").textContent).toBe("every Fri");
		expect(q(item, ".cp-meta-date").textContent).toBe("Fri, Oct 9");
	});
});

describe("the row menu", () => {
	it("offers Skip this occurrence, Edit repeat… and Stop repeating after Complete, only for an open repeating task", async () => {
		const m = await mountM7();
		await create(m, "Weekly review");
		await m.h.app.tasks.create({ title: "Plain" });
		const section = await showInbox(m);
		const menu = await contextMenu(m, rowFor(section, "Weekly review"));
		const names = titles(menu);
		const at = names.indexOf("Complete");
		expect(names.slice(at, at + 4)).toEqual(["Complete", "Skip this occurrence", "Edit repeat…", "Stop repeating"]);
		expect(menuItem(menu, "Skip this occurrence").icon).toBe("skip-forward");
		expect(menuItem(menu, "Edit repeat…").icon).toBe("repeat");
		expect(menuItem(menu, "Stop repeating").icon).toBe("ban");
		const clear = menuItem(menu, "Clear schedule (change the repeat instead)");
		expect(clear.disabled).toBe(true);
		// Scheduling still works: it re-anchors the series.
		expect(menuItem(menu, "Schedule for tomorrow").disabled).not.toBe(true);
		const plain = titles(await contextMenu(m, rowFor(section, "Plain")));
		for (const gone of ["Skip this occurrence", "Edit repeat…", "Stop repeating"]) expect(plain).not.toContain(gone);
		expect(plain).toContain("Clear schedule");
	});

	it("Skip this occurrence skips the date, moves the row on and shows an Undo notice with the store's label", async () => {
		const m = await mountM7();
		const t = await create(m, "Weekly review");
		const section = await showInbox(m);
		menuItem(await contextMenu(m, rowFor(section, "Weekly review")), "Skip this occurrence").run();
		await settle();
		expect(lastNotice(m)).toEqual({ message: 'Skipped "Weekly review" for Fri, Oct 9.', label: SKIP_OCCURRENCE_LABEL });
		expect(m.h.app.store.undoLabel).toBe(SKIP_OCCURRENCE_LABEL);
		expect(dateOf(rowFor(section, "Weekly review"))).toBe("Fri, Oct 16");
		// The notice's own Undo, bound as the host binds it, reverts the skip.
		await expect(m.host.undoButtons.at(-1)!()).resolves.toBe(true);
		expect(m.h.app.store.undoLabel).not.toBe(SKIP_OCCURRENCE_LABEL);
		menuItem(await contextMenu(m, rowFor(section, "Weekly review")), "Skip this occurrence").run();
		await settle();
		expect(taskById(m, t.id).recurrence?.endedAt).toBeNull();
	});

	it("Edit repeat… opens the details pane on the task with its picker open", async () => {
		const m = await mountM7();
		await create(m, "Weekly review");
		const section = await showInbox(m);
		expect(section.querySelector(".cp-details")).toBeNull();
		menuItem(await contextMenu(m, rowFor(section, "Weekly review")), "Edit repeat…").run();
		await settle();
		const pane = q(section, ".cp-details");
		expect(q(pane, ".cp-repeat-field .cp-repeat-pop")).not.toBeNull();
		expect(q(pane, ".cp-repeat-button").textContent).toBe("every Fri");
	});

	it("Stop repeating asks first; cancel changes nothing, confirm ends the series and keeps its history in Completed", async () => {
		const m = await mountM7();
		const t = await create(m, "Weekly review");
		const section = await showInbox(m);
		const run = async () => menuItem(await contextMenu(m, rowFor(section, "Weekly review")), "Stop repeating").run();
		await run();
		await settle();
		expect(m.asked).toEqual([
			{ title: "Stop repeating", message: 'Stop repeating "Weekly review"? Its history stays in Completed.', buttons: ["Stop repeating"] },
		]);
		expect(taskById(m, t.id).recurrence?.endedAt).toBeNull();
		expect(m.notices).toEqual([]);
		m.answer.value = true;
		await run();
		await settle();
		expect(taskById(m, t.id).recurrence?.endedAt).not.toBeNull();
		expect(taskById(m, t.id).status).toBe("completed");
		expect(lastNotice(m)).toEqual({ message: 'Stopped repeating "Weekly review".', label: STOP_REPEATING_LABEL });
		expect(m.h.app.store.undoLabel).toBe(STOP_REPEATING_LABEL);
		// The stopped series is a completed task now, in Completed once its check animation ended: no chip.
		await new Promise((r) => setTimeout(r, LINGER_MS + 100));
		await settle();
		await click(completedToggle(section));
		expect(rowFor(section, "Weekly review").querySelector(".cp-meta-repeat")).toBeNull();
	});
});

describe("completing an occurrence", () => {
	it("the checkbox completes the date, keeps the row with its next date and says so with Undo; nothing to confirm for the subtasks", async () => {
		const m = await mountM7();
		const t = await create(m, "Weekly review");
		const sub = (await m.h.app.tasks.create({ title: "Inbox zero", parentId: t.id })).task;
		const section = await showInbox(m);
		await click(checkbox(rowFor(section, "Weekly review")));
		expect(m.asked).toEqual([]);
		expect(lastNotice(m)).toEqual({ message: 'Completed "Weekly review" for Fri, Oct 9.', label: COMPLETE_OCCURRENCE_LABEL });
		expect(m.h.app.store.undoLabel).toBe(COMPLETE_OCCURRENCE_LABEL);
		const row = rowFor(section, "Weekly review");
		expect(dateOf(row)).toBe("Fri, Oct 16");
		expect(checkbox(row).checked).toBe(false);
		expect(taskById(m, t.id).status).toBe("open");
		expect(taskById(m, sub.id).status).toBe("open");
	});

	it("an overdue series: one done record and the earlier dates skipped, told in the notice", async () => {
		const m = await mountM7();
		await create(m, "Stretch", { scheduled: { kind: "date", date: "2026-09-25" }, repeat: { rule: dailyRule } });
		const section = await showInbox(m);
		await click(checkbox(rowFor(section, "Stretch")));
		expect(lastNotice(m)?.message).toBe('Completed "Stretch" for Fri, Sep 25, 5 earlier dates skipped.');
		expect(lastNotice(m)?.label).toBe(COMPLETE_OCCURRENCE_LABEL);
		expect(dateOf(rowFor(section, "Stretch"))).toBe("Today");
		const records = [...m.h.app.store.state.occurrenceRecords.values()];
		expect(records.filter((r) => r.status === "done")).toHaveLength(1);
		expect(records.filter((r) => r.status === "skipped" && r.auto)).toHaveLength(5);
	});

	it("the last allowed occurrence ends the series, and the notice says so", async () => {
		const m = await mountM7();
		const t = await create(m, "Once", { repeat: { rule: weeklyFriday.rule, end: { kind: "count", count: 1 } } });
		const section = await showInbox(m);
		await click(checkbox(rowFor(section, "Once")));
		expect(lastNotice(m)?.message).toBe('Completed "Once" for Fri, Oct 9. The series has ended.');
		expect(taskById(m, t.id).status).toBe("completed");
	});

	it("a plain task completes as before: no notice", async () => {
		const m = await mountM7();
		await m.h.app.tasks.create({ title: "Plain" });
		const section = await showInbox(m);
		await click(checkbox(rowFor(section, "Plain")));
		expect(m.notices).toEqual([]);
		expect(m.asked).toEqual([]);
	});
});

describe("a series that has ended but is still open (a hand-edited file or a sync)", () => {
	/** Logwell never leaves a series ended and open, but loads one. */
	const endedOpen = async (m: M7Mount, title: string) => {
		const t = await create(m, title);
		await m.h.app.store.run(
			"Test setup",
			(tx) => {
				const cur = tx.get("tasks", t.id)!;
				tx.put("tasks", { ...cur, recurrence: { ...cur.recurrence!, endedAt: "2026-09-30T10:00:00.000Z" } });
			},
			{ undoable: false },
		);
		return t;
	};

	it("#131: the checkbox completes it as a plain task, without an error", async () => {
		const m = await mountM7();
		const t = await endedOpen(m, "Weekly review");
		const section = await showInbox(m);
		await click(checkbox(rowFor(section, "Weekly review")));
		expect(m.host.messages).toEqual([]);
		expect(taskById(m, t.id).status).toBe("completed");
		expect(m.h.app.store.undoLabel).toBe("Complete task");
		expect([...m.h.app.store.state.occurrenceRecords.values()]).toEqual([]);
	});

	it("#131: its menu offers Complete without the repeat actions, and Complete completes it", async () => {
		const m = await mountM7();
		const t = await endedOpen(m, "Weekly review");
		const section = await showInbox(m);
		const menu = await contextMenu(m, rowFor(section, "Weekly review"));
		const names = titles(menu);
		expect(names).toContain("Complete");
		for (const gone of ["Skip this occurrence", "Edit repeat…", "Stop repeating"]) expect(names).not.toContain(gone);
		menuItem(menu, "Complete").run?.();
		await settle();
		expect(m.host.messages).toEqual([]);
		expect(taskById(m, t.id).status).toBe("completed");
	});
});

describe("Completed history rows (D7)", () => {
	async function twoDone(m: M7Mount) {
		const t = await create(m, "Weekly review");
		const section = await showInbox(m);
		await click(checkbox(rowFor(section, "Weekly review")));
		await click(checkbox(rowFor(section, "Weekly review")));
		await click(completedToggle(section));
		return { t, section };
	}

	it("one row per done occurrence: the title and the date, checked, keyed by task and date, without the repeat chip", async () => {
		const m = await mountM7();
		const { section } = await twoDone(m);
		const rows = rowsFor(section, "Weekly review");
		// The open row, then the two history rows.
		expect(rows).toHaveLength(3);
		const history = rows.filter((r) => r.dataset.occurrence !== undefined);
		expect(history.map((r) => r.dataset.occurrence).sort()).toEqual([FRIDAY, "2026-10-16"]);
		expect(history.map((r) => q(r, ".cp-task-title").textContent).sort()).toEqual(["Weekly review · Fri, Oct 16", "Weekly review · Fri, Oct 9"]);
		expect(new Set(rows.map((r) => r.dataset.rowKey)).size).toBe(3);
		for (const r of history) {
			expect(r.classList.contains("is-completed")).toBe(true);
			expect(checkbox(r).checked).toBe(true);
			expect(r.querySelector(".cp-meta-repeat")).toBeNull();
			expect(r.querySelector(".cp-meta-date")).toBeNull();
		}
		expect(rows.filter((r) => r.dataset.occurrence === undefined)).toHaveLength(1);
	});

	it("the checkbox reopens that occurrence with an Undo notice", async () => {
		const m = await mountM7();
		const { section } = await twoDone(m);
		const oct9 = rowsFor(section, "Weekly review").find((r) => r.dataset.occurrence === FRIDAY)!;
		await click(checkbox(oct9));
		expect(lastNotice(m)).toEqual({ message: 'Reopened "Weekly review" for Fri, Oct 9.', label: REOPEN_OCCURRENCE_LABEL });
		expect(m.h.app.store.undoLabel).toBe(REOPEN_OCCURRENCE_LABEL);
		expect(rowsFor(section, "Weekly review").some((r) => r.dataset.occurrence === FRIDAY)).toBe(false);
		// Oct 9 is unresolved again and is the current occurrence.
		expect(dateOf(rowsFor(section, "Weekly review").find((r) => r.dataset.occurrence === undefined)!)).toBe("Fri, Oct 9");
	});

	it("the menu offers only Open details and Reopen", async () => {
		const m = await mountM7();
		const { section } = await twoDone(m);
		const oct9 = rowsFor(section, "Weekly review").find((r) => r.dataset.occurrence === FRIDAY)!;
		const menu = await contextMenu(m, oct9);
		expect(titles(menu)).toEqual(["Open details", "Reopen"]);
		menuItem(menu, "Reopen").run();
		await settle();
		expect(lastNotice(m)?.label).toBe(REOPEN_OCCURRENCE_LABEL);
	});

	it("a click opens the details of the series task", async () => {
		const m = await mountM7();
		const { t, section } = await twoDone(m);
		await click(rowsFor(section, "Weekly review").find((r) => r.dataset.occurrence === FRIDAY));
		expect(q(section, ".cp-details .cp-details-title")).not.toBeNull();
		expect(taskById(m, t.id).title).toBe("Weekly review");
	});

	it("a weekly series done on three weeks keeps its three done rows when its rule is edited in the details", async () => {
		const m = await mountM7();
		const t = await create(m, "Weekly review", { scheduled: { kind: "date", date: "2026-10-01" } });
		// Done on its day three weeks running: Thursday Oct 1, 8 and 15.
		await m.h.app.recurrence.complete(t.id);
		m.h.clock.set("2026-10-08T10:00:00Z");
		await m.h.app.recurrence.complete(t.id);
		m.h.clock.set("2026-10-15T10:00:00Z");
		await m.h.app.recurrence.complete(t.id);
		await m.rerender();
		const records = () =>
			[...m.h.app.store.state.occurrenceRecords.values()]
				.filter((r) => r.taskId === t.id)
				.map((r) => `${r.occurrenceDate}:${r.status}`)
				.sort();
		const done = ["2026-10-01:done", "2026-10-08:done", "2026-10-15:done"];
		expect(records()).toEqual(done);

		const pane = await openDetails(m, "Weekly review");
		await click(q(pane, ".cp-repeat-button"));
		await click(q(pane, '.cp-repeat-pop [data-preset="weekday"]'));
		expect(taskById(m, t.id).recurrence!.versions.map((v) => v.effectiveFrom)).toEqual(["2026-10-01", "2026-10-15"]);
		expect(records()).toEqual(done);
		const section = await showInbox(m);
		await click(completedToggle(section));
		const history = rowsFor(section, "Weekly review").filter((r) => r.dataset.occurrence !== undefined);
		expect(history.map((r) => r.dataset.occurrence).sort()).toEqual(["2026-10-01", "2026-10-08", "2026-10-15"]);
	});
});
