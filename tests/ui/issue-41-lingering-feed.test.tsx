// @vitest-environment happy-dom
import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FEED_LIMIT } from "../../src/app/store";
import type { ID, Task } from "../../src/domain/types";
import type { JournalOp } from "../../src/persistence/journal";
import { collectionsOf } from "../../src/persistence/schema";
import { LINGER_MS, useLingering } from "../../src/ui/useLingering";
import { type AppHarness, appHarness } from "../app/harness";

// Issue 41: the hold on a just-completed row reads the store's changes since the last render (`changesSince`), not
// every task. A completion through the store holds the row for 450 ms, a reopen releases it; a reload or a
// replacement of all records (no list of changes) holds nothing; a hidden section looks at nothing and, when shown,
// holds no row completed meanwhile.

let host: HTMLElement;
let h: AppHarness;
let a: ID;
let b: ID;
let held: ReadonlySet<ID> = new Set();
let iterations = 0;
function Probe(props: { active: boolean }) {
	const tasks = h.app.store.state.tasks;
	held = useLingering(h.app.store, tasks, props.active);
	return null;
}
const draw = async (active = true) => {
	render(<Probe active={active} />, host);
	await vi.advanceTimersByTimeAsync(0);
};

/** Counts the iterations of the store's task map (a pass over every task) while `fn` runs. */
async function countTaskPasses(fn: () => Promise<void>): Promise<number> {
	const proto = Map.prototype as unknown as Record<string | symbol, (...args: unknown[]) => unknown>;
	const names: (string | symbol)[] = ["values", "keys", "entries", "forEach", Symbol.iterator];
	const originals = names.map((n) => proto[n] as (...args: unknown[]) => unknown);
	iterations = 0;
	names.forEach((name, i) => {
		const original = originals[i] as (...args: unknown[]) => unknown;
		proto[name] = function (this: Map<unknown, unknown>, ...args: unknown[]) {
			if (this === h.app.store.state.tasks) iterations++;
			return original.apply(this, args);
		};
	});
	try {
		await fn();
	} finally {
		names.forEach((name, i) => {
			proto[name] = originals[i] as (...args: unknown[]) => unknown;
		});
	}
	return iterations;
}

/** The file changed outside: persistence swaps the state with `a` completed, then the store says it reloaded. */
function reloadWithCompleted(id: ID): void {
	const data = h.store.data;
	const t = data.tasks.get(id)!;
	const done: Task = { ...t, status: "completed", completedAt: "2026-10-01T09:00:00.000Z" };
	const ops: JournalOp[] = [{ c: "tasks", id, v: done }];
	h.store.commit({ ...data, tasks: new Map(data.tasks).set(id, done) }, ops);
	h.app.store.notifyReloaded();
}

beforeEach(async () => {
	h = await appHarness();
	a = (await h.app.tasks.create({ title: "Pay rent" })).task.id;
	b = (await h.app.tasks.create({ title: "Buy milk" })).task.id;
	vi.useFakeTimers();
	host = document.createElement("div");
	document.body.append(host);
	held = new Set();
});
afterEach(() => {
	render(null, host);
	host.remove();
	vi.useRealTimers();
});

describe("the hold on a just-completed row reads the store's changes (issue 41)", () => {
	it("holds a task completed through the store for 450 ms, without reading every task", async () => {
		await draw();
		await h.app.tasks.complete(a);
		const passes = await countTaskPasses(() => draw());
		expect(held).toEqual(new Set([a]));
		expect(passes).toBe(0);
		await vi.advanceTimersByTimeAsync(LINGER_MS - 1);
		expect(held.has(a)).toBe(true);
		await vi.advanceTimersByTimeAsync(1);
		expect(held.has(a)).toBe(false);
	});

	it("releases a held task reopened through the store at once", async () => {
		await draw();
		await h.app.tasks.complete(a);
		await draw();
		await h.app.tasks.reopen(a);
		await draw();
		expect(held.size).toBe(0);
	});

	it("nets several changes between two renders: complete then reopen holds nothing, complete again holds", async () => {
		await draw();
		await h.app.tasks.complete(a);
		await h.app.tasks.reopen(a);
		await h.app.tasks.complete(b);
		await h.app.tasks.update(a, { title: "Pay the rent" });
		await draw();
		expect(held).toEqual(new Set([b]));
		await h.app.tasks.complete(a);
		await h.app.tasks.reopen(a);
		await h.app.tasks.complete(a);
		await draw();
		expect(held).toEqual(new Set([a, b]));
	});

	it("holds a task completed by Undo of a reopen, and releases one reopened by Undo of a completion", async () => {
		await draw();
		await h.app.tasks.complete(a);
		await draw();
		expect(held.has(a)).toBe(true);
		await h.app.store.undo();
		await draw();
		expect(held.has(a)).toBe(false);
		await h.app.tasks.complete(b);
		await draw();
		await vi.advanceTimersByTimeAsync(LINGER_MS);
		await h.app.tasks.reopen(b);
		await draw();
		expect(held.has(b)).toBe(false);
		await h.app.store.undo();
		await draw();
		expect(h.app.store.state.tasks.get(b)?.status).toBe("completed");
		expect(held.has(b)).toBe(true);
	});

	it("holds nothing for a reload that completed a task outside, and keeps an earlier hold", async () => {
		await draw();
		await h.app.tasks.complete(b);
		await draw();
		reloadWithCompleted(a);
		await draw();
		expect(h.app.store.state.tasks.get(a)?.status).toBe("completed");
		expect(held).toEqual(new Set([b]));
	});

	it("releases a held task that a reload or a replacement of all records reopened", async () => {
		await draw();
		const before = h.app.store.state;
		await h.app.tasks.complete(a);
		await draw();
		expect(held.has(a)).toBe(true);
		await h.app.store.replaceAll(collectionsOf(before), null);
		await draw();
		expect(h.app.store.state.tasks.get(a)?.status).toBe("open");
		expect(held.size).toBe(0);
	});

	it(`holds nothing when more than ${FEED_LIMIT} changes came between two renders, and still releases a reopened task`, async () => {
		await draw();
		await h.app.tasks.complete(a);
		await draw();
		await h.app.tasks.complete(b);
		await h.app.tasks.reopen(a);
		for (let i = 0; i < FEED_LIMIT; i++) await h.app.tasks.update(b, { title: `Buy milk ${i}` });
		expect(h.app.store.changesSince(h.app.store.version - FEED_LIMIT - 1)).toBeUndefined();
		await draw();
		expect(held.size).toBe(0);
	});

	it("a hidden section holds no row completed meanwhile when shown, and holds the next completion", async () => {
		await draw();
		await draw(false);
		await h.app.tasks.complete(a);
		await draw(false);
		await h.app.tasks.update(a, { title: "Pay the rent" });
		// Shown again without a render while hidden after the last change.
		await draw(true);
		expect(held.size).toBe(0);
		await h.app.tasks.complete(b);
		await draw();
		expect(held).toEqual(new Set([b]));
	});
});
