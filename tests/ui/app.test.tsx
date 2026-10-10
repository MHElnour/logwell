// @vitest-environment happy-dom
import { render } from "preact";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { EventBus } from "../../src/app/events";
import { DEFAULT_SETTINGS } from "../../src/app/settings";
import { CpbaseStore } from "../../src/persistence/CpbaseStore";
import { AppRoot } from "../../src/ui/AppRoot";
import type { ButtonSpec, MenuSpec, QuickAddPreset, UiHost } from "../../src/ui/host";
import { QuickAddForm } from "../../src/ui/QuickAddForm";
import { TOGGLE_COMPLETE_EVENT } from "../../src/ui/TaskList";
import { type AppHarness, appHarness, makeReadOnly } from "../app/harness";

// Smoke tests of the real Preact UI against the real services, with a fake
// host in place of Obsidian. They catch runtime errors and check the wiring of
// tasks, notes, subtasks and the app shell that the e2e specs
// repeat inside Obsidian.

beforeAll(() => {
	// Obsidian adds HTMLElement.empty(); the UI uses it through icons.
	(HTMLElement.prototype as unknown as { empty: () => void }).empty = function (this: HTMLElement) {
		this.replaceChildren();
	};
});

class FakeHost implements UiHost {
	readonly messages: string[] = [];
	readonly menus: MenuSpec[] = [];
	readonly opened: string[] = [];
	chooseAnswers: unknown[] = [];
	nextNote: string | null = null;
	readonly noteEvents = new EventBus<{ note: string }>();

	constructor(private readonly h: AppHarness) {}

	get app() {
		return this.h.app;
	}

	readonly openSection = () => undefined;
	startFocus = async () => undefined;
	focusGesture = () => undefined;
	focusConfig = () => ({ rounds: 4, focusSec: 1500, breakSec: 300, longBreakSec: 900 });
	setFocusConfig = async () => undefined;
	habitDialog: UiHost["habitDialog"] = async () => undefined;
	reminderGesture: UiHost["reminderGesture"] = () => undefined;
	settings() {
		return DEFAULT_SETTINGS;
	}
	notify(message: string) {
		this.messages.push(message);
	}
	error(err: unknown) {
		this.messages.push(err instanceof Error ? err.message : String(err));
	}
	/** The Undo button of each notice, bound as the Obsidian host binds it (`store.undoFor`). */
	readonly undoButtons: (() => Promise<boolean>)[] = [];
	notifyUndo(message: string, label: string, mark: number) {
		this.messages.push(message);
		this.undoButtons.push(this.app.store.undoFor(mark, label));
	}
	async choose<T>(_t: string, message: string, buttons: ButtonSpec<T>[]): Promise<T | null> {
		this.messages.push(message);
		const answer = this.chooseAnswers.shift();
		return answer === undefined ? (buttons[0]?.value ?? null) : (answer as T | null);
	}
	async prompt() {
		return null;
	}
	showMenu(_evt: unknown, items: MenuSpec) {
		this.menus.push(items);
	}
	attachTokenSuggest() {
		return { isOpen: () => false, dispose: () => undefined };
	}
	resolveNoteLinks(): string[] {
		return [];
	}
	async pickNote() {
		return this.nextNote;
	}
	async pickTask() {
		return null;
	}
	async pickCategory() {
		return null;
	}
	readonly presets: QuickAddPreset[] = [];
	quickAdd(preset: QuickAddPreset = {}) {
		this.messages.push("quick add");
		this.presets.push(preset);
	}
	openNote(path: string) {
		this.opened.push(path);
	}
	async renderNote(path: string, el: HTMLElement) {
		el.textContent = this.h.notes.files.get(path) ?? "";
		return () => undefined;
	}
	onNotesChanged(listener: (path: string) => void) {
		return this.noteEvents.on("note", listener);
	}
	async exportBackup() {}
	async exportCsv() {}
	async importBackup() {}
	setIcon(el: HTMLElement, icon: string) {
		// Like Obsidian: an unknown name leaves the element empty, a known one gets an svg child.
		if (icon.startsWith("unknown-")) return;
		el.setAttribute("data-icon", icon);
		el.appendChild(el.ownerDocument.createElement("svg"));
	}
}

async function settleUi(): Promise<void> {
	for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

function byText(root: HTMLElement, selector: string, text: string): HTMLElement {
	const el = [...root.querySelectorAll<HTMLElement>(selector)].find((e) => e.textContent?.trim().includes(text));
	if (el === undefined) throw new Error(`No ${selector} with text "${text}"`);
	return el;
}

/** Types a value and lets Preact re-render, as between real key presses. */
async function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
	input.value = value;
	input.dispatchEvent(new Event("input", { bubbles: true }));
	await settleUi();
}

