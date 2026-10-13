// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AppMount, byLabel, click, day, mountApp, q, qa, settle, tasksEl, unmountAll } from "./app-helpers";
import { cal, entries, openCalendar } from "./calendar-helpers";
import { mountHabits, openHabits, rowOf, seedMockup } from "./habits-helpers";
import { checkedOf, menuItems, menuTitles, openViewMenu, pickItem, viewButton } from "./view-menu-helpers";
import { LINGER_MS } from "../../src/ui/useLingering";
import { card, completedToggle, groupLabels, matrix, openMatrix, quadrantEl, titlesIn } from "./matrix-helpers";

describe("the view menu and the Completed group", () => {
	// The ⋯ view menu in Tasks and the Completed group. Today is 2026-10-01 (Europe/Berlin).

	// Fake timers (Date stays real: the harness has its own clock): the 450 ms hold is stepped, not slept.
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	});
	afterEach(async () => {
		unmountAll();
		// Run what the unmounts left queued (Preact's effect flush) while the fake timers still own it.
		await vi.runOnlyPendingTimersAsync();
		vi.useRealTimers();
	});

	const rowTitles = (m: AppMount) => [...tasksEl(m).querySelectorAll<HTMLElement>(".cp-task-row .cp-task-title")].map((e) => e.textContent.trim());
	const toggle = (m: AppMount) => tasksEl(m).querySelector<HTMLButtonElement>(".cp-completed-toggle");
	const waitLinger = async () => {
		await vi.advanceTimersByTimeAsync(LINGER_MS + 80);
		await settle();
	};
	async function openView(m: AppMount, name: string) {
		await click([...m.root.querySelectorAll<HTMLElement>(".cp-sidebar-item")].find((e) => e.textContent?.includes(name)));
	}
	const rowOf = (m: AppMount, title: string) => [...tasksEl(m).querySelectorAll<HTMLElement>(".cp-task-row")].find((r) => r.textContent.includes(title))!;
	const checkbox = (m: AppMount, title: string) => rowOf(m, title).querySelector<HTMLInputElement>(".cp-task-checkbox")!;

	describe("Tasks view menu", () => {
		it("replaces the filter bar with a ⋯ button that has a label, is a button and opens the menu", async () => {
			const m = await mountApp();
			expect(tasksEl(m).querySelector(".cp-filter-bar")).toBeNull();
			const btn = tasksEl(m).querySelector<HTMLButtonElement>('[aria-label="View options"]')!;
			expect(btn.tagName).toBe("BUTTON");
			expect(btn.tabIndex).toBeGreaterThanOrEqual(0);
			expect(tasksEl(m).querySelector(".cp-main-header")!.contains(btn)).toBe(true);
			expect(tasksEl(m).querySelector('input[aria-label="Search this list"]')).not.toBeNull();
			const menu = await openViewMenu(m, tasksEl(m));
			expect(menuTitles(menu)).toEqual(["Sort: default", "Sort: by date", "Sort: by priority", "Group by…", "Show completed"]);
			expect(menuItems(menu).map((i) => i.checked)).toEqual([true, false, false, undefined, true]);
		});

		it("every Tasks view has the menu, except the Trash", async () => {
			const m = await mountApp();
			for (const name of ["Upcoming", "Inbox", "Completed"]) {
				await openView(m, name);
				expect(tasksEl(m).querySelector('[aria-label="View options"]'), name).not.toBeNull();
			}
			// The Completed list is all completed tasks: nothing to show or hide.
			expect(menuTitles(await openViewMenu(m, tasksEl(m)))).not.toContain("Show completed");
			await openView(m, "Trash");
			expect(tasksEl(m).querySelector('[aria-label="View options"]')).toBeNull();
		});

		it("sorts by priority and by date from the menu, and checks the choice", async () => {
			const m = await mountApp();
			const T = m.h.app.tasks;
			await T.create({ title: "Late", priority: 0, scheduled: day("2026-10-09") });
			await T.create({ title: "Soon", priority: 3, scheduled: day("2026-10-02") });
			await T.create({ title: "Urgent", priority: 1 });
			await openView(m, "Inbox");
			expect(rowTitles(m)).toEqual(["Late", "Soon", "Urgent"]);
			let menu = await openViewMenu(m, tasksEl(m));
			await pickItem(m, menu, "Sort: by priority");
			expect(rowTitles(m)).toEqual(["Urgent", "Soon", "Late"]);
			menu = await openViewMenu(m, tasksEl(m));
			expect(menuItems(menu).map((i) => i.checked)).toEqual([false, false, true, undefined, undefined, true]); // the third sort, "Group by…", "Add section", "Show completed"
			await pickItem(m, menu, "Sort: by date");
			expect(rowTitles(m)).toEqual(["Soon", "Late", "Urgent"]);
			await pickItem(m, await openViewMenu(m, tasksEl(m)), "Sort: default");
			expect(rowTitles(m)).toEqual(["Late", "Soon", "Urgent"]);
		});

		it("the sort applies to every view", async () => {
			const m = await mountApp();
			await m.h.app.tasks.create({ title: "A", priority: 0, scheduled: day("2026-10-01") });
			await m.h.app.tasks.create({ title: "B", priority: 1, scheduled: day("2026-10-01") });
			await pickItem(m, await openViewMenu(m, tasksEl(m)), "Sort: by priority");
			expect(rowTitles(m)).toEqual(["B", "A"]);
			await openView(m, "Inbox");
			expect(rowTitles(m)).toEqual(["B", "A"]);
		});
	});

	describe("Completed group (spec §7)", () => {
		it("is last, collapsed by default and labelled with the count", async () => {
			const m = await mountApp();
			const T = m.h.app.tasks;
			await T.create({ title: "Open one" });
			const a = await T.create({ title: "Done A" });
			const b = await T.create({ title: "Done B" });
			await T.complete(a.task.id);
			m.h.clock.advance(1000);
			await T.complete(b.task.id);
			await waitLinger();
			await openView(m, "Inbox");
			expect(rowTitles(m)).toEqual(["Open one"]);
			const t = toggle(m)!;
			expect(t.textContent.trim()).toBe("Completed · 2");
			expect(t.getAttribute("aria-expanded")).toBe("false");
			const group = t.closest(".cp-task-group")!;
			expect(group.getAttribute("role")).toBe("group");
			expect(group.hasAttribute("aria-label")).toBe(false);
			expect(group.getAttribute("aria-labelledby")).toBe(t.querySelector("span[id]")!.id);
			expect(tasksEl(m).querySelector(".cp-task-list")!.lastElementChild).toBe(group);
			await click(t);
			expect(toggle(m)!.getAttribute("aria-expanded")).toBe("true");
			// Newest completedAt first.
			expect(rowTitles(m)).toEqual(["Open one", "Done B", "Done A"]);
		});

		it("each view remembers its own expanded state across section switches", async () => {
			const m = await mountApp();
			const T = m.h.app.tasks;
			const a = await T.create({ title: "Done A" });
			await T.complete(a.task.id);
			await waitLinger();
			await openView(m, "Inbox");
			await click(toggle(m));
			await click(byLabel(m.root, "Calendar"));
			await click(byLabel(m.root, "Tasks"));
			expect(toggle(m)!.getAttribute("aria-expanded")).toBe("true");
			await openView(m, "Today");
			await openView(m, "Inbox");
			expect(toggle(m)!.getAttribute("aria-expanded")).toBe("true");
			await click(toggle(m));
			expect(toggle(m)!.getAttribute("aria-expanded")).toBe("false");
		});

		it("shows 20 at a time with a Show more button", async () => {
			const m = await mountApp();
			for (let i = 0; i < 45; i++) {
				const t = await m.h.app.tasks.create({ title: `Done ${String(i).padStart(2, "0")}` });
				m.h.clock.advance(1000);
				await m.h.app.tasks.complete(t.task.id);
			}
			await waitLinger();
			await openView(m, "Inbox");
			await click(toggle(m));
			expect(rowTitles(m)).toHaveLength(20);
			expect(rowTitles(m)[0]).toBe("Done 44");
			const more = () => tasksEl(m).querySelector<HTMLButtonElement>(".cp-completed-more");
			await click(more());
			expect(rowTitles(m)).toHaveLength(40);
			await click(more());
			expect(rowTitles(m)).toHaveLength(45);
			expect(more()).toBeNull();
			expect(toggle(m)!.textContent.trim()).toBe("Completed · 45");
		});

		describe("Show more starts again at 20", () => {
			const done = async (m: AppMount, n: number, categoryId?: string) => {
				for (let i = 0; i < n; i++) {
					const t = await m.h.app.tasks.create({ title: `Done ${String(i).padStart(2, "0")}`, categoryId });
					m.h.clock.advance(1000);
					await m.h.app.tasks.complete(t.task.id);
				}
				await waitLinger();
			};
			const more = (m: AppMount) => tasksEl(m).querySelector<HTMLButtonElement>(".cp-completed-more");

			it("when the group is collapsed and opened again", async () => {
				const m = await mountApp();
				await done(m, 45);
				await openView(m, "Inbox");
				await click(toggle(m));
				await click(more(m));
				expect(rowTitles(m)).toHaveLength(40);
				await click(toggle(m));
				await click(toggle(m));
				expect(rowTitles(m)).toHaveLength(20);
			});

			it("when the filter changes", async () => {
				const m = await mountApp();
				await done(m, 45);
				await openView(m, "Inbox");
				await click(toggle(m));
				await click(more(m));
				expect(rowTitles(m)).toHaveLength(40);
				await pickItem(m, await openViewMenu(m, tasksEl(m)), "Sort: by date");
				expect(rowTitles(m)).toHaveLength(20);
			});

			it("when the view changes", async () => {
				const m = await mountApp();
				await done(m, 45);
				await openView(m, "Inbox");
				await click(toggle(m));
				await click(more(m));
				expect(rowTitles(m)).toHaveLength(40);
				await openView(m, "Today");
				await openView(m, "Inbox");
				expect(toggle(m)!.getAttribute("aria-expanded")).toBe("true");
				expect(rowTitles(m)).toHaveLength(20);
			});

			it("in the matrix: on collapse and on a filter change", async () => {
				const m = await mountApp();
				const study = await m.h.app.categories.create("Study", null);
				await done(m, 25, study.id);
				await openMatrix(m);
				const q = () => quadrantEl(m.root, "neither");
				const moreBtn = () => q().querySelector<HTMLButtonElement>(".cp-completed-more");
				await click(completedToggle(m.root, "neither"));
				expect(titlesIn(m.root, "neither")).toHaveLength(20);
				await click(moreBtn());
				expect(titlesIn(m.root, "neither")).toHaveLength(25);
				await click(completedToggle(m.root, "neither"));
				await click(completedToggle(m.root, "neither"));
				expect(titlesIn(m.root, "neither")).toHaveLength(20);
				await click(moreBtn());
				expect(titlesIn(m.root, "neither")).toHaveLength(25);
				const lists = (await pickItem(m, await openViewMenu(m, matrix(m.root)), "Lists…"))!;
				await pickItem(m, lists, "Study");
				expect(titlesIn(m.root, "neither")).toHaveLength(20);
			});
		});

		it("Show completed off hides the group, on brings it back", async () => {
			const m = await mountApp();
			const a = await m.h.app.tasks.create({ title: "Done A" });
			await m.h.app.tasks.complete(a.task.id);
			await waitLinger();
			await openView(m, "Inbox");
			expect(toggle(m)).not.toBeNull();
			await pickItem(m, await openViewMenu(m, tasksEl(m)), "Show completed");
			expect(toggle(m)).toBeNull();
			const menu = await openViewMenu(m, tasksEl(m));
			expect(checkedOf(menu, "Show completed")).toBe(false);
			await pickItem(m, menu, "Show completed");
			expect(toggle(m)).not.toBeNull();
		});

		it("a view with only completed tasks still shows its empty text above the group", async () => {
			const m = await mountApp();
			const a = await m.h.app.tasks.create({ title: "Done A" });
			await m.h.app.tasks.complete(a.task.id);
			await waitLinger();
			await openView(m, "Inbox");
			expect(tasksEl(m).querySelector(".cp-empty-text")!.textContent).toBe("Inbox is empty.");
			expect(toggle(m)!.textContent.trim()).toBe("Completed · 1");
		});

		it("follows the membership rules per view", async () => {
			const m = await mountApp();
			const T = m.h.app.tasks;
			const study = await m.h.app.categories.create("Study", null);
			await m.h.app.tags.create("mytag", "red");
			const mk = async (title: string, patch: Omit<Parameters<typeof T.create>[0], "title">) => {
				const r = await T.create({ title, ...patch });
				await T.complete(r.task.id);
			};
			await mk("Due today", { scheduled: day("2026-10-01") });
			await mk("Deadline today", { deadline: day("2026-10-01") });
			await mk("Overdue done today", { scheduled: day("2026-09-20") });
			await mk("Next week", { scheduled: day("2026-10-05") });
			await mk("No date", {});
			await mk("In Study", { categoryId: study.id });
			await mk("Tagged", { tagKeys: ["mytag"] });
			await waitLinger();
			const names = async (view: string) => {
				await openView(m, view);
				const t = toggle(m);
				if (t === null) return [];
				if (t.getAttribute("aria-expanded") === "false") await click(t);
				return rowTitles(m).sort();
			};
			expect(await names("Today")).toEqual(["Deadline today", "Due today", "Overdue done today"]);
			// Upcoming starts tomorrow, so today's tasks are not in its group.
			expect(await names("Upcoming")).toEqual(["Next week"]);
			expect(await names("Inbox")).toEqual(["Deadline today", "Due today", "Next week", "No date", "Overdue done today", "Tagged"]);
			expect(await names("Study")).toEqual(["In Study"]);
			expect(await names("mytag")).toEqual(["Tagged"]);
		});

		it("a completed subtask of an open parent stays under it; of a completed parent it goes to the group", async () => {
			const m = await mountApp();
			const T = m.h.app.tasks;
			const p = await T.create({ title: "Parent" });
			const s1 = await T.create({ title: "Sub one", parentId: p.task.id });
			await T.create({ title: "Sub two", parentId: p.task.id });
			await T.complete(s1.task.id);
			await waitLinger();
			await openView(m, "Inbox");
			expect(rowTitles(m)).toEqual(["Parent", "Sub one", "Sub two"]);
			expect(rowOf(m, "Sub one").classList.contains("is-completed")).toBe(true);
			expect(rowOf(m, "Sub one").classList.contains("is-subtask")).toBe(true);
			expect(toggle(m)).toBeNull();
			// Completing the parent (with its open subtask) moves the family into the group.
			const q = await T.create({ title: "Parent 2" });
			const s2 = await T.create({ title: "Child", parentId: q.task.id });
			await T.complete(s2.task.id);
			await T.complete(q.task.id);
			await waitLinger();
			expect(rowTitles(m)).toEqual(["Parent", "Sub one", "Sub two"]);
			expect(toggle(m)!.textContent.trim()).toBe("Completed · 2");
		});

		it("completing keeps the row in place for the check animation, then moves it; reopening moves it back (AS-10)", async () => {
			const m = await mountApp();
			await m.h.app.tasks.create({ title: "Ship it", scheduled: day("2026-10-01") });
			await m.h.app.tasks.create({ title: "Other", scheduled: day("2026-10-01") });
			await settle();
			expect(rowTitles(m)).toEqual(["Ship it", "Other"]);
			await click(checkbox(m, "Ship it"));
			// Right away: the row is still there and completed (the animation plays).
			expect(rowTitles(m)).toEqual(["Ship it", "Other"]);
			expect(rowOf(m, "Ship it").classList.contains("is-completed")).toBe(true);
			await waitLinger();
			expect(rowTitles(m)).toEqual(["Other"]);
			expect(toggle(m)!.textContent.trim()).toBe("Completed · 1");
			await click(toggle(m));
			expect(rowTitles(m)).toEqual(["Other", "Ship it"]);
			// The calendar hides it while Show completed is off; the matrix moves it to the Completed group.
			await openCalendar(m);
			expect(entries(m.root, "Ship it")).toHaveLength(0);
			await openMatrix(m);
			expect(groupLabels(m.root, "neither")).toEqual(["Today", "Completed · 1"]);
			expect(titlesIn(m.root, "neither")).toEqual(["Other"]);
			expect(completedToggle(m.root, "neither")).not.toBeNull();
			// Reopen from the Tasks group.
			await click(byLabel(m.root, "Tasks"));
			await click(checkbox(m, "Ship it"));
			await settle();
			expect(rowTitles(m)).toEqual(["Ship it", "Other"]);
			expect(toggle(m)).toBeNull();
			await openMatrix(m);
			expect(card(m.root, "Ship it").classList.contains("is-completed")).toBe(false);
			expect(completedToggle(m.root, "neither")).toBeNull();
		});

		it("a task completed before a view is shown never lingers", async () => {
			const m = await mountApp();
			const a = await m.h.app.tasks.create({ title: "A", scheduled: day("2026-10-01") });
			await m.h.app.tasks.create({ title: "B", scheduled: day("2026-10-01") });
			await openMatrix(m);
			await m.h.app.tasks.complete(a.task.id);
			await settle();
			await click(byLabel(m.root, "Tasks"));
			expect(rowTitles(m)).toEqual(["B"]);
		});

		it("arrow keys still move across the visible rows, including an expanded Completed group", async () => {
			const m = await mountApp();
			const T = m.h.app.tasks;
			await T.create({ title: "Open one" });
			const a = await T.create({ title: "Done A" });
			await T.complete(a.task.id);
			await waitLinger();
			await openView(m, "Inbox");
			await click(toggle(m));
			const rows = [...tasksEl(m).querySelectorAll<HTMLElement>(".cp-task-row")];
			rows[0]!.focus();
			rows[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
			expect(document.activeElement).toBe(rows[1]);
			expect(rows[1]!.textContent).toContain("Done A");
		});

		it("a matrix quadrant's Completed group is a named group with an aria-expanded button and no container aria-label", async () => {
			const m = await mountApp();
			const a = await m.h.app.tasks.create({ title: "Done A", urgent: true });
			await m.h.app.tasks.complete(a.task.id);
			await openMatrix(m);
			const t = completedToggle(m.root, "urgent")!;
			expect(t.getAttribute("aria-expanded")).toBe("false");
			const group = t.closest(".cp-task-group")!;
			expect(group.hasAttribute("aria-label")).toBe(false);
			expect(document.getElementById(group.getAttribute("aria-labelledby")!)!.textContent).toBe("Completed · 1");
		});

		it("Search keeps the full filter bar", async () => {
			const m = await mountApp();
			await click(byLabel(m.root, "Search"));
			const search = m.root.querySelector<HTMLElement>(".cp-search")!;
			expect(search.querySelector(".cp-filter-bar")).not.toBeNull();
			await click(search.querySelector('[aria-label="Show filters"]'));
			const labels = [...search.querySelectorAll(".cp-filter-panel label > span")].map((s) => s.textContent);
			expect(labels).toEqual(expect.arrayContaining(["Date", "Status", "Description note", "Sort by"]));
			expect(search.textContent).toContain("Matrix");
		});
	});
});

