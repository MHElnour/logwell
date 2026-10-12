// @vitest-environment happy-dom
import { render } from "preact";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runBlockQuery } from "../../src/domain/blockQuery";
import type { ID, Task } from "../../src/domain/types";
import type { JournalOp } from "../../src/persistence/journal";
import { parseBlockQuery } from "../../src/parsing/blockQuery";
import { type BlockBody, DashboardBlock, NO_DATABASE_TEXT, NO_TASKS_TEXT } from "../../src/ui/DashboardBlock";
import { completeBlockTask } from "../../src/ui/blockActions";
import * as domainTasks from "../../src/domain/tasks";
import * as format from "../../src/ui/format";
import { VIRTUAL_THRESHOLD } from "../../src/ui/virtual";
import { type AppHarness, appHarness } from "../app/harness";
import { rule } from "../domain/recurrence-fixtures";
import { makeTask } from "../persistence/fixtures";
import { U1Host, settle } from "./u1-helpers";
import { type FakeLayout, fakeLayout } from "./virtual-layout";

// The dashboard block component. Rows are the app's TaskRow in block mode (no selection, no menu, no
// drag); the data comes from runBlockQuery, which the Obsidian layer runs. happy-dom has no layout, so the
// windowed case runs over the fake layout of the other virtual-list tests.

vi.mock("../../src/ui/format", async (importActual) => {
	const actual = await importActual<typeof import("../../src/ui/format")>();
	return { ...actual, rowDateText: vi.fn(actual.rowDateText) };
});
const rowRenders = () => vi.mocked(format.rowDateText).mock.calls.length;
vi.mock("../../src/domain/tasks", async (importActual) => {
	const actual = await importActual<typeof import("../../src/domain/tasks")>();
	return { ...actual, subtaskCounts: vi.fn(actual.subtaskCounts) };
});
const allTaskCounts = () => vi.mocked(domainTasks.subtaskCounts).mock.calls.length;

/** U1Host that keeps the label of each Undo notice and scripts `choose`. */
class BlockHost extends U1Host {
	readonly undos: { message: string; label: string }[] = [];
	answer: boolean | null = null;
	readonly asked: string[] = [];
	override notifyUndo(message: string, label: string, mark: number): void {
		this.undos.push({ message, label });
		this.bindUndo(label, mark);
	}
	// U1Host's `choose` is typed to answer null only; the scripted answer is true or null.
	override async choose(...args: unknown[]): Promise<null> {
		this.asked.push(`${String(args[0])}: ${String(args[1])}`);
		return this.answer as unknown as null;
	}
}

beforeAll(() => {
	(HTMLElement.prototype as unknown as { empty: () => void }).empty = function (this: HTMLElement) {
		this.replaceChildren();
	};
});

let layout: FakeLayout | null = null;
const roots: HTMLElement[] = [];
afterEach(() => {
	for (const r of roots.splice(0)) {
		render(null, r);
		r.remove();
	}
	layout?.restore();
	layout = null;
});

const today = "2026-10-01";
const scheduledToday = { kind: "date" as const, date: today };

interface Mount {
	h: AppHarness;
	host: BlockHost;
	root: HTMLElement;
	opened: ID[];
	openApp: ReturnType<typeof vi.fn>;
	complete: ReturnType<typeof vi.fn>;
	draw: (source?: string, extra?: Partial<Extract<BlockBody, { kind: "tasks" }>>) => Promise<void>;
	drawBody: (body: BlockBody, chips?: string[]) => Promise<void>;
}

async function mount(): Promise<Mount> {
	const h = await appHarness();
	const host = new BlockHost(h);
	const root = document.createElement("div");
	document.body.appendChild(root);
	roots.push(root);
	const opened: ID[] = [];
	const onOpenTask = (id: ID) => opened.push(id);
	const openApp = vi.fn();
	const complete = vi.fn(async () => undefined);
	const row = { complete };
	const m: Mount = {
		h,
		host,
		root,
		opened,
		openApp,
		complete,
		drawBody: async (body, chips = []) => {
			render(<DashboardBlock icons={host} chips={chips} body={body} onOpenApp={openApp} />, root);
			await settle();
		},
		draw: async (source = "", extra = {}) => {
			const state = h.app.store.state;
			const ctx = h.app.queryContext();
			const r = runBlockQuery(parseBlockQuery(source).filters, state, ctx, "Note.md");
			if (r.kind !== "ok") throw new Error(r.message);
			await m.drawBody({ kind: "tasks", host, state, ctx, entries: r.entries, showList: true, onOpenTask, row, ...extra }, source === "" ? [] : source.split("\n"));
		},
	};
	return m;
}

