import type { WriteResult } from "../app/writes";
import type { UiHost } from "./host";

/**
 * Shows the Undo notice of a write, unless it changed nothing. The label is the one the service wrote under;
 * `mark` is `store.undoMark()` taken right before the write.
 */
export function notifyWrite(host: UiHost, result: WriteResult, message: string, mark: number): void {
	if (result.wrote) host.notifyUndo(message, result.label, mark);
}