describe("section state written with an updater", () => {
	// Section state is written with an updater, never by spreading the `ui` object a render captured: a
	// menu that stays open past a later change must not bring back what that change replaced.

	const selected = (m: AppMount) =>
		[...tasksEl(m).querySelectorAll<HTMLElement>(".cp-task-row.is-selected")].map((r) => r.querySelector(".cp-task-title")!.textContent.trim());

	async function twoTasks() {
		const m = await mountApp();
		const work = await m.h.app.categories.create("Work");
		const a = (await m.h.app.tasks.create({ title: "Alpha", categoryId: work.id })).task;
		const b = (await m.h.app.tasks.create({ title: "Beta", categoryId: work.id })).task;
		const view = { kind: "category" as const, id: work.id };
		m.handle.current!.showTasks(view, a.id);
		await settle();
		expect(selected(m)).toEqual(["Alpha"]);
		return { m, view, b };
	}

	describe("Tasks view menu after the selection changed", () => {
		for (const pick of ["Sort: by priority", "Add section", "Show completed"]) {
			it(`"${pick}" keeps the task selected in the meantime`, async () => {
				const { m, view, b } = await twoTasks();
				const menu = await openViewMenu(m, tasksEl(m));
				m.handle.current!.showTasks(view, b.id);
				await settle();
				expect(selected(m)).toEqual(["Beta"]);
				await pickItem(m, menu, pick);
				expect(selected(m)).toEqual(["Beta"]);
			});
		}
	});

	describe("Search results opening a list", () => {
		it("keeps what another change wrote to the Tasks state in the same turn", async () => {
			const m = await mountApp();
			const work = await m.h.app.categories.create("Work");
			const x = (await m.h.app.tasks.create({ title: "Target", categoryId: work.id })).task;
			const typeIn = async (selector: string, text: string) => {
				const input = m.root.querySelector<HTMLInputElement>(selector)!;
				input.value = text;
				input.dispatchEvent(new Event("input", { bubbles: true }));
				await settle();
			};
			await typeIn('.cp-tasks input[aria-label="Search this list"]', "zzz");
			await click(byLabel(m.root, "Search"));
			await typeIn(".cp-search input[type=search]", "Work");
			const link = [...m.root.querySelectorAll<HTMLButtonElement>(".cp-search-categories .cp-link-button")].find((b) => b.textContent.includes("Work"))!;
			// One synchronous turn: another change clears the list's search text, then the result is clicked.
			m.handle.current!.showTasks({ kind: "inbox" }, x.id);
			link.click();
			await settle();
			expect(m.root.querySelector<HTMLInputElement>('.cp-tasks input[aria-label="Search this list"]')!.value).toBe("");
			expect(tasksEl(m).querySelector(".cp-main-title")!.textContent).toContain("Work");
		});
	});

	describe("Habits page after the selection changed", () => {
		it("a week strip pick in the same turn keeps the habit that was selected meanwhile", async () => {
			const m = await mountHabits();
			const habits = await seedMockup(m.h);
			await m.rerender();
			const el = await openHabits(m);
			expect(rowOf(el, "Meditate").classList.contains("is-selected")).toBe(true);
			const monday = qa<HTMLButtonElement>(el, ".cp-habit-day")[0]!;
			// One synchronous turn: the selection moves to Read, then the older strip button is pressed.
			m.handle.current!.showHabit(habits.read.id);
			monday.click();
			await settle();
			expect(rowOf(el, "Read").classList.contains("is-selected")).toBe(true);
			expect(q(el, ".cp-habit-day.is-selected").getAttribute("aria-label")).toContain("Mon 28");
		});
	});
});

