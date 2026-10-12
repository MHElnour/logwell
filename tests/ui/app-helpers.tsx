import { render } from "preact";
import { EventBus } from "../../src/app/events";
import { DEFAULT_SETTINGS } from "../../src/app/settings";
import { AppRoot } from "../../src/ui/AppRoot";
import type { MenuSpec, UiHost } from "../../src/ui/host";
import { type AppHarness, appHarness } from "../app/harness";

/** A host that records menus and icon names, with scripted picker answers (UI tests). */
export class U1Host implements UiHost {
	readonly messages: string[] = [];
	readonly menus: MenuSpec[] = [];
	readonly opened: string[] = [];
	readonly noteEvents = new EventBus<{ note: string }>();
	nextCategory: string | null = null;
	nextIcon: string | null | undefined = undefined;
	constructor(private readonly h: AppHarness) {}
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
	error(err: unknown) {
		this.messages.push(err instanceof Error ? err.message : String(err));
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
	async choose() {
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
	async pickNote() {
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
	quickAdd() {}
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

export const settle = async () => {
	for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

export async function mountU1(): Promise<{ h: AppHarness; host: U1Host; root: HTMLElement; unmount: () => void }> {
	(HTMLElement.prototype as unknown as { empty: () => void }).empty = function (this: HTMLElement) {
		this.replaceChildren();
	};
	const h = await appHarness();
	const host = new U1Host(h);
	const root = document.createElement("div");
	document.body.appendChild(root);
	render(<AppRoot host={host} initialSection={null} handle={() => undefined} />, root);
	await settle();
	return {
		h,
		host,
		root,
		unmount: () => {
			render(null, root);
			root.remove();
		},
	};
}

export function menuItem(menu: MenuSpec | undefined, title: string) {
	const item = menu?.find((i) => i !== "separator" && i.title === title);
	if (item === undefined || item === "separator") throw new Error(`No menu item "${title}"`);
	return item;
}
