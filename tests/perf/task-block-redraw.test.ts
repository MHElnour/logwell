// @vitest-environment happy-dom
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/app/settings";
import type { ID, Task } from "../../src/domain/types";
import type { JournalOp } from "../../src/persistence/journal";
import { BLOCK_LANGUAGE, type BlockEnv, REFRESH_MS, registerDashboardBlock } from "../../src/obsidian/dashboardBlock";
import { appHarness } from "../app/harness";
import { Plugin } from "../app/obsidian-stub";
import { makeTask } from "../persistence/fixtures";
import { U1Host } from "../ui/app-helpers";
import { CI_SLACK, LISTS, LOG, TASKS, countBigPasses, median, tally, taskId } from "./view-edit-fixture";

// Issue 75: a task block's redraw makes no pass over every task of its own. The query is the only pass
// (blockQuery.ts); the subtask counts of the shown parents come from the task index, also for a completed parent the
// block still holds. Parents are every tenth task (i % 10 = 7), each followed by its one subtask (i % 10 = 8); every
// 500th task is high priority, so a list holds 10 high-priority parents and the vault 100 (under the 150 rows above
// which a list is windowed, and happy-dom has no layout to window by).

const SAFETY_NET_MS = 50 * CI_SLACK;
const RUNS = 5;

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

async function setup() {
	const h = await appHarness();
	const lists = [];
	for (let k = 0; k < LISTS; k++) lists.push(await h.app.categories.create(`List ${k}`));
	const data = h.store.data;
	const tasks = new Map(data.tasks);
	const ops: JournalOp[] = [];
	for (let i = 0; i < TASKS; i++) {
		const t: Task = makeTask(taskId(i + 1), {
			title: `Task ${i}`,
			categoryId: lists[Math.floor(i / (TASKS / LISTS))]!.id,
			priority: i % 500 === 7 ? 1 : 0,
			parentId: i % 10 === 8 ? taskId(i) : null,
			sortKey: `V${i.toString(36).padStart(5, "0")}`,
		});
		tasks.set(t.id, t);
		ops.push({ c: "tasks", id: t.id, v: t });
	}
	h.store.commit({ ...data, tasks }, ops);
	expect(h.store.data.tasks.size).toBe(TASKS);
	const plugin = new Plugin({}, {});
	const session = { app: h.app, host: new U1Host(h) };
	const env: BlockEnv = { session: () => session, onSession: () => () => undefined, settings: () => DEFAULT_SETTINGS, openTask: () => undefined, openView: () => undefined };
	registerDashboardBlock(plugin as never, env);
	const processor = plugin.codeBlockProcessors.get(BLOCK_LANGUAGE)!;
	const children: { unload(): void }[] = [];
	const els: HTMLElement[] = [];
	const block = (source: string) => {
		const el = document.createElement("div");
		document.body.appendChild(el);
		els.push(el);
		processor(source, el, { sourcePath: "Note.md", addChild: (c: { load(): void; unload(): void }) => (children.push(c), c.load()) });
		return el;
	};
	const cleanup = () => {
		vi.useRealTimers();
		for (const c of children) c.unload();
		for (const el of els) el.remove();
	};
	return { h, block, cleanup };
}

/** The first high-priority parent of list `list`: task 5,000 list + 8 (index 5,000 list + 7). */
const shownParent = (list: number): ID => taskId(list * (TASKS / LISTS) + 8);
const titles = (el: HTMLElement) => [...el.querySelectorAll(".cp-task-title")].map((t) => t.textContent.trim());
const badge = (el: HTMLElement, title: string) =>
	[...el.querySelectorAll<HTMLElement>(".cp-task-row")]
		.find((r) => r.querySelector(".cp-task-title")!.textContent.trim() === title)
		?.querySelector(".cp-meta-subtasks")
		?.textContent.replace(/\s/g, "");
/** The source file of each full pass in the pass list (`<name> <file>:<line>:<col>`), without repeats. */
const files = (passes: string[]) => [...new Set(passes.map((p) => (p.split(" ")[1] ?? "").replace(/:\d+:\d+$/, "")))].sort();
const FAKE: NonNullable<Parameters<typeof vi.useFakeTimers>[0]> = { toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] };

