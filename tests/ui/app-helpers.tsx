import { type ComponentChild, render } from "preact";
import { afterEach, expect, vi } from "vitest";
import type { CheckpointApp } from "../../src/app/App";
import { EventBus } from "../../src/app/events";
import { type CheckpointSettings, DEFAULT_SETTINGS, type WeekStart } from "../../src/app/settings";
import type { Task } from "../../src/domain/types";
import type { JournalOp } from "../../src/persistence/journal";
import { AppRoot, type AppRootHandle } from "../../src/ui/AppRoot";
import type { ButtonSpec, MenuSpec, QuickAddPreset, UiHost } from "../../src/ui/host";
import { QuickAddForm } from "../../src/ui/QuickAddForm";
import { QuickAddModel } from "../../src/ui/quickadd/QuickAddModel";
import { type AppHarness, appHarness } from "../app/harness";
import { makeTask } from "../persistence/fixtures";

// The UI test kit: the one fake host, the one app mount, the Quick Add mounts, the event helpers and the small
// readers every tests/ui suite shares. What a test mounts through it is unmounted after the test, and the layout
// fakes it installs are removed then. Obsidian's element additions (`empty`, `createDiv`, `createEl`) come from
// dom-setup.ts, which vitest loads before every tests/ui file.

const cleanups: (() => void)[] = [];

/** Unmounts what the kit mounted and removes its fakes now; after each test this runs anyway (last). */
export function unmountAll(): void {
	for (const undo of cleanups.splice(0).reverse()) undo();
}
afterEach(unmountAll);

// -- The host and the app -----------------------------------------------------------------------------------------

