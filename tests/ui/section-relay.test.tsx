// @vitest-environment happy-dom
import { render } from "preact";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { AppRoot, type AppRootHandle } from "../../src/ui/AppRoot";
import { SectionRelay } from "../../src/ui/sectionRelay";
import { appHarness } from "../app/harness";
import { settle, U1Host } from "./u1-helpers";
import { emptyFilter } from "../../src/domain/queries";
import { INBOX_ID } from "../../src/domain/types";
import { initialTasksState, revealInTasks } from "../../src/ui/TasksSection";
import { makeTask } from "../persistence/fixtures";
import { type CalMount, click, mountCal, settle as settleCal } from "./m3-helpers";
import { sidebarItem } from "./k1a-helpers";
import { openViewMenu as openMenuAt, pickItem } from "./view-menu-helpers";

describe("section relay", () => {
	// "Open calendar" and "Open search" on a tab that is not open yet showed Tasks: the request came
	// before AppRoot registered its handle (a post-paint effect) and was dropped. SectionRelay keeps it.

	const roots: HTMLElement[] = [];
	afterEach(() => {
		for (const r of roots.splice(0)) {
			render(null, r);
			r.remove();
		}
	});

	/** Mounts AppRoot the way CheckpointView.renderApp does. */
	async function mount(relay: SectionRelay, order: "show-before-mount" | "show-right-after-mount" | "show-after-effects") {
		(HTMLElement.prototype as unknown as { empty: () => void }).empty = function (this: HTMLElement) {
			this.replaceChildren();
		};
		const h = await appHarness();
		const host = new U1Host(h);
		const root = document.createElement("div");
		document.body.appendChild(root);
		roots.push(root);
		const view = () => <AppRoot host={host} initialSection={relay.pending} handle={(handle: AppRootHandle) => relay.attach(handle)} />;
		if (order === "show-before-mount") relay.show("calendar");
		render(view(), root);
		// Effects have not run yet: the handle is not registered. This is the window the bug lived in.
		if (order === "show-right-after-mount") relay.show("calendar");
		await settle();
		if (order === "show-after-effects") {
			relay.show("calendar");
			await settle();
		}
		return { root, rerender: async () => (render(view(), root), await settle()) };
	}

	const visibleSection = (root: HTMLElement) => {
		const shown = [...root.querySelectorAll<HTMLElement>(".cp-section")].filter((s) => !s.hidden);
		expect(shown).toHaveLength(1);
		return shown[0]!.querySelector(".cp-calendar") !== null ? "calendar" : shown[0]!.querySelector(".cp-search") !== null ? "search" : "tasks";
	};

	describe("SectionRelay with the real app root", () => {
		it("a request made right after the mount, before the handle exists, is delivered (the bug)", async () => {
			const m = await mount(new SectionRelay(), "show-right-after-mount");
			expect(visibleSection(m.root)).toBe("calendar");
		});

		it("a request made before the first render seeds the first paint and is not lost", async () => {
			const relay = new SectionRelay();
			const m = await mount(relay, "show-before-mount");
			expect(visibleSection(m.root)).toBe("calendar");
			expect(relay.pending).toBeNull();
		});

		it("a request made once the handle exists goes straight through", async () => {
			const m = await mount(new SectionRelay(), "show-after-effects");
			expect(visibleSection(m.root)).toBe("calendar");
		});

		it("a re-render does not replay or lose the section the user moved to", async () => {
			const relay = new SectionRelay();
			const m = await mount(relay, "show-right-after-mount");
			relay.show("search");
			await settle();
			expect(visibleSection(m.root)).toBe("search");
			await m.rerender();
			expect(visibleSection(m.root)).toBe("search");
		});
	});

	describe("SectionRelay", () => {
		const spy = () => {
			const shown: string[] = [];
			const habits: [string, boolean | undefined][] = [];
			return {
				shown,
				habits,
				handle: {
					showSection: (s: string) => void shown.push(s),
					showHabit: (id: string, focus?: boolean) => void habits.push([id, focus]),
				} as unknown as AppRootHandle,
			};
		};

		it("keeps only the latest queued request and delivers it once on attach", () => {
			const relay = new SectionRelay();
			const { shown, handle } = spy();
			relay.show("calendar");
			relay.show("search");
			expect(relay.pending).toBe("search");
			relay.attach(handle);
			relay.attach(handle); // the root re-registers on every render
			expect(shown).toEqual(["search"]);
			expect(relay.pending).toBeNull();
		});

		it("after detach, requests wait for the next root", () => {
			const relay = new SectionRelay();
			const first = spy();
			relay.attach(first.handle);
			relay.show("calendar");
			relay.detach();
			relay.show("search");
			expect(first.shown).toEqual(["calendar"]);
			const second = spy();
			relay.attach(second.handle);
			expect(second.shown).toEqual(["search"]);
		});

		it("the today request is carried like any section", () => {
			const relay = new SectionRelay();
			const { shown, handle } = spy();
			relay.show("today");
			relay.attach(handle);
			expect(shown).toEqual(["today"]);
		});

		it("queues showHabit before attach and replays it once on attach", () => {
			const relay = new SectionRelay();
			const { habits, handle } = spy();
			relay.showHabit("h-1", true);
			expect(relay.pending).toBe("habits");
			expect(habits).toEqual([]);
			relay.attach(handle);
			relay.attach(handle); // the root re-registers on every render
			expect(habits).toEqual([["h-1", true]]);
			expect(relay.pending).toBeNull();
		});

		it("a section then a habit (the openHabits order): both are delivered, the section first", () => {
			const relay = new SectionRelay();
			const { shown, habits, handle } = spy();
			relay.show("habits");
			relay.showHabit("h-1", false);
			relay.attach(handle);
			expect(shown).toEqual(["habits"]);
			expect(habits).toEqual([["h-1", false]]);
		});

		it("a section requested after a queued habit wins: the habit is dropped", () => {
			const relay = new SectionRelay();
			const { shown, habits, handle } = spy();
			relay.showHabit("h-1", true);
			relay.show("calendar");
			expect(relay.pending).toBe("calendar");
			relay.attach(handle);
			expect(shown).toEqual(["calendar"]);
			expect(habits).toEqual([]);
		});

		it("showHabit goes straight through once the handle exists, and waits again after detach", () => {
			const relay = new SectionRelay();
			const first = spy();
			relay.attach(first.handle);
			relay.showHabit("h-1", true);
			relay.detach();
			relay.showHabit("h-2", false);
			expect(first.habits).toEqual([["h-1", true]]);
			const second = spy();
			relay.attach(second.handle);
			expect(second.habits).toEqual([["h-2", false]]);
		});
	});
});

