import type { RecurrenceResult } from "../app/RecurrenceService";
import type { ID, LocalDate, Task } from "../domain/types";
import { plural } from "../domain/text";
import { formatDate } from "./format";
import type { UiHost } from "./host";
import { type RepeatChoice, ruleText } from "./repeat";
import { runWrite } from "./writeNotice";

// Writes of repeating tasks, from the row menus, the checkbox, the Completed history and the
// details pane. Every write goes through app.recurrence; the Undo notice carries the label the service wrote
// under and shows only when something was written, as the habit writes do.

export const DEADLINE_CLEARED_TEXT = "The deadline was cleared: a repeating task has no deadline.";

/** What a date change of a series reports (TaskResult.reanchored): its new current occurrence, and whether its end was dropped. */
export interface Reanchored {
	date: LocalDate;
	endCleared: boolean;
}

/**
 * A date change of a series re-anchors the whole series (there is no single-occurrence move), so say so with an Undo
 * notice. `label` is the store label the write ran under ("Edit task", or "Move task" for a board or list move);
 * `mark` is `store.undoMark()` taken right before it.
 */
export function notifyReanchored(host: UiHost, task: Pick<Task, "title">, r: Reanchored, label: string, mark: number): void {
	const end = r.endCleared ? " Its end was removed." : "";
	host.notifyUndo(`"${task.title}" now repeats from ${formatDate(r.date, host.app.queryContext().today)}.${end}`, label, mark);
}

const today = (host: UiHost): LocalDate => host.app.queryContext().today;
const dateText = (host: UiHost, date: LocalDate | null): string => (date === null ? "" : ` for ${formatDate(date, today(host))}`);
const ENDED_TEXT = " The series has ended.";

/**
 * Completes the current occurrence: the checkbox of an open repeating task (the series stays, with its next
 * date). N earlier dates skipped by the catch-up and the end of the series are told in the notice.
 */
export function completeOccurrence(host: UiHost, task: Task): Promise<boolean> {
	return runWrite(
		host,
		() => host.app.recurrence.complete(task.id),
		(r) => {
			const result = r as RecurrenceResult;
			const skipped = result.autoSkipped > 0 ? `, ${plural(result.autoSkipped, "earlier date")} skipped` : "";
			return `Completed "${task.title}"${dateText(host, result.date)}${skipped}.${result.seriesEnded ? ENDED_TEXT : ""}`;
		},
	);
}

/** Skips the current occurrence. */
export function skipOccurrence(host: UiHost, task: Task): Promise<boolean> {
	return runWrite(
		host,
		() => host.app.recurrence.skip(task.id),
		(r) => `Skipped "${task.title}"${dateText(host, (r as RecurrenceResult).date)}.${(r as RecurrenceResult).seriesEnded ? ENDED_TEXT : ""}`,
	);
}

/** Removes the record of one occurrence of the Completed history. */
export function reopenOccurrence(host: UiHost, task: Task, date: LocalDate): Promise<boolean> {
	return runWrite(
		host,
		() => host.app.recurrence.reopen(task.id, date),
		() => `Reopened "${task.title}"${dateText(host, date)}.`,
	);
}

/** "Stop repeating": after a confirmation, the series ends and its history stays in Completed. */
export async function stopRepeating(host: UiHost, task: Task): Promise<boolean> {
	const ok = await host.choose("Stop repeating", `Stop repeating "${task.title}"? Its history stays in Completed.`, [
		{ label: "Stop repeating", value: true, warning: true },
	]);
	if (ok !== true) return false;
	return runWrite(
		host,
		() => host.app.recurrence.stop(task.id),
		() => `Stopped repeating "${task.title}".`,
	);
}

/**
 * The details pane's picker: sets the repeat (null = Never) from today, with the end the picker returned.
 * `anchor` is the date the picker named its hints from (the series' first date), so the notice words the rule as
 * the task will have it ("every Fri", not the weekday of today). A yearly rule on a task that already repeats is
 * named from the series' own first date, which the edit keeps ("yearly on Jan 15").
 */
export function setRepeat(host: UiHost, task: Task, choice: RepeatChoice | null, anchor: LocalDate): Promise<boolean> {
	return runWrite(
		host,
		() => host.app.recurrence.setRepeat(task.id, choice === null ? null : choice.rule, undefined, choice === null ? undefined : choice.end),
		(r) => {
			const base =
				choice === null
					? `"${task.title}" no longer repeats.`
					: `"${task.title}" repeats ${ruleText(choice, anchor, task.recurrence?.anchor)}.`;
			return (r as RecurrenceResult).deadlineCleared ? `${base} ${DEADLINE_CLEARED_TEXT}` : base;
		},
	);
}

// -- "Edit repeat…" from a row menu -----------------------------------------------------------

/** Returns true when it took the request (it opened a picker the user can see). */
type EditListener = (taskId: ID) => boolean;

/**
 * "Edit repeat…" opens the details pane on the task and its Repeat picker. The menu cannot reach the pane's
 * state, so it leaves a request here: a pane that is already open hears it at once, one that mounts after the
 * menu action finds it on mount. A request is only good for a moment (compared with the clock, no timer), so a
 * pane that opens later for another reason does not open a picker nobody asked for.
 */
const listeners = new Set<EditListener>();
let pending: { id: ID; at: number } | null = null;
const FRESH_MS = 1500;

export function requestRepeatEdit(taskId: ID): void {
	pending = { id: taskId, at: Date.now() };
	// A pane that is already open takes it now (and the request is spent); otherwise one that mounts soon finds it.
	// Only the first listener to accept consumes: a hidden background copy has no visible pane to open.
	for (const l of [...listeners]) {
		if (l(taskId)) {
			pending = null;
			return;
		}
	}
}

/**
 * True when the element is on screen: not inside a hidden section, and shown by Obsidian's own test where it has one
 * (`isShown`, which also sees another, background Logwell tab), else by having a layout box.
 */
export function isPaneShown(el: HTMLElement | null): boolean {
	if (el === null || el.closest("[hidden]") !== null) return false;
	const obsidian = el as HTMLElement & { isShown?: () => boolean };
	return typeof obsidian.isShown === "function" ? obsidian.isShown() : el.getClientRects().length > 0;
}

/** True once when a recent request names this task (the pane checks it when it mounts); the request is spent. */
export function hasRepeatEditRequest(taskId: ID, visible = true): boolean {
	// A hidden background copy of the pane (every section keeps one) leaves the request for the visible one.
	if (!visible || pending === null || pending.id !== taskId) return false;
	const fresh = Date.now() - pending.at < FRESH_MS;
	// First consumer wins: hidden copies of the pane and a later re-mount must not open the picker again.
	pending = null;
	return fresh;
}

export function onRepeatEditRequest(listener: EditListener): () => void {
	listeners.add(listener);
	return () => void listeners.delete(listener);
}
