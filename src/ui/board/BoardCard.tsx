import type { TargetedKeyboardEvent } from "preact";
import { useRef } from "preact/hooks";
import type { BoardCard as BoardCardData } from "../../domain/board";
import type { ListEntry, QueryContext } from "../../domain/queries";
import { tagLabel } from "../../domain/tags";
import { type SubtaskCount, isActiveSeries } from "../../domain/tasks";
import type { ID } from "../../domain/types";
import type { DbData } from "../../persistence/schema";
import { taskMenu } from "../actions";
import { Icon, TaskCheckbox, hueClass } from "../common";
import { dueSpecOf } from "../format";
import type { UiHost } from "../host";
import { RepeatChip } from "../RepeatChip";
import { onItemKeyDown, useCompleteToggle } from "../rowItem";
import { deadlineMark, dueMark, listMark, noteMark, subtaskMark, toneOf } from "../rowMeta";
import { memoComponent, sameDay, sameEntry, sameLookups, sameSubtasks } from "../rowMemo";

// A board card: the checkbox and title on one line, a meta line under it, and the parent's subtasks
// nested inside the same box. It reuses the row's checkbox, meta colors and context menu.

interface CommonProps {
	host: UiHost;
	state: DbData;
	ctx: QueryContext;
	selectedId: ID | null;
	/** Show the list (dot and name); false inside that list's own view and for nested subtasks. */
	showCategory: boolean;
	counts: ReadonlyMap<ID, SubtaskCount>;
	onSelect: (id: ID) => void;
	draggingId: ID | null;
	/** The card or subtask a drag would drop before; draws the line. */
	dropBeforeId: ID | null;
}

/** The meta line: date (colored), list, tags as pills, note, subtasks n/m. */
function BoardMeta({ host, state, ctx, entry, showCategory, subtasks }: {
	host: UiHost;
	state: DbData;
	ctx: QueryContext;
	entry: ListEntry;
	showCategory: boolean;
	subtasks: SubtaskCount | undefined;
}) {
	const { task } = entry;
	const done = task.status === "completed";
	// The effective schedule, so a repeating card shows its current occurrence.
	const due = dueSpecOf(task, entry.schedule);
	const tone = toneOf(done, due, ctx);
	const repeats = isActiveSeries(task);
	const category = state.categories.get(task.categoryId);
	const subCount = task.parentId === null ? (subtasks?.total ?? 0) : 0;
	const hasMeta =
		due !== null || repeats || (showCategory && category !== undefined) || task.tagKeys.length > 0 || task.descriptionNote !== null || subCount > 0;
	if (!hasMeta) return null;
	return (
		<div class="cp-board-meta">
			{due !== null && dueMark(due, tone, ctx)}
			{repeats && <RepeatChip host={host} task={task} />}
			{deadlineMark(host, entry, ctx)}
			{showCategory && category !== undefined && listMark(category)}
			{task.tagKeys.map((key) => (
				<span key={key} class={`cp-tag-pill ${hueClass(state.tags.get(key)?.color)}`}>
					@{tagLabel(state.tags, key)}
				</span>
			))}
			{task.descriptionNote !== null && noteMark(host, task.descriptionNote.path)}
			{subtaskMark(subCount, subtasks)}
		</div>
	);
}

