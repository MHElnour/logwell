// Alt+Arrow moves on a matrix card. The Scope routing is shared with the board (../moveKeys.ts).

import { routeMove } from "../moveKeys";

/** Sent to the focused card; `detail.key` is the arrow key. */
export const MATRIX_MOVE_EVENT = "cp-matrix-move";

export const MOVE_ARROWS = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"] as const;

/**
 * True when the key was consumed: a matrix card of this view has focus and now got the event. When false the
 * caller returns true to the Scope, so Obsidian's default for the key still runs.
 */
export function routeMatrixMove(container: HTMLElement, evt: KeyboardEvent): boolean {
	return routeMove(container, evt, ".cp-matrix-q .cp-task-row", MATRIX_MOVE_EVENT);
}
