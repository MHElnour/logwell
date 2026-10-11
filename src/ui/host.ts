import type { CheckpointApp } from "../app/App";
import type { CheckpointSettings } from "../app/settings";
import type { FocusSetConfig } from "../domain/focus";
import type { HabitInput } from "../domain/habits";
import type { ID, LocalDate, TagColor } from "../domain/types";
import type { SpanDecision } from "../parsing";

// What the Preact UI needs from Obsidian. The view supplies an implementation;
// components never touch the vault or storage directly.

export interface MenuItemSpec {
	title: string;
	icon?: string;
	checked?: boolean;
	warning?: boolean;
	disabled?: boolean;
	run: () => void;
}

export type MenuSpec = (MenuItemSpec | "separator")[];

export interface ButtonSpec<T> {
	label: string;
	value: T;
	cta?: boolean;
	warning?: boolean;
}

export interface QuickAddPreset {
	categoryId?: ID;
	parentId?: ID;
	date?: LocalDate | null;
	/** Tags pre-selected for the new task (the tag view's preset). */
	tagKeys?: string[];
	/** The matrix quadrant's flags; they start the new task and survive a "keep open" reset. */
	urgent?: boolean;
	important?: boolean;
	/** The section a new task starts in; only used while the task stays in `categoryId`. */
	sectionId?: ID | null;
}

/** What the one-step "New list" dialog returns. */
export interface NewListValues {
	name: string;
	/** A Lucide icon name; null = none. */
	icon: string | null;
	/** One of the theme colors; null = the "Default" swatch, which means no color. */
	color: TagColor | null;
}

/** What the "New list" dialog needs from its caller. */
export interface NewListOptions {
	/** The swatch that starts selected: the color the next list would get from the palette. */
	defaultColor: TagColor;
	/**
	 * Creates the list. Resolves a message to show inline (the dialog stays open, values kept), or null
	 * once the list exists (the dialog closes).
	 */
	create(values: NewListValues): Promise<string | null>;
}

/** What the New habit and Edit habit dialog needs from its caller. */
export interface HabitDialogOptions {
	title: "New habit" | "Edit habit";
	submit: "Create habit" | "Save";
	/** The values to start from: an existing habit (Edit), an example chip, or null for an empty form. */
	initial: HabitInput | null;
	/** The color swatch that starts selected when `initial` is null. */
	defaultColor: TagColor;
	/** Resolves a message to show inline (the dialog stays open, values kept), or null once saved (it closes), as NewListOptions.create. */
	save(input: HabitInput): Promise<string | null>;
}

/** What the New tag and Edit tag dialog returns. */
export interface TagDialogValues {
	/** The tag's own name, trimmed (no parent path). */
	name: string;
	/** The key of a top-level tag, or null for none. */
	parent: string | null;
	/** One of the theme colors; null = the "Default" swatch, which means no color. */
	color: TagColor | null;
}

/** What the New tag and Edit tag dialog needs from its caller. */
export interface TagDialogOptions {
	title: "New tag" | "Edit tag";
	submit: "Create" | "Save";
	/** The values to start from: empty with the next palette color (New), or the tag's own (Edit). */
	initial: TagDialogValues;
	/** The Parent choices after None, by key and shown name. */
	parents: { key: string; label: string }[];
	/** Why the tag takes no parent (it has child tags, or a "/" in its name): the select is off with this hint; null when free. */
	parentLock: string | null;
	/** The first problem of a name under a parent, or null (`newTagProblem`); runs on every keystroke. */
	check(name: string, parent: string | null): string | null;
	/** Resolves a message to show inline (the dialog stays open, values kept), or null once saved (it closes), as NewListOptions.create. */
	save(values: TagDialogValues): Promise<string | null>;
}

/** What the TickTick sync shows and starts from the Tasks section. */
export interface TickTickUi {
	/** A token is chosen and the switch for this device is on. */
	ready(): boolean;
	/** The list menu's "Sync with TickTick…": pick a TickTick list, preview, first sync. */
	link(listId: ID): Promise<void>;
	/** Unlink; every task stays on both sides. */
	unlink(listId: ID): Promise<void>;
	/** Milliseconds since the epoch of this device's last sync without a failure, or null. */
	lastSyncAt(): number | null;
	/** Runs after each sync of this device; returns the unsubscribe. */
	onStatus(listener: () => void): () => void;
}

