// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { CpbaseStore } from "../../src/persistence/CpbaseStore";
import type { ButtonSpec, QuickAddPreset } from "../../src/ui/host";
import { TOGGLE_COMPLETE_EVENT } from "../../src/ui/TaskList";
import { appHarness, makeReadOnly } from "../app/harness";
import { keydown, mountApp, mountQuickForm, settle, typeInto, U1Host } from "./app-helpers";

// Smoke tests of the real Preact UI against the real services, with a fake
// host in place of Obsidian. They catch runtime errors and check the wiring of
// tasks, notes, subtasks and the app shell that the e2e specs
// repeat inside Obsidian.

/** The kit's host with scripted confirmations, a scripted note pick, the Quick Add presets asked and note text from the vault. */
class FakeHost extends U1Host {
	chooseAnswers: unknown[] = [];
	nextNote: string | null = null;
	readonly presets: QuickAddPreset[] = [];
	override async choose<T>(_t: string, message: string, buttons: ButtonSpec<T>[]): Promise<T | null> {
		this.messages.push(message);
		const answer = this.chooseAnswers.shift();
		return answer === undefined ? (buttons[0]?.value ?? null) : (answer as T | null);
	}
	override async pickNote() {
		return this.nextNote;
	}
	override quickAdd(preset: QuickAddPreset = {}) {
		this.messages.push("quick add");
		this.presets.push(preset);
	}
	override async renderNote(path: string, el: HTMLElement) {
		el.textContent = this.h.notes.files.get(path) ?? "";
		return () => undefined;
	}
}

function byText(root: HTMLElement, selector: string, text: string): HTMLElement {
	const el = [...root.querySelectorAll<HTMLElement>(selector)].find((e) => e.textContent?.trim().includes(text));
	if (el === undefined) throw new Error(`No ${selector} with text "${text}"`);
	return el;
}

const mount = () => mountApp({}, { host: (h) => new FakeHost(h) });

