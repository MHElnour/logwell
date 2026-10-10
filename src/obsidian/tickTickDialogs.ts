import type { App } from "obsidian";
import { SYNCED_LIST_OPEN_MAX } from "../app/listIndex";
import type { LinkOption } from "../app/tickTickLink";
import type { FirstSyncPlan, PendingTrash } from "../app/SyncService";
import { openFormModal } from "./formModal";

// The dialogs of the TickTick sync. Each form is plain DOM built by a function
// (testable without a Modal) and each Modal wrapper only hosts one and resolves its answer. Styles: `.checkpoint-tt-dialog`.

let seq = 0;

type Attrs = Record<string, string>;

function el<K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, cls = "", text = "", attr: Attrs = {}): HTMLElementTagNameMap[K] {
	const node = parent.createEl(tag, { cls: cls === "" ? undefined : cls, attr });
	if (text !== "") node.textContent = text;
	return node;
}

function button(parent: HTMLElement, label: string, cta: boolean, onClick: () => void): HTMLButtonElement {
	const b = el(parent, "button", cta ? "mod-cta" : "", label, { type: "button" });
	b.addEventListener("click", onClick);
	return b;
}

/** TickTick's per-list limits, shown when linking. */
const LIMITS_TEXT = `A synced list holds at most ${SYNCED_LIST_OPEN_MAX} open tasks, TickTick's per-list limit (99 on its free plan). Completed tasks don't count.`;

// -- link dialog ----------------------------------------------------------------------------------------------

export interface LinkFormDeps {
	listName: string;
	/** The options, read from TickTick; a rejection is shown in the dialog. */
	load: () => Promise<LinkOption[]>;
	/** The option that starts selected. */
	initial: (options: readonly LinkOption[]) => LinkOption | undefined;
	onContinue: (option: LinkOption) => void;
	onCancel: () => void;
}

/** The advice shown when linking: change synced tasks in one place. Advice only; both sides stay editable. */
const LINK_TIP =
	"Tip: make changes to synced tasks in one place, like TickTick, and they show up on both sides.";

/** Choose a TickTick list, or create one with the list's name. Keyboard: Up and Down move, Enter continues. */
export function buildLinkForm(container: HTMLElement, deps: LinkFormDeps): { focus: () => void } {
	const id = ++seq;
	el(container, "p", "cp-tt-lead", "Choose a TickTick list. Tasks, sections, tags, priority, dates and completion sync both ways.");
	el(container, "p", "cp-tt-lead", LINK_TIP);
	const labelId = `cp-tt-options-${id}`;
	el(container, "span", "cp-sr-only", "TickTick lists", { id: labelId });
	const status = el(container, "p", "cp-tt-status", "Loading your TickTick lists…", { role: "status" });
	const box = el(container, "div", "cp-tt-options", "", { role: "listbox", "aria-labelledby": labelId });
	box.hidden = true;
	el(container, "p", "cp-tt-warn", LIMITS_TEXT);
	el(container, "p", "cp-tt-lead", "Repeating tasks and TickTick notes are not synced. A tag name can be used only once, whatever its parent (TickTick allows one tag per name).");
	const actions = el(container, "div", "cp-tt-actions");
	button(actions, "Cancel", false, deps.onCancel);
	const next = button(actions, "Continue", true, () => selected !== null && deps.onContinue(selected));
	next.disabled = true;

	let options: LinkOption[] = [];
	let rows: HTMLElement[] = [];
	let selected: LinkOption | null = null;
	const select = (index: number) => {
		const option = options[index];
		if (option === undefined || option.disabled) return;
		selected = option;
		rows.forEach((r, i) => {
			r.setAttribute("aria-selected", String(i === index));
			r.tabIndex = i === index ? 0 : -1;
		});
		next.disabled = false;
	};
	const move = (from: number, step: 1 | -1) => {
		for (let i = from + step; i >= 0 && i < options.length; i += step) {
			if (options[i]!.disabled) continue;
			select(i);
			rows[i]!.focus();
			return;
		}
	};
	const draw = (loaded: LinkOption[]) => {
		options = loaded;
		rows = loaded.map((o, i) => {
			const row = el(box, "div", `cp-tt-option${o.disabled ? " is-disabled" : ""}`, "", {
				role: "option",
				"aria-selected": "false",
				tabindex: "-1",
				...(o.disabled ? { "aria-disabled": "true" } : {}),
			});
			el(row, "span", "cp-tt-option-name", o.label);
			if (o.detail !== "") el(row, "span", "cp-tt-option-detail", o.detail);
			row.addEventListener("click", () => select(i));
			row.addEventListener("keydown", (e) => {
				if (e.key === "ArrowDown") move(i, 1);
				else if (e.key === "ArrowUp") move(i, -1);
				else if (e.key === " ") select(i);
				else if (e.key === "Enter" && !o.disabled) {
					select(i);
					deps.onContinue(o);
				} else return;
				e.preventDefault();
			});
			return row;
		});
		const start = deps.initial(loaded);
		const at = start === undefined ? -1 : loaded.indexOf(start);
		if (at >= 0) select(at);
		else rows.find((_, i) => !loaded[i]!.disabled)?.setAttribute("tabindex", "0");
		status.hidden = true;
		box.hidden = false;
		(rows[at] ?? rows[0])?.focus();
	};
	deps.load().then(draw, (err: unknown) => {
		status.setAttribute("role", "alert");
		status.textContent = err instanceof Error ? err.message : String(err);
	});
	return { focus: () => (rows.find((r) => r.tabIndex === 0) ?? next).focus() };
}

