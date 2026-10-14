import { type CompleteResult, DELETE_TASK_LABEL, DST_WARNING_TEXT, DUPLICATE_TASK_LABEL, EDIT_TASK_LABEL, type TaskPatch } from "../app/TaskService";
import { addDays } from "../domain/time";
import { plural } from "../domain/text";
import { quadrantOf } from "../domain/queries";
import { isActiveSeries } from "../domain/tasks";
import { type LocalDate, PRIORITIES, type Priority, type Task } from "../domain/types";
import { PRIORITY_NAME } from "./format";
import { ICON } from "./icons";
import { QUADRANT_LIST } from "./matrix/quadrants";
import type { MenuItemSpec, MenuSpec, UiHost } from "./host";
import {
	type Reanchored,
	completeOccurrence,
	notifyReanchored,
	reopenOccurrence,
	requestRepeatEdit,
	skipOccurrence,
	stopRepeating,
} from "./repeatActions";
import { moveToDate } from "../domain/calendar";

// Task actions shared by list rows and the details pane.

/**
 * Completes a task; with open subtasks it asks first ("Complete all (N)" or Cancel) and then completes them
 * too. The result of the last write and the undo mark taken right before it (for its notice), or null when the
 * user cancelled. Errors are the caller's.
 */
export async function completeAsking(host: UiHost, task: Task): Promise<{ result: CompleteResult; mark: number } | null> {
	const { tasks, store } = host.app;
	let mark = store.undoMark();
	let result = await tasks.complete(task.id);
	if (result.kind === "needs-confirmation") {
		const n = result.openSubtasks;
		const ok = await host.choose("Complete task", `"${task.title}" has ${plural(n, "open subtask")}.`, [{ label: `Complete all (${n})`, value: true, cta: true }]);
		if (ok !== true) return null;
		mark = store.undoMark();
		result = await tasks.complete(task.id, { includeSubtasks: true });
	}
	return { result, mark };
}

/** Complete or reopen, with the prompt for open subtasks: "Complete all (N)" or Cancel. */
export async function toggleComplete(host: UiHost, task: Task): Promise<void> {
	const { tasks } = host.app;
	try {
		if (task.status === "completed") {
			await tasks.reopen(task.id);
			return;
		}
		// An open repeating task completes its occurrence and stays; its subtasks come back unchecked, so
		// there is nothing to confirm. The notice (Undo, "Complete occurrence") says what was done. A series that
		// has ended completes as a plain task.
		if (isActiveSeries(task)) {
			await completeOccurrence(host, task);
			return;
		}
		await completeAsking(host, task);
	} catch (err) {
		host.error(err);
	}
}

/** Disclosed parent deletion, then an Undo notice. */
export async function deleteTask(host: UiHost, task: Task): Promise<boolean> {
	const subs = host.app.tasks.subtaskCount(task.id);
	if (subs > 0) {
		const ok = await host.choose(
			"Delete task",
			`Move "${task.title}" to Trash? This also moves ${plural(subs, "subtask")} to Trash.`,
			[{ label: "Move to trash", value: true, warning: true }],
		);
		if (ok !== true) return false;
	}
	try {
		const mark = host.app.store.undoMark();
		await host.app.tasks.delete(task.id);
		host.notifyUndo(`Moved "${task.title}" to Trash.`, DELETE_TASK_LABEL, mark);
		return true;
	} catch (err) {
		host.error(err);
		return false;
	}
}

/**
 * One TaskService.update. "same" means the patch resolved to the current values (nothing written, no
 * undo entry), so a caller must not offer an Undo for it: that Undo would revert an earlier command.
 */
export async function writeTask(host: UiHost, task: Task, patch: TaskPatch): Promise<"changed" | "same" | "failed"> {
	const mark = host.app.store.undoMark();
	const { outcome, reanchored } = await writeTaskResult(host, task, patch);
	// A date change of a series re-anchors the whole series; say so (the caller's own notice, if any, is replaced
	// by this one: use writeTaskResult to decide).
	if (outcome === "changed" && reanchored !== null) notifyReanchored(host, task, reanchored, EDIT_TASK_LABEL, mark);
	return outcome;
}

/** `writeTask` without the re-anchor notice: for callers that show their own and must replace it with that notice. */
export async function writeTaskResult(
	host: UiHost,
	task: Task,
	patch: TaskPatch,
): Promise<{ outcome: "changed" | "same" | "failed"; reanchored: Reanchored | null }> {
	try {
		const { warnings, changed, reanchored } = await host.app.tasks.update(task.id, patch);
		for (const w of warnings) host.notify(DST_WARNING_TEXT[w]);
		return { outcome: changed === false ? "same" : "changed", reanchored: reanchored ?? null };
	} catch (err) {
		host.error(err);
		return { outcome: "failed", reanchored: null };
	}
}

export async function updateTask(host: UiHost, task: Task, patch: TaskPatch): Promise<boolean> {
	return (await writeTask(host, task, patch)) !== "failed";
}

export async function moveToCategory(host: UiHost, task: Task): Promise<void> {
	if (task.parentId !== null) {
		host.notify("A subtask always stays in its parent's list.");
		return;
	}
	const id = await host.pickCategory();
	if (id !== null) await updateTask(host, task, { categoryId: id });
}

/** The pending "Move to section…" menu, if any: one at a time, and cancellable when the app goes away. */
let moveMenuTimer: number | null = null;

/** Clears a pending "Move to section…" menu (the app root calls it on unmount). */
export function cancelMoveToSection(): void {
	if (moveMenuTimer === null) return;
	window.clearTimeout(moveMenuTimer);
	moveMenuTimer = null;
}

