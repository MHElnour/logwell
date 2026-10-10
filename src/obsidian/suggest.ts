import { categoryText } from "../ui/icons";
import { AbstractInputSuggest, type App } from "obsidian";
import type { CheckpointApp } from "../app/App";
import type { SpanDecision } from "../parsing";
import { tokenAtCursor } from "../parsing";
import { applyTokenChoice, filterByQuery, suggestNotes } from "./tokenChoice";

type Token = NonNullable<ReturnType<typeof tokenAtCursor>>;

export type SuggestItem =
	| { kind: "category"; id: string; name: string; icon: string | null }
	| { kind: "tag"; key: string; displayName: string }
	| { kind: "note"; path: string; basename: string; insert: string };

/** #category, @tag and [[note]] suggestions for the Quick Add input. */
export class QuickAddSuggest extends AbstractInputSuggest<SuggestItem> {
	private cpOpened = false;
	/** Whether the last lookup produced suggestions. Obsidian calls open() on every input event, even when it then shows nothing. */
	private cpShowing = false;
	private cpToken: Token | null = null;
	/**
	 * Set by a pick until the user edits the text again. The pick rewrites the input and dispatches an
	 * `input` event, and Obsidian answers that by looking up suggestions again, which can land after our
	 * close() and show the same suggestion once more. The next Enter then picked again instead of saving
	 * (an intermittent e2e failure). While held, the suggester stays closed and empty.
	 */
	private cpHold = false;

	constructor(
		app: App,
		private readonly cpInput: HTMLInputElement,
		private readonly cpLists: {
			categories: () => { id: string; name: string; icon: string | null }[];
			tags: () => { key: string; displayName: string }[];
		},
		private readonly cpOnBind: (decision: SpanDecision) => void,
	) {
		super(app, cpInput);
		// Only a real edit fires beforeinput; the synthetic `input` of a pick does not.
		cpInput.addEventListener("beforeinput", () => {
			this.cpHold = false;
		});
	}

	/**
	 * True only while a popover with suggestions is on screen, so Enter saves otherwise.
	 * Not named `isOpen`: Obsidian's PopoverSuggest assigns its own `isOpen` field on the
	 * instance, which shadows a method of that name. Our own fields are prefixed `cp` for the
	 * same reason (found by e2e: "isOpen is not a function").
	 */
	isShowing(): boolean {
		return this.cpOpened && this.cpShowing;
	}

	override open(): void {
		if (this.cpHold) return;
		this.cpOpened = true;
		super.open();
	}

	override close(): void {
		this.cpOpened = false;
		this.cpShowing = false;
		super.close();
	}

	protected getSuggestions(query: string): SuggestItem[] {
		const items = this.cpHold ? [] : this.cpLookup();
		this.cpShowing = items.length > 0;
		return items;
	}

	private cpLookup(): SuggestItem[] {
		const cursor = this.cpInput.selectionStart ?? this.cpInput.value.length;
		this.cpToken = tokenAtCursor(this.cpInput.value, cursor);
		const token = this.cpToken;
		if (token === null) return [];
		if (token.kind === "category") {
			const items = this.cpLists.categories().map((c): SuggestItem => ({ kind: "category", id: c.id, name: c.name, icon: c.icon }));
			return filterByQuery(items, (i) => (i.kind === "category" ? i.name : ""), token.query);
		}
		if (token.kind === "tag") {
			const items = this.cpLists.tags().map((t): SuggestItem => ({ kind: "tag", key: t.key, displayName: t.displayName }));
			return filterByQuery(items, (i) => (i.kind === "tag" ? i.displayName : ""), token.query);
		}
		return suggestNotes(this.app.vault.getMarkdownFiles(), token.query).map((n): SuggestItem => ({ kind: "note", ...n }));
	}

	renderSuggestion(item: SuggestItem, el: HTMLElement): void {
		if (item.kind === "category") el.setText(categoryText(item));
		else if (item.kind === "tag") el.setText(`@${item.displayName}`);
		else el.setText(item.path.replace(/\.md$/i, ""));
	}

	override selectSuggestion(item: SuggestItem): void {
		const token = this.cpToken ?? tokenAtCursor(this.cpInput.value, this.cpInput.selectionStart ?? this.cpInput.value.length);
		if (token === null) {
			this.close();
			return;
		}
		const insert = item.kind === "category" ? `#${item.name}` : item.kind === "tag" ? `@${item.displayName}` : `[[${item.insert}]]`;
		const result = applyTokenChoice(this.cpInput.value, token, insert);
		this.close();
		this.cpHold = true;
		this.cpInput.value = result.value;
		this.cpInput.setSelectionRange(result.cursor, result.cursor);
		this.cpInput.dispatchEvent(new Event("input", { bubbles: true }));
		const base = { span: result.span, text: insert };
		if (item.kind === "category") this.cpOnBind({ ...base, kind: "category", categoryId: item.id });
		else if (item.kind === "tag") this.cpOnBind({ ...base, kind: "tag", key: item.key });
		else this.cpOnBind({ ...base, kind: "note", path: item.path });
	}
}

/**
 * Attaches the #category, @tag and [[note]] suggester to a Quick Add input. `dispose` is idempotent and
 * calls `onDispose` once (the caller drops its own bookkeeping there).
 */
export function attachTokenSuggest(
	obsidianApp: App,
	app: CheckpointApp,
	input: HTMLInputElement,
	onBind: (decision: SpanDecision) => void,
	onDispose: () => void = () => undefined,
): { isOpen: () => boolean; dispose: () => void } {
	const suggest = new QuickAddSuggest(
		obsidianApp,
		input,
		{
			categories: () => app.categories.list().map((c) => ({ id: c.id, name: c.name, icon: c.icon })),
			tags: () => app.tags.list().map((t) => ({ key: t.key, displayName: t.displayName })),
		},
		onBind,
	);
	let disposed = false;
	const dispose = () => {
		if (disposed) return;
		disposed = true;
		suggest.close();
		onDispose();
	};
	return { isOpen: () => suggest.isShowing(), dispose };
}
