// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import * as views from "../../src/app/views";
import { type CalMount, click, mountCal, settle } from "./m3-helpers";

// The Tasks section builds its rows and its Completed group (one `buildList`) only when their inputs change:
// selecting a row, which only moves `selectedId`, must not rebuild them.

vi.mock("../../src/app/views", async (importActual) => {
	const actual = await importActual<typeof import("../../src/app/views")>();
	return { ...actual, buildList: vi.fn(actual.buildList) };
});

const mounted: CalMount[] = [];
afterEach(() => {
	for (const m of mounted.splice(0)) m.unmount();
});

describe("Tasks section memoization", () => {
	it("does not rebuild the rows or the Completed group when only the selection changes", async () => {
		const m = await mountCal();
		mounted.push(m);
		await m.h.app.tasks.create({ title: "Ship it", scheduled: { kind: "date", date: "2026-10-01" } });
		await settle();
		const build = vi.mocked(views.buildList);
		const row = m.root.querySelector<HTMLElement>(".cp-tasks .cp-task-row .cp-task-title")!;
		expect(row.textContent.trim()).toBe("Ship it");
		const before = build.mock.calls.length;
		expect(before).toBeGreaterThan(0);
		await click(row);
		expect(m.root.querySelector(".cp-details-pane")).not.toBeNull();
		expect(build.mock.calls.length).toBe(before);
	});
});
