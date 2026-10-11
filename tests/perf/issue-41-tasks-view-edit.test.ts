// @vitest-environment happy-dom
import { createElement, render } from "preact";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { type TaskView, buildList, calendarTasks, menuTasks, sidebarCounts, unscheduledTasks } from "../../src/app/views";
import { type CalendarContext, layoutMonth, layoutWeek, monthGrid, weekDays } from "../../src/domain/calendar";
import { matrixQuadrants } from "../../src/domain/matrix";
import { type TaskFilter, emptyFilter, entryOf, filterTasks } from "../../src/domain/queries";
import { indexOccurrenceRecords } from "../../src/domain/recurrence";
import { compareTasksBySortKey } from "../../src/domain/tasks";
import type { ID } from "../../src/domain/types";
import type { JournalOp } from "../../src/persistence/journal";
import type { DbData } from "../../src/persistence/schema";
import { CalendarSection, initialCalendarState } from "../../src/ui/CalendarSection";
import { SearchSection, initialSearchState } from "../../src/ui/SearchSection";
import { TasksSection, initialTasksState } from "../../src/ui/TasksSection";
import { appHarness } from "../app/harness";
import { makeTask } from "../persistence/fixtures";
import { U1Host } from "../ui/u1-helpers";
import { type FakeLayout, fakeLayout } from "../ui/virtual-layout";

// One task edit with the Tasks view open at 50,000 tasks (issue 41). The view rebuilds its list whenever the
// task map changes; with the task index, `buildList` filters only the view's candidates. This test measures the work
// one edit causes:
//   - the time of `buildList` (the open rows and the Completed group) for Inbox, Today and a list on the state
//     after an edit, and of `sidebarCounts`, with the index and without it (every task read);
//   - the number of full passes over the task map during the edit command and during the section's redraw,
//     counted by wrapping the Map iteration methods (a pass is an iteration of a map of 40,000+ entries),
//     with the source line that started each pass: the command copies the map once, the redraw reads none;
//   - how often the list's rows are put in order (`arrangeHierarchy` sorting its top-level rows): never with the index, which keeps each list's ids in sort order; once per build without it.
// The time bounds are loose and pass on CI; the numbers are the result (CHECKPOINT_PERF_LOG=1). The pass and
// sort counts are exact.
//
// The whole app is not mounted: happy-dom mounting AppRoot with 50,000 tasks did not finish in minutes, so the
// redraw is measured on `TasksSection` alone (what the app re-renders per change for the visible view), with
// the real `buildList`, row memo and windowing. Redraw times in happy-dom are several times slower than in
// Chromium; the pass counts are exact.

const TASKS = 50_000;
const LISTS = 10;
const RUNS = 5;
const BIG = 40_000;
const CI_SLACK = process.env.CI ? 4 : 1;
const VIEW_BUDGET_MS = 200 * CI_SLACK; // the `save_ms` pass limit; one rebuild is far below it today
// Times depend on how busy the machine is, so a view with the index is compared with the same view read through every
// task, measured in the same run (the fastest of several interleaved runs of each, so load hits both alike). The exact
// checks are the candidate counts and the sort counts; the absolute bound is only a safety net.
const SAFETY_NET_MS = 50 * CI_SLACK;
// Measured alone: Inbox about 0.5 of the full read (22,500 rows to make either way; no sort with the index), Today 0.15
// (2,500 dated tasks are its candidates), a list 0.3, the sidebar counts 0.12.
const INBOX_RATIO = 0.8;
const TODAY_RATIO = 0.5;
const LIST_RATIO = 0.6;
const COUNTS_RATIO = 0.5;
const fastest = (xs: number[]) => Math.min(...xs);
const LOG = Boolean(process.env.CHECKPOINT_PERF_LOG);

beforeAll(() => {
	(HTMLElement.prototype as unknown as { empty: () => void }).empty = function (this: HTMLElement) {
		this.replaceChildren();
	};
});

