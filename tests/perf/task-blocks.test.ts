// @vitest-environment happy-dom
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/app/settings";
import * as matcher from "../../src/domain/blockQuery";
import type { ID, Task } from "../../src/domain/types";
import { parseBlockQuery } from "../../src/parsing/blockQuery";
import type { JournalOp } from "../../src/persistence/journal";
import { BLOCK_LANGUAGE, type BlockEnv, REFRESH_MS, registerDashboardBlock } from "../../src/obsidian/dashboardBlock";
import { appHarness } from "../app/harness";
import { Plugin } from "../app/obsidian-stub";
import { makeTask } from "../persistence/fixtures";
import { U1Host } from "../ui/app-helpers";
import { countBigPasses, elapsed, elapsedAsync, perfLog, tally } from "./measure";
import { addDays } from "../../src/domain/time";
import { taskId } from "./view-edit-fixture";

// A note with 10 dashboard blocks over 50,000 tasks. One task change must wake only the blocks it can
// affect: the others run no query and draw nothing. The tasks are spread over 10 lists, 5,000 each, and 20 of
// each list's tasks are high priority; block k shows the high-priority tasks of list k. The query counts are the
// checks; the times are logged (CHECKPOINT_PERF_LOG=1). Measured: one change with one block querying about 10 ms; a
// change no block can show about 5 ms (ten queries took about 45); a block with a tag list and both date keys about 6 ms.

const TASKS = 50_000;
const LISTS = 10;

vi.mock("../../src/domain/blockQuery", async (importActual) => {
	const actual = await importActual<typeof import("../../src/domain/blockQuery")>();
	return { ...actual, runBlockQuery: vi.fn(actual.runBlockQuery) };
});

/** The lists whose block queried since the counters were cleared. */
const queried = new Map<string, number>();