export interface UiHost {
	readonly app: CheckpointApp;
	settings(): CheckpointSettings;

	notify(message: string): void;
	/** Shows the error message of a failed command. */
	error(err: unknown): void;
	/**
	 * A notice with an Undo button for the write that ran under the store label `label`. `mark` is
	 * `store.undoMark()` taken right before that write, so the Undo reverts that write and no other.
	 */
	notifyUndo(message: string, label: string, mark: number): void;
	choose<T>(title: string, message: string, buttons: ButtonSpec<T>[]): Promise<T | null>;
	prompt(title: string, fields: { key: string; label: string; value: string; placeholder?: string }[], submit?: string): Promise<Record<string, string> | null>;
	/**
	 * `onClose` runs whenever the menu hides: after a pick (the item's `run` is called in the same
	 * tick) and after a dismissal (Escape, a click outside), so a caller can tell the two apart.
	 */
	showMenu(evt: MouseEvent | { x: number; y: number }, items: MenuSpec, onClose?: () => void): void;
	pickNote(): Promise<string | null>;
	pickTask(exclude: ID): Promise<ID | null>;
	pickCategory(): Promise<ID | null>;
	/**
	 * A grid picker for a list icon. Resolves to a Lucide name, `null` for "None",
	 * or `undefined` when dismissed. Optional so lightweight test hosts need not stub it.
	 */
	pickIcon?(current: string | null): Promise<string | null | undefined>;
	/**
	 * The one-step "New list" dialog: a name, an icon and a color. It calls `options.create` on
	 * Create and closes only when that succeeds; resolves when the dialog is gone (also when dismissed).
	 * Optional so lightweight test hosts need not stub it; the sidebar then falls back to a name prompt.
	 */
	newList?(options: NewListOptions): Promise<void>;
	/**
	 * The New tag / Edit tag dialog; resolves when it is gone (saved or dismissed). Optional so lightweight test hosts
	 * need not stub it; without it the sidebar shows no New tag button and no Edit item.
	 */
	tagDialog?(options: TagDialogOptions): Promise<void>;
	quickAdd(preset?: QuickAddPreset): void;
	/** #category, @tag and [[note]] suggestions on a Quick Add input. Disposed with the view. */
	attachTokenSuggest(input: HTMLInputElement, onBind: (decision: SpanDecision) => void): { isOpen(): boolean; dispose(): void };
	/** Vault notes a [[link]] can mean: exact path wins, else every basename match. */
	resolveNoteLinks(linktext: string): string[];

	openNote(path: string, split: boolean): void;
	/** Renders a note into el; returns a disposer. */
	renderNote(path: string, el: HTMLElement): Promise<() => void>;
	/** Called when a note is modified, created, deleted or renamed. */
	onNotesChanged(listener: (path: string) => void): () => void;

	exportBackup(): Promise<void>;
	/** Writes one CSV file per entity into a new vault folder and says where. */
	exportCsv(): Promise<void>;
	importBackup(): Promise<void>;

	setIcon(el: HTMLElement, icon: string): void;
	/** Starts focus on a task (or none), after the running-timer prompts, and opens the Focus page. */
	startFocus(taskId: ID | null): Promise<void>;
	/** The Focus page Start button is a user gesture: unlocks the sound and asks once for notifications. */
	focusGesture(): void;
	/** The remembered set values as a config in seconds. */
	focusConfig(): FocusSetConfig;
	setFocusConfig(config: FocusSetConfig): Promise<void>;
	/** The New habit / Edit habit dialog; resolves when the dialog is gone. */
	habitDialog(options: HabitDialogOptions): Promise<void>;
	/** A user gesture (saving a habit with a reminder on) asks the Notification permission once. */
	reminderGesture(): void;
	/**
	 * The TickTick sync. Optional so lightweight test hosts need not stub it; without it the sidebar shows no
	 * sync items and the list header no sync line.
	 */
	readonly tickTick?: TickTickUi;
	/** Opens the app on a section (the Today habits block links to Habits). */
	readonly openSection: (section: SectionId) => void;
}

export type SectionId = "tasks" | "calendar" | "focus" | "habits" | "matrix" | "search" | "data";