const taskId = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)] ?? 0;
}

/** Counts iterations of maps with at least `BIG` entries while `fn` runs; returns where each pass started. */
async function countBigPasses<T>(fn: () => Promise<T> | T): Promise<{ result: T; passes: string[] }> {
	const proto = Map.prototype as unknown as Record<string | symbol, (...a: unknown[]) => unknown>;
	const names: (string | symbol)[] = ["values", "keys", "entries", "forEach", Symbol.iterator];
	const originals = names.map((n) => proto[n] as (...a: unknown[]) => unknown);
	const passes: string[] = [];
	names.forEach((name, i) => {
		const original = originals[i] as (...a: unknown[]) => unknown;
		proto[name] = function (this: Map<unknown, unknown>, ...args: unknown[]) {
			if (this.size >= BIG) {
				const frames = (new Error().stack ?? "").split("\n").filter((l) => l.includes("/src/"));
				const first = (frames[0] ?? "(outside src)").trim().replace(/^at /, "").replace(/\(?file:\/\/|\)$/g, "");
				passes.push(`${String(name === Symbol.iterator ? "[iterator]" : name)} ${first.replace(/.*\/src\//, "src/")}`);
			}
			return original.apply(this, args);
		};
	});
	try {
		return { result: await fn(), passes };
	} finally {
		names.forEach((name, i) => {
			proto[name] = originals[i] as (...a: unknown[]) => unknown;
		});
	}
}

/**
 * Counts the sorts `arrangeHierarchy` makes of its top-level rows (arrays of 1,000+ tasks; its subtask
 * lists are short) while `fn` runs.
 */
async function countHierarchySorts<T>(fn: () => Promise<T> | T): Promise<{ result: T; sorts: number }> {
	const proto = Array.prototype as unknown as { sort: (...a: unknown[]) => unknown };
	const original = proto.sort;
	let sorts = 0;
	proto.sort = function (this: unknown[], ...args: unknown[]) {
		if (this.length >= 1_000 && (new Error().stack ?? "").includes("at arrangeHierarchy ")) sorts++;
		return original.apply(this, args);
	};
	try {
		return { result: await fn(), sorts };
	} finally {
		proto.sort = original;
	}
}

const tally = (passes: string[]) => {
	const counts = new Map<string, number>();
	for (const p of passes) counts.set(p, (counts.get(p) ?? 0) + 1);
	return [...counts].map(([where, n]) => `${n}x ${where}`).join("; ");
};

/**
 * Which completed task `i` is, if any: completed in lists[3] (every tenth task, as before), completed subtasks of an
 * open parent two rows up in the Inbox and ten rows up in lists[1] (they stay under the parent, and go to the
 * Completed group when a search leaves the parent out), and completed top-level tasks in both.
 */
function completedKind(i: number): "task" | "subtask" | null {
	if (i % 10 === 3) return "task";
	if (i % 20 === 4 || i % 40 === 11) return "subtask";
	if (i % 20 === 6 || i % 40 === 31) return "task";
	return null;
}

async function bigHarness(oneBigList = false) {
	const h = await appHarness();
	const lists: ID[] = [];
	for (let i = 0; i < LISTS; i++) lists.push((await h.app.categories.create(`List ${i}`)).id);
	const today = h.app.queryContext().today;
	const data = h.store.data;
	const tasks = new Map(data.tasks);
	const ops: JournalOp[] = [];
	for (let i = 0; i < TASKS; i++) {
		const kind = completedKind(i);
		const t = makeTask(taskId(i + 1), {
			// The search "step" matches the subtasks and every fourth task, never a subtask's parent.
			title: kind === "subtask" || i % 4 === 0 ? `Task ${i} step` : `Task ${i}`,
			sortKey: `V${((i * 7919) % TASKS).toString(36).padStart(4, "0")}`,
			categoryId: i % 2 === 0 ? "inbox" : lists[oneBigList ? 0 : i % LISTS],
			parentId: kind === "subtask" ? taskId(i + 1 - (i % 2 === 0 ? 2 : 10)) : null,
			scheduled: i % 20 === 0 ? { kind: "date", date: today } : null,
			status: kind === null ? "open" : "completed",
			completedAt: kind === null ? null : `2026-09-${i % 3 === 0 ? 29 : 30}T18:${String(i % 60).padStart(2, "0")}:00.000Z`,
		});
		tasks.set(t.id, t);
		ops.push({ c: "tasks", id: t.id, v: t });
	}
	h.store.commit({ ...data, tasks }, ops);
	expect(h.app.store.state.tasks.size).toBe(TASKS);
	return { h, lists };
}

