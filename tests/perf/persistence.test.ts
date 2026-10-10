import { describe, expect, it } from "vitest";
import type { Checkin, FocusSession, Habit, Task } from "../../src/domain/types";
import { type DbData, createEmptyDb } from "../../src/persistence/schema";
import { serializeDb } from "../../src/persistence/serializer";
import { harness, makeTask, withTask } from "../persistence/fixtures";

// Load under 500 ms and save under 100 ms at 5,000 tasks,
// 20,000 check-ins and 5,000 focus sessions, through the real CpbaseStore,
// serializer, validator and backup store (in-memory file gateway).
//
// Measured 2026-10-01 on an M-series Mac, Node 22, vitest (median of 3 opens,
// 5 saves; CHECKPOINT_PERF_LOG=1 prints them): file 8.7 MB; load 98-136 ms;
// save of one edit 6-19 ms (the higher ends under the full parallel suite).
// The budgets are the target budgets themselves: about 4x (load) and 5x (save)
// headroom over the slowest measured run, for a slow CI machine.

const TASKS = 5000;
const HABITS = 20;
const CHECKINS = 20000;
const SESSIONS = 5000;
// The budgets were set on the M-series Mac where the suite runs locally. Shared CI runners are
// two to three times slower, so CI gets a 4x allowance: it still catches a real regression, while the
// strict numbers keep running locally.
const CI_SLACK = process.env.CI ? 4 : 1;
const LOAD_BUDGET_MS = 500 * CI_SLACK;
const SAVE_BUDGET_MS = 100 * CI_SLACK;

const uuid = (prefix: number, n: number) =>
	`${prefix.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

function day(n: number): string {
	return new Date(Date.UTC(2025, 0, 1) + n * 86400000).toISOString().slice(0, 10);
}

/** Target-scale data with records shaped like real ones, typed habits and check-ins included. */
function planScaleDb(): DbData {
	const base = createEmptyDb({ dbId: "db-1", revision: "r-000000000000", deviceId: "d-other", now: "2026-10-01T08:00:00.000Z" });
	const tasks = new Map<string, Task>();
	for (let i = 0; i < TASKS; i++) {
		const id = uuid(1, i);
		tasks.set(
			id,
			makeTask(id, {
				title: `Task number ${i} with a realistic title`,
				sortKey: `V${i.toString(36).padStart(4, "0")}`,
				scheduled: i % 4 === 0 ? { kind: "date", date: day(600 + (i % 60)) } : null,
				deadline: i % 7 === 0 ? { kind: "datetime", local: `${day(610 + (i % 30))}T17:00`, tz: "Europe/Berlin" } : null,
				descriptionNote: i % 5 === 0 ? { path: `Notes/Task ${i}.md`, linkedAt: "2026-09-01T09:00:00.000Z" } : null,
				status: i % 3 === 0 ? "completed" : "open",
				completedAt: i % 3 === 0 ? "2026-09-30T18:00:00.000Z" : null,
				urgent: i % 2 === 0,
				important: i % 3 === 1,
			}),
		);
	}
	const habits = new Map<string, Habit>();
	for (let h = 0; h < HABITS; h++) {
		const id = uuid(2, h);
		habits.set(id, {
			id,
			name: `Habit ${h}`,
			icon: null,
			color: null,
			timeOfDay: "anytime",
			reminder: null,
			archivedAt: null,
			sortKey: `a${h}`,
			createdAt: "2025-01-01T07:00:00.000Z",
			modifiedAt: "2025-01-01T07:00:00.000Z",
			versions: [
				{
					effectiveFrom: "2025-01-01",
					goal: { type: "quantity", target: 30, unit: "min", period: "day" },
					schedule: { kind: "weekdays", days: ["MO", "TU", "WE", "TH", "FR"] },
					weekStart: "MO",
				},
			],
		});
	}
	const checkins = new Map<string, Checkin>();
	for (let c = 0; c < CHECKINS; c++) {
		const id = uuid(3, c);
		const at = `${day(Math.floor(c / HABITS))}T20:15:00.000Z`;
		checkins.set(id, { id, habitId: uuid(2, c % HABITS), date: day(Math.floor(c / HABITS)), value: 20, note: null, createdAt: at, modifiedAt: at, deletedAt: null });
	}
	const focusSessions = new Map<string, FocusSession>();
	for (let s = 0; s < SESSIONS; s++) {
		const id = uuid(4, s);
		const d = day(Math.floor(s / 8));
		focusSessions.set(id, {
			id,
			deviceId: "d-other",
			taskId: uuid(1, s % TASKS),
			taskTitleSnapshot: `Task number ${s % TASKS}`,
			plannedSec: 1500,
			status: "completed",
			segments: [
				{ start: `${d}T18:00:00.000Z`, end: `${d}T18:12:30.000Z` },
				{ start: `${d}T18:15:00.000Z`, end: `${d}T18:27:30.000Z` },
			],
			unobserved: [],
			splitFrom: null,
			startedAt: `${d}T18:00:00.000Z`,
			endedAt: `${d}T18:27:30.000Z`,
			finalizedAt: `${d}T18:27:31.000Z`,
		});
	}
	return { ...base, tasks, habits, checkins, focusSessions };
}

function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)]!;
}

describe("persistence at target scale", () => {
	it(`loads under ${LOAD_BUDGET_MS} ms and saves one edit under ${SAVE_BUDGET_MS} ms`, async () => {
		const text = serializeDb(planScaleDb());
		const h = harness(text);

		// Load: open = read + parse + validate + session-start backups. The first
		// open warms up the JIT and writes the first snapshot.
		await h.store.open();
		expect(h.store.data.tasks.size).toBe(TASKS);
		expect(h.store.data.habits.size).toBe(HABITS);
		expect(h.store.data.checkins.size).toBe(CHECKINS);
		expect(h.store.data.focusSessions.size).toBe(SESSIONS);
		await h.store.close();
		const loads: number[] = [];
		let store = h.store;
		for (let i = 0; i < 3; i++) {
			store = h.newStore();
			const start = performance.now();
			await store.open();
			loads.push(performance.now() - start);
			if (i < 2) await store.close();
		}

		// Save: one edited task, the usual case (cached record lines + journal entry).
		const saves: number[] = [];
		for (let i = 0; i < 5; i++) {
			const task = store.data.tasks.get(uuid(1, i))!;
			const { next, ops } = withTask(store.data, { ...task, title: `Edited ${i}`, modifiedAt: `2026-10-01T10:00:0${i}.000Z` });
			store.commit(next, ops);
			const start = performance.now();
			await store.flush();
			saves.push(performance.now() - start);
		}
		await store.close();
		expect(h.dbText()).toContain('"title":"Edited 4"');

		const sizeMb = text.length / 1e6;
		const loadMs = median(loads);
		const saveMs = Math.max(...saves.slice(1)); // the first save may rebuild the line cache
		const report = `size ${sizeMb.toFixed(1)} MB, load ${loads.map((x) => x.toFixed(0)).join("/")} ms, saves ${saves.map((x) => x.toFixed(1)).join("/")} ms`;
		expect(loadMs, report).toBeLessThan(LOAD_BUDGET_MS);
		expect(saves[0]!, report).toBeLessThan(LOAD_BUDGET_MS);
		expect(saveMs, report).toBeLessThan(SAVE_BUDGET_MS);
		if (process.env.CHECKPOINT_PERF_LOG) process.stderr.write(`${report}\n`);
	});
});