/** A host that records notices, menus and opened notes, with scripted picker answers (UI tests). */
export class U1Host implements UiHost {
	readonly messages: string[] = [];
	readonly menus: MenuSpec[] = [];
	readonly opened: string[] = [];
	readonly noteEvents = new EventBus<{ note: string }>();
	nextCategory: string | null = null;
	nextIcon: string | null | undefined = undefined;
	constructor(protected readonly h: AppHarness) {}
	get app() {
		return this.h.app;
	}
	readonly openSection = () => undefined;
	startFocus: UiHost["startFocus"] = async () => undefined;
	focusGesture: UiHost["focusGesture"] = () => undefined;
	focusConfig: UiHost["focusConfig"] = () => ({ rounds: 4, focusSec: 1500, breakSec: 300, longBreakSec: 900 });
	setFocusConfig: UiHost["setFocusConfig"] = async () => undefined;
	habitDialog: UiHost["habitDialog"] = async () => undefined;
	reminderGesture: UiHost["reminderGesture"] = () => undefined;
	settings() {
		return DEFAULT_SETTINGS;
	}
	notify(m: string) {
		this.messages.push(m);
	}
	/** Records the error's text, after the context when there is one, as the Obsidian host shows it. */
	error(err: unknown, context?: string) {
		const message = err instanceof Error ? err.message : String(err);
		this.messages.push(context === undefined ? message : `${context}: ${message}`);
	}
	/** The Undo button of each notice, newest last, bound as the Obsidian host binds it (`store.undoFor`). */
	readonly undoButtons: (() => Promise<boolean>)[] = [];
	notifyUndo(m: string, label: string, mark: number) {
		this.messages.push(m);
		this.bindUndo(label, mark);
	}
	/** For tests that replace `notifyUndo`: binds the Undo button the way the host does. */
	bindUndo(label: string, mark: number): void {
		this.undoButtons.push(this.app.store.undoFor(mark, label));
	}
	/** Answers every confirmation with null (cancel). */
	async choose<T>(_title: string, _message: string, _buttons: ButtonSpec<T>[]): Promise<T | null> {
		return null;
	}
	async prompt() {
		return null;
	}
	/** The `onClose` of each menu shown, parallel to `menus`. */
	readonly closers: (() => void)[] = [];
	showMenu(_e: unknown, items: MenuSpec, onClose?: () => void) {
		this.menus.push(items);
		this.closers.push(onClose ?? (() => undefined));
	}
	/** Dismisses the last menu the way Escape or a click outside does: its close signal, no pick. */
	dismissMenu() {
		this.closers.at(-1)?.();
	}
	attachTokenSuggest() {
		return { isOpen: () => false, dispose: () => undefined };
	}
	resolveNoteLinks(): string[] {
		return [];
	}
	async pickNote(): Promise<string | null> {
		return null;
	}
	async pickTask() {
		return null;
	}
	async pickCategory() {
		return this.nextCategory;
	}
	async pickIcon() {
		return this.nextIcon;
	}
	quickAdd(_preset?: QuickAddPreset) {}
	openNote(p: string) {
		this.opened.push(p);
	}
	async renderNote(_p: string, el: HTMLElement) {
		el.textContent = "";
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

/** An Undo notice: its text and the store label its Undo is bound to. */
export interface Notice {
	message: string;
	label: string;
}

/** Records the host's Undo notices in the returned list (not in `messages`); their Undo buttons stay bound. */
export function recordNotices(host: U1Host): Notice[] {
	const notices: Notice[] = [];
	host.notifyUndo = (message: string, label: string, mark: number) => {
		notices.push({ message, label });
		host.bindUndo(label, mark);
	};
	return notices;
}

export const lastNotice = (m: { notices: Notice[] }): Notice | undefined => m.notices[m.notices.length - 1];

/** Lets pending promises and zero-delay timers run, so Preact has re-rendered; also works while timers are faked. */
export async function settle(): Promise<void> {
	if (vi.isFakeTimers()) {
		for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
		return;
	}
	for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

/** `settle` plus time for Preact's passive effects (it runs them after a frame or 100 ms). */
export async function flushEffects(): Promise<void> {
	await settle();
	await new Promise((r) => setTimeout(r, 120));
	await settle();
}

/** A new element under `parent`, removed (with whatever is rendered into it) after the test. */
function attach(parent: HTMLElement): { root: HTMLElement; unmount: () => void } {
	const root = document.createElement("div");
	parent.appendChild(root);
	let live = true;
	const unmount = () => {
		if (!live) return;
		live = false;
		render(null, root);
		root.remove();
	};
	cleanups.push(unmount);
	return { root, unmount };
}

/** Renders a component into a new element under `parent` (the body by default); unmounted after the test. */
export function mountNode(node: ComponentChild, parent: HTMLElement = document.body): HTMLElement {
	const { root } = attach(parent);
	render(node, root);
	return root;
}

export interface AppMount<H extends U1Host = U1Host> {
	h: AppHarness;
	host: H;
	root: HTMLElement;
	handle: { current: AppRootHandle | null };
	/** Re-renders the app (settings and the clock are read on render). */
	rerender: () => Promise<void>;
	unmount: () => void;
}

export interface AppMountOptions<H extends U1Host> {
	/** A harness the test seeded first; a new one otherwise. */
	harness?: AppHarness;
	/** Builds the host, for a host with extras (a subclass of U1Host). */
	host?: (h: AppHarness) => H;
}

/**
 * Mounts the whole app (AppRoot) on a real store. The harness clock is 2026-10-01T10:00Z, so the display zone
 * (Europe/Berlin) shows Thursday 2026-10-01, 12:00. `settings` are laid over the defaults.
 */
export async function mountApp<H extends U1Host = U1Host>(settings: Partial<CheckpointSettings> = {}, opts: AppMountOptions<H> = {}): Promise<AppMount<H>> {
	const h = opts.harness ?? (await appHarness());
	const host = opts.host?.(h) ?? (new U1Host(h) as H);
	if (Object.keys(settings).length > 0) host.settings = () => ({ ...DEFAULT_SETTINGS, ...settings });
	const { root, unmount } = attach(document.body);
	const handle: { current: AppRootHandle | null } = { current: null };
	const view = () => <AppRoot host={host} initialSection={null} handle={(x) => (handle.current = x)} />;
	render(view(), root);
	await settle();
	return {
		h,
		host,
		root,
		handle,
		rerender: async () => {
			render(view(), root);
			await settle();
		},
		unmount,
	};
}

interface ElementOptions {
	cls?: string;
	text?: string;
	type?: string;
	attr?: Record<string, string>;
}

/** An element with Obsidian's additions (installed by dom-setup.ts), as a Modal's `modalEl` and `contentEl` are. */
export type ObsidianElement = HTMLElement & {
	addClass(...c: string[]): void;
	toggleClass(c: string | string[], on: boolean): void;
	empty(): void;
	createEl(tag: string, o?: ElementOptions): ObsidianElement;
	createDiv(o?: ElementOptions): ObsidianElement;
	createSpan(o?: ElementOptions): ObsidianElement;
};

export const obsidianElement = (tag = "div") => document.createElement(tag) as ObsidianElement;

// -- Quick Add ----------------------------------------------------------------------------------------------------

export interface QuickFormOptions {
	app?: CheckpointApp;
	preset?: QuickAddPreset;
	locale?: "en" | "en-GB";
	weekStart?: WeekStart;
	eveningTime?: string;
	keepOpen?: boolean;
	pickNote?: () => Promise<string | null>;
	resolveNote?: (text: string) => string[];
	/** Where the form goes (the body by default). */
	parent?: HTMLElement;
	/** Records the form's errors in `errors` instead of failing the test on them. */
	recordErrors?: boolean;
}

/** The token suggester the form attaches to its input: whether it shows as open, and the pick it reports. */
export interface QuickSuggest {
	open: boolean;
	input: HTMLInputElement | null;
	onBind: Parameters<UiHost["attachTokenSuggest"]>[1] | null;
	disposed: number;
}

export interface QuickForm {
	app: CheckpointApp;
	root: HTMLElement;
	/** The title of each save. */
	saved: string[];
	/** The warnings each save reported (the text after "Added" in the notice). */
	warnings: string[][];
	errors: unknown[];
	closed: { n: number };
	suggest: QuickSuggest;
	/** What the modal's Escape calls first (QuickAddForm's registerEscape). */
	closeOverlay: () => boolean;
	/** Unmounts the form early (it is unmounted after the test anyway). */
	unmount: () => void;
}

/** Mounts the Quick Add form on a real app (a new harness unless `app` is given), recording what it reports. */
export async function mountQuickForm(opts: QuickFormOptions = {}): Promise<QuickForm> {
	const app = opts.app ?? (await appHarness()).app;
	const { root, unmount } = attach(opts.parent ?? document.body);
	const m: QuickForm = {
		app,
		root,
		saved: [],
		warnings: [],
		errors: [],
		closed: { n: 0 },
		suggest: { open: false, input: null, onBind: null, disposed: 0 },
		closeOverlay: () => false,
		unmount,
	};
	render(
		<QuickAddForm
			app={app}
			preset={opts.preset ?? {}}
			locale={() => opts.locale ?? "en"}
			weekStart={() => opts.weekStart ?? "MO"}
			eveningTime={() => opts.eveningTime ?? "20:00"}
			keepOpen={() => opts.keepOpen ?? false}
			pickNote={opts.pickNote ?? (async () => null)}
			resolveNote={opts.resolveNote ?? (() => [])}
			setIcon={(el, icon) => el.setAttribute("data-icon", icon)}
			attachTokenSuggest={(input, onBind) => {
				m.suggest.input = input;
				m.suggest.onBind = onBind;
				return { isOpen: () => m.suggest.open, dispose: () => void m.suggest.disposed++ };
			}}
			onSaved={(title, warnings) => {
				m.saved.push(title);
				m.warnings.push(warnings);
			}}
			onError={(err) => {
				m.errors.push(err);
				if (opts.recordErrors !== true) throw err;
			}}
			onClose={() => void m.closed.n++}
			registerEscape={(fn) => {
				m.closeOverlay = fn;
			}}
		/>,
		root,
	);
	await settle();
	return m;
}

/** The parts of a Quick Add form: the title input, the tools and their popovers, a day of the date popover's month. */
export const titleInput = (root: ParentNode) => root.querySelector<HTMLInputElement>(".cp-quick-add-title")!;
export const qaTool = (root: ParentNode, label: string) => root.querySelector<HTMLButtonElement>(`.cp-qa-tool[aria-label="${label}"]`)!;
export const dateTool = (root: ParentNode) => qaTool(root, "Date");
export const moreTool = (root: ParentNode) => qaTool(root, "Priority, list, tags and note");
export const datePop = (root: ParentNode) => root.querySelector<HTMLElement>(".cp-date-pop");
export const morePop = (root: ParentNode) => root.querySelector<HTMLElement>(".cp-more-pop");
export const popDay = (root: ParentNode, date: string) => root.querySelector<HTMLButtonElement>(`.cp-cal-day[data-date="${date}"]`)!;
/** The tasks the form's app holds. */
export const formTasks = (m: { app: CheckpointApp }) => [...m.app.store.state.tasks.values()];

export interface QuickModelOptions {
	/** The harness to build on; a new one otherwise. */
	h?: AppHarness;
	/** Sets the harness clock first (an ISO instant). */
	at?: string;
	preset?: QuickAddPreset;
	keepOpen?: boolean;
}

export interface QuickModel {
	h: AppHarness;
	m: QuickAddModel;
	saved: string[];
	warnings: string[][];
	closed: { n: number };
}

/** A Quick Add model without the form (English, no notes); an error fails the test. */
export async function quickModel(opts: QuickModelOptions = {}): Promise<QuickModel> {
	const h = opts.h ?? (await appHarness());
	if (opts.at !== undefined) h.clock.set(opts.at);
	const saved: string[] = [];
	const warnings: string[][] = [];
	const closed = { n: 0 };
	const m = new QuickAddModel(
		{
			app: h.app,
			preset: opts.preset ?? {},
			locale: () => "en",
			resolveNote: () => [],
			onSaved: (title, w) => {
				saved.push(title);
				warnings.push(w);
			},
			onError: (e) => {
				throw e;
			},
			keepOpen: () => opts.keepOpen ?? true,
			onClose: () => void closed.n++,
		},
		() => undefined,
	);
	return { h, m, saved, warnings, closed };
}

export interface PopoverLayout {
	barTop: number;
	barRight?: number;
	popHeight: number;
	popWidth?: number;
	windowHeight: number;
	windowWidth?: number;
	clipBottom?: number;
	statusTop?: number;
}

/**
 * Fake layout for the Quick Add popovers (happy-dom has none): the add bar (or an `.anchor`) is 52 px high at `barTop`,
 * a popover is `popHeight` high below it, a `.fake-clip` container ends at `clipBottom`, a `.status-bar` starts at
 * `statusTop`; the window is `windowHeight` by `windowWidth`. Returns the layout, which a test may change (a scroll moves
 * the bar). Removed after the test, with those elements.
 */
export function fakePopoverLayout(opts: PopoverLayout): PopoverLayout {
	const box = (top: number, height: number, left = 0, width = 0) => rect(left, top, left + width, top + height);
	const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
		if (this.classList.contains("cp-qa-barwrap") || this.classList.contains("anchor")) return box(opts.barTop, 52, (opts.barRight ?? 500) - 400, 400);
		if (this.classList.contains("cp-pop") || this.classList.contains("pop")) return box(opts.barTop + 60, opts.popHeight, 0, opts.popWidth ?? 336);
		if (this.classList.contains("fake-clip")) return box(0, opts.clipBottom ?? 0, 0, 600);
		if (this.classList.contains("status-bar")) return box(opts.statusTop ?? 0, 30);
		return box(0, 0);
	});
	const h = window.innerHeight;
	const w = window.innerWidth;
	Object.defineProperty(window, "innerHeight", { value: opts.windowHeight, configurable: true });
	Object.defineProperty(window, "innerWidth", { value: opts.windowWidth ?? 1200, configurable: true });
	cleanups.push(() => {
		spy.mockRestore();
		Object.defineProperty(window, "innerHeight", { value: h, configurable: true });
		Object.defineProperty(window, "innerWidth", { value: w, configurable: true });
		document.querySelectorAll(".fake-clip, .status-bar, .anchor").forEach((e) => e.remove());
	});
	return opts;
}

// -- Events -------------------------------------------------------------------------------------------------------

/** Clicks the element (it must exist) and lets the app re-render. */
export async function click(el: Element | null | undefined): Promise<void> {
	if (el === null || el === undefined) throw new Error("element not found");
	(el as HTMLElement).click();
	await settle();
}

/** Sets a field's value and sends the event typing (or picking, with "change") sends; no re-render yet. */
export function fill(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string, event: "input" | "change" = "input"): void {
	el.value = value;
	el.dispatchEvent(new Event(event, { bubbles: true }));
}

/** `fill`, then lets the app re-render, as between real key presses. */
export async function typeInto(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string, event: "input" | "change" = "input"): Promise<void> {
	fill(el, value, event);
	await settle();
}

/** Sends a keydown and returns it (`defaultPrevented` tells whether a handler took it); no re-render yet. */
export function keydown(el: Element, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
	const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
	el.dispatchEvent(e);
	return e;
}

/** `keydown`, then lets the app re-render. */
export async function pressKey(el: Element, key: string, init: KeyboardEventInit = {}): Promise<KeyboardEvent> {
	const e = keydown(el, key, init);
	await settle();
	return e;
}

/** `pressKey` on the focused element. */
export const pressFocused = (key: string, init: KeyboardEventInit = {}): Promise<KeyboardEvent> => pressKey(document.activeElement!, key, init);

/** A pointer event at (x, y): the primary mouse button unless `init` says otherwise. */
export function pointer(type: string, x: number, y: number, init: { button?: number; pointerType?: string; id?: number } = {}): PointerEvent {
	return new PointerEvent(type, {
		bubbles: true,
		cancelable: true,
		clientX: x,
		clientY: y,
		button: init.button ?? 0,
		pointerId: init.id ?? 1,
		pointerType: init.pointerType ?? "mouse",
		isPrimary: true,
	});
}

/** Presses on `el`, moves in two steps and (unless `release` is false) releases at `to`, with the click a browser sends. */
export async function dragTo(el: Element, from: { x: number; y: number }, to: { x: number; y: number }, release = true): Promise<void> {
	el.dispatchEvent(pointer("pointerdown", from.x, from.y));
	el.dispatchEvent(pointer("pointermove", from.x + 10, from.y + 10));
	el.dispatchEvent(pointer("pointermove", to.x, to.y));
	await settle();
	if (release) await releaseAt(el, to);
}

/** Releases the pointer (and sends the click a browser sends) after a `dragTo(..., false)`. */
export async function releaseAt(el: Element, to: { x: number; y: number }): Promise<void> {
	el.dispatchEvent(pointer("pointerup", to.x, to.y));
	el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
	await settle();
}

/** A layout box from its edges (happy-dom has no layout; tests stub `getBoundingClientRect` with these). */
export const rect = (left: number, top: number, right: number, bottom: number): DOMRect =>
	({ left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) });

