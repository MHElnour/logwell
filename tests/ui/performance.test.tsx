// @vitest-environment happy-dom
import { render } from "preact";
import { beforeAll, describe, expect, it } from "vitest";
import { buildList, sidebarCounts } from "../../src/app/views";
import { emptyFilter } from "../../src/domain/queries";
import { addDays } from "../../src/domain/time";
import type { Checkin, Habit, ID, Task } from "../../src/domain/types";
import type { JournalOp } from "../../src/persistence/journal";
import type { DbData } from "../../src/persistence/schema";
import type { UiHost } from "../../src/ui/host";
import { HabitsSection, initialHabitsState } from "../../src/ui/HabitsSection";
import { TodayHabitsBlock } from "../../src/ui/habits/TodayHabits";
import { TaskList } from "../../src/ui/TaskList";
import { makeTask } from "../persistence/fixtures";
import { appHarness } from "../app/harness";

// View render under 100 ms at 5,000 tasks on desktop.
//
// happy-dom builds DOM nodes several times slower than Chromium, so the render
// budget cannot be the 100 ms target; the O(n) property is checked
// deterministically by counting full scans of the task map during one render.
//
// Measured 2026-10-01 on an M-series Mac, Node 22 (CHECKPOINT_PERF_LOG=1 prints
// them): list query 1.1-2.0 ms; query + render of the 4,500 Inbox rows
// 203-231 ms, alone or under the full parallel suite. The budgets leave about
// 10x (query) and 2x (render) headroom for CI; an O(n²) render of 4,500 rows
// is far above either.

const TOTAL = 5000;
const PARENTS = 500;
const SUBS_PER_PARENT = 2;
const OPEN_ROWS = TOTAL - PARENTS; // every root, plus the open subtask of each parent
// The budgets were set on the M-series Mac where the suite runs locally. Shared CI runners are
// two to three times slower, so CI gets a 4x allowance: it still catches a real regression, while the
// strict numbers keep running locally.
const CI_SLACK = process.env.CI ? 4 : 1;
const QUERY_BUDGET_MS = 25 * CI_SLACK;
const RENDER_BUDGET_MS = 500 * CI_SLACK;

beforeAll(() => {
	(HTMLElement.prototype as unknown as { empty: () => void }).empty = function (this: HTMLElement) {
		this.replaceChildren();
	};
});

/** A task map that counts full scans, to tell O(n) from O(n²) without timing. */
class ScanCountingMap extends Map<ID, Task> {
	scans = 0;
	override values(): MapIterator<Task> {
		this.scans++;
		return super.values();
	}
	override entries(): MapIterator<[ID, Task]> {
		this.scans++;
		return super.entries();
	}
	override keys(): MapIterator<ID> {
		this.scans++;
		return super.keys();
	}
	override forEach(fn: (value: Task, key: ID, map: Map<ID, Task>) => void): void {
		this.scans++;
		super.forEach(fn);
	}
	override [Symbol.iterator](): MapIterator<[ID, Task]> {
		this.scans++;
		return super[Symbol.iterator]();
	}
}

function bigTaskSet(): Task[] {
	const tasks: Task[] = [];
	const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
	const roots = TOTAL - PARENTS * SUBS_PER_PARENT;
	for (let i = 0; i < roots; i++) {
		tasks.push(
			makeTask(id(i + 1), {
				title: `Task ${i}`,
				sortKey: `V${i.toString(36).padStart(4, "0")}`,
				scheduled: i % 10 === 0 ? { kind: "date", date: "2026-10-01" } : null,
			}),
		);
	}
	let n = roots;
	for (let p = 0; p < PARENTS; p++) {
		for (let s = 0; s < SUBS_PER_PARENT; s++) {
			n++;
			tasks.push(
				makeTask(id(n), {
					title: `Subtask ${p}.${s}`,
					parentId: id(p + 1),
					status: s === 0 ? "completed" : "open",
					completedAt: s === 0 ? "2026-10-01T09:30:00.000Z" : null,
				}),
			);
		}
	}
	return tasks;
}

async function bigState() {
	const h = await appHarness();
	const data = h.store.data;
	const tasks = new ScanCountingMap(data.tasks);
	const ops: JournalOp[] = [];
	for (const t of bigTaskSet()) {
		tasks.set(t.id, t);
		ops.push({ c: "tasks", id: t.id, v: t });
	}
	h.store.commit({ ...data, tasks }, ops);
	const state = h.app.store.state;
	expect(state.tasks.size).toBe(TOTAL);
	const host = { app: h.app, setIcon: () => undefined } as unknown as UiHost;
	return { h, state, tasks, host, ctx: h.app.queryContext() };
}

