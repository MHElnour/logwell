import { render } from "preact";
import { afterEach, beforeAll, expect } from "vitest";
import type { ID } from "../../src/domain/types";
import type { JournalOp } from "../../src/persistence/journal";
import { appHarness } from "../app/harness";
import { makeTask } from "../persistence/fixtures";
import type { FakeLayout } from "../ui/virtual-layout";

// The 50,000-task state and the measuring helpers of the issue 41 perf tests (one edit with a view open). Each test
// file runs in its own worker, so the harnesses of one file never share a heap with the other's.

export const TASKS = 50_000;
export const LISTS = 10;
export const RUNS = 5;
const BIG = 40_000;
export const CI_SLACK = process.env.CI ? 4 : 1;
// Times depend on how busy the machine is, so a view with the index is compared with the same view read through every
// task, measured in the same run (the fastest of several interleaved runs of each, so load hits both alike). The exact
// checks are the candidate counts and the sort counts; the absolute bound is only a safety net.
export const SAFETY_NET_MS = 50 * CI_SLACK;
export const fastest = (xs: number[]) => Math.min(...xs);
export const LOG = Boolean(process.env.CHECKPOINT_PERF_LOG);

export const taskId = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

export function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)] ?? 0;
}

/** Counts iterations of maps with at least `BIG` entries while `fn` runs; returns where each pass started. */
export async function countBigPasses<T>(fn: () => Promise<T> | T): Promise<{ result: T; passes: string[] }> {
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

export const tally = (passes: string[]) => {
	const counts = new Map<string, number>();
	for (const p of passes) counts.set(p, (counts.get(p) ?? 0) + 1);
	return [...counts].map(([where, n]) => `${n}x ${where}`).join("; ");
};

/**
 * Which completed task `i` is, if any: completed in lists[3] (every tenth task, as before), completed subtasks of an
 * open parent two rows up in the Inbox and ten rows up in lists[1] (they stay under the parent, and go to the
 * Completed group when a search leaves the parent out), and completed top-level tasks in both.
 */
function completedKind(i: number): "task" | "subtask" | null {
	if (i % 10 === 3) return "task";
	if (i % 20 === 4 || i % 40 === 11) return "subtask";
	if (i % 20 === 6 || i % 40 === 31) return "task";
	return null;
}

export async function bigHarness(oneBigList = false) {
	const h = await appHarness();
	const lists: ID[] = [];
	for (let i = 0; i < LISTS; i++) lists.push((await h.app.categories.create(`List ${i}`)).id);
	const today = h.app.queryContext().today;
	const data = h.store.data;
	const tasks = new Map(data.tasks);
	const ops: JournalOp[] = [];
	for (let i = 0; i < TASKS; i++) {
		const kind = completedKind(i);
		const t = makeTask(taskId(i + 1), {
			// The search "step" matches the subtasks and every fourth task, never a subtask's parent.
			title: kind === "subtask" || i % 4 === 0 ? `Task ${i} step` : `Task ${i}`,
			sortKey: `V${((i * 7919) % TASKS).toString(36).padStart(4, "0")}`,
			categoryId: i % 2 === 0 ? "inbox" : lists[oneBigList ? 0 : i % LISTS],
			parentId: kind === "subtask" ? taskId(i + 1 - (i % 2 === 0 ? 2 : 10)) : null,
			scheduled: i % 20 === 0 ? { kind: "date", date: today } : null,
			status: kind === null ? "open" : "completed",
			completedAt: kind === null ? null : `2026-09-${i % 3 === 0 ? 29 : 30}T18:${String(i % 60).padStart(2, "0")}:00.000Z`,
		});
		tasks.set(t.id, t);
		ops.push({ c: "tasks", id: t.id, v: t });
	}
	h.store.commit({ ...data, tasks }, ops);
	expect(h.app.store.state.tasks.size).toBe(TASKS);
	return { h, lists };
}

/** Rows of 52 px in a 520 px scroller: the fake layout of the windowed lists (happy-dom has none). */
export const ROW = 52;
export const VIEWPORT = 520;

/**
 * The mounted sections and the fake layout of a test file, cleared after each test; the `empty()` helper Obsidian
 * adds to elements. Call once per file.
 */
export function domCleanup(): { containers: HTMLElement[]; layout: FakeLayout | null } {
	const dom: { containers: HTMLElement[]; layout: FakeLayout | null } = { containers: [], layout: null };
	beforeAll(() => {
		(HTMLElement.prototype as unknown as { empty: () => void }).empty = function (this: HTMLElement) {
			this.replaceChildren();
		};
	});
	afterEach(() => {
		dom.layout?.restore();
		dom.layout = null;
		for (const c of dom.containers.splice(0)) {
			render(null, c);
			c.remove();
		}
	});
	return dom;
}
