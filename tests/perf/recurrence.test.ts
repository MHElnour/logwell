import { describe, expect, it } from "vitest";
import { buildList, sidebarCounts } from "../../src/app/views";
import { type CalendarContext, layoutMonth, monthGrid } from "../../src/domain/calendar";
import { type QueryContext, emptyFilter } from "../../src/domain/queries";
import { indexOccurrenceRecords, scheduleResolver } from "../../src/domain/recurrence";
import type { OccurrenceRecord, RepeatRule, Task } from "../../src/domain/types";
import { createEmptyDb } from "../../src/persistence/schema";
import type { DbData } from "../../src/persistence/schema";
import { median, perfLog } from "./measure";

// The target-scale check with repeating tasks. 5,000 tasks, 500 of them repeating with mixed rules,
// a hundred with 50 or more records. Today, Upcoming, a month of the calendar and the sidebar counts grow linearly
// with the number of tasks: four times the tasks take well under ten times as long, measured in the same run. Each
// view's own time is logged (CHECKPOINT_PERF_LOG=1). Deterministic: a seeded generator, a fixed day.

const TASKS = 5000;
const REPEATING = 500;
const GROWTH = 10;
// A flat allowance for timer noise on a very fast small run.
const NOISE_MS = 25;
const TODAY = "2026-10-05";
const ZONE = "Europe/Berlin";

const ctxBase: QueryContext = { today: TODAY, zone: ZONE, upcomingDays: 14, weekStart: "MO" };

const day = (n: number): string => new Date(Date.UTC(2026, 9, 5) + n * 86_400_000).toISOString().slice(0, 10);
const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

