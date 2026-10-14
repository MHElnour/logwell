import { type App, FuzzySuggestModal, Setting, type TFile, type TFolder, getIconIds, setIcon } from "obsidian";
import { TAG_COLORS, type TagColor } from "../domain/types";
import type { ButtonSpec, NewListOptions, NewListValues } from "../ui/host";
import { LIST_ICONS } from "../ui/icons";
import { capitalize, clamp } from "../domain/text";
import { el } from "./dom";
import { openFormModal } from "./formModal";
import { ResolvingModal } from "./resolvingModal";

/** Unique element ids for the icon picker, which can be opened again before the old DOM is gone. */
let iconGridSeq = 0;

// Small reusable modals. Each returns a promise that resolves on close.

export class ChoiceModal<T> extends ResolvingModal<T | null> {
	private cpOnAbort: (() => void) | null = null;

	constructor(
		app: App,
		private readonly title: string,
		private readonly message: string,
		private readonly buttons: ButtonSpec<T>[],
		private readonly cancelLabel: string = "Cancel",
		private readonly cpSignal?: AbortSignal,
	) {
		super(app, null);
	}

	override onOpen(): void {
		this.setTitle(this.title);
		if (this.cpSignal !== undefined) {
			const onAbort = () => this.close();
			this.cpOnAbort = onAbort;
			this.cpSignal.addEventListener("abort", onAbort, { once: true });
		}
		this.contentEl.createEl("p", { text: this.message });
		const setting = new Setting(this.contentEl);
		for (const b of this.buttons) {
			setting.addButton((btn) => {
				btn.setButtonText(b.label);
				if (b.cta === true) btn.setCta();
				if (b.warning === true) btn.setDestructive();
				btn.onClick(() => this.cpAnswer(b.value));
			});
		}
		setting.addButton((btn) => btn.setButtonText(this.cancelLabel).onClick(() => this.close()));
	}

	override onClose(): void {
		// A normal close first: a later abort must not close this modal a second time.
		if (this.cpOnAbort !== null) this.cpSignal?.removeEventListener("abort", this.cpOnAbort);
		this.cpOnAbort = null;
		super.onClose();
	}
}

/** Resolves the chosen value, or null when dismissed (Escape, the cancel button or closing). */
export function choose<T>(
	app: App,
	title: string,
	message: string,
	buttons: ButtonSpec<T>[],
	cancelLabel = "Cancel",
	/** Aborting closes the dialog and resolves null, for a question that was answered elsewhere. */
	signal?: AbortSignal,
): Promise<T | null> {
	return new ChoiceModal(app, title, message, buttons, cancelLabel, signal).cpAsk();
}

export interface PromptField {
	key: string;
	label: string;
	value: string;
	placeholder?: string;
	description?: string;
}

class PromptModal extends ResolvingModal<Record<string, string> | null> {
	private values: Record<string, string> = {};

	constructor(
		app: App,
		private readonly title: string,
		private readonly fields: PromptField[],
		private readonly submitLabel: string,
	) {
		super(app, null);
	}

	override onOpen(): void {
		this.setTitle(this.title);
		const form = this.contentEl.createEl("form");
		form.addEventListener("submit", (evt) => {
			evt.preventDefault();
			this.cpAnswer(this.values);
		});
		this.fields.forEach((f, i) => {
			this.values[f.key] = f.value;
			const s = new Setting(form).setName(f.label);
			if (f.description !== undefined) s.setDesc(f.description);
			s.addText((t) => {
				t.setValue(f.value).onChange((v) => (this.values[f.key] = v));
				if (f.placeholder !== undefined) t.setPlaceholder(f.placeholder);
				if (i === 0) window.setTimeout(() => t.inputEl.focus(), 0);
			});
		});
		new Setting(form).addButton((b) =>
			b
				.setButtonText(this.submitLabel)
				.setCta()
				.onClick(() => this.cpAnswer(this.values)),
		);
	}
}

export function prompt(
	app: App,
	title: string,
	fields: PromptField[],
	submitLabel = "Save",
): Promise<Record<string, string> | null> {
	return new PromptModal(app, title, fields, submitLabel).cpAsk();
}

/** A fuzzy picker over arbitrary items. Resolves null when dismissed. */
class PickerModal<T> extends FuzzySuggestModal<T> {
	private chosen: T | null = null;

