import { Modal, setIcon } from "obsidian";
import { h, render } from "preact";
import type CheckpointPlugin from "../main";
import type { SpanDecision } from "../parsing";
import { accentClass } from "../ui/accent";
import { QuickAddForm } from "../ui/QuickAddForm";
import type { QuickAddPreset } from "../ui/host";
import { pickNote } from "./modals";
import { actionNotice, showError } from "./notices";
import { resolveNoteLinks } from "./noteLinks";
import type { DbSession } from "./session";
import { attachTokenSuggest } from "./suggest";

/** Quick Add: natural-language input, chips and manual fields in one modal. */
export class QuickAddModal extends Modal {
	private cpDisposers: (() => void)[] = [];
	/** Closes an open popover or chip picker; true when there was one. */
	private cpClosePicker: () => boolean = () => false;

	constructor(
		private readonly plugin: CheckpointPlugin,
		private readonly session: DbSession,
		private readonly preset: QuickAddPreset,
	) {
		super(plugin.app);
	}

	override onOpen(): void {
		this.setTitle("Quick add task");
		this.modalEl.addClass("checkpoint-quick-add-modal", accentClass(this.plugin.settings));
		const app = this.session.app;

		// Escape closes an open popover or chip picker first, then the modal. The scope runs before the
		// modal's own handler where Obsidian orders it so; the capture listener below covers the rest.
		this.scope.register([], "Escape", () => {
			this.close();
			return false;
		});
		this.registerPickerEscape();

		render(
			h(QuickAddForm, {
				app,
				preset: this.preset,
				locale: () => this.plugin.settings.dateLocale,
				eveningTime: () => this.plugin.settings.eveningTime,
				weekStart: () => this.plugin.settings.weekStart,
				setIcon: (el: HTMLElement, icon: string) => setIcon(el, icon),
				keepOpen: () => this.plugin.settings.keepQuickAddOpen,
				pickNote: async () => (await pickNote(this.app))?.path ?? null,
				resolveNote: (linktext: string) => resolveNoteLinks(this.app, linktext),
				// The modal has no UiHost; this has the same shape as UiHost.attachTokenSuggest.
				attachTokenSuggest: (input: HTMLInputElement, onBind: (d: SpanDecision) => void) => {
					const handle = attachTokenSuggest(this.app, app, input, onBind);
					this.cpDisposers.push(handle.dispose);
					return handle;
				},
				registerEscape: (closePicker: () => boolean) => {
					this.cpClosePicker = closePicker;
				},
				onSaved: (title: string, warnings: string[]) => {
					const suffix = warnings.length > 0 ? ` (${warnings.join("; ")})` : "";
					actionNotice(`Added "${title}"${suffix}`, [], 3000);
				},
				onError: (err: unknown) => showError(err),
				onClose: () => this.closeNow(),
			}),
			this.contentEl,
		);
	}

	/** A capture-phase Escape listener on the modal: an open chip picker takes the key. */
	private registerPickerEscape(): void {
		const handler = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || e.defaultPrevented) return;
			if (this.cpClosePicker()) {
				e.preventDefault();
				e.stopPropagation();
			}
		};
		this.modalEl.addEventListener("keydown", handler, true);
		this.cpDisposers.push(() => this.modalEl.removeEventListener("keydown", handler, true));
	}

	/**
	 * Escape closes an open popover (date or more menu) or chip picker first, then the modal. Obsidian's own Escape handler
	 * runs before any we register and calls close(), so the check lives here (found by e2e).
	 * Saving and the form's own close use closeNow().
	 */
	override close(): void {
		if (this.cpClosePicker()) return;
		super.close();
	}

	closeNow(): void {
		super.close();
	}

	override onClose(): void {
		render(null, this.contentEl);
		for (const dispose of this.cpDisposers.splice(0)) dispose();
		this.contentEl.empty();
	}
}

export function openQuickAdd(plugin: CheckpointPlugin, session: DbSession, preset: QuickAddPreset = {}): void {
	if (session.store.readOnlyState !== null) {
		showError(new Error("The database is read-only until the problem shown in the app is resolved."));
		return;
	}
	new QuickAddModal(plugin, session, preset).open();
}