beforeAll(() => {
	const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
	proto.empty = function (this: HTMLElement) {
		this.replaceChildren();
	};
	Object.defineProperty(HTMLElement.prototype, "win", { configurable: true, get: () => window });
	Object.defineProperty(HTMLElement.prototype, "doc", { configurable: true, get: () => document });
	proto.createDiv = function (this: HTMLElement, o: { cls: string }) {
		const el = this.ownerDocument.createElement("div");
		el.className = o.cls;
		this.appendChild(el);
		return el;
	};
	proto.isShown = function (this: HTMLElement) {
		return this.isConnected;
	};
	vi.stubGlobal("IntersectionObserver", undefined);
	(window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = undefined;
});
afterAll(() => {
	vi.unstubAllGlobals();
});

describe("ten dashboard blocks over 50,000 tasks", () => {
	it("one change redraws only the blocks it can affect", async () => {
		const h = await appHarness();
		const host = new U1Host(h);
		const lists = [];
		for (let k = 0; k < LISTS; k++) lists.push(await h.app.categories.create(`List ${k}`));
		// 50,000 tasks in one commit: list k holds tasks 5,000 k .. 5,000 k + 4,999; every 250th is high priority.
		const data = h.store.data;
		const tasks = new Map(data.tasks);
		const ops: JournalOp[] = [];
		for (let i = 0; i < TASKS; i++) {
			const t: Task = makeTask(taskId(i + 1), { title: `Task ${i}`, categoryId: lists[Math.floor(i / (TASKS / LISTS))]!.id, priority: i % 250 === 7 ? 1 : 0, sortKey: `V${i.toString(36).padStart(5, "0")}` });
			tasks.set(t.id, t);
			ops.push({ c: "tasks", id: t.id, v: t });
		}
		h.store.commit({ ...data, tasks }, ops);
		expect(h.store.data.tasks.size).toBe(TASKS);

		const plugin = new Plugin({}, {});
		// One object for the life of the session, as the plugin gives it.
		const session = { app: h.app, host };
		const env: BlockEnv = {
			session: () => session,
			onSession: () => () => undefined,
			settings: () => DEFAULT_SETTINGS,
			openTask: () => undefined,
			openView: () => undefined,
		};
		registerDashboardBlock(plugin as never, env);
		const processor = plugin.codeBlockProcessors.get(BLOCK_LANGUAGE)!;
		const children: { unload(): void }[] = [];
		const els: HTMLElement[] = [];
		for (let k = 0; k < LISTS; k++) {
			const el = document.createElement("div");
			document.body.appendChild(el);
			els.push(el);
			processor(`list: List ${k}\npriority: high`, el, { sourcePath: "Note.md", addChild: (c: { load(): void; unload(): void }) => (children.push(c), c.load()) });
		}
		const title = (k: number) => [...els[k]!.querySelectorAll(".cp-task-title")].length;
		for (let k = 0; k < LISTS; k++) expect(title(k)).toBe(20);

		const actualRun = (await vi.importActual<typeof import("../../src/domain/blockQuery")>("../../src/domain/blockQuery")).runBlockQuery;
		vi.mocked(matcher.runBlockQuery).mockImplementation((filters, state, ctx, note) => {
			queried.set(filters.list!, (queried.get(filters.list!) ?? 0) + 1);
			return actualRun(filters, state, ctx, note);
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
		const change = async (fn: () => Promise<unknown>): Promise<number> => {
			queried.clear();
			return elapsedAsync(async () => {
				await fn();
				await vi.advanceTimersByTimeAsync(REFRESH_MS + 10);
			});
		};
		const first = (k: number): ID => taskId(k * (TASKS / LISTS) + 1);

		// 1. A title edit of a task no block shows: no block queries or draws.
		const skipped = await change(() => h.app.tasks.update(first(3), { title: "Edited, not shown" }));
		expect([...queried.keys()]).toEqual([]);

		// 2. A task of list 3 becomes high priority: only block 3 queries, and it shows the task.
		const entering = await change(() => h.app.tasks.update(first(3), { priority: 1 }));
		expect([...queried.entries()]).toEqual([["List 3", 1]]);
		expect(title(3)).toBe(21);
		expect(title(4)).toBe(20);

		// 3. A shown task of list 5 is renamed: only block 5 queries.
		const shown = taskId(5 * (TASKS / LISTS) + 8);
		const renamed = await change(() => h.app.tasks.update(shown, { title: "Renamed" }));
		expect([...queried.entries()]).toEqual([["List 5", 1]]);
		perfLog(`task blocks: a change no block shows ${skipped.toFixed(1)} ms, one entering block 3 ${entering.toFixed(1)} ms, a rename in block 5 ${renamed.toFixed(1)} ms`);

		// 4. Many changes in one burst still cost one query per affected block.
		queried.clear();
		for (let i = 0; i < 5; i++) await h.app.tasks.update(taskId(7 * (TASKS / LISTS) + 8 + 250 * i), { title: `Burst ${i}` });
		await vi.advanceTimersByTimeAsync(REFRESH_MS + 10);
		expect([...queried.entries()]).toEqual([["List 7", 1]]);

		vi.useRealTimers();
		for (const c of children) c.unload();
		for (const el of els) el.remove();
	}, 120_000);

	// #52: a block with a tag list and both date keys is one pass over the tasks; each tag key of a task is tested once per block.
	it("a block with a tag list, due and scheduled queries 50,000 tasks in one pass", async () => {
		const h = await appHarness();
		for (const name of ["Home/Calls", "Home/Garden", "Work", "Errands"]) await h.app.tags.create(name);
		const KEYS = ["home/calls", "home/garden", "work", "errands"];
		const data = h.store.data;
		const tasks = new Map(data.tasks);
		const ops: JournalOp[] = [];
		const ctx = h.app.queryContext();
		const day = (n: number) => ({ kind: "date" as const, date: addDays(ctx.today, n) });
		for (let i = 0; i < TASKS; i++) {
			const t: Task = makeTask(taskId(i + 1), {
				title: `Task ${i}`,
				tagKeys: [KEYS[i % KEYS.length]!, ...(i % 7 === 0 ? [KEYS[(i + 1) % KEYS.length]!] : [])],
				scheduled: i % 3 === 0 ? day((i % 21) - 10) : null,
				deadline: i % 5 === 0 ? day((i % 17) - 8) : null,
				sortKey: `V${i.toString(36).padStart(5, "0")}`,
			});
			tasks.set(t.id, t);
			ops.push({ c: "tasks", id: t.id, v: t });
		}
		h.store.commit({ ...data, tasks }, ops);
		const actual = (await vi.importActual<typeof import("../../src/domain/blockQuery")>("../../src/domain/blockQuery")).runBlockQuery;
		const filters = parseBlockQuery("tag: home, work, errands\ndue: overdue\nscheduled: this week").filters;
		const ms = elapsed(() => actual(filters, h.store.data, ctx, "Note.md"));
		perfLog(`task block with a tag list, due and scheduled over ${TASKS} tasks: ${ms.toFixed(1)} ms`);
		const { result: r, passes } = await countBigPasses(() => actual(filters, h.store.data, ctx, "Note.md"));
		expect(passes, tally(passes)).toHaveLength(1);
		expect(r.kind).toBe("ok");
		if (r.kind === "ok") expect(r.entries.length).toBeGreaterThan(0);
	}, 120_000);
});
