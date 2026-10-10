import { render } from "preact";
import { EventBus } from "../../src/app/events";
import { DEFAULT_SETTINGS } from "../../src/app/settings";
import { AppRoot } from "../../src/ui/AppRoot";
import type { UiHost } from "../../src/ui/host";
import { type AppHarness, appHarness } from "../app/harness";

/** A minimal host for the add bar tests: no Obsidian, no suggester. */
class QuickHost implements UiHost {
	readonly messages: string[] = [];
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
	notify(m: string) {
		this.messages.push(m);
	}
	error(err: unknown) {
		this.messages.push(err instanceof Error ? err.message : String(err));
	}
	/** The Undo button of each notice, bound as the Obsidian host binds it (`store.undoFor`). */
	readonly undoButtons: (() => Promise<boolean>)[] = [];
	notifyUndo(m: string, label: string, mark: number) {
		this.messages.push(m);
		this.undoButtons.push(this.app.store.undoFor(mark, label));
	}
	async choose() {
		return null;
	}
	async prompt() {
		return null;
	}
	showMenu() {}
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
		return null;
	}
	quickAdd() {}
	openNote() {}
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

export async function mountApp(): Promise<{ h: AppHarness; host: QuickHost; root: HTMLElement; unmount: () => void }> {
	const h = await appHarness();
	const host = new QuickHost(h);
	const root = document.createElement("div");
	document.body.appendChild(root);
	render(<AppRoot host={host} initialSection={null} handle={() => undefined} />, root);
	for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
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
