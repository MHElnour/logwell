// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CalMount, byLabel, cal, cell, click, entries, entry, entryName, mountCal, openCalendar, settle } from "./m3-helpers";
import { q } from "./m7-helpers";

// Repeating tasks on the calendar. The clock is Thursday 2026-10-01,
// so the visible week is Mon 2026-09-28 to Sun 2026-10-04. "Weekly review" repeats every Friday from 2026-10-02.

const mounted: CalMount[] = [];
afterEach(() => {
	vi.useRealTimers();
	for (const m of mounted.splice(0)) m.unmount();
});
async function mount() {
	const m = await mountCal();
	mounted.push(m);
	return m;
}

const rule = { freq: "weekly", interval: 1, weekdays: null, monthly: null, afterCompletion: false, time: null, tz: null } as const;
const timedRule = { ...rule, time: "09:00", tz: "Europe/Berlin" } as const;

async function seed(m: CalMount, r: typeof rule | typeof timedRule = rule) {
	const task = (await m.h.app.tasks.create({ title: "Weekly review", scheduled: { kind: "date", date: "2026-10-02" }, repeat: { rule: r } } as never)).task;
	await m.h.app.tasks.create({ title: "Dentist", scheduled: { kind: "date", date: "2026-10-01" } });
	await settle();
	return task;
}

