// @vitest-environment happy-dom
import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ID, Task } from "../../src/domain/types";
import { LINGER_MS, useLingering, useLingeringShown } from "../../src/ui/useLingering";
import { type AppHarness, appHarness } from "../app/harness";
import type { ListEntry } from "../../src/domain/queries";
import { FEED_LIMIT } from "../../src/app/store";
import type { JournalOp } from "../../src/persistence/journal";
import { collectionsOf } from "../../src/persistence/schema";
import { mountNode, unmountAll } from "./app-helpers";

describe("the hold in the app", () => {
	// The hold on a just-completed row. Fake timers drive the 450 ms; the task is completed and reopened through the
	// store, whose changes the hook reads.

	let host: HTMLElement;
	let h: AppHarness;
	let a: ID;
	let held: ReadonlySet<ID> = new Set();
	function Probe(props: { active: boolean }) {
		held = useLingering(h.app.store, h.app.store.state.tasks, props.active);
		return null;
	}
	const draw = async (active = true) => {
		render(<Probe active={active} />, host);
		await vi.advanceTimersByTimeAsync(0);
	};
	const complete = () => h.app.tasks.complete(a);
	const reopen = () => h.app.tasks.reopen(a);

	beforeEach(async () => {
		h = await appHarness();
		a = (await h.app.tasks.create({ title: "Pay rent" })).task.id;
		vi.useFakeTimers();
		host = mountNode(null);
		held = new Set();
	});
	afterEach(() => {
		unmountAll();
		vi.useRealTimers();
	});

	describe("useLingering", () => {
		it("holds a task completed while shown for exactly 450 ms", async () => {
			await draw();
			await complete();
			await draw();
			expect(held.has(a)).toBe(true);
			await vi.advanceTimersByTimeAsync(LINGER_MS - 1);
			expect(held.has(a)).toBe(true);
			await vi.advanceTimersByTimeAsync(1);
			expect(held.has(a)).toBe(false);
		});

		it("complete, reopen, complete keeps the full 450 ms from the second completion", async () => {
			await draw();
			await complete();
			await draw();
			await vi.advanceTimersByTimeAsync(100);
			await reopen();
			await draw();
			expect(held.has(a)).toBe(false);
			await vi.advanceTimersByTimeAsync(100);
			await complete();
			await draw();
			expect(held.has(a)).toBe(true);
			// Past the first timer (450 ms after the first completion): still held.
			await vi.advanceTimersByTimeAsync(LINGER_MS - 1);
			expect(held.has(a)).toBe(true);
			await vi.advanceTimersByTimeAsync(1);
			expect(held.has(a)).toBe(false);
		});

		it("a reopened task is not held, and its timer is gone", async () => {
			await draw();
			await complete();
			await draw();
			await reopen();
			await draw();
			expect(held.has(a)).toBe(false);
			// Preact's own effect flush (rAF and a 100 ms fallback) and the store's save are done by then; the 450 ms timer is not due.
			await vi.advanceTimersByTimeAsync(200);
			await h.store.flush();
			expect(vi.getTimerCount()).toBe(0);
		});

		it("a section that becomes shown only takes a baseline", async () => {
			await draw(false);
			await complete();
			await draw(false);
			await draw(true);
			expect(held.size).toBe(0);
		});

		it("unmounting leaves no pending timer", async () => {
			await draw();
			await complete();
			await draw();
			await h.store.flush();
			expect(vi.getTimerCount()).toBeGreaterThan(0);
			render(null, host);
			await vi.advanceTimersByTimeAsync(200);
			await h.store.flush();
			expect(vi.getTimerCount()).toBe(0);
		});
	});
});