	constructor(
		app: App,
		private readonly items: T[],
		private readonly text: (item: T) => string,
		placeholder: string,
		private readonly resolve: (item: T | null) => void,
	) {
		super(app);
		this.setPlaceholder(placeholder);
	}

	getItems(): T[] {
		return this.items;
	}

	getItemText(item: T): string {
		return this.text(item);
	}

	onChooseItem(item: T): void {
		this.chosen = item;
	}

	override onClose(): void {
		super.onClose();
		// onChooseItem runs after onClose in some versions; defer the resolve.
		window.setTimeout(() => this.resolve(this.chosen), 0);
	}
}

export function pick<T>(app: App, items: T[], text: (item: T) => string, placeholder: string): Promise<T | null> {
	return new Promise((resolve) => new PickerModal(app, items, text, placeholder, resolve).open());
}

/** Vault Markdown files by path: only .md is linkable. */
export function pickNote(app: App): Promise<TFile | null> {
	const files = app.vault.getMarkdownFiles().sort((a, b) => a.path.localeCompare(b.path));
	return pick(app, files, (f) => f.path, "Choose a note to link");
}

export function pickFolder(app: App, placeholder: string): Promise<TFolder | null> {
	const folders = app.vault.getAllFolders(true).sort((a, b) => a.path.localeCompare(b.path));
	return pick(app, folders, (f) => (f.isRoot() ? "/" : f.path), placeholder);
}

export function pickJsonFile(app: App): Promise<TFile | null> {
	const files = app.vault
		.getFiles()
		.filter((f) => f.extension === "json")
		.sort((a, b) => b.stat.mtime - a.stat.mtime);
	return pick(app, files, (f) => f.path, "Choose a Logwell backup (.json)");
}

/**
 * Arrow, Home and End keys inside a grid of buttons (a roving tabindex). `list` is the visible buttons in
 * order; the column count is how many share the first row. Returns true when the key was a grid key.
 */
function gridKey(e: KeyboardEvent, el: HTMLElement, list: HTMLElement[]): boolean {
	const at = list.indexOf(el);
	const top = list[0]?.offsetTop;
	const cols = Math.max(1, list.filter((b) => b.offsetTop === top).length);
	let next: number;
	if (e.key === "ArrowRight") next = at + 1;
	else if (e.key === "ArrowLeft") next = at - 1;
	else if (e.key === "ArrowDown") next = at + cols;
	else if (e.key === "ArrowUp") next = at - cols;
	else if (e.key === "Home") next = 0;
	else if (e.key === "End") next = list.length - 1;
	else return false;
	e.preventDefault();
	list[clamp(next, 0, list.length - 1)]?.focus();
	return true;
}

/** The accessible name of an icon button: its Lucide name without hyphens. */
const iconButtonLabel = (name: string): string => name.replace(/-/g, " ");

/** A filterable grid of list icons. Resolves a name, null for "None", or undefined when dismissed. */
class IconPickerModal extends ResolvingModal<string | null | undefined> {
	constructor(
		app: App,
		private readonly current: string | null,
		private readonly cpAccentClass: string = "",
	) {
		super(app, undefined);
	}

	override onOpen(): void {
		this.setTitle("Change icon");
		this.modalEl.addClass("checkpoint-icon-picker");
		if (this.cpAccentClass !== "") this.modalEl.addClass(this.cpAccentClass);
		const filter = this.contentEl.createEl("input", { type: "search", cls: "cp-icon-filter" });
		filter.placeholder = "Filter icons";
		filter.setAttribute("aria-label", "Filter icons");
		// The grid is a container: name it with aria-labelledby, since Obsidian tooltips any aria-label.
		const gridLabelId = `cp-icon-grid-label-${++iconGridSeq}`;
		this.contentEl.createSpan({ cls: "cp-sr-only", text: "Icons", attr: { id: gridLabelId } });
		const grid = this.contentEl.createDiv({ cls: "cp-icon-grid", attr: { role: "group", "aria-labelledby": gridLabelId } });
		const choose = (icon: string | null) => this.cpAnswer(icon);
		const buttons: { name: string; el: HTMLButtonElement }[] = [];
		const visible = () => buttons.filter((b) => !b.el.hasClass("cp-hidden")).map((b) => b.el);
		// Roving tabindex: one tab stop in the grid; arrows, Home and End move inside it.
		const setActive = (el: HTMLButtonElement | undefined) => {
			for (const b of buttons) b.el.tabIndex = b.el === el ? 0 : -1;
		};
		for (const name of LIST_ICONS) {
			const el = grid.createEl("button", { cls: "cp-icon-choice", attr: { type: "button", "aria-label": iconButtonLabel(name), title: iconButtonLabel(name), "aria-pressed": String(name === this.current) } });
			if (name === this.current) el.addClass("is-current");
			setIcon(el, name);
			el.addEventListener("click", () => choose(name));
			el.addEventListener("focus", () => setActive(el));
			el.addEventListener("keydown", (e: KeyboardEvent) => {
				gridKey(e, el, visible());
			});
			buttons.push({ name, el });
		}
		setActive(buttons.find((b) => b.name === this.current)?.el ?? buttons[0]?.el);
		const none = this.contentEl.createEl("button", { text: "None", cls: "cp-icon-none", attr: { type: "button" } });
		none.addEventListener("click", () => choose(null));
		filter.addEventListener("input", () => {
			const q = filter.value.trim().toLowerCase();
			for (const b of buttons) b.el.toggleClass("cp-hidden", q !== "" && !b.name.includes(q));
			setActive(visible()[0]);
		});
		window.setTimeout(() => filter.focus(), 0);
	}
}

