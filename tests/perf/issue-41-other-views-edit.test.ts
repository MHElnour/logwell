// @vitest-environment happy-dom
import { createElement, render } from "preact";
import { describe, expect, it } from "vitest";
import { calendarTasks, menuTasks, unscheduledTasks } from "../../src/app/views";
import { type CalendarContext, layoutMonth, layoutWeek, monthGrid, weekDays } from "../../src/domain/calendar";
import { matrixQuadrants } from "../../src/domain/matrix";
import { type TaskFilter, emptyFilter, entryOf, filterTasks } from "../../src/domain/queries";
import { indexOccurrenceRecords } from "../../src/domain/recurrence";
import { compareTasksBySortKey } from "../../src/domain/tasks";
import type { ID } from "../../src/domain/types";
import type { DbData } from "../../src/persistence/schema";
import { CalendarSection, initialCalendarState } from "../../src/ui/CalendarSection";
import { SearchSection, initialSearchState } from "../../src/ui/SearchSection";
import { U1Host } from "../ui/u1-helpers";
import { fakeLayout } from "../ui/virtual-layout";
import { LISTS, LOG, ROW, RUNS, SAFETY_NET_MS, TASKS, VIEWPORT, bigHarness, countBigPasses, domCleanup, fastest, median, taskId } from "./issue-41-fixture";

// The calendar, the Eisenhower matrix and Search (issue 41). On every change the calendar places its dated tasks
// (the index's 2,500) and shows the Unscheduled count (from the index's open tasks, with the default menu); the
// drawer's rows are read and made only while it is open, and then every open task is read. The matrix reads the
// index's set for its menu when one holds at most half the tasks (a list, a tag, or the open tasks in a vault of
// mostly completed ones); it shows every task by default, so then it reads every task, as before. Search checks every
// title (a text search has no candidates), once per change and only while shown.
const CALENDAR_RATIO = 0.6;
const CALENDAR_BEFORE_RATIO = 0.5;
const MATRIX_LIST_RATIO = 0.75;

const dom = domCleanup();

