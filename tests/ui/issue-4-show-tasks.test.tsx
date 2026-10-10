// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AppRootHandle } from "../../src/ui/AppRoot";
import { SectionRelay } from "../../src/ui/sectionRelay";
import { emptyFilter } from "../../src/domain/queries";
import { INBOX_ID } from "../../src/domain/types";
import { initialTasksState, revealInTasks } from "../../src/ui/TasksSection";
import { makeTask } from "../persistence/fixtures";
import { click, mountCal, type CalMount, settle } from "./m3-helpers";
import { sidebarItem } from "./k1a-helpers";
import { openViewMenu as openMenuAt, pickItem } from "./view-menu-helpers";

// A dashboard block opens a task, or the view that matches its filters, in the app. The request goes
// through the same relay as the section commands, so it also works on a tab that is not open yet.

beforeAll(() => {
	(HTMLElement.prototype as unknown as { createDiv: (o: { cls: string }) => HTMLElement }).createDiv = function (this: HTMLElement, o) {
		const el = this.ownerDocument.createElement("div");
		el.className = o.cls;
		this.appendChild(el);
		return el;
	};
});

const mounted: CalMount[] = [];
afterEach(() => {
	for (const m of mounted.splice(0)) m.unmount();
});

const rows = (m: CalMount) => [...m.root.querySelectorAll<HTMLElement>(".cp-tasks .cp-task-row")];
const selected = (m: CalMount) => rows(m).filter((r) => r.classList.contains("is-selected")).map((r) => r.querySelector(".cp-task-title")!.textContent.trim());
const visibleSection = (m: CalMount) => [...m.root.querySelectorAll<HTMLElement>(".cp-section")].filter((s) => !s.hidden);

describe("AppRootHandle.showTasks", () => {
	it("shows the view and selects the task, from any section", async () => {
		const m = await mountCal();
		mounted.push(m);
		const work = await m.h.app.categories.create("Work");
		await m.h.app.tasks.create({ title: "Other", categoryId: work.id });
		const a = (await m.h.app.tasks.create({ title: "Target", categoryId: work.id })).task;
		await click(m.root.querySelector('.cp-rail [aria-label="Calendar"]'));
		m.handle.current!.showTasks({ kind: "category", id: work.id }, a.id);
		await settle();
		expect(visibleSection(m)).toHaveLength(1);
		expect(visibleSection(m)[0]!.querySelector(".cp-tasks")).not.toBeNull();
		expect(selected(m)).toEqual(["Target"]);
		expect(m.root.querySelector(".cp-details-pane")).not.toBeNull();
	});

	it("shows a view without selecting anything when no task is given", async () => {
		const m = await mountCal();
		mounted.push(m);
		const work = await m.h.app.categories.create("Work");
		await m.h.app.tasks.create({ title: "Target", categoryId: work.id });
		m.handle.current!.showTasks({ kind: "category", id: work.id }, null);
		await settle();
		expect(rows(m).map((r) => r.querySelector(".cp-task-title")!.textContent.trim())).toEqual(["Target"]);
		expect(selected(m)).toEqual([]);
	});
});

