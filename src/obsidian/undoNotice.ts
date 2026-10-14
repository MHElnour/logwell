import type { Notice } from "obsidian";
import { actionNotice, undoAction } from "./notices";

/** The Undo notice of a write: `mark` is `store.undoMark()` taken right before it, `label` the store label it ran under. */
export function undoNotice(store: { undoFor(mark: number, label: string): () => Promise<boolean> }, message: string, label: string, mark: number): Notice {
	return boundUndoNotice(message, store.undoFor(mark, label));
}

/**
 * An Undo notice for an undo already bound to what it reverses (a check-in in another database, a focus timer):
 * when `undo` resolves false the notice says there was nothing to undo.
 */
export function boundUndoNotice(message: string, undo: () => Promise<boolean>): Notice {
	return actionNotice(message, [undoAction(undo)]);
}