/** One task in a card: the parent, or a nested subtask. Focusable; Alt+Arrow and the menu keys work on it. */
function BoardItem(props: CommonProps & {
	entry: ListEntry;
	isSub: boolean;
	/** The parent's collapse chevron: undefined when it has no nested subtasks. */
	collapse?: { collapsed: boolean; toggle: () => void };
	/** In a windowed column, the column's item count and this item's 1-based position. */
	setSize?: number;
	posInSet?: number;
}) {
	const { host, state, ctx, entry, isSub } = props;
	const { task } = entry;
	const done = task.status === "completed";
	const itemRef = useRef<HTMLDivElement>(null);
	const { completing, justCompleted, toggle, animationEnded } = useCompleteToggle(host, task, itemRef);

	const selected = task.id === props.selectedId;
	const open = () => props.onSelect(task.id);
	const menuFor = (el: HTMLElement) => taskMenu(host, task, ctx.today, open, el);
	const onKeyDown = (e: TargetedKeyboardEvent<HTMLDivElement>) => {
		if (e.altKey) return;
		onItemKeyDown(e, host, { listSelector: ".cp-board-col-body", itemSelector: ".cp-board-item", toggle: () => toggle(task), open, menu: menuFor });
	};

	return (
		<div
			class={`cp-board-item${isSub ? " is-sub" : ""}${selected ? " is-selected" : ""}${done ? " is-completed" : ""}${completing ? " is-completing" : ""}${justCompleted ? " is-just-completed" : ""}${props.draggingId === task.id ? " is-dragging" : ""}${props.dropBeforeId === task.id ? " is-drop-before" : ""}`}
			role="option"
			aria-selected={selected}
			aria-setsize={props.setSize}
			aria-posinset={props.posInSet}
			tabIndex={0}
			data-task-id={task.id}
			ref={itemRef}
			onClick={open}
			onKeyDown={onKeyDown}
			onAnimationEnd={animationEnded}
			onContextMenu={(e) => {
				e.preventDefault();
				host.showMenu(e, menuFor(e.currentTarget));
			}}
		>
			<div class="cp-board-line">
				{props.collapse !== undefined && (
					<button
						type="button"
						class="cp-board-chevron clickable-icon"
						aria-label={props.collapse.collapsed ? "Expand subtasks" : "Collapse subtasks"}
						aria-expanded={!props.collapse.collapsed}
						tabIndex={-1}
						onClick={(e) => {
							e.stopPropagation();
							props.collapse?.toggle();
						}}
					>
						<Icon host={host} icon={props.collapse.collapsed ? "chevron-right" : "chevron-down"} />
					</button>
				)}
				<TaskCheckbox done={done} title={task.title} tabIndex={-1} priority={task.priority} onToggle={() => toggle(task)} />
				<div class="cp-board-title">
					{entry.parentTitle !== null && <span class="cp-parent-prefix">{entry.parentTitle} › </span>}
					{task.title}
				</div>
			</div>
			<BoardMeta
				host={host}
				state={state}
				ctx={ctx}
				entry={entry}
				showCategory={props.showCategory && !isSub}
				subtasks={props.counts.get(task.id)}
			/>
		</div>
	);
}

type BoardCardProps = CommonProps & {
	card: BoardCardData;
	collapsed: boolean;
	onToggleCollapse: (id: ID) => void;
	/** The end-of-list line for this card's subtasks. */
	dropEnd: boolean;
	/** In a windowed column, its item count (tasks and shown subtasks) and this card's task's 1-based position. */
	setSize?: number;
	posInSet?: number;
};

/** The card is the same when each of its items (the parent, then its subtasks) draws the same. */
function sameCard(a: BoardCardProps, b: BoardCardProps): boolean {
	if (
		a.host !== b.host ||
		a.showCategory !== b.showCategory ||
		a.onSelect !== b.onSelect ||
		a.onToggleCollapse !== b.onToggleCollapse ||
		a.collapsed !== b.collapsed ||
		a.dropEnd !== b.dropEnd ||
		a.setSize !== b.setSize ||
		a.posInSet !== b.posInSet ||
		!sameDay(a.ctx, b.ctx) ||
		a.card.subtasks.length !== b.card.subtasks.length
	) {
		return false;
	}
	const items = (p: BoardCardProps) => [p.card.entry, ...p.card.subtasks];
	const before = items(a);
	const after = items(b);
	return after.every((entry, i) => {
		const prev = before[i]!;
		const id = entry.task.id;
		return (
			sameEntry(prev, entry) &&
			(a.selectedId === id) === (b.selectedId === id) &&
			(a.draggingId === id) === (b.draggingId === id) &&
			(a.dropBeforeId === id) === (b.dropBeforeId === id) &&
			sameSubtasks(a.counts.get(id), b.counts.get(id)) &&
			sameLookups(a.state, b.state, entry.task)
		);
	});
}

/** A card: the task, and its nested subtasks under it while expanded. Skipped while `sameCard`. */
export const BoardCard = memoComponent(BoardCardView, sameCard);

function BoardCardView(props: BoardCardProps) {
	const { card } = props;
	const id = card.entry.task.id;
	const nested = card.subtasks.length > 0;
	return (
		<div class={`cp-board-card${props.draggingId === id ? " is-dragging" : ""}${props.dropEnd ? " is-drop-end" : ""}`} data-task-id={id}>
			<BoardItem
				{...props}
				entry={card.entry}
				isSub={false}
				posInSet={props.posInSet}
				collapse={nested ? { collapsed: props.collapsed, toggle: () => props.onToggleCollapse(id) } : undefined}
			/>
			{nested && !props.collapsed && (
				<div class="cp-board-subs">
					{card.subtasks.map((s, k) => (
						<BoardItem key={s.task.id} {...props} entry={s} isSub={true} posInSet={props.posInSet === undefined ? undefined : props.posInSet + 1 + k} />
					))}
				</div>
			)}
		</div>
	);
}
