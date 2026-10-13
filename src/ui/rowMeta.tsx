import { NOT_SYNCED_TITLE, notSyncedReason } from "../app/syncMarks";
import type { ListEntry, QueryContext } from "../domain/queries";
import { isDeadlineMissed } from "../domain/queries";
import type { SubtaskCount } from "../domain/tasks";
import type { Category, DateSpec, Task } from "../domain/types";
import type { DbData } from "../persistence/schema";
import { Icon, hueClass } from "./common";
import { focusedText } from "./focus/format";
import { focusTotalsOf } from "./focus/totals";
import { type DateTone, dateTone, formatDateSpec, rowDateText } from "./format";
import type { UiHost } from "./host";
import { ICON } from "./icons";

// The pieces of a task's meta line that a list row (TaskRow) and a board card (BoardCard) draw the same way.
// Plain functions returning markup, not components: a row renders them inline, without a component per piece.

/** The color of a row's date: a done task has none. */
export function toneOf(done: boolean, due: DateSpec | null, ctx: QueryContext): DateTone {
	return done ? "none" : dateTone(due, ctx.zone, ctx.today);
}

/** The date (colored by its tone). */
export function dueMark(due: DateSpec, tone: DateTone, ctx: QueryContext) {
	return <span class={`cp-meta-date is-${tone}`}>{rowDateText(due, ctx.zone, ctx.today)}</span>;
}

/** The deadline flag, beside a schedule; nothing for a task without both. */
export function deadlineMark(host: UiHost, entry: ListEntry, ctx: QueryContext) {
	const { task } = entry;
	if (entry.schedule === null || task.deadline === null) return null;
	return (
		<span class={`cp-meta-deadline${isDeadlineMissed(task, ctx) ? " is-missed" : ""}`} title="Deadline">
			<Icon host={host} icon={ICON.flag} />
			{formatDateSpec(task.deadline, ctx.zone, ctx.today)}
		</span>
	);
}

/** The list's dot and name. */
export function listMark(category: Category) {
	return (
		<span class="cp-meta-list">
			<span class={`cp-list-dot ${hueClass(category.color)}`} aria-hidden="true" />
			<span class="cp-meta-list-name">{category.name}</span>
		</span>
	);
}

/** The "done/total" of a parent's subtasks; nothing for a count of 0. */
export function subtaskMark(total: number, counts: SubtaskCount | undefined) {
	if (total <= 0) return null;
	return (
		<span class="cp-meta-subtasks" title="Subtasks done">
			{counts?.done ?? 0}/{total}
		</span>
	);
}

/** The description-note mark; the card also shows the note's path as its tooltip. */
export function noteMark(host: UiHost, title?: string) {
	return (
		<span class="cp-meta-note" title={title} aria-label="Has description note" role="img">
			<Icon host={host} icon={ICON.note} />
		</span>
	);
}

/** "Not synced" on an open task of a TickTick list that does not sync; nothing otherwise. Compared by `sameSyncMark`. */
export function notSyncedMark(state: DbData, task: Task) {
	const reason = notSyncedReason(state.syncLinks, task);
	if (reason === null) return null;
	return (
		<span class="cp-meta-notsynced" title={NOT_SYNCED_TITLE[reason]}>
			Not synced
		</span>
	);
}

/** The task's focused time; nothing without any. Compared by `sameFocusTotal`. */
export function focusMark(host: UiHost, state: DbData, task: Task) {
	const sec = focusTotalsOf(state).get(task.id) ?? 0;
	if (sec <= 0) return null;
	return (
		<span class="cp-meta-focus" title="Focused time">
			<Icon host={host} icon={ICON.railFocus} />
			<span aria-hidden="true">{focusedText(sec)}</span>
			<span class="cp-sr-only">{`${focusedText(sec)} focused`}</span>
		</span>
	);
}
