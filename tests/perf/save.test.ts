import { describe, expect, it } from "vitest";
import { compareSortKeys } from "../../src/domain/sortKey";
import type { Task } from "../../src/domain/types";
import { type DbData, createEmptyDb } from "../../src/persistence/schema";
import { RecordLineCache, serializeDb } from "../../src/persistence/serializer";
import { harness, load, makeTask, withTask } from "../persistence/fixtures";

// Save serialization at 50,000 tasks (issue 36). `serializeDb` sorts every collection's ids on each save
// (`[...map.keys()].sort(compareSortKeys)`), although a save usually changes one record. This test times a save
// serialization after a one-task edit, the sort of the same ids on its own, and a save with nothing changed, and
// counts the lines that are serialized again. It measures; the time assertions are loose bounds so they pass
// today and on CI. Ids are random UUIDs, as the app generates them.

const TASKS = 50_000;
const EDITS = 7;
const CI_SLACK = process.env.CI ? 4 : 1;
const SAVE_BUDGET_MS = 200 * CI_SLACK; // the `save_ms` pass limit in performance.md
const LOG = Boolean(process.env.CHECKPOINT_PERF_LOG);

/** A small seeded generator, so every run sorts the same ids. */
function prng(seed: number): () => number {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function randomUuids(count: number): string[] {
	const rand = prng(36);
	const hex = (n: number) => {
		let s = "";
		for (let i = 0; i < n; i++) s += Math.floor(rand() * 16).toString(16);
		return s;
	};
	return Array.from({ length: count }, () => `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`);
}

function bigDb(ids: string[]): DbData {
	const base = createEmptyDb({ dbId: "db-1", revision: "r-000000000000", deviceId: "d-other", now: "2026-10-01T08:00:00.000Z" });
	const tasks = new Map<string, Task>();
	ids.forEach((id, i) => {
		tasks.set(
			id,
			makeTask(id, {
				title: `Task number ${i} with a realistic title`,
				sortKey: `V${i.toString(36).padStart(4, "0")}`,
				scheduled: i % 4 === 0 ? { kind: "date", date: "2026-11-01" } : null,
				status: i % 3 === 0 ? "completed" : "open",
				completedAt: i % 3 === 0 ? "2026-09-30T18:00:00.000Z" : null,
				urgent: i % 2 === 0,
			}),
		);
	});
	return { ...base, tasks };
}

function addTasks(data: DbData, count: number): DbData {
	const tasks = new Map(data.tasks);
	randomUuids(count + TASKS)
		.slice(TASKS)
		.forEach((id, i) => tasks.set(id, makeTask(id, { title: `New task ${i}`, sortKey: `W${i.toString(36).padStart(4, "0")}` })));
	return { ...data, tasks };
}

function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)] ?? 0;
}

function time<T>(fn: () => T): { ms: number; value: T } {
	const start = performance.now();
	const value = fn();
	return { ms: performance.now() - start, value };
}