const rows = (m: Mount) => [...m.root.querySelectorAll<HTMLElement>(".cp-task-row")];
const titles = (m: Mount) => rows(m).map((r) => r.querySelector(".cp-task-title")!.textContent.trim());
const click = async (el: Element | null | undefined) => {
	if (el === null || el === undefined) throw new Error("element not found");
	el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
	await settle();
};

describe("messages", () => {
	it("shows a parser or matcher error in the error style", async () => {
		const m = await mount();
		await m.drawBody({ kind: "message", tone: "error", lines: ["No list named “Wrok”."] });
		const msg = m.root.querySelector(".cp-block-msg")!;
		expect(msg.classList.contains("is-error")).toBe(true);
		expect(msg.textContent).toContain("No list named “Wrok”.");
		expect(rows(m)).toHaveLength(0);
	});

	it("shows one line per problem", async () => {
		const m = await mount();
		await m.drawBody({ kind: "message", tone: "error", lines: ["Unknown filter “foo”.", "Duplicate filter “list”."] });
		expect([...m.root.querySelectorAll(".cp-block-msg-line")].map((l) => l.textContent)).toEqual(["Unknown filter “foo”.", "Duplicate filter “list”."]);
	});

	it("says there is no database, in the plain style", async () => {
		const m = await mount();
		await m.drawBody({ kind: "message", tone: "info", lines: [NO_DATABASE_TEXT] });
		expect(NO_DATABASE_TEXT).toBe("Open a Logwell database to see tasks.");
		const msg = m.root.querySelector(".cp-block-msg")!;
		expect(msg.classList.contains("is-error")).toBe(false);
		expect(msg.textContent).toBe("Open a Logwell database to see tasks.");
	});

	it("says No tasks found. when the filters are valid and nothing matches", async () => {
		const m = await mount();
		await m.draw("priority: high");
		expect(NO_TASKS_TEXT).toBe("No tasks found.");
		expect(m.root.querySelector(".cp-block-msg")!.textContent).toBe("No tasks found.");
		expect(m.root.querySelector(".cp-block-count")!.textContent).toBe("0 tasks");
		expect(rows(m)).toHaveLength(0);
	});
});

describe("header", () => {
	it("shows the filters as chips, the task count and an Open in Logwell button", async () => {
		const m = await mount();
		await m.h.app.tasks.create({ title: "A", priority: 1 });
		await m.h.app.tasks.create({ title: "B", priority: 1 });
		await m.draw("priority: high");
		expect([...m.root.querySelectorAll(".cp-block-chip")].map((c) => c.textContent)).toEqual(["priority: high"]);
		expect(m.root.querySelector(".cp-block-count")!.textContent).toBe("2 tasks");
		const open = m.root.querySelector<HTMLButtonElement>('button[aria-label="Open in Logwell"]')!;
		expect(open).not.toBeNull();
		await click(open);
		expect(m.openApp).toHaveBeenCalledTimes(1);
	});

	it("counts one task in the singular and counts a subtask under its parent as part of it", async () => {
		const m = await mount();
		const parent = (await m.h.app.tasks.create({ title: "Parent" })).task;
		await m.h.app.tasks.create({ title: "Child", parentId: parent.id });
		await m.draw();
		expect(titles(m)).toEqual(["Parent", "Child"]);
		expect(m.root.querySelector(".cp-block-count")!.textContent).toBe("1 task");
	});

	it("keeps the Open in Logwell button when there is no database", async () => {
		const m = await mount();
		await m.drawBody({ kind: "message", tone: "info", lines: [NO_DATABASE_TEXT] }, ["list: Work"]);
		expect(m.root.querySelector('button[aria-label="Open in Logwell"]')).not.toBeNull();
		expect(m.root.querySelector(".cp-block-count")!.textContent).toBe("");
	});

	it("labels the list and puts no aria-label on containers", async () => {
		const m = await mount();
		await m.h.app.tasks.create({ title: "A" });
		await m.draw();
		const labelled = [...m.root.querySelectorAll("[aria-label]")].filter((e) => e.tagName !== "BUTTON" && e.tagName !== "INPUT" && e.getAttribute("role") !== "img");
		expect(labelled).toEqual([]);
	});
});