export function pickListIcon(app: App, current: string | null, accentClass = ""): Promise<string | null | undefined> {
	return new IconPickerModal(app, current, accentClass).cpAsk();
}

/** The most icons the New list grid draws for one search; a longer result asks for a longer query. */
export const NEW_LIST_ICON_LIMIT = 120;

export interface NewListFormDeps {
	setIcon: (el: HTMLElement, icon: string) => void;
	/** Every Lucide name (`getIconIds()`), without the "lucide-" prefix. */
	iconIds: () => string[];
	/** The swatch that starts selected; null = the "Default" swatch (no color). */
	defaultColor: TagColor | null;
	/** Resolves a message to show inline (the form stays as it is), or null when it succeeded. */
	onSubmit: (values: NewListValues) => Promise<string | null>;
	onCancel: () => void;
}

/**
 * The row of color swatches (a "Default" one meaning no color, then the eight theme colors) as `aria-pressed`
 * buttons in a group named by `labelId`. Shared by the New list form and the New habit dialog.
 * `onChange` runs after a pick.
 */
export function buildColorRow(
	parent: HTMLElement,
	labelId: string,
	initial: TagColor | null,
	onChange: (color: TagColor | null) => void = () => undefined,
): { value: () => TagColor | null; set: (color: TagColor | null) => void } {
	const row = el(parent, "div", "cp-color-row", { role: "group", "aria-labelledby": labelId });
	let color: TagColor | null = initial;
	const choices: (TagColor | null)[] = [null, ...TAG_COLORS];
	const swatches = choices.map((c) => {
		const b = el(row, "button", `cp-color-choice${c === null ? " is-default" : ""}`, {
			type: "button",
			"aria-label": c === null ? "Default" : capitalize(c),
			"aria-pressed": String(c === color),
		});
		if (c !== null) b.style.setProperty("--cp-swatch", `var(--color-${c})`);
		b.addEventListener("click", () => set(c, true));
		return b;
	});
	function set(c: TagColor | null, notify = false): void {
		color = c;
		swatches.forEach((o, i) => o.setAttribute("aria-pressed", String(choices[i] === c)));
		if (notify) onChange(c);
	}
	return { value: () => color, set: (c) => set(c) };
}

/**
 * The one-step "New list" form in `container`: a name, an icon search with a keyboard grid,
 * and the color row. Plain DOM so it can be tested without a Modal. Returns `focus()` for the name field.
 */
