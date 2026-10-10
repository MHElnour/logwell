// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import * as views from "../../src/app/views";
import { type CalMount, mountCal, settle } from "./m3-helpers";

// Completing a task renders the Tasks section once (the row is held among the open
// rows in that same pass), then once more when the 450 ms hold ends. Fake timers drive the hold, so this
// lives in its own file: faked timers leave Preact's effect scheduling in a state the next test in the same
// worker would inherit.

vi.mock("../../src/app/views", async (importActual) => {
	const actual = await importActual<typeof import("../../src/app/views")>();
	return { ...actual, buildView: vi.fn(actual.buildView) };
});

const mounted: CalMount[] = [];
afterEach(() => {
	vi.useRealTimers();
	for (const m of mounted.splice(0)) m.unmount();
});

const builds = () => vi.mocked(views.buildView).mock.calls.length;
const rows = (m: CalMount) => [...m.root.querySelectorAll<HTMLElement>(".cp-tasks .cp-task-row")];

describe("render passes with the hold on a completed row", () => {
	it("completing a task renders the Tasks section once, then once more when the hold ends", async () => {
		const m = await mountCal();
		mounted.push(m);
		const ids: string[] = [];
		for (const title of ["A", "B"]) ids.push((await m.h.app.tasks.create({ title, scheduled: { kind: "date", date: "2026-10-01" } })).task.id);
		await settle();
		await new Promise((r) => setTimeout(r, 120));
		vi.useFakeTimers();
		const b0 = builds();
		await m.h.app.tasks.complete(ids[0]!);
		for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(150);
		// The completed row is held among the open rows in the same pass.
		expect(builds() - b0).toBe(1);
		expect(rows(m)).toHaveLength(2);
		expect(rows(m).filter((r) => r.classList.contains("is-completed"))).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(450);
		expect(builds() - b0).toBe(2);
		expect(rows(m)).toHaveLength(1);
	});
});