const rect = (left: number, top: number, right: number, bottom: number) =>
	({ left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

function stubWeek(root: HTMLElement) {
	const w = cal(root);
	w.querySelectorAll<HTMLElement>(".cp-cal-daycol").forEach((c, i) => (c.getBoundingClientRect = () => rect(100 * i, 0, 100 * i + 100, 1152)));
	w.querySelectorAll<HTMLElement>(".cp-cal-allday-cell").forEach((c, i) => (c.getBoundingClientRect = () => rect(100 * i, -100, 100 * i + 100, -50)));
	const scroller = w.querySelector<HTMLElement>(".cp-cal-scroller");
	if (scroller !== null) scroller.getBoundingClientRect = () => rect(0, -1000, 700, 2000);
	const sticky = w.querySelector<HTMLElement>(".cp-cal-sticky");
	if (sticky !== null) sticky.getBoundingClientRect = () => rect(0, -1000, 700, -50);
}

function ptr(type: string, x: number, y: number): Event {
	const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
	Object.defineProperty(ev, "pointerId", { value: 1 });
	Object.defineProperty(ev, "pointerType", { value: "mouse" });
	return ev;
}

async function drag(el: Element, from: { x: number; y: number }, to: { x: number; y: number }) {
	el.dispatchEvent(ptr("pointerdown", from.x, from.y));
	el.dispatchEvent(ptr("pointermove", from.x + 6, from.y + 6));
	el.dispatchEvent(ptr("pointermove", to.x, to.y));
	await settle();
	el.dispatchEvent(ptr("pointerup", to.x, to.y));
	await settle();
}

const classes = (el: Element) => [...el.classList];

describe("week view", () => {
	it("draws the current occurrence solid with the repeat icon before the title, and says it repeats", async () => {
		const m = await mount();
		await seed(m);
		await openCalendar(m);
		const e = entry(cal(m.root), "Weekly review");
		expect(classes(e)).toContain("is-repeat");
		expect(classes(e)).not.toContain("is-future");
		expect(entryName(e)).toBe("Weekly review, Fri Oct 2, all day, repeats");
		const body = e.querySelector(".cp-cal-entry-body")!;
		expect(body.firstElementChild?.classList.contains("cp-cal-repeat")).toBe(true);
		expect(body.querySelector('.cp-cal-repeat[data-icon="repeat"]')).not.toBeNull();
		// A task that does not repeat has no icon and no repeat class.
		const plain = entry(cal(m.root), "Dentist");
		expect(classes(plain)).not.toContain("is-repeat");
		expect(plain.querySelector(".cp-cal-repeat")).toBeNull();
	});

	it("draws the next weeks' occurrences faded with a dashed edge (is-future) and names them", async () => {
		const m = await mount();
		await seed(m);
		await openCalendar(m);
		await click(byLabel(cal(m.root), "Next week"));
		const e = entry(cal(m.root), "Weekly review");
		expect(classes(e)).toContain("is-future");
		expect(classes(e)).toContain("is-repeat");
		expect(entryName(e)).toBe("Weekly review, Fri Oct 9, all day, repeats, future occurrence");
	});

	it("a done occurrence is struck through like a completed task", async () => {
		const m = await mount();
		const t = await seed(m);
		await m.h.app.recurrence.complete(t.id);
		await openCalendar(m);
		const done = entry(cal(m.root), "Weekly review");
		expect(classes(done)).toContain("is-completed");
		expect(classes(done)).not.toContain("is-future");
		expect(entryName(done)).toContain("completed");
		await click(byLabel(cal(m.root), "Next week"));
		// The new current occurrence (Oct 9) is solid.
		expect(classes(entry(cal(m.root), "Weekly review"))).not.toContain("is-future");
	});

	it("a timed series draws blocks with the icon too, and they cannot be resized or moved", async () => {
		const m = await mount();
		await seed(m, timedRule);
		await openCalendar(m);
		stubWeek(m.root);
		const block = entry(cal(m.root), "Weekly review", ".cp-cal-daycol");
		expect(classes(block)).toContain("is-block");
		expect(classes(block)).toContain("is-repeat");
		expect(block.querySelector(".cp-cal-repeat")).not.toBeNull();
		expect(block.querySelector(".cp-cal-resize")).toBeNull();
	});
});

describe("no drag (decision 5)", () => {
	it("pressing and dragging an all-day occurrence changes nothing and starts no drag", async () => {
		const m = await mount();
		const t = await seed(m);
		await openCalendar(m);
		stubWeek(m.root);
		const before = JSON.stringify(m.h.app.store.state.tasks.get(t.id));
		const notices: string[] = [];
		Object.assign(m.host, {
			notifyUndo: (msg: string, label: string, mark: number) => {
				notices.push(msg);
				m.host.bindUndo(label, mark);
			},
		});
		const e = entry(cal(m.root), "Weekly review");
		await drag(e, { x: 450, y: -75 }, { x: 50, y: -75 });
		expect(cal(m.root).classList.contains("is-dragging")).toBe(false);
		expect(e.classList.contains("is-dragging")).toBe(false);
		expect(cal(m.root).querySelector(".cp-cal-ghost")).toBeNull();
		expect(JSON.stringify(m.h.app.store.state.tasks.get(t.id))).toBe(before);
		expect(notices).toEqual([]);
	});

	it("a timed occurrence is not moved either", async () => {
		const m = await mount();
		const t = await seed(m, timedRule);
		await openCalendar(m);
		stubWeek(m.root);
		const before = JSON.stringify(m.h.app.store.state.tasks.get(t.id));
		const block = entry(cal(m.root), "Weekly review", ".cp-cal-daycol");
		await drag(block, { x: 450, y: 450 }, { x: 150, y: 600 });
		expect(cal(m.root).classList.contains("is-dragging")).toBe(false);
		expect(JSON.stringify(m.h.app.store.state.tasks.get(t.id))).toBe(before);
	});

	it("a plain task still moves (the guard is only for series)", async () => {
		const m = await mount();
		await seed(m);
		await openCalendar(m);
		stubWeek(m.root);
		const e = entry(cal(m.root), "Dentist");
		await drag(e, { x: 350, y: -75 }, { x: 50, y: -75 });
		const dentist = [...m.h.app.store.state.tasks.values()].find((t) => t.title === "Dentist")!;
		expect(dentist.scheduled).toEqual({ kind: "date", date: "2026-09-28" });
	});

	it("opens the details pane on a click, as for any task", async () => {
		const m = await mount();
		await seed(m);
		await openCalendar(m);
		await click(entry(cal(m.root), "Weekly review"));
		const pane = q(cal(m.root), ".cp-details");
		expect(pane.querySelector(".cp-due-chip")?.textContent).toContain("Tomorrow · every Fri");
	});
});

describe("month view", () => {
	it("shows every Friday: the first solid, the later ones faded; a week click shows them again", async () => {
		const m = await mount();
		await seed(m);
		await openCalendar(m);
		await click([...cal(m.root).querySelectorAll<HTMLButtonElement>(".cp-cal-mode button")].find((b) => b.textContent?.trim() === "Month"));
		const on = (date: string) => entries(cell(cal(m.root), "cell", date), "Weekly review");
		expect(on("2026-10-02")).toHaveLength(1);
		expect(classes(on("2026-10-02")[0]!)).not.toContain("is-future");
		for (const date of ["2026-10-09", "2026-10-16", "2026-10-23", "2026-10-30"]) {
			expect(on(date), date).toHaveLength(1);
			expect(classes(on(date)[0]!), date).toContain("is-future");
		}
		expect(on("2026-10-03")).toHaveLength(0);
		expect(on("2026-10-09")[0]!.querySelector(".cp-cal-repeat")).not.toBeNull();
	});
});

describe("the Unscheduled drawer", () => {
	it("lists open tasks without a date and never a repeating task", async () => {
		const m = await mount();
		await seed(m);
		await m.h.app.tasks.create({ title: "Someday" });
		await openCalendar(m);
		await click(cal(m.root).querySelector(".cp-cal-unscheduled-toggle, [aria-label='Unscheduled']"));
		const rows = [...cal(m.root).querySelectorAll(".cp-cal-unscheduled .cp-task-row .cp-task-title")].map((r) => r.textContent.trim());
		expect(rows).toEqual(["Someday"]);
	});
});
