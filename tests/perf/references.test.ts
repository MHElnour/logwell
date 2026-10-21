import { describe, expect, it } from "vitest";
import { Tx } from "../../src/app/tx";
import { INBOX_ID } from "../../src/domain/types";
import type { AppHarness } from "../app/harness";
import { makeTask } from "../persistence/fixtures";
import { countBigPasses, measuredAsync, perfLog, tally } from "./measure";
import { TASKS, bigHarness, uuid } from "./view-edit-fixture";

// The reference check of every commit and of Undo at 50,000 tasks (#215). The check reads the records a command wrote
// and, for each record it removes, the records that point at it: those come from the task index while it is built, so
// no command and no Undo makes a pass over the task map for it. Measured: one task edit, Complete all of a parent with
// 500 subtasks, the delete of a list of 25,000 tasks and its Undo. The check's own time is the time from the end of the
// command (`Tx.finish`) to the save (`commit`), logged with CHECKPOINT_PERF_LOG=1; the pass counts are exact.

const SUBTASKS = 500;

/** Runs `run` and returns its time, the passes over the task map it made, and the time its reference check took. */
async function measuredCheck(h: AppHarness, run: () => Promise<unknown>): Promise<{ ms: number; checkMs: number; passes: string[] }> {
	const proto = Tx.prototype as unknown as { finish: (this: Tx) => ReturnType<Tx["finish"]> };
	const finish = proto.finish;
	let finished = Number.NaN;
	let checkMs = Number.NaN;
	proto.finish = function (this: Tx) {
		const out = finish.call(this);
		finished = performance.now();
		return out;
	};
	const commit = h.store.commit.bind(h.store);
	h.store.commit = (next, ops) => {
		checkMs = performance.now() - finished;
		commit(next, ops);
	};
	try {
		const { result, passes } = await countBigPasses(() => measuredAsync(run));
		return { ms: result.ms, checkMs, passes };
	} finally {
		proto.finish = finish;
		Reflect.deleteProperty(h.store, "commit");
	}
}

describe("the reference check", () => {
	it("#215: checks an edit, Complete all of 500 subtasks, a 25,000-task list delete and its Undo without a pass over the tasks", async () => {
		const { h, lists } = await bigHarness(true);
		const store = h.app.store;
		const index = h.app.tasks.lists;
		const parentId = uuid(1, 0);
		await store.run("Seed", (tx) => {
			tx.put("tasks", makeTask(parentId, { title: "Plan the trip" }));
			for (let i = 1; i <= SUBTASKS; i++) tx.put("tasks", makeTask(uuid(1, i), { title: `Step ${i}`, parentId }));
		});
		// The index is built by the first read, as the sidebar does on open; the check never builds it.
		index.openCount(INBOX_ID);
		const rebuilds = index.rebuilds;
		const listTasks = index.tasksOf((id) => store.state.tasks.get(id), lists[0]!).length;
		expect(listTasks).toBe(TASKS / 2);

		const steps: [string, () => Promise<unknown>][] = [
			["one task edit", () => h.app.tasks.update(uuid(1, 1), { title: "Book the hotel" })],
			[`Complete all of ${SUBTASKS} subtasks`, () => h.app.tasks.complete(parentId, { includeSubtasks: true })],
			[`delete of a list of ${listTasks} tasks`, () => h.app.categories.delete(lists[0]!)],
			["its Undo", () => store.undo()],
		];
		const lines: string[] = [];
		for (const [name, run] of steps) {
			const { ms, checkMs, passes } = await measuredCheck(h, run);
			const checks = passes.filter((p) => p.includes("src/persistence/references.ts"));
			lines.push(`${name} ${ms.toFixed(1)} ms, check ${checkMs.toFixed(2)} ms, passes: ${tally(passes) || "none"}`);
			expect(checks, `${name}: ${tally(passes)}`).toEqual([]);
			if (name === "its Undo") expect(ms, lines.join("; ")).toBeLessThan(100);
		}
		expect(store.state.categories.has(lists[0]!)).toBe(true);
		expect(index.rebuilds).toBe(rebuilds);
		expect(index.verify(store.state)).toEqual([]);

		// Without the index (after a reload, before any read) the check reads the tasks once instead, and builds nothing.
		store.notifyReloaded();
		const unbuilt = await measuredCheck(h, () => h.app.categories.delete(lists[0]!));
		lines.push(`the delete without the index ${unbuilt.ms.toFixed(1)} ms, check ${unbuilt.checkMs.toFixed(2)} ms, passes: ${tally(unbuilt.passes)}`);
		perfLog(`issue-215: reference check at ${TASKS} tasks: ${lines.join("; ")}`);
		expect(unbuilt.passes.filter((p) => p.includes("src/persistence/references.ts")), tally(unbuilt.passes)).toHaveLength(1);
		expect(index.rebuilds).toBe(rebuilds);
	}, 120_000);
});