describe("rows in block mode", () => {
	it("draw like the app's rows: checkbox, title, date", async () => {
		const m = await mount();
		await m.h.app.tasks.create({ title: "A", scheduled: scheduledToday, priority: 1 });
		await m.draw();
		const row = rows(m)[0]!;
		expect(row.querySelector("input.cp-task-checkbox.cp-pri-1")).not.toBeNull();
		expect(row.querySelector(".cp-meta-date")!.textContent).toContain("Today");
		expect(row.getAttribute("aria-selected")).toBe("false");
	});

	it("shows the list name unless the block is filtered to one list", async () => {
		const m = await mount();
		await m.h.app.tasks.create({ title: "A" });
		await m.draw();
		expect(m.root.querySelector(".cp-meta-list-name")).not.toBeNull();
		await m.draw("", { showList: false });
		expect(m.root.querySelector(".cp-meta-list-name")).toBeNull();
	});

	it("a click on the row opens the task in the app", async () => {
		const m = await mount();
		const a = (await m.h.app.tasks.create({ title: "A" })).task;
		await m.h.app.tasks.create({ title: "B" });
		await m.draw();
		await click(rows(m)[0]);
		expect(m.opened).toEqual([a.id]);
		expect(rows(m)[0]!.classList.contains("is-selected")).toBe(false);
	});

	it("Enter on a row opens it and Down moves to the next row", async () => {
		const m = await mount();
		const a = (await m.h.app.tasks.create({ title: "A" })).task;
		await m.h.app.tasks.create({ title: "B" });
		await m.draw();
		rows(m)[0]!.focus();
		rows(m)[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
		expect(document.activeElement).toBe(rows(m)[1]);
		rows(m)[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		expect(m.opened).toEqual([a.id]);
	});

	it("the checkbox completes through the block's own handler and does not open the task", async () => {
		const m = await mount();
		const a = (await m.h.app.tasks.create({ title: "A" })).task;
		await m.draw();
		await click(rows(m)[0]!.querySelector("input.cp-task-checkbox"));
		expect(m.complete).toHaveBeenCalledTimes(1);
		expect(m.complete.mock.calls[0]![0]).toMatchObject({ id: a.id });
		expect(m.opened).toEqual([]);
	});

	it("has no row menu: not from a right click and not from the menu keys", async () => {
		const m = await mount();
		await m.h.app.tasks.create({ title: "A" });
		await m.draw();
		const row = rows(m)[0]!;
		row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
		row.focus();
		row.dispatchEvent(new KeyboardEvent("keydown", { key: "ContextMenu", bubbles: true, cancelable: true }));
		row.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true }));
		expect(m.host.menus).toHaveLength(0);
	});

	it("does not start a drag: a pointer drag over the rows leaves them where they are", async () => {
		const m = await mount();
		await m.h.app.tasks.create({ title: "A" });
		await m.h.app.tasks.create({ title: "B" });
		await m.draw();
		const first = rows(m)[0]!;
		first.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 10, clientY: 10, button: 0 }));
		first.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 10, clientY: 200 }));
		first.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 10, clientY: 200 }));
		await settle();
		expect(m.root.querySelector(".is-dragging, .is-reordering, .cp-reorder-line:not([hidden])")).toBeNull();
		expect(titles(m)).toEqual(["A", "B"]);
	});

	it("a refresh with one changed task renders only that row", async () => {
		const m = await mount();
		const ids: ID[] = [];
		for (const title of ["A", "B", "C"]) ids.push((await m.h.app.tasks.create({ title, scheduled: scheduledToday })).task.id);
		await m.draw();
		const before = rowRenders();
		await m.h.app.tasks.update(ids[1]!, { title: "B edited" });
		await m.draw();
		expect(titles(m)).toEqual(["A", "B edited", "C"]);
		expect(rowRenders() - before).toBe(1);
		// The same data again renders no row.
		const again = rowRenders();
		await m.draw();
		expect(rowRenders() - again).toBe(0);
	});
});

describe("subtask counts in block mode", () => {
	it("reads the subtask counts from the task index, and never counts every task again", async () => {
		const m = await mount();
		const parent = (await m.h.app.tasks.create({ title: "Parent" })).task;
		const c1 = (await m.h.app.tasks.create({ title: "C1", parentId: parent.id })).task;
		await m.h.app.tasks.create({ title: "C2", parentId: parent.id });
		await m.h.app.tasks.complete(c1.id);
		const other = (await m.h.app.tasks.create({ title: "Other" })).task;
		await m.h.app.tasks.create({ title: "Other child", parentId: other.id });
		// The index is built by the first read (any open view does that); a block reads it, never counts again.
		m.h.app.tasks.lists.subtaskCounts();
		const rebuilds = m.h.app.tasks.lists.rebuilds;
		vi.mocked(domainTasks.subtaskCounts).mockClear();
		await m.draw("");
		const label = (title: string) => rows(m).find((r) => r.querySelector(".cp-task-title")!.textContent.trim() === title)!.querySelector(".cp-meta-subtasks")?.textContent.replace(/\s/g, "");
		expect(label("Parent")).toBe("1/2");
		expect(label("Other")).toBe("0/1");
		expect(allTaskCounts()).toBe(0);
		expect(m.h.app.tasks.lists.rebuilds).toBe(rebuilds);
	});
});