// -- Reading the DOM ----------------------------------------------------------------------------------------------

/** The first match, which must exist. */
export const q = <T extends HTMLElement = HTMLElement>(root: ParentNode, sel: string): T => {
	const found = root.querySelector<T>(sel);
	if (found === null) throw new Error(`no ${sel}`);
	return found;
};
export const qa = <T extends HTMLElement = HTMLElement>(root: ParentNode, sel: string): T[] => [...root.querySelectorAll<T>(sel)];
/** The text of an element with its whitespace collapsed ("" for none). */
export const text = (el: Element | null | undefined): string => el?.textContent?.replace(/\s+/gu, " ").trim() ?? "";
export const byLabel = (root: ParentNode, label: string) => root.querySelector<HTMLElement>(`[aria-label="${label}"]`);
/** The Tasks section of a mounted app. */
export const tasksEl = (m: { root: HTMLElement }) => q(m.root, ".cp-tasks");
/** The sidebar entry whose text contains `name`. */
export const sidebarItem = (root: ParentNode, name: string) =>
	[...root.querySelectorAll<HTMLElement>(".cp-sidebar-item")].find((e) => e.textContent?.includes(name))!;

/** The rows of the sidebar's tag tree, their labels, and the row of one label. */
export const tagRows = (m: { root: HTMLElement }) => [...m.root.querySelectorAll<HTMLElement>(".cp-sidebar .cp-tag-tree .cp-sidebar-item")];
export const tagLabels = (m: { root: HTMLElement }) => tagRows(m).map((r) => r.querySelector(".cp-sidebar-label")!.textContent);
export const tagRow = (m: { root: HTMLElement }, label: string) => tagRows(m).find((r) => r.querySelector(".cp-sidebar-label")!.textContent === label)!;