describe(`#75: one redraw of a task block at ${TASKS} tasks`, () => {
	it("a rename of a shown task makes only the command's and the query's passes, in a list block and in a vault-wide block", async () => {
		const { h, block, cleanup } = await setup();
		const small = block("list: List 3\npriority: high");
		const wide = block("priority: high");
		expect(titles(small)).toHaveLength(10);
		expect(titles(wide)).toHaveLength(100);
		// The first draws built the index; from here on a redraw reads it.
		const rebuilds = h.app.tasks.lists.rebuilds;
		vi.useFakeTimers(FAKE);
		const ms: number[] = [];
		for (let run = 0; run < RUNS; run++) {
			const edit = await countBigPasses(async () => {
				const start = performance.now();
				await h.app.tasks.update(shownParent(3), { title: `Renamed ${run}` });
				await vi.advanceTimersByTimeAsync(REFRESH_MS + 10);
				ms.push(performance.now() - start);
			});
			if (LOG && run === 0) process.stderr.write(`issue-75: one rename, two blocks: passes ${tally(edit.passes)}\n`);
			// The command (src/app/tx.ts) and one query per block (src/domain/blockQuery.ts); no pass of the block's own.
			expect(
				files(edit.passes).filter((f) => !f.endsWith("src/app/tx.ts") && !f.endsWith("src/domain/blockQuery.ts")),
				tally(edit.passes),
			).toEqual([]);
			expect(titles(small)).toContain(`Renamed ${run}`);
			expect(titles(wide)).toContain(`Renamed ${run}`);
		}
		expect(h.app.tasks.lists.rebuilds).toBe(rebuilds);
		if (LOG) process.stderr.write(`issue-75: command to DOM, two blocks, median ${median(ms).toFixed(1)} ms\n`);
		expect(median(ms)).toBeLessThan(SAFETY_NET_MS);
		cleanup();
	}, 120_000);

	it("a completed parent whose subtasks are all done stays on screen with its badge and no pass in the block's component", async () => {
		const { h, block, cleanup } = await setup();
		const el = block("list: List 3\npriority: high");
		const parent = shownParent(3);
		const title = h.app.store.state.tasks.get(parent)!.title;
		const child = taskId(3 * (TASKS / LISTS) + 9);
		expect(h.app.store.state.tasks.get(child)!.parentId).toBe(parent);
		expect(badge(el, title)).toBe("0/1");
		vi.useFakeTimers(FAKE);
		await h.app.tasks.complete(child);
		await vi.advanceTimersByTimeAsync(REFRESH_MS + 10);
		expect(badge(el, title)).toBe("1/1");
		const rebuilds = h.app.tasks.lists.rebuilds;
		// Completing the parent drops it from the query (a block shows open tasks); the block holds its row for the check animation.
		const completing = await countBigPasses(async () => {
			await h.app.tasks.complete(parent);
			await vi.advanceTimersByTimeAsync(REFRESH_MS + 10);
		});
		if (LOG) process.stderr.write(`issue-75: completing a held parent: passes ${tally(completing.passes)}\n`);
		expect(titles(el)).toContain(title);
		expect(badge(el, title)).toBe("1/1");
		expect(files(completing.passes).filter((f) => f.includes("src/ui/") || f.includes("src/obsidian/")), tally(completing.passes)).toEqual([]);
		expect(h.app.tasks.lists.rebuilds).toBe(rebuilds);
		cleanup();
	}, 120_000);

	it(`ten blocks affected by one rename redraw within ${SAFETY_NET_MS} ms`, async () => {
		const { h, block, cleanup } = await setup();
		const els: HTMLElement[] = [];
		// Ten list blocks, of which only the one of list 3 shows the renamed task, and nine vault-wide blocks that show it too.
		for (let k = 0; k < LISTS; k++) els.push(block(`list: List ${k}\npriority: high`));
		for (let k = 0; k < 9; k++) els.push(block("priority: high"));
		vi.useFakeTimers(FAKE);
		const ms: number[] = [];
		for (let run = 0; run < RUNS; run++) {
			const start = performance.now();
			await h.app.tasks.update(shownParent(3), { title: `Renamed ${run}` });
			await vi.advanceTimersByTimeAsync(REFRESH_MS + 10);
			ms.push(performance.now() - start);
			expect(els.filter((e) => titles(e).includes(`Renamed ${run}`))).toHaveLength(10);
		}
		if (LOG) process.stderr.write(`issue-75: one rename, ten affected blocks, median ${median(ms).toFixed(1)} ms\n`);
		expect(median(ms)).toBeLessThan(SAFETY_NET_MS);
		cleanup();
	}, 120_000);
});
