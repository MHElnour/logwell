import type { WriteResult } from "../app/writes";
import type { UiHost } from "./host";

/** Shows the Undo notice of a write, unless it changed nothing. The label is the one the service wrote under. */
export function notifyWrite(host: UiHost, result: WriteResult, message: string): void {
	if (result.wrote) host.notifyUndo(message, result.label);
}
