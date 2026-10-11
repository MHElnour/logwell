// @vitest-environment happy-dom
import { render } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as views from "../../src/app/views";
import * as format from "../../src/ui/format";
import { useFocus } from "../../src/ui/hooks";
import { type CalMount, click, mountCal, settle } from "./m3-helpers";

// One change re-renders the Tasks section once, and a row whose own inputs did not
// change is not re-rendered. The counters wrap the pure functions the renders call: buildList (once per
// Tasks section render that rebuilds its rows), globalSearch (once per Search section render) and the
// format helper TaskRow calls on every render of a dated row.

vi.mock("../../src/app/views", async (importActual) => {
	const actual = await importActual<typeof import("../../src/app/views")>();
	return { ...actual, buildList: vi.fn(actual.buildList), globalSearch: vi.fn(actual.globalSearch) };
});
vi.mock("../../src/ui/format", async (importActual) => {
	const actual = await importActual<typeof import("../../src/ui/format")>();
	return { ...actual, rowDateText: vi.fn(actual.rowDateText) };
});

const mounted: CalMount[] = [];
afterEach(() => {
	for (const m of mounted.splice(0)) m.unmount();
});

const builds = () => vi.mocked(views.buildList).mock.calls.length;
const searches = () => vi.mocked(views.globalSearch).mock.calls.length;
const rowRenders = () => vi.mocked(format.rowDateText).mock.calls.length;

async function mountWithTasks(titles: string[]): Promise<{ m: CalMount; ids: string[] }> {
	const m = await mountCal();
	mounted.push(m);
	const ids: string[] = [];
	for (const title of titles) ids.push((await m.h.app.tasks.create({ title, scheduled: { kind: "date", date: "2026-10-01" } })).task.id);
	await flush();
	return { m, ids };
}

/** settle() plus time for Preact's passive effects (it runs them after a frame or 100 ms). */
const flush = async () => {
	await settle();
	await new Promise((r) => setTimeout(r, 120));
	await settle();
};

const rows = (m: CalMount) => [...m.root.querySelectorAll<HTMLElement>(".cp-tasks .cp-task-row")];

describe("render passes", () => {
	it("one edit renders the Tasks section once and only the changed row", async () => {
		const { m, ids } = await mountWithTasks(["A", "B", "C"]);
		expect(rows(m)).toHaveLength(3);
		const [b0, r0, s0] = [builds(), rowRenders(), searches()];
		await m.h.app.tasks.update(ids[1]!, { title: "B edited" });
		await flush();
		expect(rows(m).map((r) => r.querySelector(".cp-task-title")!.textContent.trim())).toContain("B edited");
		expect(builds() - b0).toBe(1);
		expect(rowRenders() - r0).toBe(1);
		// The Search section is mounted but hidden: it searches nothing for the change (issue 41).
		expect(searches() - s0).toBe(0);
	});

	it("Search reads the titles once per change while shown, and not again on a render without a change (issue 41)", async () => {
		const { m, ids } = await mountWithTasks(["Call the bank", "Buy milk", "Call mom"]);
		await click(m.root.querySelector('.cp-rail [aria-label="Search"]'));
		const box = m.root.querySelector<HTMLInputElement>('.cp-search-box input[type="search"]')!;
		box.value = "call";
		box.dispatchEvent(new Event("input", { bubbles: true }));
		await flush();
		const results = () => [...m.root.querySelectorAll<HTMLElement>(".cp-search .cp-task-row")];
		expect(results()).toHaveLength(2);
		const s0 = searches();
		await m.h.app.tasks.update(ids[1]!, { title: "Call the plumber" });
		await flush();
		expect(results()).toHaveLength(3);
		expect(searches() - s0).toBe(1);
		// Selecting a result renders the section again; the tasks, query and filter are the same, so no search runs.
		const s1 = searches();
		await click(results()[0]);
		expect(m.root.querySelector(".cp-details-pane")).not.toBeNull();
		expect(searches() - s1).toBe(0);
	});

	it("selecting a row re-renders only the row that was selected", async () => {
		const { m } = await mountWithTasks(["A", "B", "C"]);
		const r0 = rowRenders();
		await click(rows(m)[1]);
		expect(m.root.querySelector(".cp-details-pane")).not.toBeNull();
		expect(rowRenders() - r0).toBe(1);
		const r1 = rowRenders();
		await click(rows(m)[2]);
		// The row that lost the selection and the row that gained it.
		expect(rowRenders() - r1).toBe(2);
	});

	it("showing Today when Today is already shown renders nothing", async () => {
		const { m } = await mountWithTasks(["A", "B", "C"]);
		const [b0, r0] = [builds(), rowRenders()];
		m.handle.current!.showSection("today");
		await settle();
		expect(builds() - b0).toBe(0);
		expect(rowRenders() - r0).toBe(0);
	});

	it("showing Today from another view still switches to Today", async () => {
		const { m } = await mountWithTasks(["A"]);
		await click(m.root.querySelector('.cp-rail [aria-label="Calendar"]'));
		m.handle.current!.showSection("today");
		await settle();
		const shown = [...m.root.querySelectorAll<HTMLElement>(".cp-section")].filter((s) => !s.hidden);
		expect(shown).toHaveLength(1);
		expect(shown[0]!.querySelector(".cp-tasks")).not.toBeNull();
		expect(shown[0]!.querySelector(".cp-main-title")!.textContent).toBe("Today");
	});
});

