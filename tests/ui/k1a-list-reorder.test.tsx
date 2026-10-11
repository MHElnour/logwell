// @vitest-environment happy-dom
import { render } from "preact";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildList } from "../../src/app/views";
import { type TaskSort, emptyFilter } from "../../src/domain/queries";
import type { Task } from "../../src/domain/types";
import { TaskList } from "../../src/ui/TaskList";
import { type AppHarness, appHarness } from "../app/harness";
import { dragTo, press, releaseAt, settle } from "./m4-helpers";
import { U1Host } from "./u1-helpers";

// Dragging list rows to reorder them (manual sort only). happy-dom has no layout, so every
// row gets a fake 40 px high box in DOM order and the list a 500 px wide one.

beforeAll(() => {
	// Obsidian's DOM helper, which happy-dom does not have.
	(HTMLElement.prototype as unknown as { createDiv: (o: { cls: string }) => HTMLElement }).createDiv = function (this: HTMLElement, o) {
		const el = this.ownerDocument.createElement("div");
		el.className = o.cls;
		this.appendChild(el);
		return el;
	};
	(HTMLElement.prototype as unknown as { empty: () => void }).empty = function (this: HTMLElement) {
		this.replaceChildren();
	};
});

const containers: HTMLElement[] = [];
afterEach(() => {
	for (const c of containers.splice(0)) {
		render(null, c);
		c.remove();
	}
});

