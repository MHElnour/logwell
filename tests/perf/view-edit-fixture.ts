import { render } from "preact";
import { afterEach, beforeAll, expect } from "vitest";
import type { ID } from "../../src/domain/types";
import type { JournalOp } from "../../src/persistence/journal";
import { appHarness } from "../app/harness";
import { makeTask } from "../persistence/fixtures";
import type { FakeLayout } from "../ui/virtual-layout";

// The 50,000-task state of the issue 41 perf tests (one edit with a view open); the measuring helpers are in
// measure.ts. Each test file runs in its own worker, so the harnesses of one file never share a heap with the other's.

export const TASKS = 50_000;
export const LISTS = 10;
export const RUNS = 5;

export const taskId = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

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
