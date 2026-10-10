// @vitest-environment happy-dom
import { createElement, render } from "preact";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { type TaskView, buildView, sidebarCounts } from "../../src/app/views";
import { emptyFilter } from "../../src/domain/queries";
import type { ID } from "../../src/domain/types";
import type { JournalOp } from "../../src/persistence/journal";
import { TasksSection, initialTasksState } from "../../src/ui/TasksSection";
import { appHarness } from "../app/harness";
import { makeTask } from "../persistence/fixtures";
import { U1Host } from "../ui/u1-helpers";
import { type FakeLayout, fakeLayout } from "../ui/virtual-layout";

// One task edit with the Tasks view open at 50,000 tasks (issue 41). The view rebuilds its list whenever the
// task map changes, and `buildView` filters every task. This test measures the work one edit causes:
//   - the time of `buildView` for Inbox, Today and a list on the state after an edit, and of `sidebarCounts`;
//   - the number of full passes over the task map during the edit command and during the section's redraw,
//     counted by wrapping the Map iteration methods (a pass is an iteration of a map of 40,000+ entries),
//     with the source line that started each pass.
// The assertions are loose bounds that pass today and on CI; the numbers are the result (CHECKPOINT_PERF_LOG=1).
//
// The whole app is not mounted: happy-dom mounting AppRoot with 50,000 tasks did not finish in minutes, so the
// redraw is measured on `TasksSection` alone (what the app re-renders per change for the visible view), with
// the real `buildView`, row memo and windowing. Redraw times in happy-dom are several times slower than in
// Chromium; the pass counts are exact.

const TASKS = 50_000;
const LISTS = 10;
const RUNS = 5;
const BIG = 40_000;
const CI_SLACK = process.env.CI ? 4 : 1;
const VIEW_BUDGET_MS = 200 * CI_SLACK; // the `save_ms` pass limit; one rebuild is far below it today
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

const tally = (passes: string[]) => {
	const counts = new Map<string, number>();
	for (const p of passes) counts.set(p, (counts.get(p) ?? 0) + 1);
	return [...counts].map(([where, n]) => `${n}x ${where}`).join("; ");
};

async function bigHarness() {
	const h = await appHarness();
	const lists: ID[] = [];
	for (let i = 0; i < LISTS; i++) lists.push((await h.app.categories.create(`List ${i}`)).id);
	const today = h.app.queryContext().today;
	const data = h.store.data;
	const tasks = new Map(data.tasks);
	const ops: JournalOp[] = [];
	for (let i = 0; i < TASKS; i++) {
		const t = makeTask(taskId(i + 1), {
			title: `Task ${i}`,
			sortKey: `V${i.toString(36).padStart(4, "0")}`,
			categoryId: i % 2 === 0 ? "inbox" : lists[i % LISTS],
			scheduled: i % 20 === 0 ? { kind: "date", date: today } : null,
			status: i % 10 === 3 ? "completed" : "open",
			completedAt: i % 10 === 3 ? "2026-09-30T18:00:00.000Z" : null,
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
	it("times buildView for Inbox, Today and a list on the state after an edit", async () => {
		const { h, lists } = await bigHarness();
		const views: { name: string; view: TaskView }[] = [
			{ name: "Inbox", view: { kind: "inbox" } },
			{ name: "Today", view: { kind: "today" } },
			{ name: "a list", view: { kind: "category", id: lists[1] as ID } },
		];
		const ctx = h.app.queryContext();
		const times = new Map<string, number[]>();
		const rows = new Map<string, number>();
		let counts: number[] = [];
		for (let run = 0; run < RUNS + 1; run++) {
			// The edit command, then the view work its change triggers.
			await h.app.tasks.update(taskId(run * 1000 + 1), { title: `Edited ${run}` });
			const state = h.app.store.state;
			for (const { name, view } of views) {
				const start = performance.now();
				const groups = buildView(state, view, ctx, emptyFilter(), "");
				const ms = performance.now() - start;
				rows.set(name, groups.reduce((n, g) => n + g.entries.length, 0));
				if (run > 0) times.set(name, [...(times.get(name) ?? []), ms]);
			}
			const start = performance.now();
			sidebarCounts(state, ctx);
			if (run > 0) counts = [...counts, performance.now() - start];
		}
		const report = [...views.map(({ name }) => `${name} ${median(times.get(name) ?? []).toFixed(1)} ms (${rows.get(name)} rows)`), `sidebar counts ${median(counts).toFixed(1)} ms`].join("; ");
		if (LOG) process.stderr.write(`issue-41: buildView after one edit at ${TASKS} tasks: ${report}\n`);
		for (const { name } of views) expect(median(times.get(name) ?? []), report).toBeLessThan(VIEW_BUDGET_MS);
		expect(median(counts), report).toBeLessThan(VIEW_BUDGET_MS);
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
			const commandPasses = median(command.map((p) => p.length));
			const redrawPasses = median(redraw.map((p) => p.length));
			if (LOG) {
				process.stderr.write(
					`issue-41: one edit at ${TASKS} tasks (${open.name} open): ${commandPasses} full passes in the edit command (${tally(command[0] ?? [])}); ` +
						`${redrawPasses} in the section redraw (${tally(redraw[0] ?? [])}); redraw ${median(redrawMs).toFixed(0)} ms in happy-dom\n`,
				);
			}
			expect(container.textContent).toContain(`Edited ${RUNS}`);
			// The redraw rebuilds the view from the changed task map: at least one pass. The upper bound only catches a runaway.
			expect(redrawPasses).toBeGreaterThanOrEqual(1);
			expect(redrawPasses).toBeLessThanOrEqual(20);
			expect(commandPasses).toBeLessThanOrEqual(20);
		}, 120_000);
	}
});
