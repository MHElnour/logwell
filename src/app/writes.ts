// The result of a labelled write: the Undo notice carries the exact store label.

export interface WriteResult {
	/** False when the command changed nothing (no write, no undo entry). */
	wrote: boolean;
	/** The store label the command ran under; equals `store.undoLabel` after a write. */
	label: string;
}