// -- first-sync preview ---------------------------------------------------------------------------------------

export interface PreviewFormDeps {
	listName: string;
	projectName: string;
	plan: Pick<FirstSyncPlan, "toLogwell" | "toTickTick">;
	onSync: () => void;
	onBack: () => void;
}

/** How many tasks each side gets, and the duplicate warning when both sides have tasks. */
export function buildPreviewForm(container: HTMLElement, deps: PreviewFormDeps): { focus: () => void } {
	const { plan } = deps;
	const both = plan.toLogwell > 0 && plan.toTickTick > 0;
	el(
		container,
		"p",
		"cp-tt-lead",
		both
			? "Both lists already have tasks. They are not matched: every task is copied to the other side."
			: "Open tasks are copied to the side that does not have them. Nothing is matched or removed.",
	);
	const counts = el(container, "div", "cp-tt-counts");
	const box = (n: number, text: string) => {
		const b = el(counts, "div", "cp-tt-count");
		el(b, "b", "", String(n));
		el(b, "span", "", text);
	};
	box(plan.toLogwell, `open ${plan.toLogwell === 1 ? "task comes" : "tasks come"} to Logwell`);
	box(plan.toTickTick, `open ${plan.toTickTick === 1 ? "task goes" : "tasks go"} to TickTick`);
	if (both) el(container, "p", "cp-tt-warn", "Tasks that exist on both sides will appear twice. Delete the copy you don't want; the delete syncs.");
	el(container, "p", "cp-tt-lead", "A backup is taken first (Data > Backups).");
	const actions = el(container, "div", "cp-tt-actions");
	button(actions, "Back", false, deps.onBack);
	const sync = button(actions, "Sync", true, deps.onSync);
	return { focus: () => sync.focus() };
}

// -- tasks missing from TickTick ----------------------------------------------------------------------------

export interface MissingFormDeps {
	pending: PendingTrash;
	listName: string;
	onChoose: (choice: "trash" | "keep") => void;
}

/** The dialog title of one pending confirmation. */
export function missingTitle(pending: PendingTrash, listName: string): string {
	const n = pending.tasks.length;
	return pending.reason === "emptied" ? `${listName} is empty in TickTick` : `${n} task${n === 1 ? " was" : "s were"} removed from ${listName} in TickTick`;
}

/**
 * The tasks a pull would move to Trash. `many` (5 or more) lists their titles;
 * `emptied` asks about all of them and says that Keep also unlinks the list.
 */
export function buildMissingForm(container: HTMLElement, deps: MissingFormDeps): { focus: () => void } {
	const { pending } = deps;
	const n = pending.tasks.length;
	if (pending.reason === "emptied") {
		el(container, "p", "cp-tt-lead", `It had ${n} task${n === 1 ? "" : "s"} at the last sync. Move ${n === 1 ? "it" : `all ${n}`} to Trash in Logwell?`);
		const keep = el(container, "p", "cp-tt-lead");
		el(keep, "b", "", "Keep");
		keep.append(" keeps them in Logwell and unlinks the list, so nothing is deleted.");
	} else {
		el(container, "p", "cp-tt-lead", "They were deleted there or moved to a list that isn't synced. Move them to Trash in Logwell too?");
		const list = el(container, "ul", "cp-tt-titles", "", { tabindex: "0" });
		for (const t of pending.tasks) el(list, "li", "", t.title);
		el(container, "p", "cp-tt-lead", "Keep leaves them in Logwell only. They show Not synced and are not sent to TickTick again.");
	}
	const actions = el(container, "div", "cp-tt-actions");
	button(actions, "Keep", false, () => deps.onChoose("keep"));
	const trash = button(actions, "Move to Trash", true, () => deps.onChoose("trash"));
	return { focus: () => trash.focus() };
}

// -- modal hosts ----------------------------------------------------------------------------------------------------

const open = <T>(app: App, title: string, accent: string, build: Parameters<typeof openFormModal<T>>[4]): Promise<T | null> =>
	openFormModal<T>(app, title, "checkpoint-tt-dialog", accent, build);

/** The link dialog. Resolves the chosen option, or null when dismissed. */
export function pickLinkOption(app: App, deps: Omit<LinkFormDeps, "onContinue" | "onCancel">, accent = ""): Promise<LinkOption | null> {
	return open<LinkOption>(app, `Sync “${deps.listName}” with TickTick`, accent, (content, done, cancel) =>
		buildLinkForm(content, { ...deps, onContinue: done, onCancel: cancel }),
	);
}

/** The first-sync preview. Resolves `sync`, `back` or null when dismissed. */
export function showFirstSyncPreview(app: App, deps: Omit<PreviewFormDeps, "onSync" | "onBack">, accent = ""): Promise<"sync" | "back" | null> {
	return open<"sync" | "back">(app, `First sync: ${deps.listName} ⟷ ${deps.projectName}`, accent, (content, done) =>
		buildPreviewForm(content, { ...deps, onSync: () => done("sync"), onBack: () => done("back") }),
	);
}

/** The question about tasks missing from TickTick. Resolves the choice, or null when dismissed (decide later). */
export function askMissing(app: App, deps: Omit<MissingFormDeps, "onChoose">, accent = ""): Promise<"trash" | "keep" | null> {
	return open<"trash" | "keep">(app, missingTitle(deps.pending, deps.listName), accent, (content, done) =>
		buildMissingForm(content, { ...deps, onChoose: done }),
	);
}
