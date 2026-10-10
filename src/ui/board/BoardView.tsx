import type { ComponentChildren } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { DST_WARNING_TEXT, type TaskPatch } from "../../app/TaskService";
import type { BoardCard as BoardCardData, BoardColumn } from "../../domain/board";
import { moveToDate, moveSameMoment } from "../../domain/calendar";
import type { ListEntry, QueryContext } from "../../domain/queries";
import type { SubtaskCount } from "../../domain/tasks";
import { dateSpecDate } from "../../domain/time";
import type { DateSpec, ID, LocalDate, Task } from "../../domain/types";
import type { DbData } from "../../persistence/schema";
import { writeTaskResult } from "../actions";
import { type Reanchored, notifyReanchored } from "../repeatActions";
import { CompletedGroup } from "../CompletedGroup";
import { AddSectionField } from "../AddSectionField";
import { Icon, IconButton } from "../common";
import { useStableCallback, useSubtaskCounts, useUniqueId } from "../hooks";
import type { UiHost } from "../host";
import { routedMoves, useMoveEvent } from "../moveKeys";
import { sectionMenu } from "../sectionActions";
import { taskRowFor } from "../TaskRow";
import { VIRTUAL_THRESHOLD } from "../virtual";
import { onWindowedColumnKeyDown } from "../virtualKeys";
import { VirtualRows } from "../VirtualRows";
import { BoardCard } from "./BoardCard";
import { BOARD_MOVE_EVENT } from "./keys";
import { type BoardDrop, useBoardDrag } from "./useBoardDrag";
import { useColumnDrag } from "./useColumnDrag";

// The board: one scrolling row of columns, each with its cards and its Completed group.
// Every move (a drop, Alt+Arrow) is one write: TaskService.place in the Default sort, one task update
// otherwise. So it is one undo entry, with an Undo notice only when something changed.

/** The patch that puts a task on `date`, keeping its time (the `moveToDate` rule); empty when it is there already. */
export function datePatch(task: Task, date: LocalDate, zone: string, schedule?: DateSpec | null): TaskPatch {
	// A series has no `scheduled` of its own; `schedule` is its current occurrence, which keeps its time and zone.
	const own = schedule === undefined ? task.scheduled : schedule;
	const field: "scheduled" | "deadline" = own !== null || task.deadline === null ? "scheduled" : "deadline";
	const current: DateSpec | null = field === "scheduled" ? own : task.deadline;
	const next: DateSpec = current === null ? { kind: "date", date } : moveToDate(current, date, zone);
	return moveSameMoment(current, next, zone) ? {} : { [field]: next };
}

/**
 * The patch a drop on `to` makes (empty when the card changes no day). Dropping an Overdue card on Today
 * also moves a past deadline, so the card does not stay Overdue: each date keeps its time.
 */
export function columnPatch(task: Task, to: BoardColumn, ctx: QueryContext, schedule?: DateSpec | null): TaskPatch {
	// A column of an Inbox or list board is a section (a day column has none).
	if (to.sectionId !== undefined) return task.sectionId === to.sectionId ? {} : { sectionId: to.sectionId };
	if (to.date === null) return {};
	const patch = datePatch(task, to.date, ctx.zone, schedule);
	const { scheduled, deadline } = task;
	if (to.id === "today" && scheduled !== null && deadline !== null) {
		const past = (spec: DateSpec) => dateSpecDate(spec, ctx.zone) < ctx.today;
		if (past(scheduled) && past(deadline)) {
			const next = moveToDate(deadline, to.date, ctx.zone);
			if (!moveSameMoment(deadline, next, ctx.zone)) patch.deadline = next;
		}
	}
	return patch;
}

/** A card's height before one was measured: a task line and a meta line. */
const CARD_ESTIMATE_PX = 64;
const cardKey = (card: BoardCardData) => card.entry.task.id;