describe(`one edit with the calendar, the matrix or Search at ${TASKS} tasks (issue 41)`, () => {
	it("builds the calendar and the matrix after an edit from the index's candidates, with the same result", async () => {
		const { h, lists } = await bigHarness();
		const index = h.app.tasks.lists;
		const ctx = h.app.queryContext();
		const open = emptyFilter("open");
		const all = emptyFilter("all");
		const oneList = { ...emptyFilter("all"), categoryIds: [lists[1] as ID] };
		const calCtx = (state: DbData): CalendarContext => ({ zone: ctx.zone, today: ctx.today, now: h.app.clock.now().toISOString(), weekStart: ctx.weekStart, records: indexOccurrenceRecords(state.occurrenceRecords) });
		const week = weekDays(ctx.today, ctx.weekStart);
		const grid = monthGrid(ctx.today, ctx.weekStart);
		const month = ctx.today.slice(0, 7);
		// What the calendar builds per change with the drawer closed (the default): its tasks, then the week or the month.
		const calendar = (state: DbData, withIndex: boolean, mode: "week" | "month") => {
			const cal = calendarTasks(state, ctx, open, withIndex ? index : undefined);
			const placed = mode === "week" ? layoutWeek(cal.dated, week, calCtx(state)) : layoutMonth(cal.dated, grid, month, calCtx(state));
			return { placed, unscheduled: cal.unscheduledCount };
		};
		const matrix = (state: DbData, filter: TaskFilter, withIndex: boolean) => matrixQuadrants(menuTasks(state, ctx, filter, { index: withIndex ? index : undefined }), state.tasks, ctx);
		// Before the index the calendar passed every task through the menu to the layout and made the drawer's rows.
		const calendarBefore = (state: DbData) => {
			const tasks = filterTasks(state.tasks.values(), open, "", ctx);
			const placed = layoutWeek(tasks, week, calCtx(state));
			const rows = tasks.filter((t) => t.scheduled === null && t.recurrence === null && t.status === "open").sort(compareTasksBySortKey).map((t) => entryOf(t, state.tasks, ctx));
			return { placed, unscheduled: rows.length };
		};
		const cases: { name: string; build: (state: DbData, withIndex: boolean) => unknown }[] = [
			{ name: "calendar week", build: (state, withIndex) => calendar(state, withIndex, "week") },
			{ name: "calendar month", build: (state, withIndex) => calendar(state, withIndex, "month") },
			// The reference of this case is the calendar's work before the index; with the index, the week as above.
			{ name: "calendar week, before", build: (state, withIndex) => (withIndex ? calendar(state, true, "week") : calendarBefore(state)) },
			{ name: "matrix a list", build: (state, withIndex) => matrix(state, oneList, withIndex) },
			{ name: "matrix", build: (state, withIndex) => matrix(state, all, withIndex) },
		];
		const times = new Map<string, number[]>();
		const scanTimes = new Map<string, number[]>();
		const push = (map: Map<string, number[]>, name: string, ms: number) => map.set(name, [...(map.get(name) ?? []), ms]);
		for (let run = 0; run < RUNS + 1; run++) {
			await h.app.tasks.update(taskId(run * 1000 + 1), { title: `Edited ${run}` });
			const state = h.app.store.state;
			for (const { name, build } of cases) {
				const scanStart = performance.now();
				const reference = build(state, false);
				const scanMs = performance.now() - scanStart;
				const start = performance.now();
				const result = build(state, true);
				const ms = performance.now() - start;
				expect(result).toEqual(reference);
				if (run > 0) push(times, name, ms);
				if (run > 0) push(scanTimes, name, scanMs);
			}
		}
		const state = h.app.store.state;
		const ratio = (name: string) => fastest(times.get(name) ?? []) / fastest(scanTimes.get(name) ?? []);
		const report = cases
			.map(({ name }) => `${name} ${median(times.get(name) ?? []).toFixed(2)} ms with the index, ${median(scanTimes.get(name) ?? []).toFixed(2)} ms without (fastest ${ratio(name).toFixed(2)} of it)`)
			.join("; ");
		if (LOG) process.stderr.write(`issue-41: calendar and matrix after one edit at ${TASKS} tasks: ${report}\n`);
		// Candidates: the 2,500 dated tasks, a list's 5,000. The open tasks are 90% of all here: their set is not read,
		// and the matrix by default shows every task.
		const openCount = [...state.tasks.values()].filter((t) => t.status === "open").length;
		expect(index.filterCandidates(state, open, "dated")?.length, report).toBe(TASKS / 20);
		expect(index.filterCandidates(state, oneList)?.length, report).toBe(TASKS / LISTS);
		expect(index.filterCandidates(state, open, "open"), report).toBeUndefined();
		expect(index.filterCandidates(state, all), report).toBeUndefined();
		expect(index.openTotal(state), report).toBe(openCount);
		// The calendar with the drawer closed and the matrix of one list make no pass over the task map; the drawer's
		// rows and the matrix by default read every task once.
		const passes = async (fn: () => unknown) => (await countBigPasses(fn)).passes.length;
		expect(await passes(() => calendar(state, true, "week")), report).toBe(0);
		expect(await passes(() => calendar(state, true, "month")), report).toBe(0);
		expect(await passes(() => matrix(state, oneList, true)), report).toBe(0);
		expect(await passes(() => unscheduledTasks(state, ctx, open, index)), report).toBe(1);
		expect(await passes(() => matrix(state, all, true)), report).toBe(1);
		expect(ratio("calendar week"), report).toBeLessThan(CALENDAR_RATIO);
		expect(ratio("calendar month"), report).toBeLessThan(CALENDAR_RATIO);
		expect(ratio("calendar week, before"), report).toBeLessThan(CALENDAR_BEFORE_RATIO);
		expect(ratio("matrix a list"), report).toBeLessThan(MATRIX_LIST_RATIO);
		for (const { name } of cases) expect(fastest(times.get(name) ?? []), report).toBeLessThan(SAFETY_NET_MS);
	}, 120_000);

	it("redraws the calendar after an edit without a pass over the tasks while the drawer is closed", async () => {
		const { h } = await bigHarness();
		const host = new U1Host(h);
		const container = document.createElement("div");
		container.className = "cp-main";
		document.body.appendChild(container);
		dom.containers.push(container);
		dom.layout = fakeLayout({
			viewport: (el) => (el.classList.contains("cp-main") ? VIEWPORT : undefined),
			height: (el) => (el.classList.contains("cp-task-row") ? ROW : undefined),
		});
		const passes: Record<string, number[]> = {};
		for (const unscheduledOpen of [false, true]) {
			const ui = { ...initialCalendarState(h.app.queryContext().today), unscheduledOpen };
			const draw = () =>
				render(createElement(CalendarSection, { host, state: h.app.store.state, ctx: h.app.queryContext(), ui, setUi: () => undefined, visible: true }), container);
			draw();
			await new Promise((r) => setTimeout(r, 0));
			const counted: number[] = [];
			for (let run = 0; run < 3; run++) {
				await h.app.tasks.update(taskId(run * 1000 + 1), { title: `Edited ${String(unscheduledOpen)} ${run}` });
				const drawn = await countBigPasses(async () => {
					draw();
					await new Promise((r) => setTimeout(r, 0));
				});
				counted.push(drawn.passes.length);
			}
			passes[unscheduledOpen ? "drawer open" : "drawer closed"] = counted;
			render(null, container);
		}
		if (LOG) process.stderr.write(`issue-41: calendar redraws after an edit at ${TASKS} tasks, passes over the tasks: ${JSON.stringify(passes)}\n`);
		// The open drawer lists every open task without a date: it reads every task, once per redraw.
		expect(passes).toEqual({ "drawer closed": [0, 0, 0], "drawer open": [1, 1, 1] });
	}, 120_000);

	it("searches once per change while Search is shown, and never while it is hidden", async () => {
		const { h } = await bigHarness();
		const host = new U1Host(h);
		const container = document.createElement("div");
		container.className = "cp-main";
		document.body.appendChild(container);
		dom.containers.push(container);
		dom.layout = fakeLayout({
			viewport: (el) => (el.classList.contains("cp-main") ? VIEWPORT : undefined),
			height: (el) => (el.classList.contains("cp-task-row") ? ROW : undefined),
		});
		const counts: Record<string, number> = {};
		for (const visible of [true, false]) {
			const ui = { ...initialSearchState(), query: "Task 4999" };
			const draw = () =>
				render(
					createElement(SearchSection, { host, state: h.app.store.state, ctx: h.app.queryContext(), ui, setUi: () => undefined, onOpenCategory: () => undefined, onOpenHabit: () => undefined, visible }),
					container,
				);
			draw();
			await new Promise((r) => setTimeout(r, 0));
			await h.app.tasks.update(taskId(1), { title: `Edited ${String(visible)}` });
			const name = visible ? "shown" : "hidden";
			counts[`${name}, after an edit`] = (await countBigPasses(() => draw())).passes.length;
			counts[`${name}, drawn again`] = (await countBigPasses(() => draw())).passes.length;
			render(null, container);
		}
		if (LOG) process.stderr.write(`issue-41: Search at ${TASKS} tasks, passes over the tasks per redraw: ${JSON.stringify(counts)}\n`);
		expect(counts).toEqual({ "shown, after an edit": 1, "shown, drawn again": 0, "hidden, after an edit": 0, "hidden, drawn again": 0 });
	}, 120_000);
});