describe("showing tasks from a block", () => {
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
			await settleCal();
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
			await settleCal();
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
			await settleCal();
		};

		it("clears the search text, so a task the text did not match is shown", async () => {
			const m = await mountCal();
			mounted.push(m);
			const work = await m.h.app.categories.create("Work");
			await m.h.app.tasks.create({ title: "Other", categoryId: work.id });
			const a = (await m.h.app.tasks.create({ title: "Target", categoryId: work.id })).task;
			m.handle.current!.showTasks({ kind: "category", id: work.id }, null);
			await settleCal();
			await typeSearch(m, "zzz");
			expect(rows(m)).toHaveLength(0);
			m.handle.current!.showTasks({ kind: "category", id: work.id }, a.id);
			await settleCal();
			expect(search(m).value).toBe("");
			expect(rows(m).map((r) => r.querySelector(".cp-task-title")!.textContent.trim())).toEqual(["Other", "Target"]);
			expect(selected(m)).toEqual(["Target"]);
		});

		it("clears the search text for a view without a task too", async () => {
			const m = await mountCal();
			mounted.push(m);
			await typeSearch(m, "zzz");
			m.handle.current!.showTasks({ kind: "inbox" }, null);
			await settleCal();
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
			await settleCal();
			expect(toggle().getAttribute("aria-expanded")).toBe("true");
			expect(selected(m)).toEqual(["Target"]);
		});

		it("keeps the sort the user chose", async () => {
			const m = await mountCal();
			mounted.push(m);
			const before = await m.h.app.tasks.create({ title: "A" });
			m.handle.current!.showTasks({ kind: "inbox" }, before.task.id);
			await settleCal();
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
});
