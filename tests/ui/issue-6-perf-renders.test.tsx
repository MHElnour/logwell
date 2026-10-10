// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { syncLinkId } from "../../src/domain/types";
import * as format from "../../src/ui/format";
import { type CalMount, mountCal, settle } from "./m3-helpers";

// Performance: the "Not synced" chip reads links, and a write to links must redraw only the rows whose own
// link (or whose list's link) changed, never every row.

vi.mock("../../src/ui/format", async (importActual) => {
	const actual = await importActual<typeof import("../../src/ui/format")>();
	return { ...actual, rowDateText: vi.fn(actual.rowDateText) };
});

const mounted: CalMount[] = [];
afterEach(() => {
	for (const m of mounted.splice(0)) m.unmount();
});
const rowRenders = () => vi.mocked(format.rowDateText).mock.calls.length;
const flush = async () => {
	await settle();
	await new Promise((r) => setTimeout(r, 120));
	await settle();
};

describe("rows and links", () => {
	it("a link write redraws only the row of that task, and a link of a task not shown redraws none", async () => {
		const m = await mountCal();
		mounted.push(m);
		const ids: string[] = [];
		for (const title of ["A", "B", "C"]) ids.push((await m.h.app.tasks.create({ title, scheduled: { kind: "date", date: "2026-10-01" } })).task.id);
		const inboxLink = { kind: "list" as const, logwellId: "inbox", ttId: "p", ttProjectId: null, etag: null, base: {}, noteBySync: false, lastPulledAt: null, modifiedAt: "x" };
		const put = (link: typeof inboxLink | (Omit<typeof inboxLink, "kind"> & { kind: "task"; mode: "localOnly" })) =>
			m.h.app.store.run("test links", (tx) => void tx.put("syncLinks", link), { undoable: false });
		await put(inboxLink);
		await flush();
		const rows = () => [...m.root.querySelectorAll<HTMLElement>(".cp-tasks .cp-task-row")];
		expect(rows()).toHaveLength(3);
		const r0 = rowRenders();
		await put({ ...inboxLink, kind: "task", logwellId: ids[1]!, ttId: "t", mode: "localOnly" });
		await flush();
		expect(rowRenders() - r0).toBe(1);
		expect(rows().filter((r) => r.querySelector(".cp-meta-notsynced") !== null)).toHaveLength(1);
		const r1 = rowRenders();
		await put({ ...inboxLink, kind: "task", logwellId: "00000000-0000-4000-8000-0000000000ff", ttId: "u", mode: "localOnly" });
		await flush();
		expect(rowRenders() - r1).toBe(0);
		expect(m.h.app.store.state.syncLinks.has(syncLinkId("task", ids[1]!))).toBe(true);
		// A sync rewrites the list's link and the tasks' links without changing what the chip shows: no row is redrawn.
		const r2 = rowRenders();
		await put({ ...inboxLink, modifiedAt: "y" });
		await put({ ...inboxLink, kind: "task", logwellId: ids[0]!, ttId: "a" } as never);
		await put({ ...inboxLink, kind: "task", logwellId: ids[1]!, ttId: "t", mode: "localOnly", modifiedAt: "z" });
		await flush();
		expect(rowRenders() - r2).toBe(0);
	});
});