describe("AppRootHandle.showTasks: nothing may hide the task that was asked for", () => {
	const search = (m: CalMount) => m.root.querySelector<HTMLInputElement>(".cp-tasks input[type=search]")!;
	const typeSearch = async (m: CalMount, text: string) => {
		const input = search(m);
		input.value = text;
		input.dispatchEvent(new Event("input", { bubbles: true }));
		await settle();
	};

	it("clears the search text, so a task the text did not match is shown", async () => {
		const m = await mountCal();
		mounted.push(m);
		const work = await m.h.app.categories.create("Work");
		await m.h.app.tasks.create({ title: "Other", categoryId: work.id });
		const a = (await m.h.app.tasks.create({ title: "Target", categoryId: work.id })).task;
		m.handle.current!.showTasks({ kind: "category", id: work.id }, null);
		await settle();
		await typeSearch(m, "zzz");
		expect(rows(m)).toHaveLength(0);
		m.handle.current!.showTasks({ kind: "category", id: work.id }, a.id);
		await settle();
		expect(search(m).value).toBe("");
		expect(rows(m).map((r) => r.querySelector(".cp-task-title")!.textContent.trim())).toEqual(["Other", "Target"]);
		expect(selected(m)).toEqual(["Target"]);
	});

	it("clears the search text for a view without a task too", async () => {
		const m = await mountCal();
		mounted.push(m);
		await typeSearch(m, "zzz");
		m.handle.current!.showTasks({ kind: "inbox" }, null);
		await settle();
		expect(search(m).value).toBe("");
	});

	it("opens the task's section when the user had collapsed it", async () => {
		const m = await mountCal();
		mounted.push(m);
		const alpha = await m.h.app.sections.create(INBOX_ID, "Alpha");
		const a = (await m.h.app.tasks.create({ title: "Target", sectionId: alpha.id })).task;
		await click(sidebarItem(m.root, "Inbox"));
		const menu = await openMenuAt(m, m.root.querySelector(".cp-tasks")!);
		await pickItem(m, (await pickItem(m, menu, "Group by…"))!, "Section");
		const toggle = () => [...m.root.querySelectorAll<HTMLButtonElement>(".cp-tasks .cp-section-toggle")].find((b) => b.textContent.includes("Alpha"))!;
		await click(toggle());
		expect(toggle().getAttribute("aria-expanded")).toBe("false");
		expect(rows(m)).toHaveLength(0);
		m.handle.current!.showTasks({ kind: "inbox" }, a.id);
		await settle();
		expect(toggle().getAttribute("aria-expanded")).toBe("true");
		expect(selected(m)).toEqual(["Target"]);
	});

	it("keeps the sort the user chose", async () => {
		const m = await mountCal();
		mounted.push(m);
		const before = await m.h.app.tasks.create({ title: "A" });
		m.handle.current!.showTasks({ kind: "inbox" }, before.task.id);
		await settle();
		expect(selected(m)).toEqual(["A"]);
	});
});

describe("revealInTasks", () => {
	const task = makeTask("00000000-0000-4000-8000-000000000001", { title: "Target" });
	const filtered = () => {
		const ui = initialTasksState();
		return { ...ui, text: "zzz", filter: { ...emptyFilter(), priorities: [1 as const], tagKeys: ["x"], date: "overdue" as const, status: "open" as const, sort: "priority" as const } };
	};

	it("resets the content filters for a task, but keeps the sort", () => {
		const out = revealInTasks(filtered(), { kind: "inbox" }, task.id, task);
		expect(out.filter).toEqual({ ...emptyFilter(), sort: "priority" });
		expect(out.text).toBe("");
		expect(out.selectedId).toBe(task.id);
	});

	it("leaves the filters alone for a view without a task", () => {
		const ui = filtered();
		const out = revealInTasks(ui, { kind: "inbox" }, null, undefined);
		expect(out.filter).toBe(ui.filter);
		expect(out.text).toBe("");
	});
});

describe("SectionRelay.showTasks", () => {
	const spy = () => {
		const calls: [unknown, string | null][] = [];
		const sections: string[] = [];
		return { calls, sections, handle: { showSection: (s: string) => void sections.push(s), showTasks: (v: unknown, id: string | null) => void calls.push([v, id]) } as unknown as AppRootHandle };
	};

	it("goes straight through once the handle exists", () => {
		const relay = new SectionRelay();
		const { calls, handle } = spy();
		relay.attach(handle);
		relay.showTasks({ kind: "today" }, "t-1");
		expect(calls).toEqual([[{ kind: "today" }, "t-1"]]);
	});

	it("is queued before the handle exists, seeds the first paint with Tasks and is delivered once", () => {
		const relay = new SectionRelay();
		const { calls, handle } = spy();
		relay.showTasks({ kind: "inbox" }, "t-1");
		expect(relay.pending).toBe("tasks");
		relay.attach(handle);
		relay.attach(handle);
		expect(calls).toEqual([[{ kind: "inbox" }, "t-1"]]);
		expect(relay.pending).toBeNull();
	});

	it("a later section request replaces a queued one, and the other way round", () => {
		const relay = new SectionRelay();
		const first = spy();
		relay.showTasks({ kind: "inbox" }, null);
		relay.show("calendar");
		relay.attach(first.handle);
		expect(first.calls).toEqual([]);
		expect(first.sections).toEqual(["calendar"]);
		const relay2 = new SectionRelay();
		const second = spy();
		relay2.show("calendar");
		relay2.showTasks({ kind: "inbox" }, null);
		relay2.attach(second.handle);
		expect(second.sections).toEqual([]);
		expect(second.calls).toEqual([[{ kind: "inbox" }, null]]);
	});
});