describe("app UI (smoke)", () => {
	it("AS-01: adds a task from the inline bar and shows it in Inbox", async () => {
		const { h, root } = await mount();
		expect(root.querySelector(".cp-main-title")?.textContent).toBe("Today");
		byText(root, ".cp-sidebar-item", "Inbox").click();
		await settle();
		const input = root.querySelector<HTMLInputElement>(".cp-add-bar input")!;
		await typeInto(input, "Buy milk");
		keydown(input, "Enter");
		await settle();
		expect(byText(root, ".cp-task-row", "Buy milk")).toBeDefined();
		expect(h.app.store.state.tasks.size).toBe(1);
		expect(h.notes.writes).toEqual([]);
	});

	it("AS-02 / TASK-02 / AS-06: details, title restore, note link and missing note", async () => {
		const { h, host, root } = await mount();
		h.notes.files.set("Plan.md", "Plan body text");
		const { task } = await h.app.tasks.create({ title: "Plan the trip" });
		byText(root, ".cp-sidebar-item", "Inbox").click();
		await settle();
		byText(root, ".cp-task-row", "Plan the trip").click();
		await settle();
		const title = root.querySelector<HTMLTextAreaElement>(".cp-details-title")!;
		expect(title.value).toBe("Plan the trip");

		await typeInto(title, "   ");
		title.dispatchEvent(new FocusEvent("blur"));
		await settle();
		expect(title.value).toBe("Plan the trip");
		expect(host.messages).toContain("A task needs a title. The previous title was restored.");

		host.nextNote = "Plan.md";
		byText(root, "button", "Link existing note").click();
		await settle();
		expect(root.querySelector(".cp-note-preview")?.textContent).toBe("Plan body text");
		expect(h.app.store.state.tasks.get(task.id)?.descriptionNote?.path).toBe("Plan.md");
		expect(root.querySelectorAll('.cp-description [aria-label="Open note"]').length).toBe(1);
		expect([...root.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Open note")).toHaveLength(0);
		root.querySelector<HTMLElement>('.cp-description [aria-label="Open note"]')!.click();
		expect(host.opened).toEqual(["Plan.md"]);

		h.notes.files.delete("Plan.md");
		host.noteEvents.emit("note", "Plan.md");
		await settle();
		expect(root.querySelector(".cp-description.is-missing")?.textContent).toContain("Description note not found: Plan.md");
		byText(root, "button", "Unlink").click();
		await settle();
		expect(h.app.store.state.tasks.get(task.id)?.descriptionNote).toBeNull();
	});

	it("SUB-03: completing a parent asks first; cancel changes nothing", async () => {
		const { h, host, root } = await mount();
		const parent = (await h.app.tasks.create({ title: "Parent" })).task;
		byText(root, ".cp-sidebar-item", "Inbox").click();
		await settle();
		byText(root, ".cp-task-row", "Parent").click();
		await settle();
		const sub = root.querySelector<HTMLInputElement>(".cp-details-section .cp-qa-input")!;
		await typeInto(sub, "Child");
		keydown(sub, "Enter");
		await settle();
		expect(h.app.tasks.subtaskCount(parent.id)).toBe(1);

		host.chooseAnswers = [null];
		root.querySelector<HTMLInputElement>(".cp-details-top .cp-task-checkbox")!.click();
		await settle();
		expect(host.messages.some((m) => m.includes("has 1 open subtask"))).toBe(true);
		expect(h.app.store.state.tasks.get(parent.id)?.status).toBe("open");

		host.chooseAnswers = [true];
		root.querySelector<HTMLInputElement>(".cp-details-top .cp-task-checkbox")!.click();
		await settle();
		expect([...h.app.store.state.tasks.values()].every((t) => t.status === "completed")).toBe(true);
	});

	it("UI-01: switching sections keeps each section's state; keyboard and menu work", async () => {
		const { h, host, root } = await mount();
		await h.app.tasks.create({ title: "Alpha" });
		await h.app.tasks.create({ title: "Beta" });
		await h.app.tasks.create({ title: "Gamma" });
		byText(root, ".cp-sidebar-item", "Inbox").click();
		await settle();
		const rows = root.querySelectorAll<HTMLElement>(".cp-task-row");
		expect(rows).toHaveLength(3);
		rows[0]!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
		expect(host.menus[0]?.some((i) => i !== "separator" && i.title === "Delete")).toBe(true);
		keydown(rows[0]!, "Enter", { ctrlKey: true });
		await settle();
		expect([...h.app.store.state.tasks.values()].find((t) => t.title === "Alpha")?.status).toBe("completed");

		// Inside Obsidian, Cmd/Ctrl+Enter arrives as this event from the view's keymap scope.
		byText(root, ".cp-task-row", "Gamma").dispatchEvent(new CustomEvent(TOGGLE_COMPLETE_EVENT));
		await settle();
		expect([...h.app.store.state.tasks.values()].find((t) => t.title === "Gamma")?.status).toBe("completed");

		byText(root, ".cp-task-row", "Beta").click();
		await settle();
		root.querySelector<HTMLButtonElement>('.cp-rail [aria-label="Search"]')!.click();
		await settle();
		const search = root.querySelector<HTMLInputElement>('.cp-search-box input[type="search"]')!;
		await typeInto(search, "alp");
		await settle();
		expect(byText(root, ".cp-search .cp-task-row", "Alpha")).toBeDefined();
		root.querySelector<HTMLButtonElement>('.cp-rail [aria-label="Data"]')!.click();
		await settle();
		expect(byText(root, "button", "Export backup")).toBeDefined();
		root.querySelector<HTMLButtonElement>('.cp-rail [aria-label="Tasks"]')!.click();
		await settle();
		expect(root.querySelector(".cp-main-title")?.textContent).toBe("Inbox");
		expect(root.querySelector<HTMLTextAreaElement>(".cp-details-title")?.value).toBe("Beta");
	});

	it("deletes with an undo notice and shows the batch in Trash", async () => {
		const { h, host, root } = await mount();
		await h.app.tasks.create({ title: "Gone soon" });
		byText(root, ".cp-sidebar-item", "Inbox").click();
		await settle();
		byText(root, ".cp-task-row", "Gone soon").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
		const del = host.menus[0]?.find((i) => i !== "separator" && i.title === "Delete");
		if (del === undefined || del === "separator") throw new Error("no delete item");
		del.run();
		await settle();
		expect(host.messages).toContain('Moved "Gone soon" to Trash.');
		byText(root, ".cp-sidebar-item", "Trash").click();
		await settle();
		byText(root, ".cp-trash-entry button", "Restore").click();
		await settle();
		expect(h.app.store.state.tasks.size).toBe(1);
	});

	it("hidden Tasks catches up on its first visible render after a task is completed or trashed", async () => {
		const { h, root } = await mount();
		const done = (await h.app.tasks.create({ title: "Finish me" })).task;
		const gone = (await h.app.tasks.create({ title: "Bin me" })).task;
		await h.app.tasks.create({ title: "Stay put" });
		byText(root, ".cp-sidebar-item", "Inbox").click();
		await settle();
		const count = (label: string): string | undefined => byText(root, ".cp-sidebar-item", label).querySelector(".cp-count")?.textContent ?? undefined;
		expect(root.querySelectorAll(".cp-task-row")).toHaveLength(3);
		expect(count("Inbox")).toBe("3");
		expect(count("Trash")).toBeUndefined();

		// Leave Tasks (it stays mounted but hidden), then change what it shows.
		root.querySelector<HTMLButtonElement>('.cp-rail [aria-label="Data"]')!.click();
		await settle();
		await h.app.tasks.complete(done.id);
		await h.app.tasks.delete(gone.id);
		await settle();

		root.querySelector<HTMLButtonElement>('.cp-rail [aria-label="Tasks"]')!.click();
		await settle();
		expect(root.querySelector(".cp-main-title")?.textContent).toBe("Inbox");
		const titles = [...root.querySelectorAll(".cp-task-row")].map((r) => r.textContent ?? "");
		expect(titles).toHaveLength(1);
		expect(titles[0]).toContain("Stay put");
		expect(count("Inbox")).toBe("1");
		expect(count("Trash")).toBe("1");
		byText(root, ".cp-sidebar-item", "Trash").click();
		await settle();
		expect(byText(root, ".cp-trash-entry", "Bin me")).toBeDefined();

		// Emptying the Trash changes only `trash`, not `tasks`: the Trash count must follow it too.
		root.querySelector<HTMLButtonElement>('.cp-rail [aria-label="Data"]')!.click();
		await settle();
		await h.app.tasks.emptyTrash();
		await settle();
		root.querySelector<HTMLButtonElement>('.cp-rail [aria-label="Tasks"]')!.click();
		await settle();
		expect(count("Trash")).toBeUndefined();
		expect(root.querySelector(".cp-trash-entry")).toBeNull();
	});

	it("QA-01: the header + in a tag view presets that tag", async () => {
		const { h, host, root } = await mount();
		await h.app.tags.create("Work");
		await settle();
		byText(root, ".cp-sidebar-item", "Work").click();
		await settle();
		root.querySelector<HTMLButtonElement>('.cp-tasks .cp-main-header [aria-label="Quick add task"]')!.click();
		expect(host.presets).toEqual([{ categoryId: "inbox", date: null, tagKeys: ["work"] }]);
	});

	it("QA-01: Quick Add saves the preset tags", async () => {
		const h = await appHarness();
		await h.app.tags.create("work");
		const { root: container } = await mountQuickForm({ app: h.app, preset: { tagKeys: ["work"] } });
		expect(container.querySelector(".cp-tag-input .cp-chip")?.textContent).toContain("@work");
		const title = container.querySelector<HTMLInputElement>(".cp-quick-add-title")!;
		await typeInto(title, "Plan the week");
		keydown(title, "Enter");
		await settle();
		expect([...h.app.store.state.tasks.values()].map((t) => t.tagKeys)).toEqual([["work"]]);
	});

	it("element IDs stay unique with details open in Tasks and Search", async () => {
		const { h, root } = await mount();
		await h.app.tasks.create({ title: "Alpha", scheduled: { kind: "date", date: "2026-10-01" } });
		await settle();
		byText(root, ".cp-tasks .cp-task-row", "Alpha").click();
		await settle();
		root.querySelector<HTMLButtonElement>('.cp-rail [aria-label="Search"]')!.click();
		await settle();
		await typeInto(root.querySelector<HTMLInputElement>('.cp-search-box input[type="search"]')!, "alp");
		byText(root, ".cp-search .cp-task-row", "Alpha").click();
		await settle();
		const details = root.querySelectorAll<HTMLElement>(".cp-details");
		expect(details).toHaveLength(2);
		// The date fields open from the date chip.
		for (const chip of root.querySelectorAll<HTMLButtonElement>(".cp-details .cp-due-chip")) chip.click();
		await settle();
		const ids = [...root.querySelectorAll("[id]")].map((e) => e.id);
		expect(ids.length).toBeGreaterThan(0);
		expect(new Set(ids).size).toBe(ids.length);
		// Every label points at a control inside its own details pane.
		for (const pane of details) {
			for (const label of pane.querySelectorAll<HTMLLabelElement>("label[for]")) {
				expect(pane.querySelector(`#${CSS.escape(label.htmlFor)}`)).not.toBeNull();
			}
		}
	});

	it("backups are listed only while the Data section is visible", async () => {
		const list = vi.spyOn(CpbaseStore.prototype, "listSnapshots");
		try {
			const { h, root } = await mount();
			await h.app.tasks.create({ title: "One" });
			await h.app.tasks.create({ title: "Two" });
			await settle();
			expect(list).not.toHaveBeenCalled();

			root.querySelector<HTMLButtonElement>('.cp-rail [aria-label="Data"]')!.click();
			await settle();
			expect(list).toHaveBeenCalled();

			root.querySelector<HTMLButtonElement>('.cp-rail [aria-label="Tasks"]')!.click();
			await settle();
			const calls = list.mock.calls.length;
			await h.app.tasks.create({ title: "Three" });
			await settle();
			expect(list.mock.calls.length).toBe(calls);
		} finally {
			list.mockRestore();
		}
	});

	it("#24: the Data section lists on open and after an action in it, not on every change", async () => {
		const list = vi.spyOn(CpbaseStore.prototype, "listSnapshots");
		try {
			const { h, root } = await mount();
			root.querySelector<HTMLButtonElement>('.cp-rail [aria-label="Data"]')!.click();
			await settle();
			const opened = list.mock.calls.length;
			expect(opened).toBeGreaterThan(0);

			await h.app.tasks.create({ title: "Elsewhere" });
			await settle();
			expect(list.mock.calls.length).toBe(opened);

			(byText(root, "button", "Export CSV") as HTMLButtonElement).click();
			await settle();
			expect(list.mock.calls.length).toBeGreaterThan(opened);
		} finally {
			list.mockRestore();
		}
	});

	it("#24: the Data section lists again when it becomes visible again", async () => {
		const list = vi.spyOn(CpbaseStore.prototype, "listSnapshots");
		try {
			const { root } = await mount();
			const rail = (name: string) => root.querySelector<HTMLButtonElement>(`.cp-rail [aria-label="${name}"]`)!;
			rail("Data").click();
			await settle();
			const first = list.mock.calls.length;
			rail("Tasks").click();
			await settle();
			expect(list.mock.calls.length).toBe(first);
			rail("Data").click();
			await settle();
			expect(list.mock.calls.length).toBeGreaterThan(first);
		} finally {
			list.mockRestore();
		}
	});

	it("#24: a status change or a reload while the Data section is open lists again, an ordinary edit does not", async () => {
		const list = vi.spyOn(CpbaseStore.prototype, "listSnapshots");
		const conflicts = vi.spyOn(CpbaseStore.prototype, "listConflicts");
		try {
			const { h, root } = await mount();
			root.querySelector<HTMLButtonElement>('.cp-rail [aria-label="Data"]')!.click();
			await settle();
			expect(root.querySelector(".cp-data")?.textContent).toContain("No open conflicts.");
			let calls = list.mock.calls.length;

			// A conflict arrives from outside the section (a store event), then a notice resolves it.
			conflicts.mockResolvedValue([{ path: "c/x.cpbase", kind: "conflict", revision: "r-abc", writtenAt: "2026-10-10T10:00:00.000Z", stamp: "1" }]);
			h.app.store.notifyStatus();
			await settle();
			expect(list.mock.calls.length).toBeGreaterThan(calls);
			expect(root.querySelector(".cp-data")?.textContent).toContain("Conflict copy r-abc");
			calls = list.mock.calls.length;

			conflicts.mockResolvedValue([]);
			h.app.store.notifyReloaded();
			h.app.store.notifyStatus();
			await settle();
			expect(list.mock.calls.length).toBeGreaterThan(calls);
			expect(root.querySelector(".cp-data")?.textContent).toContain("No open conflicts.");
			calls = list.mock.calls.length;

			await h.app.tasks.create({ title: "Ordinary edit" });
			await settle();
			expect(list.mock.calls.length).toBe(calls);
		} finally {
			list.mockRestore();
			conflicts.mockRestore();
		}
	});

	it("export is disabled with a reason while read-only", async () => {
		const { h, root } = await mount();
		await makeReadOnly(h);
		h.app.store.notifyStatus();
		root.querySelector<HTMLButtonElement>('.cp-rail [aria-label="Data"]')!.click();
		await settle();
		const exportButton = byText(root, "button", "Export backup") as HTMLButtonElement;
		expect(exportButton.disabled).toBe(true);
		const reason = root.querySelector(`#${CSS.escape(exportButton.getAttribute("aria-describedby") ?? "none")}`);
		expect(reason?.textContent).toContain("read-only");
	});
});