describe("rows follow everything they draw", () => {
	const meta = (m: CalMount, nth: number) => rows(m)[nth]!.querySelector(".cp-task-meta")!.textContent;

	it("a renamed list, a recolored tag and a subtask count reach the rows that show them", async () => {
		const m = await mountCal();
		mounted.push(m);
		const list = await m.h.app.categories.create("Errands");
		const tag = await m.h.app.tags.create("urgent");
		const parent = await m.h.app.tasks.create({ title: "Parent", categoryId: list.id, tagKeys: [tag.key], scheduled: { kind: "date", date: "2026-10-01" } });
		await m.h.app.tasks.create({ title: "Sub 1", parentId: parent.task.id, scheduled: { kind: "date", date: "2026-10-01" } });
		const sub2 = await m.h.app.tasks.create({ title: "Sub 2", parentId: parent.task.id, scheduled: { kind: "date", date: "2026-10-01" } });
		await flush();
		const parentRow = () => rows(m).findIndex((r) => r.querySelector(".cp-task-title")!.textContent.trim() === "Parent");
		expect(meta(m, parentRow())).toContain("Errands");
		expect(meta(m, parentRow())).toContain("0/2");
		await m.h.app.categories.update(list.id, { name: "Chores" });
		await flush();
		expect(meta(m, parentRow())).toContain("Chores");
		await m.h.app.tasks.complete(sub2.task.id);
		await flush();
		expect(meta(m, parentRow())).toContain("1/2");
		const pill = () => rows(m)[parentRow()]!.querySelector(".cp-tag-pill")!;
		const before = pill().className;
		await m.h.app.tags.setColor(tag.key, "purple");
		await flush();
		expect(pill().className).not.toBe(before);
	});

	it("the sidebar counts and the Upcoming list follow a change of the week start", async () => {
		const m = await mountCal();
		mounted.push(m);
		let weekStart = "MO";
		(m.h.app as unknown as { settings: { weekStart: () => string } }).settings.weekStart = () => weekStart;
		// Every second Monday, anchored on Sunday 2026-10-04 and without a week start of its own.
		const rule = { freq: "weekly", interval: 2, weekdays: ["MO"], monthly: null, afterCompletion: false, time: null, tz: null };
		const t = (await m.h.app.tasks.create({ title: "Biweekly", scheduled: { kind: "date", date: "2026-10-04" }, repeat: { rule } } as never)).task;
		// The service stamps the setting on a new rule; drop it, so the setting decides the weeks (an older rule has none).
		for (const v of m.h.app.store.state.tasks.get(t.id)!.recurrence!.versions) delete (v.rule as { weekStart?: string }).weekStart;
		await m.h.app.tasks.complete(t.id);
		await m.rerender();
		await flush();
		const upcoming = () => {
			const item = [...m.root.querySelectorAll<HTMLElement>(".cp-sidebar-item")].find((i) => i.textContent.includes("Upcoming"))!;
			return item.querySelector(".cp-count")?.textContent ?? "0";
		};
		// Monday weeks: the next one is 2026-10-12, beyond the upcoming range.
		expect(upcoming()).toBe("0");
		weekStart = "SU";
		await m.rerender();
		await flush();
		// Sunday weeks: 2026-10-05 is in the week of the anchor.
		expect(upcoming()).toBe("1");
	});

	it("a task's focused time reaches its row without the task record changing", async () => {
		const { m, ids } = await mountWithTasks(["A", "B"]);
		const session = (minutes: number) => ({
			id: "s1",
			deviceId: "d",
			taskId: ids[0]!,
			taskTitleSnapshot: "A",
			plannedSec: 1500,
			status: "completed" as const,
			segments: [{ start: "2026-10-01T08:00:00.000Z", end: new Date(Date.parse("2026-10-01T08:00:00.000Z") + minutes * 60_000).toISOString() }],
			unobserved: [],
			splitFrom: null,
			startedAt: "2026-10-01T08:00:00.000Z",
			endedAt: "2026-10-01T09:00:00.000Z",
			finalizedAt: "2026-10-01T09:00:00.000Z",
		});
		const task = m.h.app.store.state.tasks.get(ids[0]!);
		const focus = () => rows(m)[0]!.querySelector(".cp-meta-focus")?.textContent ?? "";
		expect(focus()).toBe("");
		await m.h.app.store.run("Edit focus record", (tx) => tx.put("focusSessions", session(25) as never));
		await flush();
		const first = focus();
		expect(first).toContain("25");
		await m.h.app.store.run("Edit focus record", (tx) => tx.put("focusSessions", session(50) as never));
		await flush();
		expect(focus()).toContain("50");
		expect(focus()).not.toBe(first);
		expect(m.h.app.store.state.tasks.get(ids[0]!)).toBe(task);
	});

	it("a repeating task's occurrence date follows the week start without the task record changing", async () => {
		const m = await mountCal();
		mounted.push(m);
		let weekStart = "MO";
		(m.h.app as unknown as { settings: { weekStart: () => string } }).settings.weekStart = () => weekStart;
		const rule = { freq: "weekly", interval: 2, weekdays: ["MO"], monthly: null, afterCompletion: false, time: null, tz: null };
		const t = (await m.h.app.tasks.create({ title: "Biweekly", scheduled: { kind: "date", date: "2026-10-04" }, repeat: { rule } } as never)).task;
		for (const v of m.h.app.store.state.tasks.get(t.id)!.recurrence!.versions) delete (v.rule as { weekStart?: string }).weekStart;
		await m.h.app.tasks.complete(t.id);
		await m.rerender();
		await flush();
		await click([...m.root.querySelectorAll<HTMLElement>(".cp-sidebar-item")].find((i) => i.textContent.includes("Inbox")));
		await flush();
		const task = m.h.app.store.state.tasks.get(t.id);
		const dateText = () => rows(m).find((r) => r.querySelector(".cp-task-title")!.textContent.includes("Biweekly"))!.querySelector(".cp-meta-date")!.textContent;
		const before = dateText();
		weekStart = "SU";
		await m.rerender();
		await flush();
		expect(dateText()).not.toBe(before);
		expect(m.h.app.store.state.tasks.get(t.id)).toBe(task);
	});

	it("the due date text follows a change of the display day", async () => {
		const { m } = await mountWithTasks(["A"]);
		const date = () => rows(m)[0]!.querySelector(".cp-meta-date")!.textContent;
		const before = date();
		expect(before).toBeTruthy();
		// A day later: the same task is now overdue and reads differently.
		m.h.clock.advance(2 * 86_400_000);
		await m.rerender();
		await flush();
		expect(date()).not.toBe(before);
	});
});

