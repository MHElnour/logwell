import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { type MatrixGroup, QUADRANT_ORDER, matrixQuadrants, quadrantFlags } from "../domain/matrix";
import { type ListEntry, type Quadrant, type QueryContext, type TaskFilter, emptyFilter, filterTasks, quadrantOf } from "../domain/queries";
import type { SubtaskCount } from "../domain/tasks";
import type { ID } from "../domain/types";
import type { DbData } from "../persistence/schema";
import { QUADRANTS, writeTask } from "./actions";
import { Icon } from "./common";
import { useActiveMemo, useStableCallback, useSubtaskCounts, useUniqueId } from "./hooks";
import type { UiHost } from "./host";
import { ICON } from "./icons";
import { routedMoves, useMoveEvent } from "./moveKeys";
import { MATRIX_MOVE_EVENT } from "./matrix/keys";
import { QUADRANT_INFO, adjacentQuadrant } from "./matrix/quadrants";
import { useMatrixDrag } from "./matrix/useMatrixDrag";
import { DetailsPane } from "./TaskDetails";
import { taskRowFor } from "./TaskRow";
import { CompletedGroup } from "./CompletedGroup";
import { useLingering } from "./useLingering";
import { ScopeMenuButton } from "./ViewMenu";

// The Eisenhower matrix section. The layout comes from src/domain/matrix.ts;
// this file draws it and offers the moves: the context menu (actions.ts), the keys 1-4 and
// Alt+Arrow on a focused card, and dragging a card onto a quadrant. Every move is one
// TaskService.update on the same task ID.

export interface MatrixSectionState {
	/** Set by the view menu: lists, tags and "Show completed" (status "all", the default). */
	filter: TaskFilter;
	selectedId: ID | null;
	/** Whether each quadrant's Completed group is expanded; kept for the session. */
	completedOpen: Partial<Record<Quadrant, boolean>>;
}

export function initialMatrixState(): MatrixSectionState {
	return { filter: emptyFilter("all"), selectedId: null, completedOpen: {} };
}

const NO_GROUPS: Record<Quadrant, MatrixGroup[]> = { "urgent-important": [], important: [], urgent: [], neither: [] };
const LABEL = new Map(QUADRANTS.map((q) => [q.id, q.label]));

/** Moves a task to a quadrant; true when a change was written. A move to the current one writes nothing. */
async function moveToQuadrant(host: UiHost, id: ID, to: Quadrant): Promise<boolean> {
	const task = host.app.store.state.tasks.get(id);
	if (task === undefined || quadrantOf(task) === to) return false;
	return (await writeTask(host, task, quadrantFlags(to))) === "changed";
}

