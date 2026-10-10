import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { isListSynced } from "../app/syncMarks";
import { type SidebarCounts, type TaskView, type ViewGroup, buildBoard, buildCompleted, buildView, completedScope, sidebarCounts, viewPreset, viewTitle } from "../app/views";
import type { BoardColumn } from "../domain/board";
import { type GroupBy, effectiveGroupBy, groupByOptions } from "../domain/groupBy";
import { type ListEntry, type QueryContext, type TaskFilter, emptyFilter } from "../domain/queries";
import { type ID, INBOX_ID, type Task } from "../domain/types";
import type { DbData } from "../persistence/schema";
import { BoardView } from "./board/BoardView";
import { TodayHabitsBlock, TodayHabitsColumn } from "./habits/TodayHabits";
import { Icon, IconButton, SrOnly } from "./common";
import { useActiveMemo, useStableCallback, useSubtaskCounts, useUniqueId } from "./hooks";
import type { UiHost } from "./host";
import { ICON } from "./icons";
import { Sidebar } from "./Sidebar";
import { SyncStatusLine } from "./SyncStatusLine";
import { DetailsPane } from "./TaskDetails";
import { InlineAddBar } from "./quickadd/InlineAddBar";
import { TaskList, sectionKey } from "./TaskList";
import { TrashList } from "./TrashList";
import { useLingering } from "./useLingering";
import { ViewMenuButton, groupByMenu, tasksViewMenu } from "./ViewMenu";

export interface TasksSectionState {
	view: TaskView;
	selectedId: ID | null;
	text: string;
	/** Only `sort` is used: the view menu sets it. */
	filter: TaskFilter;
	/** "Show completed" in the view menu: shows the Completed group. */
	showCompleted: boolean;
	/** Whether each view's Completed group is expanded, by view key; kept for the session. */
	completedOpen: Record<string, boolean>;
	/** The Board mode by view key; a view not listed shows the list. Kept for the session. */
	boardMode: Record<string, boolean>;
	/** Which list-view sections are collapsed, by `sectionKey`; kept for the session. */
	sectionCollapsed: Record<string, boolean>;
	/** The "Group by" choice of each view in List mode, by view key; a view not listed uses its default. Kept for the session. */
	groupBy: Record<string, GroupBy>;
}

export function initialTasksState(): TasksSectionState {
	return { view: { kind: "today" }, selectedId: null, text: "", filter: emptyFilter(), showCompleted: true, completedOpen: {}, boardMode: {}, sectionCollapsed: {}, groupBy: {} };
}

/**
 * The state for showing `view` with `selectedId` selected. Whatever the user left in this section must not hide the
 * task asked for: the search text, any content filter (the sort stays) and the task's section when it was collapsed
 * (the list is grouped by section). The sort, the board mode and the Completed group hide no open task.
 */
export function revealInTasks(ui: TasksSectionState, view: TaskView, selectedId: ID | null, task: Task | undefined): TasksSectionState {
	if (selectedId === null) return { ...ui, view, selectedId, text: "" };
	const key = task === undefined ? null : sectionKey(task.categoryId, task.sectionId);
	const collapsed = key !== null && ui.sectionCollapsed[key] === true;
	return {
		...ui,
		view,
		selectedId,
		text: "",
		filter: { ...emptyFilter(), sort: ui.filter.sort },
		sectionCollapsed: collapsed ? { ...ui.sectionCollapsed, [key]: false } : ui.sectionCollapsed,
	};
}

/** The views with a List | Board switch: Tags, Completed and Trash have none. */
const BOARD_VIEWS: ReadonlySet<TaskView["kind"]> = new Set(["today", "upcoming", "inbox", "category"]);
/** The views whose list rows drag (the manual order and, with a grouping, between groups): the board views and a tag. */
const DRAG_VIEWS: ReadonlySet<TaskView["kind"]> = new Set(["today", "upcoming", "inbox", "category", "tag"]);
const NO_GROUPS: ViewGroup[] = [];
const NO_COLUMNS: BoardColumn[] = [];
const NO_ENTRIES: ListEntry[] = [];
const NO_COUNTS: SidebarCounts = { today: 0, upcoming: 0, categories: new Map(), tags: new Map(), completed: 0, trash: 0 };

/** Matches the 800 px container query in styles.css under which the sidebar is hidden. */
const NARROW_SIDEBAR_PX = 800;

const EMPTY_TEXT: Record<TaskView["kind"], string> = {
	today: "Nothing due today.",
	upcoming: "Nothing scheduled in the coming days.",
	inbox: "Inbox is empty.",
	category: "No open tasks in this list.",
	tag: "No open tasks with this tag.",
	completed: "No completed tasks yet.",
	trash: "Trash is empty.",
};