const rect = (left: number, top: number, right: number, bottom: number) =>
	({ left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

interface Mount {
	h: AppHarness;
	host: U1Host;
	root: HTMLElement;
	undo: ReturnType<typeof vi.spyOn>;
	redraw: (sort: TaskSort | undefined) => Promise<void>;
}

async function mount(sort: TaskSort | undefined = "manual"): Promise<Mount> {
	const h = await appHarness();
	const host = new U1Host(h);
	const undo = vi.spyOn(host, "notifyUndo");
	const root = document.createElement("div");
	document.body.appendChild(root);
	containers.push(root);
	const redraw = async (s: TaskSort | undefined) => {
		const state = h.app.store.state;
		const ctx = h.app.queryContext();
		const filter = { ...emptyFilter("all"), sort: s ?? "manual" };
		const groups = buildList(state, { kind: "inbox" }, ctx, filter, "").groups;
		render(
			<TaskList host={host} state={state} groups={groups} ctx={ctx} selectedId={null} showCategory={false} emptyText="" label="Inbox" sort={s} onSelect={() => undefined} />,
			root,
		);
		await settle();
		const list = root.querySelector<HTMLElement>(".cp-task-list");
		if (list === null) return;
		list.getBoundingClientRect = () => rect(0, 0, 500, 1000);
		root.querySelectorAll<HTMLElement>(".cp-task-row").forEach((r, i) => (r.getBoundingClientRect = () => rect(0, 40 * i, 500, 40 * i + 40)));
	};
	await redraw(sort);
	return { h, host, root, undo, redraw };
}

const titles = (m: Mount) => [...m.root.querySelectorAll(".cp-task-row .cp-task-title")].map((t) => t.textContent.trim());
const row = (m: Mount, text: string) =>
	[...m.root.querySelectorAll<HTMLElement>(".cp-task-row")].find((r) => r.querySelector(".cp-task-title")!.textContent.includes(text))!;
const task = (m: Mount, title: string): Task => [...m.h.app.store.state.tasks.values()].find((t) => t.title === title)!;
const centerY = (i: number) => 40 * i + 20;
const X = 100;

async function seedFlat(m: Mount, names = ["A", "B", "C", "D"]) {
	for (const n of names) await m.h.app.tasks.create({ title: n });
	await m.redraw("manual");
}

/** The order after the store changed, as the app would re-render it. */
const reordered = async (m: Mount) => {
	await m.redraw("manual");
	return titles(m);
};

describe("list row reorder (D5)", () => {
	it("starts with the stored order", async () => {
		const m = await mount();
		await seedFlat(m);
		expect(titles(m)).toEqual(["A", "B", "C", "D"]);
	});

	it("drops a row at the top", async () => {
		const m = await mount();
		await seedFlat(m);
		const id = task(m, "C").id;
		await dragTo(row(m, "C"), { x: X, y: centerY(2) }, { x: X, y: 2 });
		expect(task(m, "C").id).toBe(id);
		expect(await reordered(m)).toEqual(["C", "A", "B", "D"]);
		expect(m.undo).toHaveBeenCalledWith('Moved "C".', "Move task", expect.any(Number));
		expect(await m.h.app.store.undo()).toBe("Move task");
		expect(await reordered(m)).toEqual(["A", "B", "C", "D"]);
	});

	it("drops a row in the middle, in one write", async () => {
		const m = await mount();
		await seedFlat(m);
		const place = vi.spyOn(m.h.app.tasks, "place");
		// Row A dragged below B's middle (y 60) lands between B and C.
		await dragTo(row(m, "A"), { x: X, y: centerY(0) }, { x: X, y: 62 });
		expect(place).toHaveBeenCalledTimes(1);
		expect(place.mock.calls[0]![1]).toEqual([task(m, "B").id, task(m, "A").id, task(m, "C").id, task(m, "D").id]);
		expect(await reordered(m)).toEqual(["B", "A", "C", "D"]);
	});

	it("drops a row at the bottom, also when released below the list", async () => {
		const m = await mount();
		await seedFlat(m);
		await dragTo(row(m, "B"), { x: X, y: centerY(1) }, { x: X, y: 400 });
		expect(await reordered(m)).toEqual(["A", "C", "D", "B"]);
	});

	it("shows a drop line while dragging and removes it afterwards", async () => {
		const m = await mount();
		await seedFlat(m);
		await dragTo(row(m, "A"), { x: X, y: centerY(0) }, { x: X, y: 62 }, false);
		const list = m.root.querySelector(".cp-task-list")!;
		const line = list.querySelector<HTMLElement>(".cp-reorder-line")!;
		expect(line.hidden).toBe(false);
		expect(line.style.top).toBe("80px");
		expect(row(m, "A").classList.contains("is-dragging")).toBe(true);
		await releaseAt(row(m, "A"), { x: X, y: 62 });
		expect(list.querySelector(".cp-reorder-line")).toBeNull();
		expect(list.classList.contains("is-reordering")).toBe(false);
	});

	it("a drop where the row already is writes nothing and offers no Undo", async () => {
		const m = await mount();
		await seedFlat(m);
		const place = vi.spyOn(m.h.app.tasks, "place");
		await dragTo(row(m, "B"), { x: X, y: centerY(1) }, { x: X, y: centerY(1) + 6 });
		expect(place).not.toHaveBeenCalled();
		expect(m.undo).not.toHaveBeenCalled();
	});

	it("does not drag under By date or By priority, or without a sort", async () => {
		for (const sort of ["date", "priority", undefined] as const) {
			const m = await mount(sort);
			for (const n of ["A", "B", "C"]) await m.h.app.tasks.create({ title: n });
			await m.redraw(sort);
			const place = vi.spyOn(m.h.app.tasks, "place");
			await dragTo(row(m, "C"), { x: X, y: centerY(2) }, { x: X, y: 2 });
			expect(place).not.toHaveBeenCalled();
			expect(m.root.querySelector(".cp-reorder-line")).toBeNull();
			expect(row(m, "C").classList.contains("is-dragging")).toBe(false);
		}
	});

	it("keeps a subtask among its siblings, and a top-level row moves with its subtasks", async () => {
		const m = await mount();
		const P = await m.h.app.tasks.create({ title: "P" });
		await m.h.app.tasks.create({ title: "S1", parentId: P.task.id });
		await m.h.app.tasks.create({ title: "S2", parentId: P.task.id });
		await m.h.app.tasks.create({ title: "Q" });
		await m.redraw("manual");
		expect(titles(m)).toEqual(["P", "S1", "S2", "Q"]);
		// S1 dragged far down only goes below S2, never out of P.
		const place = vi.spyOn(m.h.app.tasks, "place");
		await dragTo(row(m, "S1"), { x: X, y: centerY(1) }, { x: X, y: 900 });
		expect(place.mock.calls[0]![1]).toEqual([task(m, "S2").id, task(m, "S1").id]);
		expect(await reordered(m)).toEqual(["P", "S2", "S1", "Q"]);
		// P dragged below Q takes S2 and S1 along.
		await dragTo(row(m, "P"), { x: X, y: centerY(0) }, { x: X, y: 900 });
		expect(place.mock.calls[1]![1]).toEqual([task(m, "Q").id, task(m, "P").id]);
		expect(await reordered(m)).toEqual(["Q", "P", "S2", "S1"]);
	});

	it("a subtask alone under its parent has nothing to reorder: the press is a click", async () => {
		const m = await mount();
		const P = await m.h.app.tasks.create({ title: "P" });
		await m.h.app.tasks.create({ title: "S1", parentId: P.task.id });
		await m.h.app.tasks.create({ title: "Q" });
		await m.redraw("manual");
		const place = vi.spyOn(m.h.app.tasks, "place");
		await dragTo(row(m, "S1"), { x: X, y: centerY(1) }, { x: X, y: 900 });
		expect(place).not.toHaveBeenCalled();
	});

	it("Escape cancels: nothing is written and the line goes away", async () => {
		const m = await mount();
		await seedFlat(m);
		const place = vi.spyOn(m.h.app.tasks, "place");
		const r = row(m, "C");
		await dragTo(r, { x: X, y: centerY(2) }, { x: X, y: 2 }, false);
		expect(m.root.querySelector(".cp-reorder-line")).not.toBeNull();
		await press(window as unknown as Element, "Escape");
		expect(m.root.querySelector(".cp-reorder-line")).toBeNull();
		await releaseAt(r, { x: X, y: 2 });
		expect(place).not.toHaveBeenCalled();
		expect(titles(m)).toEqual(["A", "B", "C", "D"]);
	});

	it("a press that does not pass the threshold is still a click", async () => {
		const m = await mount();
		await seedFlat(m);
		const onSelect = vi.fn();
		const state = m.h.app.store.state;
		const ctx = m.h.app.queryContext();
		const groups = buildList(state, { kind: "inbox" }, ctx, { ...emptyFilter("all"), sort: "manual" }, "").groups;
		render(
			<TaskList host={m.host} state={state} groups={groups} ctx={ctx} selectedId={null} showCategory={false} emptyText="" label="Inbox" sort="manual" onSelect={onSelect} />,
			m.root,
		);
		await settle();
		const r = row(m, "B");
		r.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(onSelect).toHaveBeenCalledTimes(1);
	});

	it("the checkbox and buttons inside a row never start a drag", async () => {
		const m = await mount();
		await seedFlat(m);
		const place = vi.spyOn(m.h.app.tasks, "place");
		const box = row(m, "C").querySelector<HTMLElement>("input")!;
		await dragTo(box, { x: X, y: centerY(2) }, { x: X, y: 2 });
		expect(place).not.toHaveBeenCalled();
		expect(m.root.querySelector(".cp-reorder-line")).toBeNull();
	});

	it("a read-only list never reorders", async () => {
		const m = await mount();
		await seedFlat(m);
		const state = m.h.app.store.state;
		const ctx = m.h.app.queryContext();
		const groups = buildList(state, { kind: "inbox" }, ctx, { ...emptyFilter("all"), sort: "manual" }, "").groups;
		render(
			<TaskList host={m.host} state={state} groups={groups} ctx={ctx} selectedId={null} showCategory={false} emptyText="" label="Inbox" sort="manual" readOnly onSelect={() => undefined} />,
			m.root,
		);
		await settle();
		const place = vi.spyOn(m.h.app.tasks, "place");
		m.root.querySelector<HTMLElement>(".cp-task-list")!.getBoundingClientRect = () => rect(0, 0, 500, 1000);
		m.root.querySelectorAll<HTMLElement>(".cp-task-row").forEach((r, i) => (r.getBoundingClientRect = () => rect(0, 40 * i, 500, 40 * i + 40)));
		await dragTo(row(m, "C"), { x: X, y: centerY(2) }, { x: X, y: 2 });
		expect(place).not.toHaveBeenCalled();
	});
});