export function BoardView(props: {
	host: UiHost;
	state: DbData;
	ctx: QueryContext;
	columns: BoardColumn[];
	selectedId: ID | null;
	showCategory: boolean;
	/** The "Default" sort: a card can be placed among its neighbours. */
	manual: boolean;
	readOnly: boolean;
	showCompleted: boolean;
	/** The preset a column's "+" starts from, apart from the day. */
	addCategoryId: ID;
	/** Changes when the view menu's "Add section" is picked: the "+ Add section" column opens its field. */
	addSectionRequest: number;
	/** Identifies the view and its filter; a change starts each Completed group's paging again. */
	resetKey: string;
	completedOpen: (columnId: string) => boolean;
	onToggleCompleted: (columnId: string) => void;
	onSelect: (id: ID) => void;
	/**
	 * A column drawn before the task columns that is not one of `columns`: the Today view's Habits
	 * column. It takes no drop and no keyboard move, because none of the board's lookups can reach it.
	 */
	leading?: ComponentChildren;
	/** The subtask counts of every task, when the caller has them; counted here when left out. */
	subtaskCounts?: ReadonlyMap<ID, SubtaskCount>;
}) {
	const { host, state, ctx, columns } = props;
	const baseId = useUniqueId("cp-board");
	const rootRef = useRef<HTMLDivElement>(null);
	const ownCounts = useSubtaskCounts(state.tasks, props.subtaskCounts === undefined);
	const counts = props.subtaskCounts ?? ownCounts;
	const [collapsed, setCollapsed] = useState<ReadonlySet<ID>>(new Set());
	const [announcement, setAnnouncement] = useState("");
	// Sections exist on Inbox and list boards only; the "+ Add section" column is their last column.
	const sectioned = columns.some((c) => c.sectionId !== undefined);
	// The field belongs to the list it was opened in, so it does not follow the user into another list and no
	// effect has to close it: one that ran late would undo a click made right after the board mounted.
	const [addingIn, setAddingIn] = useState<ID | null>(null);
	const adding = addingIn === props.addCategoryId;
	const seenRequest = useRef(props.addSectionRequest);
	// A layout effect: the field is in the DOM one render after the menu pick.
	useLayoutEffect(() => {
		if (props.addSectionRequest === seenRequest.current) return;
		seenRequest.current = props.addSectionRequest;
		if (!props.readOnly && sectioned) setAddingIn(props.addCategoryId);
	}, [props.addSectionRequest]);
	// The card to focus once the re-render put it in its new place. A ref, never the event target: that
	// element is gone after the move. `column` is where a key sent it, so a quick second key builds on it.
	const pending = useRef<{ id: ID; column: string } | null>(null);
	const columnsRef = useRef(columns);
	columnsRef.current = columns;
	const propsRef = useRef(props);
	propsRef.current = props;

	useLayoutEffect(() => {
		const p = pending.current;
		if (p === null) return;
		const el = [...(rootRef.current?.querySelectorAll<HTMLElement>(".cp-board-item") ?? [])].find((e) => e.dataset.taskId === p.id);
		// Wait for the card to be in the column the key sent it to: a render before the write lands
		// (the announcement reset) still shows it in the old one, and it is rebuilt when it moves.
		if (el === undefined || el.closest<HTMLElement>(".cp-board-col")?.dataset.column !== p.column) return;
		pending.current = null;
		el.focus();
	});

	// A fixed identity, so a card skips its render while nothing it draws changed.
	const toggleCollapse = useStableCallback((id: ID) => {
		const next = new Set(collapsed);
		if (!next.delete(id)) next.add(id);
		setCollapsed(next);
	});

	/**
	 * Writes a move; the store label of the write when something changed, else null. `to` is set only
	 * when the card changes column: that is when its day changes. `order` is placed only under the
	 * Default sort ("Move task"); otherwise the patch goes through `update` ("Edit task"). The Undo
	 * notice must carry the same label, or its Undo throws UndoConflict (`undoIfLatest`).
	 */
	const write = async (
		id: ID,
		order: ID[],
		to: BoardColumn | null,
	): Promise<{ label: "Move task" | "Edit task"; reanchored: Reanchored | null } | null> => {
		const task = host.app.store.state.tasks.get(id);
		if (task === undefined) return null;
		// A series moves by its current occurrence (it has no `scheduled`), keeping the time.
		const schedule = task.recurrence === null ? undefined : host.app.effectiveSchedule(task);
		const patch = to !== null ? columnPatch(task, to, ctx, schedule) : {};
		if (propsRef.current.manual) {
			try {
				const { changed, warnings, reanchored } = await host.app.tasks.place(id, order, patch);
				for (const w of warnings) host.notify(DST_WARNING_TEXT[w]);
				return changed !== false ? { label: "Move task", reanchored: reanchored ?? null } : null;
			} catch (err) {
				host.error(err);
				return null;
			}
		}
		if (Object.keys(patch).length === 0) return null;
		const r = await writeTaskResult(host, task, patch);
		return r.outcome === "changed" ? { label: "Edit task", reanchored: r.reanchored } : null;
	};

	const drop = (d: BoardDrop) => {
		const title = host.app.store.state.tasks.get(d.id)?.title ?? "Task";
		const moved = d.to.id !== d.from;
		void write(d.id, d.order, moved ? d.to : null).then((done) => {
			if (done === null) return;
			// A series' date change re-anchors it: that notice replaces the move notice.
			if (done.reanchored !== null) notifyReanchored(host, { title }, done.reanchored, done.label);
			else host.notifyUndo(moved ? `Moved "${title}" to ${d.to.title}.` : `Moved "${title}".`, done.label);
		});
	};

	const drag = useBoardDrag({
		root: () => rootRef.current,
		columns: () => columnsRef.current,
		parentOf: (id) => host.app.store.state.tasks.get(id)?.parentId ?? null,
		onDrop: drop,
	});

	// Dragging a section column's header reorders the sections of the list.
	const columnDrag = useColumnDrag({
		root: () => rootRef.current,
		sectionIds: () => columnsRef.current.flatMap((c) => (c.sectionId == null ? [] : [c.sectionId])),
		onDrop: (id, order) => {
			const title = host.app.store.state.sections.get(id)?.name ?? "Section";
			void host.app.sections
				.place(id, order)
				.then(({ changed }) => {
					if (changed) host.notifyUndo(`Moved section "${title}".`, "Move section");
				})
				.catch((err) => host.error(err));
		},
	});

	/** The column and the list of sibling ids a task sits in, as drawn. */
	const locate = (id: ID): { column: BoardColumn; siblings: ID[]; nested: boolean } | null => {
		for (const column of columnsRef.current) {
			const card = column.cards.find((c) => c.entry.task.id === id);
			if (card !== undefined) {
				const parentId = card.entry.task.parentId;
				const siblings = column.cards.filter((c) => c.entry.task.parentId === parentId).map((c) => c.entry.task.id);
				return { column, siblings, nested: false };
			}
			const parent = column.cards.find((c) => c.subtasks.some((s) => s.task.id === id));
			if (parent !== undefined) return { column, siblings: parent.subtasks.map((s) => s.task.id), nested: true };
		}
		return null;
	};

	const moveFromKeyboard = (id: ID, columnId: string, to: BoardColumn | null, order: ID[], message: (title: string) => string) => {
		pending.current = { id, column: columnId };
		// Clear first: the same message twice in a row is only announced when the text changes in between.
		setAnnouncement("");
		void write(id, order, to).then((moved) => {
			if (moved) setAnnouncement(message(host.app.store.state.tasks.get(id)?.title ?? "Task"));
			else if (pending.current?.id === id) pending.current = null;
		});
	};

	/** Alt+Arrow on a card; true only when it acted, so a key that cannot move anything is left to Obsidian. */
	const keyMove = (item: HTMLElement, key: string): boolean => {
		if (propsRef.current.readOnly) return false;
		const id = item.dataset.taskId;
		if (id === undefined || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(key)) return false;
		const at = locate(id);
		if (at === null) return false;
		if (key === "ArrowUp" || key === "ArrowDown") {
			if (!propsRef.current.manual) return false;
			const i = at.siblings.indexOf(id);
			const j = key === "ArrowUp" ? i - 1 : i + 1;
			if (i < 0 || j < 0 || j >= at.siblings.length) return false;
			const order = [...at.siblings];
			order.splice(i, 1);
			order.splice(j, 0, id);
			moveFromKeyboard(id, at.column.id, null, order, () => `Moved ${key === "ArrowUp" ? "up" : "down"}, position ${j + 1} of ${order.length}`);
			return true;
		}
		// A nested subtask never leaves its parent's card.
		if (at.nested) return false;
		const cols = columnsRef.current;
		const p = pending.current;
		const here = p !== null && p.id === id ? p.column : at.column.id;
		const from = cols.findIndex((c) => c.id === here);
		const step = key === "ArrowLeft" ? -1 : 1;
		const to = cols[from + step];
		if (to === undefined || !to.acceptsDrop || (to.date === null && to.sectionId === undefined)) return false;
		// A subtask always stays in its parent's section.
		if (to.sectionId !== undefined && (host.app.store.state.tasks.get(id)?.parentId ?? null) !== null) return false;
		const targetSiblings = to.cards.filter((c) => c.entry.task.id !== id && c.entry.task.parentId === (host.app.store.state.tasks.get(id)?.parentId ?? null)).map((c) => c.entry.task.id);
		moveFromKeyboard(id, to.id, to, [...targetSiblings, id], (title) => `Moved "${title}" to ${to.title}`);
		return true;
	};

	const onKeyDownCapture = (e: KeyboardEvent) => {
		const item = e.target as HTMLElement | null;
		if (item === null || !item.classList?.contains("cp-board-item") || e.ctrlKey || e.metaKey || e.shiftKey || !e.altKey) return;
		// The view's Scope already moved the card for this key (Obsidian's hotkeys run before the page).
		if (routedMoves.has(e)) {
			e.preventDefault();
			e.stopPropagation();
			return;
		}
		if (!keyMove(item, e.key)) return;
		// Before the item's own handler: Alt+Arrow must not move focus between cards.
		e.preventDefault();
		e.stopPropagation();
	};

	// Alt+Arrow arrives as an event from the view's Scope (see board/keys.ts).
	useMoveEvent(rootRef, BOARD_MOVE_EVENT, ".cp-board-item", keyMove);

	/**
	 * The drop target a column draws. Without the Default sort a card is not placed, so a same-column drop
	 * draws nothing and another column only shows its highlight (no line).
	 */
	const overFor = (columnId: string) => {
		const o = drag.over;
		if (o === null || o.columnId !== columnId) return null;
		if (props.manual || o.refused) return o;
		return o.from === o.columnId ? null : { ...o, beforeId: null, endKey: "" };
	};

	return (
		<div
			class={`cp-board${drag.draggingId !== null ? " is-dragging-card" : ""}`}
			ref={rootRef}
			onKeyDownCapture={onKeyDownCapture}
			onPointerDown={
				props.readOnly
					? undefined
					: (e) => {
							drag.onPointerDown(e);
							columnDrag.onPointerDown(e);
						}
			}
		>
			<div class={`cp-board-scroll${columnDrag.draggingId !== null ? " is-dragging-column" : ""}`}>
				{props.leading}
				{columns.map((col) => (
					<Column
						key={col.id}
						{...props}
						column={col}
						idBase={`${baseId}-${col.id}`}
						counts={counts}
						collapsed={collapsed}
						onToggleCollapse={toggleCollapse}
						draggingId={drag.draggingId}
						over={overFor(col.id)}
						draggingColumn={columnDrag.draggingId !== null && columnDrag.draggingId === col.sectionId}
						columnDropBefore={columnDrag.beforeId != null && columnDrag.beforeId === col.sectionId}
						movingId={pending.current?.column === col.id ? pending.current.id : null}
					/>
				))}
				{sectioned && !props.readOnly && (
					<div class={`cp-board-add-col${columnDrag.draggingId !== null && columnDrag.beforeId === null ? " is-column-drop-end" : ""}`}>
						{adding ? (
							<AddSectionField host={host} categoryId={props.addCategoryId} cls="is-board" onClose={() => setAddingIn(null)} />
						) : (
							<button type="button" class="cp-board-add-section" onClick={() => setAddingIn(props.addCategoryId)}>
								<Icon host={host} icon="plus" />
								<span>Add section</span>
							</button>
						)}
					</div>
				)}
			</div>
			<span class="cp-sr-only" role="status" aria-live="polite">
				{announcement}
			</span>
		</div>
	);
}

