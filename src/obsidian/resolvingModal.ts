import { type App, Modal } from "obsidian";

/**
 * A modal that answers once. A subclass draws in `onOpen` and calls `cpAnswer(value)`, which closes it;
 * `cpAsk()` opens it and resolves with that answer, or with the `dismissed` value when it closed any other
 * way (Escape, a Cancel button, the close button). Closing empties the content. A subclass that extends
 * `onClose` calls `super.onClose()` last. Members are cp-prefixed so they never shadow Obsidian's own.
 */
export abstract class ResolvingModal<T> extends Modal {
	private cpResult: T;
	private cpResolve: ((value: T) => void) | null = null;

	constructor(app: App, dismissed: T) {
		super(app);
		this.cpResult = dismissed;
	}

	/** Opens the modal; resolves once it has closed. */
	cpAsk(): Promise<T> {
		return new Promise((resolve) => {
			this.cpResolve = resolve;
			this.open();
		});
	}

	/** Records the answer and closes. */
	protected cpAnswer(value: T): void {
		this.cpResult = value;
		this.close();
	}

	override onClose(): void {
		this.contentEl.empty();
		this.cpResolve?.(this.cpResult);
		this.cpResolve = null;
	}
}