export function MatrixSection(props: {
	host: UiHost;
	state: DbData;
	ctx: QueryContext;
	ui: MatrixSectionState;
	/** Functional, so several quick changes each build on the latest state. */
	setUi: (update: (s: MatrixSectionState) => MatrixSectionState) => void;
	/** True while the section is shown. */
	visible: boolean;
}) {
	const { host, state, ctx, ui, setUi } = props;
	const baseId = useUniqueId("cp-matrix");
	const gridRef = useRef<HTMLDivElement>(null);
	// The card to focus once the re-render put it in its new quadrant. A ref, never the event
	// target: that element is gone after the move. `q` is where the user sent it, so a quick second
	// key press builds on the first.
	const pending = useRef<{ id: ID; q: Quadrant } | null>(null);
	const [announcement, setAnnouncement] = useState("");

	// A task completed a moment ago stays in its date group until its check animation ends.
	const held = useLingering(state.tasks, props.visible);
	const quadrants = useActiveMemo(
		props.visible,
		() => matrixQuadrants(filterTasks(state.tasks.values(), ui.filter, "", ctx), state.tasks, ctx, held),
		[state.tasks, state.occurrenceRecords, ui.filter, ctx.today, ctx.zone, ctx.weekStart, held],
		NO_GROUPS,
	);
	const counts = useSubtaskCounts(state.tasks, props.visible);

	const select = useStableCallback((id: ID | null) => setUi((s) => ({ ...s, selectedId: id })));

	useLayoutEffect(() => {
		const p = pending.current;
		if (p === null) return;
		const card = gridRef.current?.querySelector<HTMLElement>(`[data-quadrant="${p.q}"] [data-task-id="${p.id}"]`);
		if (card === null || card === undefined) return;
		pending.current = null;
		card.focus();
	});

	const moveFromKeyboard = (id: ID, to: Quadrant) => {
		pending.current = { id, q: to };
		// Clear first: the same message twice in a row is only announced when the text changes in between.
		setAnnouncement("");
		void moveToQuadrant(host, id, to).then((moved) => {
			if (moved) setAnnouncement(`Moved to ${LABEL.get(to) ?? to}`);
			else if (pending.current?.id === id && pending.current.q === to) pending.current = null;
		});
	};

	/** The keys 1-4 and Alt+Arrow on a card; true when the key was a move key (even a no-op one). */
	const keyMove = (row: HTMLElement, key: string, alt: boolean): boolean => {
		const id = row.dataset.taskId;
		const task = id === undefined ? undefined : host.app.store.state.tasks.get(id);
		if (id === undefined || task === undefined) return false;
		const p = pending.current;
		const current = p !== null && p.id === id ? p.q : quadrantOf(task);
		let to: Quadrant | null = null;
		if (!alt && key >= "1" && key <= "4") {
			to = QUADRANT_ORDER[Number(key) - 1] ?? null;
		} else if (alt && (key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown")) {
			to = adjacentQuadrant(current, key, QUADRANT_ORDER);
		} else {
			return false;
		}
		if (to !== null && to !== current) moveFromKeyboard(id, to);
		return true;
	};

	const onKeyDownCapture = (e: KeyboardEvent) => {
		const row = e.target as HTMLElement | null;
		if (row === null || !row.classList?.contains("cp-task-row") || e.ctrlKey || e.metaKey || e.shiftKey) return;
		// The view's Scope already moved the card for this key (Obsidian's hotkeys run before the page).
		if (routedMoves.has(e)) {
			e.preventDefault();
			e.stopPropagation();
			return;
		}
		if (!keyMove(row, e.key, e.altKey)) return;
		// Before the row's own handler: Alt+Arrow must not move focus between cards.
		e.preventDefault();
		e.stopPropagation();
	};

	// Alt+Arrow arrives as an event from the view's Scope (see matrix/keys.ts); the matrix consumes every one.
	useMoveEvent(gridRef, MATRIX_MOVE_EVENT, ".cp-task-row", (row, key) => {
		keyMove(row, key, true);
		return true;
	});

	const drag = useMatrixDrag({
		grid: () => gridRef.current,
		quadrantOfTask: (id) => {
			const t = host.app.store.state.tasks.get(id);
			return t === undefined ? null : quadrantOf(t);
		},
		onDrop: (id, to) => {
			const title = host.app.store.state.tasks.get(id)?.title ?? "Task";
			const mark = host.app.store.undoMark();
			void moveToQuadrant(host, id, to).then((moved) => {
				if (moved) host.notifyUndo(`Moved "${title}" to ${LABEL.get(to) ?? to}.`, "Edit task", mark);
			});
		},
	});

	return (
		<div class={`cp-matrix${ui.selectedId !== null ? " has-details" : ""}`}>
			<div class="cp-matrix-main">
				<header class="cp-main-header cp-matrix-header">
					<h2 class="cp-main-title">Eisenhower matrix</h2>
						<ScopeMenuButton host={host} visible={props.visible} filter={ui.filter} onChange={(update) => setUi((s) => ({ ...s, filter: update(s.filter) }))} />
				</header>
				<div
					class={`cp-matrix-grid${drag.draggingId !== null ? " is-dragging-card" : ""}`}
					ref={gridRef}
					onKeyDownCapture={onKeyDownCapture}
					onPointerDown={drag.onPointerDown}
				>
					{QUADRANT_ORDER.map((q) => (
						<QuadrantCard
							key={q}
							host={host}
							state={state}
							ctx={ctx}
							quadrant={q}
							groups={quadrants[q]}
							idBase={`${baseId}-${q}`}
							selectedId={ui.selectedId}
							counts={counts}
							onSelect={select}
							draggingId={drag.draggingId}
							isDropTarget={drag.overQuadrant === q}
							completedResetKey={JSON.stringify(ui.filter)}
							completedOpen={ui.completedOpen[q] === true}
							onToggleCompleted={() => setUi((s) => ({ ...s, completedOpen: { ...s.completedOpen, [q]: s.completedOpen[q] !== true } }))}
						/>
					))}
				</div>
				<span class="cp-sr-only" role="status" aria-live="polite">
					{announcement}
				</span>
			</div>
			<DetailsPane host={host} state={state} ctx={ctx} selectedId={ui.selectedId} onSelect={select} />
		</div>
	);
}

function QuadrantCard(props: {
	host: UiHost;
	state: DbData;
	ctx: QueryContext;
	quadrant: Quadrant;
	groups: MatrixGroup[];
	idBase: string;
	selectedId: ID | null;
	counts: ReadonlyMap<ID, SubtaskCount>;
	onSelect: (id: ID | null) => void;
	draggingId: ID | null;
	isDropTarget: boolean;
	completedOpen: boolean;
	onToggleCompleted: () => void;
	/** The matrix filter; a change starts the Completed group's paging again. */
	completedResetKey: string;
}) {
	const { host, quadrant, groups, idBase } = props;
	const info = QUADRANT_INFO[quadrant];
	const titleId = `${idBase}-title`;
	return (
		<section class={`cp-matrix-q ${info.cls}${props.isDropTarget ? " is-drop-target" : ""}`} data-quadrant={quadrant} aria-labelledby={titleId}>
			<div class="cp-matrix-q-head">
				<span class="cp-q-badge" aria-hidden="true">
					{info.numeral}
				</span>
				<span class="cp-matrix-q-title" id={titleId}>
					{info.title}
				</span>
				<span class="cp-matrix-q-sub">{info.subtitle}</span>
				<button
					type="button"
					class="cp-matrix-q-add clickable-icon"
					aria-label={info.addLabel}
					onClick={() => host.quickAdd(quadrantFlags(quadrant))}
				>
					<Icon host={host} icon={ICON.add} />
				</button>
			</div>
			<div class="cp-matrix-q-body">
				{groups.length === 0 ? (
					<p class="cp-matrix-q-empty">No tasks</p>
				) : (
					<div class="cp-task-list cp-matrix-q-list" role="group" aria-labelledby={titleId}>
						{groups.map((g) => {
							const row = (entry: ListEntry) => taskRowFor(props, props.counts, entry, true, { showMatrix: false, dragging: entry.task.id === props.draggingId });
							if (g.id === "completed") {
								return (
									<CompletedGroup
										key={g.id}
										host={host}
										resetKey={props.completedResetKey}
										idBase={idBase}
										entries={g.entries}
										open={props.completedOpen}
										onToggle={props.onToggleCompleted}
										renderRow={row}
										cls="cp-matrix-group is-completed"
									/>
								);
							}
							const headingId = `${idBase}-group-${g.id}`;
							return (
								<div class={`cp-task-group cp-matrix-group is-${g.id}`} key={g.id} role="group" aria-labelledby={headingId}>
									<div class={`cp-matrix-group-label${g.tone === undefined ? "" : ` is-${g.tone}`}`} id={headingId}>
										{g.label}
									</div>
									<div class="cp-task-rows" role="listbox" aria-labelledby={headingId}>
										{g.entries.map(row)}
									</div>
								</div>
							);
						})}
					</div>
				)}
			</div>
		</section>
	);
}