export function buildNewListForm(container: HTMLElement, deps: NewListFormDeps): { focus: () => void } {
	const form = el(container, "form", "cp-new-list");
	const seq = ++iconGridSeq;

	// Name
	const nameLabel = el(form, "label", "cp-new-list-label", { for: `cp-new-list-name-${seq}` });
	nameLabel.textContent = "Name";
	const name = el(form, "input", "cp-new-list-name", { type: "text", id: `cp-new-list-name-${seq}`, placeholder: "Study", "aria-label": "List name", maxlength: "80" });
	const error = el(form, "p", "cp-new-list-error", { role: "alert" });
	error.hidden = true;

	// Icon
	const iconLabelId = `cp-new-list-icons-${seq}`;
	const iconLabel = el(form, "span", "cp-new-list-label", { id: iconLabelId });
	iconLabel.textContent = "Icon";
	const search = el(form, "input", "cp-icon-filter", { type: "search", placeholder: "Search icons", "aria-label": "Search icons" });
	const grid = el(form, "div", "cp-icon-grid", { role: "group", "aria-labelledby": iconLabelId });
	let icon: string | null = null;
	let buttons: HTMLButtonElement[] = [];
	const setActive = (active: HTMLButtonElement | undefined) => {
		for (const b of buttons) b.tabIndex = b === active ? 0 : -1;
	};
	const renderIcons = () => {
		const q = search.value.trim().toLowerCase();
		// No query: the curated list icons. A query searches every Lucide icon.
		const names = q === "" ? [...LIST_ICONS] : deps.iconIds().map((n) => n.replace(/^lucide-/, "")).filter((n) => n.includes(q) && n.length <= 40);
		grid.replaceChildren();
		buttons = names.slice(0, NEW_LIST_ICON_LIMIT).map((n) => {
			const label = iconButtonLabel(n);
			const b = el(grid, "button", `cp-icon-choice${n === icon ? " is-current" : ""}`, { type: "button", "aria-label": label, "aria-pressed": String(n === icon) });
			deps.setIcon(b, n);
			b.addEventListener("click", () => {
				// Pressing the chosen icon again clears it.
				icon = icon === n ? null : n;
				for (const o of buttons) {
					const on = o.getAttribute("aria-label") === iconButtonLabel(icon ?? "");
					o.setAttribute("aria-pressed", String(on));
					o.classList.toggle("is-current", on);
				}
			});
			b.addEventListener("focus", () => setActive(b));
			b.addEventListener("keydown", (e) => void gridKey(e, b, buttons));
			return b;
		});
		setActive(buttons.find((b) => b.getAttribute("aria-pressed") === "true") ?? buttons[0]);
		if (names.length === 0) {
			const none = el(grid, "p", "cp-new-list-none");
			none.textContent = "No icons match.";
		}
	};
	search.addEventListener("input", renderIcons);
	// Enter in the search box searches; it must not submit the form.
	search.addEventListener("keydown", (e) => {
		if (e.key === "Enter") e.preventDefault();
	});
	renderIcons();

	// Color
	const colorLabelId = `cp-new-list-colors-${seq}`;
	const colorLabel = el(form, "span", "cp-new-list-label", { id: colorLabelId });
	colorLabel.textContent = "Color";
	const colors = buildColorRow(form, colorLabelId, deps.defaultColor);

	const actions = el(form, "div", "cp-new-list-actions");
	const cancel = el(actions, "button", "", { type: "button" });
	cancel.textContent = "Cancel";
	cancel.addEventListener("click", () => deps.onCancel());
	const create = el(actions, "button", "mod-cta", { type: "submit" });
	create.textContent = "Create";

	const showError = (message: string) => {
		error.textContent = message;
		error.hidden = false;
		name.setAttribute("aria-invalid", "true");
		name.focus();
	};
	let busy = false;
	const submit = async () => {
		if (busy) return;
		const value = name.value.trim();
		if (value === "") return showError("A list needs a name.");
		busy = true;
		create.disabled = true;
		try {
			// On success the caller closes the dialog; on a message everything typed stays.
			const message = await deps.onSubmit({ name: value, icon, color: colors.value() });
			if (message !== null && message !== "") showError(message);
		} finally {
			busy = false;
			create.disabled = false;
		}
	};
	form.addEventListener("submit", (e) => {
		e.preventDefault();
		void submit();
	});
	name.addEventListener("input", () => {
		error.hidden = true;
		name.removeAttribute("aria-invalid");
	});
	return { focus: () => name.focus() };
}

/** The "New list" dialog. Resolves when it is gone: created, or dismissed (Escape or Cancel). */
export async function newListDialog(app: App, options: NewListOptions, accentClass = ""): Promise<void> {
	await openFormModal<void>(app, "New list", "checkpoint-new-list", accentClass, (content, done, cancel) =>
		buildNewListForm(content, {
			setIcon: (el, icon) => setIcon(el, icon),
			iconIds: () => getIconIds(),
			defaultColor: options.defaultColor,
			onSubmit: async (values) => {
				const message = await options.create(values);
				if (message === null) done();
				return message;
			},
			onCancel: cancel,
		}),
	);
}