describe("messages", () => {
	it("draws repeated lines each time and follows a change of the lines", async () => {
		const m = await mount();
		const lines = () => [...m.root.querySelectorAll(".cp-block-msg-line")].map((l) => l.textContent);
		await m.drawBody({ kind: "message", tone: "error", lines: ["Same.", "Same."] });
		expect(lines()).toEqual(["Same.", "Same."]);
		await m.drawBody({ kind: "message", tone: "error", lines: ["Same.", "Other.", "Same."] });
		expect(lines()).toEqual(["Same.", "Other.", "Same."]);
		await m.drawBody({ kind: "message", tone: "error", lines: ["Other."] });
		expect(lines()).toEqual(["Other."]);
	});
});

describe("completing from the block", () => {
	it("completes a task and offers Undo under the label of that write", async () => {
		const m = await mount();
		const a = (await m.h.app.tasks.create({ title: "A" })).task;
		await completeBlockTask(m.host, a);
		expect(m.h.app.store.state.tasks.get(a.id)!.status).toBe("completed");
		expect(m.host.undos).toEqual([{ message: 'Completed "A".', label: "Complete task" }]);
		await expect(m.host.undoButtons[0]!()).resolves.toBe(true);
		expect(m.h.app.store.state.tasks.get(a.id)!.status).toBe("open");
	});

	it("completes the current occurrence of a repeating task, with the occurrence label", async () => {
		const m = await mount();
		const a = (await m.h.app.tasks.create({ title: "Water", scheduled: scheduledToday, repeat: { rule: rule() } })).task;
		await completeBlockTask(m.host, m.h.app.store.state.tasks.get(a.id)!);
		expect(m.host.undos).toHaveLength(1);
		expect(m.host.undos[0]!.label).toBe("Complete occurrence");
		expect(m.h.app.store.state.tasks.get(a.id)!.status).toBe("open");
	});

	it("asks before completing a task with open subtasks; Complete all completes both under one label", async () => {
		const m = await mount();
		const parent = (await m.h.app.tasks.create({ title: "Parent" })).task;
		const child = (await m.h.app.tasks.create({ title: "Child", parentId: parent.id })).task;
		m.host.answer = true;
		await completeBlockTask(m.host, parent);
		expect(m.host.asked).toHaveLength(1);
		expect(m.h.app.store.state.tasks.get(parent.id)!.status).toBe("completed");
		expect(m.h.app.store.state.tasks.get(child.id)!.status).toBe("completed");
		expect(m.host.undos).toEqual([{ message: 'Completed "Parent" and 1 subtask.', label: "Complete task" }]);
	});

	it("leaves the task alone when the prompt is dismissed, with no notice", async () => {
		const m = await mount();
		const parent = (await m.h.app.tasks.create({ title: "Parent" })).task;
		await m.h.app.tasks.create({ title: "Child", parentId: parent.id });
		m.host.answer = null;
		await completeBlockTask(m.host, parent);
		expect(m.h.app.store.state.tasks.get(parent.id)!.status).toBe("open");
		expect(m.host.undos).toEqual([]);
	});

	it("shows an error and no notice when the database is read-only", async () => {
		const m = await mount();
		const a = (await m.h.app.tasks.create({ title: "A" })).task;
		const { makeReadOnly } = await import("../app/harness");
		await makeReadOnly(m.h);
		await completeBlockTask(m.host, a);
		expect(m.host.undos).toEqual([]);
		expect(m.host.messages.length).toBeGreaterThan(0);
	});

	it("keeps a just-completed row for a moment so its check shows, then drops it", async () => {
		const m = await mount();
		const ids: ID[] = [];
		for (const title of ["A", "B"]) ids.push((await m.h.app.tasks.create({ title })).task.id);
		await m.draw();
		await m.h.app.tasks.complete(ids[0]!);
		await m.draw();
		expect(titles(m)).toEqual(["A", "B"]);
		expect(rows(m)[0]!.classList.contains("is-completed")).toBe(true);
		expect(m.root.querySelector(".cp-block-count")!.textContent).toBe("1 task");
		await new Promise((r) => setTimeout(r, 650));
		await settle();
		expect(titles(m)).toEqual(["B"]);
	});

	it("keeps the subtask badge of a held parent while its row stays", async () => {
		const m = await mount();
		const parent = (await m.h.app.tasks.create({ title: "Parent" })).task;
		const child = (await m.h.app.tasks.create({ title: "Child", parentId: parent.id })).task;
		await m.draw("");
		await m.h.app.tasks.complete(child.id);
		await m.h.app.tasks.complete(parent.id);
		// Nothing of the family is open: the block's own query returns no row and counts no parent.
		await m.draw("");
		expect(titles(m)).toContain("Parent");
		const row = rows(m).find((r) => r.querySelector(".cp-task-title")!.textContent.trim() === "Parent")!;
		expect(row.querySelector(".cp-meta-subtasks")!.textContent.replace(/\s/g, "")).toBe("1/1");
	});

	it("keeps the last completed row too, instead of switching to the empty message at once", async () => {
		const m = await mount();
		const a = (await m.h.app.tasks.create({ title: "A" })).task;
		await m.draw();
		await m.h.app.tasks.complete(a.id);
		await m.draw();
		expect(titles(m)).toEqual(["A"]);
		expect(m.root.querySelector(".cp-block-msg")).toBeNull();
		await new Promise((r) => setTimeout(r, 650));
		await settle();
		expect(m.root.querySelector(".cp-block-msg")!.textContent).toBe("No tasks found.");
	});
});