function press(el: HTMLElement, key: string, extra: KeyboardEventInit = {}): void {
	el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...extra }));
}

let container: HTMLElement | null = null;
afterEach(() => {
	if (container !== null) render(null, container);
	container?.remove();
	container = null;
});

async function mount() {
	const h = await appHarness();
	const host = new FakeHost(h);
	container = document.createElement("div");
	document.body.appendChild(container);
	render(<AppRoot host={host} initialSection={null} handle={() => undefined} />, container);
	await settleUi();
	return { h, host, root: container };
}

describe("app UI (smoke)", () => {
	it("AS-01: adds a task from the inline bar and shows it in Inbox", async () => {
		const { h, root } = await mount();
		expect(root.querySelector(".cp-main-title")?.textContent).toBe("Today");
		byText(root, ".cp-sidebar-item", "Inbox").click();
		await settleUi();
		const input = root.querySelector<HTMLInputElement>(".cp-add-bar input")!;
		await typeInto(input, "Buy milk");
		press(input, "Enter");
		await settleUi();
		expect(byText(root, ".cp-task-row", "Buy milk")).toBeDefined();
		expect(h.app.store.state.tasks.size).toBe(1);
		expect(h.notes.writes).toEqual([]);
	});

	it("AS-02 / TASK-02 / AS-06: details, title restore, note link and missing note", async () => {
		const { h, host, root } = await mount();
		h.notes.files.set("Plan.md", "Plan body text");
		const { task } = await h.app.tasks.create({ title: "Plan the trip" });
		byText(root, ".cp-sidebar-item", "Inbox").click();
		await settleUi();
		byText(root, ".cp-task-row", "Plan the trip").click();
		await settleUi();
		const title = root.querySelector<HTMLTextAreaElement>(".cp-details-title")!;
		expect(title.value).toBe("Plan the trip");

		await typeInto(title, "   ");
		title.dispatchEvent(new FocusEvent("blur"));
		await settleUi();
		expect(title.value).toBe("Plan the trip");
		expect(host.messages).toContain("A task needs a title. The previous title was restored.");

		host.nextNote = "Plan.md";
		byText(root, "button", "Link existing note").click();
		await settleUi();
		expect(root.querySelector(".cp-note-preview")?.textContent).toBe("Plan body text");
		expect(h.app.store.state.tasks.get(task.id)?.descriptionNote?.path).toBe("Plan.md");
		expect(root.querySelectorAll('.cp-description [aria-label="Open note"]').length).toBe(1);
		expect([...root.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Open note")).toHaveLength(0);
		root.querySelector<HTMLElement>('.cp-description [aria-label="Open note"]')!.click();
		expect(host.opened).toEqual(["Plan.md"]);

		h.notes.files.delete("Plan.md");
		host.noteEvents.emit("note", "Plan.md");
		await settleUi();
		expect(root.querySelector(".cp-description.is-missing")?.textContent).toContain("Description note not found: Plan.md");
		byText(root, "button", "Unlink").click();
		await settleUi();
		expect(h.app.store.state.tasks.get(task.id)?.descriptionNote).toBeNull();
	});

	it("SUB-03: completing a parent asks first; cancel changes nothing", async () => {
		const { h, host, root } = await mount();
		const parent = (await h.app.tasks.create({ title: "Parent" })).task;
		byText(root, ".cp-sidebar-item", "Inbox").click();
		await settleUi();
		byText(root, ".cp-task-row", "Parent").click();
		await settleUi();
		const sub = root.querySelector<HTMLInputElement>(".cp-details-section .cp-qa-input")!;
		await typeInto(sub, "Child");
		press(sub, "Enter");
		await settleUi();
		expect(h.app.tasks.subtaskCount(parent.id)).toBe(1);

		host.chooseAnswers = [null];
		root.querySelector<HTMLInputElement>(".cp-details-top .cp-task-checkbox")!.click();
		await settleUi();
		expect(host.messages.some((m) => m.includes("has 1 open subtask"))).toBe(true);
		expect(h.app.store.state.tasks.get(parent.id)?.status).toBe("open");

		host.chooseAnswers = [true];
		root.querySelector<HTMLInputElement>(".cp-details-top .cp-task-checkbox")!.click();
		await settleUi();
		expect([...h.app.store.state.tasks.values()].every((t) => t.status === "completed")).toBe(true);
	});

	it("UI-01: switching sections keeps each section's state; keyboard and menu work", async () => {
		const { h, host, root } = await mount();
		await h.app.tasks.create({ title: "Alpha" });
		await h.app.tasks.create({ title: "Beta" });
		await h.app.tasks.create({ title: "Gamma" });
		byText(root, ".cp-sidebar-item", "Inbox").click();
		await settleUi();
		const rows = root.querySelectorAll<HTMLElement>(".cp-task-row");
		expect(rows).toHaveLength(3);
		rows[0]!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
		expect(host.menus[0]?.some((i) => i !== "separator" && i.title === "Delete")).toBe(true);
		press(rows[0]!, "Enter", { ctrlKey: true });
		await settleUi();
		expect([...h.app.store.state.tasks.values()].find((t) => t.title === "Alpha")?.status).toBe("completed");

		// Inside Obsidian, Cmd/Ctrl+Enter arrives as this event from the view's keymap scope.
		byText(root, ".cp-task-row", "Gamma").dispatchEvent(new CustomEvent(TOGGLE_COMPLETE_EVENT));
		await settleUi();
		expect([...h.app.store.state.tasks.values()].find((t) => t.title === "Gamma")?.status).toBe("completed");

		byText(root, ".cp-task-row", "Beta").click();
		await settleUi();
		root.querySelector<HTMLButtonElement>('.cp-rail [aria-label="Search"]')!.click();
		await settleUi();
		const search = root.querySelector<HTMLInputElement>('.cp-search-box input[type="search"]')!;
		await typeInto(search, "alp");
		await settleUi();
		expect(byText(root, ".cp-search .cp-task-row", "Alpha")).toBeDefined();
		root.querySelector<HTMLButtonElement>('.cp-rail [aria-label="Data"]')!.click();
		await settleUi();
		expect(byText(root, "button", "Export backup")).toBeDefined();
		root.querySelector<HTMLButtonElement>('.cp-rail [aria-label="Tasks"]')!.click();
		await settleUi();
		expect(root.querySelector(".cp-main-title")?.textContent).toBe("Inbox");
		expect(root.querySelector<HTMLTextAreaElement>(".cp-details-title")?.value).toBe("Beta");
	});

	it("deletes with an undo notice and shows the batch in Trash", async () => {
		const { h, host, root } = await mount();
		await h.app.tasks.create({ title: "Gone soon" });
		byText(root, ".cp-sidebar-item", "Inbox").click();
		await settleUi();
		byText(root, ".cp-task-row", "Gone soon").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
		const del = host.menus[0]?.find((i) => i !== "separator" && i.title === "Delete");
		if (del === undefined || del === "separator") throw new Error("no delete item");
		del.run();
		await settleUi();
		expect(host.messages).toContain('Moved "Gone soon" to Trash.');
		byText(root, ".cp-sidebar-item", "Trash").click();
		await settleUi();
		byText(root, ".cp-trash-entry button", "Restore").click();
		await settleUi();
		expect(h.app.store.state.tasks.size).toBe(1);
	});

	it("hidden Tasks catches up on its first visible render after a task is completed or trashed", async () => {
		const { h, root } = await mount();
		const done = (await h.app.tasks.create({ title: "Finish me" })).task;
		const gone = (await h.app.tasks.create({ title: "Bin me" })).task;
		await h.app.tasks.create({ title: "Stay put" });
		byText(root, ".cp-sidebar-item", "Inbox").click();
		await settleUi();
		const count = (label: string): string | undefined => byText(root, ".cp-sidebar-item", label).querySelector(".cp-count")?.textContent ?? undefined;
		expect(root.querySelectorAll(".cp-task-row")).toHaveLength(3);
		expect(count("Inbox")).toBe("3");
		expect(count("Trash")).toBeUndefined();

		// Leave Tasks (it stays mounted but hidden), then change what it shows.
		root.querySelector<HTMLButtonElement>('.cp-rail [aria-label="Data"]')!.click();
		await settleUi();
		await h.app.tasks.complete(done.id);
		await h.app.tasks.delete(gone.id);
		await settleUi();

		root.querySelector<HTMLButtonElement>('.cp-rail [aria-label="Tasks"]')!.click();
		await settleUi();
		expect(root.querySelector(".cp-main-title")?.textContent).toBe("Inbox");
		const titles = [...root.querySelectorAll(".cp-task-row")].map((r) => r.textContent ?? "");
		expect(titles).toHaveLength(1);
		expect(titles[0]).toContain("Stay put");
		expect(count("Inbox")).toBe("1");
		expect(count("Trash")).toBe("1");
		byText(root, ".cp-sidebar-item", "Trash").click();
		await settleUi();
		expect(byText(root, ".cp-trash-entry", "Bin me")).toBeDefined();

		// Emptying the Trash changes only `trash`, not `tasks`: the Trash count must follow it too.
		root.querySelector<HTMLButtonElement>('.cp-rail [aria-label="Data"]')!.click();
		await settleUi();
		await h.app.tasks.emptyTrash();
		await settleUi();
		root.querySelector<HTMLButtonElement>('.cp-rail [aria-label="Tasks"]')!.click();
		await settleUi();
		expect(count("Trash")).toBeUndefined();
		expect(root.querySelector(".cp-trash-entry")).toBeNull();
	});

	it("QA-01: the header + in a tag view presets that tag", async () => {
		const { h, host, root } = await mount();
		await h.app.tags.create("Work");
		await settleUi();
		byText(root, ".cp-sidebar-item", "Work").click();
		await settleUi();
		root.querySelector<HTMLButtonElement>('.cp-tasks .cp-main-header [aria-label="Quick add task"]')!.click();
		expect(host.presets).toEqual([{ categoryId: "inbox", date: null, tagKeys: ["work"] }]);
	});

	it("QA-01: Quick Add saves the preset tags", async () => {
		const h = await appHarness();
		await h.app.tags.create("work");
		container = document.createElement("div");
		document.body.appendChild(container);
		render(
			<QuickAddForm
				app={h.app}
				preset={{ tagKeys: ["work"] }}
				locale={() => "en"}
				weekStart={() => "MO"}
				setIcon={(el, icon) => el.setAttribute("data-icon", icon)}
				keepOpen={() => false}
				pickNote={async () => null}
				resolveNote={() => []}
				attachTokenSuggest={() => ({ isOpen: () => false, dispose: () => undefined })}
				onSaved={() => undefined}
				onError={(err) => {
					throw err;
				}}
				onClose={() => undefined}
			/>,
			container,
		);
		await settleUi();
		expect(container.querySelector(".cp-tag-input .cp-chip")?.textContent).toContain("@work");
		const title = container.querySelector<HTMLInputElement>(".cp-quick-add-title")!;
		await typeInto(title, "Plan the week");
		press(title, "Enter");
		await settleUi();
		expect([...h.app.store.state.tasks.values()].map((t) => t.tagKeys)).toEqual([["work"]]);
	});

	it("review #19: element IDs stay unique with details open in Tasks and Search", async () => {
		const { h, root } = await mount();
		await h.app.tasks.create({ title: "Alpha", scheduled: { kind: "date", date: "2026-10-01" } });
		await settleUi();
		byText(root, ".cp-tasks .cp-task-row", "Alpha").click();
		await settleUi();
		root.querySelector<HTMLButtonElement>('.cp-rail [aria-label="Search"]')!.click();
		await settleUi();
		await typeInto(root.querySelector<HTMLInputElement>('.cp-search-box input[type="search"]')!, "alp");
		byText(root, ".cp-search .cp-task-row", "Alpha").click();
		await settleUi();
		const details = root.querySelectorAll<HTMLElement>(".cp-details");
		expect(details).toHaveLength(2);
		// The date fields open from the date chip.
		for (const chip of root.querySelectorAll<HTMLButtonElement>(".cp-details .cp-due-chip")) chip.click();
		await settleUi();
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

	it("review #11: backups are listed only while the Data section is visible", async () => {
		const list = vi.spyOn(CpbaseStore.prototype, "listSnapshots");
		try {
			const { h, root } = await mount();
			await h.app.tasks.create({ title: "One" });
			await h.app.tasks.create({ title: "Two" });
			await settleUi();
			expect(list).not.toHaveBeenCalled();

			root.querySelector<HTMLButtonElement>('.cp-rail [aria-label="Data"]')!.click();
			await settleUi();
			expect(list).toHaveBeenCalled();

			root.querySelector<HTMLButtonElement>('.cp-rail [aria-label="Tasks"]')!.click();
			await settleUi();
			const calls = list.mock.calls.length;
			await h.app.tasks.create({ title: "Three" });
			await settleUi();
			expect(list.mock.calls.length).toBe(calls);
		} finally {
			list.mockRestore();
		}
	});

	it("review #16: export is disabled with a reason while read-only", async () => {
		const { h, root } = await mount();
		await makeReadOnly(h);
		h.app.store.notifyStatus();
		root.querySelector<HTMLButtonElement>('.cp-rail [aria-label="Data"]')!.click();
		await settleUi();
		const exportButton = byText(root, "button", "Export backup") as HTMLButtonElement;
		expect(exportButton.disabled).toBe(true);
		const reason = root.querySelector(`#${CSS.escape(exportButton.getAttribute("aria-describedby") ?? "none")}`);
		expect(reason?.textContent).toContain("read-only");
	});
});
