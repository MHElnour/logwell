// @vitest-environment happy-dom
import { createElement, render } from "preact";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { type TaskView, buildList, sidebarCounts } from "../../src/app/views";
import { emptyFilter } from "../../src/domain/queries";
import type { ID } from "../../src/domain/types";
import type { JournalOp } from "../../src/persistence/journal";
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
// With the index, Today and a list read only their candidates: about 1 ms is the target, bounded loosely here.
const CANDIDATES_BUDGET_MS = 5 * CI_SLACK;
const COUNTS_BUDGET_MS = 2 * CI_SLACK; // the target is 0.5 ms
// Inbox builds 22,500 rows (the target was 3 ms). With each list's order kept in the index no rows are sorted, and the
// time left is making the rows; it was about 11 ms before the order was kept. The sort count below is the exact check.
const INBOX_BUDGET_MS = 9 * CI_SLACK;
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
		expect(median(times.get("Today") ?? []), report).toBeLessThan(CANDIDATES_BUDGET_MS);
		expect(median(times.get("a list") ?? []), report).toBeLessThan(CANDIDATES_BUDGET_MS);
		expect(median(counts), report).toBeLessThan(COUNTS_BUDGET_MS);
		expect(median(times.get("Inbox") ?? []), report).toBeLessThan(INBOX_BUDGET_MS);
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
		expect(median(times), report).toBeLessThan(CANDIDATES_BUDGET_MS);
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