const ROW = 52;
const VIEWPORT = 520;
let layout: FakeLayout | null = null;
const containers: HTMLElement[] = [];
afterEach(() => {
	layout?.restore();
	layout = null;
	for (const c of containers.splice(0)) {
		render(null, c);
		c.remove();
	}
});

describe(`one edit with the Tasks view at ${TASKS} tasks (issue 41)`, () => {
	it("times buildList for Inbox, Today and a list on the state after an edit, ordering no rows", async () => {
		const { h, lists } = await bigHarness();
		const views: { name: string; view: TaskView; text: string }[] = [
			{ name: "Inbox", view: { kind: "inbox" }, text: "" },
			// The search leaves every parent of a completed subtask out: those subtasks go to the Completed group.
			{ name: "Inbox searching", view: { kind: "inbox" }, text: "step" },
			{ name: "Today", view: { kind: "today" }, text: "" },
			{ name: "a list", view: { kind: "category", id: lists[1] as ID }, text: "" },
		];
		const ctx = h.app.queryContext();
		const index = h.app.tasks.lists;
		const times = new Map<string, number[]>();
		const scanTimes = new Map<string, number[]>();
		const rows = new Map<string, string>();
		const completed = new Map<string, number>();
		const sorts = new Map<string, number>();
		let counts: number[] = [];
		let scanCounts: number[] = [];
		for (let run = 0; run < RUNS + 1; run++) {
			// The edit command, then the view work its change triggers.
			await h.app.tasks.update(taskId(run * 1000 + 1), { title: `Edited ${run}` });
			const state = h.app.store.state;
			for (const { name, view, text } of views) {
				const scanStart = performance.now();
				const reference = buildList(state, view, ctx, emptyFilter(), text);
				const scanMs = performance.now() - scanStart;
				const start = performance.now();
				const list = buildList(state, view, ctx, emptyFilter(), text, undefined, { index });
				const ms = performance.now() - start;
				expect(list).toEqual(reference);
				const shown = list.groups.flatMap((g) => g.entries);
				rows.set(name, `${shown.length} rows (${shown.filter((e) => e.task.status === "completed").length} completed under a parent), ${list.completed.length} in the Completed group`);
				completed.set(name, list.completed.length);
				if (run > 0) times.set(name, [...(times.get(name) ?? []), ms]);
				if (run > 0) scanTimes.set(name, [...(scanTimes.get(name) ?? []), scanMs]);
			}
			const scanStart = performance.now();
			const reference = sidebarCounts(state, ctx);
			const scanMs = performance.now() - scanStart;
			const start = performance.now();
			const fromIndex = sidebarCounts(state, ctx, index);
			const ms = performance.now() - start;
			expect(fromIndex).toEqual(reference);
			if (run > 0) counts = [...counts, ms];
			if (run > 0) scanCounts = [...scanCounts, scanMs];
		}
		// Outside the timed runs: the sort counter's stack reads would cost more than the sorts.
		for (const { name, view, text } of views) sorts.set(name, (await countHierarchySorts(() => buildList(h.app.store.state, view, ctx, emptyFilter(), text, undefined, { index }))).sorts);
		const report = [
			...views.map(
				({ name }) =>
					`${name} ${median(times.get(name) ?? []).toFixed(2)} ms with the index, ${median(scanTimes.get(name) ?? []).toFixed(2)} ms without (${rows.get(name)}; rows ordered ${sorts.get(name)}x)`,
			),
			`sidebar counts ${median(counts).toFixed(2)} ms with the index, ${median(scanCounts).toFixed(2)} ms without`,
		].join("; ");
		if (LOG) process.stderr.write(`issue-41: buildList after one edit at ${TASKS} tasks: ${report}\n`);
		for (const { name } of views) expect(median(times.get(name) ?? []), report).toBeLessThan(VIEW_BUDGET_MS);
		// The index reads only the view's candidates: the Inbox half the tasks, Today the dated tasks, a list its own.
		const state = h.app.store.state;
		expect(index.candidates(state, { kind: "inbox" })?.length, report).toBe(TASKS / 2);
		expect(index.candidates(state, { kind: "today" })?.length, report).toBe(TASKS / 20);
		expect(index.candidates(state, { kind: "category", id: lists[1] as ID })?.length, report).toBe(TASKS / LISTS);
		const ratio = (name: string) => fastest(times.get(name) ?? []) / fastest(scanTimes.get(name) ?? []);
		const ratios = `Inbox ${ratio("Inbox").toFixed(2)}, Today ${ratio("Today").toFixed(2)}, a list ${ratio("a list").toFixed(2)}, sidebar counts ${(fastest(counts) / fastest(scanCounts)).toFixed(2)} of the full read`;
		if (LOG) process.stderr.write(`issue-41: fastest with the index over fastest without: ${ratios}\n`);
		expect(ratio("Inbox"), `${ratios}; ${report}`).toBeLessThan(INBOX_RATIO);
		expect(ratio("Today"), `${ratios}; ${report}`).toBeLessThan(TODAY_RATIO);
		expect(ratio("a list"), `${ratios}; ${report}`).toBeLessThan(LIST_RATIO);
		expect(fastest(counts) / fastest(scanCounts), `${ratios}; ${report}`).toBeLessThan(COUNTS_RATIO);
		for (const name of ["Inbox", "Today", "a list"]) expect(fastest(times.get(name) ?? []), report).toBeLessThan(SAFETY_NET_MS);
		expect(fastest(counts), report).toBeLessThan(SAFETY_NET_MS);
		// With the index no list sorts its rows (it walks the index's order); Today has no hierarchy.
		expect(Object.fromEntries(sorts), report).toEqual({ Inbox: 0, "Inbox searching": 0, Today: 0, "a list": 0 });
		// The Inbox and the list have completed tasks of their own; the search sends the 2,500 subtasks to the group too.
		expect(completed.get("Inbox"), report).toBe(2_500);
		expect(completed.get("Inbox searching"), report).toBe(2_500);
		expect(completed.get("a list"), report).toBe(1_250);
	}, 120_000);

	it("deletes a list of 25,000 tasks and restores it with the Inbox and the list viewed, at about the cost without kept orders", async () => {
		// Deleting a list moves its tasks to the Inbox in one event, and Undo moves them back: the index must not move
		// each task in the long orders of the Inbox and the list (that copies an array per task).
		const run = async (viewed: boolean) => {
			const { h, lists } = await bigHarness(true);
			const big = lists[0] as ID;
			const index = h.app.tasks.lists;
			const ctx = h.app.queryContext();
			const inbox: TaskView = { kind: "inbox" };
			const list: TaskView = { kind: "category", id: big };
			if (viewed) for (const view of [inbox, list]) buildList(h.app.store.state, view, ctx, emptyFilter(), "", undefined, { index });
			const timed = async (fn: () => Promise<unknown>) => {
				const start = performance.now();
				await fn();
				return performance.now() - start;
			};
			const deleteMs = await timed(() => h.app.categories.delete(big));
			expect(index.verify(h.app.store.state)).toEqual([]);
			const inboxMs = await timed(async () => buildList(h.app.store.state, inbox, ctx, emptyFilter(), "", undefined, { index }));
			const undoMs = await timed(() => h.app.store.undo());
			expect(index.verify(h.app.store.state)).toEqual([]);
			const state = h.app.store.state;
			expect(buildList(state, list, ctx, emptyFilter(), "", undefined, { index })).toEqual(buildList(state, list, ctx, emptyFilter(), ""));
			expect(buildList(state, inbox, ctx, emptyFilter(), "", undefined, { index })).toEqual(buildList(state, inbox, ctx, emptyFilter(), ""));
			return { deleteMs, undoMs, inboxMs };
		};
		// The faster of two runs without kept orders is the cost to compare with (one slow run is a pause, not the cost).
		const [first, second] = [await run(false), await run(false)] as const;
		const plain = { deleteMs: Math.min(first.deleteMs, second.deleteMs), undoMs: Math.min(first.undoMs, second.undoMs), inboxMs: Math.min(first.inboxMs, second.inboxMs) };
		const kept = await run(true);
		const report = `delete ${kept.deleteMs.toFixed(0)} ms and Undo ${kept.undoMs.toFixed(0)} ms with the orders built (${plain.deleteMs.toFixed(0)} and ${plain.undoMs.toFixed(0)} ms without), then the Inbox ${kept.inboxMs.toFixed(0)} ms (${plain.inboxMs.toFixed(0)} ms)`;
		if (LOG) process.stderr.write(`issue-41: bulk list delete at ${TASKS} tasks: ${report}\n`);
		// Moving 25,000 tasks one by one took about 800 ms each way.
		expect(kept.deleteMs, report).toBeLessThan((plain.deleteMs * 2 + 100) * CI_SLACK);
		expect(kept.undoMs, report).toBeLessThan((plain.undoMs * 2 + 100) * CI_SLACK);
	}, 300_000);

	it("reads Today from the index after a task is completed and saved, without building it again", async () => {
		const { h } = await bigHarness();
		const index = h.app.tasks.lists;
		const today: TaskView = { kind: "today" };
		buildList(h.app.store.state, today, h.app.queryContext(), emptyFilter(), "", undefined, { index });
		const rebuilds = index.rebuilds;
		const times: number[] = [];
		const scans: number[] = [];
		for (let run = 0; run < RUNS + 1; run++) {
			// Complete a task due today, then the save lands (a new state with the same tasks) before the view
			// redraws when the check animation ends.
			await h.app.tasks.complete(taskId(run * 20 + 1));
			const edited = h.app.store.state;
			await h.store.flush();
			expect(h.app.store.state).not.toBe(edited);
			const state = h.app.store.state;
			const ctx = h.app.queryContext();
			const start = performance.now();
			const list = buildList(state, today, ctx, emptyFilter(), "", undefined, { index });
			const ms = performance.now() - start;
			const scanStart = performance.now();
			const reference = buildList(state, today, ctx, emptyFilter(), "");
			const scanMs = performance.now() - scanStart;
			expect(list).toEqual(reference);
			if (run > 0) times.push(ms);
			if (run > 0) scans.push(scanMs);
		}
		const report = `Today after complete and save: ${median(times).toFixed(2)} ms with the index, ${median(scans).toFixed(2)} ms without; index rebuilds ${index.rebuilds - rebuilds}`;
		if (LOG) process.stderr.write(`issue-41: ${report}\n`);
		expect(index.rebuilds - rebuilds, report).toBe(0);
		expect(fastest(times) / fastest(scans), report).toBeLessThan(TODAY_RATIO);
		expect(fastest(times), report).toBeLessThan(SAFETY_NET_MS);
	}, 120_000);

	for (const open of [
		{ name: "Inbox", view: { kind: "inbox" } },
		{ name: "Today", view: { kind: "today" } },
	] as { name: string; view: TaskView }[]) {
		it(`counts the full passes over the tasks that one edit causes with ${open.name} open: the command, then the section's redraw`, async () => {
			const { h } = await bigHarness();
			const host = new U1Host(h);
			// Lists draw only the rows near the viewport (above 150 rows); happy-dom has no layout, so a fake one:
			// rows of 52 px in a 520 px scroller.
			layout = fakeLayout({
				viewport: (el) => (el.classList.contains("cp-main") ? VIEWPORT : undefined),
				height: (el) => (el.classList.contains("cp-task-row") ? ROW : undefined),
			});
			const container = document.createElement("div");
			container.className = "cp-main";
			document.body.appendChild(container);
			containers.push(container);
			const ui = { ...initialTasksState(), view: open.view };
			const draw = () =>
				render(
					createElement(TasksSection, {
						host,
						state: h.app.store.state,
						ctx: h.app.queryContext(),
						ui,
						setUi: () => undefined,
						visible: true,
						sidebarOpen: false,
						setSidebarOpen: () => undefined,
					}),
					container,
				);
			draw();
			await new Promise((r) => setTimeout(r, 150));
			expect(container.querySelectorAll(".cp-task-row").length).toBeGreaterThan(0);

			const command: string[][] = [];
			const redraw: string[][] = [];
			const redrawMs: number[] = [];
			for (let run = 0; run < RUNS + 1; run++) {
				const edit = await countBigPasses(() => h.app.tasks.update(taskId(1), { title: `Edited ${run}` }));
				const start = performance.now();
				const drawn = await countBigPasses(async () => {
					draw();
					await new Promise((r) => setTimeout(r, 0));
				});
				if (run > 0) {
					command.push(edit.passes);
					redraw.push(drawn.passes);
					redrawMs.push(performance.now() - start);
				}
			}
			// One more edit and redraw, untimed, to count how often the rows are ordered.
			await h.app.tasks.update(taskId(1), { title: `Edited ${RUNS + 1}` });
			const { sorts } = await countHierarchySorts(async () => {
				draw();
				await new Promise((r) => setTimeout(r, 0));
			});
			const commandPasses = median(command.map((p) => p.length));
			const redrawPasses = median(redraw.map((p) => p.length));
			if (LOG) {
				process.stderr.write(
					`issue-41: one edit at ${TASKS} tasks (${open.name} open): ${commandPasses} full passes in the edit command (${tally(command[0] ?? [])}); ` +
						`${redrawPasses} in the section redraw (${tally(redraw[0] ?? [])}); rows ordered ${sorts}x; redraw ${median(redrawMs).toFixed(0)} ms in happy-dom\n`,
				);
			}
			expect(container.textContent).toContain(`Edited ${RUNS + 1}`);
			// The rows, the Completed group, the sidebar counts and the subtask counts read the task index, and the
			// lingering rows the store's changes since the last redraw: no pass over every task.
			expect(redrawPasses, tally(redraw[0] ?? [])).toBe(0);
			expect(commandPasses).toBeLessThanOrEqual(20);
			// Inbox and Today sort no rows: the index keeps the order.
			expect(sorts).toBe(0);
		}, 120_000);
	}
});

// The calendar, the Eisenhower matrix and Search (issue 41). On every change the calendar places its dated tasks
// (the index's 2,500) and shows the Unscheduled count (from the index's open tasks, with the default menu); the
// drawer's rows are read and made only while it is open, and then every open task is read. The matrix reads the
// index's set for its menu when one holds at most half the tasks (a list, a tag, or the open tasks in a vault of
// mostly completed ones); it shows every task by default, so then it reads every task, as before. Search checks every
// title (a text search has no candidates), once per change and only while shown.
const CALENDAR_RATIO = 0.6;
const CALENDAR_BEFORE_RATIO = 0.5;
const MATRIX_LIST_RATIO = 0.75;

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
		containers.push(container);
		layout = fakeLayout({
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
		containers.push(container);
		layout = fakeLayout({
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
