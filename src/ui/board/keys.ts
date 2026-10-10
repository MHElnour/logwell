// Alt+Arrow moves on a board card. Same reason as the matrix (matrix/keys.ts): Obsidian's global
// Alt+Left/Right hotkeys run before the page, so CheckpointView registers the arrows on the view's Scope and
// hands them to the focused card with this event. No obsidian import.

import { routeMove } from "../moveKeys";

/** Sent to the focused card; `detail.key` is the arrow key. */
export const BOARD_MOVE_EVENT = "cp-board-move";

/**
 * True when the key was consumed: a board card of this view has focus and moved. When false (focus elsewhere, or the
 * card could not move) the caller returns true to the Scope, so Obsidian's default for the key still runs.
 * The board answers in `detail.acted`: a key that moved nothing (a single column, the last day) is not consumed.
 */
export function routeBoardMove(container: HTMLElement, evt: KeyboardEvent): boolean {
	return routeMove(container, evt, ".cp-board .cp-board-item", BOARD_MOVE_EVENT);
}
