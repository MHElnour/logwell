import type { Task } from "../domain/types";
import type { UiHost } from "./host";
import { completeAsking } from "./actions";
import { completeOccurrence } from "./repeatActions";

// What the checkbox of a dashboard block row does. The block sits in a note, often with the app closed,
// so unlike the app's own list it says what it did and offers Undo.

/**
 * Completes `task` through the task service and offers Undo under the label of that write. A task with
 * open subtasks asks first, as in the app. A repeating task completes its current occurrence (its own notice).
 * A row still held after it was completed reopens. Errors go to the host.
 */
export async function completeBlockTask(host: UiHost, task: Task): Promise<void> {
	const { tasks } = host.app;
	try {
		if (task.status === "completed") {
			await tasks.reopen(task.id);
			return;
		}
		if (task.recurrence !== null) {
			await completeOccurrence(host, task);
			return;
		}
		const result = await completeAsking(host, task);
		if (result === null || result.kind !== "done" || result.completed === 0) return;
		const subs = result.completed - 1;
		host.notifyUndo(`Completed "${task.title}"${subs > 0 ? ` and ${subs} subtask${subs === 1 ? "" : "s"}` : ""}.`, result.label);
	} catch (err) {
		host.error(err);
	}
}
