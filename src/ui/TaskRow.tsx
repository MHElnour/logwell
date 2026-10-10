import { useRef } from "preact/hooks";
import { NOT_SYNCED_TITLE, notSyncedReason } from "../app/syncMarks";
import type { ListEntry, QueryContext } from "../domain/queries";
import type { SubtaskCount } from "../domain/tasks";
import type { ID, Task } from "../domain/types";
import type { DbData } from "../persistence/schema";
import { occurrenceMenu, taskMenu } from "./actions";
import { Icon, TaskCheckbox, hueClass } from "./common";
import { dueSpecOf, entryKey, formatDate, formatDuration } from "./format";
import type { UiHost } from "./host";
import { focusedText } from "./focus/format";
import { focusTotalsOf } from "./focus/totals";
import { ICON } from "./icons";
import { quadrantWords } from "./matrix/quadrants";
import { RepeatChip } from "./RepeatChip";
import { deadlineMark, dueMark, listMark, noteMark, subtaskMark, toneOf } from "./rowMeta";
import { memoComponent, sameDay, sameEntry, sameFocusTotal, sameLookups, sameSubtasks, sameSyncMark } from "./rowMemo";
import { onItemKeyDown, useCompleteToggle } from "./rowItem";

/**
 * A row in a dashboard block. It has no selection, no menu and no drag; a click opens the task through
 * `onSelect`, and the checkbox completes through `complete`. One object per block, so memoized rows stay equal.
 */
export interface BlockRowOps {
	complete: (task: Task) => Promise<void>;
}

interface RowProps {
	host: UiHost;
	state: DbData;
	entry: ListEntry;
	ctx: QueryContext;
	selected: boolean;
	/** Show the list (dot and name); false inside that list's own view. */
	showCategory: boolean;
	/** This task's subtask totals, from a map built once per list render. */
	subtasks: SubtaskCount | undefined;
	onSelect: (id: ID) => void;
	/** The row is being dragged (the matrix): it stays in place, dimmed. State, so a re-render keeps it. */
	dragging?: boolean;
	/** Show the "Urgent · Important" chip; false inside the matrix, where the quadrant says it. */
	showMatrix?: boolean;
	/** In a windowed listbox (not every row drawn), its row count and this row's 1-based position. */
	setSize?: number;
	posInSet?: number;
	/** Set in a dashboard block; see BlockRowOps. */
	block?: BlockRowOps;
}

/**
 * The one task row. Lists, search, the calendar drawer, the matrix and the dashboard
 * block reuse it. It re-renders only when something it draws changed (`sameRow`), so
 * `onSelect` must keep its identity between renders of the list.
 */
export const TaskRow = memoComponent(TaskRowView, sameRow);

/**
 * A `TaskRow` for `entry` in a list, a board column or a matrix quadrant: selected when it is the selected task's own
 * row, with its subtask totals from `counts`. `extra` adds what only some callers pass (drag state, set position, block ops).
 */
export function taskRowFor(
	list: Pick<RowProps, "host" | "state" | "ctx" | "onSelect"> & { selectedId: ID | null },
	counts: ReadonlyMap<ID, SubtaskCount>,
	entry: ListEntry,
	showCategory: boolean,
	extra?: Partial<RowProps>,
) {
	return (
		<TaskRow
			key={entryKey(entry)}
			host={list.host}
			state={list.state}
			entry={entry}
			ctx={list.ctx}
			selected={entry.occurrence === null && entry.task.id === list.selectedId}
			showCategory={showCategory}
			subtasks={counts.get(entry.task.id)}
			onSelect={list.onSelect}
			{...extra}
		/>
	);
}

function sameRow(a: RowProps, b: RowProps): boolean {
	return (
		a.host === b.host &&
		a.selected === b.selected &&
		a.showCategory === b.showCategory &&
		a.dragging === b.dragging &&
		a.showMatrix === b.showMatrix &&
		a.setSize === b.setSize &&
		a.posInSet === b.posInSet &&
		a.block === b.block &&
		a.onSelect === b.onSelect &&
		sameDay(a.ctx, b.ctx) &&
		sameEntry(a.entry, b.entry) &&
		sameSubtasks(a.subtasks, b.subtasks) &&
		sameLookups(a.state, b.state, b.entry.task) &&
		sameFocusTotal(a.state, b.state, b.entry.task) &&
		sameSyncMark(a.state, b.state, b.entry.task)
	);
}