describe(`performance at ${TOTAL} tasks`, () => {
	it("rendering the Inbox scans the task map a constant number of times", async () => {
		const { state, tasks, host, ctx } = await bigState();
		const container = document.createElement("div");
		try {
			tasks.scans = 0;
			const groups = buildList(state, { kind: "inbox" }, ctx, emptyFilter(), "").groups;
			render(
				<TaskList host={host} state={state} groups={groups} ctx={ctx} selectedId={null} showCategory={false} emptyText="" label="Inbox" onSelect={() => undefined} />,
				container,
			);
			expect(container.querySelectorAll(".cp-task-row")).toHaveLength(OPEN_ROWS);
			// O(n): a few passes in total, never one per row.
			expect(tasks.scans).toBeLessThanOrEqual(3);
		} finally {
			render(null, container);
		}
	});

	it("the Inbox list query and render stay within budget", async () => {
		const { state, host, ctx } = await bigState();
		const container = document.createElement("div");
		document.body.appendChild(container);
		const query = (s: DbData) => {
			sidebarCounts(s, ctx);
			return buildList(s, { kind: "inbox" }, ctx, emptyFilter(), "").groups;
		};
		const renderInbox = () =>
			render(
				<TaskList host={host} state={state} groups={query(state)} ctx={ctx} selectedId={null} showCategory={false} emptyText="" label="Inbox" onSelect={() => undefined} />,
				container,
			);
		try {
			// Warm up once, so the timings do not include JIT compilation.
			renderInbox();
			render(null, container);

			let start = performance.now();
			query(state);
			const queryMs = performance.now() - start;

			start = performance.now();
			renderInbox();
			const renderMs = performance.now() - start;

			expect(container.querySelectorAll(".cp-task-row")).toHaveLength(OPEN_ROWS);
			if (process.env.CHECKPOINT_PERF_LOG) process.stderr.write(`query ${queryMs.toFixed(1)} ms, query + render ${renderMs.toFixed(0)} ms\n`);
			expect(queryMs, `list query took ${queryMs.toFixed(1)} ms`).toBeLessThan(QUERY_BUDGET_MS);
			expect(renderMs, `query + render took ${renderMs.toFixed(0)} ms`).toBeLessThan(RENDER_BUDGET_MS);
		} finally {
			render(null, container);
			container.remove();
		}
	});
});

// The Habits page and the Today block at target scale (20 habits, 20,000 check-ins): one
// HabitIndex per state, so a render is a few streak walks and one 50-row log, not a pass per row.
describe("performance at target scale: 20 habits and 20,000 check-ins (D18)", () => {
	const HABITS = 20;
	const CHECKINS = 20000;
	const DAYS = CHECKINS / HABITS;

	async function habitState() {
		const h = await appHarness();
		const ctx = h.app.queryContext();
		const first = addDays(ctx.today, -(DAYS - 1));
		const data = h.store.data;
		const habits = new Map(data.habits);
		const checkins = new Map(data.checkins);
		const ops: JournalOp[] = [];
		const uuid = (prefix: number, n: number) => `${prefix.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
		for (let i = 0; i < HABITS; i++) {
			const habit: Habit = {
				id: uuid(2, i),
				name: `Habit ${i}`,
				icon: null,
				color: null,
				timeOfDay: (["morning", "afternoon", "evening", "anytime"] as const)[i % 4]!,
				reminder: null,
				archivedAt: null,
				sortKey: `a${i.toString(36).padStart(2, "0")}`,
				createdAt: "2025-01-01T07:00:00.000Z",
				modifiedAt: "2025-01-01T07:00:00.000Z",
				versions: [
					{
						effectiveFrom: first,
						goal: i % 2 === 0 ? { type: "quantity", target: 20, unit: "min", period: "day" } : { type: "count", target: 3, unit: null, period: "week" },
						schedule: i % 2 === 0 ? { kind: "weekdays", days: ["MO", "TU", "WE", "TH", "FR"] } : { kind: "weekly" },
						weekStart: "MO",
					},
				],
			};
			habits.set(habit.id, habit);
			ops.push({ c: "habits", id: habit.id, v: habit });
		}
		for (let c = 0; c < CHECKINS; c++) {
			const date = addDays(first, Math.floor(c / HABITS));
			const at = `${date}T12:00:00.000Z`;
			const checkin: Checkin = { id: uuid(3, c), habitId: uuid(2, c % HABITS), date, value: 20, note: null, createdAt: at, modifiedAt: at, deletedAt: null };
			checkins.set(checkin.id, checkin);
			ops.push({ c: "checkins", id: checkin.id, v: checkin });
		}
		h.store.commit({ ...data, habits, checkins }, ops);
		const host = {
			app: h.app,
			setIcon: () => undefined,
			settings: () => ({ eveningTime: "20:00" }),
			openSection: () => undefined,
		} as unknown as UiHost;
		return { h, host, ctx };
	}

	it("renders the Habits page and the Today block under the render budget", async () => {
		const { h, host, ctx } = await habitState();
		expect(h.app.store.state.checkins.size).toBe(CHECKINS);
		const container = document.createElement("div");
		document.body.appendChild(container);
		const page = () =>
			render(<HabitsSection host={host} state={h.app.store.state} ctx={ctx} ui={initialHabitsState(ctx.today)} setUi={() => undefined} focusRequest={null} />, container);
		const block = () => render(<TodayHabitsBlock host={host} today={ctx.today} />, container);
		try {
			page();
			render(null, container);
			block();
			render(null, container);

			let start = performance.now();
			page();
			const pageMs = performance.now() - start;
			expect(container.querySelectorAll(".cp-habit-row")).toHaveLength(HABITS);
			// The selected habit's log shows its first 50 of 1,000 entries.
			expect(container.querySelectorAll(".cp-habit-entry")).toHaveLength(50);
			render(null, container);

			start = performance.now();
			block();
			const blockMs = performance.now() - start;
			expect(container.querySelector(".cp-today-habits")).not.toBeNull();
			if (process.env.CHECKPOINT_PERF_LOG) process.stderr.write(`habits page ${pageMs.toFixed(0)} ms, today block ${blockMs.toFixed(0)} ms\n`);
			expect(pageMs, `the Habits page took ${pageMs.toFixed(0)} ms`).toBeLessThan(RENDER_BUDGET_MS);
			expect(blockMs, `the Today block took ${blockMs.toFixed(0)} ms`).toBeLessThan(RENDER_BUDGET_MS);
		} finally {
			render(null, container);
			container.remove();
		}
	});
});
