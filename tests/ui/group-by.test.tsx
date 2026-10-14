// @vitest-environment happy-dom
import { render } from "preact";
import { describe, expect, it, vi } from "vitest";
import { type TaskView, buildList } from "../../src/app/views";
import type { GroupBy } from "../../src/domain/groupBy";
import { type TaskSort, emptyFilter } from "../../src/domain/queries";
import { INBOX_ID } from "../../src/domain/types";
import { TaskList } from "../../src/ui/TaskList";
import { makeReadOnly } from "../app/harness";
import { type AppMount, click, day, dragTo, mountApp, mountNode, rect, rowTitles, settle, sidebarItem, taskOf, tasksEl, U1Host } from "./app-helpers";
import { modeButton } from "./board-helpers";
import { checkedOf, menuItems, menuTitles, openViewMenu, pickItem } from "./view-menu-helpers";

// The "Group by…" menu, the grouped list, and dragging a row to another group.
// Today is 2026-10-01 (Europe/Berlin).


const headingTexts = (m: AppMount) =>
	[...m.root.querySelectorAll(".cp-tasks .cp-task-group > .cp-group-heading")].map((h) => h.textContent.replace(/\s+/g, " ").trim());


/** Opens the view menu, then "Group by…", and returns the options menu. */
async function groupMenu(m: AppMount) {
	const menu = await openViewMenu(m, tasksEl(m));
	const second = await pickItem(m, menu, "Group by…");
	expect(second).not.toBeNull();
	return second!;
}
async function groupBy(m: AppMount, title: string) {
	await pickItem(m, await groupMenu(m), title);
}

describe("the Group by menu", () => {
	it("offers each view its own options with the default checked", async () => {
		const m = await mountApp();
		await click(sidebarItem(m.root, "Today"));
		let menu = await groupMenu(m);
		expect(menuTitles(menu)).toEqual(["Date", "List", "Priority", "Tag", "None"]);
		expect(checkedOf(menu, "Date")).toBe(true);
		await click(sidebarItem(m.root, "Inbox"));
		menu = await groupMenu(m);
		expect(menuTitles(menu)).toEqual(["None", "Section", "Date", "Priority", "Tag"]);
		expect(checkedOf(menu, "None")).toBe(true);
		expect(checkedOf(menu, "Section")).toBe(false);
		await m.h.app.tags.create("Work");
		await click(sidebarItem(m.root, "Work"));
		menu = await groupMenu(m);
		expect(menuTitles(menu)).toEqual(["None", "Date", "List", "Priority"]);
	});

	it("is not in Completed or Trash, and not in Board mode", async () => {
		const m = await mountApp();
		await click(sidebarItem(m.root, "Completed"));
		expect(menuTitles(await openViewMenu(m, tasksEl(m)))).not.toContain("Group by…");
		await click(sidebarItem(m.root, "Today"));
		expect(menuTitles(await openViewMenu(m, tasksEl(m)))).toContain("Group by…");
		await click(modeButton(m.root, "Board"));
		expect(menuTitles(await openViewMenu(m, tasksEl(m)))).toEqual(["Sort: default", "Sort: by date", "Sort: by priority", "Show completed"]);
		await click(modeButton(m.root, "List"));
		expect(menuTitles(await openViewMenu(m, tasksEl(m)))).toContain("Group by…");
	});

	it("remembers the choice per view and checks it", async () => {
		const m = await mountApp();
		await click(sidebarItem(m.root, "Inbox"));
		await groupBy(m, "Priority");
		expect(checkedOf(await groupMenu(m), "Priority")).toBe(true);
		await click(sidebarItem(m.root, "Today"));
		expect(checkedOf(await groupMenu(m), "Date")).toBe(true);
		await click(sidebarItem(m.root, "Inbox"));
		expect(checkedOf(await groupMenu(m), "Priority")).toBe(true);
		// The board and back: the list keeps its grouping.
		await click(modeButton(m.root, "Board"));
		await click(modeButton(m.root, "List"));
		expect(checkedOf(await groupMenu(m), "Priority")).toBe(true);
	});
});

describe("the Group by second menu timer", () => {
	it("unmounting before the tick shows no menu", async () => {
		const m = await mountApp();
		await click(sidebarItem(m.root, "Inbox"));
		const menu = await openViewMenu(m, tasksEl(m));
		const show = vi.spyOn(m.host, "showMenu");
		menuItems(menu).find((i) => i.title === "Group by…")!.run();
		m.unmount();
		await new Promise((r) => setTimeout(r, 5));
		expect(show).not.toHaveBeenCalled();
	});
});

