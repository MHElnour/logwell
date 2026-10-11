import { Notice } from "obsidian";
import { NOTHING_TO_UNDO } from "../ui/format";

export interface NoticeAction {
	label: string;
	run: () => void | Promise<void>;
	/** Set by `undoAction`: a notice with an Undo button closes sooner. */
	isUndo?: boolean;
}

/** A "Done, Undo" notice closes after this long (Cmd/Ctrl+Z still undoes every change). */
export const UNDO_NOTICE_MS = 4000;

/** Any other notice with a message or buttons closes after this long. */
const DEFAULT_NOTICE_MS = 8000;

/**
 * A notice with action buttons. `timeout` 0 keeps it until dismissed (used for
 * conflicts and damaged-file messages). Left out, it is `UNDO_NOTICE_MS` when an action is an Undo, else 8 s.
 */
export function actionNotice(
	message: string,
	actions: NoticeAction[],
	timeout = actions.some((a) => a.isUndo === true) ? UNDO_NOTICE_MS : DEFAULT_NOTICE_MS,
): Notice {
	let notice: Notice | null = null;
	const fragment = createFragment((f) => {
		f.createDiv({ text: message, cls: "checkpoint-notice-text" });
		if (actions.length === 0) return;
		const row = f.createDiv({ cls: "checkpoint-notice-actions" });
		for (const action of actions) {
			const button = row.createEl("button", { text: action.label });
			button.addEventListener("click", (evt) => {
				evt.stopPropagation();
				notice?.hide();
				void Promise.resolve(action.run()).catch((err: unknown) => showError(err));
			});
		}
	});
	notice = new Notice(fragment, timeout);
	return notice;
}

/**
 * The Undo button of a notice. `undo` resolves false when there is nothing to undo any more; `onNothing` then
 * says so (a plain notice unless the caller routes it elsewhere). A thrown error reaches `showError` through `actionNotice`.
 */
export function undoAction(undo: () => Promise<boolean>, onNothing: () => void = () => void new Notice(NOTHING_TO_UNDO)): NoticeAction {
	return {
		label: "Undo",
		isUndo: true,
		run: async () => {
			if (!(await undo())) onNothing();
		},
	};
}

/** The one-time Sync notice closes by itself after this long. */
export const SYNC_NOTICE_MS = 15000;

/** .cpbase is not a default Obsidian Sync type. Closes after 15 s or with "Got it". */
export function syncNotice(): Notice {
	return actionNotice(
		"If you use Obsidian Sync, turn on \"Sync all other types\" so the database file syncs. Git and other file-sync tools need no change.",
		[{ label: "Got it", run: () => undefined }],
		SYNC_NOTICE_MS,
	);
}

export function showError(err: unknown): void {
	const message = err instanceof Error ? err.message : String(err);
	new Notice(message);
	if (!(err instanceof Error && err.name === "DomainError")) console.error("Logwell:", err);
}
