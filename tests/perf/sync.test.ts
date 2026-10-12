import { describe, expect, it } from "vitest";
import { type Change, Tx } from "../../src/app/tx";
import { isDomainError } from "../../src/domain/errors";
import { dateFromTt, dateToTt, fieldHashes, type SyncFields } from "../../src/domain/ticktick/mapping";
import type { Category, DateSpec, SyncLink, Tag, Task } from "../../src/domain/types";
import { createEmptyDb } from "../../src/persistence/schema";
import { serializeDb } from "../../src/persistence/serializer";
import { FakeTickTick } from "../app/fake-ticktick";
import { syncHarness } from "../app/sync-harness";
import { makeTask } from "../persistence/fixtures";
import { FakeClock } from "../helpers";
import type { TtTask } from "../../src/domain/ticktick/types";

describe("sync at the limits", () => {
	// A sync pulls and diffs every linked list. At the limit (9 linked lists of 999 open tasks, the open-task cap and
	// TickTick's list count) a sync that finds no change must stay within budget, and in a 50,000-task database (the
	// target scale of docs/development/performance.md) only the linked lists' tasks may be read and touched.
	//
	// Measured 2026-10-08 on an M-series Mac, Node 22 (CHECKPOINT_PERF_LOG=1 prints them): no change 49 ms (first sync
	// after load, field hashes not memoized yet) and 18 ms; one change in 50,000 tasks 28 ms. Budgets: about 5x.

	const LISTS = 9;
	const PER_LIST = 999;
	// Same allowance as the other perf tests: CI runners are two to three times slower.
	const CI_SLACK = process.env.CI ? 4 : 1;
	const NO_CHANGE_BUDGET_MS = 250 * CI_SLACK;
	const ONE_CHANGE_BUDGET_MS = 150 * CI_SLACK;
	/** 1,000 checks of the open-task cap; measured 2026-10-08: about 4 ms. */
	const CAP_CHECKS_BUDGET_MS = 50 * CI_SLACK;
	const NOW = "2026-10-01T09:59:00.000Z";

	const uuid = (prefix: number, n: number) => `${prefix.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

	/** A database with LISTS linked lists of PER_LIST synced tasks, `total` tasks in all, and the matching TickTick. */
	/** With `tagged`, every task carries two tags (one nested), in Logwell and in TickTick, and the bases hash them. */
	/** With `notes`, the first `notes` tasks of the first list have a sync-created description note. */
	function linkedDb(total: number, tt: FakeTickTick, tagged = false, notes = 0): string {
		const db = createEmptyDb({ dbId: "db-1", revision: "r-000000000000", deviceId: "d-other", now: NOW });
		const tagKeys = tagged ? ["home/calls", "errands"] : [];
		const tags = new Map<string, Tag>();
		if (tagged) {
			for (const [key, displayName] of [["home", "Home"], ["home/calls", "Home/Calls"], ["errands", "Errands"]] as const) {
				tags.set(key, { key, displayName, color: null, createdAt: NOW, modifiedAt: NOW });
			}
			tt.addTag("home", "Home");
			tt.addTag("calls", "Calls", "home");
			tt.addTag("errands", "Errands");
		}
		const categories = new Map(db.categories);
		const tasks = new Map<string, Task>();
		const links = new Map<string, SyncLink>();
		const plan: { listId: string; name: string; tasks: Task[] }[] = [];
		for (let l = 0; l <= LISTS; l++) {
			const id = uuid(3, l);
			const list: Category = { id, name: `List ${l}`, icon: null, color: null, nameKey: `list ${l}`, isInbox: false, sortKey: `V${l}`, createdAt: NOW, modifiedAt: NOW };
			categories.set(id, list);
			plan.push({ listId: id, name: list.name, tasks: [] });
		}
		for (let i = 0; i < total; i++) {
			const linked = i < LISTS * PER_LIST;
			const slot = linked ? Math.floor(i / PER_LIST) : LISTS;
			const descriptionNote = i < notes ? { path: notePath(i), linkedAt: NOW } : null;
			const t = makeTask(uuid(1, i), { title: `Errand number ${i}`, categoryId: plan[slot]!.listId, sortKey: `V${i.toString(36).padStart(4, "0")}`, tagKeys, descriptionNote });
			tasks.set(t.id, t);
			if (linked) plan[slot]!.tasks.push(t);
		}
		for (const p of plan.slice(0, LISTS)) {
			const project = tt.addProject(p.name);
			links.set(`list:${p.listId}`, { kind: "list", logwellId: p.listId, ttId: project.id, ttProjectId: null, etag: null, base: {}, noteBySync: false, lastPulledAt: NOW, modifiedAt: NOW });
			for (const t of p.tasks) {
				const note = t.descriptionNote === null ? null : `Text of ${t.title}\nSecond line`;
				const made = tt.add(project.id, { title: t.title, ...(tagged ? { tags: ["calls", "errands"] } : {}), ...(note === null ? {} : { content: note }) });
				const base = fieldHashes({ title: t.title, status: "open", priority: 0, date: null, parent: null, section: null, tags: tagged ? ["calls", "errands"] : [] });
				links.set(`task:${t.id}`, {
					kind: "task",
					logwellId: t.id,
					ttId: made.id,
					ttProjectId: project.id,
					etag: made.etag ?? null,
					base,
					noteBySync: note !== null,
					...(note === null ? {} : { noteBase: note }),
					lastPulledAt: null,
					modifiedAt: NOW,
				});
			}
		}
		return serializeDb({ ...db, categories, tags, tasks, syncLinks: links });
	}

	const notePath = (i: number) => `Task notes/Errand number ${i}.md`;

	async function setup(total: number, tagged = false, notes = 0) {
		// The fake is filled first, then the database text that holds its ids and etags is loaded.
		const tt = new FakeTickTick(new FakeClock(NOW));
		const text = linkedDb(total, tt, tagged, notes);
		const s = await syncHarness(text, tt);
		for (let i = 0; i < notes; i++) s.h.notes.set(notePath(i), `Text of Errand number ${i}\nSecond line\n`);
		s.notesOn = notes > 0;
		return { s, tt, sync: s.sync };
	}

	async function timed(run: () => Promise<unknown>): Promise<number> {
		const start = performance.now();
		await run();
		return performance.now() - start;
	}

	/**
	 * Counts full iterations of any Map holding at least `min` entries (the tasks of a 50,000-task database) while `run`
	 * runs. A scan of all tasks shows up here even when it is too fast to fail a time budget.
	 */
	async function bigScans(min: number, run: () => Promise<unknown>): Promise<number> {
		const proto = Map.prototype as unknown as Record<string | symbol, (...args: unknown[]) => unknown>;
		const names: (string | symbol)[] = ["values", "keys", "entries", "forEach", Symbol.iterator];
		const saved = names.map((n) => proto[n]!);
		let count = 0;
		names.forEach((n, i) => {
			const original = saved[i]!;
			proto[n] = function (this: Map<unknown, unknown>, ...args: unknown[]) {
				if (this.size >= min) count++;
				return original.apply(this, args);
			};
		});
		try {
			await run();
		} finally {
			names.forEach((n, i) => (proto[n] = saved[i]!));
		}
		return count;
	}

	describe("TickTick sync at the limits (issue #6)", () => {
		it(`pulls and diffs ${LISTS} linked lists of ${PER_LIST} tasks with no change within budget`, async () => {
			const { s, tt, sync } = await setup(LISTS * PER_LIST);
			const tasks = s.h.app.store.state.tasks;
			const first = await timed(() => sync.sync());
			const second = await timed(() => sync.sync());
			if (process.env.CHECKPOINT_PERF_LOG) process.stderr.write(`sync, no change: first ${first.toFixed(0)} ms, second ${second.toFixed(0)} ms\n`);
			expect(s.h.app.store.state.tasks).toBe(tasks);
			expect(tt.count("batchTasks") + tt.count("createTask") + tt.count("getTask")).toBe(0);
			expect(first).toBeLessThan(NO_CHANGE_BUDGET_MS);
			expect(second).toBeLessThan(NO_CHANGE_BUDGET_MS);
		});

		it(`with tags on every task, a sync with no change stays within budget and sends nothing (D29)`, async () => {
			const { s, tt, sync } = await setup(LISTS * PER_LIST, true);
			const tasks = s.h.app.store.state.tasks;
			const links = s.h.app.store.state.syncLinks;
			const first = await timed(() => sync.sync());
			const second = await timed(() => sync.sync());
			if (process.env.CHECKPOINT_PERF_LOG) process.stderr.write(`sync, tagged, no change: first ${first.toFixed(0)} ms, second ${second.toFixed(0)} ms\n`);
			expect(s.h.app.store.state.tasks).toBe(tasks);
			expect(s.h.app.store.state.syncLinks).toBe(links);
			expect(tt.count("batchTasks") + tt.count("createTask") + tt.count("getTask") + tt.count("listTags") + tt.count("createTag")).toBe(0);
			expect(first).toBeLessThan(NO_CHANGE_BUDGET_MS);
			expect(second).toBeLessThan(NO_CHANGE_BUDGET_MS);
		});

		it(`with ${PER_LIST} sync-created description notes, a sync with no change reads no note after the first and stays within budget (SYNC-09)`, async () => {
			const { s, tt, sync } = await setup(LISTS * PER_LIST, false, PER_LIST);
			const links = s.h.app.store.state.syncLinks;
			const first = await timed(() => sync.sync());
			const readsAfterFirst = s.h.notes.reads.length;
			const second = await timed(() => sync.sync());
			if (process.env.CHECKPOINT_PERF_LOG) process.stderr.write(`sync, ${PER_LIST} notes, no change: first ${first.toFixed(0)} ms, second ${second.toFixed(0)} ms\n`);
			// The first sync of a session reads each sync note once; nothing differs, so nothing is written or sent.
			expect(readsAfterFirst).toBe(PER_LIST);
			expect(s.h.notes.reads.length).toBe(readsAfterFirst);
			expect(s.h.notes.writes).toEqual([]);
			expect(s.h.app.store.state.syncLinks).toBe(links);
			expect(tt.count("batchTasks") + tt.count("updateTask") + tt.count("createTask")).toBe(0);
			expect(first).toBeLessThan(NO_CHANGE_BUDGET_MS);
			expect(second).toBeLessThan(NO_CHANGE_BUDGET_MS);
		});

		it("touches only the linked lists in a 50,000-task database", async () => {
			const { s, tt, sync } = await setup(50_000);
			await sync.sync();
			const changes: Change[] = [];
			s.h.app.store.bus.on("changed", (e) => changes.push(...(e.changes ?? [])));
			const one = [...s.h.app.store.state.syncLinks.values()].find((l) => l.kind === "task")!;
			tt.edit(one.ttId, { title: "Call the bank" });
			let ms = 0;
			const scans = await bigScans(40_000, async () => (ms = await timed(() => sync.sync())));
			if (process.env.CHECKPOINT_PERF_LOG) process.stderr.write(`sync, one change in 50,000 tasks: ${ms.toFixed(0)} ms, ${scans} full scans\n`);
			// One copy of the task map, by the content command's copy-on-write transaction (Tx); no scan by the sync.
			expect(scans).toBeLessThanOrEqual(1);
			const touchedTasks = changes.filter((c) => c.c === "tasks").map((c) => c.id);
			expect(touchedTasks).toEqual([one.logwellId]);
			// The bookkeeping: that task's link and the nine list links (last pull).
			expect(changes.filter((c) => c.c === "syncLinks")).toHaveLength(1 + LISTS);
			expect(changes.every((c) => c.c === "tasks" || c.c === "syncLinks")).toBe(true);
			expect(ms).toBeLessThan(ONE_CHANGE_BUDGET_MS);
		});

		it("checks the 999 open-task cap of a synced list without a scan of all tasks (SYNC-13)", async () => {
			const { s } = await setup(50_000);
			const state = s.h.app.store.state;
			const lists = s.h.app.tasks.lists;
			const link = [...state.syncLinks.values()].find((l) => l.kind === "list")!;
			expect(lists.openCount(link.logwellId)).toBe(PER_LIST);
			const some = lists.tasksOf((id) => state.tasks.get(id), link.logwellId)[0]!;
			// A command that adds one open task to a full synced list; the put copies the task map once (Tx), outside the
			// measurement.
			const tx = new Tx(state, NOW);
			tx.put("tasks", { ...some, id: "00000009-0000-4000-8000-000000000001" });
			let refused = 0;
			let ms = 0;
			const scans = await bigScans(40_000, async () => {
				ms = await timed(async () => {
					for (let i = 0; i < 1000; i++) {
						try {
							lists.assertSyncedRoom(tx);
						} catch (err) {
							if (isDomainError(err, "SyncedListFull")) refused++;
						}
					}
				});
			});
			if (process.env.CHECKPOINT_PERF_LOG) process.stderr.write(`cap check x1000 in 50,000 tasks: ${ms.toFixed(1)} ms, ${scans} full scans\n`);
			expect(refused).toBe(1000);
			expect(scans).toBe(0);
			expect(ms).toBeLessThan(CAP_CHECKS_BUDGET_MS);
		});
	});
});

describe("field mapping", () => {
	// The field mapping runs once per linked task on every sync. 50,000 tasks (the target scale of
	// docs/development/performance.md) must map within budget: a realistic spread of dates (two years of days, a
	// quarter of them timed, three zones), deterministic.

	const TASKS = 50_000;
	// Same allowance as the other perf tests: CI runners are two to three times slower.
	const CI_SLACK = process.env.CI ? 4 : 1;
	const BUDGET_MS = 200 * CI_SLACK;
	const MAX_RATIO = 3;
	const SAFETY_MS = 2000;
	const ZONES = ["Europe/Moscow", "America/New_York", "UTC"];
	const DISPLAY = "Europe/Berlin";

	const pad = (n: number): string => String(n).padStart(2, "0");
	const day = (n: number): string => new Date(Date.UTC(2026, 0, 1) + (n % 730) * 86_400_000).toISOString().slice(0, 10);

	const specs: DateSpec[] = [];
	for (let i = 0; i < TASKS; i++) {
		specs.push(
			i % 4 === 0
				? { kind: "datetime", local: `${day(i)}T${pad(i % 24)}:${pad((i * 7) % 4 * 15)}`, tz: ZONES[i % ZONES.length] ?? "UTC" }
				: { kind: "date", date: day(i) },
		);
	}

	/** Median of 5 runs after one warm-up run (as the other perf tests): `run` is called 6 times. */
	const RUNS = 6;
	function timeIt(run: () => void): number {
		const once = (): number => {
			const start = performance.now();
			run();
			return performance.now() - start;
		};
		once();
		const times = Array.from({ length: RUNS - 1 }, once).sort((a, b) => a - b);
		return times[Math.floor(times.length / 2)]!;
	}

	describe("TickTick mapping at 50,000 tasks (issue #6)", () => {
		it("dateToTt maps every task within budget", () => {
			let sink = 0;
			const ms = timeIt(() => {
				for (const spec of specs) sink += dateToTt(spec, DISPLAY).dueDate.length;
			});
			expect(sink).toBeGreaterThan(0);
			expect(ms).toBeLessThan(BUDGET_MS);
		});

		it("dateFromTt maps every task within budget", () => {
			const tasks: Pick<TtTask, "startDate" | "dueDate" | "isAllDay" | "timeZone">[] = specs.map((s) => dateToTt(s, DISPLAY));
			let sink = 0;
			const ms = timeIt(() => {
				for (const t of tasks) sink += dateFromTt(t, DISPLAY)?.kind.length ?? 0;
			});
			expect(sink).toBeGreaterThan(0);
			expect(ms).toBeLessThan(BUDGET_MS);
		});

		it("fieldHashes hashes every task within budget", () => {
			const fieldsOf = (i: number): SyncFields => ({
				title: `Task number ${i} with a title of ordinary length`,
				status: i % 2 === 0 ? "open" : "completed",
				priority: (i % 4) as 0 | 1 | 2 | 3,
				date: specs[i] ?? null,
				parent: i % 5 === 0 ? `parent-${i}` : null,
				section: i % 3 === 0 ? `section-${i % 9}` : null,
				tags: i % 4 === 0 ? ["calls", "errands"] : [],
			});
			let sink = 0;
			const hashAll = (): void => {
				for (let i = 0; i < TASKS; i++) sink += fieldHashes(fieldsOf(i)).title?.length ?? 0;
			};
			// The reference does the same kind of work as the hashing (build the fields, serialize and encode each value, fold the
			// bytes) without its sort and set. It runs right before each timed run, so a busy machine slows both.
			let reference = 0;
			const referenceAll = (): void => {
				const encoder = new TextEncoder();
				for (let i = 0; i < TASKS; i++) {
					for (const value of Object.values(fieldsOf(i))) for (const byte of encoder.encode(JSON.stringify(value))) reference = (Math.imul(reference ^ byte, 0x01000193) | 0);
				}
			};
			const once = (run: () => void): number => {
				const start = performance.now();
				run();
				return performance.now() - start;
			};
			once(referenceAll);
			once(hashAll);
			const hashed: number[] = [];
			const references: number[] = [];
			for (let r = 0; r < RUNS - 1; r++) {
				references.push(once(referenceAll));
				hashed.push(once(hashAll));
			}
			const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
			const ms = median(hashed);
			const refMs = median(references);
			expect(sink).toBe(TASKS * 8 * RUNS);
			expect(reference).not.toBe(0);
			expect(ms).toBeLessThan(MAX_RATIO * refMs);
			// Safety net against a hashing that is slow whatever the machine does.
			expect(ms).toBeLessThan(SAFETY_MS * CI_SLACK);
		});
	});
});
