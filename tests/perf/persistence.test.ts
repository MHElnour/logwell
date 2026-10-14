import { describe, expect, it } from "vitest";
import type { Checkin, FocusSession, Habit, Task } from "../../src/domain/types";
import { type DbData, createEmptyDb } from "../../src/persistence/schema";
import { serializeDb } from "../../src/persistence/serializer";
import { harness, makeTask, withTask } from "../persistence/fixtures";
import { elapsedAsync, median, perfLog } from "./measure";
import { addDays } from "../../src/domain/time";
import { uuid } from "./view-edit-fixture";

// Load and save of one edit at 5,000 tasks, 20,000 check-ins and 5,000 focus sessions, through the real CpbaseStore,
// serializer, validator and backup store (in-memory file gateway). The data is checked; the times are logged
// (CHECKPOINT_PERF_LOG=1), since nothing in the same run does the same work to compare them with. The limits harness
// holds the open and save budgets in real Obsidian (docs/development/performance.md), and
// tests/perf/save.test.ts counts the record lines a save of one edit builds again.
//
// Measured 2026-10-01 on an M-series Mac, Node 22, vitest (median of 3 opens, 5 saves): file 8.7 MB; load 98-136 ms;
// save of one edit 6-19 ms (the higher ends under the full parallel suite).

const TASKS = 5000;
const HABITS = 20;
const CHECKINS = 20000;
const SESSIONS = 5000;

const day = (n: number): string => addDays("2025-01-01", n);

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

describe("persistence at target scale", () => {
	it("loads the target-scale data and saves one edit, and logs the times", async () => {
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
			loads.push(await elapsedAsync(() => store.open()));
			if (i < 2) await store.close();
		}

		// Save: one edited task, the usual case (cached record lines + journal entry).
		const saves: number[] = [];
		for (let i = 0; i < 5; i++) {
			const task = store.data.tasks.get(uuid(1, i))!;
			const { next, ops } = withTask(store.data, { ...task, title: `Edited ${i}`, modifiedAt: `2026-10-01T10:00:0${i}.000Z` });
			store.commit(next, ops);
			saves.push(await elapsedAsync(() => store.flush()));
		}
		await store.close();
		expect(h.dbText()).toContain('"title":"Edited 4"');

		const sizeMb = text.length / 1e6;
		// The first save may rebuild the line cache, so the slowest of the others is the one-edit save.
		perfLog(
			`size ${sizeMb.toFixed(1)} MB, load median ${median(loads).toFixed(0)} ms (${loads.map((x) => x.toFixed(0)).join("/")}), ` +
				`saves ${saves.map((x) => x.toFixed(1)).join("/")} ms (slowest after the first ${Math.max(...saves.slice(1)).toFixed(1)})`,
		);
	});
});
