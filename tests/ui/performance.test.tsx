// @vitest-environment happy-dom
import { render } from "preact";
import { describe, expect, it } from "vitest";
import { buildList, sidebarCounts } from "../../src/app/views";
import { emptyFilter } from "../../src/domain/queries";
import { addDays } from "../../src/domain/time";
import type { Checkin, Habit, ID, Task } from "../../src/domain/types";
import type { JournalOp } from "../../src/persistence/journal";
import { HabitsSection, initialHabitsState } from "../../src/ui/HabitsSection";
import { TodayHabitsBlock } from "../../src/ui/habits/TodayHabits";
import { TaskList } from "../../src/ui/TaskList";
import { makeTask } from "../persistence/fixtures";
import { appHarness } from "../app/harness";
import { elapsed, perfLog, timeBoth } from "../perf/measure";
import { U1Host } from "./app-helpers";

// View render under 100 ms at 5,000 tasks on desktop.
//
// happy-dom builds DOM nodes several times slower than Chromium, and a time depends on how busy the machine is, so no
// test here asserts a time. The O(n) property is checked deterministically by counting full scans of the task map
// during one render, and by comparing the Inbox at 5,000 tasks with the Inbox at 1,250 in the same run: four times the
// rows take about four times as long, while an O(n²) render takes sixteen times as long.
//
// Measured 2026-10-01 on an M-series Mac, Node 22 (CHECKPOINT_PERF_LOG=1 prints them): list query 1.1-2.0 ms; query +
// render of the 4,500 Inbox rows 203-231 ms, alone or under the full parallel suite.

const TOTAL = 5000;
const SUBS_PER_PARENT = 2;
const openRows = (total: number) => total - total / 10; // every root, plus the open subtask of each parent
const OPEN_ROWS = openRows(TOTAL);
const GROWTH = 8;
// A flat allowance for timer noise and a collection pause in one run.
const NOISE_MS = 50;

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

/** `total` tasks: a tenth of them are parents with two subtasks each, one completed and one open. */
function bigTaskSet(total = TOTAL): Task[] {
	const tasks: Task[] = [];
	const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
	const parents = total / 10;
	const roots = total - parents * SUBS_PER_PARENT;
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
	for (let p = 0; p < parents; p++) {
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

async function bigState(total = TOTAL) {
	const h = await appHarness();
	const data = h.store.data;
	const tasks = new ScanCountingMap(data.tasks);
	const ops: JournalOp[] = [];
	for (const t of bigTaskSet(total)) {
		tasks.set(t.id, t);
		ops.push({ c: "tasks", id: t.id, v: t });
	}
	h.store.commit({ ...data, tasks }, ops);
	const state = h.app.store.state;
	expect(state.tasks.size).toBe(total);
	const host = new U1Host(h);
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

	it("the Inbox list query and render grow linearly with the tasks", async () => {
		type Big = Awaited<ReturnType<typeof bigState>>;
		const large = await bigState();
		let small: Big | null = await bigState(TOTAL / 4);
		const inbox = ({ state, host, ctx }: Big, container: HTMLElement) => {
			sidebarCounts(state, ctx);
			const groups = buildList(state, { kind: "inbox" }, ctx, emptyFilter(), "").groups;
			render(<TaskList host={host} state={state} groups={groups} ctx={ctx} selectedId={null} showCategory={false} emptyText="" label="Inbox" onSelect={() => undefined} />, container);
		};
		/**
		 * The rows the Inbox of `big` draws. Counted by walking the elements: happy-dom keeps what a `querySelectorAll` over
		 * thousands of rows matched after they are unmounted, about 300 MB per query here.
		 */
		const rowsOf = (big: Big) => {
			const container = document.createElement("div");
			inbox(big, container);
			let rows = 0;
			const walk = (el: Element | null): void => {
				for (let e = el; e !== null; e = e.nextElementSibling) {
					if (e.classList.contains("cp-task-row")) rows++;
					walk(e.firstElementChild);
				}
			};
			walk(container.firstElementChild);
			render(null, container);
			return rows;
		};
		const largeContainer = document.createElement("div");
		const smallContainer = document.createElement("div");
		/**
		 * Query and render of the Inbox of `big`, as when the view opens, then its unmount, so at most one Inbox is in the
		 * DOM at a time; both sizes pay the unmount alike.
		 */
		const openAndClose = (big: Big, container: HTMLElement) => () => {
			inbox(big, container);
			render(null, container);
		};
		try {
			expect(rowsOf(large)).toBe(OPEN_ROWS);
			expect(rowsOf(small)).toBe(openRows(TOTAL / 4));
			const queryMs = elapsed(() => buildList(large.state, { kind: "inbox" }, large.ctx, emptyFilter(), ""));
			const times = timeBoth(openAndClose(small, smallContainer), openAndClose(large, largeContainer), 2);
			small = null;
			const report = `query + render ${times.small.toFixed(0)} ms at ${TOTAL / 4} tasks, ${times.large.toFixed(0)} ms at ${TOTAL}`;
			perfLog(`Inbox: list query ${queryMs.toFixed(1)} ms at ${TOTAL} tasks; ${report}`);
			expect(times.large, report).toBeLessThan(times.small * GROWTH + NOISE_MS);
		} finally {
			render(null, largeContainer);
			render(null, smallContainer);
		}
	}, 60_000);
});

// The Habits page and the Today block at target scale (20 habits, 20,000 check-ins): one
// HabitIndex per state, so a render is a few streak walks and one 50-row log, not a pass per row.
describe("performance at target scale: 20 habits and 20,000 check-ins", () => {
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
		const host = new U1Host(h);
		return { h, host, ctx };
	}

	it("renders the Habits page and the Today block", async () => {
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
			perfLog(`habits page ${pageMs.toFixed(0)} ms, today block ${blockMs.toFixed(0)} ms`);
		} finally {
			render(null, container);
			container.remove();
		}
	});
});
