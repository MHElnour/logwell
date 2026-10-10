// @vitest-environment happy-dom
import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ID, Task } from "../../src/domain/types";
import { LINGER_MS, useLingering } from "../../src/ui/useLingering";

// The hold on a just-completed row. Fake timers drive the 450 ms.

const task = (status: Task["status"]): Task => ({ id: "a", title: "A", status }) as Task;
const tasks = (status: Task["status"]): ReadonlyMap<ID, Task> => new Map([["a", task(status)]]);

let host: HTMLElement;
let held: ReadonlySet<ID> = new Set();
function Probe(props: { tasks: ReadonlyMap<ID, Task>; active: boolean }) {
	held = useLingering(props.tasks, props.active);
	return null;
}
const draw = async (t: ReadonlyMap<ID, Task>, active = true) => {
	render(<Probe tasks={t} active={active} />, host);
	await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => {
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

describe("useLingering", () => {
	it("holds a task completed while shown for exactly 450 ms", async () => {
		await draw(tasks("open"));
		await draw(tasks("completed"));
		expect(held.has("a")).toBe(true);
		await vi.advanceTimersByTimeAsync(LINGER_MS - 1);
		expect(held.has("a")).toBe(true);
		await vi.advanceTimersByTimeAsync(1);
		expect(held.has("a")).toBe(false);
	});

	it("complete, reopen, complete keeps the full 450 ms from the second completion", async () => {
		await draw(tasks("open"));
		await draw(tasks("completed"));
		await vi.advanceTimersByTimeAsync(100);
		await draw(tasks("open"));
		expect(held.has("a")).toBe(false);
		await vi.advanceTimersByTimeAsync(100);
		await draw(tasks("completed"));
		expect(held.has("a")).toBe(true);
		// Past the first timer (450 ms after the first completion): still held.
		await vi.advanceTimersByTimeAsync(LINGER_MS - 1);
		expect(held.has("a")).toBe(true);
		await vi.advanceTimersByTimeAsync(1);
		expect(held.has("a")).toBe(false);
	});

	it("a reopened task is not held, and its timer is gone", async () => {
		await draw(tasks("open"));
		await draw(tasks("completed"));
		await draw(tasks("open"));
		expect(held.has("a")).toBe(false);
		// Preact's own effect flush (rAF and a 100 ms fallback) is done by then; the 450 ms timer is not due.
		await vi.advanceTimersByTimeAsync(200);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("a section that becomes shown only takes a baseline", async () => {
		await draw(tasks("open"), false);
		await draw(tasks("completed"), false);
		await draw(tasks("completed"), true);
		expect(held.size).toBe(0);
	});

	it("unmounting leaves no pending timer", async () => {
		await draw(tasks("open"));
		await draw(tasks("completed"));
		expect(vi.getTimerCount()).toBeGreaterThan(0);
		render(null, host);
		await vi.advanceTimersByTimeAsync(200);
		expect(vi.getTimerCount()).toBe(0);
	});
});