/** Inline "Add task" bar: the same parser, chips and keyboard rules as Quick Add. */
function AddBar({ host, view, state, ctx }: { host: UiHost; view: TaskView; state: DbData; ctx: QueryContext }) {
	const preset = viewPreset(view, ctx, state);
	return (
		<InlineAddBar
			host={host}
			// The view's preset only supplies defaults; nothing here is a manual value.
			preset={{ categoryId: preset.addCategoryId, date: preset.addDate, tagKeys: preset.addTagKeys }}
			ariaLabel="Add task"
			placeholder={`Add task to ${viewTitle(view, state)} — try “Read chapter 3 tomorrow 7pm #Study !1”`}
			cls="cp-add-bar"
		/>
	);
}

export function TasksSection(props: {
	host: UiHost;
	state: DbData;
	ctx: QueryContext;
	ui: TasksSectionState;
	setUi: (s: TasksSectionState) => void;
	/** True while the section is shown; a hidden one holds no just-completed rows. */
	visible: boolean;
	sidebarOpen: boolean;
	setSidebarOpen: (open: boolean) => void;
}) {
	const { host, state, ctx, ui, setUi } = props;
	// Counts every task: rebuilt only when what they read changes, not on every render (selecting a row, typing in a bar). The app mounts a hidden section too, which keeps its last value (`useActiveMemo`).
	const counts = useActiveMemo(
		props.visible,
		() => sidebarCounts(state, ctx),
		// `sidebarCounts` reads `tasks`, `trash` and, for a repeating task, `occurrenceRecords`; `ctx` only its day, zone and upcoming range (the week start moves a series' occurrence).
		[state.tasks, state.occurrenceRecords, state.trash, ctx.today, ctx.zone, ctx.upcomingDays, ctx.weekStart],
		NO_COUNTS,
	);
	const { view } = ui;
	// A task completed a moment ago stays among the open rows until its check animation ends.
	const held = useLingering(state.tasks, props.visible);
	const viewKey = JSON.stringify(view);
	const boardOn = BOARD_VIEWS.has(view.kind) && ui.boardMode[viewKey] === true;
	// The grouping of the list; the board has fixed columns, so it ignores this.
	const groupBy = effectiveGroupBy(view.kind, ui.groupBy[viewKey]);
	const uiRef = useRef(ui);
	uiRef.current = ui;
	// Rebuilt only when an input changes, not on every render (selecting a row, typing in a bar).
	const groups = useActiveMemo(
		props.visible,
		() => (boardOn ? NO_GROUPS : buildView(state, view, ctx, ui.filter, ui.text, held, groupBy)),
		// `state` only supplies `tasks`, `occurrenceRecords` (the current occurrence of a series moves without its task changing), `sections`, `categories` and `tags` here; `ctx` only its day, zone, week start and upcoming range.
		[boardOn, state.tasks, state.occurrenceRecords, state.sections, state.categories, state.tags, view, ui.filter, ui.text, held, groupBy, ctx.today, ctx.zone, ctx.upcomingDays, ctx.weekStart],
		NO_GROUPS,
	);
	const columns = useActiveMemo(
		props.visible,
		() => (boardOn ? buildBoard(state, view, ctx, ui.filter, ui.text, held) : NO_COLUMNS),
		[boardOn, state.tasks, state.occurrenceRecords, state.sections, view, ui.filter, ui.text, held, ctx.today, ctx.zone, ctx.upcomingDays, ctx.weekStart],
		NO_COLUMNS,
	);
	const hasGroup = completedScope(view) !== null;
	const showGroup = hasGroup && ui.showCompleted && !boardOn;
	const completedEntries = useActiveMemo(
		props.visible,
		() => (showGroup ? buildCompleted(state, view, ctx, ui.filter, ui.text, held) : []),
		[showGroup, state.tasks, state.occurrenceRecords, state.sections, view, ui.filter, ui.text, held, ctx.today, ctx.zone, ctx.upcomingDays, ctx.weekStart],
		NO_ENTRIES,
	);
	const shownCount = useMemo(
		() =>
			boardOn
				? columns.reduce((n, c) => n + c.cards.reduce((m, card) => m + 1 + card.subtasks.length, 0), 0)
				: groups.reduce((n, g) => n + g.entries.length, 0),
		[boardOn, columns, groups],
	);
	const subtaskCounts = useSubtaskCounts(state.tasks, props.visible && view.kind !== "trash");
	const modeLabelId = `${useUniqueId("cp-mode")}-label`;
	const preset = viewPreset(view, ctx, state);
	const readOnly = host.app.store.readOnlyState !== null;
	// Inbox and lists have sections; "Add section" (view menu) asks the list or the board to open its name field.
	const sectionList: ID | null = view.kind === "inbox" ? INBOX_ID : view.kind === "category" ? view.id : null;
	const hasSections = sectionList !== null && [...state.sections.values()].some((s) => s.categoryId === sectionList);
	const [addSectionRequest, setAddSectionRequest] = useState(0);
	// "Group by…" opens a second menu; a native menu closes on a pick, so it is shown on the next tick.
	const groupMenuTimer = useRef<number | null>(null);
	useEffect(() => () => {
		if (groupMenuTimer.current !== null) window.clearTimeout(groupMenuTimer.current);
	}, []);
	const groupOptions = groupByOptions(view.kind);
	const showGroupMenu = (at: { x: number; y: number }) => {
		if (groupMenuTimer.current !== null) window.clearTimeout(groupMenuTimer.current);
		groupMenuTimer.current = window.setTimeout(() => {
			groupMenuTimer.current = null;
			const cur = uiRef.current;
			host.showMenu(
				at,
				groupByMenu(groupOptions, effectiveGroupBy(view.kind, cur.groupBy[viewKey]), (by) =>
					setUi({ ...uiRef.current, groupBy: { ...uiRef.current.groupBy, [viewKey]: by } }),
				),
			);
		}, 0);
	};
	const select = useStableCallback((id: ID | null) => setUi({ ...ui, selectedId: id }));
	const showCategory = view.kind !== "category" && view.kind !== "inbox";

	// The ☰ button works at every width.
	// Wide: it collapses the sidebar so the list gets the room. Narrow (the sidebar is already
	// hidden under ~800 px): it opens the sidebar as an overlay.
	const rootRef = useRef<HTMLDivElement>(null);
	const [collapsed, setCollapsed] = useState(false);
	const [narrow, setNarrow] = useState(false);
	useEffect(() => {
		const el = rootRef.current;
		if (el === null || typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(() => setNarrow(el.clientWidth <= NARROW_SIDEBAR_PX));
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	const listsShown = narrow ? props.sidebarOpen : !collapsed;
	const toggleLists = () => {
		const isNarrow = (rootRef.current?.clientWidth ?? Infinity) <= NARROW_SIDEBAR_PX && rootRef.current?.clientWidth !== 0;
		setNarrow(isNarrow);
		if (isNarrow) props.setSidebarOpen(!props.sidebarOpen);
		else setCollapsed(!collapsed);
	};

	return (
		<div
			ref={rootRef}
			class={`cp-tasks${ui.selectedId !== null ? " has-details" : ""}${props.sidebarOpen ? " is-sidebar-open" : ""}${collapsed ? " is-sidebar-collapsed" : ""}`}
		>
			<div class="cp-sidebar-pane">
				<Sidebar
					host={host}
					state={state}
					counts={counts}
					view={view}
					onView={(v) => {
						setUi({ ...ui, view: v, text: "" });
						props.setSidebarOpen(false);
					}}
				/>
			</div>
			<main class={`cp-main${boardOn ? " is-board" : ""}`}>
				<header class="cp-main-header">
					<IconButton
						host={host}
						icon="menu"
						label={listsShown ? "Hide lists" : "Show lists"}
						cls="cp-sidebar-toggle"
						pressed={listsShown}
						onClick={toggleLists}
					/>
					<h2 class="cp-main-title">{viewTitle(view, state)}</h2>
					{view.kind !== "trash" && <span class="cp-count-pill">{shownCount}</span>}
					{sectionList !== null && host.tickTick !== undefined && isListSynced(state.syncLinks, sectionList) && <SyncStatusLine host={host} />}
					{BOARD_VIEWS.has(view.kind) && (
						<div class="cp-mode-switch" role="group" aria-labelledby={modeLabelId}>
							<SrOnly id={modeLabelId}>Layout</SrOnly>
							{([false, true] as const).map((board) => (
								<button
									key={String(board)}
									type="button"
									class={`cp-mode-button${boardOn === board ? " is-active" : ""}`}
									aria-pressed={boardOn === board}
									onClick={() => setUi({ ...ui, boardMode: { ...ui.boardMode, [viewKey]: board } })}
								>
									<Icon host={host} icon={board ? "layout-dashboard" : ICON.list} />
									<span>{board ? "Board" : "List"}</span>
								</button>
							))}
						</div>
					)}
					<input
						type="search"
						class="cp-view-search"
						placeholder="Search this list"
						aria-label="Search this list"
						value={ui.text}
						onInput={(e) => setUi({ ...ui, text: e.currentTarget.value })}
					/>
					{view.kind !== "trash" && (
						<ViewMenuButton
							host={host}
							open={(at) =>
								host.showMenu(
									at,
									tasksViewMenu({
										sort: ui.filter.sort,
										onSort: (sort) => setUi({ ...ui, filter: { ...ui.filter, sort } }),
										showCompleted: hasGroup ? ui.showCompleted : undefined,
										onShowCompleted: (showCompleted) => setUi({ ...ui, showCompleted }),
										// The new section must be visible, so the list switches to Group by Section.
										onAddSection:
											sectionList !== null && !readOnly
												? () => {
														if (!boardOn && groupBy !== "section") setUi({ ...ui, groupBy: { ...ui.groupBy, [viewKey]: "section" } });
														setAddSectionRequest((n) => n + 1);
													}
												: undefined,
										// List mode only, and only where the view offers a grouping.
										onGroupBy: !boardOn && groupOptions.length > 0 ? () => showGroupMenu(at) : undefined,
									}),
								)
							}
						/>
					)}
					<IconButton
						host={host}
						icon="plus"
						label="Quick add task"
						disabled={readOnly}
						onClick={() =>
							host.quickAdd({
								categoryId: preset.addCategoryId,
								date: preset.addDate,
								tagKeys: preset.addTagKeys,
							})
						}
					/>
				</header>
				{view.kind === "trash" ? (
					<TrashList host={host} state={state} ctx={ctx} />
				) : (
					<>
						{!readOnly && view.kind !== "completed" && <AddBar host={host} view={view} state={state} ctx={ctx} />}
						{boardOn ? (
							<BoardView
								host={host}
								state={state}
								ctx={ctx}
								columns={columns}
								selectedId={ui.selectedId}
								showCategory={showCategory}
								leading={view.kind === "today" ? <TodayHabitsColumn host={host} today={ctx.today} /> : undefined}
								subtaskCounts={subtaskCounts}
								manual={ui.filter.sort === "manual"}
								readOnly={readOnly}
								showCompleted={ui.showCompleted}
								addCategoryId={preset.addCategoryId}
								addSectionRequest={addSectionRequest}
								resetKey={`${viewKey}|${JSON.stringify(ui.filter)}|${ui.text}`}
								completedOpen={(id) => ui.completedOpen[`board:${viewKey}:${id}`] === true}
								onToggleCompleted={(id) => {
									const key = `board:${viewKey}:${id}`;
									setUi({ ...ui, completedOpen: { ...ui.completedOpen, [key]: ui.completedOpen[key] !== true } });
								}}
								onSelect={select}
							/>
						) : (
							<>
								{/* The Habits block sits between the add bar and the list, in Today only. */}
								{view.kind === "today" && <TodayHabitsBlock host={host} today={ctx.today} />}
								<TaskList
									host={host}
									sort={DRAG_VIEWS.has(view.kind) ? ui.filter.sort : undefined}
									readOnly={readOnly}
									virtualize={true}
									subtaskCounts={subtaskCounts}
									state={state}
									groups={groups}
									ctx={ctx}
									selectedId={ui.selectedId}
									showCategory={showCategory}
									emptyText={ui.text !== "" ? "No tasks match." : EMPTY_TEXT[view.kind]}
									label={viewTitle(view, state)}
									onSelect={select}
									sections={
										sectionList === null
											? undefined
											: {
													categoryId: sectionList,
													hasAny: hasSections,
													collapsed: (key) => ui.sectionCollapsed[key] === true,
													onToggle: (key) => setUi({ ...ui, sectionCollapsed: { ...ui.sectionCollapsed, [key]: ui.sectionCollapsed[key] !== true } }),
													addRequest: addSectionRequest,
												}
									}
									completed={
										hasGroup
											? {
													entries: completedEntries,
													open: ui.completedOpen[viewKey] === true,
													onToggle: () => setUi({ ...ui, completedOpen: { ...ui.completedOpen, [viewKey]: ui.completedOpen[viewKey] !== true } }),
													resetKey: `${viewKey}|${JSON.stringify(ui.filter)}|${ui.text}`,
												}
											: undefined
									}
								/>
							</>
						)}
					</>
				)}
			</main>
			<DetailsPane host={host} state={state} ctx={ctx} selectedId={ui.selectedId} onSelect={select} />
		</div>
	);
}