/** Right-clicks `el` and returns the menu the host was asked to show. */
export async function contextMenu(m: { host: U1Host }, el: Element): Promise<MenuSpec> {
	el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
	await settle();
	return m.host.menus.at(-1)!;
}

export function menuItem(menu: MenuSpec | undefined, title: string) {
	const item = menu?.find((i) => i !== "separator" && i.title === title);
	if (item === undefined || item === "separator") throw new Error(`No menu item "${title}"`);
	return item;
}

/**
 * Where an aria-label is allowed: elements the pointer actually targets as a control, where a tooltip naming the
 * control is wanted (icon-only buttons, inputs without visible text).
 * - button, input, select, textarea, a: native interactive controls. This covers role=tab (the tabs are buttons), the
 *   task checkbox and the add-bar input.
 * - [role=img]: the "Has description note" meta icon, whose tooltip is the point.
 * Everything else (nav, div/section/ul with role listbox, group, list, tablist, dialog, ...) is a container: hovering
 * anywhere inside it would surface the tooltip, anchored to the container rather than the pointer. Rows (role=option)
 * are deliberately not on the list: their text content names them.
 */
export const ARIA_LABEL_ALLOWED = ["button", "input", "select", "textarea", "a", '[role="img"]'];

/** Elements in `root` that carry an aria-label but are not one of the `allowed` controls (Obsidian shows it as a tooltip). */
export function strayAriaLabels(root: ParentNode, allowed: string[] = ARIA_LABEL_ALLOWED): string[] {
	return [...root.querySelectorAll<HTMLElement>("[aria-label]")]
		.filter((el) => !allowed.some((sel) => el.matches(sel)))
		.map((el) => `<${el.tagName.toLowerCase()} class="${el.className}" role="${el.getAttribute("role") ?? ""}" aria-label="${el.getAttribute("aria-label")}">`);
}