function Column(props: Parameters<typeof BoardView>[0] & {
	column: BoardColumn;
	idBase: string;
	counts: ReadonlyMap<ID, SubtaskCount>;
	collapsed: ReadonlySet<ID>;
	onToggleCollapse: (id: ID) => void;
	draggingId: ID | null;
	over: { beforeId: ID | null; endKey: string; refused: boolean } | null;
	/** This section column is being dragged / the dragged column would land before it. */
	draggingColumn: boolean;
	columnDropBefore: boolean;
	/** A card Alt+Arrow is moving into this column: drawn even when the column is windowed, so focus can follow it. */
	movingId: ID | null;
}) {
	const { host, column, idBase, over } = props;
	const section = column.sectionId == null ? undefined : props.state.sections.get(column.sectionId);
	const titleId = `${idBase}-title`;
	const cardCount = column.cards.length;
	// A column with more items (cards and their subtasks) than the threshold draws only the cards near its viewport.
	const windowed = column.cards.reduce((n, c) => n + 1 + c.subtasks.length, 0) > VIRTUAL_THRESHOLD;
	const dragged = props.draggingId;
	const pinned = [
		dragged === null ? null : (column.cards.find((c) => c.entry.task.id === dragged || c.subtasks.some((s) => s.task.id === dragged))?.entry.task.id ?? null),
		props.movingId,
	];
	// Windowed, each item tells assistive technology the column's size and its position (cards and the
	// subtasks they show), since not every card is in the DOM. A plain column's markup carries neither.
	let positions: number[] | null = null;
	let setSize = 0;
	if (windowed) {
		positions = column.cards.map((c) => {
			const at = setSize + 1;
			setSize += 1 + (props.collapsed.has(c.entry.task.id) ? 0 : c.subtasks.length);
			return at;
		});
	}
	const card = (data: BoardCardData, index?: number) => (
		<BoardCard
			key={data.entry.task.id}
			card={data}
			host={host}
			state={props.state}
			ctx={props.ctx}
			selectedId={props.selectedId}
			showCategory={props.showCategory}
			counts={props.counts}
			onSelect={props.onSelect}
			draggingId={props.draggingId}
			dropBeforeId={over?.beforeId ?? null}
			collapsed={props.collapsed.has(data.entry.task.id)}
			onToggleCollapse={props.onToggleCollapse}
			dropEnd={over?.endKey === data.entry.task.id}
			setSize={positions === null ? undefined : setSize}
			posInSet={positions === null || index === undefined ? undefined : positions[index]}
		/>
	);
	const completedRow = (entry: ListEntry) => taskRowFor(props, props.counts, entry, props.showCategory);
	return (
		<section
			class={`cp-board-col${column.tone === undefined ? "" : ` is-${column.tone}`}${over !== null && !over.refused ? " is-drop-target" : ""}${over?.refused === true ? " is-refused" : ""}${props.draggingColumn ? " is-dragging-column" : ""}${props.columnDropBefore ? " is-column-drop-before" : ""}`}
			data-column={column.id}
			data-section-id={section?.id}
			data-date={column.date ?? undefined}
			aria-labelledby={titleId}
		>
			<div class="cp-board-col-head">
				<h3 class="cp-board-col-title" id={titleId}>
					{column.title}
				</h3>
				<span class="cp-board-col-count">{cardCount}</span>
				{column.acceptsDrop && (
					<IconButton
						host={host}
						icon="plus"
						label={`Add task to ${column.title}`}
						cls="cp-board-add"
						disabled={props.readOnly}
						onClick={() =>
							host.quickAdd(
								column.sectionId === undefined
									? { categoryId: props.addCategoryId, date: column.date }
									: { categoryId: props.addCategoryId, date: column.date, sectionId: column.sectionId },
							)
						}
					/>
				)}
				{section !== undefined && (
					<IconButton
						host={host}
						icon="more-horizontal"
						label={`Options for section ${section.name}`}
						cls="cp-board-menu"
						disabled={props.readOnly}
						onClick={(e) => {
							const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
							host.showMenu({ x: r.left, y: r.bottom }, sectionMenu(host, section));
						}}
					/>
				)}
			</div>
			<div class="cp-board-col-body" onKeyDownCapture={windowed ? (e) => onWindowedColumnKeyDown(e, e.currentTarget) : undefined}>
				<VirtualRows
					enabled={windowed}
					items={column.cards}
					keyOf={cardKey}
					renderItem={card}
					box={{ class: `cp-board-cards${over?.endKey === column.id ? " is-drop-end" : ""}`, role: "listbox", "aria-labelledby": titleId }}
					scroller=".cp-board-col-body"
					estimate={CARD_ESTIMATE_PX}
					pinned={pinned}
				/>
				{cardCount === 0 && <p class="cp-board-empty">No tasks</p>}
				{props.showCompleted && column.completed.length > 0 && (
					<div class="cp-task-list cp-board-completed" role="group" aria-labelledby={titleId}>
						<CompletedGroup
							host={host}
							idBase={idBase}
							entries={column.completed}
							open={props.completedOpen(column.id)}
							onToggle={() => props.onToggleCompleted(column.id)}
							renderRow={completedRow}
							resetKey={`${props.resetKey}|${column.id}`}
						/>
					</div>
				)}
			</div>
		</section>
	);
}
