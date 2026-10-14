import type { App } from "obsidian";
import { ResolvingModal } from "./resolvingModal";

type Build<T> = (content: HTMLElement, done: (value: T) => void, cancel: () => void) => { focus: () => void };

/** Hosts one plain-DOM form: the title, the plugin tokens and scope classes, the form, then focus after the open animation. */
class FormModal<T> extends ResolvingModal<T | null> {
	constructor(
		app: App,
		private readonly cpTitle: string,
		private readonly cpScopeClass: string,
		private readonly cpAccentClass: string,
		private readonly cpBuild: Build<T>,
	) {
		super(app, null);
	}

	override onOpen(): void {
		this.setTitle(this.cpTitle);
		// checkpoint-icon-picker carries the plugin tokens and the screen-reader class for a dialog outside the view.
		this.modalEl.addClass("checkpoint-icon-picker", this.cpScopeClass);
		if (this.cpAccentClass !== "") this.modalEl.addClass(this.cpAccentClass);
		const form = this.cpBuild(
			this.contentEl,
			(value) => this.cpAnswer(value),
			() => this.close(),
		);
		window.setTimeout(() => form.focus(), 0);
	}
}

/** Opens `build`'s form in a modal. Resolves what `done` was given, or null when it closed any other way. */
export function openFormModal<T>(app: App, title: string, scopeClass: string, accent: string, build: Build<T>): Promise<T | null> {
	return new FormModal<T>(app, title, scopeClass, accent, build).cpAsk();
}