/** The accessible name that aria-labelledby resolves to, or null if it does not resolve. */
export function labelledBy(el: Element): string | null {
	const ids = (el.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
	if (ids.length === 0) return null;
	const doc = el.ownerDocument;
	const parts = ids.map((id) => doc.getElementById(id)?.textContent?.trim() ?? "");
	return parts.some((p) => p === "") ? null : parts.join(" ");
}

/** Every aria-labelledby in scope resolves to non-empty text, and ids are unique per document. */
export function expectLabelsResolve(root: ParentNode): void {
	const ids = [...document.querySelectorAll("[id]")].map((e) => e.id);
	expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
	for (const el of root.querySelectorAll("[aria-labelledby]")) {
		expect(labelledBy(el), `unresolved aria-labelledby on <${el.tagName.toLowerCase()} class="${el.className}">`).not.toBeNull();
	}
}

// -- The store ----------------------------------------------------------------------------------------------------

/** A date without a time, and a time in a zone, as a task stores them (`tests/persistence/fixtures.ts`). */
export { at, day } from "../persistence/fixtures";

/** The task with this title, which must exist. */
export function taskOf(m: { h: { app: CheckpointApp } }, title: string): Task {
	const found = [...m.h.app.store.state.tasks.values()].find((t) => t.title === title);
	if (found === undefined) throw new Error(`no task "${title}"`);
	return found;
}

/** How many writes Undo can take back. */
export const undoDepth = (m: { h: { app: CheckpointApp } }) => (m.h.app.store as unknown as { undoStack: unknown[] }).undoStack.length;

/** The id of the n-th seeded task (1-based), and the 0-based index of a seeded task's id (-1 for none). */
import { taskId } from "../helpers";
export { taskId };
export const indexOfTaskId = (id: string | undefined) => (id === undefined ? -1 : parseInt(id.slice(-12), 16) - 1);
/** The row of seeded task `i` (0-based) under `scope`, or null when it is not drawn. */
export const rowOf = (scope: ParentNode, i: number) => scope.querySelector<HTMLElement>(`.cp-task-row[data-task-id="${taskId(i + 1)}"]`);
/** The titles of the Tasks section's rows, in order. */
export const rowTitles = (m: AppMount) => [...m.root.querySelectorAll(".cp-tasks .cp-task-row .cp-task-title")].map((t) => t.textContent.trim());
/** The index of the focused seeded task, or -1. */
export const focusedIndex = () => indexOfTaskId((document.activeElement as HTMLElement | null)?.dataset?.taskId);

/**
 * Commits `count` open Inbox tasks "Task 0".."Task n-1" in that manual order in one write, with ids `taskId(1..n)`;
 * `patch(i)` adds fields to task i.
 */
export function seedTasks(h: AppHarness, count: number, patch: (i: number) => Partial<Task> = () => ({})): void {
	const data = h.store.data;
	const tasks = new Map(data.tasks);
	const ops: JournalOp[] = [];
	for (let i = 0; i < count; i++) {
		const t: Task = makeTask(taskId(i + 1), { title: `Task ${i}`, sortKey: `V${i.toString(36).padStart(4, "0")}`, ...patch(i) });
		tasks.set(t.id, t);
		ops.push({ c: "tasks", id: t.id, v: t });
	}
	h.store.commit({ ...data, tasks }, ops);
}
