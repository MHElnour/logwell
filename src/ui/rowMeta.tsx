import type { ComponentChild } from "preact";
import { NOT_SYNCED_TITLE, notSyncedReason } from "../app/syncMarks";
import type { ListEntry, QueryContext } from "../domain/queries";
import { isDeadlineMissed } from "../domain/queries";
import { tagLabel } from "../domain/tags";
import { type SubtaskCount, isActiveSeries } from "../domain/tasks";
import type { Category, DateSpec, Task } from "../domain/types";
import type { DbData } from "../persistence/schema";
import { Icon, hueClass } from "./common";
import { focusedText } from "./focus/format";
import { focusTotalsOf } from "./focus/totals";
import { type DateTone, dateTone, formatDateSpec, formatDuration, rowDateText } from "./format";
import type { UiHost } from "./host";
import { ICON } from "./icons";
import { quadrantWords } from "./matrix/quadrants";
import { RepeatChip } from "./RepeatChip";

// The marks of a task's meta line, and their one order (`metaLine`), for a list row (TaskRow) and a board card
// (BoardCard) alike. Plain functions returning markup, not components: a row renders them inline, without a
// component per piece. The row's and the card's memo comparators (`rowMemo.ts`) name what these read.

/** The color of a row's date: a done task has none. */
export function toneOf(done: boolean, due: DateSpec | null, ctx: QueryContext): DateTone {
	return done ? "none" : dateTone(due, ctx.zone, ctx.today);
}

/**
 * The date (colored by its tone). A task with only a deadline shows it here, with the flag: the flag always means
 * "deadline", and a missed one is red by its tone.
 */
export function dueMark(host: UiHost, entry: ListEntry, due: DateSpec, tone: DateTone, ctx: QueryContext) {
	const text = rowDateText(due, ctx.zone, ctx.today);
	if (entry.schedule !== null) return <span class={`cp-meta-date is-${tone}`}>{text}</span>;
	return (
		<span class={`cp-meta-date is-${tone} is-deadline`} title="Deadline">
			<Icon host={host} icon={ICON.flag} />
			<span class="cp-sr-only">Deadline</span>
			<span>{text}</span>
		</span>
	);
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

/** Each of the task's tags as tinted text: "@label" in the tag's color. */
export function tagMarks(state: DbData, tagKeys: readonly string[]) {
	return tagKeys.map((key) => (
		<span key={key} class={`cp-meta-tag ${hueClass(state.tags.get(key)?.color)}`}>
			@{tagLabel(state.tags, key)}
		</span>
	));
}

/** The "done/total" of a parent's subtasks; nothing for a count of 0. */
export function subtaskMark(host: UiHost, total: number, counts: SubtaskCount | undefined) {
	if (total <= 0) return null;
	return (
		<span class="cp-meta-subtasks" title="Subtasks done">
			<Icon host={host} icon={ICON.subtasks} />
			{counts?.done ?? 0}/{total}
		</span>
	);
}

/** The description-note mark. */
export function noteMark(host: UiHost) {
	return (
		<span class="cp-meta-note" aria-label="Has description note" role="img">
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

/**
 * The task's time: its focused time ("25m", or "25m of 30m" beside a planned time), else its planned time, else
 * nothing. One mark for both. Compared by `sameFocusTotal` (and the task record, which holds the planned time).
 */
export function timeMark(host: UiHost, state: DbData, task: Task) {
	const sec = focusTotalsOf(state).get(task.id) ?? 0;
	const planned = task.plannedDurationMin;
	if (sec > 0) {
		const focused = focusedText(sec);
		const shown = planned === null ? focused : `${focused} of ${formatDuration(planned)}`;
		return (
			<span class="cp-meta-focus" title="Focused time">
				<Icon host={host} icon={ICON.railFocus} />
				<span aria-hidden="true">{shown}</span>
				<span class="cp-sr-only">{planned === null ? `${focused} focused` : `${focused} focused of ${formatDuration(planned)} planned`}</span>
			</span>
		);
	}
	if (planned === null) return null;
	return (
		<span class="cp-meta-duration" title="Planned time">
			<Icon host={host} icon={ICON.clock} />
			{formatDuration(planned)}
		</span>
	);
}

/** The task's matrix flags ("Urgent · Important"); nothing for a task with neither. */
export function matrixMark(task: Task) {
	if (!task.urgent && !task.important) return null;
	return (
		<span class="cp-meta-matrix" title="Matrix flags">
			{quadrantWords(task.urgent, task.important)}
		</span>
	);
}

/**
 * The second line of a row and the meta line of a card, the one order of the marks: list, tags, deadline, repeat,
 * subtasks, note, time, matrix flags, "Not synced". `lead` is drawn first (a card's date). Nothing when there is
 * no mark. `showCategory` and `showMatrix` are the places where the list or the flags are said elsewhere; `subtasks` is the
 * parent's totals (a subtask shows none).
 */
export function metaLine(
	cls: string,
	host: UiHost,
	state: DbData,
	entry: ListEntry,
	ctx: QueryContext,
	o: { showCategory: boolean; showMatrix: boolean; subtasks: SubtaskCount | undefined; lead?: ComponentChild },
) {
	const { task } = entry;
	const category = o.showCategory ? state.categories.get(task.categoryId) : undefined;
	const lead = o.lead ?? null;
	const list = category === undefined ? null : listMark(category);
	const tags = tagMarks(state, task.tagKeys);
	const deadline = deadlineMark(host, entry, ctx);
	const repeats = entry.occurrence === null && isActiveSeries(task);
	const subtasks = subtaskMark(host, task.parentId === null ? (o.subtasks?.total ?? 0) : 0, o.subtasks);
	const note = task.descriptionNote === null ? null : noteMark(host);
	const time = timeMark(host, state, task);
	const matrix = o.showMatrix ? matrixMark(task) : null;
	const notSynced = entry.occurrence === null ? notSyncedMark(state, task) : null;
	if (lead === null && list === null && tags.length === 0 && deadline === null && !repeats && subtasks === null && note === null && time === null && matrix === null && notSynced === null) {
		return null;
	}
	return (
		<div class={cls}>
			{lead}
			{list}
			{tags}
			{deadline}
			{repeats && <RepeatChip host={host} task={task} today={ctx.today} />}
			{subtasks}
			{note}
			{time}
			{matrix}
			{notSynced}
		</div>
	);
}
