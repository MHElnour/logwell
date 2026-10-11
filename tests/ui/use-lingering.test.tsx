// @vitest-environment happy-dom
import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ID } from "../../src/domain/types";
import { LINGER_MS, useLingering } from "../../src/ui/useLingering";
import { type AppHarness, appHarness } from "../app/harness";

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