describe("board cards", () => {
	it("one edit re-renders only the changed card, and selecting a card re-renders the two it concerns", async () => {
		const { m, ids } = await mountWithTasks(["A", "B", "C"]);
		const board = [...m.root.querySelectorAll<HTMLElement>(".cp-tasks .cp-mode-button")].find((b) => b.textContent.includes("Board"))!;
		await click(board);
		await flush();
		const cards = () => [...m.root.querySelectorAll<HTMLElement>(".cp-tasks .cp-board-card")];
		expect(cards()).toHaveLength(3);
		const r0 = rowRenders();
		await m.h.app.tasks.update(ids[1]!, { title: "B edited" });
		await flush();
		expect(cards().map((c) => c.querySelector(".cp-board-title")!.textContent.trim())).toContain("B edited");
		expect(rowRenders() - r0).toBe(1);
		const r1 = rowRenders();
		await click(cards()[0]!.querySelector(".cp-board-item"));
		expect(rowRenders() - r1).toBe(1);
		const r2 = rowRenders();
		await click(cards()[2]!.querySelector(".cp-board-item"));
		expect(rowRenders() - r2).toBe(2);
	});

	it("a card shows a change of its nested subtask", async () => {
		const m = await mountCal();
		mounted.push(m);
		const parent = await m.h.app.tasks.create({ title: "Parent", scheduled: { kind: "date", date: "2026-10-01" } });
		const sub = await m.h.app.tasks.create({ title: "Sub", parentId: parent.task.id, scheduled: { kind: "date", date: "2026-10-01" } });
		await flush();
		const board = [...m.root.querySelectorAll<HTMLElement>(".cp-tasks .cp-mode-button")].find((b) => b.textContent.includes("Board"))!;
		await click(board);
		await flush();
		const subTitles = () => [...m.root.querySelectorAll<HTMLElement>(".cp-tasks .cp-board-subs .cp-board-title")].map((e) => e.textContent.trim());
		expect(subTitles()).toEqual(["Sub"]);
		await m.h.app.tasks.update(sub.task.id, { title: "Sub renamed" });
		await flush();
		expect(subTitles()).toEqual(["Sub renamed"]);
	});
});

describe("useFocus", () => {
	it("does not re-render on mount when the timer did not change", async () => {
		const m = await mountCal();
		mounted.push(m);
		const root = document.createElement("div");
		let renders = 0;
		function Probe() {
			useFocus(m.host, true);
			renders++;
			return <span />;
		}
		render(<Probe />, root);
		await flush();
		expect(renders).toBe(1);
		render(null, root);
	});

	it("still re-renders when the timer changed between the render and the subscription", async () => {
		const m = await mountCal();
		mounted.push(m);
		const root = document.createElement("div");
		let last: ReturnType<typeof useFocus> | null = null;
		function Probe() {
			last = useFocus(m.host, true);
			return <span />;
		}
		render(<Probe />, root);
		// Between the render and its effects: a timer starts.
		await m.h.app.focus.start({ rounds: 1, focusSec: 60, breakSec: 60, longBreakSec: 60 }, null);
		await flush();
		expect(last!.timer).not.toBeNull();
		await m.h.app.focus.stop();
		render(null, root);
	});
});
