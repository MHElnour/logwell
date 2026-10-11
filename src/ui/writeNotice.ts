import type { WriteResult } from "../app/writes";
import type { UiHost } from "./host";

/**
 * Shows the Undo notice of a write, unless it changed nothing. The label is the one the service wrote under;
 * `mark` is `store.undoMark()` taken right before the write.
 */
export function notifyWrite(host: UiHost, result: WriteResult, message: string, mark: number): void {
	if (result.wrote) host.notifyUndo(message, result.label, mark);
}

/**
 * Runs a write and shows its Undo notice; errors go to the host. `message` is the notice text, or a function of the
 * result when the text depends on it. Resolves whether it succeeded (a no-op write counts as success).
 */
export async function runWrite(host: UiHost, write: () => Promise<WriteResult>, message: string | ((result: WriteResult) => string)): Promise<boolean> {
	try {
		const mark = host.app.store.undoMark();
		const result = await write();
		notifyWrite(host, result, typeof message === "string" ? message : message(result), mark);
		return true;
	} catch (err) {
		host.error(err);
		return false;
	}
}