function lcg(seed: number): () => number {
	let s = seed;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

const rule = (patch: Partial<RepeatRule>): RepeatRule => ({ freq: "daily", interval: 1, weekdays: null, monthly: null, afterCompletion: false, time: null, tz: null, ...patch });

const RULES: RepeatRule[] = [
	rule({}),
	rule({ freq: "weekly", weekdays: ["MO", "WE", "FR"] }),
	rule({ freq: "weekly", interval: 2, weekdays: ["TU"] }),
	rule({ freq: "monthly", monthly: { kind: "day", day: 31 } }),
	rule({ freq: "monthly", monthly: { kind: "nth", n: -1, weekday: "FR" } }),
	rule({ freq: "monthly", interval: 2, monthly: { kind: "lastDay" } }),
	rule({ freq: "yearly" }),
	rule({ interval: 3, afterCompletion: true }),
	rule({ time: "09:00", tz: ZONE }),
];

interface Seed {
	tasks: Map<string, Task>;
	records: Map<string, OccurrenceRecord>;
}

function seed(taskCount: number, repeatingCount: number): Seed {
	const rnd = lcg(42);
	const tasks = new Map<string, Task>();
	const records = new Map<string, OccurrenceRecord>();
	for (let i = 0; i < taskCount; i++) {
		const id = uuid(i);
		const repeating = i < repeatingCount;
		const offset = Math.floor(rnd() * 120) - 40;
		const base: Task = {
			id,
			title: `Task ${i}`,
			descriptionNote: null,
			categoryId: i % 7 === 0 ? "inbox" : `list-${i % 7}`,
			tagKeys: i % 5 === 0 ? ["work", "work/urgent"] : [],
			parentId: null,
			sectionId: null,
			scheduled: repeating || i % 9 === 0 ? null : { kind: "date", date: day(offset) },
			deadline: null,
			plannedDurationMin: null,
			urgent: i % 3 === 0,
			important: i % 4 === 0,
			priority: 0,
			status: !repeating && i % 11 === 0 ? "completed" : "open",
			completedAt: null,
			recurrence: null,
			sortKey: `k${String(i).padStart(6, "0")}`,
			createdAt: "2026-01-01T09:00:00.000Z",
			modifiedAt: "2026-01-01T09:00:00.000Z",
		};
		if (repeating) {
			const r = RULES[i % RULES.length]!;
			const anchor = day(-90 + (i % 40));
			base.recurrence = { anchor, versions: [{ effectiveFrom: anchor, rule: r }], end: { kind: "never" }, endedAt: null };
			// A hundred series carry 50 to 69 done or skipped records from the anchor on.
			if (i < 100) {
				const n = 50 + (i % 20);
				for (let k = 0; k < n; k++) {
					const date = day(-90 + (i % 40) + k);
					records.set(`${id}:${date}`, {
						taskId: id,
						occurrenceDate: date,
						status: k % 7 === 3 ? "skipped" : "done",
						resolvedAt: `${date}T08:00:00.000Z`,
						auto: k % 7 === 3,
						completedOn: k % 7 === 3 ? null : date,
					});
				}
			}
		}
		tasks.set(id, base);
	}
	return { tasks, records };
}

/** A state holding the seed; the maps are fresh, so no index is cached from an earlier run. */
function stateOf(s: Seed): DbData {
	const base = createEmptyDb({ dbId: "perf", revision: "r1", deviceId: "d1", now: "2026-10-05T00:00:00.000Z" });
	return { ...base, tasks: new Map(s.tasks), occurrenceRecords: new Map(s.records) };
}

/** The median of `runs` timed runs after one warm-up run (JIT); `run` returns its own time. */
function medianRun(run: () => number, runs = 5): number {
	run();
	return median(Array.from({ length: runs }, run));
}

/** Time of `work(state)` on a state built outside the timing, so the cold resolver and index are included. */
function timed(s: Seed, work: (state: DbData, ctx: QueryContext) => unknown): number {
	return medianRun(() => {
		const state = stateOf(s);
		const ctx: QueryContext = { ...ctxBase, schedule: scheduleResolver(state, ctxBase) };
		const start = performance.now();
		work(state, ctx);
		return performance.now() - start;
	});
}

const full = seed(TASKS, REPEATING);
const quarter = seed(TASKS / 4, REPEATING / 4);
const log = (name: string, ms: number): void => perfLog(`recurrence ${name}: ${ms.toFixed(1)} ms`);

/** Time of a month of the calendar over every series of `s`. */
function monthTime(s: Seed): number {
	const grid = monthGrid("2026-10-01", "MO");
	return medianRun(() => {
		const state = stateOf(s);
		const cal: CalendarContext = { zone: ZONE, today: TODAY, now: "2026-10-05T10:00:00.000Z", weekStart: "MO", records: indexOccurrenceRecords(state.occurrenceRecords) };
		const start = performance.now();
		const cells = layoutMonth(state.tasks.values(), grid, "2026-10", cal).flat();
		const elapsed = performance.now() - start;
		expect(cells.reduce((n, c) => n + c.count, 0)).toBeGreaterThan(s === full ? REPEATING : REPEATING / 4);
		return elapsed;
	});
}

describe("target-scale views with 500 repeating tasks (D12)", () => {
	it("the seed has the shape the test promises", () => {
		expect(full.tasks.size).toBe(TASKS);
		expect([...full.tasks.values()].filter((t) => t.recurrence !== null)).toHaveLength(REPEATING);
		const counts = [...indexOccurrenceRecords(full.records)].map(([, list]) => list.length);
		expect(counts.filter((n) => n >= 50)).toHaveLength(100);
	});

	it("Today builds and the repeating tasks are in it", () => {
		const ms = timed(full, (state, ctx) => {
			const groups = buildList(state, { kind: "today" }, ctx, emptyFilter(), "").groups;
			expect(groups.flatMap((g) => g.entries).some((e) => e.task.recurrence !== null)).toBe(true);
		});
		log("today", ms);
	});

	it("Upcoming builds and lists a series once", () => {
		const ms = timed(full, (state, ctx) => {
			const groups = buildList(state, { kind: "upcoming" }, ctx, emptyFilter(), "").groups;
			const ids = groups.flatMap((g) => g.entries.map((e) => e.task.id));
			expect(new Set(ids).size).toBe(ids.length);
		});
		log("upcoming", ms);
	});

	it("a month of the calendar projects every series, in time that grows linearly with the tasks", () => {
		// A month shows ~40 occurrences of every series; the timed ones each need a Luxon conversion per day (the same
		// cost a plain timed task has).
		const small = monthTime(quarter);
		const large = monthTime(full);
		log("month", large);
		perfLog(`recurrence month, scale 1,250 -> 5,000: ${(large / Math.max(small, 0.01)).toFixed(1)}x`);
		expect(large, `${small.toFixed(1)} ms -> ${large.toFixed(1)} ms`).toBeLessThan(small * GROWTH + NOISE_MS);
	});

	it("the sidebar counts count today's tasks", () => {
		const ms = timed(full, (state, ctx) => {
			const counts = sidebarCounts(state, ctx);
			expect(counts.today).toBeGreaterThan(0);
		});
		log("sidebar counts", ms);
	});

	it("grows linearly with the number of tasks: four times the tasks take well under ten times as long", () => {
		const work = (state: DbData, ctx: QueryContext): void => {
			sidebarCounts(state, ctx);
			buildList(state, { kind: "today" }, ctx, emptyFilter(), "");
			buildList(state, { kind: "upcoming" }, ctx, emptyFilter(), "");
		};
		const small = timed(quarter, work);
		const large = timed(full, work);
		perfLog(`recurrence scale 1,250 -> 5,000: ${(large / Math.max(small, 0.01)).toFixed(1)}x`);
		expect(large, `${small.toFixed(1)} ms -> ${large.toFixed(1)} ms`).toBeLessThan(small * GROWTH + NOISE_MS);
	});
});