describe("the hold in a task block", () => {
	// The hold on a just-completed row in a dashboard block. Unlike the app's lists, the block reads only the
	// tasks it showed last time (not a status map of every task), and uses the timers of its own window.

	const task = (status: Task["status"], id = "a"): Task => ({ id, title: id.toUpperCase(), status }) as Task;
	const entry = (t: Task): ListEntry => ({ task: t, depth: 0, parentTitle: null, schedule: null, occurrence: null });

	/** A task map that only answers `get`: iterating it fails the test. */
	class GetOnly extends Map<ID, Task> {
		constructor(tasks: Task[]) {
			super(tasks.map((t) => [t.id, t]));
		}
		override values(): never {
			throw new Error("the block must not walk every task");
		}
		override entries(): never {
			throw new Error("the block must not walk every task");
		}
		override keys(): never {
			throw new Error("the block must not walk every task");
		}
		override forEach(): never {
			throw new Error("the block must not walk every task");
		}
		override [Symbol.iterator](): never {
			throw new Error("the block must not walk every task");
		}
	}

	let host: HTMLElement;
	let held: ReadonlySet<ID> = new Set();
	let win: Window = window;
	function Probe(props: { entries: ListEntry[]; tasks: ReadonlyMap<ID, Task> }) {
		held = useLingeringShown(props.entries, props.tasks, win);
		return null;
	}
	const draw = async (entries: ListEntry[], tasks: Task[]) => {
		render(<Probe entries={entries} tasks={new GetOnly(tasks)} />, host);
		await vi.advanceTimersByTimeAsync(0);
	};

	beforeEach(() => {
		vi.useFakeTimers();
		host = mountNode(null);
		held = new Set();
		win = window;
	});
	afterEach(() => {
		unmountAll();
		vi.useRealTimers();
	});

	describe("useLingeringShown", () => {
		it("holds a shown task that is now completed for exactly 450 ms", async () => {
			await draw([entry(task("open"))], [task("open")]);
			await draw([], [task("completed")]);
			expect(held.has("a")).toBe(true);
			await vi.advanceTimersByTimeAsync(LINGER_MS - 1);
			expect(held.has("a")).toBe(true);
			await vi.advanceTimersByTimeAsync(1);
			expect(held.has("a")).toBe(false);
		});

		it("reads only the tasks it showed last time, never every task", async () => {
			const big = Array.from({ length: 200 }, (_, i) => task("open", `t${i}`));
			await draw([entry(big[0]!)], big);
			// GetOnly throws on any walk of the map; this draw must still hold the completed one.
			await draw([], [task("completed", "t0"), ...big.slice(1)]);
			expect(held.has("t0")).toBe(true);
		});

		it("does not hold a task that was not shown, one that was deleted, or one that left the filters while open", async () => {
			await draw([entry(task("open", "a")), entry(task("open", "b"))], [task("open", "a"), task("open", "b"), task("open", "c")]);
			await draw([], [task("completed", "c"), task("open", "b")]);
			expect(held.size).toBe(0);
		});

		it("releases a held task at once when it is shown again, and its timer is gone", async () => {
			await draw([entry(task("open"))], [task("open")]);
			await draw([], [task("completed")]);
			expect(held.has("a")).toBe(true);
			await draw([entry(task("open"))], [task("open")]);
			expect(held.has("a")).toBe(false);
			await vi.advanceTimersByTimeAsync(200);
			expect(vi.getTimerCount()).toBe(0);
		});

		it("complete, reopen, complete keeps the full 450 ms from the second completion", async () => {
			await draw([entry(task("open"))], [task("open")]);
			await draw([], [task("completed")]);
			await vi.advanceTimersByTimeAsync(100);
			await draw([entry(task("open"))], [task("open")]);
			await vi.advanceTimersByTimeAsync(100);
			await draw([], [task("completed")]);
			expect(held.has("a")).toBe(true);
			await vi.advanceTimersByTimeAsync(LINGER_MS - 1);
			expect(held.has("a")).toBe(true);
			await vi.advanceTimersByTimeAsync(1);
			expect(held.has("a")).toBe(false);
		});

		it("an unchanged entries list takes no new look", async () => {
			const entries = [entry(task("open"))];
			await draw(entries, [task("open")]);
			await draw(entries, [task("completed")]);
			expect(held.size).toBe(0);
		});

		it("starts and clears its timers on the window it is given, not the global one", async () => {
			const timers = new Map<number, () => void>();
			const cleared: number[] = [];
			let n = 0;
			win = {
				setTimeout: (fn: () => void, ms: number) => {
					expect(ms).toBe(LINGER_MS);
					timers.set(++n, fn);
					return n;
				},
				clearTimeout: (h: number) => void cleared.push(h),
			} as unknown as Window;
			const globalSet = vi.spyOn(window, "setTimeout");
			await draw([entry(task("open"))], [task("open")]);
			await draw([], [task("completed")]);
			expect(held.has("a")).toBe(true);
			expect([...timers.keys()]).toEqual([1]);
			expect(globalSet.mock.calls.filter(([, ms]) => ms === LINGER_MS)).toEqual([]);
			timers.get(1)!();
			await vi.advanceTimersByTimeAsync(0);
			expect(held.has("a")).toBe(false);
			// A second hold, then unmount: the timer is cleared on that window.
			await draw([entry(task("open"))], [task("open")]);
			await draw([], [task("completed")]);
			render(null, host);
			expect(cleared).toContain(2);
		});

		it("unmounting leaves no pending timer", async () => {
			await draw([entry(task("open"))], [task("open")]);
			await draw([], [task("completed")]);
			render(null, host);
			await vi.advanceTimersByTimeAsync(0);
			expect(vi.getTimerCount()).toBe(0);
		});
	});
});

describe("the hold reads the change feed", () => {
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
	/** The probe with the task map given, as a section passes the map of the state it renders. */
	function MapProbe(props: { tasks: ReadonlyMap<ID, Task> }) {
		held = useLingering(h.app.store, props.tasks, true);
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
		host = mountNode(null);
		held = new Set();
	});
	afterEach(() => {
		unmountAll();
		vi.useRealTimers();
	});

	describe("#41: the hold on a just-completed row reads the store's changes", () => {
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

		it("a render of an older task map than the store's looks at nothing; the render of the current one holds the task", async () => {
			const older = h.app.store.state.tasks;
			render(<MapProbe tasks={older} />, host);
			await vi.advanceTimersByTimeAsync(0);
			await h.app.tasks.complete(a);
			// The section re-renders alone (a hold ending) before the app passes it the new state.
			render(<MapProbe tasks={older} />, host);
			await vi.advanceTimersByTimeAsync(0);
			expect(held.size).toBe(0);
			render(<MapProbe tasks={h.app.store.state.tasks} />, host);
			await vi.advanceTimersByTimeAsync(0);
			expect(held).toEqual(new Set([a]));
		});

		it("tasks written without a change event hold nothing new, and a held task they reopened is released", async () => {
			await draw();
			await h.app.tasks.complete(b);
			await draw();
			expect(held).toEqual(new Set([b]));
			// Straight to persistence, no change event: `a` completed and `b` reopened.
			const data = h.store.data;
			const done: Task = { ...data.tasks.get(a)!, status: "completed", completedAt: "2026-10-01T09:00:00.000Z" };
			const reopened: Task = { ...data.tasks.get(b)!, status: "open", completedAt: null };
			const ops: JournalOp[] = [
				{ c: "tasks", id: a, v: done },
				{ c: "tasks", id: b, v: reopened },
			];
			h.store.commit({ ...data, tasks: new Map(data.tasks).set(a, done).set(b, reopened) }, ops);
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
});