describe(`#36: save serialization at ${TASKS} tasks`, () => {
	// Three orders of the task map's keys. A database read from its file has its keys in file order, which is
	// sorted. New tasks are added at the end of the map. Only ids inserted in random order (the worst case, not
	// what the app does on a normal open) make the sort do its full work.
	const scenarios: { name: string; make: (ids: string[]) => DbData }[] = [
		{ name: "as loaded (keys already sorted)", make: (ids) => load(serializeDb(bigDb(ids))) },
		{ name: "as loaded + 100 new tasks at the end", make: (ids) => addTasks(load(serializeDb(bigDb(ids))), 100) },
		{ name: "random key order (worst case)", make: bigDb },
	];

	for (const scenario of scenarios) {
		it(`times a save after a one-task edit, its id sort alone and an unchanged save: ${scenario.name}`, () => {
			const ids = randomUuids(TASKS);
			let data = scenario.make(ids);
			const cache = new RecordLineCache();
			const first = time(() => serializeDb(data, cache));

			const edits: number[] = [];
			for (let i = 0; i < EDITS; i++) {
				const task = data.tasks.get(ids[i * 1000] as string) as Task;
				const edited = { ...task, title: `Edited ${i}`, modifiedAt: `2026-10-01T10:00:0${i}.000Z` };
				// A commit copies the map and replaces one record, the way the store does.
				data = { ...data, tasks: new Map(data.tasks).set(edited.id, edited) };
				edits.push(time(() => serializeDb(data, cache)).ms);
			}
			const text = serializeDb(data, cache);
			expect(text).toContain(`"title":"Edited ${EDITS - 1}"`);

			const sorts: number[] = [];
			for (let i = 0; i < EDITS; i++) sorts.push(time(() => [...data.tasks.keys()].sort(compareSortKeys)).ms);
			const unchanged: number[] = [];
			for (let i = 0; i < EDITS; i++) unchanged.push(time(() => serializeDb(data, cache)).ms);

			const editMs = median(edits);
			const sortMs = median(sorts);
			const sameMs = median(unchanged);
			if (LOG) {
				process.stderr.write(
					`issue-36 [${scenario.name}]: ${data.tasks.size} tasks, ${(text.length / 1e6).toFixed(1)} MB; first full serialize ${first.ms.toFixed(0)} ms; ` +
						`serializeDb after a one-task edit median ${editMs.toFixed(1)} ms (${edits.map((x) => x.toFixed(0)).join("/")}); ` +
						`id sort alone median ${sortMs.toFixed(1)} ms (${((sortMs / editMs) * 100).toFixed(0)}% of the edit save); ` +
						`unchanged save median ${sameMs.toFixed(1)} ms\n`,
				);
			}
			expect(editMs).toBeLessThan(SAVE_BUDGET_MS);
			expect(sameMs).toBeLessThan(SAVE_BUDGET_MS);
			expect(sortMs).toBeLessThan(SAVE_BUDGET_MS);
		}, 60_000);
	}

	it("a one-task edit serializes one record again, so the id sort is the only per-task work left", () => {
		const ids = randomUuids(2_000);
		let data = bigDb(ids);
		const cache = new RecordLineCache();
		serializeDb(data, cache);
		// Count the task lines built after the first save: only new objects need a new line.
		const originalLine = cache.line.bind(cache);
		let built = 0;
		const seen = new WeakSet<object>();
		for (const t of data.tasks.values()) seen.add(t);
		cache.line = (collection, record) => {
			if (collection === "tasks" && !seen.has(record)) built++;
			return originalLine(collection, record);
		};
		const task = data.tasks.get(ids[5] as string) as Task;
		const edited = { ...task, title: "Edited" };
		data = { ...data, tasks: new Map(data.tasks).set(edited.id, edited) };
		serializeDb(data, cache);
		expect(built).toBe(1);
	});

	it("logs a save through the store (journal, backups and file write included) at 50,000 tasks", async () => {
		const ids = randomUuids(TASKS);
		const text = serializeDb(bigDb(ids));
		const h = harness(text);
		await h.store.open();
		expect(h.store.data.tasks.size).toBe(TASKS);
		const saves: number[] = [];
		for (let i = 0; i < EDITS; i++) {
			const task = h.store.data.tasks.get(ids[i * 1000] as string) as Task;
			const { next, ops } = withTask(h.store.data, { ...task, title: `Edited ${i}`, modifiedAt: `2026-10-01T10:00:0${i}.000Z` });
			h.store.commit(next, ops);
			const start = performance.now();
			await h.store.flush();
			saves.push(performance.now() - start);
		}
		await h.store.close();
		expect(h.dbText()).toContain(`"title":"Edited ${EDITS - 1}"`);
		const saveMs = median(saves.slice(1));
		if (LOG) process.stderr.write(`issue-36: store save at ${TASKS} tasks, flush median ${saveMs.toFixed(1)} ms (${saves.map((x) => x.toFixed(0)).join("/")})\n`);
		expect(saveMs).toBeLessThan(SAVE_BUDGET_MS);
	}, 60_000);
});