describe("the grouped list", () => {
	it("Inbox is a plain list by default, even with sections; Group by Section shows them", async () => {
		const m = await mountApp();
		const alpha = await m.h.app.sections.create(INBOX_ID, "Alpha");
		await m.h.app.tasks.create({ title: "N1" });
		await m.h.app.tasks.create({ title: "A1", sectionId: alpha.id });
		await click(sidebarItem(m.root, "Inbox"));
		expect(m.root.querySelector(".cp-tasks .cp-section-heading")).toBeNull();
		expect(headingTexts(m)).toEqual([]);
		expect(rowTitles(m)).toEqual(["N1", "A1"]);
		await groupBy(m, "Section");
		expect(headingTexts(m)).toEqual(["No section1", "Alpha1"]);
	});

	it("Today and Upcoming look as before: Overdue and Today, and the days", async () => {
		const m = await mountApp();
		await m.h.app.tasks.create({ title: "Late", scheduled: day("2026-09-29") });
		await m.h.app.tasks.create({ title: "Now", scheduled: day("2026-10-01") });
		await m.h.app.tasks.create({ title: "Next", scheduled: day("2026-10-05") });
		await click(sidebarItem(m.root, "Today"));
		expect(headingTexts(m)).toEqual(["Overdue1", "Today1"]);
		expect(m.root.querySelector(".cp-tasks .cp-group-overdue")).toBeNull();
		await click(sidebarItem(m.root, "Upcoming"));
		expect(headingTexts(m)).toEqual(["Mon, Oct 51"]);
	});

	it("groups a list by date: a red past-date heading with an overdue label, then No date", async () => {
		const m = await mountApp();
		await m.h.app.tasks.create({ title: "Late", scheduled: day("2026-09-29") });
		await m.h.app.tasks.create({ title: "Now", scheduled: day("2026-10-01") });
		await m.h.app.tasks.create({ title: "Whenever" });
		await click(sidebarItem(m.root, "Inbox"));
		await groupBy(m, "Date");
		expect(headingTexts(m)).toEqual(["Tue, Sep 29overdue1", "Today1", "No date1"]);
		const past = m.root.querySelector<HTMLElement>('.cp-tasks [data-group-key="2026-09-29"]')!;
		expect(past.querySelector(".cp-group-heading")!.classList.contains("is-overdue")).toBe(true);
		const label = past.querySelector<HTMLElement>(".cp-group-overdue")!;
		expect(label.textContent).toBe("overdue");
		// The group is named by the date and the label, never by an aria-label.
		expect(past.hasAttribute("aria-label")).toBe(false);
		expect(past.getAttribute("aria-labelledby")!.split(" ")).toHaveLength(2);
		expect(m.root.querySelector(".cp-tasks .cp-group-heading.is-today")).not.toBeNull();
	});

	it("groups by priority, tag and list", async () => {
		const m = await mountApp();
		await m.h.app.tags.create("Work");
		const work = await m.h.app.categories.create("Work list");
		await m.h.app.tasks.create({ title: "Hi", priority: 1, tagKeys: ["work"], scheduled: day("2026-10-01") });
		await m.h.app.tasks.create({ title: "Plain", categoryId: work.id, scheduled: day("2026-10-01") });
		await click(sidebarItem(m.root, "Today"));
		await groupBy(m, "Priority");
		expect(headingTexts(m)).toEqual(["High1", "None1"]);
		await groupBy(m, "Tag");
		expect(headingTexts(m)).toEqual(["@Work1", "No tag1"]);
		await groupBy(m, "List");
		expect(headingTexts(m)).toEqual(["Inbox1", "Work list1"]);
		await groupBy(m, "None");
		expect(headingTexts(m)).toEqual([]);
		expect(rowTitles(m)).toEqual(["Hi", "Plain"]);
	});
});