describe("the Lists… loop", () => {
	// "Lists…" and "Tags…" show their menu again after a pick. The loop must end when the
	// menu is dismissed, when the section is hidden and when it unmounts.

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	});
	afterEach(async () => {
		unmountAll();
		// Run what the unmounts left queued (Preact's effect flush) while the fake timers still own it.
		await vi.runOnlyPendingTimersAsync();
		vi.useRealTimers();
	});
	async function mountWithCategory() {
		const m = await mountApp();
		await m.h.app.categories.create("Study", null);
		await openCalendar(m);
		return m;
	}
	const run = (menu: ReturnType<typeof menuItems>, title: string) => menu.find((i) => i.title === title)!.run();
	const elapse = async () => {
		await vi.advanceTimersByTimeAsync(10);
		await settle();
	};

	describe("Lists… loop", () => {
		it("shows the menu again after a pick", async () => {
			const m = await mountWithCategory();
			const root = await openViewMenu(m, cal(m.root));
			run(menuItems(root), "Lists…");
			await elapse();
			const lists = m.host.menus.at(-1)!;
			const before = m.host.menus.length;
			run(menuItems(lists), "Study");
			await elapse();
			expect(m.host.menus.length).toBe(before + 1);
		});

		it("a dismissed menu does not reopen, and focus returns to the ⋯ button", async () => {
			const m = await mountWithCategory();
			const root = await openViewMenu(m, cal(m.root));
			run(menuItems(root), "Lists…");
			await elapse();
			const before = m.host.menus.length;
			m.host.dismissMenu();
			await elapse();
			await vi.advanceTimersByTimeAsync(1000);
			expect(m.host.menus.length).toBe(before);
			expect(document.activeElement).toBe(viewButton(cal(m.root)));
		});

		it("a pick followed by a dismissal of the reopened menu ends the loop", async () => {
			const m = await mountWithCategory();
			run(menuItems(await openViewMenu(m, cal(m.root))), "Lists…");
			await elapse();
			run(menuItems(m.host.menus.at(-1)!), "Study");
			await elapse();
			const before = m.host.menus.length;
			m.host.dismissMenu();
			await elapse();
			expect(m.host.menus.length).toBe(before);
		});

		it("a menu closed by its own pick is not taken for a dismissal", async () => {
			const m = await mountWithCategory();
			run(menuItems(await openViewMenu(m, cal(m.root))), "Lists…");
			await elapse();
			const before = m.host.menus.length;
			// The host closes the menu on a pick: the pick and the close signal both arrive.
			run(menuItems(m.host.menus.at(-1)!), "Study");
			m.host.dismissMenu();
			await elapse();
			expect(m.host.menus.length).toBe(before + 1);
		});

		it("does not reopen after the section unmounts", async () => {
			const m = await mountWithCategory();
			run(menuItems(await openViewMenu(m, cal(m.root))), "Lists…");
			await elapse();
			const before = m.host.menus.length;
			run(menuItems(m.host.menus.at(-1)!), "Study");
			m.unmount();
			await elapse();
			expect(m.host.menus.length).toBe(before);
			expect(vi.getTimerCount()).toBe(0);
		});

		it("does not reopen once the section is hidden", async () => {
			const m = await mountWithCategory();
			run(menuItems(await openViewMenu(m, cal(m.root))), "Lists…");
			await elapse();
			const before = m.host.menus.length;
			run(menuItems(m.host.menus.at(-1)!), "Study");
			(byLabel(m.root, "Tasks") as HTMLElement).click(); // hides the calendar in the same tick as the pick
			await elapse();
			expect(m.host.menus.length).toBe(before);
		});
	});
});