// -- long results ----------------------------------------------------------------------------------

const ROW = 52;
const BODY = 340;
const taskId = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

async function seeded(m: Mount, count: number): Promise<void> {
	const data = m.h.store.data;
	const tasks = new Map(data.tasks);
	const ops: JournalOp[] = [];
	for (let i = 0; i < count; i++) {
		const t: Task = makeTask(taskId(i + 1), { title: `Task ${i}`, sortKey: `V${i.toString(36).padStart(4, "0")}` });
		tasks.set(t.id, t);
		ops.push({ c: "tasks", id: t.id, v: t });
	}
	m.h.store.commit({ ...data, tasks }, ops);
}

describe("long results", () => {
	it("at or below the threshold draws every row", async () => {
		const m = await mount();
		await seeded(m, VIRTUAL_THRESHOLD);
		await m.draw();
		expect(rows(m)).toHaveLength(VIRTUAL_THRESHOLD);
		expect(m.root.querySelector(".cp-virtual-spacer")).toBeNull();
	});

	it("above it scrolls inside the block body and draws only the rows near the viewport", async () => {
		const m = await mount();
		await seeded(m, 2000);
		layout = fakeLayout({
			viewport: (el) => (el.classList.contains("cp-block-body") ? BODY : undefined),
			height: (el) => (el.classList.contains("cp-task-row") ? ROW : undefined),
		});
		await m.draw();
		const body = m.root.querySelector<HTMLElement>(".cp-block-body")!;
		expect(rows(m).length).toBeGreaterThan(BODY / ROW);
		expect(rows(m).length).toBeLessThan(40);
		expect(titles(m)[0]).toBe("Task 0");
		expect(layout.contentHeight(body)).toBe(2000 * ROW);
		await layout.scrollTo(body, 1000 * ROW);
		expect(titles(m)).toContain("Task 1000");
		expect(titles(m)).not.toContain("Task 0");
		// The count is the whole result, not the drawn rows.
		expect(m.root.querySelector(".cp-block-count")!.textContent).toBe("2000 tasks");
	});

	it("tolerates a container with no size, then draws the rows once it has one", async () => {
		const m = await mount();
		await seeded(m, 400);
		// No layout: clientHeight is 0, as in a collapsed callout or a background tab.
		await expect(m.draw()).resolves.toBeUndefined();
		expect(m.root.querySelector(".cp-block-body")).not.toBeNull();
		expect(rows(m).length).toBeLessThan(400);
		layout = fakeLayout({
			viewport: (el) => (el.classList.contains("cp-block-body") ? BODY : undefined),
			height: (el) => (el.classList.contains("cp-task-row") ? ROW : undefined),
		});
		const body = m.root.querySelector<HTMLElement>(".cp-block-body")!;
		await layout.scrollTo(body, 0);
		expect(rows(m).length).toBeGreaterThan(BODY / ROW);
		expect(titles(m)[0]).toBe("Task 0");
	});
});