describe('"Add section" in the list view menu', () => {
	it("switches the view to Group by Section and opens the name field with the focus in it", async () => {
		const m = await mountApp();
		await m.h.app.tasks.create({ title: "N1" });
		await click(sidebarItem(m.root, "Inbox"));
		await pickItem(m, await openViewMenu(m, tasksEl(m)), "Add section");
		expect(checkedOf(await groupMenu(m), "Section")).toBe(true);
		const input = m.root.querySelector<HTMLInputElement>(".cp-tasks .cp-section-name-input");
		expect(input).not.toBeNull();
		await settle();
		expect(document.activeElement).toBe(input);
	});

	it("keeps another grouping's choice when a section is added on the board", async () => {
		const m = await mountApp();
		await click(sidebarItem(m.root, "Inbox"));
		await groupBy(m, "Priority");
		await click(modeButton(m.root, "Board"));
		await pickItem(m, await openViewMenu(m, tasksEl(m)), "Add section");
		await click(modeButton(m.root, "List"));
		expect(checkedOf(await groupMenu(m), "Priority")).toBe(true);
	});

	it("does not open the field by itself when the grouping is switched to Section later", async () => {
		const m = await mountApp();
		await m.h.app.sections.create(INBOX_ID, "Alpha");
		await click(sidebarItem(m.root, "Inbox"));
		await pickItem(m, await openViewMenu(m, tasksEl(m)), "Add section");
		m.root.querySelector<HTMLInputElement>(".cp-tasks .cp-section-name-input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		await settle();
		await groupBy(m, "Priority");
		await groupBy(m, "Section");
		expect(m.root.querySelector(".cp-tasks .cp-section-name-input")).toBeNull();
	});
});

describe("dragging a row to another group", () => {
	// happy-dom has no layout: each group is a 30 px heading plus 40 px rows, one under the other.

	async function mountList(view: TaskView, by: GroupBy, seed: (m: AppMount) => Promise<void>, readOnly = false, sort: TaskSort = "manual") {
		const m = await mountApp();
		await seed(m);
		const host = new U1Host(m.h);
		const undo = vi.spyOn(host, "notifyUndo");
		const root = mountNode(null);
		const redraw = async () => {
			const state = m.h.app.store.state;
			const ctx = m.h.app.queryContext();
			const groups = buildList(state, view, ctx, { ...emptyFilter("all"), sort }, "", undefined, { groupBy: by }).groups;
			render(
				<TaskList
					host={host}
					state={state}
					groups={groups}
					ctx={ctx}
					selectedId={null}
					showCategory={false}
					emptyText=""
					label="List"
					sort={sort}
					readOnly={readOnly}
					onSelect={() => undefined}
				/>,
				root,
			);
			await settle();
			let y = 0;
			const tops = new Map<string, number>();
			root.querySelectorAll<HTMLElement>("[data-group-key]").forEach((g) => {
				const start = y;
				y += 30;
				const head = g.querySelector<HTMLElement>(".cp-group-heading");
				if (head !== null) head.getBoundingClientRect = () => rect(0, start, 500, start + 30);
				g.querySelectorAll<HTMLElement>(".cp-task-row").forEach((r) => {
					const top = y;
					r.getBoundingClientRect = () => rect(0, top, 500, top + 40);
					tops.set(r.querySelector(".cp-task-title")!.textContent.trim(), top + 20);
					y += 40;
				});
				const end = y;
				g.getBoundingClientRect = () => rect(0, start, 500, end);
			});
			root.querySelector<HTMLElement>(".cp-task-list")!.getBoundingClientRect = () => rect(0, 0, 500, 1000);
			return tops;
		};
		return { m, root, undo, redraw, host, tops: await redraw() };
	}
	const rowEl = (root: HTMLElement, text: string) => [...root.querySelectorAll<HTMLElement>(".cp-task-row")].find((r) => r.querySelector(".cp-task-title")!.textContent.trim() === text)!;
	const seedPriority = async (m: AppMount) => {
		await m.h.app.tasks.create({ title: "H1", priority: 1 });
		await m.h.app.tasks.create({ title: "H2", priority: 1 });
		await m.h.app.tasks.create({ title: "L1", priority: 3 });
	};

	it("priority: the drop sets the priority and the place in one write, one undo step and one notice", async () => {
		const { m, root, undo, tops } = await mountList({ kind: "inbox" }, "priority", seedPriority);
		const place = vi.spyOn(m.h.app.tasks, "place");
		await dragTo(rowEl(root, "L1"), { x: 100, y: tops.get("L1")! }, { x: 100, y: tops.get("H2")! + 15 });
		expect(place).toHaveBeenCalledTimes(1);
		const [id, order, patch] = place.mock.calls[0]!;
		expect(id).toBe(taskOf(m, "L1").id);
		expect(order).toEqual([taskOf(m, "H1").id, taskOf(m, "H2").id, taskOf(m, "L1").id]);
		expect(patch).toEqual({ priority: 1 });
		expect(taskOf(m, "L1").priority).toBe(1);
		expect(undo).toHaveBeenCalledTimes(1);
		expect(undo).toHaveBeenCalledWith('Moved "L1" to High.', "Move task", expect.any(Number));
		expect(await m.h.app.store.undo()).toBe("Move task");
		expect(taskOf(m, "L1").priority).toBe(3);
	});

	it("date: the drop moves the task to that day and keeps its time", async () => {
		const { m, root, undo, tops } = await mountList({ kind: "inbox" }, "date", async (m) => {
			await m.h.app.tasks.create({ title: "Mon", scheduled: day("2026-10-05") });
			await m.h.app.tasks.create({ title: "Timed", scheduled: { kind: "datetime", local: "2026-10-07T09:30", tz: "Europe/Berlin" } });
		});
		await dragTo(rowEl(root, "Timed"), { x: 100, y: tops.get("Timed")! }, { x: 100, y: tops.get("Mon")! + 15 });
		expect(taskOf(m, "Timed").scheduled).toEqual({ kind: "datetime", local: "2026-10-05T09:30", tz: "Europe/Berlin" });
		expect(undo).toHaveBeenCalledWith('Moved "Timed" to Mon, Oct 5.', "Move task", expect.any(Number));
	});

	it("date: a timed series dropped on another day keeps its time and the notice says it re-anchored", async () => {
		const weekly = { freq: "weekly", interval: 1, weekdays: null, monthly: null, afterCompletion: false, time: null, tz: null } as const;
		const { m, root, undo, tops } = await mountList({ kind: "inbox" }, "date", async (m) => {
			await m.h.app.tasks.create({ title: "Mon", scheduled: day("2026-10-05") });
			await m.h.app.tasks.create({ title: "Gym", scheduled: { kind: "datetime", local: "2026-10-07T07:00", tz: "Europe/Berlin" }, repeat: { rule: weekly } });
		});
		const place = vi.spyOn(m.h.app.tasks, "place");
		await dragTo(rowEl(root, "Gym"), { x: 100, y: tops.get("Gym")! }, { x: 100, y: tops.get("Mon")! + 15 });
		expect(place.mock.calls[0]![2]).toEqual({ scheduled: { kind: "datetime", local: "2026-10-05T07:00", tz: "Europe/Berlin" } });
		const gym = taskOf(m, "Gym");
		expect(gym.scheduled).toBeNull();
		expect(m.h.app.effectiveSchedule(gym)).toEqual({ kind: "datetime", local: "2026-10-05T07:00", tz: "Europe/Berlin" });
		expect(undo).toHaveBeenCalledTimes(1);
		expect(undo).toHaveBeenCalledWith('"Gym" now repeats from Mon, Oct 5.', "Move task", expect.any(Number));
		expect(m.h.app.store.undoLabel).toBe("Move task");
	});

	it("date: a deadline-only task moves its deadline, as on the board", async () => {
		const { m, root, tops } = await mountList({ kind: "inbox" }, "date", async (m) => {
			await m.h.app.tasks.create({ title: "Mon", scheduled: day("2026-10-05") });
			await m.h.app.tasks.create({ title: "Due", deadline: day("2026-10-08") });
		});
		await dragTo(rowEl(root, "Due"), { x: 100, y: tops.get("Due")! }, { x: 100, y: tops.get("Mon")! + 15 });
		expect(taskOf(m, "Due").deadline).toEqual(day("2026-10-05"));
		expect(taskOf(m, "Due").scheduled).toBeNull();
	});

	it("date: No date and the Overdue group of Today refuse a row from another group", async () => {
		const { m, root, tops } = await mountList({ kind: "inbox" }, "date", async (m) => {
			await m.h.app.tasks.create({ title: "Mon", scheduled: day("2026-10-05") });
			await m.h.app.tasks.create({ title: "Free" });
		});
		const place = vi.spyOn(m.h.app.tasks, "place");
		await dragTo(rowEl(root, "Mon"), { x: 100, y: tops.get("Mon")! }, { x: 100, y: tops.get("Free")! + 15 });
		expect(place).not.toHaveBeenCalled();
		expect(taskOf(m, "Mon").scheduled).toEqual(day("2026-10-05"));
	});

	it("Today: a row from Overdue dropped on Today is rescheduled to today; the other way is refused", async () => {
		const { m, root, tops } = await mountList({ kind: "today" }, "date", async (m) => {
			await m.h.app.tasks.create({ title: "Late", scheduled: { kind: "datetime", local: "2026-09-29T08:15", tz: "Europe/Berlin" } });
			await m.h.app.tasks.create({ title: "Now", scheduled: day("2026-10-01") });
		});
		const place = vi.spyOn(m.h.app.tasks, "place");
		await dragTo(rowEl(root, "Now"), { x: 100, y: tops.get("Now")! }, { x: 100, y: tops.get("Late")! });
		expect(place).not.toHaveBeenCalled();
		await dragTo(rowEl(root, "Late"), { x: 100, y: tops.get("Late")! }, { x: 100, y: tops.get("Now")! + 15 });
		expect(taskOf(m, "Late").scheduled).toEqual({ kind: "datetime", local: "2026-10-01T08:15", tz: "Europe/Berlin" });
	});

	it("list: the drop moves the task and its subtasks to that list", async () => {
		const { m, root, undo, tops } = await mountList({ kind: "today" }, "list", async (m) => {
			const work = await m.h.app.categories.create("Work");
			await m.h.app.tasks.create({ title: "W", categoryId: work.id, scheduled: day("2026-10-01") });
			const i = (await m.h.app.tasks.create({ title: "I", scheduled: day("2026-10-01") })).task;
			await m.h.app.tasks.create({ title: "I sub", parentId: i.id });
		});
		await dragTo(rowEl(root, "I"), { x: 100, y: tops.get("I")! }, { x: 100, y: tops.get("W")! + 15 });
		const work = taskOf(m, "W").categoryId;
		expect(taskOf(m, "I").categoryId).toBe(work);
		expect(taskOf(m, "I sub").categoryId).toBe(work);
		expect(undo).toHaveBeenCalledWith('Moved "I" to Work.', "Move task", expect.any(Number));
	});

	it("tag: a drop on another tag group is refused, and a row still reorders inside its group", async () => {
		const { m, root, undo, tops } = await mountList({ kind: "inbox" }, "tag", async (m) => {
			await m.h.app.tags.create("Home");
			await m.h.app.tags.create("Work");
			await m.h.app.tasks.create({ title: "H1", tagKeys: ["home"] });
			await m.h.app.tasks.create({ title: "H2", tagKeys: ["home"] });
			await m.h.app.tasks.create({ title: "W1", tagKeys: ["work"] });
		});
		const place = vi.spyOn(m.h.app.tasks, "place");
		await dragTo(rowEl(root, "H1"), { x: 100, y: tops.get("H1")! }, { x: 100, y: tops.get("W1")! + 15 });
		expect(place).not.toHaveBeenCalled();
		expect(taskOf(m, "H1").tagKeys).toEqual(["home"]);
		await dragTo(rowEl(root, "H2"), { x: 100, y: tops.get("H2")! }, { x: 100, y: tops.get("H1")! - 15 });
		expect(place).toHaveBeenCalledTimes(1);
		expect(place.mock.calls[0]![1]).toEqual([taskOf(m, "H2").id, taskOf(m, "H1").id]);
		expect(place.mock.calls[0]![2]).toEqual({});
		expect(undo).toHaveBeenCalledWith('Moved "H2".', "Move task", expect.any(Number));
	});

	it("a subtask cannot change group alone, and its parent takes it along", async () => {
		const { m, root, undo, redraw } = await mountList({ kind: "inbox" }, "priority", async (m) => {
			const a = (await m.h.app.tasks.create({ title: "A", priority: 1 })).task;
			await m.h.app.tasks.create({ title: "A sub", parentId: a.id, priority: 3 });
			await m.h.app.tasks.create({ title: "A sub2", parentId: a.id, priority: 3 });
			await m.h.app.tasks.create({ title: "B", priority: 2 });
		});
		const tops = await redraw();
		// The subtasks sit under A in High, whatever their own priority.
		expect([...root.querySelectorAll('[data-group-key="priority:1"] .cp-task-title')].map((t) => t.textContent.trim())).toEqual(["A", "A sub", "A sub2"]);
		const place = vi.spyOn(m.h.app.tasks, "place");
		await dragTo(rowEl(root, "A sub"), { x: 100, y: tops.get("A sub")! }, { x: 100, y: tops.get("B")! });
		for (const call of place.mock.calls) expect(call[2]).toEqual({});
		expect(taskOf(m, "A sub").priority).toBe(3);
		expect(undo).not.toHaveBeenCalledWith(expect.stringContaining("to Medium"), "Move task", expect.any(Number));
	});

	it("under another sort a row still crosses groups: one update, the sort key untouched, no place", async () => {
		const { m, root, undo, host, tops } = await mountList({ kind: "inbox" }, "priority", seedPriority, false, "priority");
		const before = taskOf(m, "L1").sortKey;
		const place = vi.spyOn(m.h.app.tasks, "place");
		const update = vi.spyOn(m.h.app.tasks, "update");
		await dragTo(rowEl(root, "L1"), { x: 100, y: tops.get("L1")! }, { x: 100, y: tops.get("H2")! + 15 });
		expect(place).not.toHaveBeenCalled();
		expect(update).toHaveBeenCalledTimes(1);
		expect(update.mock.calls[0]![1]).toEqual({ priority: 1 });
		expect(taskOf(m, "L1").priority).toBe(1);
		expect(taskOf(m, "L1").sortKey).toBe(before);
		// The notice must carry the label the store recorded (`update` runs as "Edit task"), or its Undo throws.
		expect(undo).toHaveBeenCalledWith('Moved "L1" to High.', "Edit task", expect.any(Number));
		await expect(host.undoButtons.at(-1)!()).resolves.toBe(true);
		expect(taskOf(m, "L1").priority).toBe(3);
	});

	it("under another sort a same-group drop writes nothing and draws no line", async () => {
		const { m, root, tops } = await mountList({ kind: "inbox" }, "date", async (m) => {
			await m.h.app.tasks.create({ title: "A", scheduled: day("2026-10-05") });
			await m.h.app.tasks.create({ title: "B", scheduled: day("2026-10-05") });
			await m.h.app.tasks.create({ title: "C", scheduled: day("2026-10-06") });
		}, false, "date");
		const place = vi.spyOn(m.h.app.tasks, "place");
		const update = vi.spyOn(m.h.app.tasks, "update");
		await dragTo(rowEl(root, "A"), { x: 100, y: tops.get("A")! }, { x: 100, y: tops.get("B")! + 15 }, false);
		expect(root.querySelector(".cp-reorder-line:not([hidden])")).toBeNull();
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		await dragTo(rowEl(root, "A"), { x: 100, y: tops.get("A")! }, { x: 100, y: tops.get("B")! + 15 });
		expect(place).not.toHaveBeenCalled();
		expect(update).not.toHaveBeenCalled();
	});

	it("date: a timed task dropped on a day with no such time shows the daylight saving warning", async () => {
		const { m, root, host, tops } = await mountList({ kind: "inbox" }, "date", async (m) => {
			m.h.clock.set("2026-03-27T08:00:00Z");
			await m.h.app.tasks.create({ title: "Gap", scheduled: day("2026-03-29") });
			await m.h.app.tasks.create({ title: "Spring", scheduled: { kind: "datetime", local: "2026-03-30T02:30", tz: "Europe/Berlin" } });
		});
		await dragTo(rowEl(root, "Spring"), { x: 100, y: tops.get("Spring")! }, { x: 100, y: tops.get("Gap")! + 15 });
		expect(taskOf(m, "Spring").scheduled).toEqual({ kind: "datetime", local: "2026-03-29T03:30", tz: "Europe/Berlin" });
		expect(host.messages).toContain("Adjusted for daylight saving");
	});

	it("shows an Undo notice only when something changed", async () => {
		const { m, root, undo, tops } = await mountList({ kind: "inbox" }, "priority", seedPriority);
		const spy = vi.spyOn(m.h.app.tasks, "place").mockResolvedValue({ task: taskOf(m, "L1"), warnings: [], changed: false });
		await dragTo(rowEl(root, "L1"), { x: 100, y: tops.get("L1")! }, { x: 100, y: tops.get("H2")! + 15 });
		expect(spy).toHaveBeenCalledTimes(1);
		expect(undo).not.toHaveBeenCalled();
	});

	it("a read-only database drags nothing", async () => {
		const { m, root, tops } = await mountList({ kind: "inbox" }, "priority", seedPriority, true);
		await makeReadOnly(m.h);
		const place = vi.spyOn(m.h.app.tasks, "place");
		await dragTo(rowEl(root, "L1"), { x: 100, y: tops.get("L1")! }, { x: 100, y: tops.get("H2")! + 15 });
		expect(place).not.toHaveBeenCalled();
		expect(taskOf(m, "L1").priority).toBe(3);
	});
});

// menuItems is used by the helpers above through the shared module.
void menuItems;