function TaskRowView({ host, state, entry, ctx, selected, showCategory, subtasks, onSelect, dragging, showMatrix = true, setSize, posInSet, block }: RowProps) {
	const { task } = entry;
	// A Completed history row is one done occurrence of a repeating task; it reads as completed and reopens that date.
	const occurrence = entry.occurrence;
	const done = occurrence !== null || task.status === "completed";
	const category = state.categories.get(task.categoryId);
	const subCount = task.parentId === null ? (subtasks?.total ?? 0) : 0;
	// The date is the effective schedule (the current occurrence of a repeating task), not task.scheduled.
	const due = occurrence !== null ? null : dueSpecOf(task, entry.schedule);
	const tone = toneOf(done, due, ctx);
	const open = () => onSelect(task.id);
	const rowRef = useRef<HTMLDivElement>(null);
	const { completing, justCompleted, toggle, animationEnded } = useCompleteToggle(host, task, rowRef, occurrence?.date ?? null, block?.complete);
	const menuFor = (el: HTMLElement) => (occurrence === null ? taskMenu(host, task, ctx.today, open, el) : occurrenceMenu(host, task, occurrence.date, open));

	const tags = task.tagKeys;
	const firstTag = tags.length > 0 ? state.tags.get(tags[0]!) : undefined;
	const focusSec = focusTotalsOf(state).get(task.id) ?? 0;
	// An open task of a TickTick list that does not sync says so.
	const notSynced = occurrence === null ? notSyncedReason(state.syncLinks, task) : null;
	return (
		<div
			class={`cp-task-row${selected ? " is-selected" : ""}${done ? " is-completed" : ""}${completing ? " is-completing" : ""}${justCompleted ? " is-just-completed" : ""}${entry.depth === 1 ? " is-subtask" : ""}${dragging === true ? " is-dragging" : ""}`}
			role="option"
			aria-selected={selected}
			aria-setsize={setSize}
			aria-posinset={posInSet}
			tabIndex={0}
			data-task-id={task.id}
			data-row-key={entryKey(entry)}
			data-occurrence={occurrence === null ? undefined : occurrence.date}
			ref={rowRef}
			onClick={open}
			onKeyDown={(e) =>
				onItemKeyDown(e, host, { listSelector: ".cp-task-list", itemSelector: ".cp-task-row", toggle: () => toggle(task), open, menu: block === undefined ? menuFor : undefined })
			}
			onAnimationEnd={animationEnded}
			onContextMenu={
				block === undefined
					? (e) => {
							e.preventDefault();
							host.showMenu(e, menuFor(e.currentTarget));
						}
					: undefined
			}
		>
			<TaskCheckbox done={done} title={task.title} tabIndex={-1} priority={task.priority} onToggle={() => toggle(task)} />
			<div class="cp-task-title">
				{entry.parentTitle !== null && <span class="cp-parent-prefix">{entry.parentTitle} › </span>}
				{task.title}
				{occurrence !== null && <span class="cp-occurrence-date">{` · ${formatDate(occurrence.date, ctx.today)}`}</span>}
			</div>
			<div class="cp-task-meta">
				{tags.length > 0 && (
					<span class="cp-meta-tags" title={tags.map((k) => `@${state.tags.get(k)?.displayName ?? k}`).join(" ")}>
						{/* First tag, then a count, so a pill is never cut off mid-word in a tight row. */}
						<span class={`cp-tag-pill ${hueClass(firstTag?.color)}`}>@{firstTag?.displayName ?? tags[0]}</span>
						{tags.length > 1 && <span class="cp-tag-more">+{tags.length - 1}</span>}
					</span>
				)}
				{task.descriptionNote !== null && noteMark(host)}
				{occurrence === null && task.recurrence !== null && <RepeatChip host={host} task={task} />}
				{notSynced !== null && (
					<span class="cp-meta-notsynced" title={NOT_SYNCED_TITLE[notSynced]}>
						Not synced
					</span>
				)}
				{subtaskMark(subCount, subtasks)}
				{showCategory && category !== undefined && listMark(category)}
				{deadlineMark(host, entry, ctx)}
				{task.plannedDurationMin !== null && <span class="cp-meta-duration">{formatDuration(task.plannedDurationMin)}</span>}
				{focusSec > 0 && (
					<span class="cp-meta-focus" title="Focused time">
						<Icon host={host} icon={ICON.railFocus} />
						<span aria-hidden="true">{focusedText(focusSec)}</span>
						<span class="cp-sr-only">{`${focusedText(focusSec)} focused`}</span>
					</span>
				)}
				{showMatrix && (task.urgent || task.important) && (
					<span class="cp-meta-matrix" title="Matrix flags">
						{quadrantWords(task.urgent, task.important)}
					</span>
				)}
				{due !== null && dueMark(due, tone, ctx)}
			</div>
		</div>
	);
}
