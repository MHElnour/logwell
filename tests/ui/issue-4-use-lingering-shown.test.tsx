// @vitest-environment happy-dom
import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ListEntry } from "../../src/domain/queries";
import type { ID, Task } from "../../src/domain/types";
import { LINGER_MS, useLingeringShown } from "../../src/ui/useLingering";

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
	host = document.createElement("div");
	document.body.append(host);
	held = new Set();
	win = window;
});
afterEach(() => {
	render(null, host);
	host.remove();
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