/**
 * "Move to section…" opens a second menu: "No section" and the list's sections, the current one checked.
 * A native menu closes on a pick, so the second one is shown on the next tick, under `anchor` (the row or
 * card the first menu came from). It is not shown when the anchor has left the document by then.
 */
export function moveToSection(host: UiHost, task: Task, anchor: HTMLElement): void {
	cancelMoveToSection();
	moveMenuTimer = window.setTimeout(() => {
		moveMenuTimer = null;
		if (!anchor.isConnected) return;
		const current = host.app.store.state.tasks.get(task.id) ?? task;
		const at = anchor.getBoundingClientRect();
		host.showMenu({ x: at.left + 24, y: at.bottom }, [
			{ title: "No section", checked: current.sectionId === null, run: () => void updateTask(host, current, { sectionId: null }) },
			...host.app.sections.inList(current.categoryId).map((section) => ({
				title: section.name,
				checked: current.sectionId === section.id,
				run: () => void updateTask(host, current, { sectionId: section.id }),
			})),
		]);
	}, 0);
}

export async function duplicateTask(host: UiHost, task: Task): Promise<Task | null> {
	try {
		const mark = host.app.store.undoMark();
		const copy = await host.app.tasks.duplicate(task.id);
		host.notifyUndo(`Duplicated "${task.title}".`, DUPLICATE_TASK_LABEL, mark);
		return copy;
	} catch (err) {
		host.error(err);
		return null;
	}
}

/** Changes only the priority. */
export async function setPriority(host: UiHost, task: Task, priority: Priority): Promise<void> {
	try {
		await host.app.tasks.setPriority(task.id, priority);
	} catch (err) {
		host.error(err);
	}
}

/** One menu item per priority, the current one checked. `title` names an item. */
export function priorityItems(host: UiHost, task: Task, title: (p: Priority) => string): MenuItemSpec[] {
	return PRIORITIES.map((p) => ({
		title: title(p),
		icon: "flag",
		checked: task.priority === p,
		run: () => void setPriority(host, task, p),
	}));
}

/** The menu of a Completed history row: one done occurrence of a repeating task. */
export function occurrenceMenu(host: UiHost, task: Task, date: LocalDate, onOpen: () => void): MenuSpec {
	return [
		{ title: "Open details", icon: "panel-right", run: onOpen },
		{ title: "Reopen", icon: "rotate-ccw", run: () => void reopenOccurrence(host, task, date) },
	];
}

/** The row context menu. */
export function taskMenu(host: UiHost, task: Task, today: string, onOpen: () => void, anchor: HTMLElement): MenuSpec {
	// A series has no `scheduled` of its own; "Schedule for …" moves its current occurrence, keeping its time and zone.
	const current = task.recurrence === null ? null : host.app.effectiveSchedule(task);
	const date = (d: string | null) => () =>
		void updateTask(host, task, {
			scheduled: d === null ? null : current === null ? { kind: "date", date: d } : moveToDate(current, d, host.app.queryContext().zone),
		});
	const quadrant = quadrantOf(task);
	const repeating = task.recurrence !== null;
	const activeSeries = isActiveSeries(task);
	return [
		{ title: "Open details", icon: "panel-right", run: onOpen },
		{
			title: task.status === "open" ? "Complete" : "Reopen",
			icon: task.status === "open" ? "check" : "rotate-ccw",
			run: () => void toggleComplete(host, task),
		},
		// The three repeat actions follow Complete. Edit repeat… opens the details pane on the
		// task and its picker, so the editor is the one that holds the rule, the end and the Undo notice.
		...(activeSeries
			? [
					{ title: "Skip this occurrence", icon: "skip-forward", run: () => void skipOccurrence(host, task) },
					{
						title: "Edit repeat…",
						icon: "repeat",
						run: () => {
							onOpen();
							requestRepeatEdit(task.id);
						},
					},
					{ title: "Stop repeating", icon: "ban", run: () => void stopRepeating(host, task) },
				]
			: []),
		{ title: "Start focus", icon: ICON.railFocus, run: () => void host.startFocus(task.id).catch((err: unknown) => host.error(err)) },
		"separator",
		{ title: "Schedule for today", icon: "calendar-check", run: date(today) },
		{ title: "Schedule for tomorrow", icon: "calendar-plus", run: date(addDays(today, 1)) },
		{ title: "Schedule for next week", icon: "calendar-range", run: date(addDays(today, 7)) },
		// A repeating task has no schedule of its own to clear: clearing it would end the series.
		{
			title: repeating ? "Clear schedule (change the repeat instead)" : "Clear schedule",
			icon: "calendar-x",
			disabled: task.scheduled === null,
			run: date(null),
		},
		"separator",
		...priorityItems(host, task, (p) => `Priority: ${PRIORITY_NAME[p]}`),
		"separator",
		{ title: "Move to list…", icon: "folder-input", disabled: task.parentId !== null, run: () => void moveToCategory(host, task) },
		// Only for a top-level task of a list that has sections (a subtask follows its parent's section).
		...(task.parentId === null && host.app.sections.inList(task.categoryId).length > 0
			? [{ title: "Move to section…", icon: "layout-list", run: () => moveToSection(host, task, anchor) }]
			: []),
		...QUADRANT_LIST.map((q) => ({
			title: `Move to quadrant: ${q.title.toLowerCase()}`,
			checked: quadrant === q.id,
			run: () => void updateTask(host, task, { urgent: q.urgent, important: q.important }),
		})),
		"separator",
		{ title: "Duplicate", icon: "copy", run: () => void duplicateTask(host, task) },
		{ title: "Delete", icon: "trash-2", warning: true, run: () => void deleteTask(host, task) },
	];
}
