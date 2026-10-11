import type { Notice } from "obsidian";
import { actionNotice, undoAction } from "./notices";

/** The Undo notice of a write: `mark` is `store.undoMark()` taken right before it, `label` the store label it ran under. */
export function undoNotice(store: { undoFor(mark: number, label: string): () => Promise<boolean> }, message: string, label: string, mark: number): Notice {
	return actionNotice(message, [undoAction(store.undoFor(mark, label))]);
}
